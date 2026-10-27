/** Website sign-in keeps session secrets on the Host and drains owned windows. */
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { readFile } from 'node:fs/promises'
import { GalleryLogins, type GalleryLoginBrowser } from '../src/host/gallery-login.ts'
import { resolveConfig } from '../src/host/config.ts'
import { MediaError } from '../src/media/errors.ts'
import { serviceFixture } from './helpers/service-fixture.ts'
import { configRevision } from '../src/host/config.ts'
import { UnsplashApi } from '../src/media/unsplash.ts'
import { connectGalleryLogin, withGalleryAccount } from '../src/client/gallery-login.ts'
import { z } from 'zod'
import { chromium } from 'playwright-core'
import { launchGalleryLogin } from '../src/host/gallery-login-browser.ts'
import { CurlRequestError } from '../src/media/unsplash-transport.ts'

test('login capture starts at navigation commit and ignores anonymous website cookies', async () => {
  const lifetime = new AbortController(), settings = config()
  let closed = 0
  let authenticated = false
  let capturedOptions: { userAgent?: string } | undefined
  let waitUntil: string | undefined
  const launch = mock.method(chromium, 'launchPersistentContext', async (_directory: string, options: { userAgent?: string }) => {
    capturedOptions = options
    return {
      once() {},
      pages: () => [{ goto: async (_url: string, options: { waitUntil: string }) => { waitUntil = options.waitUntil } }],
      cookies: async () => [{ name: 'uuid', value: 'anonymous', domain: 'unsplash.com' }, ...(authenticated ? [{ name: 'un_sesh', value: 'host-only-fixture', domain: 'unsplash.com' }] : [])],
      close: async () => { closed++ },
    }
  })
  try {
    const browser = await launchGalleryLogin(settings, lifetime.signal)
    assert.equal(capturedOptions?.userAgent, settings.source.unsplash.userAgent)
    assert.equal(waitUntil, 'commit')
    assert.equal(await browser.cookie(), '')
    authenticated = true
    assert.match(await browser.cookie(), /un_sesh=host-only-fixture/)
    await browser.close()
    assert.equal(closed, 1)
  } finally { launch.mock.restore() }
})

