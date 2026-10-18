/** Both public article extraction paths preserve the same HTTP failure semantics. */
import { describe, expect, it } from 'vitest'
import { extractArticle } from '../src/articles.js'
import { createCapture, resolveCaptureConfig } from '../src/capture.js'
import { resolveConfig } from '../src/config.js'

const url = 'https://articles.example.test/story'

describe('HTTP errors across text and rich capture', () => {
  it.each([
    [401, 'article-access'], [403, 'article-access'], [404, 'article-not-found'],
    [429, 'article-rate-limit'], [500, 'article-server'], [503, 'article-server'],
  ])('keeps HTTP %i as %s in both paths', async (statusCode, code) => {
    const page = { url, statusCode, truncated: false, body: { kind: 'text', content: '' } }
    expect(() => extractArticle(page, { url, language: '' }, resolveConfig())).toThrow(code)
    const capture = createCapture(resolveCaptureConfig(), { renderer: {
      async render() { return { html: '', url, statusCode, diagnostics: [] } },
      async dispose() {}, async readiness() { return { available: true } },
    } })
    try { await expect(capture.capture(url)).rejects.toThrow(code) }
    finally { await capture.dispose() }
  })
})
