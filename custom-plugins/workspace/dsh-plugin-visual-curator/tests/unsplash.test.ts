/** Unsplash responses come from external JSON; pagination and account identity remain explicit. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/host/config.ts'
import { UnsplashApi, UnsplashSourceProvider, normalizeCookie } from '../src/media/unsplash.ts'
import { CurlRequestError, retryCurlRead, curlResolveArgument } from '../src/media/unsplash-transport.ts'

const photo = (id: string) => ({ id, width: 1200, height: 800, urls: { small: `https://images.unsplash.com/${id}?w=400`, regular: `https://images.unsplash.com/${id}?w=1200`, raw: `https://images.unsplash.com/${id}` }, alt_description: 'Green park', links: { html: `https://unsplash.com/photos/${id}` }, user: { name: 'Photographer', username: 'artist' }, premium: false })
const bounds = { maxBytes: 1_000_000, timeoutMs: 10_000, maxRedirects: 2 }

test('restricted Unsplash originals remain explicit instead of becoming missing reference images', async () => {
  const api = new UnsplashApi({ request: async () => ({ total: 1, total_pages: 1, results: [{ ...photo('restricted'), premium: true }] }) })
  const page = await new UnsplashSourceProvider(api).search({ query: 'car', pageSize: 20 }, null, bounds)
  assert.equal(page.items[0]?.originalUrl, undefined)
  assert.equal(page.items[0]?.originalUnavailable, 'restricted')
})

test('each curl connection receives the complete checked address set including IPv6 and rotated fallback order', () => {
  const addresses = [{ address: '151.101.65.181', family: 4 }, { address: '151.101.1.181', family: 4 }, { address: '2606:4700::1111', family: 6 }]
  assert.equal(curlResolveArgument('unsplash.com', addresses, 0), 'unsplash.com:443:151.101.65.181,151.101.1.181,[2606:4700::1111]')
  assert.equal(curlResolveArgument('unsplash.com', addresses, 1), 'unsplash.com:443:151.101.1.181,[2606:4700::1111],151.101.65.181')
})

test('transient connection failures advance the read attempt within the configured retry budget', async () => {
  const attempts: number[] = []
  const result = await retryCurlRead(async attempt => { attempts.push(attempt); if (!attempt) throw new CurlRequestError(28); return { items: ['ready'] } }, 1, new AbortController().signal)
  assert.deepEqual({ attempts, result }, { attempts: [0, 1], result: { items: ['ready'] } })
  let exhausted = 0
  await assert.rejects(retryCurlRead(async () => { exhausted++; throw new CurlRequestError(7) }, 1, new AbortController().signal), { code: 'source-network-failed' })
  assert.equal(exhausted, 2)
  let disabled = 0
  await assert.rejects(retryCurlRead(async () => { disabled++; throw new CurlRequestError(28) }, 0, new AbortController().signal), { code: 'source-request-timeout' })
  assert.equal(disabled, 1)
})

test('certificate failures and caller cancellation never trigger another curl read', async () => {
  let calls = 0
  await assert.rejects(retryCurlRead(async () => { calls++; throw new CurlRequestError(60) }, 3, new AbortController().signal), { code: 'source-tls-failed' })
  assert.equal(calls, 1)
  const controller = new AbortController()
  await assert.rejects(retryCurlRead(async () => { controller.abort(); throw new CurlRequestError(28) }, 3, controller.signal), { code: 'source-request-timeout' })
  let cancelledCalls = 0
  await assert.rejects(retryCurlRead(async () => { cancelledCalls++; return 'unexpected' }, 1, controller.signal), { name: 'AbortError' })
  assert.equal(cancelledCalls, 0)
})

test('login verification has independent validated retry and timeout settings', () => {
  const settings = resolveConfig({ limits: { requestTimeoutMs: 180000 } })
  assert.equal(settings.source.unsplash.login.validationTimeoutMs, 20000)
  assert.equal(settings.source.unsplash.login.maxValidationAttempts, 3)
  assert.equal(settings.source.unsplash.connectTimeoutMs, 5000)
  assert.equal(settings.source.unsplash.readRetryAttempts, 1)
  assert.throws(() => resolveConfig({ source: { unsplash: { connectTimeoutMs: 0 } } }))
  assert.throws(() => resolveConfig({ source: { unsplash: { readRetryAttempts: -1 } } }))
  assert.throws(() => resolveConfig({ source: { unsplash: { login: { maxValidationAttempts: 0 } } } }))
  assert.throws(() => resolveConfig({ source: { unsplash: { login: { validationTimeoutMs: -1 } } } }))
})

test('curl failure classes distinguish timeouts, DNS, partial responses and certificate failures', () => {
  assert.equal(new CurlRequestError(28).code, 'source-request-timeout')
  assert.equal(new CurlRequestError(6).code, 'source-dns-failed')
  assert.equal(new CurlRequestError(18).code, 'source-response-incomplete')
  assert.equal(new CurlRequestError(56).retryable, true)
  assert.equal(new CurlRequestError(60).retryable, false)
  assert.equal(new CurlRequestError(60).code, 'source-tls-failed')
  assert.equal(new CurlRequestError(null, true).code, 'source-client-unavailable')
  assert.equal(new CurlRequestError(2).retryable, false)
})

test('multiple gallery accounts have distinct credentials and a valid explicit search account', () => {
  const accounts = ['a', 'b'].map(id => ({ id, label: id, credentialRef: `UNSPLASH_${id}`, username: id, userId: id, name: id }))
  const config = resolveConfig({ source: { provider: 'unsplash', unsplash: { accounts, defaultAccountId: 'b' } } })
  assert.equal(config.source.unsplash.accounts.length, 2)
  assert.equal(config.source.unsplash.defaultAccountId, 'b')
  assert.throws(() => resolveConfig({ source: { unsplash: { accounts: [accounts[0], accounts[0]] } } }))
  assert.throws(() => resolveConfig({ source: { unsplash: { accounts, defaultAccountId: 'missing' } } }))
  assert.throws(() => resolveConfig({ source: { unsplash: { accounts: [{ ...accounts[0], cookie: 'secret' }] } } }))
})

test('cookie import accepts a header or Netscape file and rejects header injection without echoing secrets', () => {
  assert.equal(normalizeCookie('session=first; other=second'), 'session=first; other=second')
  assert.equal(normalizeCookie('# Netscape HTTP Cookie File\n#HttpOnly_.unsplash.com\tTRUE\t/\tTRUE\t0\tsession\tprivate\n'), 'session=private')
  assert.throws(() => normalizeCookie('session=private\r\nX-Test: bad'), error => error instanceof Error && !error.message.includes('private'))
  assert.throws(() => normalizeCookie('https://unsplash.com'))
})

test('bookmarks envelopes and collection arrays are normalized without exposing share keys', async () => {
  const calls: string[] = []
  const api = new UnsplashApi({ request: async path => { calls.push(path); return path === '/me/bookmarks' ? { total: 1, results: [photo('one')] } : [{ id: 'folder', title: 'Forest', private: true, total_photos: 1, share_key: 'private-key', cover_photo: photo('one') }] } })
  const bookmarks = await api.photos({ kind: 'bookmarks' }, null, 20, bounds)
  assert.equal(bookmarks.items.length, 1)
  assert.equal(bookmarks.nextCursor, null)
  const folders = await api.collections('owner', null, 20, bounds)
  assert.equal(folders.items[0]?.private, true)
  assert.equal('share_key' in folders.items[0]!, false)
  assert.deepEqual(calls, ['/me/bookmarks', '/users/owner/collections'])
})

test('server-sized search pages are sliced without dropping images or accepting a changed continuation', async () => {
  let changed = false
  const api = new UnsplashApi({ request: async () => ({ total: 5, total_pages: 1, results: [1, 2, 3, 4, 5].map(id => photo(changed ? `new-${id}` : String(id))) }) })
  const source = new UnsplashSourceProvider(api)
  const first = await source.search({ query: 'green park', pageSize: 2 }, null, bounds)
  assert.deepEqual(first.items.map(item => item.providerAssetId), ['1', '2'])
  const second = await source.search({ query: 'green park', pageSize: 2 }, first.nextCursor, bounds)
  assert.deepEqual(second.items.map(item => item.providerAssetId), ['3', '4'])
  const third = await source.search({ query: 'green park', pageSize: 2 }, second.nextCursor, bounds)
  assert.deepEqual(third.items.map(item => item.providerAssetId), ['5'])
  assert.equal(third.nextCursor, null)
  changed = true
  await assert.rejects(source.search({ query: 'green park', pageSize: 2 }, first.nextCursor, bounds), /continuation/i)
})

test('source JSON rejects unapproved media origins and identities before returning pixels', async () => {
  const api = new UnsplashApi({ request: async () => ({ results: [{ ...photo('one'), urls: { small: 'http://127.0.0.1/private', regular: 'https://example.test/private' } }], total: 1, total_pages: 1 }) })
  await assert.rejects(api.photos({ kind: 'search', query: 'park' }, null, 20, bounds))
  const bad = new UnsplashApi({ request: async () => photo('different') })
  await assert.rejects(bad.photo('requested', bounds))
})

test('bookmarks stop at the exact total on a short final server page', async () => {
  const api = new UnsplashApi({ request: async (_path, params) => ({ total: 5, results: (params.page === 1 ? ['1', '2', '3'] : ['4', '5']).map(photo) }) })
  const first = await api.photos({ kind: 'bookmarks' }, null, 3, bounds)
  const last = await api.photos({ kind: 'bookmarks' }, first.nextCursor, 3, bounds)
  assert.deepEqual(last.items.map(item => item.id), ['4', '5'])
  assert.equal(last.nextCursor, null)
})

test('a server repeating the first page cannot create an endless gallery continuation', async () => {
  const api = new UnsplashApi({ request: async () => ({ total: 4, total_pages: 2, results: ['1', '2'].map(photo) }) })
  const first = await api.photos({ kind: 'search', query: 'park' }, null, 2, bounds)
  await assert.rejects(api.photos({ kind: 'search', query: 'park' }, first.nextCursor, 2, bounds), /continuation/i)
})
