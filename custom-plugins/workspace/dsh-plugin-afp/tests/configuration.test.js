import test from 'node:test'
import assert from 'node:assert/strict'
import { configurationAction } from '../src/host/afp-configuration.js'
import { resolveConfig } from '../config-schema.js'
import { transport, Connection } from '../src/host/afp-credentials.js'
import { digest } from '../src/host/afp-state-store.js'

test('preview retention settings are configurable, defaulted for existing deployments and bounded', () => {
  const config = resolveConfig({})
  assert.equal(config.previewCacheMaxEntries, 300)
  assert.equal(config.previewCacheMaxBytes, 67108864)
  assert.equal(config.previewCacheTtlMs, 600000)
  assert.equal(resolveConfig({ previewCacheMaxEntries: 0 }).previewCacheMaxEntries, 0)
  for (const input of [{ previewCacheMaxEntries: -1 }, { previewCacheMaxEntries: 5001 }, { previewCacheMaxBytes: 0 },
    { previewCacheMaxBytes: 268435457 }, { previewCacheTtlMs: 999 }, { previewCacheTtlMs: 3600001 }]) assert.throws(() => resolveConfig(input), /previewCache/)
})

test('deployment editor validates fields, refuses stale saves and retains unrelated settings', async () => {
  const entry = { options: { id: 'afp' }, fiber: { config: resolveConfig({ maxBatches: 7 }) } }
  let writes = 0
  const ctx = { configEditor: { entries: () => [entry], edit: async (_entry, change) => { entry.fiber.config = change(entry.fiber.config); writes++ } } }
  const service = { connection: { configurationInfo: async () => ({ credentials: {}, token: { configured: false } }) } }
  const first = JSON.parse(await configurationAction(ctx, { operation: 'read' }, service))
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

test('explicit credential reveal accepts only AFP secret fields and the current deployment revision', async () => {
  const config = resolveConfig({})
  const entry = { options: { id: 'afp' }, fiber: { config } }
  const refs = { AFP_PASSWORD: 'fixture-password', VISION_API_KEY: 'fixture-vision-key', OTHER_SECRET: 'unrelated' }
  const connection = new Connection({
    describe: async ref => ({ configured: Boolean(refs[ref]), writable: true }),
    resolve: async ref => refs[ref] ? { value: refs[ref] } : undefined,
    readRecord: async () => undefined,
  }, config)
  const ctx = { configEditor: { entries: () => [entry] } }, service = { connection }
  const revision = digest(JSON.stringify(config))
  for (const [key, value] of [['passwordRef', refs.AFP_PASSWORD], ['visionKeyRef', refs.VISION_API_KEY]]) {
    assert.deepEqual(JSON.parse(await configurationAction(ctx, { operation: 'reveal-credential', key, revision }, service)), { value })
  }
  for (const input of [
    { operation: 'reveal-credential', key: 'OTHER_SECRET', revision },
    { operation: 'reveal-credential', key: 'usernameRef', revision },
    { operation: 'reveal-credential', key: 'passwordRef', revision: 'stale' },
    { operation: 'reveal-credential', key: 'passwordRef', revision, ref: 'OTHER_SECRET' },
  ]) await assert.rejects(configurationAction(ctx, input, service))
  const metadata = await connection.configurationInfo()
  assert.equal(JSON.stringify(metadata).includes(refs.AFP_PASSWORD), false)
  assert.equal(JSON.stringify(metadata).includes(refs.VISION_API_KEY), false)
})

test('configuration metadata displays the username without exposing secrets or stale account grants', async () => {
  const config = resolveConfig({})
  const refs = { AFP_USERNAME: 'private-account', AFP_PASSWORD: 'private-password' }
  const expiry = Math.floor(Date.now() / 1000) + 3600
  const token = 'header.' + Buffer.from(JSON.stringify({ exp: expiry })).toString('base64url') + '.private-signature'
  const fingerprint = digest(JSON.stringify(['', refs.AFP_USERNAME, refs.AFP_PASSWORD, config.loginEndpoint]))
  const credentials = {
    describe: async key => ({ configured: Boolean(refs[key]), writable: true }),
    resolve: async key => refs[key] ? { value: refs[key] } : undefined,
    readRecord: async () => ({ kind: 'grant', payload: { fingerprint, token, verifiedAt: 1234 } }),
  }
  const connection = new Connection(credentials, config)
  const details = await connection.configurationInfo()
  assert.equal(details.username, refs.AFP_USERNAME)
  assert.equal(details.token.configured, true)
  assert.equal(details.token.expiresAt, expiry * 1000)
  assert.equal(details.token.verifiedAt, 1234)
  assert.equal(details.credentials.accessTokenRef.configured, true, 'A verified cached token is configured for display')
  assert.equal((await connection.configurationInfo('accessTokenRef')).value, token)
  assert.equal(details.credentials.usernameRef.configured, true)
  for (const secret of [refs.AFP_PASSWORD, token]) assert.equal(JSON.stringify(details).includes(secret), false)
  refs.AFP_PASSWORD = 'replacement-password'
  assert.equal((await connection.configurationInfo()).token.configured, false)
})
