/** Keyless OAuth protocol, account isolation and serialized token rotation. */
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, Server, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider, type CredentialKey, type CredentialRecord, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { CodexAccounts, ACCOUNTS_KEY, AccountError, type AccountsOptions } from '../src/host/accounts/index.ts'
import { createOAuthAttempt, exchangeTokens } from '../src/host/accounts/oauth.ts'
import { AccountRejected, readGrant } from '../src/host/accounts/record.ts'
import { readBoundedJson } from '../src/host/accounts/json.ts'
import { CodexResponsesTransport } from '../src/host/relay/transport.ts'
import { startRelay } from '../src/host/relay/server.ts'

const jwt = (accountId: string, extra: Record<string, unknown> = {}) => `e30.${Buffer.from(JSON.stringify({ email: `${accountId}@fixture.invalid`,
  'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'plus', ...extra } })).toString('base64url')}.fixture`
const keyFor = (id: string) => `acct-${createHash('sha256').update(id).digest('hex').slice(0, 24)}`

class MemoryCredentials extends CredentialProvider {
  record: CredentialRecord | undefined
  private tail: Promise<void> = Promise.resolve()
  override async resolve(_ref: CredentialRef) { return undefined }
  override async describe(_ref: CredentialRef) { return { configured: false, writable: true } }
  override async set(_ref: CredentialRef, _value: string) {}
  override async unset(_ref: CredentialRef) {}
  override async readRecord(_key: CredentialKey) { return structuredClone(this.record) }
  override async describeRecord(_key: CredentialKey) { return this.record ? { configured: true, writable: true, kind: this.record.kind } : { configured: false, writable: true } }
  override async listRecords() { return this.record ? [{ key: ACCOUNTS_KEY, kind: this.record.kind }] : [] }
  override async modifyRecord(key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
    const operation = this.tail.then(async () => { const next = await mutate(structuredClone(this.record)); if (next !== undefined) { this.record = structuredClone(next); this.ctx.emit('credentials/record-updated', key) }; return structuredClone(this.record) })
    this.tail = operation.then(() => {}, () => {}); return operation
  }
  override async deleteRecord(key: CredentialKey) { this.record = undefined; this.ctx.emit('credentials/record-updated', key) }
}

async function fixture(network?: typeof fetch, now?: () => number) {
  const ctx = new Context(); await ctx.plugin(MemoryCredentials); await ctx.plugin(AuthorizationService)
  const options: AccountsOptions = { credentials: ctx.credentials, authorization: ctx.authorization,
    fetch: network ?? (async input => String(input).includes('/codex/models') ? Response.json({ models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT fixture' }, { slug: 'unknown-future-model' }] })
      : Response.json({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 12, reset_at: 2000000000 } } })),
    clientId: 'fixture-client', authorizeUrl: 'https://auth.fixture.invalid/oauth/authorize', tokenUrl: 'https://auth.fixture.invalid/oauth/token',
    callbackPorts: [0], loginTimeoutMs: 5000, tokenTimeoutMs: 1000, sessionAffinityLimit: 8, cooldownMs: 1000,
    baseUrl: 'https://chatgpt.fixture.invalid/backend-api', clientVersion: 'fixture', discoveryTtlMs: 1, ...(now === undefined ? {} : { now }) }
  const accounts = new CodexAccounts(options), unmount = accounts.mount()
  const seed = async (ids: string[], expired = false) => {
    const now = Date.now()
    await ctx.credentials.modifyRecord(ACCOUNTS_KEY, async () => ({ kind: 'grant', payload: { version: 1, revision: 1,
      accounts: Object.fromEntries(ids.map(id => [keyFor(id), { accountKey: keyFor(id), accountId: id, label: id, enabled: true, priority: 0,
        revision: 1, createdAt: now, updatedAt: now, credential: { type: 'oauth', access: jwt(id), refresh: `fixture-refresh-${id}`,
          expires: now + (expired ? -1 : 3600000), accountId: id, idToken: jwt(id, { chatgpt_workspace_id: 'fixture-workspace' }) } }])) } }))
  }
  return { ctx, options, accounts, seed, close: async () => { await unmount(); await ctx.fiber.dispose() } }
}

test('images skip accounts forbidding credits without treating text allowance as image allowance', async () => {
  const f = await fixture()
  try {
    await f.seed(['a', 'b'])
    await f.accounts.update(keyFor('a'), { revision: 1, allowCredits: false, priority: 100 })
    const chosen = await f.accounts.withAccount({ kind: 'image' }, async lease => lease.accountKey)
    assert.equal(chosen, keyFor('b'))
    await f.accounts.update(keyFor('b'), { revision: 1, allowCredits: false })
    await assert.rejects(f.accounts.withAccount({ kind: 'image' }, async () => true), { code: 'IMAGE_CREDITS_DISABLED' })
    assert.equal(await f.accounts.withAccount({ kind: 'text', model: 'gpt-6.1-sol' }, async () => true), true)
  } finally { await f.close() }
})

test('different members of one workspace remain distinct and signing in again preserves that member key', async () => {
  let email = 'alice@fixture.invalid'
  const access = () => `e30.${Buffer.from(JSON.stringify({ email, sub: email, 'https://api.openai.com/auth': { chatgpt_account_id: 'same-team', chatgpt_plan_type: 'team' } })).toString('base64url')}.fixture`
  const f = await fixture(async input => String(input).endsWith('/token') ? Response.json({ access_token: access(), id_token: access(), refresh_token: 'fixture-' + email, expires_in: 3600 }) : Response.json({ rate_limit: {} }))
  const login = async () => { const pending = await f.accounts.beginLogin(), url = new URL(pending.authorizationUrl); return f.accounts.completeLogin(pending.loginId, `${pending.redirectUri}?code=fixture&state=${url.searchParams.get('state')}`) }
  try {
    await login(); const alice = (await f.accounts.list())[0]!
    email = 'bob@fixture.invalid'; await login()
    const views = await f.accounts.list()
    assert.equal(views.length, 2)
    assert.equal(views.find(account => account.email === email)?.label, email)
    email = 'alice@fixture.invalid'; await login()
    const again = await f.accounts.list()
    assert.equal(again.length, 2); assert.equal(again.find(account => account.email === email)?.accountKey, alice.accountKey)
  } finally { await f.close() }
})

