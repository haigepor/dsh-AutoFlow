/** Subscription management keeps credentials on the Host and synchronizes after committed authorization. */
import { afterEach, expect, it, vi } from 'vitest'
import { SubscriptionController } from '../src/client/subscription-controller.ts'
import { SubscriptionFailure, subscriptionAccounts, subscriptionLogin } from '../src/client/subscription-api.ts'
import type { SubscriptionOperations } from '../src/client/subscription-api.ts'

const account = () => ({ accountKey: 'account-fixture', accountId: 'workspace-fixture', label: 'Fixture account', email: 'owner@example.test', plan: 'plus',
  enabled: true, allowCredits: false, priority: 0, revision: 1, tokenExpiresAt: 2000000000000, auth: { state: 'ready' }, modelsStatus: 'ready',
  usage: { status: 'ready', freshness: 'fresh', fetchedAt: 1800000000000, primary: { usedPercent: 20, resetAt: 2000000000000 } } })
const login = (state = 'waiting') => ({ loginId: 'login-fixture', state, authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=fixture', expiresAt: Date.now() + 60000 })
const owners: SubscriptionController[] = []
afterEach(async () => { for (const owner of owners.splice(0)) await owner.dispose(); vi.useRealTimers() })

function fixture() {
  let connected = false, availability: 'active' | 'disabled' = 'active', nextFailure: string | undefined
  let pollGate: Promise<unknown> | undefined
  const calls: { operation: string; args: Record<string, unknown> }[] = []
  const changed = vi.fn(async () => {})
  const operations: SubscriptionOperations = {
    availability: async () => availability, activate: async () => { availability = 'active'; return 'active' },
    invoke: async (operation, args) => {
      calls.push({ operation, args })
      if (nextFailure !== undefined) { const code = nextFailure; nextFailure = undefined; throw new SubscriptionFailure(code) }
      if (operation === 'account-list') return connected ? [account()] : []
      if (operation === 'model-list') return connected ? [{ id: 'gpt-fixture', name: 'GPT fixture' }] : []
      if (operation === 'login-start') return login()
      if (operation === 'login-status') { if (pollGate !== undefined) return pollGate; connected = true; return login('authorized') }
      if (operation === 'login-complete') { connected = true; return login('authorized') }
      if (operation === 'login-cancel') return { cancelled: true }
      if (operation === 'account-update') return account()
      if (operation === 'account-remove') { connected = false; return { removed: true } }
      if (operation === 'account-refresh') return account()
      throw new Error('Unexpected operation')
    },
  }
  const owner = new SubscriptionController(changed); owner.connect(operations); owners.push(owner)
  return { owner, calls, changed, fail: (code: string) => { nextFailure = code }, disable: () => { availability = 'disabled' }, gatePoll: (gate: Promise<unknown>) => { pollGate = gate } }
}

it('validates account and login JSON while projecting away all credential values', () => {
  const raw = { ...account(), credential: { access: 'private-access', refresh: 'private-refresh' }, credentialTag: 'private-tag' }
  expect(JSON.stringify(subscriptionAccounts([raw]))).not.toMatch(/private-|credential/)
  expect(subscriptionAccounts([raw])[0]).toMatchObject({ email: 'owner@example.test', allowCredits: false, usage: { primary: { usedPercent: 20 } } })
  expect(() => subscriptionAccounts([{ ...raw, revision: 'bad' }])).toThrow(SubscriptionFailure)
  expect(() => subscriptionLogin({ ...login(), authorizationUrl: 'javascript:alert(1)' })).toThrow(SubscriptionFailure)
  expect(() => subscriptionLogin({ ...login(), authorizationUrl: 'https://evil.test/oauth/authorize' })).toThrow(SubscriptionFailure)
})

it('model configuration is explicit, revision checked and keeps image defaults unchanged unless selected', async () => {
  const changed = vi.fn(async () => {}), calls: { operation: string; args: Record<string, unknown> }[] = []
  let revision = 3, entries: { kind: 'text' | 'image'; id: string; name: string }[] = []
  const catalog = () => ({ revision, entries, defaultImageModel: 'existing-image', candidates: [{ id: 'gpt-fixture', name: 'GPT' }] })
  const owner = new SubscriptionController(changed); owners.push(owner)
  owner.connect({ availability: async () => 'active', activate: async () => 'active', invoke: async (operation, args) => {
    calls.push({ operation, args })
    if (operation === 'account-list') return [account()]
    if (operation === 'model-list') return [{ id: 'gpt-fixture', name: 'GPT' }]
    if (operation === 'model-catalog') return catalog()
    if (operation === 'model-catalog-save') {
      expect(args['revision']).toBe(revision); revision++
      entries = [{ kind: 'text', id: 'gpt-fixture', name: 'My GPT' }, { kind: 'image', id: 'image-fixture', name: 'Images' }]
      return catalog()
    }
    throw new Error('Unexpected operation')
  } })
  await owner.ensure()
  expect(calls.some(call => call.operation === 'model-catalog-save')).toBe(false)
  await owner.loadCatalog()
  expect(await owner.saveCatalog([{ kind: 'text', id: 'gpt-fixture', name: 'My GPT' }, { kind: 'image', id: 'image-fixture', name: 'Images' }])).toBe(true)
  expect(calls.find(call => call.operation === 'model-catalog-save')?.args).not.toHaveProperty('defaultImageModel')
  expect(owner.store.getSnapshot().catalog).toMatchObject({ revision: 4, entries: [{ kind: 'text' }, { kind: 'image' }], defaultImageModel: 'existing-image' })
  expect(changed).toHaveBeenCalledOnce()
})

it('polls one login and refreshes accounts plus both model directories before announcing success', async () => {
  vi.useFakeTimers()
  const f = fixture(); await f.owner.ensure()
  expect(f.owner.store.getSnapshot().accounts).toHaveLength(0)
  await f.owner.startLogin(); await vi.advanceTimersByTimeAsync(1000)
  expect(f.owner.store.getSnapshot()).toMatchObject({ login: null, accounts: [{ email: 'owner@example.test' }], models: [{ id: 'gpt-fixture' }], notice: { code: 'CONNECTED', success: true } })
  expect(f.changed).toHaveBeenCalledOnce()
  expect(f.calls.map(call => call.operation)).toEqual(['account-list', 'model-list', 'login-start', 'login-status', 'account-list', 'model-list'])
  await vi.advanceTimersByTimeAsync(10000)
  expect(f.calls.filter(call => call.operation === 'login-status')).toHaveLength(1)
})

it('manual completion never stores the callback and revision-checked changes reload both directories', async () => {
  const f = fixture(); await f.owner.ensure(); await f.owner.startLogin()
  expect(await f.owner.completeLogin('http://localhost:1455/auth/callback?code=private-code&state=fixture')).toBe(true)
  const row = f.owner.store.getSnapshot().accounts[0]!
  expect(JSON.stringify(f.owner.store.getSnapshot())).not.toContain('private-code')
  await f.owner.update(row, { allowCredits: true })
  expect(f.calls.find(call => call.operation === 'account-update')?.args).toEqual({ accountKey: row.accountKey, revision: 1, allowCredits: true })
  await f.owner.refresh(); await f.owner.remove(row)
  expect(f.changed).toHaveBeenCalledTimes(4)
  expect(f.owner.store.getSnapshot().accounts).toHaveLength(0)
})

it('a cancelled login ignores an older pending poll and disposal stops future polling', async () => {
  vi.useFakeTimers()
  const f = fixture(), gate = Promise.withResolvers<unknown>()
  await f.owner.ensure(); f.gatePoll(gate.promise); await f.owner.startLogin()
  await vi.advanceTimersByTimeAsync(1000); await f.owner.cancelLogin()
  gate.resolve(login('authorized')); await vi.advanceTimersByTimeAsync(1)
  expect(f.owner.store.getSnapshot().login).toBeNull(); expect(f.changed).not.toHaveBeenCalled()
  await f.owner.dispose(); await vi.advanceTimersByTimeAsync(10000)
  expect(f.calls.filter(call => call.operation === 'login-status')).toHaveLength(1)
})

it('activation is explicit and a failed read preserves the last good rows', async () => {
  const f = fixture(); f.disable(); await f.owner.ensure()
  expect(f.owner.store.getSnapshot().availability).toBe('disabled'); expect(f.calls).toHaveLength(0)
  expect(await f.owner.activate()).toBe(true)
  await f.owner.startLogin(); await f.owner.completeLogin('http://localhost:1455/auth/callback?code=fixture&state=fixture')
  const before = f.owner.store.getSnapshot().accounts
  f.fail('UNAVAILABLE'); await f.owner.ensure()
  expect(f.owner.store.getSnapshot().status).toBe('error'); expect(f.owner.store.getSnapshot().accounts).toEqual(before)
  f.fail('REVISION_CONFLICT'); expect(await f.owner.update(before[0]!, { label: 'New name' })).toBe(false)
  expect(f.owner.store.getSnapshot().notice).toMatchObject({ code: 'REVISION_CONFLICT', success: false })
})

it('a committed login with failed directory synchronization reports the remaining action', async () => {
  const owner = new SubscriptionController(async () => { throw new Error('private transport failure') }); owners.push(owner)
  const connected: SubscriptionOperations = { availability: async () => 'active', activate: async () => 'active', invoke: async operation =>
    operation === 'login-start' ? login() : operation === 'login-complete' ? login('authorized') : operation === 'model-list' ? [] : [account()] }
  owner.connect(connected); await owner.startLogin(); await owner.completeLogin('http://localhost:1455/auth/callback?code=fixture&state=fixture')
  expect(owner.store.getSnapshot()).toMatchObject({ login: null, error: 'DIRECTORY_REFRESH_FAILED', notice: { code: 'DIRECTORY_REFRESH_FAILED', success: false } })
  expect(JSON.stringify(owner.store.getSnapshot())).not.toContain('private transport')
})