const owner = 'profile-owner'
const config = () => resolveConfig({ source: { unsplash: { login: { timeoutMs: 5000, pollIntervalMs: 1, retryDelayMs: 1 } } } })
const identity = { userId: 'person-a', username: 'person_a', name: 'Person A', totalCollections: 1 }
const fixture = (options: { me?: () => Promise<typeof identity>; opening?: Promise<void> } = {}) => {
  const closed = new AbortController(), lifetime = new AbortController(), stored: string[] = []
  let closeCount = 0
  const browser: GalleryLoginBrowser = { closed: closed.signal, cookie: async () => '_unsplash_session=private-fixture', close: async () => { closeCount++; closed.abort() } }
  const settings = config()
  const logins = new GalleryLogins(settings, lifetime.signal, async signal => { await options.opening; signal.throwIfAborted(); return browser }, options.me ?? (async () => identity), async (_ref, value) => { stored.push(value) })
  return { logins, stored, closed, settings, lifetime, get closeCount() { return closeCount } }
}
const settled = async (f: ReturnType<typeof fixture>, id: string) => {
  for (let count = 0; count < 100; count++) { const view = f.logins.status(id, owner); if (['ready', 'failed', 'cancelled'].includes(view.state)) return view; await setImmediate() }
  assert.fail('Sign-in did not settle')
}
const waitForLogin = async (f: ReturnType<typeof fixture>, id: string, state: string) => {
  for (;;) {
    const view = f.logins.status(id, owner)
    if (view.state === state || view.state === 'failed' || view.state === 'cancelled') return view
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

test('Client publishes changed login progress instead of re-rendering unchanged polling replies', async () => {
  const states = ['waiting', 'waiting', 'validating', 'validating', 'ready'] as const
  const notices: string[] = []
  let next = 0
  const account = { id: 'test-account', credentialRef: 'TEST_COOKIE', label: 'Test', ...identity }
  await connectGalleryLogin(async operation => operation === 'gallery-login-start' ? { id: 'test-flow', state: 'opening' } : operation === 'gallery-login-status' ? { id: 'test-flow', state: states[next++] } : account,
    { revision: 'test', operationId: 'progress' }, { pollIntervalMs: 1, requestTimeoutMs: 1000, signal: new AbortController().signal, onStatus: view => notices.push(view.state) })
  assert.deepEqual({ progress: notices, unchangedReplies: next - (notices.length - 1) }, JSON.parse(await readFile(new URL('./fixtures/gallery-login-progress.expected.json', import.meta.url), 'utf8')))
})

test('website access checks remain visible until account validation succeeds', { timeout: 5000 }, async () => {
  let attempts = 0
  let complete: ((value: typeof identity) => void) | undefined
  let reachedSecond!: () => void
  const secondAttempt = new Promise<void>(resolve => { reachedSecond = resolve })
  const f = fixture({ me: async () => {
    if (++attempts === 1) throw new MediaError('source-access-check', 'gallery', false, 'Access check', 'Retry')
    return new Promise(resolve => { complete = resolve; reachedSecond() })
  } })
  const view = f.logins.start({ operationId: 'access-check' }, owner)
  try {
    await secondAttempt
    assert.equal(f.logins.status(view.id, owner).errorCode, 'source-access-check')
    assert.equal(f.logins.status(view.id, owner).state, 'validating')
    complete!(identity)
    const ready = await settled(f, view.id)
    assert.equal(ready.state, 'ready')
    assert.equal(ready.errorCode, undefined)
  } finally { complete?.(identity); await f.logins.dispose() }
})

test('temporary validation failures retry in the same login window before credentials can be saved', { timeout: 10000 }, async () => {
  let attempts = 0
  const f = fixture({ me: async () => {
    if (++attempts === 1) throw new MediaError('source-network-failed', 'gallery', true, 'Temporary network failure', 'Retry')
    return identity
  } })
  Object.assign(f.settings.source.unsplash.login, { validationTimeoutMs: 1000, maxValidationAttempts: 3, retryDelayMs: 1 })
  const view = f.logins.start({ operationId: 'transient-network' }, owner)
  try {
    let current = f.logins.status(view.id, owner)
    while (!['ready', 'failed', 'cancelled'].includes(current.state)) {
      await new Promise(resolve => setTimeout(resolve, 1))
      current = f.logins.status(view.id, owner)
    }
    assert.equal(current.state, 'ready')
    assert.equal(attempts, 2)
    assert.equal(f.closeCount, 1)
    assert.deepEqual(f.stored, [])
    await f.logins.finish(view.id, owner)
    assert.equal(f.stored.length, 1)
  } finally { await f.logins.dispose() }
})

test('exhausted retries pause without losing the window and an owned manual retry saves the verified session', { timeout: 10000 }, async () => {
  let recovered = false, attempts = 0
  const f = fixture({ me: async () => {
    attempts++
    if (!recovered) throw new CurlRequestError(56)
    return identity
  } })
  f.settings.source.unsplash.login.maxValidationAttempts = 2
  const view = f.logins.start({ operationId: 'pause-and-retry' }, owner)
  try {
    const paused = await waitForLogin(f, view.id, 'retry-paused')
    assert.equal(paused.state, 'retry-paused')
    assert.equal(attempts, 2)
    assert.equal(paused.validation?.curlExitCode, 56)
    assert.deepEqual(f.stored, [])
    assert.equal(f.closeCount, 0)
    await assert.rejects(f.logins.finish(view.id, owner), { code: 'source-network-failed' })
    assert.throws(() => f.logins.retry(view.id, 'other-owner'), { code: 'owner-denied' })
    recovered = true
    const resumed = f.logins.retry(view.id, owner)
    f.logins.retry(view.id, owner)
    assert.equal((await waitForLogin(f, view.id, 'ready')).state, 'ready')
    await f.logins.finish(view.id, owner)
    const summary = { paused: paused.state, pausedAttempt: paused.validation?.attempt, curlExitCode: paused.validation?.curlExitCode, resumed: resumed.state, final: f.logins.status(view.id, owner).state, attempts, credentialWrites: f.stored.length, closedWindows: f.closeCount }
    assert.deepEqual(summary, JSON.parse(await readFile(new URL('./fixtures/gallery-login-retry.expected.json', import.meta.url), 'utf8')))
  } finally { await f.logins.dispose() }
})

test('per-verification deadline retries without consuming the entire login lifetime', { timeout: 10000 }, async () => {
  let attempts = 0, aborted = false
  const f = fixture()
  f.settings.source.unsplash.login.validationTimeoutMs = 10
  const logins = new GalleryLogins(f.settings, f.lifetime.signal, async () => ({ closed: f.closed.signal, cookie: async () => 'un_sesh=deadline-fixture', close: async () => {} }), async (_cookie, signal) => {
    if (++attempts > 1) return identity
    return await new Promise((_, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(signal.reason) }, { once: true }) })
  }, async () => {})
  const view = logins.start({ operationId: 'verification-deadline' }, owner)
  try {
    const current = await waitForLogin({ ...f, logins }, view.id, 'ready')
    assert.equal(current.state, 'ready')
    assert.equal(attempts, 2)
    assert.equal(aborted, true)
  } finally { await logins.dispose(); await f.logins.dispose() }
})

