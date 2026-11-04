/** Deployment settings reject unsafe listeners before opening sockets. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config, resolveOptions } from '../src/host/config.ts'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/host/plugin.ts'

test('defaults the rc.1 image request count and rejects an oversized offload step before mounting', async () => {
  const config = Config({})
  assert.equal(config.maxRequestImages, 50)
  assert.equal(config.imageOffloadCountQuantum, undefined)
  const ctx = new Context()
  try {
    await assert.rejects(apply(ctx, Config({ maxRequestImages: 2, imageOffloadCountQuantum: 3 })), /must not exceed maxRequestImages/)
    assert.equal(ctx.get('codexSubscription'), undefined)
  } finally { await ctx.fiber.dispose() }
})

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
