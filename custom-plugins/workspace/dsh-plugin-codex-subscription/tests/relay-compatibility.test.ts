/** Local real HTTP/WebSocket clients exercise external compatibility without paid upstream calls. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { gzipSync, zstdCompressSync } from 'node:zlib'
import WebSocket from 'ws'
import { startRelay } from '../src/host/relay/server.ts'
import type { RelayConfig, RelayDependencies } from '../src/host/relay/types.ts'

const config: RelayConfig = { host: '127.0.0.1', port: 0, gatewayKeys: [{ id: 'one', secret: 'gateway-key-one-123456' }], allowedOrigins: [], maxRequestBytes: 1024 * 1024,
  maxResponseBytes: 1024 * 1024, requestTimeoutMs: 5000, imageWaitMs: 50, assetUrlTtlMs: 60000, maxConcurrentRequests: 8,
  maxSocketConnections: 4, maxSocketQueuedTurns: 2, maxSocketHistoryBytes: 1024 * 1024 }
const authorization = { Authorization: `Bearer ${config.gatewayKeys[0]!.secret}`, 'Content-Type': 'application/json' }
const unused = async (): Promise<never> => { throw new Error('unused') }
function dependencies(requestResponses: RelayDependencies['requestResponses']): RelayDependencies { return { requestResponses, listModels: async () => [], images: { submit: unused, getResult: unused }, readAsset: unused } }
const completed = (id: string) => ({ type: 'response.completed', response: { id, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'reply' }] }] } })
const upstream = (id: string) => new Response(`data: ${JSON.stringify(completed(id))}\n\n`, { headers: { 'content-type': 'text/event-stream' } })

test('gzip and zstd decode before JSON with compressed and expanded size limits', async () => {
  let calls = 0
  const relay = await startRelay({ ...config, maxRequestBytes: 512 }, dependencies(async () => { calls++; return upstream('r') }))
  try {
    for (const [encoding, compress] of [['gzip', gzipSync], ['zstd', zstdCompressSync]] as const) {
      const result = await fetch(`${relay.origin}/v1/responses`, { method: 'POST', headers: { ...authorization, 'content-encoding': encoding }, body: compress(Buffer.from(JSON.stringify({ model: 'x', input: [] }))) })
      assert.equal(result.status, 200); await result.body?.cancel()
      const oversized = await fetch(`${relay.origin}/v1/responses`, { method: 'POST', headers: { ...authorization, 'content-encoding': encoding }, body: compress(Buffer.from(JSON.stringify({ model: 'x', input: 'x'.repeat(2048) }))) })
      assert.equal(oversized.status, 413); await oversized.body?.cancel()
    }
    const unsupported = await fetch(`${relay.origin}/v1/responses`, { method: 'POST', headers: { ...authorization, 'content-encoding': 'br' }, body: '{}' })
    assert.equal(unsupported.status, 415); await unsupported.body?.cancel()
    const invalid = await fetch(`${relay.origin}/v1/responses`, { method: 'POST', headers: { ...authorization, 'content-encoding': 'gzip' }, body: 'invalid' })
    assert.equal(invalid.status, 400); await invalid.body?.cancel()
    assert.equal(calls, 2)
  } finally { await relay.close() }
})

async function open(origin: string, headers: Record<string, string> = authorization) {
  const ws = new WebSocket(origin.replace('http:', 'ws:') + '/v1/responses', { headers })
  const messages: Record<string, unknown>[] = [], waiters: Array<() => void> = []
  ws.on('message', bytes => { messages.push(JSON.parse(bytes.toString())); waiters.shift()?.() })
  ws.on('error', () => { /* Assertions inspect handshake/close outcomes. */ })
  try { await once(ws, 'open') } catch (error) { ws.terminate(); throw error }
  return { ws, async next() { if (messages.length === 0) await new Promise<void>(resolve => waiters.push(resolve)); return messages.shift()! }, async close() { if (ws.readyState === WebSocket.CLOSED) return; const ended = once(ws, 'close'); ws.terminate(); await ended } }
}