test('reauthorizing a legacy v1 account keeps its key and user-selected label', async () => {
  const f = await fixture(async input => String(input).endsWith('/token') ? Response.json({ access_token: jwt('a'), id_token: jwt('a'), refresh_token: 'reauthorized', expires_in: 3600 }) : Response.json({ rate_limit: {} }))
  try {
    await f.seed(['a']); await f.accounts.update(keyFor('a'), { revision: 1, label: 'My account' })
    const pending = await f.accounts.beginLogin(), url = new URL(pending.authorizationUrl)
    await f.accounts.completeLogin(pending.loginId, `${pending.redirectUri}?code=fixture&state=${url.searchParams.get('state')}`)
    const accounts = await f.accounts.list()
    assert.equal(accounts.length, 1); assert.equal(accounts[0]?.accountKey, keyFor('a')); assert.equal(accounts[0]?.label, 'My account')
  } finally { await f.close() }
})

test('a failed quota poll retains an unreset exhausted window when credits spending is disabled', async () => {
  let now = Date.now(), failing = false
  const f = await fixture(async input => String(input).includes('/codex/models') ? Response.json({ models: [{ slug: 'gpt-6.1-sol' }] })
    : failing ? new Response(null, { status: 503 }) : Response.json({ rate_limit: { primary_window: { used_percent: 100, reset_at: Math.floor((now + 3600000) / 1000) } } }), () => now)
  f.options.discoveryTtlMs = 60000
  try {
    await f.seed(['a']); await f.accounts.update(keyFor('a'), { revision: 1, allowCredits: false }); await f.accounts.list()
    await assert.rejects(f.accounts.withAccount({ kind: 'text', model: 'gpt-6.1-sol' }, async () => true), { code: 'NO_AVAILABLE_ACCOUNT' })
    now += 60001; failing = true
    await assert.rejects(f.accounts.withAccount({ kind: 'text', model: 'gpt-6.1-sol' }, async () => true), { code: 'NO_AVAILABLE_ACCOUNT' })
    const view = (await f.accounts.list())[0]!
    assert.equal(view.usage?.primary?.usedPercent, 100)
  } finally { await f.close() }
})

test('quota failures expose safe HTTP or response classifications and retain the last successful windows', async () => {
  let mode: 'ready' | 'http' | 'json' | 'schema' = 'ready', now = Date.now()
  const privateDetails = 'fixture-private-quota-body-and-message'
  const f = await fixture(async input => {
    if (String(input).includes('/codex/models')) return Response.json({ models: [{ slug: 'gpt-6.1-sol' }] })
    if (mode === 'http') return Response.json({ error: { message: privateDetails } }, { status: 503 })
    if (mode === 'json') return new Response(privateDetails)
    if (mode === 'schema') return Response.json({ rate_limit: { primary_window: { used_percent: privateDetails } } })
    return Response.json({ rate_limit: { primary_window: { used_percent: 25, reset_after_seconds: 3600 }, secondary_window: { used_percent: 75, reset_after_seconds: 7200 } } })
  }, () => now)
  f.options.discoveryTtlMs = 60000
  try {
    await f.seed(['a'])
    const good = (await f.accounts.list())[0]!.usage!
    for (const failure of ['http', 'json', 'schema'] as const) {
      mode = failure; now += 1000
      const usage = (await f.accounts.refreshAccount(keyFor('a'))).usage!
      assert.equal(usage.status, 'error'); assert.equal(usage.freshness, 'stale')
      assert.equal(usage.errorCode, failure === 'http' ? 'USAGE_HTTP_FAILED' : 'USAGE_INVALID_RESPONSE')
      assert.equal(usage.errorStatus, failure === 'http' ? 503 : undefined)
      assert.deepEqual(usage.primary, good.primary); assert.deepEqual(usage.secondary, good.secondary)
      assert.equal(usage.lastSuccessfulAt, good.lastSuccessfulAt)
      assert.equal(JSON.stringify(usage).includes(privateDetails), false)
      assert.equal(JSON.stringify(usage).includes('fixture-refresh'), false)
    }
  } finally { await f.close() }
})

test('spent quota survives an account owner restart and an unsuccessful first poll', async () => {
  let now = Date.now(), failing = false
  const f = await fixture(async () => failing ? new Response(null, { status: 503 })
    : Response.json({ rate_limit: { primary_window: { used_percent: 100, reset_after_seconds: 3600 } } }), () => now)
  let restarted: CodexAccounts | undefined
  try {
    await f.seed(['a']); await f.accounts.update(keyFor('a'), { revision: 1, allowCredits: false }); await f.accounts.list()
    failing = true; now += 60001
    restarted = new CodexAccounts(f.options)
    await assert.rejects(restarted.withAccount({ kind: 'text' }, async () => true), { code: 'NO_AVAILABLE_ACCOUNT' })
    assert.equal((await restarted.getAccountQuota(keyFor('a')))?.primary?.usedPercent, 100)
  } finally { await restarted?.dispose(); await f.close() }
})

test('a partial successful poll does not discard a known exhausted window', async () => {
  let partial = false
  const f = await fixture(async () => Response.json(partial ? { rate_limit: {} } : { rate_limit: { primary_window: { used_percent: 100, reset_after_seconds: 3600 } } }))
  try {
    await f.seed(['a']); await f.accounts.update(keyFor('a'), { revision: 1, allowCredits: false }); await f.accounts.list()
    partial = true; await f.accounts.refreshAccount(keyFor('a'))
    await assert.rejects(f.accounts.withAccount({ kind: 'text' }, async () => true), { code: 'NO_AVAILABLE_ACCOUNT' })
  } finally { await f.close() }
})

