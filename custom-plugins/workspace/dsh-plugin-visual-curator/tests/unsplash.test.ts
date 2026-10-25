/** Unsplash responses come from external JSON; pagination and account identity remain explicit. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/host/config.ts'
import { UnsplashApi, UnsplashSourceProvider, normalizeCookie } from '../src/media/unsplash.ts'

const photo = (id: string) => ({ id, width: 1200, height: 800, urls: { small: `https://images.unsplash.com/${id}?w=400`, regular: `https://images.unsplash.com/${id}?w=1200`, raw: `https://images.unsplash.com/${id}` }, alt_description: 'Green park', links: { html: `https://unsplash.com/photos/${id}` }, user: { name: 'Photographer', username: 'artist' }, premium: false })
const bounds = { maxBytes: 1_000_000, timeoutMs: 10_000, maxRedirects: 2 }

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
