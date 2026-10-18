/** Article-scoped image transport and decoding reuse retain network and lifetime guarantees. */
import { test, expect } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { connect } from 'node:net'
import { gzipSync } from 'node:zlib'
import { resolveCaptureConfig } from '../src/capture.js'
import { createPublicRequest } from '../src/capture-media.js'
import { CaptureRenderer } from '../src/capture-renderer.js'

const config = resolveCaptureConfig({ requestTimeoutMs: 5000, renderTimeoutMs: 5000 })
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVQImWP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64')

async function serverFixture(t, handler) {
  const sockets = new Map(), closed = [], requests = []
  let socketSequence = 0
  const server = createServer((request, response) => {
    requests.push({ url: request.url, host: request.headers.host, socket: sockets.get(request.socket) })
    if (handler?.(request, response)) return
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ socket: sockets.get(request.socket), url: request.url }))
  })
  server.on('connection', socket => {
    sockets.set(socket, ++socketSequence)
    closed.push(new Promise(resolve => socket.once('close', resolve)))
  })
  t.onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await Promise.all(closed)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://article.example.test:${server.address().port}`
  // Only this fixture injection may pin test domains to loopback; product policy is unchanged.
  const calls = [], policy = async url => {
    calls.push(url.href)
    if (url.pathname === '/private') throw Object.assign(new Error('article-url-blocked'), { code: 'article-url-blocked' })
    return [{ address: '127.0.0.1', family: 4 }]
  }
  return { origin, policy, calls, requests, closed, sockets }
}

const body = response => JSON.parse(response.bytes.toString('utf8'))

test('ordinary public requests retain one-shot connections without an implicit shared pool', async t => {
  const owned = await serverFixture(t), request = createPublicRequest(config, { networkPolicy: owned.policy })
  const first = body(await request(`${owned.origin}/one`)), second = body(await request(`${owned.origin}/two`))
  expect(second.socket).not.toBe(first.socket)
  expect(owned.calls).toEqual([`${owned.origin}/one`, `${owned.origin}/two`])
})

test('an article request session revalidates every URL while reusing a verified connection and closes it on disposal', async t => {
  const owned = await serverFixture(t), request = createPublicRequest(config, { networkPolicy: owned.policy })
  const session = request.createSession()
  t.onTestFinished(() => session.dispose())
  const first = body(await session(`${owned.origin}/one`)), second = body(await session(`${owned.origin}/two`))
  expect(second.socket).toBe(first.socket)
  expect(owned.calls).toEqual([`${owned.origin}/one`, `${owned.origin}/two`])
  await session.dispose()
  await Promise.all(owned.closed)
  await expect(session(`${owned.origin}/after-dispose`)).rejects.toMatchObject({ code: 'article-interrupted' })
  expect(owned.requests).toHaveLength(2)
})

test('origins, changed verified address sets and different article sessions never share a connection', async t => {
  const owned = await serverFixture(t)
  let addresses = [{ address: '127.0.0.1', family: 4 }]
  const policy = async url => { await owned.policy(url); return addresses }
  const request = createPublicRequest(config, { networkPolicy: policy }), first = request.createSession(), second = request.createSession()
  t.onTestFinished(async () => { await first.dispose(); await second.dispose() })
  const original = body(await first(`${owned.origin}/original`))
  addresses = [{ address: '127.0.0.1', family: 4 }, { address: '127.0.0.2', family: 4 }]
  const changed = body(await first(`${owned.origin}/changed`))
  expect(changed.socket).not.toBe(original.socket)
  addresses = [...addresses].reverse()
  const reordered = body(await first(`${owned.origin}/reordered`))
  expect(reordered.socket).toBe(changed.socket)
  const otherOrigin = body(await first(`${owned.origin.replace('article.', 'images.')}/other-origin`))
  expect(otherOrigin.socket).not.toBe(changed.socket)
  const otherArticle = body(await second(`${owned.origin}/other-article`))
  expect([original.socket, changed.socket, otherOrigin.socket]).not.toContain(otherArticle.socket)
  expect(owned.calls).toHaveLength(5)
})

test('disabling the article connection pool preserves bounded requests with fresh sockets', async t => {
  const owned = await serverFixture(t)
  const request = createPublicRequest({ ...config, imageConnectionPoolSize: 0 }, { networkPolicy: owned.policy }), session = request.createSession()
  t.onTestFinished(() => session.dispose())
  const first = body(await session(`${owned.origin}/one`)), second = body(await session(`${owned.origin}/two`))
  expect(second.socket).not.toBe(first.socket)
  expect(owned.calls).toHaveLength(2)
})

