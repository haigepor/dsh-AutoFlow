/** Remote collection references retain links without a download admission. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'
import { UnsplashApi } from '../src/media/unsplash.ts'
import { resolveConfig } from '../src/host/config.ts'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { remoteReferenceBlob } from '../src/media/remote-reference.ts'
import { dataOf } from '../src/host/runtime.ts'

const unsplash = resolveConfig({ source: { unsplash: { accounts: [{ id: 'a', label: 'A', credentialRef: 'COOKIE_A', userId: 'user-a', username: 'owner-a', name: 'A' }] } } }).source.unsplash

test('link references commit immediately without fetching CDN pixels or per-photo details already in the listing', async () => {
  let downloads = 0, details = 0
  const photo = { id: 'park', width: 400, height: 200, urls: { small: 'https://images.unsplash.com/reference?w=200', regular: 'https://images.unsplash.com/reference?w=1080' }, user: { username: 'artist' } }
  const api = new UnsplashApi({ request: async path => {
    if (path === '/me') return { id: 'user-a', username: 'owner-a', name: 'A', total_collections: 1 }
    if (path.endsWith('/photos') && path.startsWith('/collections/')) return [photo]
    details++; return photo
  } })
  const f = await serviceFixture(undefined, {}, { galleryApi: async () => api, galleryMedia: { request: async () => { downloads++; return { status: 200, headers: { 'content-type': 'image/png' }, bytes: f.http.image } } } }, { provider: 'unsplash', unsplash })
  await f.service.initialize()
  try {
    const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'remote-style', name: 'Remote style' }))
    await f.action('gallery-photos', { accountId: 'a', scope: { kind: 'collection', collectionId: 'park-folder' } })
    const input = { operationId: 'remote-reference', transferId: 'transfer-a', mode: 'remote-reference', accountId: 'a', styleId, expectedRevision: 1, photoIds: ['park'], role: 'positive' }
    const receipt = await f.action('gallery-import', input)
    assert.equal(z.object({ results: z.array(z.object({ ok: z.boolean() })) }).parse(receipt).results[0]?.ok, true)
    assert.equal(downloads, 0, 'Referencing must not fetch image bytes')
    assert.equal(details, 0, 'A verified listing already supplies this descriptor')
    assert.equal(f.repository.list('asset')[0]?.originalBlob, undefined)
    assert.equal(f.repository.list('imageVersion')[0]?.versionKind, 'remote-reference')
    assert.deepEqual(await f.action('gallery-import', input), receipt)
  } finally { await f.cleanup() }
})

test('URL analysis and reference datasets carry remote locations without claiming measured pixels or writing blobs', async () => {
  const api = new UnsplashApi({ request: async path => path === '/me' ? { id: 'user-a', username: 'owner-a', name: 'A', total_collections: 1 } : { id: 'park', width: 400, height: 200, urls: { small: 'https://images.unsplash.com/reference?w=200', regular: 'https://images.unsplash.com/reference?w=1080' } } })
  const f = await serviceFixture(undefined, {}, { galleryApi: async () => api, galleryMedia: { request: async () => { throw new Error('Reference registration must not download pixels') } } }, { provider: 'unsplash', unsplash })
  const urls: string[] = [], request = f.http.request.bind(f.http)
  f.http.request = async (url, options) => {
    if (url.startsWith('https://vision.example.test')) {
      const body = z.object({ messages: z.array(z.object({ content: z.union([z.string(), z.array(z.object({ image_url: z.object({ url: z.string() }).optional() }).passthrough())]) })) }).parse(JSON.parse(Buffer.from(options.body ?? []).toString('utf8')))
      for (const message of body.messages) if (Array.isArray(message.content)) urls.push(...message.content.flatMap(item => item.image_url ? [item.image_url.url] : []))
    }
    return request(url, options)
  }
  await f.service.initialize()
  try {
    const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'url-style', name: 'URL style' }))
    await f.action('gallery-import', { operationId: 'url-reference', transferId: 'url-transfer', mode: 'remote-reference', accountId: 'a', styleId, expectedRevision: 1, photoIds: ['park'] })
    const image = f.repository.list('imageVersion')[0]!
    const response = await f.service.resource(new Request(`https://owner.example/api/visual-curator/resource?imageVersionId=${image.id}`))
    assert.equal(response.status, 302); assert.equal(response.headers.get('location'), image.blob.remoteSource?.url)
    const { runId } = z.object({ runId: z.string() }).parse(await f.action('reference-analyze', { operationId: 'url-analysis', styleId, buildDataset: true }))
    await f.jobs.drain()
    assert.equal(f.domain.require('run', runId).status, 'completed', JSON.stringify(dataOf(f.domain.require('run', runId)).error))
    const profile = f.repository.list('modelProfile')[0]!
    await f.action('export-start', { operationId: 'url-export', kind: 'style', purpose: 'reference', releaseId: profile.id })
    await f.jobs.drain()
    const exported = f.repository.list('profileExport')[0]!
    assert.ok(exported, 'A URL reference package must be exportable')
    const references = z.object({ resources: z.array(z.object({ digestKind: z.string(), pixelDigest: z.null(), remoteSource: z.object({ url: z.string() }) })) }).parse(JSON.parse(exported.files.find(file => file.name === 'references.json')!.content))
    const files = await readdir(join(f.root, 'visual-curator'), { recursive: true }).catch(() => [])
    const actual = { requestsUseRemoteUrls: urls.length === 2 && urls.every(url => url === 'https://images.unsplash.com/reference?w=1080'), referenceVersion: image.versionKind, digestKind: references.resources[0]?.digestKind, pixelDigest: references.resources[0]?.pixelDigest, localBlobFiles: files.filter(file => /(^|[\\/])blobs[\\/]/.test(file)).length, fabricatedMeasurements: f.repository.list('observation').flatMap(item => item.measured).length, remoteLocationExported: references.resources[0]?.remoteSource.url === image.blob.remoteSource?.url, replayLimitationRecorded: JSON.stringify(f.repository.list('request')).includes('Remote URLs identify provider references') }
    assert.deepEqual(actual, JSON.parse(await readFile(new URL('./fixtures/gallery-remote-reference.expected.json', import.meta.url), 'utf8')))
  } finally { await f.cleanup() }
})

test('cancelling a blocked reference interrupts lookup, retains its acknowledged prefix and stops later items', { timeout: 10000 }, async () => {
  let entered = () => {}, lookedUp = 0
  const second = new Promise<void>(resolve => { entered = resolve })
  const api = new UnsplashApi({ request: async (path, _params, bounds) => {
    if (path === '/me') return { id: 'user-a', username: 'owner-a', name: 'A', total_collections: 1 }
    lookedUp++
    if (path.endsWith('/second')) { entered(); await new Promise((_resolve, reject) => { bounds.signal?.addEventListener('abort', () => reject(bounds.signal?.reason), { once: true }) }) }
    return { id: path.split('/').at(-1), width: 400, height: 200, urls: { small: 'https://images.unsplash.com/fixture', regular: 'https://images.unsplash.com/fixture' } }
  } })
  const f = await serviceFixture(undefined, {}, { galleryApi: async () => api }, { provider: 'unsplash', unsplash })
  await f.service.initialize()
  let pending: Promise<unknown> | undefined
  try {
    const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'cancel-style', name: 'Cancel style' }))
    const control = { transferId: 'cancel-transfer', accountId: 'a' }
    pending = f.action('gallery-import', { ...control, operationId: 'cancel-reference', mode: 'remote-reference', styleId, expectedRevision: 1, photoIds: ['first', 'second', 'third'] })
    await second
    const progress = z.object({ rows: z.array(z.object({ name: z.string(), ok: z.boolean() })) }).parse(await f.action('gallery-import-progress', control))
    assert.deepEqual(progress.rows, [{ name: 'first', ok: true }])
    await assert.rejects(f.action('gallery-import-cancel', { ...control, accountId: 'b' }), { code: 'owner-denied' })
    await f.action('gallery-import-cancel', control)
    const receipt = z.object({ cancelled: z.boolean(), results: z.array(z.object({ name: z.string(), ok: z.boolean(), error: z.object({ code: z.string() }).optional() })) }).parse(await pending)
    assert.equal(receipt.cancelled, true)
    assert.deepEqual(receipt.results.map(row => [row.name, row.ok, row.error?.code]), [['first', true, undefined], ['second', false, 'cancelled'], ['third', false, 'cancelled']])
    assert.equal(lookedUp, 2)
    assert.equal(f.domain.require('draft', f.domain.require('style', styleId).draftId).referenceIds.length, 1)
  } finally { await f.action('gallery-import-cancel', { transferId: 'cancel-transfer', accountId: 'a' }); await pending?.catch(() => {}); await f.cleanup() }
})

test('cancellation arriving before the import prevents its lookup and registration', async () => {
  let reads = 0
  const api = new UnsplashApi({ request: async () => { reads++; throw new Error('No request should be admitted') } })
  const f = await serviceFixture(undefined, {}, { galleryApi: async () => api }, { provider: 'unsplash', unsplash })
  await f.service.initialize()
  try {
    const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'early-style', name: 'Early cancel' }))
    await f.action('gallery-import-cancel', { transferId: 'early-transfer', accountId: 'a' })
    const receipt = z.object({ cancelled: z.boolean() }).parse(await f.action('gallery-import', { transferId: 'early-transfer', accountId: 'a', operationId: 'early-import', mode: 'remote-reference', styleId, expectedRevision: 1, photoIds: ['park'] }))
    assert.equal(receipt.cancelled, true); assert.equal(reads, 0); assert.equal(f.repository.list('imageVersion').length, 0)
  } finally { await f.cleanup() }
})

test('remote references reject unapproved origins and signed or credential-bearing URLs', () => {
  for (const url of ['http://images.unsplash.com/a', 'https://127.0.0.1/a', 'https://images.unsplash.com.evil.test/a', 'https://user:password@images.unsplash.com/a', 'https://images.unsplash.com/a?token=secret', 'invalid']) assert.throws(() => remoteReferenceBlob({ providerId: 'unsplash', photoId: 'park', accountId: 'a', url, thumbnailUrl: 'https://images.unsplash.com/a' }))
})
