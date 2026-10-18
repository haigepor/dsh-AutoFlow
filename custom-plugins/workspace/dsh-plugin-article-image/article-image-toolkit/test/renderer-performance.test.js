/** Renderer-scoped connections and declared deferred resources preserve bounded transport and cleanup. */
import { test, expect } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createPublicRequest } from '../src/capture-media.js'
import { CaptureRenderer } from '../src/capture-renderer.js'
import { resolveCaptureConfig } from '../src/capture.js'

const config = resolveCaptureConfig({ minArticleChars: 1, renderWaitMs: 0, scrollWaitMs: 0, maxScrollSteps: 1, requestTimeoutMs: 5000 })
async function fixture(t, handler) {
  const sockets = new Map(), closures = []
  let sequence = 0
  const server = createServer((request, response) => {
    if (handler?.(request, response)) return
    response.end(JSON.stringify({ socket: sockets.get(request.socket) }))
  })
  server.on('connection', socket => { sockets.set(socket, ++sequence); closures.push(new Promise(resolve => socket.once('close', resolve))) })
  t.onTestFinished(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await Promise.all(closures) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://article.example.test:${server.address().port}`, policies = []
  const networkPolicy = async url => { policies.push(url.href); return [{ address: '127.0.0.1', family: 4 }] }
  return { origin, networkPolicy, policies, sockets, closures }
}
const socketOf = response => JSON.parse(response.bytes.toString('utf8')).socket

test('renderer session permits configured concurrent exchanges to one origin instead of serializing on image socket limits', async t => {
  const entered = Promise.withResolvers(), held = [], operations = []
  const owned = await fixture(t, (request, response) => { held.push(response); if (held.length === 2) entered.resolve(); return true })
  const request = createPublicRequest(config, { networkPolicy: owned.networkPolicy }), session = request.createSession({ poolSize: 2, connectionsPerOrigin: 2 })
  const finish = () => { for (const response of held) response.end('complete') }
  t.onTestFinished(async () => { finish(); await session.dispose(); await Promise.allSettled(operations) })
  operations.push(session(`${owned.origin}/one`), session(`${owned.origin}/two`))
  try {
    await Promise.race([entered.promise, Promise.allSettled(operations).then(() => { throw new Error('Both exchanges settled without overlapping at the server') })])
    expect(held).toHaveLength(2)
    finish(); await Promise.all(operations)
    expect(owned.policies).toHaveLength(2)
  } finally { finish(); await session.dispose(); await Promise.allSettled(operations) }
})

test('a renderer pool size override of zero retains one-shot connections while image defaults remain unchanged', async t => {
  const owned = await fixture(t), request = createPublicRequest(config, { networkPolicy: owned.networkPolicy })
  const disabled = request.createSession({ poolSize: 0, connectionsPerOrigin: 4 }), images = request.createSession()
  t.onTestFinished(async () => { await disabled.dispose(); await images.dispose() })
  expect(socketOf(await disabled(`${owned.origin}/one`))).not.toBe(socketOf(await disabled(`${owned.origin}/two`)))
  expect(socketOf(await images(`${owned.origin}/image-one`))).toBe(socketOf(await images(`${owned.origin}/image-two`)))
})

test('concurrent same-origin acquisitions during idle eviction cannot overwrite the new pool or orphan a socket', async t => {
  const owned = await fixture(t), request = createPublicRequest({ ...config, imageConnectionPoolSize: 1 }, { networkPolicy: owned.networkPolicy })
  const session = request.createSession({ poolSize: 1, connectionsPerOrigin: 1 })
  t.onTestFinished(() => session.dispose())
  await session(`${owned.origin}/warm-idle`)
  const target = owned.origin.replace('article.', 'assets.')
  const responses = await Promise.all([session(`${target}/first`), session(`${target}/second`)])
  expect(socketOf(responses[0])).toBe(socketOf(responses[1]))
  await session.dispose(); await Promise.all(owned.closures)
  expect(owned.policies).toHaveLength(3)
})

test('renderer session disposal aborts active and agent-queued requests before resolving', async t => {
  const entered = Promise.withResolvers()
  const owned = await fixture(t, (request, response) => { response.write('pending'); entered.resolve(); return true })
  const session = createPublicRequest(config, { networkPolicy: owned.networkPolicy }).createSession({ poolSize: 1, connectionsPerOrigin: 1 })
  t.onTestFinished(() => session.dispose())
  const one = session(`${owned.origin}/active`), two = session(`${owned.origin}/queued`)
  const outcomes = Promise.allSettled([one, two])
  await entered.promise; await session.dispose()
  expect((await outcomes).map(value => value.reason?.code)).toEqual(['article-interrupted', 'article-interrupted'])
  await Promise.all(owned.closures)
  await expect(session(`${owned.origin}/late`)).rejects.toMatchObject({ code: 'article-interrupted' })
})

function rendererFixture(t, { deferredTypes, match = true, failNavigation = false, withSession = true, requestOverride, targetOverride, pathPrefixes, documentUrl } = {}) {
  const target = targetOverride ?? 'https://articles.example.test/report', calls = [], sessions = [], routes = [], records = [], selectors = []
  const html = '<title>Published report</title><article><p>Published body.</p><img src="/original.png"><video controls></video></article>'
  const settings = { ...config, rendererConnectionPoolSize: 8, rendererConnectionsPerOrigin: 4, adapters: [{ id: 'resource-fixture-v1', hosts: [match ? new URL(target).hostname : 'unmatched.example.test'], articleSelector: 'article', ...(pathPrefixes ? { pathPrefixes } : {}), ...(deferredTypes ? { browserResources: { deferTypes: deferredTypes } } : {}) }] }
  const transport = async (url, options, scoped) => {
    calls.push({ url, options, scoped })
    if (failNavigation) throw Object.assign(new Error('fixture-network-failure'), { code: 'article-network' })
    return { url: url === target ? documentUrl ?? url : url, statusCode: 200, mime: url === target ? 'text/html' : 'application/octet-stream', headers: { 'content-type': url === target ? 'text/html' : 'application/octet-stream' }, bytes: Buffer.from(url === target ? html : 'resource') }
  }
  const request = (url, options) => transport(url, options, false)
  if (withSession) request.createSession = options => {
    const value = { options, disposed: false }, scoped = (url, input) => transport(url, input, true)
    scoped.dispose = async () => { value.disposed = true }
    sessions.push(value); return scoped
  }
  const frame = {}, contexts = []
  const browser = { async newContext() {
    let handler
    const context = { closed: false, addCookies: async () => {}, routeWebSocket: async () => {}, route: async (_pattern, callback) => { handler = callback }, close: async () => { context.closed = true }, async newPage() {
      return { on() {}, mainFrame: () => frame, async goto() {
        for (const type of ['document', 'image', 'font', 'media', 'script', 'stylesheet', 'xhr', 'fetch']) {
          const value = { type, aborted: false, fulfilled: false }
          const url = type === 'document' ? target : `https://articles.example.test/${type}`
          const pageRequest = { resourceType: () => type, isNavigationRequest: () => type === 'document', frame: () => frame, method: () => 'GET', url: () => url, allHeaders: async () => ({}), headers: () => ({}), postData: () => null }
          await handler({ request: () => pageRequest, abort: async () => { value.aborted = true }, fulfill: async () => { value.fulfilled = true } })
          routes.push(value)
          if (type === 'document' && value.aborted) throw new Error('fixture-navigation-aborted')
        }
      }, async evaluate(callback, input) {
        selectors.push(input)
        if (callback.name === 'scrollArticle') return { atEnd: true, height: 100 }
        if (typeof input === 'number') return true
        if (input === undefined) return html
        return 15
      } }
    } }
    contexts.push(context); return context
  }, close: async () => {} }
  const renderer = new CaptureRenderer(settings, { request: requestOverride ?? request, loadChromium: async () => ({ launch: async () => browser }) })
  t.onTestFinished(() => renderer.dispose())
  return { renderer, calls, sessions, routes, records, contexts, target, html, selectors }
}

test('every render owns a bounded resource session and releases it on completion', async t => {
  const value = rendererFixture(t)
  await value.renderer.render(value.target); await value.renderer.render(value.target)
  expect(value.sessions).toHaveLength(2)
  expect(value.sessions.map(session => session.options)).toEqual([{ poolSize: 8, connectionsPerOrigin: 4 }, { poolSize: 8, connectionsPerOrigin: 4 }])
  expect(value.sessions.every(session => session.disposed)).toBe(true)
  expect(value.calls.every(call => call.scoped)).toBe(true)
  expect(value.contexts.every(context => context.closed)).toBe(true)
})

test('only explicitly deferred image font and media routes are aborted without deleting article DOM or failing quality', async t => {
  const value = rendererFixture(t, { deferredTypes: ['image', 'font', 'media'] }), events = []
  const result = await value.renderer.render(value.target, { onProgress: event => events.push(event) })
  expect(value.routes.filter(route => route.aborted).map(route => route.type)).toEqual(['image', 'font', 'media'])
  expect(value.routes.filter(route => route.fulfilled).map(route => route.type)).toEqual(['document', 'script', 'stylesheet', 'xhr', 'fetch'])
  expect(value.calls).toHaveLength(5)
  expect(result.html).toBe(value.html)
  expect(result.diagnostics).not.toContain('resource-request-failed')
  expect(events.filter(event => event.event === 'resource-deferred').map(event => event.details.resourceType)).toEqual(['image', 'font', 'media'])
})

test('recording without markup and unmatched sites preserve all resources despite another adapters deferral declaration', async t => {
  const recording = rendererFixture(t, { deferredTypes: ['image', 'font', 'media'] })
  await recording.renderer.render(recording.target, { markup: false, onExchange: entry => recording.records.push(entry) })
  expect(recording.routes.every(route => route.fulfilled)).toBe(true)
  expect(recording.calls).toHaveLength(8); expect(recording.records.filter(entry => entry.sent)).toHaveLength(8)
  const unmatched = rendererFixture(t, { deferredTypes: ['image', 'font', 'media'], match: false })
  await unmatched.renderer.render(unmatched.target)
  expect(unmatched.routes.every(route => route.fulfilled)).toBe(true)
  expect(unmatched.calls).toHaveLength(8)
})

test('a different template on the same host retains every browser resource', async t => {
  const value = rendererFixture(t, { deferredTypes: ['image', 'font', 'media'], pathPrefixes: ['/aqui/'] })
  await value.renderer.render(value.target)
  expect(value.routes.every(route => route.fulfilled)).toBe(true)
  expect(value.calls).toHaveLength(8)
  expect(value.selectors).toContain('article,main,[role="main"],[data-ai-content-root]')
})

test('a controlled redirect into a verified template applies its browser policy before subresources', async t => {
  const value = rendererFixture(t, { targetOverride: 'https://articles.example.test/brasil/old', documentUrl: 'https://articles.example.test/aqui/current', pathPrefixes: ['/aqui/'], deferredTypes: ['image', 'font', 'media'] })
  const result = await value.renderer.render(value.target)
  expect(result.url).toBe('https://articles.example.test/aqui/current')
  expect(value.routes.filter(route => route.aborted).map(route => route.type)).toEqual(['image', 'font', 'media'])
  expect(value.calls).toHaveLength(5)
  expect(value.selectors).toContain('article')
})

test('a controlled redirect to another template stops applying the initial browser resource policy', async t => {
  const value = rendererFixture(t, { targetOverride: 'https://articles.example.test/aqui/old', documentUrl: 'https://articles.example.test/brasil/current', pathPrefixes: ['/aqui/'], deferredTypes: ['image', 'font', 'media'] })
  const result = await value.renderer.render(value.target)
  expect(result.url).toBe('https://articles.example.test/brasil/current')
  expect(value.routes.every(route => route.fulfilled)).toBe(true)
  expect(value.calls).toHaveLength(8)
  expect(value.selectors).toContain('article,main,[role="main"],[data-ai-content-root]')
})

test('a failed navigation still disposes its renderer resource session and preserves the transport error', async t => {
  const value = rendererFixture(t, { failNavigation: true })
  await expect(value.renderer.render(value.target)).rejects.toMatchObject({ code: 'article-network' })
  expect(value.sessions).toHaveLength(1)
  expect(value.sessions[0].disposed).toBe(true)
  expect(value.contexts[0].closed).toBe(true)
})

test('disposing a renderer aborts its real pinned in-flight transport and waits for its socket to close', async t => {
  const entered = Promise.withResolvers()
  const owned = await fixture(t, (request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.write('<article>Pending'); entered.resolve(); return true })
  const request = createPublicRequest(config, { networkPolicy: owned.networkPolicy })
  const value = rendererFixture(t, { requestOverride: request, targetOverride: `${owned.origin}/report` })
  const operation = value.renderer.render(value.target), stopped = expect(operation).rejects.toMatchObject({ code: 'article-interrupted' })
  await entered.promise
  await value.renderer.dispose(); await stopped
  await Promise.all(owned.closures)
  expect(value.contexts[0].closed).toBe(true)
  expect(value.renderer.renderSessions.size).toBe(0)
})