test('cancel drains a paused verification and never restarts it or writes credentials', { timeout: 10000 }, async () => {
  const f = fixture({ me: async () => { throw new CurlRequestError(7) } })
  f.settings.source.unsplash.login.maxValidationAttempts = 1
  const view = f.logins.start({ operationId: 'cancel-paused' }, owner)
  try {
    assert.equal((await waitForLogin(f, view.id, 'retry-paused')).state, 'retry-paused')
    assert.equal((await f.logins.cancel(view.id, owner)).state, 'cancelled')
    assert.equal(f.logins.retry(view.id, owner).state, 'cancelled')
    assert.deepEqual(f.stored, [])
    assert.equal(f.closeCount, 1)
  } finally { await f.logins.dispose() }
})

test('certificate failures stop verification instead of retrying an untrusted connection', async () => {
  let attempts = 0
  const f = fixture({ me: async () => { attempts++; throw new CurlRequestError(60) } })
  const view = f.logins.start({ operationId: 'invalid-certificate' }, owner)
  try {
    assert.equal((await settled(f, view.id)).errorCode, 'source-tls-failed')
    assert.equal(attempts, 1)
    assert.deepEqual(f.stored, [])
    assert.equal(f.closeCount, 1)
  } finally { await f.logins.dispose() }
})

test('captured website session is validated and stored without exposing it in status or finish data', async () => {
  const f = fixture(), view = f.logins.start({ operationId: 'start-one' }, owner)
  assert.equal(f.logins.start({ operationId: 'start-one' }, owner).id, view.id)
  assert.equal((await settled(f, view.id)).state, 'ready')
  assert.equal(f.closeCount, 1)
  assert.equal(f.stored.length, 0)
  const account = await f.logins.finish(view.id, owner)
  assert.equal(account.username, identity.username)
  assert.equal(f.stored.length, 1)
  assert.deepEqual(await f.logins.finish(view.id, owner), account)
  assert.equal(f.stored.length, 1)
  assert.equal(JSON.stringify({ view: f.logins.status(view.id, owner), account }).includes('private-fixture'), false)
  assert.deepEqual({ state: f.logins.status(view.id, owner).state, username: account.username, label: account.label, sessionVisible: JSON.stringify(f.logins.status(view.id, owner)).includes('private-fixture'), closedWindows: f.closeCount, credentialWrites: f.stored.length }, JSON.parse(await readFile(new URL('./fixtures/gallery-login.expected.json', import.meta.url), 'utf8')))
  await f.logins.dispose()
})

test('adding the same verified account reuses its identity, credential reference and custom label', async () => {
  const f = fixture()
  f.settings.source.unsplash.accounts = [{ id: 'existing-account' as typeof f.settings.source.unsplash.accounts[number]['id'], credentialRef: 'EXISTING_SESSION', label: 'My collection', ...identity }]
  try {
    const view = f.logins.start({ operationId: 'reuse-existing' }, owner)
    const ready = await settled(f, view.id)
    assert.equal(ready.state, 'ready')
    const account = await f.logins.finish(view.id, owner)
    assert.equal(account.id, 'existing-account')
    assert.equal(account.credentialRef, 'EXISTING_SESSION')
    assert.equal(account.label, 'My collection')
    assert.equal(f.settings.source.unsplash.accounts.length, 1)
    assert.equal(f.stored.length, 1)
  } finally { await f.logins.dispose() }
})

