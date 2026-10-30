import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSearchBatchesStore } from '../src/client/search-batches-store.ts'
import type { SearchBatch, SearchBatchPage } from '../src/shared/search-batches.ts'
import { searchBatchSchema, searchBatchPageSchema } from '../src/shared/search-batches.ts'

const settle = () => new Promise<void>(resolve => setImmediate(resolve))
const image = (id: string) => ({ imageVersionId: id, name: id, width: 400, height: 200, previewPath: `/api/visual-curator/resource?imageVersionId=${id}` })
const batch = (id: string): SearchBatch => searchBatchSchema.parse({ runId: id, kind: 'search', status: 'completed', createdAt: '2026-10-29T00:00:00Z', taskBrief: id, matched: 3, unavailable: false, images: [image(`${id}-1`)], nextImagePageToken: 'images-a' })
const page = (styleId: string, batches = [batch('a')]): SearchBatchPage => searchBatchPageSchema.parse({ styleId, totalBatches: batches.length, totalMatches: batches.length * 3, batches })

test('all batches are the initial view and late collection responses cannot replace the current collection', async () => {
  let finish!: (value: SearchBatchPage) => void
  const calls: Record<string, unknown>[] = []
  const store = createSearchBatchesStore({ pollMs: () => 1000000, async invoke(_operation, args) { calls.push(args); return args.styleId === 'old' ? new Promise<SearchBatchPage>(resolve => { finish = resolve }) : page(String(args.styleId)) } })
  const stopOld = store.watch('old'); stopOld()
  const stop = store.watch('current'); await settle(); finish(page('old')); await settle()
  try { assert.equal(store.getSnapshot().styleId, 'current'); assert.equal(store.getSnapshot().page?.styleId, 'current'); assert.equal(store.getSnapshot().batchId, ''); assert.equal(calls.some(call => Object.hasOwn(call, 'sessionToken')), false) }
  finally { stop(); store.dispose() }
})

test('refresh retains loaded batch and image tails without repeating their continuations', async () => {
  const store = createSearchBatchesStore({ pollMs: () => 1000000, async invoke(_operation, args) {
    if (args.pageToken === 'batch-b') return page('style', [batch('b')])
    if (args.pageToken === 'images-a') return page('style', [{ ...batch('a'), images: [image('a-2'), image('a-3')], nextImagePageToken: undefined }])
    if (args.batchId === 'b') return page('style', [batch('b')])
    return { ...page('style'), nextPageToken: 'batch-b' }
  } })
  const stop = store.watch('style'); await settle()
  try {
    await store.more(); await store.moreImages('a'); store.refresh(); await settle()
    const saved = store.getSnapshot().page!
    assert.deepEqual(saved.batches.map(row => row.runId), ['a', 'b']); assert.equal(saved.batches[0]?.images.length, 3)
    assert.equal(saved.nextPageToken, undefined); assert.equal(saved.batches[0]?.nextImagePageToken, undefined)
    store.select('b'); await settle(); assert.equal(store.getSnapshot().batchId, 'b')
  } finally { stop(); store.dispose() }
})

test('deleting the selected batch resets its filter and stale reads cannot restore its card', async () => {
  let hold = false, deleted = false, stale!: (value: SearchBatchPage) => void
  const calls: Record<string, unknown>[] = []
  const store = createSearchBatchesStore({ pollMs: () => 1000000, async invoke(operation, args) {
    if (operation === 'run-delete') { calls.push(args); deleted = true; hold = false; return { runId: args.runId, deleted: true } }
    if (hold) return new Promise<SearchBatchPage>(resolve => { stale = resolve })
    return args.batchId === 'a' ? page('style', [batch('a')]) : page('style', deleted ? [batch('b')] : [batch('a'), batch('b')])
  } })
  const stop = store.watch('style'); await settle()
  try {
    store.select('a'); await settle(); hold = true; store.refresh(); await settle()
    await store.remove('a'); stale(page('style', [batch('a')]))
    await settle()
    assert.equal(store.getSnapshot().batchId, '')
    assert.deepEqual(store.getSnapshot().page?.batches.map(batch => batch.runId), ['b'])
    assert.deepEqual(store.getSnapshot().deleting, [])
    assert.equal(calls[0]?.styleId, 'style')
    assert.equal(Object.hasOwn(calls[0]!, 'sessionToken'), false)
  } finally { stop(); store.dispose() }
})