test('live response quota is drained to storage before shutdown and protects the next owner', async () => {
  let failing = false
  const f = await fixture(async () => failing ? new Response(null, { status: 503 }) : Response.json({ rate_limit: { primary_window: { used_percent: 10 } } }))
  let restarted: CodexAccounts | undefined
  try {
    await f.seed(['a']); await f.accounts.update(keyFor('a'), { revision: 1, allowCredits: false })
    await f.accounts.withAccount({ kind: 'text' }, async lease => {
      const response = lease.observeResponse!(new Response(null, { headers: { 'x-codex-primary-used-percent': '100', 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-after-seconds': '3600' } }))
      await response.body?.cancel()
    })
    await f.accounts.dispose(); failing = true
    restarted = new CodexAccounts({ ...f.options, discoveryTtlMs: 1 })
    await assert.rejects(restarted.withAccount({ kind: 'text' }, async () => true), { code: 'NO_AVAILABLE_ACCOUNT' })
  } finally { await restarted?.dispose(); await f.close() }
})

test('a terminal pre-dispatch refresh refusal can select another account and remains persisted after restart', async () => {
  let refreshes = 0
  const f = await fixture(async (_input, init) => {
    refreshes++
    const token = new URLSearchParams(String(init?.body)).get('refresh_token')
    return token === 'fixture-refresh-a' ? Response.json({ error: 'invalid_grant' }, { status: 400 })
      : Response.json({ access_token: jwt('b'), refresh_token: 'rotated-b', expires_in: 3600 })
  })
  try {
    await f.seed(['a', 'b'], true)
    assert.equal(await f.accounts.withAccount({ kind: 'image' }, async lease => lease.accountId), 'b')
    const restarted = new CodexAccounts(f.options)
    try {
      assert.equal((await restarted.getAccountStatus(keyFor('a'))).auth.state, 'needs-login')
      await assert.rejects(restarted.withAccount({ kind: 'image', accountKey: keyFor('a') }, async () => true), { code: 'ACCOUNT_RELOGIN_REQUIRED' })
      assert.equal(refreshes, 2)
    } finally { await restarted.dispose() }
  } finally { await f.close() }
})

test('a stale rejected request cannot mark newer credentials as requiring login', async () => {
  const entered = Promise.withResolvers<void>(), rejected = Promise.withResolvers<void>()
  const f = await fixture()
  try {
    await f.seed(['a'])
    const old = f.accounts.withAccount({ kind: 'image' }, async () => { entered.resolve(); await rejected.promise; throw new AccountRejected(401, { authCode: 'TOKEN_REVOKED' }) })
    const observed = assert.rejects(old, { status: 401 })
    await entered.promise
    await f.ctx.credentials.modifyRecord(ACCOUNTS_KEY, async record => {
      const grant = readGrant(record), current = grant.accounts[keyFor('a')]!
      current.credential.access = jwt('a', { generation: 'new' }); current.credential.refresh = 'new-refresh'
      return { kind: 'grant', payload: grant }
    })
    rejected.resolve(); await observed
    assert.equal((await f.accounts.getAccountStatus(keyFor('a'))).auth.state, 'ready')
    assert.equal(await f.accounts.withAccount({ kind: 'image' }, async () => true), true)
  } finally { rejected.resolve(); await f.close() }
})

test('a terminal refresh refusal is persisted and subsequent requests wait for reauthorization', async () => {
  let refreshes = 0
  const f = await fixture(async () => { refreshes++; return Response.json({ error: 'invalid_grant', error_description: 'private provider message' }, { status: 400 }) })
  try {
    await f.seed(['a'], true)
    await assert.rejects(f.accounts.withAccount({ kind: 'image', accountKey: keyFor('a') }, async () => true))
    const accounts = await f.accounts.list()
    assert.equal(accounts[0]?.auth.state, 'needs-login')
    await assert.rejects(f.accounts.withAccount({ kind: 'image', accountKey: keyFor('a') }, async () => true), { code: 'ACCOUNT_RELOGIN_REQUIRED' })
    assert.equal(refreshes, 1)
    assert.equal(JSON.stringify(accounts).includes('private provider message'), false)
  } finally { await f.close() }
})

test('reauthorization clears a terminal failure while a transient refresh failure stays retryable', async () => {
  let terminal = false, reauthorized = false, exchanges = 0
  const f = await fixture(async input => {
    if (!String(input).endsWith('/token')) return Response.json({ rate_limit: {} })
    exchanges++
    return reauthorized ? Response.json({ access_token: jwt('a'), refresh_token: 'replacement', expires_in: 3600 })
      : Response.json({ error: terminal ? 'refresh_token_reused' : 'temporarily_unavailable' }, { status: terminal ? 400 : 503 })
  })
  try {
    await f.seed(['a'], true)
    await assert.rejects(f.accounts.withAccount({ kind: 'image' }, async () => true))
    assert.equal((await f.accounts.list())[0]?.auth.state, 'refresh-required')
    terminal = true
    await assert.rejects(f.accounts.withAccount({ kind: 'image' }, async () => true))
    assert.equal((await f.accounts.list())[0]?.auth.state, 'needs-login')
    reauthorized = true
    const pending = await f.accounts.beginLogin(), url = new URL(pending.authorizationUrl)
    await f.accounts.completeLogin(pending.loginId, `${pending.redirectUri}?code=fixture&state=${url.searchParams.get('state')}`)
    assert.equal((await f.accounts.list())[0]?.auth.state, 'ready')
    assert.equal(await f.accounts.withAccount({ kind: 'image', accountKey: keyFor('a') }, async () => true), true)
    assert.equal(exchanges, 4) // 两次显式尝试、list 的一次可恢复重试、一次重新授权。
  } finally { await f.close() }
})

test('quota information exposes live plan, credits, held reasons, relative resets and safe reset-card details', async () => {
  const now = Date.now(), until = now + 86400000
  const f = await fixture(async input => String(input).endsWith('/wham/rate-limit-reset-credits')
    ? Response.json({ credits: [{ id: 'private-reset', status: 'available', expires_at: new Date(until).toISOString() }] })
    : Response.json({ plan_type: 'pro', credits: { has_credits: false, unlimited: false, balance: '0', overage_limit_reached: true },
      spend_control: { reached: true }, rate_limit_reached_type: { type: 'workspace_owner_usage_limit_reached' },
      rate_limit_reset_credits: { available_count: 1 }, rate_limit: { allowed: false,
        primary_window: { used_percent: 100, reset_after_seconds: 3600, limit_window_seconds: 18000 } } }), () => now)
  f.options.discoveryTtlMs = 60000
  try {
    await f.seed(['a'])
    const view = (await f.accounts.list())[0]!
    assert.equal(view.plan, 'pro'); assert.equal(view.planSource, 'usage'); assert.equal(view.claimPlan, 'plus')
    assert.equal(view.workspace, 'fixture-workspace'); assert.equal(view.email, 'a@fixture.invalid')
    assert.equal(view.usage?.allowed, false); assert.equal(view.usage?.credits?.balance, '0')
    assert.equal(view.usage?.spendControlReached, true); assert.equal(view.usage?.held, true)
    assert.equal(view.usage?.heldReason, 'spending-limit')
    assert.equal(view.usage?.primary?.resetAt, now + 3600000)
    assert.equal(view.usage?.primary?.windowSeconds, 18000)
    assert.deepEqual(view.usage?.resetCredits, { availableCount: 1, earliestExpiresAt: until })
    assert.equal(JSON.stringify(view).includes('private-reset'), false)
    await assert.rejects(f.accounts.withAccount({ kind: 'text' }, async () => true), { code: 'NO_AVAILABLE_ACCOUNT' })
  } finally { await f.close() }
})

test('raw Responses switches on 402 before output and never dispatches an ordinary upstream failure twice', async () => {
  const calls: string[] = []
  let status = 402, now = Date.now()
  const f = await fixture(async (input, init) => {
    if (String(input).includes('/models')) return Response.json({ models: [{ slug: 'gpt-6.1-sol' }] })
    if (String(input).endsWith('/usage')) return Response.json({ rate_limit: {} })
    const id = new Headers(init?.headers).get('chatgpt-account-id')!; calls.push(id)
    return id === 'a' ? Response.json({ error: { code: 'insufficient_quota', message: 'private body' } }, { status }) : new Response('data: {}\n\n')
  }, () => now)
  const transport = new CodexResponsesTransport({ accounts: f.accounts, fetch: f.options.fetch, endpoint: f.options.baseUrl + '/codex/responses', originator: 'codex_cli_rs', userAgent: 'fixture', clientVersion: 'fixture' })
  try {
    await f.seed(['a', 'b']); await (await transport.request({ model: 'gpt-6.1-sol', input: 'fixture' }, new AbortController().signal)).text()
    assert.deepEqual(calls, ['a', 'b'])
    await f.accounts.update(keyFor('b'), { revision: 1, enabled: false })
    status = 500
    now += 2000; calls.length = 0
    await assert.rejects(transport.request({ model: 'gpt-6.1-sol', input: 'fixture' }, new AbortController().signal), { status: 500 })
    assert.deepEqual(calls, ['a'])
  } finally { await transport.dispose(); await f.close() }
})

test('Retry-After survives raw HTTP and local relay errors and delays that account beyond the base cooldown', async () => {
  let now = Date.now(), upstreamCalls = 0
  const f = await fixture(async (input) => {
    if (String(input).includes('/models')) return Response.json({ models: [{ slug: 'gpt-6.1-sol' }] })
    if (String(input).endsWith('/usage')) return Response.json({ rate_limit: {} })
    upstreamCalls++
    return Response.json({ error: { code: 'rate_limit_exceeded', message: 'private upstream details' } }, { status: 429, headers: { 'retry-after': '120', 'x-request-id': 'req_fixture' } })
  }, () => now)
  const transport = new CodexResponsesTransport({ accounts: f.accounts, fetch: f.options.fetch, endpoint: f.options.baseUrl + '/codex/responses', originator: 'codex_cli_rs', userAgent: 'fixture', clientVersion: 'fixture' })
  const relay = await startRelay({ host: '127.0.0.1', port: 0, gatewayKeys: [{ id: 'fixture', secret: 'test-gateway-key-1234567890' }], allowedOrigins: [], maxRequestBytes: 1024, maxResponseBytes: 65536, requestTimeoutMs: 5000, imageWaitMs: 10, assetUrlTtlMs: 60000, maxConcurrentRequests: 1 }, {
    requestResponses: (body, signal) => transport.request(body, signal), listModels: () => f.accounts.models(),
    images: { submit: async () => { throw new Error('unused') }, getResult: async () => { throw new Error('unused') } }, readAsset: async () => { throw new Error('unused') },
  })
  try {
    await f.seed(['a'])
    const response = await fetch(relay.origin + '/v1/responses', { method: 'POST', headers: { Authorization: 'Bearer test-gateway-key-1234567890', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-6.1-sol', input: 'fixture' }) })
    assert.equal(response.status, 429); assert.ok(Number(response.headers.get('retry-after')) >= 119)
    assert.equal(response.headers.get('x-request-id'), 'req_fixture')
    const body = await response.text(); assert.equal(body.includes('private upstream'), false)
    now += 2000
    await assert.rejects(f.accounts.withAccount({ kind: 'text', model: 'gpt-6.1-sol' }, async () => true), { code: 'NO_AVAILABLE_ACCOUNT' })
    assert.equal(upstreamCalls, 1)
  } finally { await relay.close(); await transport.dispose(); await f.close() }
})

test('a new client version refreshes a pending old catalog before returning to its caller', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let version = '0.159.0'
  const observed: string[] = []
  const f = await fixture(async input => {
    const selected = new URL(String(input)).searchParams.get('client_version')!
    observed.push(selected)
    if (selected === '0.159.0') { entered.resolve(); await release.promise }
    return Response.json({ models: [{ slug: 'gpt-6.1-sol', context_window: selected === '0.159.0' ? 4096 : 8192, input_modalities: ['text'] }] })
  })
  f.options.resolveClientVersion = async () => version
  f.options.discoveryTtlMs = 60000
  try {
    await f.seed(['a'])
    const first = f.accounts.models(); await entered.promise
    version = '0.170.0'
    const second = f.accounts.models(); release.resolve()
    await first
    assert.equal((await second)[0]?.contextWindow, 8192)
    assert.deepEqual(observed, ['0.159.0', '0.170.0'])
  } finally { release.resolve(); await f.close() }
})

test('raw reasoning and service-tier requests prefer an entitled account over an incompatible higher priority account', async () => {
  const f = await fixture(async (input, init) => {
    if (String(input).includes('/usage')) return Response.json({ rate_limit: {} })
    const basic = new Headers(init?.headers).get('chatgpt-account-id') === 'basic'
    return Response.json({ models: [{ slug: 'gpt-6.1-sol', context_window: 8192, input_modalities: ['text'],
      supported_reasoning_levels: [{ effort: basic ? 'low' : 'high' }], service_tiers: [{ id: basic ? 'ultrafast' : 'priority' }] }] })
  })
  f.options.discoveryTtlMs = 60000
  try {
    await f.seed(['basic', 'plus']); await f.accounts.update(keyFor('basic'), { revision: 1, priority: 10 })
    const selected = (request: { reasoningEffort?: string; serviceTier?: string }) => f.accounts.withAccount({ kind: 'text', model: 'gpt-6.1-sol', ...request }, async lease => lease.accountId)
    assert.equal(await selected({ reasoningEffort: 'high' }), 'plus')
    assert.equal(await selected({ serviceTier: 'priority' }), 'plus')
    assert.equal(await selected({ reasoningEffort: 'low' }), 'basic')
  } finally { await f.close() }
})

test('PKCE callback, manual paste and complete identity commit share one authorization record', async () => {
  let verifier = '', redirect = ''
  const f = await fixture(async (_input, init) => {
    const fields = new URLSearchParams(String(init?.body)); verifier = fields.get('code_verifier') ?? ''; redirect = fields.get('redirect_uri') ?? ''
    return Response.json({ access_token: jwt('browser'), refresh_token: 'fixture-refresh', expires_in: 3600,
      id_token: jwt('browser', { chatgpt_workspace_id: 'workspace-browser' }) })
  })
  try {
    const login = await f.accounts.beginLogin(), url = new URL(login.authorizationUrl)
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    await assert.rejects(f.accounts.completeLogin(login.loginId, `${login.redirectUri}?code=fixture-code&state=wrong`), { code: 'INVALID_STATE' })
    const done = await f.accounts.completeLogin(login.loginId, `${login.redirectUri}?code=fixture-code&state=${url.searchParams.get('state')}`)
    assert.equal(done.state, 'authorized'); assert.equal(redirect, login.redirectUri)
    assert.equal(createHash('sha256').update(verifier).digest('base64url'), url.searchParams.get('code_challenge'))
    const grant = readGrant(await f.ctx.credentials.readRecord(ACCOUNTS_KEY)), stored = Object.values(grant.accounts).find(account => account.accountId === 'browser')
    assert.equal(stored?.email, 'browser@fixture.invalid'); assert.equal(stored?.workspace, 'workspace-browser'); assert.ok(stored?.credential.idToken)
    assert.ok(!JSON.stringify(f.accounts.loginStatus(login.loginId)).includes('fixture-refresh'))
  } finally { await f.close() }
})

test('loopback callback sends auto-closing success HTML only after token exchange and credential persistence authorize the account', async () => {
  const tokenStarted = Promise.withResolvers<void>(), releaseToken = Promise.withResolvers<void>()
  const writeStarted = Promise.withResolvers<void>(), releaseWrite = Promise.withResolvers<void>()
  const access = jwt('callback-browser'), idToken = jwt('callback-browser', { chatgpt_workspace_id: 'callback-workspace' })
  const refresh = 'fixture-callback-refresh', code = 'fixture-sensitive-callback-code'
  const f = await fixture(async () => {
    tokenStarted.resolve(); await releaseToken.promise
    return Response.json({ access_token: access, id_token: idToken, refresh_token: refresh, expires_in: 3600 })
  })
  const modifyRecord = f.ctx.credentials.modifyRecord.bind(f.ctx.credentials)
  const persistence = mock.method(f.ctx.credentials, 'modifyRecord', async (key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) => {
    writeStarted.resolve(); await releaseWrite.promise
    return modifyRecord(key, mutate)
  })
  let callback: Promise<Response> | undefined, responseState: string | undefined
  let restoreResponseEnd: (() => void) | undefined
  try {
    const login = await f.accounts.beginLogin(), authorize = new URL(login.authorizationUrl), state = authorize.searchParams.get('state')!
    const url = new URL(`${login.redirectUri.replace('localhost', '127.0.0.1')}?code=${code}&state=${state}`)
    const end = ServerResponse.prototype.end
    // 在 HTTP 实际写出时观察授权状态，避免用定时等待推测是否提前成功。
    const responseEnd = mock.method(ServerResponse.prototype, 'end', function (this: ServerResponse, ...args: Parameters<ServerResponse['end']>): ServerResponse {
      if (this.req.url === url.pathname + url.search) responseState = f.accounts.loginStatus(login.loginId).state
      return Reflect.apply(end, this, args)
    })
    restoreResponseEnd = () => responseEnd.mock.restore()
    callback = fetch(url)
    await tokenStarted.promise
    assert.equal(f.accounts.loginStatus(login.loginId).state, 'exchanging')
    assert.equal(await f.ctx.credentials.readRecord(ACCOUNTS_KEY), undefined)
    releaseToken.resolve(); await writeStarted.promise
    assert.equal(f.accounts.loginStatus(login.loginId).state, 'exchanging')
    assert.equal(await f.ctx.credentials.readRecord(ACCOUNTS_KEY), undefined)
    releaseWrite.resolve()
    const response = await callback, html = await response.text()
    assert.equal(responseState, 'authorized')
    assert.equal(f.accounts.loginStatus(login.loginId).state, 'authorized')
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type') ?? '', /^text\/html(?:;|$)/i)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.match(html, /<html[\s>]/i); assert.match(html, /window\.close\s*\(/)
    assert.match(html, /手动.*关闭|关闭此.*窗口|close.*(?:tab|window)/i)
    for (const secret of [code, state, access, idToken, refresh]) assert.equal(html.includes(secret), false)
    const stored = Object.values(readGrant(await f.ctx.credentials.readRecord(ACCOUNTS_KEY)).accounts)
    assert.equal(stored.length, 1); assert.equal(stored[0]?.credential.refresh, refresh)
  } finally {
    releaseToken.resolve(); releaseWrite.resolve()
    if (callback) await Promise.allSettled([callback])
    restoreResponseEnd?.(); persistence.mock.restore(); await f.close()
  }
})

for (const failure of ['token exchange', 'credential persistence'] as const) test(`loopback callback reports ${failure} failure without success or automatic closing`, async () => {
  const privateDetails = 'fixture-private-login-failure', code = 'fixture-sensitive-rejected-code'
  const f = await fixture(async () => failure === 'token exchange'
    ? Response.json({ error: { message: privateDetails } }, { status: 503 })
    : Response.json({ access_token: jwt('rejected-browser'), refresh_token: 'fixture-rejected-refresh', expires_in: 3600 }))
  const persistence = failure === 'credential persistence' ? mock.method(f.ctx.credentials, 'modifyRecord', async () => { throw new Error(privateDetails) }) : undefined
  try {
    const login = await f.accounts.beginLogin(), state = new URL(login.authorizationUrl).searchParams.get('state')!
    const response = await fetch(`${login.redirectUri.replace('localhost', '127.0.0.1')}?code=${code}&state=${state}`), html = await response.text()
    assert.ok(response.status >= 400)
    assert.equal(f.accounts.loginStatus(login.loginId).state, 'failed')
    assert.doesNotMatch(html, /window\.close\s*\(|登录成功|授权成功|successfully|login succeeded/i)
    assert.match(html, /失败|重试|failed|retry/i)
    for (const secret of [privateDetails, code, state, 'fixture-rejected-refresh']) assert.equal(html.includes(secret), false)
    assert.equal(await f.ctx.credentials.readRecord(ACCOUNTS_KEY), undefined)
  } finally { persistence?.mock.restore(); await f.close() }
})

test('loopback callback rejects wrong state without poisoning the legitimate login and closes on cancellation', async () => {
  const f = await fixture(async () => Response.json({ access_token: jwt('callback'), refresh_token: 'fixture-refresh', expires_in: 3600 }))
  try {
    const login = await f.accounts.beginLogin(), url = new URL(login.authorizationUrl), callback = login.redirectUri.replace('localhost', '127.0.0.1')
    assert.equal((await fetch(`${callback}?code=bad&state=wrong`)).status, 400)
    assert.equal((await fetch(`${callback}?code=fixture-code&state=${url.searchParams.get('state')}`)).status, 200)
    assert.equal(f.accounts.loginStatus(login.loginId).state, 'authorized')
    const next = await f.accounts.beginLogin(); await f.accounts.cancelLogin(next.loginId)
    assert.equal(f.accounts.loginStatus(next.loginId).state, 'cancelled')
    await assert.rejects(fetch(next.redirectUri.replace('localhost', '127.0.0.1')))
  } finally { await f.close() }
})

test('callback port collision selects the next port and PKCE state cannot be replayed', async () => {
  const occupied = createServer(); await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve))
  const address = occupied.address(); assert.ok(address && typeof address !== 'string')
  const f = await fixture()
  try {
    const attempt = await createOAuthAttempt({ ...f.options, callbackPorts: [address.port, 0] })
    try {
      assert.notEqual(new URL(attempt.redirectUri).port, String(address.port))
      const callback = `${attempt.redirectUri}?code=fixture-code&state=${attempt.state}`
      attempt.accept(callback); assert.equal(await attempt.code, 'fixture-code')
      assert.throws(() => attempt.accept(callback), { code: 'LOGIN_ALREADY_COMPLETED' })
    } finally { attempt.close() }
  } finally { occupied.close(); await f.close() }
})

test('concurrent internal and external auth consumers rotate once, persist full identity and do not lose another account', async () => {
  let refreshes = 0
  const f = await fixture(async (_input, init) => {
    assert.equal(new URLSearchParams(String(init?.body)).get('grant_type'), 'refresh_token'); refreshes++
    await new Promise(resolve => setTimeout(resolve, 15))
    return Response.json({ access_token: jwt('a'), refresh_token: 'fixture-rotated', expires_in: 3600, id_token: jwt('a', { chatgpt_workspace_id: 'refreshed-workspace' }) })
  })
  try {
    await f.seed(['a', 'b'], true)
    const native = f.accounts.nativeFor(keyFor('a'))
    const values = await Promise.all([native.models.getAuth('openai-codex'), ...Array.from({ length: 5 }, () => f.accounts.withAccount({ kind: 'usage', accountKey: keyFor('a') }, async lease => lease.accessToken))])
    assert.equal(refreshes, 1); assert.equal(values.length, 6)
    const grant = readGrant(await f.ctx.credentials.readRecord(ACCOUNTS_KEY))
    assert.equal(Object.keys(grant.accounts).length, 2); assert.equal(grant.accounts[keyFor('a')]?.credential.refresh, 'fixture-rotated')
    assert.equal(grant.accounts[keyFor('a')]?.workspace, 'refreshed-workspace'); assert.equal(grant.accounts[keyFor('a')]?.revision, 2)
  } finally { await f.close() }
})

test('refresh token rotation still commits after its waiting consumer is cancelled', async () => {
  let started: () => void = () => {}, release: () => void = () => {}
  const began = new Promise<void>(resolve => { started = resolve }), blocked = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(async () => { started(); await blocked; return Response.json({ access_token: jwt('a'), refresh_token: 'saved-after-abort', expires_in: 3600 }) })
  try {
    await f.seed(['a'], true)
    const abort = new AbortController(), request = f.accounts.withAccount({ kind: 'usage', accountKey: keyFor('a'), signal: abort.signal }, async () => true)
    await began; abort.abort(new Error('fixture cancellation')); await assert.rejects(request, /fixture cancellation/)
    release()
    for (let n = 0; n < 30 && readGrant(await f.ctx.credentials.readRecord(ACCOUNTS_KEY)).accounts[keyFor('a')]?.credential.refresh !== 'saved-after-abort'; n++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(readGrant(await f.ctx.credentials.readRecord(ACCOUNTS_KEY)).accounts[keyFor('a')]?.credential.refresh, 'saved-after-abort')
  } finally { release(); await f.close() }
})

test('revision conflicts reject concurrent edits and 429 image cooldown does not block text-like work', async () => {
  const f = await fixture()
  try {
    await f.seed(['a', 'b'])
    const updates = await Promise.allSettled([f.accounts.update(keyFor('a'), { label: 'first', revision: 1 }), f.accounts.update(keyFor('a'), { enabled: false, revision: 1 })])
    assert.equal(updates.filter(value => value.status === 'fulfilled').length, 1)
    assert.equal(updates.filter(value => value.status === 'rejected' && value.reason.code === 'REVISION_CONFLICT').length, 1)
    await assert.rejects(f.accounts.withAccount({ kind: 'image', accountKey: keyFor('a') }, async () => { throw new AccountError('quota fixture', 'RATE_LIMIT', 429) }))
    await assert.rejects(f.accounts.withAccount({ kind: 'image', accountKey: keyFor('a') }, async () => true), { code: 'NO_AVAILABLE_ACCOUNT' })
    assert.equal(await f.accounts.withAccount({ kind: 'usage', accountKey: keyFor('a') }, async lease => lease.accountId), 'a')
  } finally { await f.close() }
})

test('dynamic models omit unknown capabilities and retain last-good catalog on later failure', async () => {
  let fail = false, clock = Date.now()
  const f = await fixture(async input => String(input).includes('/codex/models') ? fail ? new Response('', { status: 503 }) : Response.json({ models: [{ slug: 'gpt-6.1-sol' }, { slug: 'not-in-native-catalog' }] }) : Response.json({ plan_type: 'plus' }))
  f.options.now = () => clock
  try {
    await f.seed(['a']); assert.deepEqual((await f.accounts.models()).map(model => model.id), ['gpt-6.1-sol'])
    fail = true; clock += 100; await new Promise(resolve => setTimeout(resolve, 3))
    assert.deepEqual((await f.accounts.models()).map(model => model.id), ['gpt-6.1-sol'])
    const view = (await f.accounts.list())[0]; assert.equal(view?.modelsStatus, 'error')
    assert.ok(!JSON.stringify(view).includes('fixture-refresh')); assert.ok(!JSON.stringify(view).includes('.fixture'))
  } finally { await f.close() }
})

test('direct text requests discover models before scheduling and failed discovery never silently advertises static models', async () => {
  let calls = 0
  const f = await fixture(async input => { assert.match(String(input), /codex\/models/); calls++; return Response.json({ models: [{ slug: 'gpt-6.1-sol' }] }) })
  try {
    await f.seed(['a'])
    assert.equal(await f.accounts.withAccount({ kind: 'text', model: 'gpt-6.1-sol' }, async lease => lease.accountId), 'a')
    assert.equal(calls, 1)
  } finally { await f.close() }
  const unavailable = await fixture(async () => new Response('', { status: 503 }))
  try {
    await unavailable.seed(['a']); assert.deepEqual(await unavailable.accounts.models(), [])
    await assert.rejects(unavailable.accounts.withAccount({ kind: 'text', model: 'gpt-6.1-sol' }, async () => true), { code: 'NO_AVAILABLE_ACCOUNT' })
  } finally { await unavailable.close() }
})

test('quota exhaustion overrides priority while session affinity survives later load changes', async () => {
  let exhausted = true
  const f = await fixture(async (input, init) => String(input).includes('/codex/models')
    ? Response.json({ models: [{ slug: 'gpt-6.1-sol' }] }) : Response.json({ plan_type: 'plus', rate_limit: { primary_window: {
      used_percent: exhausted && new Headers(init?.headers).get('chatgpt-account-id') === 'a' ? 100 : 10, reset_at: Date.now() / 1000 + 300 } } }))
  try {
    await f.seed(['a', 'b']); await f.accounts.update(keyFor('a'), { priority: 10, allowCredits: false, revision: 1 }); await f.accounts.list()
    const choose = (sessionId: string) => f.accounts.withAccount({ kind: 'text', model: 'gpt-6.1-sol', sessionId }, async lease => lease.accountId)
    assert.equal(await choose('sticky'), 'b')
    exhausted = false; await new Promise(resolve => setTimeout(resolve, 3)); await f.accounts.list()
    assert.equal(await choose('sticky'), 'b'); assert.equal(await choose('new-session'), 'a')
  } finally { await f.close() }
})

test('plugin disposal cancels and drains a pending discovery fetch', async () => {
  let started: () => void = () => {}, networkSignal: AbortSignal | null | undefined
  const entered = new Promise<void>(resolve => { started = resolve })
  const f = await fixture(async (_input, init) => { networkSignal = init?.signal; started(); return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })) })
  try {
    await f.seed(['a']); const discovery = f.accounts.models(); await entered
    const rejected = assert.rejects(discovery, { code: 'CANCELLED' })
    await f.accounts.dispose(); await rejected
    assert.equal(networkSignal?.aborted, true)
    await assert.rejects(f.accounts.withAccount({ kind: 'image' }, async () => true), { code: 'CANCELLED' })
  } finally { await f.close() }
})

test('disposal waits for an already rotating token to be committed before it completes', async () => {
  let started: () => void = () => {}, release: () => void = () => {}
  const entered = new Promise<void>(resolve => { started = resolve }), blocked = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(async () => { started(); await blocked; return Response.json({ access_token: jwt('a'), refresh_token: 'disposed-persisted', expires_in: 3600 }) })
  try {
    await f.seed(['a'], true)
    const request = f.accounts.withAccount({ kind: 'usage', accountKey: keyFor('a') }, async () => true)
    await entered
    const cancelled = assert.rejects(request, { code: 'CANCELLED' })
    let disposed = false; const disposal = f.accounts.dispose().then(() => { disposed = true })
    await cancelled; assert.equal(disposed, false)
    release(); await disposal
    assert.equal(readGrant(await f.ctx.credentials.readRecord(ACCOUNTS_KEY)).accounts[keyFor('a')]?.credential.refresh, 'disposed-persisted')
  } finally { release(); await f.close() }
})

test('bounded JSON cancels oversized declared and chunked bodies before retaining unbounded data', async () => {
  let declaredCancelled = false, streamedCancelled = false
  const declared = new Response(new ReadableStream<Uint8Array>({ cancel() { declaredCancelled = true } }), { headers: { 'content-length': '1000000' } })
  await assert.rejects(readBoundedJson(declared, 16), { code: 'RESPONSE_TOO_LARGE' }); assert.equal(declaredCancelled, true)
  const chunked = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(10)); controller.enqueue(new Uint8Array(10)) }, cancel() { streamedCancelled = true } }))
  await assert.rejects(readBoundedJson(chunked, 16), { code: 'RESPONSE_TOO_LARGE' }); assert.equal(streamedCancelled, true)
})

