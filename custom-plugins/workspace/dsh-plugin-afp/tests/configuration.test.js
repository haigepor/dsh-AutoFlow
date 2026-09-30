import test from 'node:test'
import assert from 'node:assert/strict'
import { configurationAction } from '../src/host/afp-configuration.js'
import { resolveConfig } from '../config-schema.js'
import { transport } from '../src/host/afp-credentials.js'

test('deployment editor validates fields, refuses stale saves and retains unrelated settings', async () => {
  const entry = { options: { id: 'afp' }, fiber: { config: resolveConfig({ maxBatches: 7 }) } }
  let writes = 0
  const ctx = { configEditor: { entries: () => [entry], edit: async (_entry, change) => { entry.fiber.config = change(entry.fiber.config); writes++ } } }
  const first = JSON.parse(await configurationAction(ctx, { operation: 'read' }))
  assert.equal(first.config.maxBatches, 7)
  await assert.rejects(configurationAction(ctx, { operation: 'save', revision: first.revision, config: JSON.stringify({ ...first.config, concurrency: 0 }) }), /concurrency/)
  assert.equal(writes, 0)
  await configurationAction(ctx, { operation: 'save', revision: first.revision, config: JSON.stringify({ ...first.config, visionModel: 'mock-vision' }) })
  assert.equal(entry.fiber.config.visionModel, 'mock-vision'); assert.equal(entry.fiber.config.maxBatches, 7)
  await assert.rejects(configurationAction(ctx, { operation: 'save', revision: first.revision, config: JSON.stringify(first.config) }), /changed/)
  await assert.rejects(configurationAction(ctx, { operation: 'save', revision: first.revision, config: JSON.stringify({ accessToken: 'secret' }) }), /Unknown/)
  assert.equal(writes, 1)
})

test('token acquisition reuses the Host credential flow without returning a secret', async () => {
  const entry = { options: { id: 'afp' }, fiber: { config: resolveConfig({}) } }
  const signal = new AbortController().signal
  let receivedSignal
  const service = { acquireToken: async value => { receivedSignal = value; return { acquired: true } } }
  const ctx = { configEditor: { entries: () => [entry] } }

  const result = JSON.parse(await configurationAction(ctx, { operation: 'acquire-token' }, service, signal))

  assert.deepEqual(result, { acquired: true })
  assert.equal(receivedSignal, signal)
  await assert.rejects(configurationAction(ctx, { operation: 'acquire-token', token: 'never-send-secrets' }, service, signal), /Invalid/)
})

test('HTTP transport fuses abort signals and refuses credential forwarding redirects', async () => {
  const controller = new AbortController()
  let closed = false
  const request = transport(controller.signal, async (_url, options) => {
    assert.equal(options.redirect, 'manual'); assert.ok(options.signal)
    return { status: 302, body: { cancel: async () => { closed = true } } }
  })
  await assert.rejects(request('https://example.test', { headers: { Authorization: 'test' } }), /redirect/)
  assert.equal(closed, true)
  controller.abort()
  await assert.rejects(request('https://example.test'), { name: 'AbortError' })
})
