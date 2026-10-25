/** Collection pages and lightweight task polling retain already visible references. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { createCuratorStore } from '../src/client/store.ts'
import { UnsplashApi } from '../src/media/unsplash.ts'
import { serviceFixture } from './helpers/service-fixture.ts'

test('a late task acceptance cannot populate another Session scope', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  let release!: (value: object) => void
  const response = new Promise<object>(resolve => { release = resolve })
  const store = createCuratorStore({ invoke: (operation, args) => operation === 'gallery-reference-start' ? response : f.action(operation, args) })
  try {
    await store.reload()
    const starting = store.startGalleryReferences({ operationId: 'late-acceptance', styleId: 'old-style', photoIds: ['one'] })
    store.closeSession(); await store.reload()
    release({ id: 'a'.repeat(64), styleId: 'old-style', status: 'queued', phase: 'verifying', total: 1, completed: 0, failed: 0, registered: 0, createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z' })
    await starting
    assert.deepEqual(store.getSnapshot().galleryTasks, [])
  } finally { store.dispose(); await f.cleanup() }
})

test('collection pages deduplicate concurrent loads, retain cards after failure and discover appended references', async () => {
  const api = new UnsplashApi({ request: async path => ({ id: path.split('/').at(-1)!, width: 20, height: 10, urls: { small: 'https://images.unsplash.com/reference' } }) })
  const f = await serviceFixture(undefined, { pageSize: 2 }, { galleryApi: async () => api }); await f.service.initialize()
  let failPage = false, snapshots = 0, pageCalls = 0
  const store = createCuratorStore({ invoke: async (operation, args) => {
    if (operation === 'snapshot') snapshots++
    if (operation === 'references-list') { pageCalls++; if (failPage && args.pageToken) throw { code: 'page-unavailable', safeMessage: 'Retry this page', suggestedAction: 'Retry', retryable: true } }
    return f.action(operation, args)
  } })
  try {
    const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'store-style', name: 'Store' }))
    await f.action('gallery-reference-start', { operationId: 'store-import', styleId, photoIds: ['one', 'two', 'three', 'four'] }); await f.jobs.drain()
    await store.reload()
    assert.equal(store.getSnapshot().referencePages[styleId]?.total, 4)
    assert.equal(store.getSnapshot().snapshot?.images.filter(image => image.styleId === styleId).length, 2)
    failPage = true; await store.loadMoreImages()
    assert.equal(store.getSnapshot().snapshot?.images.filter(image => image.styleId === styleId).length, 2)
    assert.equal(store.getSnapshot().referencePages[styleId]?.error?.code, 'page-unavailable')
    failPage = false; const before = pageCalls
    await Promise.all([store.loadMoreImages(), store.loadMoreImages()])
    assert.equal(pageCalls - before, 1)
    assert.equal(store.getSnapshot().snapshot?.images.filter(image => image.styleId === styleId).length, 4)
    assert.equal(store.getSnapshot().referencePages[styleId]?.nextPageToken, undefined)
    await f.action('gallery-reference-start', { operationId: 'store-append', styleId, photoIds: ['five'] }); await f.jobs.drain()
    await store.refreshGalleryTasks()
    assert.ok(store.getSnapshot().snapshot!.images.filter(image => image.styleId === styleId).length >= 4, 'background refresh retains all loaded cards')
    assert.ok(store.getSnapshot().referencePages[styleId]?.nextPageToken)
    await store.loadMoreImages()
    const images = store.getSnapshot().snapshot!.images.filter(image => image.styleId === styleId)
    assert.equal(images.length, 5); assert.equal(new Set(images.map(image => image.referenceId)).size, 5)
    const reads = snapshots
    await store.refreshGalleryTasks(); await store.refreshGalleryTasks()
    assert.equal(snapshots, reads, 'unchanged task polling must not rebuild full workspace snapshots')
  } finally { store.dispose(); await f.cleanup() }
})