test('Responses WebSocket restores only its own completed turn and forwards authenticated metadata', async () => {
  const inputs: Record<string, unknown>[] = []
  const relay = await startRelay(config, dependencies(async (body, _signal, context) => { inputs.push(body); assert.equal(context?.keyId, 'one'); return upstream(`r${inputs.length}`) }))
  try {
    const client = await open(relay.origin)
    try {
    client.ws.send(JSON.stringify({ type: 'response.create', model: 'x', input: [{ role: 'user', content: 'first' }] }))
    assert.equal((await client.next()).type, 'response.completed')
    client.ws.send(JSON.stringify({ type: 'response.create', model: 'x', previous_response_id: 'r1', input: [{ role: 'user', content: 'second' }] }))
    assert.equal((await client.next()).type, 'response.completed')
    assert.equal(inputs[1]?.previous_response_id, undefined)
    assert.deepEqual(inputs[1]?.input, [{ role: 'user', content: 'first' }, ...completed('r1').response.output, { role: 'user', content: 'second' }])
    const other = await open(relay.origin)
    try {
      other.ws.send(JSON.stringify({ type: 'response.create', model: 'x', previous_response_id: 'r1', input: [] }))
      assert.equal(((await other.next()).error as { code: string }).code, 'previous_response_not_found')
      assert.equal(inputs.length, 2)
    } finally { await other.close() }
    } finally { await client.close() }
  } finally { await relay.close() }
})

test('WebSocket metadata preserves safe quota and model headers without forwarding cookies', async () => {
  const relay = await startRelay(config, dependencies(async () => {
    const response = upstream('metadata')
    response.headers.set('x-codex-primary-used-percent', '25')
    response.headers.set('x-models-etag', 'v2')
    response.headers.set('set-cookie', 'private=secret')
    return response
  }))
  try {
    const client = await open(relay.origin)
    try {
      client.ws.send(JSON.stringify({ type: 'response.create', model: 'x', input: [] }))
      const event = await client.next()
      assert.equal(event.type, 'codex.response.metadata')
      assert.deepEqual(event.headers, { 'x-codex-primary-used-percent': '25', 'x-models-etag': 'v2' })
      assert.equal((await client.next()).type, 'response.completed')
    } finally { await client.close() }
  } finally { await relay.close() }
})

test('WebSocket warmup retains input without dispatch and history eviction rejects continuation', async () => {
  let calls = 0
  const seen: Record<string, unknown>[] = []
  const relay = await startRelay({ ...config, maxSocketHistoryBytes: 180 }, dependencies(async body => { calls++; seen.push(body); return upstream('generated') }))
  try {
    const client = await open(relay.origin)
    try {
      client.ws.send(JSON.stringify({ type: 'response.create', generate: false, model: 'x', input: 'warm' }))
      assert.equal((await client.next()).type, 'response.created')
      const ready = await client.next(), id = (ready.response as { id: string }).id
      assert.equal(calls, 0)
      client.ws.send(JSON.stringify({ type: 'response.create', model: 'x', previous_response_id: id, input: [{ role: 'user', content: 'next' }] }))
      assert.equal((await client.next()).type, 'response.completed')
      assert.equal((seen[0]?.input as unknown[]).length, 2); assert.equal(calls, 1)
      client.ws.send(JSON.stringify({ type: 'response.create', model: 'x', previous_response_id: 'generated', input: [] }))
      assert.equal(((await client.next()).error as { code: string }).code, 'previous_response_not_found')
    } finally { await client.close() }
  } finally { await relay.close() }
})

test('WebSocket cancellation clears queued turns and shares the HTTP concurrency limit', async () => {
  const entered = Promise.withResolvers<void>(), aborted = Promise.withResolvers<void>()
  let calls = 0
  const relay = await startRelay({ ...config, maxConcurrentRequests: 1, maxSocketQueuedTurns: 0 }, dependencies(async (_body, signal) => {
    calls++; entered.resolve()
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"running"}}\n\n'))
      signal.addEventListener('abort', () => { aborted.resolve(); controller.close() }, { once: true })
    } }), { headers: { 'content-type': 'text/event-stream' } })
  }))
  try {
    const client = await open(relay.origin)
    try {
      client.ws.send(JSON.stringify({ type: 'response.create', model: 'x', input: [] })); await entered.promise
      assert.equal((await client.next()).type, 'response.created')
      client.ws.send(JSON.stringify({ type: 'response.create', model: 'x', input: [] }))
      assert.equal(((await client.next()).error as { code: string }).code, 'websocket_queue_full')
      const http = await fetch(`${relay.origin}/v1/models`, { headers: authorization })
      assert.equal(http.status, 429); await http.body?.cancel()
      client.ws.send(JSON.stringify({ type: 'response.cancel', response_id: 'running' }))
      await aborted.promise
      assert.equal(((await client.next()).error as { code: string }).code, 'response_cancelled')
      assert.equal(calls, 1)
    } finally { await client.close() }
  } finally { await relay.close() }
})