for (const window of ['primary_window', 'secondary_window'] as const) test(`text scheduling refreshes ${window} quota without requiring an account-management reader`, async () => {
  const f = await fixture(async (input, init) => {
    if (String(input).includes('/codex/models')) return Response.json({ models: [{ slug: 'gpt-6.1-sol' }] })
    const account = new Headers(init?.headers).get('chatgpt-account-id')
    return Response.json({ rate_limit: { [window]: { used_percent: account === 'a' ? 100 : 5, reset_at: 2000000000 } } })
  })
  try {
    await f.seed(['a', 'b'])
    await f.accounts.update(keyFor('a'), { revision: 1, priority: 100, allowCredits: false })
    const selected = await f.accounts.withAccount({ kind: 'text', model: 'gpt-6.1-sol' }, async lease => lease.accountId)
    assert.equal(selected, 'b')
  } finally { await f.close() }
})

test('image scheduling delegates plan entitlement to the upstream instead of guessing from its name', async () => {
  const f = await fixture()
  try {
    await f.seed(['a'])
    await f.ctx.credentials.modifyRecord(ACCOUNTS_KEY, async current => {
      const grant = readGrant(current)
      grant.accounts[keyFor('a')]!.plan = 'free'
      return { kind: 'grant', payload: grant }
    })
    assert.equal(await f.accounts.withAccount({ kind: 'image' }, async lease => lease.accountId), 'a')
  } finally { await f.close() }
})

