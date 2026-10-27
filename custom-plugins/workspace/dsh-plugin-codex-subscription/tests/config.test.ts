/** Deployment settings reject unsafe listeners before opening sockets. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveOptions } from '../src/host/config.ts'

test('defaults keep relay private and opt-in with one image deadline', () => {
  const options = resolveOptions({})
  assert.equal(options.relay.enabled, false)
  assert.equal(options.relay.port, 3426)
  assert.equal(options.images.timeoutMs, 300_000)
  assert.equal(options.upstream.mode, 'auto')
  assert.equal(options.upstream.cooldownMs, 600000)
  assert.throws(() => resolveOptions({ relay: { port: 70000 } }))
  assert.throws(() => resolveOptions({ relay: { host: '0.0.0.0' } }))
  assert.throws(() => resolveOptions({ images: { timeoutMs: 3_600_001 } }))
  assert.throws(() => resolveOptions({ upstream: { mode: 'unbounded' } }))
  assert.throws(() => resolveOptions({ upstream: { maxBufferedBytes: 256 * 1024 * 1024 + 1 } }))
  assert.throws(() => resolveOptions({ models: { fallbackMaxTokens: 0 } }))
  assert.throws(() => resolveOptions({ version: { maxCacheBytes: 32 * 1024 * 1024 + 1 } }))
})
