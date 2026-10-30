/** Management lifecycle tests use real account/image services and injected durable/listener I/O. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { credentialKey, type CredentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { CodexSubscriptionService, safeCode, type SubscriptionDependencies, type SubscriptionHost } from '../src/host/service.ts'
import { resolveOptions, type Config, type SubscriptionOptions } from '../src/host/config.ts'
import type { ImageTaskRepository } from '../src/host/images/types.ts'
import type { RelayConfig, RelayDependencies } from '../src/host/relay/types.ts'
import { ACCOUNTS_KEY } from '../src/host/accounts/index.ts'
import { createHash } from 'node:crypto'
import { accountViewSchema, accountUsageSchema } from '../src/shared/accounts.ts'
import { modelCatalogSchema } from '../src/shared/model-catalog.ts'
import { imageSessionViewSchema } from '../src/shared/image-view.ts'
import { parseImageTaskId } from '../src/host/images/ids.ts'
import type { ImageTaskRecord } from '../src/host/images/types.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

const keySchema = z.object({ id: z.string(), secret: z.string(), relayError: z.string().optional() })
const gatewayKey = credentialKey('codex-subscription', 'gateway')
const signal = (): AbortSignal => new AbortController().signal

async function fixture(options: { enabled?: boolean; noKey?: boolean; failNext?: boolean; closeGate?: Promise<void>; repositoryGate?: Promise<void>; network?: typeof fetch; afterSettingsWrite?: () => Promise<void>; repository?: ImageTaskRepository } = {}) {
  let settings: SubscriptionOptions = resolveOptions({ relay: { enabled: options.enabled ?? false }, version: { discoverLocal: false }, upstream: { mode: 'sse' } })
  const records = new Map<CredentialKey, CredentialRecord>()
  if (options.enabled && !options.noKey) records.set(gatewayKey, { kind: 'grant', payload: { version: 1, id: 'seed', secret: 'initial-gateway-secret-1234567890123456', createdAt: 1 } })
  let credentialTail: Promise<unknown> = Promise.resolve()
  const started: RelayConfig[] = []
  const relayOperations: RelayDependencies[] = []
  const closed: string[] = []
  let repositoryClosed = 0
  let settingsWrites = 0
  let settingsRevision = 0
  const repository: ImageTaskRepository = options.repository ?? { get: async () => undefined, list: async () => [], put: async () => {}, delete: async () => {}, close: async () => { repositoryClosed++; await options.closeGate } }
  const host: SubscriptionHost = {
    profileContext: { dir: process.cwd() },
    credentials: {
      readRecord: async key => structuredClone(records.get(key)),
      modifyRecord: (key, change) => {
        const operation = credentialTail.then(async () => { const next = await change(structuredClone(records.get(key))); if (next !== undefined) records.set(key, structuredClone(next)); return structuredClone(records.get(key)) })
        credentialTail = operation.catch(() => {})
        return operation
      },
      deleteRecord: async key => { records.delete(key) },
    },
    authorization: { registerFlow: () => () => {}, begin: async () => { throw new Error('No real browser is used by this fixture') }, cancel: () => {} },
    settings: { describe: () => [{ ns: brandString<SettingsNamespace>('codex-subscription'), revision: settingsRevision, autoGenerate: false, schema: {}, value: { options: settings }, applies: 'live' }], update: async (_ns, patch, revision) => {
      if (revision !== undefined && revision !== settingsRevision) throw Object.assign(new Error('Settings changed'), { code: 'REVISION_CONFLICT' })
      settingsWrites++; settingsRevision++; settings = resolveOptions(z.object({ options: z.unknown() }).parse(patch).options)
      await options.afterSettingsWrite?.()
    } },
    storageDomain: { open: async () => { throw new Error('The injected repository owns these records') } },
    attachments: { validateImage: async () => { throw new Error('unused') }, saveFile: async () => { throw new Error('unused') }, saveImage: async () => { throw new Error('unused') }, readFileStream: async function* () { throw new Error('unused') }, readImage: async () => { throw new Error('unused') } },
    logger: { error: () => {} },
  }
  const dependencies: SubscriptionDependencies = {
    fetch: options.network ?? (async () => { throw new Error('Real upstream calls are forbidden in this fixture') }),
    openRepository: async () => { await options.repositoryGate; return repository },
    startRelay: async (config, operations) => {
      started.push(config)
      relayOperations.push(operations)
      if (options.failNext && started.length > 1) throw new Error('private-token-in-bind-error')
      const id = config.gatewayKeys[0]?.id ?? ''
      return { origin: 'http://127.0.0.1:3426', port: 3426, close: async () => { closed.push(id) } }
    },
  }
  const boot: Config = { clientVersion: '0.159.0', loginTimeoutMs: 1000, tokenTimeoutMs: 1000, discoveryTtlMs: 1000, cooldownMs: 1000, sessionAffinityLimit: 8, streamIdleTimeoutMs: 1000, requestTimeoutMs: 1000, maxRequestImageBytes: 1024, requestImagePixelBudget: 1000, requestImageMaxBytes: 1024, options: { get: () => settings } }
  const service = new CodexSubscriptionService(host, 'codex-subscription', boot, settings, dependencies)
  return { service, initialize: () => service.initialize(), records, started, relayOperations, closed, settings: () => settings, settingsWrites: () => settingsWrites, repositoryClosed: () => repositoryClosed }
}

test('image card actions and media routes keep the explicit Session scope', async () => {
  const first = parseImageTaskId('10000000-0000-4000-8000-000000000001'), second = parseImageTaskId('10000000-0000-4000-8000-000000000002')
  const now = Date.now()
  const tasks: ImageTaskRecord[] = [first, second].map((id, i) => ({ id, owner: { kind: 'session', sessionId: i ? 'other-session' : 'current-session', toolCallId: `call-${i}` },
    state: 'failed', prompt: 'private image prompt', model: 'gpt-image-2', accountKey: 'private-account', createdAt: now, updatedAt: now, deadlineAt: now + 300000, assets: [] }))
  const repository: ImageTaskRepository = { get: async id => tasks.find(task => task.id === id), list: async () => tasks,
    put: async () => {}, delete: async () => {}, close: async () => {} }
  const f = await fixture({ repository }); await f.initialize()
  try {
    const data = imageSessionViewSchema.parse(await f.service.action({ operation: 'image-session-view', args: { sessionId: 'current-session' } }, signal()))
    assert.equal(data.tasks.length, 1); assert.equal(data.tasks[0]?.taskId, first); assert.equal(data.tasks[0]?.callId, 'call-0')
    assert.doesNotMatch(JSON.stringify(data), /private-account|private image prompt|other-session/)
    const media = await f.service.handle(new Request(`http://fixture/api/codex-subscription/media?task=${second}&session=current-session&asset=not-found`))
    assert.equal(media.status, 404)
    await assert.rejects(f.service.action({ operation: 'image-session-view', args: { sessionId: 'current-session', accountKey: 'not-accepted' } }, signal()))
  } finally { await f.service.dispose() }
})

test('catalog revision and entries come from the same committed settings snapshot during publication', async () => {
  const committed = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const f = await fixture({ afterSettingsWrite: async () => { committed.resolve(); await release.promise } })
  await f.initialize()
  const entries = [{ kind: 'image', id: 'new-image', name: 'New image' }]
  const saving = f.service.action({ operation: 'model-catalog-save', args: { revision: 0, entries } }, signal())
  try {
    await committed.promise
    const concurrent = modelCatalogSchema.parse(await f.service.action({ operation: 'model-catalog' }, signal()))
    assert.equal(concurrent.revision, 1)
    assert.deepEqual(concurrent.entries, entries)
  } finally { release.resolve(); await saving; await f.service.dispose() }
})

test('discovered accounts do not publish models until the owner explicitly saves a shared catalog', async () => {
  const f = await fixture({ network: async input => String(input).endsWith('/wham/usage') ? Response.json({ rate_limit: {} })
    : Response.json({ models: [{ slug: 'gpt-6.1-sol', context_window: 8192, input_modalities: ['text'] }] }) })
  const now = Date.now(), accountId = 'catalog-owner', accountKey = `acct-${createHash('sha256').update(accountId).digest('hex').slice(0, 24)}`
  const access = `e30.${Buffer.from(JSON.stringify({ sub: 'owner', 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url')}.fixture`
  f.records.set(ACCOUNTS_KEY, { kind: 'grant', payload: { version: 1, revision: 1, accounts: { [accountKey]: { accountKey, accountId, label: 'Owner', enabled: true, priority: 0,
    revision: 1, createdAt: now, updatedAt: now, credential: { type: 'oauth', access, refresh: 'private-refresh', expires: now + 3600000, accountId } } } } })
  await f.initialize()
  try {
    const initial = modelCatalogSchema.parse(await f.service.action({ operation: 'model-catalog' }, signal()))
    assert.equal(initial.candidates[0]?.id, 'gpt-6.1-sol'); assert.deepEqual(initial.entries, [])
    assert.deepEqual(await f.service.catalogModels(), [])
    const entries = [{ kind: 'text', id: 'gpt-6.1-sol', name: 'My GPT' }, { kind: 'image', id: 'gpt-image-2', name: 'My images' }]
    await f.service.action({ operation: 'model-catalog-save', args: { revision: initial.revision, entries } }, signal())
    assert.equal((await f.service.catalogModels())[0]?.name, 'My GPT')
    assert.equal((await f.service.catalogModels()).length, 1)
    assert.equal(f.settings().images.defaultModel, 'gpt-image-2')
    await assert.rejects(f.service.action({ operation: 'model-catalog-save', args: { revision: initial.revision, entries: [] } }, signal()), { code: 'REVISION_CONFLICT' })
    const current = modelCatalogSchema.parse(await f.service.action({ operation: 'model-catalog' }, signal()))
    await assert.rejects(f.service.action({ operation: 'model-catalog-save', args: { revision: current.revision, entries: [{ kind: 'text', id: 'unsupported', name: 'Bad' }] } }, signal()), { code: 'MODEL_NOT_AVAILABLE' })
    assert.equal(f.settingsWrites(), 1)
    assert.equal(JSON.stringify(current).includes('private-refresh'), false)
  } finally { await f.service.dispose() }
})

test('Host account queries and owner actions share full safe projections and explicit refresh bypasses the TTL', async () => {
  const requests: string[] = []
  const f = await fixture({ network: async input => {
    const path = new URL(String(input)).pathname; requests.push(path)
    return path.endsWith('/models') ? Response.json({ models: [{ slug: 'gpt-6.1-sol', context_window: 8192, input_modalities: ['text'] }] })
      : Response.json({ plan_type: 'pro', rate_limit: { allowed: true, primary_window: { used_percent: 15, limit_window_seconds: 18000, reset_after_seconds: 1000 } },
        credits: { has_credits: true, unlimited: false, balance: '12.5' }, rate_limit_reset_credits: { available_count: 0 } })
  } })
  const now = Date.now(), key = `acct-${createHash('sha256').update('safe-account').digest('hex').slice(0, 24)}`
  const access = `e30.${Buffer.from(JSON.stringify({ sub: 'safe-user', email: 'owner@fixture.invalid', 'https://api.openai.com/auth': { chatgpt_account_id: 'safe-account', chatgpt_plan_type: 'plus', chatgpt_subscription_active_until: new Date(now + 86400000).toISOString() } })).toString('base64url')}.fixture`
  f.records.set(ACCOUNTS_KEY, { kind: 'grant', payload: { version: 1, revision: 1, accounts: { [key]: { accountKey: key, accountId: 'safe-account', label: 'Owner', enabled: true, revision: 1, createdAt: now, updatedAt: now,
    credential: { type: 'oauth', access, refresh: 'private-refresh', expires: now + 3600000, accountId: 'safe-account' } } } } })
  await f.initialize()
  try {
    const initial = await f.service.accounts.getAccountStatus(key)
    assert.equal(initial.auth.state, 'ready'); assert.equal(initial.usage, undefined); assert.equal(requests.length, 0)
    assert.equal(initial.subscriptionUntil, now + 86400000); assert.notEqual(initial.subscriptionUntil, initial.tokenExpiresAt)
    const [direct, action] = await Promise.all([f.service.accounts.refreshAccount(key), f.service.action({ operation: 'account-refresh', args: { accountKey: key } }, signal())])
    const refreshed = accountViewSchema.parse(action)
    assert.deepEqual(refreshed, direct); assert.equal(requests.length, 2)
    const quota = accountUsageSchema.parse(await f.service.action({ operation: 'account-quota', args: { accountKey: key } }, signal()))
    assert.equal(requests.length, 2); assert.equal(quota.primary?.windowSeconds, 18000); assert.equal(quota.credits?.balance, '12.5')
    const status = accountViewSchema.parse(await f.service.action({ operation: 'account-status', args: { accountKey: key } }, signal()))
    assert.deepEqual(status.usage, quota)
    const snapshot = await f.service.snapshot()
    assert.deepEqual(snapshot.accounts[0], status)
    const routes = await f.service.accounts.modelRoutes()
    assert.deepEqual(await f.service.action({ operation: 'model-routes' }, signal()), routes)
    assert.deepEqual(routes[0]?.accountKeys, [key]); assert.equal(routes[0]?.baseModelId, 'gpt-6.1-sol')
    await f.service.action({ operation: 'account-status', args: { accountKey: key, fresh: true } }, signal())
    assert.equal(requests.length, 4)
    const encoded = JSON.stringify({ status, snapshot, routes })
    for (const secret of [access, 'private-refresh', 'credentialTag']) assert.equal(encoded.includes(secret), false)
    await assert.rejects(f.service.action({ operation: 'account-status', args: { accountKey: key, accessToken: 'forbidden' } }, signal()))
    await assert.rejects(f.service.accounts.getAccountStatus('missing'), { code: 'ACCOUNT_NOT_FOUND' })
    const aborted = new AbortController(); aborted.abort(new Error('cancelled caller'))
    await assert.rejects(f.service.accounts.refreshAccount(key, aborted.signal), /cancelled caller/)
    assert.equal(requests.length, 4)
  } finally { await f.service.dispose() }
})

test('gateway rotation is serialized and revoke durably disables the listener before deleting its key', async () => {
  const f = await fixture({ enabled: true })
  await f.initialize()
  try {
    const [one, two] = await Promise.all([f.service.action({ operation: 'gateway-create' }, signal()), f.service.action({ operation: 'gateway-create' }, signal())])
    const first = keySchema.parse(one), second = keySchema.parse(two)
    assert.notEqual(first.secret, second.secret)
    assert.deepEqual(f.started.map(config => config.gatewayKeys[0]?.id), ['seed', first.id, second.id])
    assert.deepEqual(f.closed, ['seed', first.id])
    const persisted = f.records.get(gatewayKey)
    assert.equal(persisted?.kind, 'grant')
    if (persisted?.kind !== 'grant') throw new Error('Expected the gateway record')
    assert.equal(keySchema.parse(persisted.payload).secret, second.secret)
    const snapshot = await f.service.snapshot()
    assert.equal(JSON.stringify(snapshot).includes(second.secret), false)
    await f.service.action({ operation: 'gateway-revoke' }, signal())
    assert.equal(f.settings().relay.enabled, false)
    assert.equal(f.settingsWrites(), 1)
    assert.equal(f.records.has(gatewayKey), false)
    assert.deepEqual(f.closed, ['seed', first.id, second.id])
  } finally { await f.service.dispose() }
})

test('a listener start failure still returns the newly committed gateway secret once', async () => {
  const f = await fixture({ enabled: true, failNext: true })
  await f.initialize()
  try {
    const result = keySchema.parse(await f.service.action({ operation: 'gateway-create' }, signal()))
    assert.equal(result.relayError, 'RELAY_START_FAILED')
    const stored = f.records.get(gatewayKey)
    if (stored?.kind !== 'grant') throw new Error('Expected a persisted secret')
    assert.equal(keySchema.parse(stored.payload).secret, result.secret)
    const snapshot = await f.service.snapshot()
    assert.equal(snapshot.relay.state, 'error')
    assert.equal(JSON.stringify(snapshot).includes(result.secret), false)
    assert.equal(JSON.stringify(snapshot).includes('private-token'), false)
  } finally { await f.service.dispose() }
})

test('dispose returns the same draining promise and stops new owner operations', async () => {
  const gate = Promise.withResolvers<void>()
  const f = await fixture({ closeGate: gate.promise })
  await f.initialize()
  const first = f.service.dispose(), second = f.service.dispose()
  assert.equal(first, second)
  await assert.rejects(f.service.action({ operation: 'gateway-create' }, signal()), { code: 'STOPPING' })
  assert.equal((await f.service.handle(new Request('http://fixture/api/codex-subscription/manage', { method: 'POST', body: '{}' }))).status, 503)
  gate.resolve()
  await first
  assert.equal(f.repositoryClosed(), 1)
})

test('dispose drains an initialization that was still opening its repository', async () => {
  const gate = Promise.withResolvers<void>()
  const f = await fixture({ repositoryGate: gate.promise })
  const initializing = f.initialize()
  const stopped = f.service.dispose()
  gate.resolve()
  await assert.rejects(initializing, { code: 'STOPPING' })
  await stopped
  assert.equal(f.repositoryClosed(), 1)
})

test('wire failures expose stable codes rather than exception details', () => {
  assert.equal(safeCode(new Error('Authorization: Bearer private-token')), 'OPERATION_FAILED')
  assert.equal(safeCode(new SyntaxError('private OAuth callback')), 'INVALID_INPUT')
  assert.equal(safeCode(Object.assign(new Error('private'), { code: 'bad token value' })), 'OPERATION_FAILED')
  assert.equal(safeCode(Object.assign(new Error('private'), { code: 'REVISION_CONFLICT' })), 'REVISION_CONFLICT')
})

test('missing relay credentials do not prevent subscription management from starting', async () => {
  const f = await fixture({ enabled: true, noKey: true })
  await f.initialize()
  try {
    const snapshot = await f.service.snapshot()
    assert.equal(snapshot.relay.state, 'error')
    assert.equal(snapshot.relay.errorCode, 'GATEWAY_KEY_REQUIRED')
    assert.deepEqual(await f.service.action({ operation: 'account-list' }, signal()), [])
    assert.deepEqual(await f.service.action({ operation: 'model-list' }, signal()), [])
  } finally { await f.service.dispose() }
})

test('external gateway revocation closes the old listener without disabling model management', async () => {
  const f = await fixture({ enabled: true })
  await f.initialize()
  try {
    f.records.delete(gatewayKey)
    await assert.rejects(f.service.refreshGateway(), { code: 'GATEWAY_KEY_REQUIRED' })
    assert.deepEqual(f.closed, ['seed'])
    assert.equal((await f.service.snapshot()).relay.state, 'error')
    assert.deepEqual(await f.service.action({ operation: 'account-list' }, signal()), [])
  } finally { await f.service.dispose() }
})

test('service methods share negotiated wire versions and refresh capabilities after version or output-budget changes', async () => {
  const requests: { url: URL; headers: Headers }[] = []
  const f = await fixture({ enabled: true, network: async (input, init) => {
    const url = new URL(String(input)), headers = new Headers(init?.headers)
    requests.push({ url, headers })
    if (url.pathname.endsWith('/models')) return Response.json({ models: [{ slug: 'future-fixture', context_window: 16384, input_modalities: ['text'] }] })
    if (url.pathname.endsWith('/usage')) return Response.json({ rate_limit: {} })
    return new Response('data: {"type":"response.completed","response":{"id":"fixture","output":[]}}\n\n', { headers: { 'x-codex-turn-state': 'fixture-turn' } })
  } })
  const accountId = 'a', now = Date.now(), accountKey = `acct-${createHash('sha256').update(accountId).digest('hex').slice(0, 24)}`
  const access = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url')}.fixture`
  f.records.set(ACCOUNTS_KEY, { kind: 'grant', payload: { version: 1, revision: 1, accounts: { [accountKey]: { accountKey, accountId, label: 'fixture', enabled: true,
    priority: 0, revision: 1, createdAt: now, updatedAt: now, credential: { type: 'oauth', access, refresh: 'fixture', expires: now + 3600000, accountId } } } } })
  await f.initialize()
  try {
    assert.equal((await f.service.accounts.models())[0]?.maxTokens, 8192)
    f.relayOperations[0]!.observeClient?.(new Headers({ originator: 'codex_cli_rs', version: '0.170.0' }))
    await f.service.accounts.models()
    const raw = await f.service.requestResponses({ model: 'future-fixture', input: 'hello', stream: true }, signal())
    assert.equal(raw.headers.get('x-codex-turn-state'), 'fixture-turn'); await raw.text()
    const discovery = requests.filter(request => request.url.pathname.endsWith('/models'))
    assert.deepEqual(discovery.map(request => request.url.searchParams.get('client_version')), ['0.159.0', '0.170.0'])
    const last = requests.at(-1)!
    assert.equal(last.headers.get('version'), '0.170.0'); assert.match(last.headers.get('user-agent')!, /codex_cli_rs\/0.170.0 /)
    await f.service.reconfigure({ ...f.settings(), models: { fallbackMaxTokens: 1024 } })
    assert.equal((await f.service.accounts.models())[0]?.maxTokens, 1024)
    const snapshot = await f.service.snapshot()
    assert.equal(snapshot.models[0]?.contextWindow, 16384)
    assert.equal(snapshot.protocol.version.effective, '0.170.0')
    assert.equal(snapshot.protocol.upstream.mode, 'sse')
    assert.deepEqual(await f.service.action({ operation: 'protocol-status' }, signal()), f.service.protocolStatus())
    assert.equal(JSON.stringify(snapshot).includes(access), false)
  } finally { await f.service.dispose() }
})
