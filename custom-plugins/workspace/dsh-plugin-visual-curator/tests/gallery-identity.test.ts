/** Identity reuse retains account ownership, bounded freshness and independent caller cancellation. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { galleryAccountSchema } from '../src/shared/gallery.ts'
import { MediaError } from '../src/media/errors.ts'
import { UnsplashApi } from '../src/media/unsplash.ts'
import { GalleryIdentityVerifier } from '../src/host/gallery-identity.ts'

const bounds = { maxBytes: 100000, timeoutMs: 10000, maxRedirects: 2 }
const account = (id = 'account-a', userId = 'user-a') => galleryAccountSchema.parse({ id, userId, username: 'owner', label: 'Account', name: 'Owner', credentialRef: 'IDENTITY_TEST' })
const identity = (id = 'user-a', name = 'Owner') => ({ id, name, username: 'owner', total_collections: 2 })

test('one verified account serves repeated pages until its configured freshness expires', async () => {
  let calls = 0, now = 100
  const api = new UnsplashApi({ request: async () => { calls++; return identity() } })
  const verifier = new GalleryIdentityVerifier(1000, () => now)
  for (let page = 0; page < 20; page++) assert.equal((await verifier.verify(api, account(), bounds)).userId, 'user-a')
  assert.equal(calls, 1)
  now = 1099; await verifier.verify(api, account(), bounds); assert.equal(calls, 1)
  now = 1100; await verifier.verify(api, account(), bounds); assert.equal(calls, 2)
  now = 50; await verifier.verify(api, account(), bounds); assert.equal(calls, 3)
  await verifier.dispose()
})

test('saved account IDs and expected user IDs never share a successful identity result', async () => {
  let calls = 0
  const api = new UnsplashApi({ request: async () => { calls++; return identity() } })
  const verifier = new GalleryIdentityVerifier(1000)
  await verifier.verify(api, account(), bounds)
  await verifier.verify(api, account('account-b'), bounds)
  assert.equal(calls, 2)
  await assert.rejects(verifier.verify(api, account('account-a', 'user-b'), bounds), { code: 'owner-denied' })
  assert.equal(calls, 3)
  await verifier.dispose()
})

test('a replacement API instance rechecks identity even when its saved account has not changed', async () => {
  let calls = 0
  const transport = { request: async () => { calls++; return identity() } }
  const verifier = new GalleryIdentityVerifier(1000)
  await verifier.verify(new UnsplashApi(transport), account(), bounds)
  await verifier.verify(new UnsplashApi(transport), account(), bounds)
  assert.equal(calls, 2)
  await verifier.dispose()
})

test('fresh checks bypass stored success and failures cannot revive an older successful result', async () => {
  let calls = 0, failing = false
  const api = new UnsplashApi({ request: async () => {
    calls++
    if (failing) throw new MediaError('source-auth-required', 'gallery', false, 'Session expired.', 'Reconnect this account.')
    return identity()
  } })
  const verifier = new GalleryIdentityVerifier(1000)
  await verifier.verify(api, account(), bounds)
  await verifier.verify(api, account(), bounds, { forceFresh: true })
  assert.equal(calls, 2)
  failing = true
  await assert.rejects(verifier.verify(api, account(), bounds, { forceFresh: true }), { code: 'source-auth-required' })
  await assert.rejects(verifier.verify(api, account(), bounds), { code: 'source-auth-required' })
  assert.equal(calls, 4)
  failing = false; await verifier.verify(api, account(), bounds); assert.equal(calls, 5)
  await verifier.dispose()
})

test('zero freshness disables success reuse while still permitting a current identity check', async () => {
  let calls = 0
  const api = new UnsplashApi({ request: async () => { calls++; return identity() } })
  const verifier = new GalleryIdentityVerifier(0)
  await verifier.verify(api, account(), bounds); await verifier.verify(api, account(), bounds)
  assert.equal(calls, 2)
  await verifier.dispose()
})

test('cancelling one concurrent reader leaves the shared check available to another reader', async () => {
  let release = () => {}, announce = () => {}, observedSignal: AbortSignal | undefined, calls = 0
  const gate = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { announce = resolve })
  const api = new UnsplashApi({ request: async (_path, _params, limits) => { calls++; observedSignal = limits.signal; announce(); await gate; return identity() } })
  const verifier = new GalleryIdentityVerifier(1000), firstLifetime = new AbortController(), secondLifetime = new AbortController()
  const first = verifier.verify(api, account(), { ...bounds, signal: firstLifetime.signal })
  const second = verifier.verify(api, account(), { ...bounds, signal: secondLifetime.signal })
  try {
    await entered
    const rejected = assert.rejects(first, { name: 'AbortError' }); firstLifetime.abort(); await rejected
    assert.equal(observedSignal?.aborted, false)
    release(); assert.equal((await second).userId, 'user-a'); assert.equal(calls, 1)
    await verifier.verify(api, account(), bounds); assert.equal(calls, 1)
  } finally { release(); await Promise.allSettled([first, second]); await verifier.dispose() }
})

test('the last reader cancels the underlying request and a later reader starts a new check', async () => {
  let announce = () => {}, calls = 0, observedSignal: AbortSignal | undefined
  const entered = new Promise<void>(resolve => { announce = resolve })
  const api = new UnsplashApi({ request: async (_path, _params, limits) => {
    if (++calls > 1) return identity()
    observedSignal = limits.signal
    announce()
    return await new Promise((_resolve, reject) => {
      if (!limits.signal) { reject(new Error('Missing request lifetime')); return }
      limits.signal.addEventListener('abort', () => reject(limits.signal?.reason), { once: true })
      if (limits.signal.aborted) reject(limits.signal.reason)
    })
  } })
  const verifier = new GalleryIdentityVerifier(1000), lifetime = new AbortController()
  const first = verifier.verify(api, account(), { ...bounds, signal: lifetime.signal })
  try {
    await entered
    const rejected = assert.rejects(first, { name: 'AbortError' }); lifetime.abort(); await rejected
    assert.equal(observedSignal?.aborted, true)
    assert.equal((await verifier.verify(api, account(), bounds)).userId, 'user-a')
    assert.equal(calls, 2)
  } finally { lifetime.abort(); await Promise.allSettled([first]); await verifier.dispose() }
})

test('invalidation rejects a late response without clearing or replacing a newer check', async () => {
  let release = () => {}, announce = () => {}, calls = 0
  const gate = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { announce = resolve })
  const api = new UnsplashApi({ request: async () => {
    if (++calls > 1) return identity('user-a', 'Fresh')
    announce(); await gate; return identity('user-a', 'Stale')
  } })
  const verifier = new GalleryIdentityVerifier(1000), old = verifier.verify(api, account(), bounds)
  try {
    await entered
    verifier.invalidate(api)
    assert.equal((await verifier.verify(api, account(), bounds)).name, 'Fresh')
    const rejected = assert.rejects(old, { name: 'AbortError' }); release(); await rejected
    assert.equal((await verifier.verify(api, account(), bounds)).name, 'Fresh')
    assert.equal(calls, 2)
  } finally { release(); await Promise.allSettled([old]); await verifier.dispose() }
})

test('aborted callers cannot consume cached success and returned values cannot mutate it', async () => {
  let calls = 0
  const verifier = new GalleryIdentityVerifier(1000), api = new UnsplashApi({ request: async () => { calls++; return identity() } })
  const result = await verifier.verify(api, account(), bounds); result.name = 'Changed outside cache'
  const stopped = new AbortController(); stopped.abort()
  await assert.rejects(verifier.verify(api, account(), { ...bounds, signal: stopped.signal }), { name: 'AbortError' })
  assert.equal((await verifier.verify(api, account(), bounds)).name, 'Owner')
  assert.equal(calls, 1)
  await verifier.dispose()
})

test('disposal aborts and drains its request before refusing further readers', async () => {
  let release = () => {}, announce = () => {}, ended = false, observedSignal: AbortSignal | undefined
  const gate = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { announce = resolve })
  const api = new UnsplashApi({ request: async (_path, _params, limits) => {
    observedSignal = limits.signal; announce()
    try { await gate; return identity() } finally { ended = true }
  } })
  const verifier = new GalleryIdentityVerifier(1000), pending = verifier.verify(api, account(), bounds)
  try {
    await entered
    const rejected = assert.rejects(pending, { name: 'AbortError' }), closing = verifier.dispose()
    assert.equal(observedSignal?.aborted, true); assert.equal(ended, false)
    release(); await closing; await rejected; assert.equal(ended, true)
    await assert.rejects(verifier.verify(api, account(), bounds), { code: 'cancelled' })
  } finally { release(); await Promise.allSettled([pending]); await verifier.dispose() }
})