test('refreshed accounts remain unique and retain an explicit public-search default', () => {
  const source = resolveConfig({ source: { provider: 'unsplash', unsplash: { accounts: [{ id: 'saved-account', credentialRef: 'SAVED_SESSION', label: 'Custom label', userId: identity.userId, username: identity.username, name: identity.name }], defaultAccountId: null } } }).source
  const account = source.unsplash.accounts[0]!
  const updated = withGalleryAccount(source, { ...account, name: 'Refreshed display name' })
  assert.equal(updated.unsplash.accounts.length, 1)
  assert.equal(updated.unsplash.accounts[0]?.credentialRef, 'SAVED_SESSION')
  assert.equal(updated.unsplash.accounts[0]?.label, 'Custom label')
  assert.equal(updated.unsplash.defaultAccountId, null)
  assert.equal(source.unsplash.accounts[0]?.name, identity.name)
  const another = resolveConfig({ source: { unsplash: { accounts: [{ id: 'other-account', credentialRef: 'OTHER_SESSION', label: 'Other', userId: 'other-user', username: 'other_user', name: 'Other' }] } } }).source.unsplash.accounts[0]!
  const multiple = { ...source, unsplash: { ...source.unsplash, accounts: [account, another] } }
  assert.deepEqual(withGalleryAccount(multiple, { ...account, name: 'Updated' }).unsplash.accounts.map(item => item.id), [account.id, another.id])
  assert.equal(withGalleryAccount(config().source, account).unsplash.defaultAccountId, account.id)
})

test('cancelled sign-in cannot store a session after an in-flight identity request returns', async () => {
  let complete!: (value: typeof identity) => void
  const f = fixture({ me: () => new Promise(resolve => { complete = resolve }) }), view = f.logins.start({ operationId: 'cancel-inflight' }, owner)
  while (!complete) await setImmediate()
  const closing = f.logins.cancel(view.id, owner)
  complete(identity)
  await closing
  assert.equal(f.logins.status(view.id, owner).state, 'cancelled')
  await assert.rejects(f.logins.finish(view.id, owner))
  assert.deepEqual(f.stored, [])
  assert.equal(f.closeCount, 1)
  await f.logins.dispose()
})

test('session owner, duplicate accounts and reconnect identity are enforced before credential writes', async () => {
  const f = fixture()
  f.settings.source.unsplash.accounts = [{ id: 'saved-account' as typeof f.settings.source.unsplash.accounts[number]['id'], credentialRef: 'SAVED_COOKIE', label: 'Saved', ...identity, userId: 'different-person' }]
  const view = f.logins.start({ operationId: 'reconnect', accountId: 'saved-account' }, owner)
  assert.throws(() => f.logins.status(view.id, 'different-session'), { code: 'owner-denied' })
  assert.equal((await settled(f, view.id)).errorCode, 'gallery-login-account-mismatch')
  await assert.rejects(f.logins.finish(view.id, owner))
  assert.deepEqual(f.stored, [])
  await f.logins.dispose()
})

test('closing the website window cancels polling and disposal waits for acquired browser cleanup', async () => {
  const f = fixture({ me: async () => { throw new MediaError('source-auth-required', 'gallery', false, 'Sign in', 'Sign in') } }), view = f.logins.start({ operationId: 'closed' }, owner)
  while (f.logins.status(view.id, owner).state === 'opening') await setImmediate()
  f.closed.abort()
  assert.equal((await settled(f, view.id)).state, 'cancelled')
  assert.equal(f.logins.status(view.id, owner).errorCode, 'gallery-login-window-closed')
  await f.logins.dispose()
  assert.equal(f.closeCount, 1)
})

