/** Real workflows preserve account ownership and learning intent after external gallery parsing. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'
import { UnsplashApi } from '../src/media/unsplash.ts'
import { resolveConfig } from '../src/host/config.ts'
import { dataOf, specOf } from '../src/host/runtime.ts'

const accounts = resolveConfig({ source: { unsplash: { accounts: ['a', 'b'].map(id => ({ id, label: `Account ${id}`, credentialRef: `COOKIE_${id}`, userId: `user-${id}`, username: `owner-${id}`, name: id })) } } }).source.unsplash

test('accounts list their own private folders, reject mismatched sessions and deny Agent enumeration', async () => {
  let wrong = false
  const f = await serviceFixture(undefined, {}, { galleryApi: async (_config, id) => new UnsplashApi({ request: async path => path === '/me' ? { id: wrong ? 'other-user' : `user-${id}`, username: `owner-${id}`, name: id, total_collections: 1 } : [{ id: `folder-${id}`, title: `Private ${id}`, private: true, total_photos: 3, share_key: 'not-for-client' }] }) }, { unsplash: accounts })
  await f.service.initialize()
  try {
    const a = z.object({ items: z.array(z.object({ id: z.string(), private: z.boolean() })) }).parse(await f.action('gallery-collections', { accountId: 'a' }))
    const b = z.object({ items: z.array(z.object({ id: z.string(), private: z.boolean() })) }).parse(await f.action('gallery-collections', { accountId: 'b' }))
    assert.equal(a.items[0]?.id, 'folder-a'); assert.equal(b.items[0]?.id, 'folder-b'); assert.equal(a.items[0]?.private, true)
    assert.equal(JSON.stringify(a).includes('not-for-client'), false)
    wrong = true
    await assert.rejects(f.action('gallery-collections', { accountId: 'a' }), { code: 'owner-denied' })
    await assert.rejects(f.service.action({ operation: 'gallery-collections', args: { accountId: 'a' } }, { kind: 'agent', id: 'agent', profileId: f.profileId, sessionId: 'other' }, new AbortController().signal), { code: 'owner-denied' })
  } finally { await f.cleanup() }
})

test('selected gallery photos become reference-only samples and produce an automatic style profile', async () => {
  let downloads = 0
  const api = new UnsplashApi({ request: async path => path === '/me' ? { id: 'user-a', username: 'owner-a', name: 'A', total_collections: 1 } : { id: path.split('/').at(-1), width: 400, height: 200, urls: { small: 'https://images.unsplash.com/reference?w=200', regular: 'https://images.unsplash.com/reference?w=400' }, user: { username: 'artist', name: 'Artist' } } })
  const f = await serviceFixture(undefined, {}, { galleryApi: async () => api, galleryMedia: { request: async () => { downloads++; return { status: 200, headers: { 'content-type': 'image/png' }, bytes: f.http.image } } } }, { provider: 'unsplash', unsplash: accounts })
  await f.service.initialize()
  try {
    const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'gallery-style', name: 'Gallery style' }))
    const args = { operationId: 'selected-photos', accountId: 'a', styleId, expectedRevision: 1, photoIds: ['park'], role: 'positive' }
    const imported = z.object({ results: z.array(z.object({ ok: z.boolean(), imageVersionId: z.string() })) }).parse(await f.action('gallery-import', args))
    assert.equal(imported.results[0]?.ok, true)
    assert.deepEqual(await f.action('gallery-import', args), await f.action('gallery-import', args)); assert.equal(downloads, 1)
    const asset = f.repository.list('asset')[0]!
    assert.equal(asset.source.kind, 'provider'); assert.equal(asset.exportPermission, 'references-only')
    if (asset.source.kind === 'provider') { assert.equal(asset.source.providerId, 'unsplash'); assert.equal(asset.source.accountIdentity, 'a') }
    assert.equal(JSON.stringify(f.repository.list('reference')).includes('https://'), false)
    const { runId } = z.object({ runId: z.string() }).parse(await f.action('reference-analyze', { operationId: 'gallery-analysis', styleId, buildDataset: true }))
    await f.jobs.drain()
    assert.equal(f.domain.require('run', runId).status, 'completed', JSON.stringify(dataOf(f.domain.require('run', runId)).error))
    const profile = f.repository.list('modelProfile')[0]!
    assert.equal(profile.references.length, 1); assert.ok(profile.rules.length)
    const usage = z.object({ id: z.string() }).parse(await f.action('usage-create', { operationId: 'gallery-usage', name: 'Square', output: { aspectP: 1, aspectQ: 1, targetWidth: 100, targetHeight: 100, acceptedFormats: ['png'], allowUpscale: false }, safeRegions: [], protectedContent: [] }))
    const search = z.object({ runId: z.string() }).parse(await f.action('search-start', { operationId: 'gallery-search', releaseId: profile.id, usageRevisionId: usage.id, sourceId: 'unsplash', taskBrief: 'Find existing photographs that match this saved visual profile.', targetCount: 1 }))
    await f.jobs.drain()
    assert.deepEqual(specOf(f.domain.require('run', search.runId)).input.queries, ['muted green landscape'])
    const expected = JSON.parse(await readFile(new URL('./fixtures/gallery-reference.expected.json', import.meta.url), 'utf8'))
    assert.deepEqual({ provider: asset.source.kind === 'provider' ? asset.source.providerId : null, permission: asset.exportPermission, referenceCount: profile.references.length, ruleSource: profile.options[0]?.selectionSource, confirmation: profile.rules[0]?.confirmation.status }, expected)
    await assert.rejects(f.action('gallery-import', { ...args, photoIds: ['other'] }), { code: 'operation-conflict' })
    const denied = await f.service.gallery(new Request('https://owner.example/api/visual-curator/gallery', { method: 'POST', body: JSON.stringify({ operation: 'config-save', args: {} }) }))
    assert.equal(denied.status, 400)
  } finally { await f.cleanup() }
})

test('public gallery import remains usable without an account and stale collection versions fail before downloading', async () => {
  const api = new UnsplashApi({ request: async () => ({ id: 'public-photo', width: 400, height: 200, urls: { small: 'https://images.unsplash.com/reference', regular: 'https://images.unsplash.com/reference' } }) })
  let downloads = 0
  const f = await serviceFixture(undefined, {}, { galleryApi: async () => api, galleryMedia: { request: async () => { downloads++; return { status: 200, headers: { 'content-type': 'image/png' }, bytes: f.http.image } } } })
  await f.service.initialize()
  try {
    const { id } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'public-style', name: 'Public references' }))
    await assert.rejects(f.action('gallery-import', { operationId: 'stale-public', styleId: id, expectedRevision: 9, photoIds: ['public-photo'] }), { code: 'revision-conflict' })
    assert.equal(downloads, 0)
    const result = z.object({ results: z.array(z.object({ ok: z.boolean() })) }).parse(await f.action('gallery-import', { operationId: 'public-import', styleId: id, expectedRevision: 1, photoIds: ['public-photo'] }))
    assert.equal(result.results[0]?.ok, true)
  } finally { await f.cleanup() }
})