for (const status of [402, 429] as const) test(`explicit pre-output ${status} refusal advances once per eligible account and ordinary errors never replay`, async () => {
  const f = await fixture()
  try {
    await f.seed(['a', 'b'])
    const seen: string[] = []
    const result = await f.accounts.withAccount({ kind: 'image' }, async lease => {
      seen.push(lease.accountId)
      if (lease.accountId === 'a') throw new AccountRejected(status)
      return lease.accountId
    })
    assert.equal(result, 'b'); assert.deepEqual(seen, ['a', 'b'])
    assert.ok((await f.accounts.list()).find(account => account.accountId === 'a')?.cooldowns.image)
    let attempts = 0
    await assert.rejects(f.accounts.withAccount({ kind: 'image' }, async () => { attempts++; throw new Error('unknown network outcome') }), /unknown network outcome/)
    assert.equal(attempts, 1)
    await assert.rejects(f.accounts.withAccount({ kind: 'image', accountKey: keyFor('b') }, async () => { throw new AccountRejected(403) }), { status: 403 })
  } finally { await f.close() }
})

test('Windows callback permission failures retain the manual PKCE completion path', async () => {
  const f = await fixture()
  const listen = mock.method(Server.prototype, 'listen', function (this: Server) {
    queueMicrotask(() => this.emit('error', Object.assign(new Error('fixture reserved port'), { code: 'EACCES' })))
    return this
  })
  try {
    const attempt = await createOAuthAttempt({ ...f.options, callbackPorts: [1455, 1457] })
    try {
      assert.equal(attempt.redirectUri, 'http://localhost:1455/auth/callback')
      attempt.accept(`${attempt.redirectUri}?code=manual-fixture&state=${attempt.state}`)
      assert.equal(await attempt.code, 'manual-fixture')
    } finally { attempt.close() }
  } finally { listen.mock.restore(); await f.close() }
})