test('existing accounts are not duplicated by a new sign-in and failed credential writes can be retried', async () => {
  const f = fixture()
  f.settings.source.unsplash.accounts = [{ id: 'already-connected' as typeof f.settings.source.unsplash.accounts[number]['id'], credentialRef: 'EXISTING', label: 'Existing', ...identity }]
  const view = f.logins.start({ operationId: 'duplicate' }, owner)
  const reused = await settled(f, view.id)
  assert.equal(reused.state, 'ready')
  assert.equal(reused.account?.id, 'already-connected')
  assert.deepEqual(f.stored, [])
  await f.logins.dispose()
  let writes = 0
  const controller = new AbortController()
  const retry = new GalleryLogins(config(), controller.signal, async () => ({ closed: new AbortController().signal, cookie: async () => 'session=fixture', close: async () => {} }), async () => identity, async () => { if (++writes === 1) throw new Error('Private provider failure') })
  const signIn = retry.start({ operationId: 'retry-write' }, owner)
  while (retry.status(signIn.id, owner).state !== 'ready') await setImmediate()
  await assert.rejects(retry.finish(signIn.id, owner), { code: 'gallery-login-save-failed' })
  assert.equal((await retry.finish(signIn.id, owner)).username, identity.username)
  assert.equal(writes, 2)
  await retry.dispose()
})

test('sign-in timeout is distinct from window closure and never commits an anonymous session', async () => {
  const f = fixture({ me: async () => { throw new MediaError('source-auth-required', 'gallery', false, 'Sign in', 'Sign in') } })
  f.settings.source.unsplash.login.timeoutMs = 20
  const view = f.logins.start({ operationId: 'timeout' }, owner)
  while (!['failed', 'cancelled'].includes(f.logins.status(view.id, owner).state)) await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(f.logins.status(view.id, owner).errorCode, 'gallery-login-timeout')
  assert.equal(f.logins.status(view.id, owner).state, 'failed')
  assert.equal(f.closeCount, 1)
  assert.deepEqual(f.stored, [])
  await f.logins.dispose()
})

test('workbench website login uses the authenticated Host route and returns only safe account metadata', async () => {
  const closed = new AbortController(), writes: string[] = []
  const f = await serviceFixture(undefined, {}, {
    launchGalleryLogin: async () => ({ closed: closed.signal, cookie: async () => 'session=host-only-fixture', close: async () => { closed.abort() } }),
    galleryApi: async () => new UnsplashApi({ request: async () => ({ id: identity.userId, username: identity.username, name: identity.name, total_collections: 1 }) }),
  })
  f.host.credentials.set = async (_ref, value) => { writes.push(value) }
  await f.service.initialize()
  const history: string[] = []
  try {
    const read = async (operation: string, args: Record<string, import('../src/shared/model.ts').Json>) => {
      const response = await f.service.gallery(new Request('https://owner.example/api/visual-curator/gallery', { method: 'POST', body: JSON.stringify({ operation, args }) }))
      const result = z.object({ ok: z.literal(true), value: z.unknown() }).parse(await response.json())
      assert.equal(JSON.stringify(result).includes('host-only-fixture'), false)
      return result.value
    }
    const account = await connectGalleryLogin(read, { revision: configRevision(f.service.config), operationId: 'authenticated-login' }, { signal: new AbortController().signal, pollIntervalMs: 1, requestTimeoutMs: 1000, onStatus: view => history.push(view.state) })
    assert.equal(account.username, identity.username)
    assert.deepEqual(writes, ['session=host-only-fixture'])
    assert.ok(history.includes('ready'))
    await assert.rejects(f.service.action({ operation: 'gallery-login-start', args: { revision: configRevision(f.service.config), operationId: 'agent-login' } }, { kind: 'agent', id: 'agent', profileId: f.profileId, sessionId: 'other' }, new AbortController().signal), { code: 'owner-denied' })
    await assert.rejects(f.action('gallery-login-start', { revision: 'old-revision', operationId: 'stale-login' }), { code: 'revision-conflict' })
  } finally { await f.cleanup() }
})

