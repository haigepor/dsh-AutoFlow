/** Explicit image CDN edges cannot change navigation, destination checks or credential scope. */
import { test, expect } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createPublicRequest } from '../src/capture-media.js'
import { createCapture, resolveCaptureConfig } from '../src/capture.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVQImWP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64')
async function fixture(t, overrides = {}) {
  const requests = [], policies = []
  const server = createServer((request, response) => {
    requests.push({ host: request.headers.host, path: request.url, headers: request.headers })
    if (request.url === '/original') { response.writeHead(301, { location: b + '/broker', 'set-cookie': 'original=secret; Path=/' }); response.end('redirect') }
    else if (request.url === '/broker') { response.writeHead(302, { location: a + '/poster', 'set-cookie': 'broker=secret; Path=/' }); response.end() }
    else if (request.url === '/unapproved') { response.writeHead(302, { location: c + '/poster' }); response.end() }
    else if (request.url === '/private') { response.writeHead(302, { location: b + '/blocked' }); response.end() }
    else { response.writeHead(200, { 'content-type': 'image/png', 'set-cookie': 'final=public; Path=/' }); response.end(png) }
  })
  t.onTestFinished(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port, a = `http://images.example.test:${port}`, b = `http://broker.example.test:${port}`, c = `http://unapproved.example.test:${port}`
  // HTTP origins and loopback pinning are isolated fixture inputs; the public schema permits HTTPS edges only.
  const edges = [{ from: a, to: b }, { from: b, to: a }]
  const config = resolveCaptureConfig({ requestTimeoutMs: 5000, ...overrides })
  const request = createPublicRequest(config, { networkPolicy: async url => {
    policies.push(url.href)
    if (url.pathname === '/blocked') throw Object.assign(new Error('article-url-blocked'), { code: 'article-url-blocked' })
    return [{ address: '127.0.0.1', family: 4 }]
  } })
  return { a, b, c, edges, config, request, requests, policies }
}

test('ordinary requests and unconfigured image sessions keep rejecting cross-origin redirects', async t => {
  const f = await fixture(t), session = f.request.createSession()
  t.onTestFinished(() => session.dispose())
  await expect(f.request(f.a + '/original')).rejects.toMatchObject({ code: 'article-redirect' })
  await expect(session(f.a + '/original')).rejects.toMatchObject({ code: 'article-redirect' })
  expect(f.requests.every(r => r.path === '/original')).toBe(true)
})

test('an explicit image edge chain revalidates each destination and strips credentials and prior cookies', async t => {
  const f = await fixture(t), session = f.request.createSession({ redirects: f.edges })
  t.onTestFinished(() => session.dispose())
  const response = await session(f.a + '/original', { headers: { Cookie: 'initial=private', Authorization: 'Bearer private', 'Proxy-Authorization': 'Basic private', referer: 'https://article.example.test/', accept: 'image/*' } })
  expect(response.bytes).toEqual(png)
  expect(response.chargedBytes).toBe(png.length + 8)
  expect(response.url).toBe(f.a + '/poster')
  expect(f.policies).toEqual([f.a + '/original', f.b + '/broker', f.a + '/poster'])
  expect(f.requests[0].headers.cookie).toBe('initial=private')
  for (const r of f.requests.slice(1)) {
    expect(r.headers.cookie).toBeUndefined(); expect(r.headers.authorization).toBeUndefined(); expect(r.headers['proxy-authorization']).toBeUndefined()
    expect(r.headers.referer).toBe('https://article.example.test/'); expect(r.headers.accept).toBe('image/*')
  }
  expect(response.headers['set-cookie']).toEqual(['final=public; Path=/'])
})

test('a configured edge does not authorize any other origin or bypass a rejected destination', async t => {
  const f = await fixture(t), session = f.request.createSession({ redirects: f.edges })
  t.onTestFinished(() => session.dispose())
  await expect(session(f.a + '/unapproved')).rejects.toMatchObject({ code: 'article-redirect' })
  await expect(session(f.a + '/private')).rejects.toMatchObject({ code: 'article-url-blocked' })
  expect(f.requests.map(r => r.path)).toEqual(['/unapproved', '/private'])
})

test('configured CDN hops retain the existing redirect and image byte limits', async t => {
  const f = await fixture(t, { maxRedirects: 1 }), session = f.request.createSession({ redirects: f.edges })
  t.onTestFinished(() => session.dispose())
  await expect(session(f.a + '/original')).rejects.toMatchObject({ code: 'article-redirect' })
  expect(f.requests.map(r => r.path)).toEqual(['/original', '/broker'])
  await expect(session(f.a + '/poster', { maxBytes: 10 })).rejects.toMatchObject({ code: 'article-resource-limit' })
})

test('image CDN exceptions do not forward request bodies and charge redirect response bytes', async t => {
  const f = await fixture(t), session = f.request.createSession({ redirects: f.edges })
  t.onTestFinished(() => session.dispose())
  await expect(session(f.a + '/original', { method: 'POST', body: 'private-request-body' })).rejects.toMatchObject({ code: 'article-redirect' })
  expect(f.requests.map(r => r.path)).toEqual(['/original'])
  await expect(session(f.a + '/original', { maxBytes: png.length })).rejects.toMatchObject({ code: 'article-resource-limit' })
})

test('capture passes CDN edges only to the original-image session and preserves the original body', async t => {
  const f = await fixture(t)
  const capture = createCapture({ ...f.config, adapters: [{ id: 'fixture', hosts: ['article.example.test'], articleSelector: 'article', imageRedirects: f.edges }] }, {
    request: f.request, inspectImage: async () => ({ width: 2, height: 2 }),
    renderer: { render: async url => ({ url, statusCode: 200, diagnostics: [], html: `<title>Published reporting</title><article><p>${'Complete public reporting. '.repeat(8)}</p><img src="${f.a}/original"></article>` }), dispose: async () => {} },
  })
  t.onTestFinished(() => capture.dispose())
  const { snapshot } = await capture.capture('https://article.example.test/report')
  expect(snapshot.blocks.filter(b => b.type === 'paragraph')).toHaveLength(1)
  expect(snapshot.assets[0]).toMatchObject({ status: 'ready', byteLength: png.length, sourceUrl: f.a + '/poster' })
})

test('adapter CDN edges require exact distinct HTTPS origins without credentials, paths or wildcards', () => {
  const adapter = { id: 'fixture', hosts: ['article.example.test'], articleSelector: 'article' }
  expect(resolveCaptureConfig({ adapters: [{ ...adapter, imageRedirects: [{ from: 'https://images.example.test', to: 'https://cdn.example.test' }] }] }).adapters[0].imageRedirects).toHaveLength(1)
  for (const from of ['http://images.example.test', 'https://user:secret@images.example.test', 'https://*.example.test', 'https://images.example.test/path', 'https://images.example.test?secret=1']) {
    expect(() => resolveCaptureConfig({ adapters: [{ ...adapter, imageRedirects: [{ from, to: 'https://cdn.example.test' }] }] })).toThrow()
  }
})
