/** Retrieval ladder, charset decoding, pacing and session cookies as one pipeline. */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fetchPage, fetchArticlePage } from '../src/fetch.js'
import { resolveConfig } from '../src/config.js'
import { pacer } from '../src/pacing.js'
import { CookieJar } from '../src/session.js'
import { ResponseCache } from '../src/cache.js'
import { createPublicRequest } from '../src/capture-media.js'
import { ArticleService } from '../src/service.js'
import { escalate, planRungs, failureFamily } from '../src/pipeline.js'

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1qggSoBOoLrdHOM-Y3YGaMUTQ3BwphWohVeDtOABWRCg/edit#gid=461869238'
const sampleCsv = readFileSync(fileURLToPath(new URL('./fixtures/sample-sheet.csv', import.meta.url)), 'utf8')
const GBK_PHRASE = [0xd5, 0xe2, 0xca, 0xc7, 0xd2, 0xbb, 0xc6, 0xaa, 0xd6, 0xd0, 0xce, 0xc4, 0xce, 0xc4, 0xd5, 0xc2]
const ARTICLE_HTML = `<html lang="pt-BR"><head><title>Roteiro</title></head><body><article><h1>Roteiro</h1>${
  Array.from({ length: 14 }, (_, index) => `<p>Parágrafo ${index + 1} do roteiro com conteúdo suficiente para passar do limite mínimo de extração configurado.</p>`).join('')
}</article></body></html>`
const NO_TEXT_HTML = '<html><head><title>App</title></head><body><main><div></div></main></body></html>'

const cleanups = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

/** A response the pinned transport would have produced. */
const response = (url, bytes, { statusCode = 200, type = 'text/html' } = {}) => ({ url, statusCode, headers: { 'content-type': type }, bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes) })

/** Transport double that answers from a script and records every call. */
function scriptedRequest(steps) {
  const calls = []
  return {
    calls,
    request: async (url, options) => {
      calls.push({ url, headers: options.headers })
      const step = steps[Math.min(calls.length - 1, steps.length - 1)]
      if (step instanceof Error) throw step
      return typeof step === 'function' ? step(url) : step
    },
  }
}

const pacedConfig = overrides => resolveConfig({ hostRatePerSecond: 100, hostBurst: 50, ...overrides })
// 睡眠推进假时钟：令牌桶按流逝时间补充，睡眠不推进时间会让等待永不结束。
const instantPacer = () => {
  const sleeps = []
  let time = 1_000_000
  return { sleeps, paced: new pacer(resolveConfig({}), { now: () => time, sleep: async ms => { sleeps.push(ms); time += ms } }) }
}

describe('strategy ladder', () => {
  it('classifies every owned failure into a family that decides the next rung', () => {
    expect(failureFamily('article-access')).toBe('client')
    expect(failureFamily('article-restricted')).toBe('decision')
    expect(failureFamily('article-challenge')).toBe('content')
    expect(failureFamily('article-timeout')).toBe('transport')
    // 未登记的错误码不能触发浏览器。
    expect(failureFamily('article-unknown-code')).toBe('transport')
  })

  it('skips the structured rung when only the browser can change the outcome', () => {
    const rungs = planRungs('fallback')
    expect(escalate(rungs, 'static', 'article-access')).toBe('browser')
    expect(escalate(rungs, 'static', 'article-extraction')).toBe('structured')
    // 受限/404/429 是站点的决定，渲染会得到同一答案。
    expect(escalate(rungs, 'static', 'article-restricted')).toBeNull()
    expect(escalate(rungs, 'static', 'article-not-found')).toBeNull()
    expect(escalate(rungs, 'static', 'article-rate-limit')).toBeNull()
  })

  it('plans no browser at all in never mode and only the browser in always mode', () => {
    expect(planRungs('never')).toEqual(['static', 'structured'])
    expect(planRungs('always')).toEqual(['browser'])
    expect(escalate(planRungs('never'), 'static', 'article-access')).toBeNull()
  })
})