test('WebSocket incomplete EOF retains deltas and emits one explicit failure without replay', async () => {
  let calls = 0
  const relay = await startRelay(config, dependencies(async () => { calls++; return new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n') }))
  try {
    const client = await open(relay.origin)
    try {
      client.ws.send(JSON.stringify({ type: 'response.create', model: 'x', input: [] }))
      const partial = await client.next(), error = await client.next()
      assert.equal(partial.delta, 'partial')
      assert.equal((error.error as { code: string }).code, 'incomplete_response'); assert.equal(calls, 1)
      assert.deepEqual([partial, error], JSON.parse(await readFile(new URL('./fixtures/responses-ws-incomplete.expected.json', import.meta.url), 'utf8')))
    } finally { await client.close() }
  } finally { await relay.close() }
})

test('WebSocket queued turns run serially and a timed-out turn releases its upstream', async () => {
  let first: ReadableStreamDefaultController<Uint8Array> | undefined, calls = 0
  const aborted = Promise.withResolvers<void>()
  const relay = await startRelay({ ...config, requestTimeoutMs: 1000 }, dependencies(async (_body, signal) => {
    calls++
    if (calls === 1) return new Response(new ReadableStream<Uint8Array>({ start(controller) { first = controller; controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"first"}}\n\n')) } }))
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"second"}}\n\n'))
      signal.addEventListener('abort', () => { aborted.resolve(); controller.close() }, { once: true })
    } }))
  }))
  try {
    const client = await open(relay.origin)
    try {
      client.ws.send(JSON.stringify({ type: 'response.create', model: 'x', input: [] })); await client.next()
      client.ws.send(JSON.stringify({ type: 'response.create', model: 'x', input: [] }))
      assert.equal(calls, 1)
      first!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(completed('first'))}\n\n`)); first!.close()
      assert.equal((await client.next()).type, 'response.completed')
      assert.equal((await client.next()).type, 'response.created')
      const error = await client.next(); await aborted.promise
      assert.equal((error.error as { code: string }).code, 'request_timeout'); assert.equal(calls, 2)
    } finally { await client.close() }
  } finally { await relay.close() }
})

async function rejected(origin: string, headers: Record<string, string>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/v1/responses', { headers })
    ws.once('unexpected-response', (_request, response) => { const status = response.statusCode ?? 0; response.destroy(); ws.terminate(); resolve(status) })
    ws.once('open', () => { ws.terminate(); reject(new Error('The forbidden handshake was accepted')) })
    ws.on('error', () => { /* Rejected handshakes are observed through their HTTP status. */ })
  })
}

test('WebSocket admission enforces Bearer, Host, Origin and connection limits before dispatch', async () => {
  let calls = 0
  const relay = await startRelay({ ...config, maxSocketConnections: 1 }, dependencies(async () => { calls++; return upstream('r') }))
  try {
    assert.equal(await rejected(relay.origin, {}), 401)
    assert.equal(await rejected(relay.origin, { ...authorization, Host: 'evil.invalid' }), 403)
    assert.equal(await rejected(relay.origin, { ...authorization, Origin: 'https://evil.invalid' }), 403)
    const client = await open(relay.origin)
    try { assert.equal(await rejected(relay.origin, authorization), 429); assert.equal(calls, 0) } finally { await client.close() }
  } finally { await relay.close() }
})

test('every WebSocket turn reauthenticates after key revocation and shutdown aborts an active turn', async () => {
  const keys = [...config.gatewayKeys], aborted = Promise.withResolvers<void>()
  let calls = 0
  const relay = await startRelay({ ...config, gatewayKeys: keys }, dependencies(async (_body, signal) => {
    calls++
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"running"}}\n\n'))
      signal.addEventListener('abort', () => { aborted.resolve(); controller.close() }, { once: true })
    } }))
  }))
  try {
    const client = await open(relay.origin)
    try {
      client.ws.send(JSON.stringify({ type: 'response.create', model: 'x', input: [] })); await client.next()
      keys.length = 0
      client.ws.send(JSON.stringify({ type: 'response.create', model: 'x', input: [] }))
      assert.equal(((await client.next()).error as { code: string }).code, 'invalid_api_key'); assert.equal(calls, 1)
      // 服务端关闭完成不代表客户端已收到断开事件；先监听，再等待实际连接关闭。
      const disconnected = once(client.ws, 'close', { signal: AbortSignal.timeout(config.requestTimeoutMs) })
      await Promise.all([relay.close(), aborted.promise, disconnected])
      assert.equal(client.ws.readyState, WebSocket.CLOSED)
    } finally { await client.close() }
  } finally { await relay.close() }
})
