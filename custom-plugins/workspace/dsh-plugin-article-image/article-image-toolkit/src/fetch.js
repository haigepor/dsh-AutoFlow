/** Direct HTTP article retrieval with explicit size and redirect limits. */
import { failure } from './contracts.js'

const WEB_ERRORS = {
  WEB_INVALID_URL: 'article-url', WEB_BLOCKED_URL: 'article-url-blocked', WEB_REDIRECT_BLOCKED: 'article-redirect',
  WEB_FETCH_TOO_LARGE: 'article-html-limit', WEB_FETCH_TIMEOUT: 'article-timeout', WEB_ABORTED: 'article-interrupted',
  WEB_UNSUPPORTED_CONTENT_TYPE: 'article-unsupported', WEB_PROVIDER_ERROR: 'article-network',
  WEB_PROVIDER_UNAVAILABLE: 'article-provider', WEB_PROVIDER_CONFIGURED_MISSING: 'article-provider',
  WEB_PROVIDER_CONFIGURED_UNAVAILABLE: 'article-provider', WEB_PROVIDER_AMBIGUOUS: 'article-provider',
}

/** Keep only known web errors; remote text never becomes caller copy. @param {unknown} error Native provider error. @returns {unknown} Owned safe error or the original failure. */
export function articleFetchError(error) { return WEB_ERRORS[error?.code] ? failure(WEB_ERRORS[error.code]) : error }

const HTML_TYPES = /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i
const TEXT_TYPES = /^(?:text\/plain|application\/xml|text\/xml)(?:;|$)/i

/** Retrieve one page as inert text or HTML under the configured byte limit. @param {string} url Article URL. @param {object} config Limits. @param {AbortSignal} signal Cancellation. @param {Function} fetchImpl Transport. @returns {Promise<object>} Page result compatible with article extraction. */
export async function fetchPage(url, config, signal, fetchImpl = globalThis.fetch) {
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeoutMs)])
  // 超时可能落在请求内或正文读取中，统一在此翻译，避免原生 TimeoutError 泄漏成 operation-failed。
  try { return await retrieve(url, config, signal, timeout, fetchImpl) }
  catch (error) {
    if (signal.aborted) throw failure('article-interrupted')
    if (timeout.aborted) throw failure('article-timeout')
    throw error
  }
}

async function retrieve(url, config, signal, timeout, fetchImpl) {
  let current = url
  for (let hop = 0; hop <= config.maxRedirects; hop++) {
    let response
    try {
      response = await fetchImpl(current, { signal: timeout, redirect: 'manual', credentials: 'omit',
        headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9', 'user-agent': config.articleUserAgent, 'accept-language': '*' } })
    } catch (error) {
      if (timeout.aborted) throw failure('article-timeout')
      throw failure('article-network')
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location) throw failure('article-redirect')
      const target = new URL(location, current)
      if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) throw failure('article-redirect')
      current = target.href
      continue
    }
    const type = response.headers.get('content-type') ?? ''
    if (!response.ok) { await response.body?.cancel(); return { url: current, statusCode: response.status, truncated: false, body: { kind: 'text', content: '' } } }
    const kind = HTML_TYPES.test(type) ? 'html' : TEXT_TYPES.test(type) ? 'text' : null
    if (!kind) { await response.body?.cancel(); throw failure('article-unsupported') }
    if (!response.body) throw failure('article-network')
    const reader = response.body.getReader(), chunks = []
    let bytes = 0, truncated = false
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.length
        if (bytes > config.maxArticleHtmlBytes) { truncated = true; break }
        chunks.push(chunk.value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    const content = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks))
    if (content.length > config.maxArticleHtmlChars) return { url: current, statusCode: response.status, truncated: true, body: { kind, content: content.slice(0, config.maxArticleHtmlChars) } }
    return { url: current, statusCode: response.status, truncated, body: { kind, content } }
  }
  throw failure('article-redirect')
}

/** Retrieve one article page. @param {object} config Limits. @param {string} url Article URL. @param {AbortSignal} signal Cancellation. @param {Function} fetchImpl Transport. @returns {Promise<object>} Page result. */
export async function fetchArticlePage(config, url, signal, fetchImpl) {
  try { return await fetchPage(url, config, signal, fetchImpl) }
  catch (error) { signal.throwIfAborted(); throw articleFetchError(error) }
}
