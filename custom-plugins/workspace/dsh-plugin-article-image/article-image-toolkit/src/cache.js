/**
 * On-disk HTTP response cache for article retrieval.
 *
 * Article bodies rarely change between requests, and every network round trip costs an
 * order of magnitude more than reading a cached file — on a slow link a single page can
 * take twenty seconds while the same cached page serves in a few milliseconds. Entries
 * keep the response body and the validators that let a later request be revalidated
 * instead of downloaded again.
 *
 * The cache is keyed by the request URL and stores only successful HTML/text responses.
 * Enabling it is a deployment decision: a caller that needs a guaranteed-fresh read
 * passes `force: true`, which bypasses the lookup but still refreshes the entry.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** Storage key for a URL: hashed so long URLs and query strings stay filesystem-safe. @param {string} url Request URL. @returns {string} Cache key. */
function cacheKey(url) { return createHash('sha256').update(url).digest('hex') }

/** Seconds a response may be reused without revalidation, from Cache-Control. @param {string|undefined} header Cache-Control value. @returns {number} Freshness in seconds, 0 when not cacheable. */
export function freshnessSeconds(header) {
  if (!header) return 0
  const value = header.toLowerCase()
  if (/\bno-store\b|\bno-cache\b/.test(value)) return 0
  const maxAge = /\bmax-age\s*=\s*(\d+)/.exec(value)
  if (maxAge) return Number(maxAge[1])
  return 0
}

/** Whether a response may be written to the cache at all. `no-store` forbids it, and a response without freshness or a validator can never answer a later request. @param {object} headers Response headers. @returns {boolean} Storable state. */
export function isStorable(headers) {
  if (!headers) return false
  const control = String(headers['cache-control'] ?? '').toLowerCase()
  if (/\bno-store\b/.test(control)) return false
  const explicit = /\bmax-age\s*=\s*(\d+)/.exec(control)
  if (explicit && Number(explicit[1]) > 0) return true
  return Boolean(headers['last-modified'] || headers.etag)
}

/**
 * Freshness for a response that carries no explicit `max-age`. RFC 9111 §4.2.2 permits a
 * heuristic, and the conventional choice is a tenth of the age since `Last-Modified`.
 * Without this, a plain news page — no Cache-Control, one `Last-Modified` — could never
 * be reused, and every read pays the full round trip. The cap keeps a rarely-edited page
 * from being served for a day: a news article's text can change under the same URL.
 * @param {object} headers Response headers.
 * @param {number} now Current epoch milliseconds.
 * @returns {number} Freshness in seconds, 0 when the response forbids reuse or has no age evidence.
 */
export function heuristicFreshness(headers, now) {
  if (!headers) return 0
  const control = String(headers['cache-control'] ?? '').toLowerCase()
  if (/\bno-store\b|\bno-cache\b/.test(control)) return 0
  const modified = Date.parse(headers['last-modified'] ?? '')
  if (!Number.isFinite(modified) || modified >= now) return 0
  return Math.min(600, Math.floor((now - modified) / 10000))
}

/** Whether a cached entry may answer a request without contacting the origin. @param {object} entry Cache entry. @param {number} now Current epoch milliseconds. @returns {boolean} Usable state. */
export function cacheIsFresh(entry, now) {
  return entry.maxAge > 0 && now < entry.storedAt + entry.maxAge * 1000
}

/**
 * One directory of cached responses. Reads tolerate a missing or corrupt entry: a cache
 * miss is never an error.
 */
export class ResponseCache {
  /** @param {string} directory Cache directory. */
  constructor(directory) {
    this.directory = directory
    this.pending = new Map()
  }

  /** @param {string} url Request URL. @returns {string} Entry path. */
  path(url) { return join(this.directory, `${cacheKey(url)}.json`) }

  /**
   * Read a stored entry. Concurrent misses on the same key share one read.
   * @param {string} url Request URL.
   * @returns {Promise<object|null>} Entry or null.
   */
  async get(url) {
    const key = cacheKey(url)
    if (this.pending.has(key)) return this.pending.get(key)
    const read = readFile(this.path(url), 'utf8')
      .then(text => JSON.parse(text))
      .catch(error => {
        // 缺失与损坏都按未命中处理：缓存从不决定抓取成败。
        void error
        return null
      })
      .finally(() => this.pending.delete(key))
    this.pending.set(key, read)
    return read
  }

  /**
   * Store a response body and its validators.
   * @param {string} url Request URL.
   * @param {object} entry Body, headers and timestamps.
   * @returns {Promise<void>} Completion.
   */
  async put(url, entry) {
    await mkdir(this.directory, { recursive: true })
    const temp = `${this.path(url)}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(entry))
    await rename(temp, this.path(url))
  }

  /** Remove every stored entry. @returns {Promise<void>} Completion. */
  async clear() { await rm(this.directory, { recursive: true, force: true }) }
}
