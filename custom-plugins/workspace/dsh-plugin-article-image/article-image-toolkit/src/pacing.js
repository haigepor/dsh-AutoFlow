/** Per-host request pacing: a token bucket plus server-directed backoff. */

/** Parse a Retry-After header value into milliseconds. @param {string|undefined} value Header value. @param {number} now Reference time. @returns {number} Delay in milliseconds, or 0. */
export function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0
  const text = String(value).trim()
  if (/^\d+$/.test(text)) return Math.min(Number(text) * 1000, 600000)
  const at = Date.parse(text)
  return Number.isFinite(at) ? Math.min(Math.max(0, at - now), 600000) : 0
}

/** Sleep for a bounded wait, waking early when the caller aborts. @param {number} ms Delay. @param {AbortSignal} [signal] Cancellation. @returns {Promise<void>} Completion. */
function delay(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', wake); resolve() }, ms)
    const wake = () => { clearTimeout(timer); resolve() }
    signal?.addEventListener('abort', wake, { once: true })
  })
}

/**
 * One bucket per host. A bucket refills continuously at `ratePerSecond` up to `burst`,
 * and a 429 or 503 with Retry-After blocks the whole host until that moment passes.
 * Pacing is per host because one slow publisher must not stall retrievals from another.
 */
export class pacer {
  /** @param {object} config Pacing limits. @param {object} [options] Clock override. */
  constructor(config, options = {}) {
    this.rate = config.hostRatePerSecond
    this.burst = config.hostBurst
    this.maxRetryAfterMs = config.maxRetryAfterMs
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? delay
    this.hosts = new Map()
  }

  /** Read or create the bucket for one host. @param {string} host Hostname. @returns {object} Bucket. */
  bucket(host) {
    let bucket = this.hosts.get(host)
    if (!bucket) { bucket = { tokens: this.burst, at: this.now(), blockedUntil: 0 }; this.hosts.set(host, bucket) }
    return bucket
  }

  /** Wait until one request to this host is allowed. @param {string} host Hostname. @param {AbortSignal} [signal] Cancellation. @returns {Promise<void>} Completion when allowed. */
  async acquire(host, signal) {
    for (;;) {
      if (signal?.aborted) return
      const bucket = this.bucket(host)
      const now = this.now()
      const blockedFor = bucket.blockedUntil - now
      if (blockedFor > 0) { await this.sleep(blockedFor, signal); continue }
      bucket.tokens = Math.min(this.burst, bucket.tokens + ((now - bucket.at) / 1000) * this.rate)
      bucket.at = now
      if (bucket.tokens >= 1) { bucket.tokens -= 1; return }
      // 令牌不足时只等补足一个令牌所需时间，睡眠期间其他主机照常放行。
      await this.sleep(Math.ceil(((1 - bucket.tokens) / this.rate) * 1000), signal)
    }
  }

  /** Record a server-directed delay for one host. @param {string} host Hostname. @param {string|undefined} header Retry-After value. @returns {number} Applied delay in milliseconds. */
  defer(host, header) {
    const delay = Math.min(retryAfterMs(header, this.now()), this.maxRetryAfterMs)
    if (delay <= 0) return 0
    const bucket = this.bucket(host)
    bucket.blockedUntil = Math.max(bucket.blockedUntil, this.now() + delay)
    return delay
  }
}
