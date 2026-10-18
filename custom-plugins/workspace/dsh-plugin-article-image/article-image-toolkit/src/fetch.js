/** Direct HTTP article retrieval over the address-pinned public transport. */
import { failure } from './contracts.js'
import { createPublicRequest } from './capture-media.js'
import { decodeBody } from './decode.js'
import { cacheIsFresh, freshnessSeconds, heuristicFreshness, isStorable } from './cache.js'

const WEB_ERRORS = {
  WEB_INVALID_URL: 'article-url', WEB_BLOCKED_URL: 'article-url-blocked', WEB_REDIRECT_BLOCKED: 'article-redirect',
  WEB_FETCH_TOO_LARGE: 'article-html-limit', WEB_FETCH_TIMEOUT: 'article-timeout', WEB_ABORTED: 'article-interrupted',
  WEB_UNSUPPORTED_CONTENT_TYPE: 'article-unsupported', WEB_PROVIDER_ERROR: 'article-network',
  WEB_PROVIDER_UNAVAILABLE: 'article-provider', WEB_PROVIDER_CONFIGURED_MISSING: 'article-provider',
  WEB_PROVIDER_CONFIGURED_UNAVAILABLE: 'article-provider', WEB_PROVIDER_AMBIGUOUS: 'article-provider',
  // 传输层按 maxBytes 截断响应时抛出这个自有错误码；它与 html-limit 是同一件事（源码超出预算），
  // 若不在读取入口归一，阶梯会把它当传输失败而永不升级到浏览器。
  ARTICLE_RESOURCE_LIMIT: 'article-html-limit',
}

/** Keep only known web errors; remote text never becomes caller copy. @param {unknown} error Native provider error. @returns {unknown} Owned safe error or the original failure. */
export function articleFetchError(error) { return WEB_ERRORS[error?.code] ? failure(WEB_ERRORS[error.code]) : error }

const HTML_TYPES = /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i
const TEXT_TYPES = /^(?:text\/plain|application\/xml|text\/xml)(?:;|$)/i
// 这几个状态码可能同时下发会话（先拒绝再凭 cookie 放行），值得用新会话重试一次。
const REFUSAL = new Set([401, 403])

/** Build one transport per configuration so the pinned connection policy is shared. @param {object} config Limits. @returns {Function} Article request. */
export function createArticleRequest(config, dependencies = {}) {
  return dependencies.request ?? createPublicRequest(config, dependencies)
}

/**
 * Retrieve one page as inert text or HTML under the configured byte limit.
 * @param {string} url Article URL.
 * @param {object} config Limits.
 * @param {AbortSignal} signal Cancellation.
 * @param {Function} [request] Address-pinned transport.
 * @param {object} [dependencies] Session jar and pacer.
 * @returns {Promise<object>} Page result compatible with article extraction.
 */
export async function fetchPage(url, config, signal, request, dependencies = {}) {
  const send = request ?? createArticleRequest(config)
  try {
    return await retrieve(url, config, signal, send, dependencies)
  } catch (error) {
    if (signal?.aborted) throw failure('article-interrupted')
    throw error
  }
}

async function retrieve(url, config, signal, request, { jar, pacer, cache } = {}) {
  const host = new URL(url).hostname.toLowerCase()
  // 命中新鲜缓存时完全不发请求：这是毫秒级返回的唯一来源，网络 RTT 才是下限。
  let cached = null
  if (cache) {
    const entry = await cache.get(url)
    if (entry?.result && cacheIsFresh(entry, Date.now())) return { ...entry.result, cached: true }
    // 过期条目仍可做条件请求：新闻站普遍 no-cache + ETag，304 让正文一个字节都不必回传。
    if (entry?.result && (entry.etag || entry.lastModified)) cached = entry
  }
  let response
  // 429 与带 Retry-After 的 503 是服务器明确要求等待：按它给的时间再试一次，
  // 第二次仍是同样的状态码就原样返回，不把等待放大成重试风暴。
  for (let attempt = 0; attempt < 2; attempt++) {
    await pacer?.acquire(host, signal)
    if (signal?.aborted) throw failure('article-interrupted')
    const jarHeaders = jar?.header(url)
    const conditional = cached
      ? { ...(cached.etag ? { 'if-none-match': cached.etag } : {}), ...(cached.lastModified ? { 'if-modified-since': cached.lastModified } : {}) }
      : {}
    const headers = { ...conditional, ...(jarHeaders ? { cookie: jarHeaders } : {}) }
    response = await request(url, { signal, maxBytes: config.maxArticleHtmlBytes, headers: Object.keys(headers).length ? headers : undefined })
    // 304 表示正文未变：直接用缓存正文，省掉整个响应体的传输。
    if (response.statusCode === 304 && cached) {
      if (cache) await cache.put(url, { ...cached, maxAge: freshnessSeconds(response.headers?.['cache-control']) || cached.maxAge, storedAt: Date.now() }).catch(error => { void error })
      return { ...cached.result, cached: true }
    }
    // 跳转链内部由传输层自行跟随，链上的 Set-Cookie 只会体现在最终响应头里；
    // 因此在这里统一入 jar，并按新会话决定是否需要一次带 cookie 的重试。
    const stored = jar ? jar.store(response.url ?? url, response.headers) : 0
    if (stored > 0 && REFUSAL.has(response.statusCode) && attempt === 0) continue
    const directed = response.headers?.['retry-after']
    if (response.statusCode !== 429 && !(response.statusCode === 503 && directed)) break
    const waited = pacer?.defer(host, directed) ?? 0
    if (!waited || signal?.aborted) break
  }
  const type = (response.headers['content-type'] ?? '').split(';')[0].trim()
  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    return { url: response.url, statusCode: response.statusCode, truncated: false, body: { kind: 'text', content: '' } }
  }
  const kind = HTML_TYPES.test(type) ? 'html' : TEXT_TYPES.test(type) ? 'text' : null
  if (!kind) throw failure('article-unsupported')
  const { text: content, charset } = decodeBody(response.bytes, response.headers['content-type'])
  if (content.length > config.maxArticleHtmlChars) {
    return { url: response.url, statusCode: response.statusCode, truncated: true, charset, body: { kind, content: content.slice(0, config.maxArticleHtmlChars) } }
  }
  const result = { url: response.url, statusCode: response.statusCode, truncated: false, charset, body: { kind, content } }
  // no-store 的响应一律不落盘；没有 max-age 时按 Last-Modified 的年龄取启发式新鲜度，
  // 否则纯新闻页永远无法命中缓存，每次读取都得支付完整往返。
  if (cache && isStorable(response.headers)) {
    const stored = freshnessSeconds(response.headers['cache-control']) || heuristicFreshness(response.headers, Date.now())
    if (stored > 0 || response.headers.etag || response.headers['last-modified']) {
      await cache.put(url, { result, maxAge: stored, storedAt: Date.now(), etag: response.headers.etag ?? null, lastModified: response.headers['last-modified'] ?? null }).catch(error => { void error })
    }
  }
  return result
}

/**
 * Retrieve one article page.
 * @param {object} config Limits.
 * @param {string} url Article URL.
 * @param {AbortSignal} signal Cancellation.
 * @param {Function} [request] Address-pinned transport.
 * @param {object} [dependencies] Session jar and pacer.
 * @returns {Promise<object>} Page result.
 */
export async function fetchArticlePage(config, url, signal, request, dependencies = {}) {
  try { return await fetchPage(url, config, signal, request, dependencies) }
  catch (error) { if (signal?.aborted) throw failure('article-interrupted'); throw articleFetchError(error) }
}
