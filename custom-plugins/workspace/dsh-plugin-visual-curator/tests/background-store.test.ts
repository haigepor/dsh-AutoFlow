/** Collection pages and lightweight task polling retain already visible references. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { createCuratorStore } from '../src/client/store.ts'
import { UnsplashApi } from '../src/media/unsplash.ts'
import { serviceFixture } from './helpers/service-fixture.ts'

test('switching between cached collections does not request their first page again', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  const reads: string[] = []
  let snapshots = 0
  const store = createCuratorStore({ invoke: async (operation, args) => { if (operation === 'snapshot') snapshots++; if (operation === 'references-list') reads.push(String(args.styleId)); return f.action(operation, args) } })
  try {
    const first = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'cached-first', name: 'First' }))
    const second = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'cached-second', name: 'Second' }))
    await store.reload()
    await store.ensureLoaded(); await store.ensureLoaded()
    assert.equal(snapshots, 1, 'entry mounts share the loaded workspace')
    store.selectStyle(first.id); await store.loadReferences(first.id)
    store.selectStyle(second.id); await store.loadReferences(second.id)
    const before = reads.length
    store.selectStyle(first.id)
    await Promise.resolve(); await Promise.resolve()
    assert.equal(reads.length, before, 'returning to a current collection reuses its cached page')
    await store.reload()
    assert.equal(reads.length, before + 1, 'explicit refresh still reads the selected collection')
  } finally { store.dispose(); await f.cleanup() }
})

test('live imports append only newly published cards and preserve unloaded older pages', async () => {
  let enterTwo = () => {}, releaseTwo = () => {}, enterThree = () => {}, releaseThree = () => {}
  const second = new Promise<void>(resolve => { enterTwo = resolve }), third = new Promise<void>(resolve => { enterThree = resolve })
  const gateTwo = new Promise<void>(resolve => { releaseTwo = resolve }), gateThree = new Promise<void>(resolve => { releaseThree = resolve })
  const api = new UnsplashApi({ request: async path => {
    const id = path.split('/').at(-1)!
    if (id === 'new-two') { enterTwo(); await gateTwo }
    if (id === 'new-three') { enterThree(); await gateThree }
    return { id, width: 20, height: 10, urls: { small: `https://images.unsplash.com/${id}` } }
  } })
  const f = await serviceFixture(undefined, { pageSize: 2, maxImportFiles: 5 }, { galleryApi: async () => api }); await f.service.initialize()
  const pages: { token: boolean; count: number }[] = []
  const store = createCuratorStore({ invoke: async (operation, args) => {
    const value = await f.action(operation, args)
    if (operation === 'references-list') pages.push({ token: !!args.pageToken, count: z.object({ images: z.array(z.json()) }).parse(value).images.length })
    return value
  } })
  try {
    const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'append-style', name: 'Append' }))
    await f.action('gallery-reference-start', { operationId: 'old-import', styleId, photoIds: ['old-one', 'old-two', 'old-three'] }); await f.jobs.drain()
    await store.reload(); await store.refreshGalleryTasks()
    await store.startGalleryReferences({ operationId: 'new-import', styleId, photoIds: ['new-one', 'new-two', 'new-three'] })
    await second; await store.refreshGalleryTasks()
    assert.ok(store.getSnapshot().snapshot!.images.some(image => image.name.includes('new-one')))
    releaseTwo(); await third
    const before = pages.length
    await store.refreshGalleryTasks()
    assert.deepEqual(pages.slice(before), [{ token: true, count: 1 }], 'progress reads only the newly committed tail')
    assert.ok(store.getSnapshot().snapshot!.images.some(image => image.name.includes('new-two')))
    await store.loadMoreImages()
    const loaded = store.getSnapshot().snapshot!.images.filter(image => image.styleId === styleId)
    assert.equal(loaded.length, 5); assert.equal(new Set(loaded.map(image => image.referenceId)).size, 5)
  } finally { releaseTwo(); releaseThree(); await f.jobs.drain(); store.dispose(); await f.cleanup() }
})

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

test('unchanged lightweight polling does not publish another gallery render', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  const store = createCuratorStore({ invoke: (operation, args) => f.action(operation, args) })
  try {
    await store.reload(); await store.refreshGalleryTasks()
    let renders = 0
    const unsubscribe = store.subscribe(() => { renders++ })
    await store.refreshGalleryTasks(); await store.refreshGalleryTasks()
    assert.equal(renders, 0)
    unsubscribe()
  } finally { store.dispose(); await f.cleanup() }
})

test('a task poll started before acceptance cannot erase the newly accepted reference task', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  let release!: (value: object) => void, reads = 0
  const old = new Promise<object>(resolve => { release = resolve })
  const store = createCuratorStore({ invoke: (operation, args) => operation === 'gallery-reference-tasks' && reads++ === 0 ? old : f.action(operation, args) })
  try {
    const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'accept-style', name: 'Accepted' }))
    await store.reload()
    const stale = store.refreshGalleryTasks()
    const task = await store.startGalleryReferences({ operationId: 'accept-task', styleId, photoIds: ['one'] })
    release({ tasks: [], analyses: [], workspaceRevision: 'old' }); await stale
    assert.ok(store.getSnapshot().galleryTasks.some(item => item.id === task.id))
  } finally { release({ tasks: [], analyses: [] }); store.dispose(); await f.cleanup() }
})

test('completed reference polling reuses the page it just updated while refreshing workspace metadata', async () => {
  const api = new UnsplashApi({ request: async path => ({ id: path.split('/').at(-1)!, width: 20, height: 10, urls: { small: 'https://images.unsplash.com/reference' } }) })
  const f = await serviceFixture(undefined, {}, { galleryApi: async () => api }); await f.service.initialize()
  let pages = 0
  const store = createCuratorStore({ invoke: (operation, args) => { if (operation === 'references-list') pages++; return f.action(operation, args) } })
  try {
    const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'settle-style', name: 'Settled' }))
    await store.reload(); await store.refreshGalleryTasks()
    await f.action('gallery-reference-start', { operationId: 'settle-task', styleId, photoIds: ['one'] }); await f.jobs.drain()
    pages = 0
    await store.refreshGalleryTasks(); await store.reload()
    assert.equal(pages, 1)
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