test('article image sessions reuse CONNECT tunnels pinned to the verified destination', async t => {
  const owned = await serverFixture(t), proxy = createServer(), tunnels = new Set(), destinations = []
  proxy.on('connect', (request, socket, head) => {
    destinations.push(request.url)
    const upstream = connect(new URL(owned.origin).port, '127.0.0.1')
    for (const value of [socket, upstream]) { tunnels.add(value); value.once('close', () => tunnels.delete(value)); value.on('error', () => { socket.destroy(); upstream.destroy() }) }
    upstream.once('connect', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket) })
    socket.once('close', () => upstream.destroy()); upstream.once('close', () => socket.destroy())
  })
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening')
  t.onTestFinished(async () => { for (const socket of tunnels) socket.destroy(); await new Promise(resolve => proxy.close(resolve)) })
  const request = createPublicRequest({ ...config, network: { ...config.network, proxyUrl: `http://127.0.0.1:${proxy.address().port}` } }, { networkPolicy: owned.policy }), session = request.createSession()
  t.onTestFinished(() => session.dispose())
  expect(body(await session(`${owned.origin}/first`)).socket).toBe(body(await session(`${owned.origin}/second`)).socket)
  expect(destinations).toEqual([`127.0.0.1:${new URL(owned.origin).port}`])
  expect(owned.requests.every(r => r.host === new URL(owned.origin).host)).toBe(true)
  expect(owned.calls).toHaveLength(2)
  await session.dispose()
})

test('session pooling cannot bypass redirected target policy, same-origin redirects or decoded byte limits', async t => {
  const owned = await serverFixture(t, (request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: '/final' }); response.end(); return true }
    if (request.url === '/denied') { response.writeHead(302, { location: '/private' }); response.end(); return true }
    if (request.url === '/cross-origin') { response.writeHead(302, { location: 'http://other.example.test/secret' }); response.end(); return true }
    if (request.url === '/large') { response.writeHead(200, { 'content-encoding': 'gzip' }); response.end(gzipSync(Buffer.alloc(1000))); return true }
    return false
  })
  const request = createPublicRequest(config, { networkPolicy: owned.policy }), session = request.createSession()
  t.onTestFinished(() => session.dispose())
  expect((await session(`${owned.origin}/redirect`)).url).toBe(`${owned.origin}/final`)
  await expect(session(`${owned.origin}/denied`)).rejects.toMatchObject({ code: 'article-url-blocked' })
  await expect(session(`${owned.origin}/cross-origin`)).rejects.toMatchObject({ code: 'article-redirect' })
  await expect(session(`${owned.origin}/large`, { maxBytes: 100 })).rejects.toMatchObject({ code: 'article-resource-limit' })
  expect(owned.calls).toContain(`${owned.origin}/private`)
  expect(owned.requests.some(value => value.url === '/private')).toBe(false)
  expect(owned.calls.some(value => value.startsWith('http://other.'))).toBe(false)
})

test('evicting an idle article pool closes the old socket before retaining another origin', async t => {
  const owned = await serverFixture(t), session = createPublicRequest({ ...config, imageConnectionPoolSize: 1 }, { networkPolicy: owned.policy }).createSession()
  t.onTestFinished(() => session.dispose())
  const first = body(await session(`${owned.origin}/first`))
  const second = body(await session(`${owned.origin.replace('article.', 'images.')}/second`))
  await owned.closed[0]
  const third = body(await session(`${owned.origin}/third`))
  expect(new Set([first.socket, second.socket, third.socket]).size).toBe(3)
})

test('session disposal settles an in-flight exchange and destroys its socket', async t => {
  const entered = Promise.withResolvers()
  const owned = await serverFixture(t, (request, response) => {
    if (request.url !== '/pending') return false
    response.writeHead(200); response.write('partial'); entered.resolve(); return true
  })
  const session = createPublicRequest(config, { networkPolicy: owned.policy }).createSession()
  t.onTestFinished(() => session.dispose())
  const pending = session(`${owned.origin}/pending`), stopped = expect(pending).rejects.toMatchObject({ code: 'article-interrupted' })
  await entered.promise; await session.dispose(); await stopped; await Promise.all(owned.closed)
})

