/** Unsaved gallery previews use the same authenticated media path as saved references. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { UnsplashApi } from '../src/media/unsplash.ts'
import { resolveConfig } from '../src/host/config.ts'
import { serviceFixture } from './helpers/service-fixture.ts'
import { readFile } from 'node:fs/promises'

const thumbnail = 'https://images.unsplash.com/photo-test?w=400'
const reference = 'https://images.unsplash.com/photo-test?w=1080'
const photo = { id: 'park', width: 400, height: 200, urls: { small: thumbnail, regular: reference }, user: { username: 'artist' } }
const unsplash = resolveConfig({ source: { unsplash: { accounts: [{ id: 'a', label: 'A', credentialRef: 'COOKIE_A', userId: 'user-a', username: 'owner-a', name: 'A' }] } } }).source.unsplash
const api = () => new UnsplashApi({ request: async path => path === '/me' ? { id: 'user-a', username: 'owner-a', name: 'A', total_collections: 1 }
  : path.includes('/collections') && !path.endsWith('/photos') ? [{ id: 'folder', title: 'Gallery folder', cover_photo: photo, total_photos: 1 }]
  : path.endsWith('/photos') ? [photo] : photo })

test('gallery cover, thumbnail and lightbox use Host previews without replacing the original descriptors', async () => {
  const downloads: { url: string; headers: Readonly<Record<string, string>> }[] = []
  const f = await serviceFixture(undefined, {}, { galleryApi: async () => api(), galleryMedia: { request: async (url, input) => { downloads.push({ url, headers: input.headers ?? {} }); return { status: 200, headers: { 'content-type': 'image/png' }, bytes: f.http.image } } } }, { provider: 'unsplash', unsplash })
  await f.service.initialize()
  try {
    const folders = z.object({ items: z.array(z.object({ coverUrl: z.string(), coverPath: z.string() })) }).parse(await f.action('gallery-collections', { accountId: 'a' }))
    const photos = z.object({ items: z.array(z.object({ thumbnailUrl: z.string(), referenceUrl: z.string(), thumbnailPath: z.string(), previewPath: z.string() })) }).parse(await f.action('gallery-photos', { accountId: 'a', scope: { kind: 'collection', collectionId: 'folder' } }))
    assert.equal(folders.items[0]!.coverUrl, thumbnail)
    assert.equal(photos.items[0]!.thumbnailUrl, thumbnail); assert.equal(photos.items[0]!.referenceUrl, reference)
    assert.equal(downloads.length, 0, 'Reading metadata must not fetch pixels')
    for (const path of [folders.items[0]!.coverPath, photos.items[0]!.thumbnailPath, photos.items[0]!.previewPath]) {
      assert.match(path, /^\/api\/visual-curator\/resource\?/)
      const response = await f.service.resource(new Request(`https://owner.example${path}`))
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'image/png')
      assert.match(response.headers.get('cache-control')!, /^private,/)
      assert.ok((await response.arrayBuffer()).byteLength > 0)
    }
    assert.deepEqual(downloads.map(item => item.url), [thumbnail, thumbnail, reference])
    assert.ok(downloads.every(item => !('cookie' in item.headers) && !('authorization' in item.headers)))
    assert.equal(f.repository.list('imageVersion').length, 0, 'Previewing must not register image records')
    const head = await f.service.resource(new Request(`https://owner.example${photos.items[0]!.previewPath}`, { method: 'HEAD' }))
    const headBytes = await head.arrayBuffer()
    assert.equal(head.status, 200); assert.equal(headBytes.byteLength, 0)
    assert.deepEqual({ hostDisplayPaths: [folders.items[0]!.coverPath, photos.items[0]!.thumbnailPath, photos.items[0]!.previewPath].every(path => path.startsWith('/api/visual-curator/resource?')), originalDescriptorsKept: photos.items[0]!.thumbnailUrl === thumbnail && photos.items[0]!.referenceUrl === reference, imageRecordsCreated: f.repository.list('imageVersion').length, previewReads: downloads.length, cookieForwarded: downloads.some(item => 'cookie' in item.headers || 'authorization' in item.headers), headHasBody: headBytes.byteLength > 0 }, JSON.parse(await readFile(new URL('./fixtures/gallery-preview.expected.json', import.meta.url), 'utf8')))
  } finally { await f.cleanup() }
})

test('gallery preview rejects unrelated destinations, signed URLs and mixed resource selectors before dispatch', async () => {
  let downloads = 0
  const f = await serviceFixture(undefined, {}, { galleryMedia: { request: async () => { downloads++; return { status: 200, headers: { 'content-type': 'image/png' }, bytes: f.http.image } } } }, { provider: 'unsplash', unsplash })
  await f.service.initialize()
  try {
    for (const target of ['http://images.unsplash.com/a', 'https://127.0.0.1/a', 'https://images.unsplash.com.evil.test/a', 'https://images.unsplash.com/a?token=secret', 'https://user:password@images.unsplash.com/a']) {
      const response = await f.service.resource(new Request(`https://owner.example/api/visual-curator/resource?galleryUrl=${encodeURIComponent(target)}`))
      assert.equal(response.ok, false)
    }
    const mixed = await f.service.resource(new Request(`https://owner.example/api/visual-curator/resource?imageVersionId=unrelated&galleryUrl=${encodeURIComponent(thumbnail)}`))
    assert.equal(mixed.ok, false); assert.equal(downloads, 0)
  } finally { await f.cleanup() }
})

test('explicit gallery redirect mode keeps original browser URLs and does not fetch preview pixels', async () => {
  let downloads = 0
  const f = await serviceFixture(undefined, {}, { galleryApi: async () => api(), galleryMedia: { request: async () => { downloads++; throw new Error('Unexpected image download') } } }, { provider: 'unsplash', unsplash: { ...unsplash, previewTransport: 'redirect' } })
  await f.service.initialize()
  try {
    const photos = z.object({ items: z.array(z.object({ thumbnailUrl: z.string(), thumbnailPath: z.string().optional() })) }).parse(await f.action('gallery-photos', { accountId: 'a', scope: { kind: 'collection', collectionId: 'folder' } }))
    assert.equal(photos.items[0]!.thumbnailUrl, thumbnail); assert.equal(photos.items[0]!.thumbnailPath, undefined)
    assert.equal(downloads, 0)
  } finally { await f.cleanup() }
})