describe('charset-aware retrieval', () => {
  it('decodes a GBK page that declares its charset only in the meta tag', async () => {
    const page = Buffer.concat([Buffer.from('<html><head><meta charset="gbk"></head><body><p>', 'latin1'), Buffer.from(GBK_PHRASE), Buffer.from('</p></body></html>', 'latin1')])
    const transport = scriptedRequest([response('https://example.com/a', page)])
    const result = await fetchPage('https://example.com/a', resolveConfig({}), undefined, transport.request)
    expect(result.charset).toBe('gb18030')
    expect(result.body.content).toContain('这是一篇中文文章')
    expect(result.body.content).not.toContain('\ufffd')
  })

  it('reports the charset through the article retrieval entry point', async () => {
    const page = Buffer.concat([Buffer.from('<meta charset="gbk"><p>', 'latin1'), Buffer.from(GBK_PHRASE), Buffer.from('</p>', 'latin1')])
    const transport = scriptedRequest([response('https://example.com/a', page)])
    const result = await fetchArticlePage(resolveConfig({}), 'https://example.com/a', undefined, transport.request)
    expect(result.charset).toBe('gb18030')
  })
})

describe('server-directed pacing', () => {
  it('waits for Retry-After and succeeds on the second attempt', async () => {
    const { sleeps, paced } = instantPacer()
    const transport = scriptedRequest([
      { url: 'https://example.com/a', statusCode: 429, headers: { 'content-type': 'text/html', 'retry-after': '3' }, bytes: Buffer.from('') },
      response('https://example.com/a', ARTICLE_HTML),
    ])
    const result = await fetchPage('https://example.com/a', pacedConfig({}), undefined, transport.request, { pacer: paced })
    expect(transport.calls).toHaveLength(2)
    expect(sleeps).toEqual([3000])
    expect(result.statusCode).toBe(200)
  })

  it('retries a 503 only when the server says when to come back', async () => {
    const withoutHeader = instantPacer()
    const first = scriptedRequest([{ url: 'https://example.com/a', statusCode: 503, headers: { 'content-type': 'text/html' }, bytes: Buffer.from('') }, response('https://example.com/a', ARTICLE_HTML)])
    const immediate = await fetchPage('https://example.com/a', pacedConfig({}), undefined, first.request, { pacer: withoutHeader.paced })
    expect(first.calls).toHaveLength(1)
    expect(immediate.statusCode).toBe(503)

    const withHeader = instantPacer()
    const second = scriptedRequest([{ url: 'https://example.com/a', statusCode: 503, headers: { 'content-type': 'text/html', 'retry-after': '1' }, bytes: Buffer.from('') }, response('https://example.com/a', ARTICLE_HTML)])
    const retried = await fetchPage('https://example.com/a', pacedConfig({}), undefined, second.request, { pacer: withHeader.paced })
    expect(second.calls).toHaveLength(2)
    expect(retried.statusCode).toBe(200)
  })

  it('stops after one retry when the server keeps refusing', async () => {
    const { paced } = instantPacer()
    const transport = scriptedRequest([{ url: 'https://example.com/a', statusCode: 429, headers: { 'content-type': 'text/html', 'retry-after': '1' }, bytes: Buffer.from('') }])
    const result = await fetchPage('https://example.com/a', pacedConfig({}), undefined, transport.request, { pacer: paced })
    expect(transport.calls).toHaveLength(2)
    expect(result.statusCode).toBe(429)
  })
})