test('authenticated retry route resumes a paused login and preserves the identity verification deadline', { timeout: 10000 }, async () => {
  let recovered = false, writes = 0
  const deadlines: number[] = []
  const f = await serviceFixture(undefined, { requestTimeoutMs: 180000 }, {
    launchGalleryLogin: async () => ({ closed: new AbortController().signal, cookie: async () => 'un_sesh=route-fixture', close: async () => {} }),
    galleryApi: async () => new UnsplashApi({ request: async (_path, _params, bounds) => {
      deadlines.push(bounds.timeoutMs)
      if (!recovered) throw new CurlRequestError(56)
      return { id: identity.userId, username: identity.username, name: identity.name, total_collections: 1 }
    } }),
  }, { unsplash: config().source.unsplash })
  f.service.config.source.unsplash.login.maxValidationAttempts = 1
  f.service.config.source.unsplash.login.validationTimeoutMs = 1234
  f.host.credentials.set = async () => { writes++ }
  await f.service.initialize()
  const read = async (operation: string, args: Record<string, import('../src/shared/model.ts').Json>) => {
    const response = await f.service.gallery(new Request('https://owner.example/api/visual-curator/gallery', { method: 'POST', body: JSON.stringify({ operation, args }) }))
    return z.object({ ok: z.literal(true), value: z.object({ id: z.string(), state: z.string() }).passthrough() }).parse(await response.json()).value
  }
  try {
    let view = await read('gallery-login-start', { revision: configRevision(f.service.config), operationId: 'route-retry' })
    while (!['retry-paused', 'failed'].includes(view.state)) { await setImmediate(); view = await read('gallery-login-status', { loginId: view.id }) }
    assert.equal(view.state, 'retry-paused')
    assert.equal(writes, 0)
    recovered = true
    assert.equal((await read('gallery-login-retry', { loginId: view.id })).state, 'validating')
    while (view.state !== 'ready') { await setImmediate(); view = await read('gallery-login-status', { loginId: view.id }) }
    const finished = await f.service.gallery(new Request('https://owner.example/api/visual-curator/gallery', { method: 'POST', body: JSON.stringify({ operation: 'gallery-login-finish', args: { loginId: view.id } }) }))
    assert.equal(finished.status, 200)
    assert.equal(writes, 1)
    assert.deepEqual(deadlines, [1234, 1234])
    await assert.rejects(f.service.action({ operation: 'gallery-login-retry', args: { loginId: view.id } }, { kind: 'agent', id: 'agent', profileId: f.profileId, sessionId: 'other' }, new AbortController().signal), { code: 'owner-denied' })
  } finally { await f.cleanup() }
})

test('a cancelled start cannot open late, and a lost start response is cancelled by its original operation identity', async () => {
  let openings = 0
  const lifetime = new AbortController(), controller = new AbortController()
  const login = new GalleryLogins(config(), lifetime.signal, async () => { openings++; return { closed: new AbortController().signal, cookie: async () => '', close: async () => {} } }, async () => identity, async () => { assert.fail('Cancelled login must not write credentials') })
  await login.cancelStart('cancel-before-admission', owner)
  assert.throws(() => login.start({ operationId: 'cancel-before-admission' }, owner), { code: 'gallery-login-cancelled' })
  assert.equal(openings, 0)
  let accepted = ''
  await assert.rejects(connectGalleryLogin(async (operation, args) => {
    if (operation === 'gallery-login-start') { accepted = login.start({ operationId: String(args.operationId) }, owner).id; controller.abort(); throw new Error('Response lost') }
    if (operation === 'gallery-login-cancel') { assert.equal(args.operationId, 'lost-response'); await login.cancelStart(String(args.operationId), owner); return { cancelled: true } }
    assert.fail('Cancelled start must not poll')
  }, { operationId: 'lost-response', revision: 'fixture' }, { signal: controller.signal, pollIntervalMs: 1, requestTimeoutMs: 1000, onStatus: () => {} }))
  assert.equal(login.status(accepted, owner).state, 'cancelled')
  await login.dispose()
})

test('failed browser cleanup stops credential commit and a later login until disposal can drain the window', async () => {
  let canClose = false, closes = 0
  const manager = new GalleryLogins(config(), new AbortController().signal, async () => ({ closed: new AbortController().signal, cookie: async () => 'session=private', close: async () => { closes++; if (!canClose) throw new Error('Window is still owned') } }), async () => identity, async () => { assert.fail('Unclosed login must not commit') })
  const view = manager.start({ operationId: 'close-failure' }, owner)
  while (manager.status(view.id, owner).state !== 'failed') await setImmediate()
  assert.equal(manager.status(view.id, owner).errorCode, 'gallery-login-close-failed')
  await assert.rejects(manager.finish(view.id, owner))
  assert.throws(() => manager.start({ operationId: 'other-start' }, owner), { code: 'gallery-login-close-failed' })
  await assert.rejects(manager.cancel(view.id, owner), { code: 'gallery-login-close-failed' })
  canClose = true
  await manager.dispose()
  assert.equal(closes, 3)
})