test('an unconfirmed deletion keeps the card and clears its busy state', async () => {
  const store = createSearchBatchesStore({ pollMs: () => 1000000, async invoke(operation) {
    if (operation === 'run-delete') throw new Error('offline')
    return page('style')
  } })
  const stop = store.watch('style'); await settle()
  try {
    await assert.rejects(store.remove('a'), /offline/)
    assert.deepEqual(store.getSnapshot().page?.batches.map(batch => batch.runId), ['a'])
    assert.deepEqual(store.getSnapshot().deleting, [])
  } finally { stop(); store.dispose() }
})

test('returning to a cached collection restores loaded pages before revalidation and isolates the owner scope', async () => {
  let hold = false, scope = 1
  const store = createSearchBatchesStore({ pollMs: () => 1000000, scope: () => scope, cachePolicy: () => ({ ttlMs: 1000, maxViews: 4, resourceTtlMs: 10000 }), async invoke(_operation, args) {
    if (hold) return new Promise<SearchBatchPage>(() => {})
    if (args.pageToken === 'batch-b') return page(String(args.styleId), [batch('b')])
    return { ...page(String(args.styleId)), nextPageToken: 'batch-b' }
  } })
  let stop = store.watch('first'); await settle()
  try {
    await store.more(); stop(); stop = store.watch('second'); await settle(); stop()
    hold = true; stop = store.watch('first')
    assert.deepEqual(store.getSnapshot().page?.batches.map(row => row.runId), ['a', 'b'])
    assert.equal(store.getSnapshot().page?.nextPageToken, undefined)
    assert.equal(store.getSnapshot().loading, true)
    stop(); scope++; stop = store.watch('first')
    assert.equal(store.getSnapshot().page, null)
  } finally { stop(); store.dispose() }
})

test('batch caches expire, evict least recently used views and retain visible results on refresh failure', async () => {
  let now = 0, fail = false, hold = false
  const store = createSearchBatchesStore({ pollMs: () => 1000000, now: () => now, cachePolicy: () => ({ ttlMs: 100, maxViews: 2, resourceTtlMs: 1000 }), async invoke(_operation, args) {
    if (hold) return new Promise<SearchBatchPage>(() => {})
    if (fail) throw new Error('offline')
    return page(String(args.styleId), [batch(String(args.styleId))])
  } })
  let stop = store.watch('a'); await settle()
  try {
    stop(); stop = store.watch('b'); await settle(); stop(); stop = store.watch('c'); await settle(); stop()
    hold = true; stop = store.watch('a'); assert.equal(store.getSnapshot().page, null); stop()
    hold = false; fail = true; stop = store.watch('b'); assert.equal(store.getSnapshot().page?.batches[0]?.runId, 'b'); await settle()
    assert.equal(store.getSnapshot().error, true)
    assert.equal(store.getSnapshot().page?.batches[0]?.runId, 'b')
    stop(); now = 101; hold = true; stop = store.watch('b'); assert.equal(store.getSnapshot().page, null)
  } finally { stop(); store.dispose() }
})

test('manual refresh and confirmed deletion invalidate every cached filter in the collection', async () => {
  let hold = false, deleted = false
  const store = createSearchBatchesStore({ pollMs: () => 1000000, cachePolicy: () => ({ ttlMs: 1000, maxViews: 8, resourceTtlMs: 10000 }), async invoke(operation, args) {
    if (operation === 'run-delete') { deleted = true; return { runId: args.runId, deleted: true } }
    if (hold) return new Promise<SearchBatchPage>(() => {})
    return page('style', args.batchId ? [batch(String(args.batchId))] : deleted ? [batch('b')] : [batch('a'), batch('b')])
  } })
  const stop = store.watch('style'); await settle()
  try {
    store.select('a'); await settle(); store.select(''); await settle()
    hold = true; store.refresh(); store.select('a'); assert.equal(store.getSnapshot().page, null)
    hold = false; store.select(''); await settle(); store.select('a'); await settle(); store.select(''); await settle()
    await store.remove('a'); hold = true; store.select('a'); assert.equal(store.getSnapshot().page, null)
    store.select(''); assert.deepEqual(store.getSnapshot().page?.batches.map(row => row.runId), ['b'])
  } finally { stop(); store.dispose() }
})