test('upstream 401 renews a not-yet-expired token once without replaying the failed operation', async () => {
  let refreshed = 0
  const fresh = jwt('a', { generation: 'fresh' })
  const f = await fixture(async () => { refreshed++; return Response.json({ access_token: fresh, refresh_token: 'renewed-refresh', expires_in: 3600 }) })
  try {
    await f.seed(['a'])
    let dispatched = 0
    await assert.rejects(f.accounts.withAccount({ kind: 'usage', accountKey: keyFor('a') }, async () => { dispatched++; throw new AccountError('HTTP 401', 'AUTH', 401) }), { status: 401 })
    assert.equal(dispatched, 1)
    assert.equal(refreshed, 1)
    assert.equal(await f.accounts.withAccount({ kind: 'usage', accountKey: keyFor('a') }, async lease => lease.accessToken), fresh)
    assert.equal(readGrant(await f.ctx.credentials.readRecord(ACCOUNTS_KEY)).accounts[keyFor('a')]?.credential.refresh, 'renewed-refresh')
  } finally { await f.close() }
})

test('credit policy permits the upstream to serve exhausted windows until spending is explicitly disabled', async () => {
  const f = await fixture(async input => String(input).includes('/codex/models') ? Response.json({ models: [{ slug: 'gpt-6.1-sol' }] })
    : Response.json({ rate_limit: { primary_window: { used_percent: 100, reset_at: 2000000000 } } }))
  try {
    await f.seed(['a'])
    assert.equal(await f.accounts.withAccount({ kind: 'text', model: 'gpt-6.1-sol' }, async lease => lease.accountId), 'a')
    const current = (await f.accounts.list())[0]!
    const updated = await f.accounts.update(current.accountKey, { revision: current.revision, allowCredits: false })
    assert.equal(updated.allowCredits, false)
    await assert.rejects(f.accounts.withAccount({ kind: 'text', model: 'gpt-6.1-sol' }, async () => true), { code: 'NO_AVAILABLE_ACCOUNT' })
  } finally { await f.close() }
})

