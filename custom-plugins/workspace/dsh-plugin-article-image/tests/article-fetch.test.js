import { test, expect, vi } from 'vitest'
import { fetchArticlePage, articleFetchError } from '../src/host/article-fetch.js'
import { resolveConfig } from '../config-schema.js'

const url = 'https://example.com/article', signal = new AbortController().signal
const page = (values = {}) => ({ url, statusCode: 200, body: { kind: 'html', content: '<article>Complete response</article>' }, truncated: false, ...values })
const nativeError = code => Object.assign(new Error('private upstream diagnostics'), { code })

test('uses the configured provider without a second request for complete pages', async () => {
  const response = page(), web = { fetch: vi.fn(async () => response) }, large = vi.fn()
  expect(await fetchArticlePage(web, resolveConfig({}), url, signal, large)).toEqual({ page: response, transport: 'configured-web', retried: false })
  expect(web.fetch).toHaveBeenCalledWith({ url }, signal)
  expect(large).not.toHaveBeenCalled()
})

test('recovers a truncated HTML page once with independent raw HTML limits', async () => {
  const config = resolveConfig({ maxArticleHtmlBytes: 8000000, maxArticleHtmlChars: 2000000 })
  const complete = page(), large = vi.fn(async () => complete)
  expect(await fetchArticlePage({ fetch: async () => page({ truncated: true }) }, config, url, signal, large)).toEqual({ page: complete, transport: 'anonymous-http-size-retry', retried: true })
  expect(large).toHaveBeenCalledExactlyOnceWith(url, config, signal)
})

test('recovers only the native response-size error and refuses a truncated retry', async () => {
  const web = { fetch: async () => { throw nativeError('WEB_FETCH_TOO_LARGE') } }, large = vi.fn(async () => page({ truncated: true }))
  await expect(fetchArticlePage(web, resolveConfig({}), url, signal, large)).rejects.toThrow('article-html-limit')
  expect(large).toHaveBeenCalledTimes(1)
})

test('respects disabled recovery and never retries denied or text-only responses', async () => {
  const large = vi.fn()
  await fetchArticlePage({ fetch: async () => page({ truncated: true }) }, resolveConfig({ retryLargeHtml: false }), url, signal, large)
  await fetchArticlePage({ fetch: async () => page({ statusCode: 403, truncated: true }) }, resolveConfig({}), url, signal, large)
  await fetchArticlePage({ fetch: async () => page({ body: { kind: 'text', content: 'Partial text' }, truncated: true }) }, resolveConfig({}), url, signal, large)
  expect(large).not.toHaveBeenCalled()
})

for (const [code, expected] of [['WEB_FETCH_TIMEOUT', 'article-timeout'], ['WEB_REDIRECT_BLOCKED', 'article-redirect'], ['WEB_BLOCKED_URL', 'article-url-blocked'], ['WEB_PROVIDER_ERROR', 'article-network'], ['WEB_UNSUPPORTED_CONTENT_TYPE', 'article-unsupported'], ['WEB_PROVIDER_CONFIGURED_MISSING', 'article-provider']]) {
  test(`reports ${code} without retrying or exposing upstream text`, async () => {
    const large = vi.fn(), error = nativeError(code)
    await expect(fetchArticlePage({ fetch: async () => { throw error } }, resolveConfig({}), url, signal, large)).rejects.toThrow(expected)
    expect(articleFetchError(error).message).not.toContain('private')
    expect(large).not.toHaveBeenCalled()
  })
}

test('an aborted operation never starts a recovery request', async () => {
  const controller = new AbortController(), large = vi.fn()
  await expect(fetchArticlePage({ fetch: async () => { controller.abort(); return page({ truncated: true }) } }, resolveConfig({}), url, controller.signal, large)).rejects.toThrow()
  expect(large).not.toHaveBeenCalled()
})
