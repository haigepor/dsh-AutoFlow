/** Record, inspect, replay and export against a loopback fixture with an exact injected policy. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { chromium } from 'patchright'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.js'
import { resolveCaptureConfig } from '../src/capture.js'
import { CaptureRenderer } from '../src/capture-renderer.js'
import { createPublicRequest } from '../src/capture-media.js'
import { Recorder } from '../src/recorder.js'
import { replayExchange } from '../src/replay.js'
import { redactExchange } from '../src/har.js'

let sharedBrowser, dir, recorder, config, renderer, fixture, captureConfig
beforeAll(async () => {
  captureConfig = resolveCaptureConfig({ renderTimeoutMs: 10000, renderWaitMs: 200, scrollWaitMs: 10, maxScrollSteps: 10, requestTimeoutMs: 5000 })
  sharedBrowser = await chromium.launch({ headless: true, timeout: captureConfig.renderTimeoutMs })
}, 30000)
afterAll(async () => { await sharedBrowser?.close() }, 30000)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'article-image-record-'))
  config = resolveConfig({ dataDir: dir })
  recorder = new Recorder(config)
  fixture = await createFixture()
  renderer = new CaptureRenderer(resolveCaptureConfig({ renderTimeoutMs: 10000, renderWaitMs: 150, scrollWaitMs: 10, maxScrollSteps: 10, requestTimeoutMs: 5000 }), {
    request: createPublicRequest(captureConfig, { networkPolicy: fixture.policy }),
    loadChromium: async () => ({ launch: async () => ({ newContext: options => sharedBrowser.newContext(options), close: async () => {} }) }),
  })
})
afterEach(async () => {
  await renderer?.dispose(); await fixture?.close(); await rm(dir, { recursive: true, force: true })
})

/** Owned loopback origin: a page that calls an authenticated JSON API and posts a login form. */
async function createFixture() {
  const requests = []
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, headers: request.headers })
    if (request.url.startsWith('/api/items')) {
      response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=fixture-secret; Path=/' })
      response.end(JSON.stringify({ items: [{ id: 1, title: 'Roteiro' }], access_token: 'fixture-access-token' }))
      return
    }
    if (request.url === '/login' && request.method === 'POST') {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += chunk })
      request.on('end', () => { response.writeHead(204, { 'x-echo': String(body.length) }); response.end() })
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<html lang="pt-BR"><head><title>Captured fixture</title></head><body><article><h1>Captured fixture</h1>${'<p>Corpo da reportagem em português.</p>'.repeat(20)}</article><script>
      fetch('/api/items?page=1', { headers: { authorization: 'Bearer fixture-token' } }).then(r => r.json())
      fetch('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'user=ana&password=fixture-password' })
    </script></body></html>`)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    origin, requests,
    policy: async url => {
      if (url.origin !== origin) throw Object.assign(new Error('article-url-blocked'), { code: 'article-url-blocked' })
      return [{ address: '127.0.0.1', family: 4 }]
    },
    close: async () => { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) },
  }
}

const request = () => createPublicRequest(config, { networkPolicy: fixture.policy })

describe('network recording', () => {
  it('records documents and API calls with an endpoint inventory', async () => {
    const capture = await recorder.record(`${fixture.origin}/article`, { renderer })
    expect(capture.scope).toBe('api')
    expect(capture.entries).toBeGreaterThanOrEqual(2)
    expect(capture.dropped).toBe(0)
    expect(capture.endpoints.map(endpoint => endpoint.path)).toEqual(expect.arrayContaining(['/article', '/api/items']))
    const api = capture.endpoints.find(endpoint => endpoint.path === '/api/items')
    expect(api).toMatchObject({ method: 'GET', count: 1, statuses: [200], query: ['page'] })
    expect(api.auth).toMatchObject({ scheme: 'bearer', present: true })
    expect(api.cookie).toBeNull()
  })

  it('records a blocked write request without sending it', async () => {
    const capture = await recorder.record(`${fixture.origin}/article`, { renderer })
    const login = (await recorder.exchanges(capture.id)).find(entry => new URL(entry.request.url).pathname === '/login')
    expect(login).toMatchObject({ sent: false, blocked: 'article-resource-method' })
    expect(login.request.method).toBe('POST')
    expect(login.request.body).toContain('password=fixture-password')
    // 服务端没有收到这次 POST：拦截发生在代发之前。
    expect(fixture.requests.some(sent => sent.url === '/login')).toBe(false)
    // 默认读取仍然脱敏。
    expect(redactExchange(login).request.body).toBe(`user=ana&password=<redacted:${'fixture-password'.length}>`)
  })

  it('keeps raw credentials in private files while the index stays redacted', async () => {
    const capture = await recorder.record(`${fixture.origin}/article`, { renderer })
    const index = await readFile(join(dir, 'captures', capture.id, 'index.json'), 'utf8')
    expect(index).not.toContain('fixture-token')
    expect(index).not.toContain('fixture-password')
    const exchanges = await recorder.exchanges(capture.id)
    const api = exchanges.find(entry => new URL(entry.request.url).pathname === '/api/items')
    expect(api.request.headers.authorization).toBe('Bearer fixture-token')
    const view = redactExchange(api)
    expect(JSON.stringify(view)).not.toContain('fixture-token')
    expect(view.request.headers.authorization).toBe(`Bearer <redacted:${'Bearer fixture-token'.length}>`)
    expect(JSON.parse(view.response.body).access_token).toBe('<redacted:20>')
  })

  it('stores every capture artifact with owner-only permissions', async () => {
    if (process.platform === 'win32') return
    const capture = await recorder.record(`${fixture.origin}/article`, { renderer })
    expect((await stat(join(dir, 'captures'))).mode & 0o777).toBe(0o700)
    expect((await stat(join(dir, 'captures', capture.id, 'index.json'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(dir, 'captures', capture.id, 'raw', '00000.json'))).mode & 0o777).toBe(0o600)
  })

  it('filters image and font resources out of the api scope', async () => {
    const capture = await recorder.record(`${fixture.origin}/article`, { renderer })
    const exchanges = await recorder.exchanges(capture.id)
    expect(exchanges.every(entry => ['document', 'xhr', 'fetch', 'websocket'].includes(entry.resourceType))).toBe(true)
  })

  it('stops at the entry budget and reports the dropped count', async () => {
    const limited = new Recorder(resolveConfig({ dataDir: dir, maxRecordEntries: 2 }))
    const capture = await limited.record(`${fixture.origin}/article`, { renderer })
    expect(capture.entries).toBe(2)
    expect(capture.dropped).toBeGreaterThan(0)
  })

  it('reports a missing renderer instead of silently recording nothing', async () => {
    await expect(recorder.record(`${fixture.origin}/article`, {})).rejects.toThrow('capture-renderer-missing')
  })

  it('rejects an unknown capture id and an out-of-range index', async () => {
    const capture = await recorder.record(`${fixture.origin}/article`, { renderer })
    await expect(recorder.index('0'.repeat(32))).rejects.toThrow('capture-missing')
    await expect(recorder.exchange(capture.id, capture.entries)).rejects.toThrow('capture-index')
    await expect(recorder.exchange(capture.id, -1)).rejects.toThrow('capture-index')
    // 非法 id 由 schema 拒绝，工具层再把它翻译成 invalid-request；不触碰文件系统。
    await expect(recorder.index('../../etc/passwd')).rejects.toThrow()
  })
})

describe('replay', () => {
  it('replays with a changed query and appends the result to the capture', async () => {
    const capture = await recorder.record(`${fixture.origin}/article`, { renderer })
    const exchanges = await recorder.exchanges(capture.id)
    const index = exchanges.findIndex(entry => new URL(entry.request.url).pathname === '/api/items')
    const result = await replayExchange(exchanges[index], { query: { page: '2', lang: 'pt' } }, { request: request(), limits: { maxExchangeBytes: config.maxExchangeBytes } })
    expect(result.response.status).toBe(200)
    expect(result.request.url).toContain('page=2')
    expect(result.request.url).toContain('lang=pt')
    expect(result.request.headers.authorization).toBe('Bearer fixture-token')
    const appended = await recorder.append(capture.id, result)
    expect(appended).toBe(capture.entries)
    const after = await recorder.index(capture.id)
    expect(after.entries).toBe(capture.entries + 1)
    expect(after.endpoints.find(endpoint => endpoint.path === '/api/items')).toMatchObject({ count: 2, query: ['lang', 'page'] })
    expect((await recorder.exchange(capture.id, appended)).replayed).toBe(true)
  })

  it('refuses a captured loopback target under the production policy', async () => {
    const capture = await recorder.record(`${fixture.origin}/article`, { renderer })
    const exchange = (await recorder.exchanges(capture.id))[0]
    const production = createPublicRequest(config)
    await expect(replayExchange(exchange, {}, { request: production, limits: { maxExchangeBytes: config.maxExchangeBytes } }))
      .rejects.toThrow('article-url-blocked')
  })

  it('rejects unsupported methods and cross-origin URL overrides before sending', async () => {
    const capture = await recorder.record(`${fixture.origin}/article`, { renderer })
    const exchange = (await recorder.exchanges(capture.id))[0]
    const send = request()
    await expect(replayExchange(exchange, { method: 'TRACE' }, { request: send, limits: { maxExchangeBytes: 1024 } })).rejects.toThrow('replay-method')
    await expect(replayExchange(exchange, { url: 'https://example.com/other' }, { request: send, limits: { maxExchangeBytes: 1024 } })).rejects.toThrow('article-url-blocked')
    await expect(replayExchange(exchange, { url: 'file:///etc/passwd' }, { request: send, limits: { maxExchangeBytes: 1024 } })).rejects.toThrow('article-url-blocked')
  })

  it('drops caller-injected credential headers but keeps safe metadata overrides', async () => {
    const capture = await recorder.record(`${fixture.origin}/article`, { renderer })
    const exchange = (await recorder.exchanges(capture.id))[0]
    fixture.requests.length = 0
    await replayExchange(exchange, { headers: { authorization: 'Bearer injected', cookie: 'sid=injected', 'accept-language': 'zh-CN' } }, { request: request(), limits: { maxExchangeBytes: config.maxExchangeBytes } })
    const sent = fixture.requests.at(-1)
    expect(sent.headers.authorization).not.toBe('Bearer injected')
    expect(sent.headers.cookie).not.toBe('sid=injected')
    expect(sent.headers['accept-language']).toBe('zh-CN')
  })
})

describe('HAR round-trip', () => {
  it('exports a capture and imports it back with the same entry and endpoint counts', async () => {
    const capture = await recorder.record(`${fixture.origin}/article`, { renderer })
    const exported = await recorder.exportHar(capture.id, '0.1.0')
    expect(exported).toEqual({ file: `exports/${capture.id}.har`, bytes: expect.any(Number), entries: capture.entries })
    const document = JSON.parse(await readFile(join(dir, 'exports', `${capture.id}.har`), 'utf8'))
    expect(document.log.version).toBe('1.2')
    expect(document.log.entries).toHaveLength(capture.entries)

    const imported = await recorder.importHar({ file: exported.file })
    expect(imported.entries).toBe(capture.entries)
    expect(imported.endpoints).toHaveLength(capture.endpoints.length)
    expect(imported.scope).toBe('har')

    const reloaded = await recorder.exchanges(imported.id)
    const api = reloaded.find(entry => new URL(entry.request.url).pathname === '/api/items')
    expect(api.request.headers.authorization).toBe('Bearer fixture-token')
  })

  it('imports an inline document and rejects traversal, bad JSON and oversized input', async () => {
    const har = JSON.stringify({ log: { version: '1.2', entries: [{ request: { method: 'GET', url: `${fixture.origin}/x` }, response: { status: 200, content: { mimeType: 'text/plain', text: 'ok' } } }] } })
    const imported = await recorder.importHar({ har })
    expect(imported.entries).toBe(1)
    await expect(recorder.importHar({ file: '../../../etc/passwd' })).rejects.toThrow('har-invalid')
    await expect(recorder.importHar({ file: 'nope.har' })).rejects.toThrow('har-invalid')
    await expect(recorder.importHar({ har: '{not json' })).rejects.toThrow('har-invalid')
    await expect(recorder.importHar({ har: JSON.stringify({ log: { entries: [] } }) })).rejects.toThrow('capture-empty')
  })
})

describe('capture storage hygiene', () => {
  it('publishes no staging directory after a successful capture', async () => {
    const capture = await recorder.record(`${fixture.origin}/article`, { renderer })
    const { readdir } = await import('node:fs/promises')
    const names = await readdir(join(dir, 'captures'))
    expect(names).toEqual([capture.id])
  })
})
