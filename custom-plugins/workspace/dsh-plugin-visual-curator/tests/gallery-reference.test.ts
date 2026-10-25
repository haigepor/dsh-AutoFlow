/** Collection selection spans every provider page and imports only the explicit selection. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { GalleryPhotoId, GalleryPhoto } from '../src/shared/gallery.ts'
import { readCollectionPhotos, importGalleryReferences, filterGalleryPhotos } from '../src/client/gallery-reference.ts'
import { createCuratorStore } from '../src/client/store.ts'
import { resultId } from '../src/client/workbench-actions.ts'
import { serviceFixture } from './helpers/service-fixture.ts'
import { UnsplashApi } from '../src/media/unsplash.ts'

const photo = (id: string): GalleryPhoto => ({ id: brandString<GalleryPhotoId>(id), title: id, width: 20, height: 10, thumbnailUrl: 'https://images.unsplash.com/preview', referenceUrl: 'https://images.unsplash.com/ref', pageUrl: '', photographer: '', photographerUrl: '', premium: false })

test('collection pages publish validated snapshots before later pages finish without changing the final all-photos result', async () => {
  let release = () => {}, announce = () => {}
  const gate = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { announce = resolve })
  const snapshots: string[][] = []
  const pending = readCollectionPhotos(async cursor => {
    if (!cursor) return { items: [photo('a'), photo('b')], nextCursor: 'next' }
    announce(); await gate
    return { items: [photo('b'), photo('c')], nextCursor: null }
  }, { maxFiles: 10, signal: new AbortController().signal, onPage: photos => { snapshots.push(photos.map(item => item.id)) } })
  try {
    await entered
    assert.deepEqual(snapshots, [['a', 'b']])
    const beforeCompletion = structuredClone(snapshots)
    release()
    const complete = (await pending).map(item => item.id)
    assert.deepEqual({ pending: beforeCompletion, complete, published: snapshots }, JSON.parse(await readFile(new URL('./fixtures/gallery-reference-progress.expected.json', import.meta.url), 'utf8')))
  } finally { release(); await pending }
})

test('an invalid later page cannot publish a new snapshot or return a partial collection', async () => {
  const snapshots: string[][] = []
  await assert.rejects(readCollectionPhotos(async cursor => ({ items: [photo(cursor ? 'b' : 'a')], nextCursor: 'same' }), { maxFiles: 10, signal: new AbortController().signal, onPage: photos => { snapshots.push(photos.map(item => item.id)) } }), { code: 'source-continuation-invalid' })
  assert.deepEqual(snapshots, [['a']])
})
test('collection search includes later pages, matches titles and photographers and retains the complete list when cleared', async () => {
  const all=await readCollectionPhotos(async cursor=>cursor ? {items:[{...photo('last'),title:'Quiet PARK',photographer:'Alice'}],nextCursor:null} : {items:[photo('first')],nextCursor:'next'}, {maxFiles:10,signal:new AbortController().signal})
  assert.deepEqual(filterGalleryPhotos(all,'park ALICE').map(item=>item.id),['last'])
  assert.deepEqual(filterGalleryPhotos(all,'missing'),[]); assert.equal(filterGalleryPhotos(all,''),all)
})
test('collection enumeration reads all pages, deduplicates photos and defaults selection independently of preview pages', async () => {
  const cursors: (string | null)[] = [], counts: number[] = []
  const photos = await readCollectionPhotos(async cursor => {
    cursors.push(cursor)
    return cursor === null ? { items: [photo('a'), photo('b')], nextCursor: 'next' } : { items: [photo('b'), photo('c')], nextCursor: null }
  }, { maxFiles: 10, signal: new AbortController().signal, onProgress: count => counts.push(count) })
  assert.deepEqual(cursors, [null, 'next']); assert.deepEqual(photos.map(item => item.id), ['a', 'b', 'c']); assert.deepEqual(counts, [2, 3])
})
test('changed cursors, repeated pages, selection limits and cancellation cannot silently import a partial collection', async () => {
  const signal = new AbortController().signal
  await assert.rejects(readCollectionPhotos(async () => ({ items: [photo('a')], nextCursor: 'same' }), { maxFiles: 10, signal }), { code: 'source-continuation-invalid' })
  await assert.rejects(readCollectionPhotos(async () => ({ items: [photo('a'), photo('b')], nextCursor: null }), { maxFiles: 1, signal }), { code: 'gallery-reference-limit' })
  const lifetime = new AbortController(); lifetime.abort()
  let called = false
  await assert.rejects(readCollectionPhotos(async () => { called = true; return { items: [], nextCursor: null } }, { maxFiles: 10, signal: lifetime.signal }), { name: 'AbortError' }); assert.equal(called, false)
})
test('deselected photos never download and configured batches refresh collection revisions', async () => {
  const downloaded: string[] = []
  const api = new UnsplashApi({ request: async path => { const id = path.split('/').at(-1)!; return { id, width: 20, height: 10, urls: { small: `https://images.unsplash.com/${id}`, regular: `https://images.unsplash.com/${id}` } } } })
  const f = await serviceFixture(undefined, { maxImportFiles: 2 }, { galleryApi: async () => api, galleryMedia: { request: async url => { downloaded.push(url); return { status: 200, headers: { 'content-type': 'image/png' }, bytes: f.http.image } } } })
  await f.service.initialize()
  const store = createCuratorStore({ invoke: f.action })
  try {
    const styleId = resultId(await store.execute('style-create', { operationId: 'style', name: 'Collection import' }))
    const selection = ['one', 'two', 'skip', 'three', 'four'].filter(id => id !== 'skip')
    const rows = await importGalleryReferences(store, { styleId, photoIds: selection, role: 'negative', batchSize: 2 }, () => {}, new AbortController().signal)
    assert.deepEqual(rows.map(row => row.status), ['imported', 'imported', 'imported', 'imported'])
    assert.equal(downloaded.length, 4); assert.equal(downloaded.some(url => url.includes('skip')), false)
    assert.equal(f.repository.list('reference').length, 4)
    assert.equal(store.getSnapshot().snapshot!.styles[0]!.referenceIds.length, 4)
    assert.ok(f.repository.list('reference').every(reference => reference.role === 'negative'))
    assert.deepEqual({ imported: rows.map(row => row.photoId), statuses: rows.map(row => row.status), references: f.repository.list('reference').length, role: 'negative', downloadedDeselectedPhoto: downloaded.some(url => url.includes('skip')) }, JSON.parse(await readFile(new URL('./fixtures/gallery-collection-selection.expected.json', import.meta.url), 'utf8')))
  } finally { store.dispose(); await f.cleanup() }
})
test('stopping after an acknowledged batch preserves success and leaves later selections undispatched', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  const store = createCuratorStore({ invoke: f.action }), lifetime = new AbortController()
  try {
    const styleId = resultId(await store.execute('style-create', { operationId: 'style', name: 'Stop between batches' }))
    let calls = 0
    const actions = { getSnapshot: store.getSnapshot, execute: async (_operation: string, args: import('../src/client/contract.ts').ActionArgs) => {
      calls++; lifetime.abort()
      return { results: (args.photoIds as string[]).map(name => ({ name, ok: true })) }
    } }
    const rows = await importGalleryReferences(actions, { styleId, photoIds: ['a', 'b', 'c'], role: 'positive', batchSize: 2 }, () => {}, lifetime.signal)
    assert.equal(calls, 1); assert.deepEqual(rows.map(row => row.status), ['imported', 'imported', 'skipped'])
  } finally { store.dispose(); await f.cleanup() }
})
test('an unknown batch result stops later batches and never reports success', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  const store = createCuratorStore({ invoke: f.action })
  try {
    const styleId = resultId(await store.execute('style-create', { operationId: 'style', name: 'Unknown batch' }))
    let calls = 0
    const actions = { getSnapshot: store.getSnapshot, execute: async () => { calls++; return undefined } }
    const rows = await importGalleryReferences(actions, { styleId, photoIds: ['a', 'b', 'c'], role: 'positive', batchSize: 2 }, () => {}, new AbortController().signal)
    assert.equal(calls, 1); assert.deepEqual(rows.map(row => row.status), ['unconfirmed', 'unconfirmed', 'skipped'])
  } finally { store.dispose(); await f.cleanup() }
})

test('remote reference progress is visible before its receipt and cancellation retains only the acknowledged prefix', { timeout: 10000 }, async () => {
  const f = await serviceFixture(); await f.service.initialize()
  const store = createCuratorStore({ invoke: f.action }), lifetime = new AbortController()
  let finish = () => {}, active = false, imports = 0, cancelRequests = 0, sawProgress = false
  const response = new Promise<void>(resolve => { finish = resolve })
  try {
    const styleId = resultId(await store.execute('style-create', { operationId: 'remote-progress-style', name: 'Remote progress' }))
    const actions = { getSnapshot: store.getSnapshot, execute: async (_operation: string, args: import('../src/client/contract.ts').ActionArgs) => {
      imports++; active = true
      assert.equal(args.mode, 'remote-reference')
      await response
      return { results: [{ name: 'a', ok: true }, { name: 'b', ok: false, error: { code: 'cancelled' } }] }
    }, galleryRead: async (operation: string) => {
      if (operation === 'gallery-import-cancel') { cancelRequests++; finish(); return { state: 'cancelling' } }
      return { state: active ? 'active' : 'idle', phase: 'referencing', rows: active ? [{ name: 'a', ok: true }] : [] }
    } }
    const rows = await importGalleryReferences(actions, { styleId, photoIds: ['a', 'b', 'c'], role: 'positive', batchSize: 2 }, rows => {
      if (rows[0]?.status === 'registered') { sawProgress = true; lifetime.abort() }
    }, lifetime.signal, { pollIntervalMs: 1, controlTimeoutMs: 1000 })
    assert.deepEqual({ sawProgress, imports, cancelRequests, statuses: rows.map(row => row.status) }, JSON.parse(await readFile(new URL('./fixtures/gallery-reference-cancel.expected.json', import.meta.url), 'utf8')))
  } finally { lifetime.abort(); finish(); store.dispose(); await f.cleanup() }
})

test('an older Host refusing reference controls cannot fall back to downloading selected photos', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  const store = createCuratorStore({ invoke: f.action })
  try {
    const styleId = resultId(await store.execute('style-create', { operationId: 'old-host-style', name: 'Older Host' }))
    let writes = 0
    const actions = { getSnapshot: store.getSnapshot, execute: async (_operation: string, args: import('../src/client/contract.ts').ActionArgs) => { writes++; return { results: (args.photoIds as string[]).map(name => ({ name, ok: true })) } }, galleryRead: async () => { throw Object.assign(new Error('Control unavailable'), { code: 'owner-denied' }) } }
    const rows = await importGalleryReferences(actions, { styleId, photoIds: ['a', 'b', 'c'], role: 'positive', batchSize: 2 }, () => {}, new AbortController().signal, { pollIntervalMs: 10, controlTimeoutMs: 1000 })
    assert.deepEqual({ writes, statuses: rows.map(row => row.status), errorCode: rows[0]?.errorCode }, JSON.parse(await readFile(new URL('./fixtures/gallery-reference-host-guard.expected.json', import.meta.url), 'utf8')))
  } finally { store.dispose(); await f.cleanup() }
})