test('aborting one session request closes its exchange without poisoning later validated requests', async t => {
  const entered = Promise.withResolvers()
  const owned = await serverFixture(t, (request, response) => {
    if (request.url !== '/pending') return false
    response.writeHead(200); response.write('partial'); entered.resolve(); return true
  })
  const session = createPublicRequest(config, { networkPolicy: owned.policy }).createSession(), controller = new AbortController()
  t.onTestFinished(() => session.dispose())
  const pending = session(`${owned.origin}/pending`, { signal: controller.signal })
  const cancelled = expect(pending).rejects.toMatchObject({ code: 'article-interrupted' })
  await entered.promise; controller.abort(); await cancelled
  expect((await session(`${owned.origin}/after-abort`)).statusCode).toBe(200)
  expect(owned.calls).toHaveLength(2)
})

function rendererFixture(t, options = {}) {
  const contexts = [], evaluations = [], browser = {
    async newContext() {
      const value = { pageCount: 0, closed: false, route: async () => {},
        async newPage() {
          value.pageCount++
          return { async evaluate(_callback, input) {
            if (value.closed) throw new Error('fixture-context-closed')
            evaluations.push({ context: contexts.indexOf(value), input })
            if (options.pending) { options.entered.resolve(); return options.pending.promise }
            expect(Buffer.from(input.base64, 'base64')).toEqual(png)
            expect(input.mime).toBe('image/png')
            return { width: 2, height: 2 }
          } }
        },
        async close() { value.closed = true; options.pending?.reject(new Error('fixture-context-closed')) },
      }
      contexts.push(value); return value
    },
    async close() { for (const context of contexts) await context.close() },
  }
  const renderer = new CaptureRenderer(config, { request() { throw new Error('unexpected-network') }, loadChromium: async () => ({ launch: async () => browser }) })
  t.onTestFinished(() => renderer.dispose())
  return { renderer, contexts, evaluations }
}

test('one article image inspector reuses a blank page while different inspectors remain isolated', async t => {
  const { renderer, contexts, evaluations } = rendererFixture(t)
  const first = await renderer.createImageInspector(), second = await renderer.createImageInspector()
  t.onTestFinished(async () => { await first.dispose(); await second.dispose() })
  expect(await first.inspect(png, 'image/png')).toEqual({ width: 2, height: 2 })
  expect(await first.inspect(png, 'image/png')).toEqual({ width: 2, height: 2 })
  expect(await second.inspect(png, 'image/png')).toEqual({ width: 2, height: 2 })
  expect(contexts).toHaveLength(2)
  expect(contexts.map(value => value.pageCount)).toEqual([1, 1])
  expect(evaluations.map(value => value.context)).toEqual([0, 0, 1])
  await first.dispose()
  expect(contexts[0].closed).toBe(true); expect(contexts[1].closed).toBe(false)
  await expect(first.inspect(png, 'image/png')).rejects.toMatchObject({ code: 'article-interrupted' })
  expect(await second.inspect(png, 'image/png')).toEqual({ width: 2, height: 2 })
  await renderer.dispose()
  expect(contexts.every(value => value.closed)).toBe(true)
  await expect(second.inspect(png, 'image/png')).rejects.toMatchObject({ code: 'article-interrupted' })
})

test('cancelling an inspector closes its context and settles an in-flight decode', async t => {
  const pending = Promise.withResolvers(), entered = Promise.withResolvers(), controller = new AbortController()
  const { renderer, contexts } = rendererFixture(t, { pending, entered })
  const inspector = await renderer.createImageInspector(controller.signal)
  t.onTestFinished(() => inspector.dispose())
  const decode = inspector.inspect(png, 'image/png'), cancelled = expect(decode).rejects.toMatchObject({ code: 'article-interrupted' })
  await entered.promise; controller.abort(); await cancelled
  await inspector.dispose()
  expect(contexts).toHaveLength(1); expect(contexts[0].closed).toBe(true)
  await expect(inspector.inspect(png, 'image/png')).rejects.toMatchObject({ code: 'article-interrupted' })
})

test('the existing one-shot inspectImage method still owns and closes a fresh context per invocation', async t => {
  const { renderer, contexts } = rendererFixture(t)
  expect(await renderer.inspectImage(png, 'image/png')).toEqual({ width: 2, height: 2 })
  expect(await renderer.inspectImage(png, 'image/png')).toEqual({ width: 2, height: 2 })
  expect(contexts).toHaveLength(2)
  expect(contexts.every(value => value.closed)).toBe(true)
})