describe('session cookies across the ladder', () => {
  const setup = async (overrides, dependencies) => {
    const dir = await mkdtemp(join(tmpdir(), 'article-image-ladder-'))
    const service = new ArticleService(resolveConfig({ dataDir: dir, ...overrides }), { download: async () => sampleCsv, ...dependencies })
    cleanups.push(async () => { await service.dispose(); await rm(dir, { recursive: true, force: true }) })
    await service.importSource({ url: SHEET_URL })
    const { items } = await service.list({})
    return { service, id: items[0].id }
  }

  it('keeps a Set-Cookie issued on a redirect hop', async () => {
    // 登录门闸的常见形态：先 302 到正文，同时下发会话。丢弃跳转上的 Set-Cookie 会让跳转后的正文变成 403。
    const server = createServer((request, response) => {
      if (request.url === '/gate') {
        response.writeHead(302, { location: '/article', 'set-cookie': 'gate=passed; Path=/; Max-Age=600' })
        response.end()
        return
      }
      const passed = (request.headers.cookie ?? '').includes('gate=passed')
      response.writeHead(passed ? 200 : 403, { 'content-type': 'text/html; charset=utf-8' })
      response.end(passed ? ARTICLE_HTML : NO_TEXT_HTML)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const origin = `http://127.0.0.1:${server.address().port}`
    cleanups.push(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
    const policy = async url => { if (url.origin !== origin) throw Object.assign(new Error('blocked'), { code: 'article-url-blocked' }); return [{ address: '127.0.0.1', family: 4 }] }
    const jar = new CookieJar()
    const request = createPublicRequest(resolveConfig({}), { networkPolicy: policy })
    const page = await fetchPage(`${origin}/gate`, resolveConfig({}), undefined, request, { jar })
    expect(page.statusCode).toBe(200)
    expect(jar.header(`${origin}/article`)).toBe('gate=passed')
    expect(page.body.content).toContain('Parágrafo 1')
  })

  it('sends a cookie set by static retrieval into the browser render', async () => {
    const jar = new CookieJar()
    let seenInRenderer
    const renderer = {
      dispose: async () => {},
      async render() { seenInRenderer = jar.header('https://example.com/a'); return { url: 'https://example.com/a', statusCode: 200, truncated: false, body: { kind: 'html', content: ARTICLE_HTML }, visible: '' } },
    }
    const fetchPageDouble = async () => {
      // 与真实传输一致：先入 jar，再返回同一响应。
      jar.store('https://example.com/a', { 'set-cookie': 'gate=passed; Path=/' })
      return { url: 'https://example.com/a', statusCode: 200, truncated: false, body: { kind: 'html', content: NO_TEXT_HTML } }
    }
    const { service, id } = await setup({ renderMode: 'fallback' }, { fetchPage: fetchPageDouble, renderer, jar })
    const item = await service.fetchArticle(id, undefined)
    expect(item.state).toBe('ready')
    expect(seenInRenderer).toBe('gate=passed')
  })

  it('walks static then structured without a browser when JSON-LD carries the body', async () => {
    const declared = 'Texto declarado para leitores automáticos. '.repeat(20)
    const html = `<html><head><title>Declarado</title><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', headline: 'Título declarado', articleBody: declared })}</script></head><body><main><div id="app"></div></main></body></html>`
    const renderer = { dispose: async () => {}, async render() { throw new Error('browser must not run') } }
    const { service, id } = await setup({ renderMode: 'never' }, { fetchPage: async (config, url) => ({ url, statusCode: 200, truncated: false, body: { kind: 'html', content: html } }), renderer })
    const item = await service.fetchArticle(id, undefined)
    expect(item.state).toBe('ready')
    expect(item.article.title).toBe('Título declarado')
    expect(item.article.paragraphs.length).toBe(1)
    expect(item.article.paragraphs[0].text).toContain('Texto declarado')
  })

  it('reuses a fresh cached response without contacting the origin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'article-image-cache-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const cache = new ResponseCache(join(dir, 'http-cache'))
    let hits = 0
    const request = async (url) => {
      hits += 1
      return { url, statusCode: 200, headers: { 'content-type': 'text/html', 'cache-control': 'public, max-age=600' }, bytes: Buffer.from(`<html><body><article><p>Trecho ${hits}</p></article></body></html>`) }
    }
    const first = await fetchPage('https://example.com/a', resolveConfig({ dataDir: dir }), undefined, request, { cache })
    const second = await fetchPage('https://example.com/a', resolveConfig({ dataDir: dir }), undefined, request, { cache })
    expect(hits).toBe(1)
    expect(first.cached ?? false).toBe(false)
    expect(second.cached).toBe(true)
    expect(second.body.content).toContain('Trecho 1')
  })

  it('re-fetches when the response is not cacheable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'article-image-nocache-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const cache = new ResponseCache(join(dir, 'http-cache'))
    let hits = 0
    const request = async (url) => {
      hits += 1
      return { url, statusCode: 200, headers: { 'content-type': 'text/html', 'cache-control': 'no-store' }, bytes: Buffer.from('<html><body><article><p>Trecho</p></article></body></html>') }
    }
    const config = resolveConfig({ dataDir: dir })
    await fetchPage('https://example.com/a', config, undefined, request, { cache })
    await fetchPage('https://example.com/a', config, undefined, request, { cache })
    expect(hits).toBe(2)
  })

  it('revalidates with the stored ETag and reuses the body on 304', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'article-image-etag-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const cache = new ResponseCache(join(dir, 'http-cache'))
    const config = resolveConfig({ dataDir: dir })
    const calls = []
    const request = async (url, options) => {
      calls.push(options.headers)
      // 第一次 200 + ETag + no-cache；第二次必须带 If-None-Match，并回 304 无正文。
      if (calls.length === 1) {
        return { url, statusCode: 200, headers: { 'content-type': 'text/html', 'cache-control': 'max-age=0, no-cache', etag: 'W/"v1"' }, bytes: Buffer.from('<html><body><article><p>Versão original</p></article></body></html>') }
      }
      return { url, statusCode: 304, headers: {}, bytes: Buffer.alloc(0) }
    }
    const first = await fetchPage('https://example.com/a', config, undefined, request, { cache })
    const second = await fetchPage('https://example.com/a', config, undefined, request, { cache })
    expect(calls[1]['if-none-match']).toBe('W/"v1"')
    expect(second.cached).toBe(true)
    expect(second.body.content).toBe(first.body.content)
  })

  it('reuses a page that carries only Last-Modified', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'article-image-heuristic-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const cache = new ResponseCache(join(dir, 'http-cache'))
    let hits = 0
    const modified = new Date(Date.now() - 3_600_000).toUTCString()
    const request = async (url) => {
      hits += 1
      return { url, statusCode: 200, headers: { 'content-type': 'text/html', 'last-modified': modified }, bytes: Buffer.from('<html><body><article><p>Sem Cache-Control</p></article></body></html>') }
    }
    const config = resolveConfig({ dataDir: dir })
    await fetchPage('https://example.com/a', config, undefined, request, { cache })
    const second = await fetchPage('https://example.com/a', config, undefined, request, { cache })
    expect(hits).toBe(1)
    expect(second.cached).toBe(true)
  })

  it('exposes the ladder, pacing and session limits in the status policy', async () => {
    const { service } = await setup({ renderMode: 'fallback', hostRatePerSecond: 2, hostBurst: 5, maxSessionCookies: 40 }, { fetchPage: async () => { throw new Error('unused') } })
    const status = await service.status()
    expect(status.retrievalPolicy).toMatchObject({ ladder: ['static', 'structured', 'browser'], hostRatePerSecond: 2, hostBurst: 5, maxSessionCookies: 40, responseCache: false })
  })

  it('reports the response cache as enabled once configured', async () => {
    const { service } = await setup({ fetchCache: true }, { fetchPage: async () => { throw new Error('unused') } })
    expect((await service.status()).retrievalPolicy.responseCache).toBe(true)
  })
})
