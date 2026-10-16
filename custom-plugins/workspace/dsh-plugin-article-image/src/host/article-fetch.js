/** Retrieve articles with explicit raw-HTML limits, preserving native URL policy. */
import { failure } from '../shared/contracts.js'

const WEB_ERRORS = {
  WEB_INVALID_URL: 'article-url', WEB_BLOCKED_URL: 'article-url-blocked', WEB_REDIRECT_BLOCKED: 'article-redirect',
  WEB_FETCH_TOO_LARGE: 'article-html-limit', WEB_FETCH_TIMEOUT: 'article-timeout', WEB_ABORTED: 'article-interrupted',
  WEB_UNSUPPORTED_CONTENT_TYPE: 'article-unsupported', WEB_PROVIDER_ERROR: 'article-network',
  WEB_PROVIDER_UNAVAILABLE: 'article-provider', WEB_PROVIDER_CONFIGURED_MISSING: 'article-provider',
  WEB_PROVIDER_CONFIGURED_UNAVAILABLE: 'article-provider', WEB_PROVIDER_AMBIGUOUS: 'article-provider',
}

/** Keep only known web errors; remote text never becomes UI copy. @param {unknown} error Native provider error. @returns {unknown} Owned safe error or the original failure. */
export function articleFetchError(error) { return WEB_ERRORS[error?.code] ? failure(WEB_ERRORS[error.code]) : error }

async function fetchLargeHtml(url, config, signal) {
  const { HttpFetchProvider } = await import('@deepseek-ai/dsh-web-fetch-http')
  const provider = new HttpFetchProvider({ maxResponseBytes: config.maxArticleHtmlBytes, maxBodyChars: config.maxArticleHtmlChars,
    timeoutMs: config.requestTimeoutMs, maxRedirects: config.maxRedirects, userAgent: config.articleUserAgent })
  return provider.fetch({ url }, signal)
}

/** Try the configured web provider, then at most one explicitly enabled size recovery. @param {object} web Native web service. @param {object} config Plugin limits. @param {string} url Article URL. @param {AbortSignal} signal Whole operation cancellation. @param {Function} largeFetch Native anonymous HTTP adapter. @returns {Promise<object>} Page and actual retrieval method for the job result. */
export async function fetchArticlePage(web, config, url, signal, largeFetch = fetchLargeHtml) {
  let page
  try { page = await web.fetch({ url }, signal) }
  catch (error) {
    signal.throwIfAborted()
    if (!config.retryLargeHtml || error?.code !== 'WEB_FETCH_TOO_LARGE') throw articleFetchError(error)
  }
  signal.throwIfAborted()
  if (page && (!config.retryLargeHtml || !page.truncated || page.body.kind !== 'html' || page.statusCode < 200 || page.statusCode >= 300)) {
    return { page, transport: 'configured-web', retried: false }
  }
  // 仅恢复响应大小失败；登录、拒绝访问、网络错误和跨源跳转不会触发另一条抓取路径。
  try { page = await largeFetch(url, config, signal) }
  catch (error) { signal.throwIfAborted(); throw articleFetchError(error) }
  signal.throwIfAborted()
  if (page.truncated) throw failure('article-html-limit')
  return { page, transport: 'anonymous-http-size-retry', retried: true }
}