test('server visibility and priority determine the advertised known-model directory', async () => {
  let models: object[] = []
  const f = await fixture(async () => Response.json({ models }))
  try {
    await f.seed(['a'])
    const known = f.accounts.nativeFor(keyFor('a')).provider.getModels().slice(0, 3)
    assert.equal(known.length, 3)
    models = known.map((model, index) => ({ slug: model.id, priority: 3 - index, visibility: index === 0 ? 'hide' : 'list' }))
    assert.deepEqual((await f.accounts.models()).map(model => model.id), [known[2]!.id, known[1]!.id])
  } finally { await f.close() }
})

test('an older in-flight quota poll cannot overwrite a live response update', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const f = await fixture(async () => { entered.resolve(); await release.promise; return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } }) })
  try {
    await f.seed(['a'])
    const polling = f.accounts.list()
    await entered.promise
    await f.accounts.withAccount({ kind: 'image' }, async lease => {
      lease.observeResponse?.(Response.json({}, { headers: { 'x-codex-primary-used-percent': '100', 'x-codex-primary-window-minutes': '300' } }))
    })
    release.resolve()
    assert.equal((await polling)[0]?.usage?.primary?.usedPercent, 100)
  } finally { release.resolve(); await f.close() }
})

test('OAuth refresh accepts JWT expiration when the server omits expires_in', async () => {
  const expires = Math.floor(Date.now() / 1000) + 3600
  const access = `e30.${Buffer.from(JSON.stringify({ exp: expires, 'https://api.openai.com/auth': { chatgpt_account_id: 'a' } })).toString('base64url')}.fixture`
  const f = await fixture(async () => Response.json({ access_token: access, refresh_token: 'rotated-fixture' }))
  try {
    const result = await exchangeTokens(f.options, { grant_type: 'refresh_token', refresh_token: 'previous-fixture' }, new AbortController().signal)
    assert.equal(result.expires, expires * 1000)
    assert.equal(result.refresh, 'rotated-fixture')
  } finally { await f.close() }
})
