/** Keyless gateway admission tests use only loopback and injected upstream responses. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { request } from 'node:http'
import { startRelay } from '../src/host/relay/server.ts'
import type { RelayConfig, RelayDependencies } from '../src/host/relay/types.ts'
import { CodexVersion } from '../src/host/version.ts'

const config: RelayConfig = { host: '127.0.0.1', port: 0, gatewayKeys: [{ id: 'first', secret: 'test-gateway-key-1234567890' }], allowedOrigins: [], maxRequestBytes: 1024, maxResponseBytes: 1024 * 1024, requestTimeoutMs: 5000, imageWaitMs: 50, assetUrlTtlMs: 60000, maxConcurrentRequests: 4, maxSocketConnections: 4, maxSocketQueuedTurns: 2, maxSocketHistoryBytes: 1048576 }
const dependencies: RelayDependencies = {
  requestResponses: async () => new Response('data: {"type":"response.completed","response":{"id":"r","output":[]}}\n\n', { headers: { 'content-type': 'text/event-stream' } }),
  listModels: async () => [{ id: 'codex-model' }],
  images: { submit: async () => { throw new Error('unused') }, getResult: async () => { throw new Error('unused') } },
  readAsset: async () => { throw new Error('unused') },
}

test('gateway rejects missing key, hostile Origin and DNS-rebinding Host', async () => {
  const relay = await startRelay(config, dependencies)
  try {
    assert.equal((await fetch(`${relay.origin}/v1/models`)).status, 401)
    const headers = { Authorization: `Bearer ${config.gatewayKeys[0]?.secret}` }
    assert.equal((await fetch(`${relay.origin}/v1/models`, { headers: { ...headers, Origin: 'https://evil.test' } })).status, 403)
    const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${relay.origin}/v1/models`, { headers: { ...headers, Host: 'evil.test' } }, response => { response.resume(); resolve(response.statusCode) })
      req.on('error', reject); req.end()
    })
    assert.equal(badHostStatus, 403)
    const response = await fetch(`${relay.origin}/v1/models`, { headers })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { object: 'list', data: [{ id: 'codex-model', object: 'model', owned_by: 'codex-subscription' }] })
  } finally { await relay.close() }
})

test('gateway bounds request bodies before invoking upstream and closes idempotently', async () => {
  let calls = 0
  const relay = await startRelay(config, { ...dependencies, requestResponses: async () => { calls++; return new Response() } })
  const response = await fetch(`${relay.origin}/v1/responses`, { method: 'POST', headers: { Authorization: `Bearer ${config.gatewayKeys[0]?.secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'x', input: 'x'.repeat(2048) }) })
  assert.equal(response.status, 413)
  assert.equal(calls, 0)
  await relay.close()
  await relay.close()
})

test('only an authenticated gateway caller can raise version negotiation', async () => {
  const versions = new CodexVersion({ minimum: '0.159.0', discoverLocal: false, probeIntervalMs: 1000, maxCacheBytes: 1024 })
  const relay = await startRelay(config, { ...dependencies, observeClient: headers => { versions.observeClient(headers) } })
  const hints = { originator: 'codex_cli_rs', version: '0.170.0' }
  try {
    const rejected = await fetch(`${relay.origin}/v1/models`, { headers: hints }); await rejected.body?.cancel()
    assert.equal(rejected.status, 401); assert.equal(await versions.current(), '0.159.0')
    const accepted = await fetch(`${relay.origin}/v1/models`, { headers: { ...hints, Authorization: `Bearer ${config.gatewayKeys[0]?.secret}` } }); await accepted.body?.cancel()
    assert.equal(accepted.status, 200); assert.equal(await versions.current(), '0.170.0')
  } finally { await relay.close(); await versions.dispose() }
})
