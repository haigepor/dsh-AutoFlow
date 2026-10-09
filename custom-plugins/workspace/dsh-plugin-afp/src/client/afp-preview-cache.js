import { readPreviewMedia } from './afp-preview-media.js'

function aborted() { return new DOMException('Preview request aborted', 'AbortError') }

/** Plugin-owned raster cache; retention budgets exclude images held by active consumers.
 * @param {object} [options] Transport, clock and object-URL providers for the browser or isolated tests.
 * @returns {object} Cache with configurable retention, independently cancellable leases and disposal.
 */
export function createPreviewCache({ load = readPreviewMedia, now = Date.now,
  createObjectURL = blob => URL.createObjectURL(blob), revokeObjectURL = url => URL.revokeObjectURL(url) } = {}) {
  const entries = new Map(), pending = new Map(), leased = new Set(), jobs = new Set()
  let policy = null, bytes = 0, generation = 0, disposed = false
  let hits = 0, misses = 0, coalesced = 0

  function revoke(entry) {
    if (!entry.url) return
    revokeObjectURL(entry.url); entry.url = null; leased.delete(entry)
  }
  function drop(entry) {
    if (entries.get(entry.key) !== entry) return
    entries.delete(entry.key); bytes -= entry.blob.size; entry.retained = false
    if (!entry.refs) revoke(entry)
  }
  function prune() {
    for (const entry of entries.values()) if (entry.expiresAt <= now()) drop(entry)
    while (policy && (entries.size > policy.maxEntries || bytes > policy.maxBytes)) drop(entries.values().next().value)
  }
  function detach(waiter) {
    waiter.job.waiters.delete(waiter)
    waiter.signal?.removeEventListener('abort', waiter.onAbort)
  }
  function stop(job) {
    if (pending.get(job.key) === job) pending.delete(job.key)
    job.controller.abort()
    for (const waiter of [...job.waiters]) { detach(waiter); waiter.reject(aborted()) }
  }
  function clear() {
    generation++
    for (const job of [...pending.values()]) stop(job)
    for (const entry of [...entries.values()]) drop(entry)
    // 账号或权限失效需要立即撤销活跃 URL；容量淘汰则等最后一个租约释放。
    for (const entry of [...leased]) revoke(entry)
  }
  function lease(entry, signal) {
    if (signal?.aborted || disposed) throw aborted()
    if (!entry.url) entry.url = createObjectURL(entry.blob)
    entry.refs++; leased.add(entry)
    let released = false
    const release = () => {
      if (released) return
      released = true; signal?.removeEventListener('abort', release); entry.refs--
      if (!entry.refs) {
        if (entry.retained && entry.expiresAt <= now()) drop(entry)
        revoke(entry)
      }
    }
    signal?.addEventListener('abort', release, { once: true })
    return { url: entry.url, release }
  }
  function launch(key) {
    const job = { key, generation, controller: new AbortController(), waiters: new Set(), done: null }
    pending.set(key, job)
    job.done = Promise.resolve().then(() => {
      job.controller.signal.throwIfAborted()
      return load(key, job.controller.signal)
    }).then(blob => {
      if (disposed || job.generation !== generation || job.controller.signal.aborted || pending.get(key) !== job) return
      pending.delete(key)
      const entry = { key, blob, refs: 0, url: null, retained: false, expiresAt: now() + (policy?.ttlMs ?? 0) }
      if (policy && policy.maxEntries > 0 && blob.size <= policy.maxBytes) {
        entry.retained = true; entries.set(key, entry); bytes += blob.size; prune()
      }
      for (const waiter of [...job.waiters]) {
        detach(waiter)
        try { waiter.resolve(lease(entry, waiter.signal)) }
        catch (error) { waiter.reject(error) }
      }
    }, error => {
      if (pending.get(key) === job) pending.delete(key)
      for (const waiter of [...job.waiters]) { detach(waiter); waiter.reject(error) }
    }).finally(() => jobs.delete(job.done))
    jobs.add(job.done)
    return job
  }

  return {
    configure(next) {
      // 策略来自 Host JSON；缺少新字段的旧 Host 仍可显示图片，但不保留 Blob。
      if (next !== null && (!next || typeof next.scope !== 'string' || !next.scope || next.scope.length > 128
        || !Number.isSafeInteger(next.maxEntries) || next.maxEntries < 0
        || !Number.isSafeInteger(next.maxBytes) || next.maxBytes < 1
        || !Number.isSafeInteger(next.ttlMs) || next.ttlMs < 1)) throw new Error('Invalid AFP preview cache policy')
      const value = next ? { scope: next.scope, maxEntries: next.maxEntries, maxBytes: next.maxBytes, ttlMs: next.ttlMs } : null
      if (JSON.stringify(value) === JSON.stringify(policy)) return false
      clear(); policy = value
      return true
    },
    acquireCached(src, signal) {
      if (disposed || signal?.aborted) return null
      prune()
      const entry = entries.get(src)
      if (!entry) return null
      hits++; entries.delete(src); entries.set(src, entry)
      return lease(entry, signal)
    },
    async acquire(src, signal, { refresh = false } = {}) {
      if (disposed || signal?.aborted) throw aborted()
      prune()
      if (refresh) this.invalidate(src)
      const cached = this.acquireCached(src, signal)
      if (cached) return cached
      let job = pending.get(src)
      if (job) coalesced++
      else { misses++; job = launch(src) }
      return new Promise((resolve, reject) => {
        const waiter = { job, signal, resolve, reject, onAbort: null }
        waiter.onAbort = () => {
          detach(waiter); reject(aborted())
          if (!job.waiters.size) stop(job)
        }
        job.waiters.add(waiter)
        signal?.addEventListener('abort', waiter.onAbort, { once: true })
      })
    },
    invalidate(src, url) {
      const entry = entries.get(src)
      // 旧图片的迟到解码错误不能删除已经重试成功的新版本。
      if (entry && (url === undefined || entry.url === url)) drop(entry)
    },
    clear,
    stats() { prune(); return { entries: entries.size, bytes, pending: pending.size, activeUrls: leased.size, hits, misses, coalesced } },
    async dispose() { disposed = true; clear(); await Promise.allSettled([...jobs]) },
  }
}