test('shared observers deduplicate loading and reset prevents late results from repopulating the cache', async () => {
  let calls = 0, hold = false, finish!: (value: SearchBatchPage) => void
  const store = createSearchBatchesStore({ pollMs: () => 1000000, cachePolicy: () => ({ ttlMs: 1000, maxViews: 4, resourceTtlMs: 10000 }), async invoke(_operation, args) {
    calls++
    if (hold) return new Promise<SearchBatchPage>(resolve => { finish = resolve })
    return page(String(args.styleId))
  } })
  hold = true
  const stop = store.watch('style'), stopAgain = store.watch('style')
  try {
    assert.equal(calls, 1)
    const oldFinish = finish; store.reset(); oldFinish(page('style')); await settle()
    assert.equal(store.getSnapshot().page, null)
    finish(page('style')); await settle()
    assert.equal(store.getSnapshot().page?.styleId, 'style')
    stopAgain(); stop(); hold = true
    const after = store.watch('other'); after()
    store.dispose()
  } finally { store.dispose() }
})

test('refreshing retained image tails never extends their original resource grant lifetime', async () => {
  let now = 0, hold = false
  const store = createSearchBatchesStore({ pollMs: () => 1000000, now: () => now, cachePolicy: () => ({ ttlMs: 1000, maxViews: 4, resourceTtlMs: 100 }), async invoke(_operation, args) {
    if (hold) return new Promise<SearchBatchPage>(() => {})
    return args.pageToken === 'images-a' ? page('style', [{ ...batch('a'), images: [image('a-tail')], nextImagePageToken: undefined }]) : page('style')
  } })
  let stop = store.watch('style'); await settle()
  try {
    await store.moreImages('a'); now = 90; store.refresh(); await settle()
    assert.equal(store.getSnapshot().page?.batches[0]?.images.length, 2)
    stop(); now = 101; hold = true; stop = store.watch('style')
    assert.equal(store.getSnapshot().page, null)
  } finally { stop(); store.dispose() }
})

test('failed initial reads and disabled cache policies do not restore stale pages', async () => {
  let fail = true, hold = false, ttlMs = 1000
  const store = createSearchBatchesStore({ pollMs: () => 1000000, cachePolicy: () => ({ ttlMs, maxViews: 4, resourceTtlMs: 10000 }), async invoke(_operation, args) {
    if (hold) return new Promise<SearchBatchPage>(() => {})
    if (fail) throw new Error('offline')
    return page(String(args.styleId))
  } })
  let stop = store.watch('failed'); await settle()
  try {
    stop(); hold = true; stop = store.watch('failed'); assert.equal(store.getSnapshot().page, null); stop()
    fail = false; hold = false; stop = store.watch('good'); await settle(); stop()
    ttlMs = 0; hold = true; stop = store.watch('good'); assert.equal(store.getSnapshot().page, null)
  } finally { stop(); store.dispose() }
})

test('a full unpaginated refresh removes batches and images absent from the authoritative response', async () => {
  let changed = false
  const store = createSearchBatchesStore({ pollMs: () => 1000000, async invoke() {
    const current = { ...batch('a'), nextImagePageToken: undefined, images: [image(changed ? 'a-new' : 'a-old')] }
    return page('style', changed ? [current] : [current, batch('b')])
  } })
  const stop = store.watch('style'); await settle()
  try {
    changed = true; store.refresh(); await settle()
    assert.deepEqual(store.getSnapshot().page?.batches.map(row => row.runId), ['a'])
    assert.deepEqual(store.getSnapshot().page?.batches[0]?.images.map(row => row.imageVersionId), ['a-new'])
  } finally { stop(); store.dispose() }
})
