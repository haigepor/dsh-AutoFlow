/** Real local WebSockets exercise the Codex bridge, fallback commit point and lifecycle. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type IncomingMessage } from 'node:http'
import { once } from 'node:events'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import { zstdCompressSync } from 'node:zlib'
import { WebSocketServer, type WebSocket } from 'ws'
import { CodexUpstream } from '../src/host/upstream.ts'
import { resolveOptions } from '../src/host/config.ts'
import { startRelay } from '../src/host/relay/server.ts'
import type { RelayConfig } from '../src/host/relay/types.ts'

const complete = { type: 'response.completed', response: { id: 'done', output: [], usage: { input_tokens: 1, output_tokens: 1 } } }
const requestBody = { model: 'fixture', input: 'hello', stream: true, store: false }
const headers = { authorization: 'Bearer fixture-secret', 'chatgpt-account-id': 'fixture-account', originator: 'codex_cli_rs', version: '0.159.0', 'content-type': 'application/json' }

async function fixture(options: { onSocket?(socket: WebSocket, request: IncomingMessage): void; handshakeStatus?: number; now?: () => number;
  settings?: Partial<ReturnType<typeof resolveOptions>['upstream']>; proxy?: string; stalled?: { entered: () => void } } = {}) {
  let httpCalls = 0, upgrades = 0
  const messages: Record<string, unknown>[] = []
  const httpBodies: Buffer[] = []
  const server = createServer(async (request, response) => {
    httpCalls++; const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    httpBodies.push(Buffer.concat(chunks)); response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`data: ${JSON.stringify(complete)}\n\n`)
  })
  const wss = new WebSocketServer({ noServer: true })
  const connections = new Set<Duplex>()
  server.on('connection', socket => { connections.add(socket); socket.once('close', () => connections.delete(socket)) })
  server.on('upgrade', (request, socket, head) => {
    upgrades++
    if (options.stalled !== undefined) { options.stalled.entered(); return }
    if (options.handshakeStatus !== undefined) { socket.end(`HTTP/1.1 ${options.handshakeStatus} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return }
    wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client, request))
  })
  wss.on('connection', (socket, request) => {
    socket.on('error', () => {})
    socket.on('message', data => { messages.push(JSON.parse(data.toString())); options.onSocket?.(socket, request) })
    if (options.onSocket === undefined) socket.on('message', () => socket.send(JSON.stringify(complete)))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const endpoint = `http://127.0.0.1:${address.port}/backend-api/codex/responses`
  const upstream = new CodexUpstream({ endpoint, fetch, settings: resolveOptions({ upstream: { connectTimeoutMs: 1000, closeTimeoutMs: 50, ...options.settings } }).upstream,
    ...(options.proxy === undefined ? {} : { resolveProxy: () => options.proxy }),
    ...(options.now === undefined ? {} : { now: options.now }) })
  const send = (body: object = requestBody, signal?: AbortSignal) => upstream.fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) })
  return { upstream, messages, httpBodies, endpoint, send, httpCalls: () => httpCalls, upgrades: () => upgrades,
    close: async () => { await upstream.dispose(); for (const client of wss.clients) client.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); for (const socket of connections) socket.destroy(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) } }
}

test('WebSocket uses Codex handshake and response.create, projecting metadata as headers and raw events as SSE', async () => {
  let seen = false
  const f = await fixture({ onSocket(socket, request) {
    assert.equal(request.headers.authorization, headers.authorization)
    assert.equal(request.headers['openai-beta'], 'responses_websockets=2026-02-06')
    assert.equal(request.headers['content-type'], undefined)
    assert.equal(request.headers['x-codex-turn-state'], undefined)
    seen = true
    socket.send(JSON.stringify({ type: 'codex.response.metadata', headers: { 'x-codex-turn-state': 'turn-fixture', 'x-models-etag': 'v2', 'openai-model': 'fixture', 'x-reasoning-included': 'true', 'retry-after-ms': '1500', 'set-cookie': 'private' } }))
    socket.send(JSON.stringify({ type: 'codex.rate_limits', plan_type: 'plus', credits: { has_credits: true, unlimited: false, balance: '1.25' },
      rate_limits: { primary: { used_percent: 12, window_minutes: 300, reset_at: 2000000000 } } }))
    socket.send(JSON.stringify(complete))
  } })
  try {
    const response = await f.upstream.fetch(f.endpoint, { method: 'POST', headers: { ...headers, 'x-codex-turn-state': 'original', 'x-openai-internal-codex-responses-lite': 'true' }, body: JSON.stringify(requestBody) })
    assert.equal(response.headers.get('x-codex-turn-state'), 'turn-fixture')
    for (const [key, value] of Object.entries({ 'x-models-etag': 'v2', 'openai-model': 'fixture', 'x-reasoning-included': 'true', 'retry-after-ms': '1500' })) assert.equal(response.headers.get(key), value)
    assert.equal(response.headers.get('x-codex-primary-used-percent'), '12')
    assert.equal(response.headers.get('x-codex-plan-type'), 'plus')
    assert.equal(response.headers.get('x-codex-credits-balance'), '1.25')
    assert.equal(response.headers.get('x-codex-credits-unlimited'), 'False')
    assert.equal(response.headers.get('set-cookie'), null)
    assert.match(await response.text(), /response.completed/)
    assert.equal(seen, true)
    assert.equal(f.messages[0]?.type, 'response.create')
    assert.deepEqual(f.messages[0]?.client_metadata, { 'x-codex-turn-state': 'original', ws_request_header_x_openai_internal_codex_responses_lite: 'true' })
    assert.equal(f.httpCalls(), 0)
    assert.equal(f.upstream.status().lastRequest?.transport, 'websocket')
  } finally { await f.close() }
})

test('a refused handshake falls back to HTTP and remembers the host until cooldown expires', async () => {
  let now = 0
  const f = await fixture({ handshakeStatus: 426, now: () => now })
  try {
    assert.match(await (await f.send()).text(), /response.completed/)
    await (await f.send()).text()
    assert.equal(f.upgrades(), 1); assert.equal(f.httpCalls(), 2)
    assert.equal(f.upstream.status().lastRequest?.reason, 'handshake_cooldown')
    now = 600001
    await (await f.send()).text()
    assert.equal(f.upgrades(), 2)
  } finally { await f.close() }
})

test('default WebSocket buffering drains a coalesced burst without replaying the request', async () => {
  const f = await fixture({ onSocket(socket) {
    socket.send(JSON.stringify({ type: 'response.created', response: { id: 'burst' } }))
    for (let i = 0; i < 256; i++) socket.send(JSON.stringify({ type: 'response.output_text.delta', delta: String(i) }))
    socket.send(JSON.stringify(complete))
  } })
  try {
    const text = await (await f.send()).text()
    assert.equal((text.match(/"type":"response.output_text.delta"/g) ?? []).length, 256)
    assert.match(text, /response.completed/)
    assert.equal(f.httpCalls(), 0)
  } finally { await f.close() }
})

test('pre-response socket close falls back, while close after response publication never repeats HTTP', async () => {
  const before = await fixture({ onSocket(socket) { socket.close(1012) } })
  try { await (await before.send()).text(); assert.equal(before.httpCalls(), 1) } finally { await before.close() }
  const after = await fixture({ onSocket(socket) { socket.send(JSON.stringify({ type: 'response.created', response: { id: 'started' } })); socket.close(1012) } })
  try {
    const response = await after.send()
    await assert.rejects(response.text(), { code: 'SOCKET_CLOSED' })
    assert.equal(after.httpCalls(), 0)
  } finally { await after.close() }
})

test('1009 remembers the rejected message size while smaller requests may still use WebSocket', async () => {
  const f = await fixture({ onSocket(socket) { socket.close(1009) } })
  try {
    await (await f.send({ ...requestBody, input: 'x'.repeat(500) })).text()
    await (await f.send({ ...requestBody, input: 'x'.repeat(600) })).text()
    assert.equal(f.upgrades(), 1)
    await (await f.send()).text()
    assert.equal(f.upgrades(), 2); assert.equal(f.httpCalls(), 3)
  } finally { await f.close() }
})

test('connection-limit frames fall back, but typed quota refusals retain status without HTTP replay', async () => {
  const limited = await fixture({ onSocket(socket) { socket.send(JSON.stringify({ type: 'error', error: { code: 'websocket_connection_limit_reached' } })) } })
  try { await (await limited.send()).text(); assert.equal(limited.httpCalls(), 1) } finally { await limited.close() }
  const refused = await fixture({ onSocket(socket) { socket.send(JSON.stringify({ type: 'error', status: 429, error: { code: 'rate_limit_exceeded', headers: { 'retry-after': '30' } } })) } })
  try {
    const response = await refused.send()
    assert.equal(response.status, 429)
    assert.equal(response.headers.get('content-type'), 'application/json')
    assert.equal(response.headers.get('retry-after'), '30')
    await response.body?.cancel(); assert.equal(refused.httpCalls(), 0)
  } finally { await refused.close() }
})

test('native zstd requests use WebSocket with plain JSON while fallback preserves the original HTTP body', async () => {
  const f = await fixture()
  try {
    const response = await f.upstream.fetch(f.endpoint, { method: 'POST', headers: { ...headers, 'content-encoding': 'zstd' }, body: zstdCompressSync(Buffer.from(JSON.stringify(requestBody))) })
    await response.text()
    assert.equal(f.messages[0]?.model, 'fixture')
    assert.equal(f.messages[0]?.stream, true)
  } finally { await f.close() }
  const fallback = await fixture({ handshakeStatus: 426 })
  try {
    const compressed = zstdCompressSync(Buffer.from(JSON.stringify(requestBody)))
    await (await fallback.upstream.fetch(fallback.endpoint, { method: 'POST', headers: { ...headers, 'content-encoding': 'zstd' }, body: compressed })).text()
    assert.deepEqual(fallback.httpBodies, [compressed])
  } finally { await fallback.close() }
})

test('authentication, quota and server handshake refusals do not disable the next WebSocket attempt', async () => {
  for (const handshakeStatus of [401, 429, 500, 503]) {
    const f = await fixture({ handshakeStatus })
    try {
      await (await f.send()).text(); await (await f.send()).text()
      assert.equal(f.upgrades(), 2); assert.equal(f.httpCalls(), 2)
      assert.equal(f.upstream.status().shunnedUntil, 0)
    } finally { await f.close() }
  }
})

test('malformed frames and local buffer limits fail explicitly without HTTP replay', async () => {
  for (const message of ['invalid JSON', JSON.stringify({ type: 'response.created\ndata: injected' })]) {
    const f = await fixture({ onSocket(socket) { socket.send(message) } })
    try { await assert.rejects(f.send(), { code: 'SOCKET_PROTOCOL' }); assert.equal(f.httpCalls(), 0) } finally { await f.close() }
  }
  for (const settings of [{ maxMessageBytes: 128 }, { maxBufferedBytes: 128 }]) {
    const f = await fixture({ settings, onSocket(socket) {
      socket.send(JSON.stringify({ type: 'response.completed', data: 'x'.repeat(1000) }))
    } })
    try {
      await assert.rejects(async () => (await f.send()).text(), { code: 'SOCKET_BUFFER_LIMIT' })
      assert.equal(f.httpCalls(), 0)
    } finally { await f.close() }
  }
})

test('a stalled WebSocket consumer retains the frame cap and cancels without replay', async () => {
  const closed = Promise.withResolvers<void>()
  const f = await fixture({ settings: { maxBufferedFrames: 1 }, onSocket(socket) {
    socket.once('close', () => closed.resolve())
    socket.send(JSON.stringify({ type: 'response.created', response: { id: 'stalled' } }))
    for (let i = 0; i < 64; i++) socket.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'x' }))
  } })
  try {
    const response = await f.send()
    await closed.promise
    await assert.rejects(response.text(), { code: 'SOCKET_BUFFER_LIMIT' })
    assert.equal(f.httpCalls(), 0)
  } finally { await f.close() }
})

test('SSE mode, nonstream input and request-size limits keep their original HTTP semantics', async () => {
  const f = await fixture({ settings: { mode: 'sse' } })
  try { await (await f.send()).text(); assert.equal(f.upgrades(), 0); assert.equal(f.httpCalls(), 1) } finally { await f.close() }
  const other = await fixture({ settings: { maxRequestBytes: 256 } })
  try {
    await (await other.send({ ...requestBody, stream: false })).text()
    await (await other.send({ ...requestBody, input: 'x'.repeat(512) })).text()
    assert.equal(other.upgrades(), 0); assert.equal(other.httpCalls(), 2)
  } finally { await other.close() }
})

test('WebSocket CONNECT uses the selected proxy and releases the owned tunnel on disposal', async () => {
  let tunnels = 0
  const sockets = new Set<Duplex>()
  const proxy = createServer()
  proxy.on('connect', (request, downstream, head) => {
    tunnels++
    const target = new URL(`http://${request.url}`)
    const upstream = connect({ host: target.hostname, port: Number(target.port) })
    sockets.add(downstream); sockets.add(upstream)
    downstream.on('error', () => upstream.destroy()); upstream.on('error', () => downstream.destroy())
    downstream.on('close', () => { sockets.delete(downstream); upstream.destroy() })
    upstream.on('close', () => { sockets.delete(upstream); downstream.destroy() })
    upstream.once('connect', () => { downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n'); upstream.write(head); downstream.pipe(upstream).pipe(downstream) })
  })
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening')
  const address = proxy.address(); assert.ok(address && typeof address !== 'string')
  const f = await fixture({ proxy: `http://127.0.0.1:${address.port}` })
  try {
    await (await f.send()).text()
    assert.equal(tunnels, 1); assert.equal(f.httpCalls(), 0)
    await f.upstream.dispose(); assert.equal(f.upstream.status().activeSockets, 0)
  } finally {
    await f.close(); for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()))
  }
})

test('authenticated local relay consumes WebSocket events as Responses and final JSON with quota headers', async () => {
  const f = await fixture({ onSocket(socket) {
    socket.send(JSON.stringify({ type: 'codex.rate_limits', rate_limits: { primary: { used_percent: 44 } } }))
    socket.send(JSON.stringify(complete))
  } })
  const config: RelayConfig = { ...resolveOptions({}).relay, port: 0, gatewayKeys: [{ id: 'one', secret: 'gateway-fixture-123456789' }], imageWaitMs: 1000 }
  const relay = await startRelay(config, { requestResponses: (body, signal) => f.send({ ...body, stream: true }, signal), listModels: async () => [],
    images: { submit: async () => { throw new Error('unused') }, getResult: async () => { throw new Error('unused') } }, readAsset: async () => { throw new Error('unused') } })
  try {
    for (const stream of [true, false]) {
      const result = await fetch(`${relay.origin}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer gateway-fixture-123456789', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fixture', input: 'hello', stream }) })
      assert.equal(result.status, 200); assert.equal(result.headers.get('x-codex-primary-used-percent'), '44')
      if (stream) assert.match(await result.text(), /response.completed/)
      else assert.deepEqual(await result.json(), complete.response)
    }
    assert.equal(f.upgrades(), 2); assert.equal(f.httpCalls(), 0)
  } finally { await relay.close(); await f.close() }
})

test('cancellation before the first frame closes the socket without fallback and disposal is idempotent', async () => {
  const received = Promise.withResolvers<void>()
  const f = await fixture({ onSocket() { received.resolve() } })
  try {
    const controller = new AbortController()
    const pending = f.send(requestBody, controller.signal)
    const rejected = assert.rejects(pending, /fixture cancel/)
    await received.promise; controller.abort(new Error('fixture cancel'))
    await rejected
    const first = f.upstream.dispose(), second = f.upstream.dispose()
    assert.equal(first, second); await first
    assert.equal(f.upstream.status().activeSockets, 0)
    assert.equal(f.httpCalls(), 0)
  } finally { await f.close() }
})

test('a stalled handshake times out into HTTP, while caller cancellation during the handshake never falls back', async () => {
  const timed = await fixture({ stalled: { entered() {} }, settings: { connectTimeoutMs: 100 } })
  try { await (await timed.send()).text(); assert.equal(timed.httpCalls(), 1) } finally { await timed.close() }
  const entered = Promise.withResolvers<void>(), controller = new AbortController()
  const cancelled = await fixture({ stalled: { entered: entered.resolve } })
  try {
    const pending = assert.rejects(cancelled.send(requestBody, controller.signal), /handshake cancelled/)
    await entered.promise; controller.abort(new Error('handshake cancelled')); await pending
    assert.equal(cancelled.httpCalls(), 0)
  } finally { await cancelled.close() }
})

test('cancelling a published body and unloading a pending request both close the actual peer without replay', async () => {
  const peer = Promise.withResolvers<void>()
  const f = await fixture({ onSocket(socket) { socket.once('close', () => peer.resolve()); socket.send(JSON.stringify({ type: 'response.created', response: { id: 'started' } })) } })
  try {
    const response = await f.send(); await response.body?.cancel(); await peer.promise
    assert.equal(f.upstream.status().activeSockets, 0); assert.equal(f.httpCalls(), 0)
  } finally { await f.close() }
  const entered = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>()
  const pending = await fixture({ onSocket(socket) { socket.once('close', () => closed.resolve()); entered.resolve() } })
  try {
    const rejected = assert.rejects(pending.send(), /disposed/)
    await entered.promise; await pending.upstream.dispose(); await rejected; await closed.promise
    assert.equal(pending.httpCalls(), 0)
  } finally { await pending.close() }
})
