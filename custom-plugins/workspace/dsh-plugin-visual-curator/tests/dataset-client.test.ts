import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDatasetStore } from '../src/client/dataset-store.ts'
import { datasetEntrySchema } from '../src/shared/datasets.ts'

const row = (status = 'running') => datasetEntrySchema.parse({ id: 'dataset-run', runId: 'dataset-run', styleId: 'collection', name: 'Collection', modelProfileId: 'profile', profileRevision: 1, model: 'fixture', contentDigest: 'digest', sampleScope: 'all', createdAt: '2026-10-28T00:00:00Z', status, counts: { references: 10, positive: 8, negative: 2, undecided: 0, rules: 7, candidates: 14, groups: 5, enabledGroups: 3, files: status === 'completed' ? 5 : 0 } })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept }); return { promise, resolve } }
const settle = async () => { await new Promise<void>(resolve => setImmediate(resolve)) }

function cachedDetail(role: 'all' | 'negative', more = false) {
  return { entry: { ...row('completed'), exportId: 'frozen-export' }, summary: '', matchingPrompt: '', rules: [], groups: [], files: [], resources: { remote: 0, total: 2, pixelDigests: 0, humanAccepts: 0 }, sampleTotal: role === 'all' ? 2 : 1,
    samples: [{ referenceId: role === 'negative' ? 'negative' : more ? 'second' : 'first', imageVersionId: 'image', role: role === 'negative' ? 'negative' : 'positive', unavailable: false, measuredCount: 0, observations: [] }], ...(role === 'all' && !more ? { nextSamplePageToken: 'tail' } : {}) }
}

test('completed detail pages survive dialog closure and role switches without resetting loaded samples', async () => {
  const calls: unknown[] = [], store = createDatasetStore({ context: () => ({ scope: 1, styleId: 'collection' }), cachePolicy: () => ({ ttlMs: 1000, maxViews: 4, maxBytes: 100000, resourceTtlMs: 2000 }), invoke: async (operation, args) => {
    if (operation === 'datasets-list') return { styleId: 'collection', total: 1, allTotal: 1, entries: [{ ...row('completed'), exportId: 'frozen-export' }] }
    calls.push(args); return cachedDetail(args.sampleRole === 'negative' ? 'negative' : 'all', !!args.pageToken)
  } })
  try {
    store.sync(); await settle(); await store.open('dataset-run'); await store.moreSamples()
    for (let index = 0; index < 10; index++) {
      await store.filterSamples('negative'); assert.equal(store.getSnapshot().detail!.samples[0]!.role, 'negative')
      await store.filterSamples('all'); assert.deepEqual(store.getSnapshot().detail!.samples.map(sample => sample.referenceId), ['first', 'second'])
      store.closeDetail(); await store.open('dataset-run')
    }
    assert.equal(calls.length, 3, 'Only the all-role first/tail pages and negative first page need transport reads')
    await store.refresh(); store.closeDetail(); await store.open('dataset-run'); assert.equal(calls.length, 4, 'Explicit refresh invalidates completed detail reuse')
  } finally { store.dispose() }
})

test('appending a detail page does not extend earlier resource authorization lifetime', async () => {
  let time = 1000
  const cursors: unknown[] = [], store = createDatasetStore({ context: () => ({ scope: 1, styleId: 'collection' }), now: () => time, cachePolicy: () => ({ ttlMs: 1000, maxViews: 4, maxBytes: 100000, resourceTtlMs: 100 }), invoke: async (operation, args) => {
    if (operation === 'datasets-list') return { styleId: 'collection', total: 1, allTotal: 1, entries: [{ ...row('completed'), exportId: 'frozen-export' }] }
    cursors.push(args.pageToken); return cachedDetail('all', !!args.pageToken)
  } })
  try {
    store.sync(); await settle(); await store.open('dataset-run'); time = 1080; await store.moreSamples()
    store.closeDetail(); time = 1100; await store.open('dataset-run')
    assert.deepEqual(cursors, [undefined, 'tail', undefined]); assert.deepEqual(store.getSnapshot().detail!.samples.map(sample => sample.referenceId), ['first'])
    time = 1200; await store.moreSamples()
    assert.deepEqual(cursors, [undefined, 'tail', undefined, undefined], 'An expired live detail reloads page one instead of appending to stale grants')
  } finally { store.dispose() }
})

test('detail reuse obeys view and byte budgets, TTL and owner scope', async () => {
  let scope = 1, reads = 0, time = 1000, maxBytes = 100000
  const store = createDatasetStore({ context: () => ({ scope, styleId: 'collection' }), now: () => time, cachePolicy: () => ({ ttlMs: 100, maxViews: 1, maxBytes, resourceTtlMs: 1000 }), invoke: async (operation, args) => {
    if (operation === 'datasets-list') return { styleId: 'collection', total: 1, allTotal: 1, entries: [{ ...row('completed'), exportId: 'frozen-export' }] }
    reads++; return cachedDetail(args.sampleRole === 'negative' ? 'negative' : 'all')
  } })
  try {
    store.sync(); await settle(); await store.open('dataset-run'); await store.filterSamples('negative'); await store.filterSamples('all'); assert.equal(reads, 3, 'The older role is evicted at one view')
    store.closeDetail(); time += 100; await store.open('dataset-run'); assert.equal(reads, 4, 'TTL equality expires a cached view')
    scope++; store.sync(); await settle(); await store.open('dataset-run'); assert.equal(reads, 5)
    maxBytes = 1; store.closeDetail(); await store.open('dataset-run'); store.closeDetail(); await store.open('dataset-run'); assert.equal(reads, 7, 'Oversized details remain readable but are not retained in cache')
  } finally { store.dispose() }
})

test('submission observation survives view closure before acknowledgement and follows the same Host run', async () => {
  const acknowledgement = deferred<unknown>(), calls: string[] = []
  let accepted = false
  const store = createDatasetStore({ context: () => ({ scope: 1, styleId: 'collection' }), operationId: () => 'once', invoke: async operation => {
    calls.push(operation)
    if (operation === 'export-start') return acknowledgement.promise
    return { styleId: 'collection', total: accepted ? 1 : 0, allTotal: accepted ? 1 : 0, entries: accepted ? [row()] : [] }
  } })
  try {
    store.sync(); await settle()
    const work = store.start({ id: 'profile', styleId: 'collection' })
    assert.equal(store.getSnapshot().submissions[0]?.status, 'submitting')
    // 关闭弹窗只卸载视图，不会调用 store.dispose 或丢弃提交状态。
    accepted = true; acknowledgement.resolve({ runId: 'dataset-run' }); await work
    assert.equal(store.getSnapshot().submissions.length, 0)
    assert.equal(store.getSnapshot().entries[0]?.id, 'dataset-run')
    await store.start({ id: 'profile', styleId: 'collection' })
    assert.equal(calls.filter(operation => operation === 'export-start').length, 1)
  } finally { store.dispose() }
})

test('unknown acknowledgements require explicit retry with the original operation identity', async () => {
  const ids: unknown[] = []
  let attempts = 0
  const store = createDatasetStore({ context: () => ({ scope: 1, styleId: 'collection' }), operationId: () => 'stable', invoke: async (operation, args) => {
    if (operation === 'export-start') { ids.push(args.operationId); if (++attempts === 1) throw new Error('connection interrupted'); return { runId: 'dataset-run' } }
    return { styleId: 'collection', total: 1, allTotal: 1, entries: attempts > 1 ? [row()] : [] }
  } })
  try {
    store.sync(); await settle()
    await store.start({ id: 'profile', styleId: 'collection' })
    assert.equal(store.getSnapshot().submissions[0]?.status, 'unknown')
    await store.refresh(); assert.equal(attempts, 1)
    await store.start({ id: 'profile', styleId: 'collection' })
    assert.deepEqual(ids, ['stable', 'stable'])
  } finally { store.dispose() }
})

test('owner changes discard private caches and late acknowledgements cannot restore them', async () => {
  let scope = 1, styleId = 'collection'
  const acknowledgement = deferred<unknown>()
  const store = createDatasetStore({ context: () => ({ scope, styleId }), invoke: async operation => operation === 'export-start' ? acknowledgement.promise : { styleId: 'collection', total: 0, allTotal: 0, entries: [] } })
  try {
    store.sync(); await settle()
    const work = store.start({ id: 'profile', styleId })
    scope++; styleId = ''; store.sync(); acknowledgement.resolve({ runId: 'dataset-run' }); await work
    assert.equal(store.getSnapshot().styleId, '')
    assert.equal(store.getSnapshot().submissions.length, 0)
    assert.equal(store.getSnapshot().entries.length, 0)
  } finally { store.dispose() }
})

test('read failures retain saved rows and filters discard stale collection responses', async () => {
  let fail = false
  const delayed = deferred<unknown>()
  const store = createDatasetStore({ context: () => ({ scope: 1, styleId: 'collection' }), invoke: async (operation, args) => {
    if (fail) throw new Error('read unavailable')
    if (args.query === 'old') return delayed.promise
    return { styleId: 'collection', total: 1, allTotal: 1, entries: [row('completed')] }
  } })
  try {
    store.sync(); await settle(); fail = true; await store.refresh()
    assert.equal(store.getSnapshot().error, true)
    assert.equal(store.getSnapshot().pageIds.length, 1)
    fail = false; store.filter('old', 'all'); store.filter('new', 'completed'); await settle()
    delayed.resolve({ styleId: 'collection', total: 0, allTotal: 0, entries: [] }); await settle()
    assert.equal(store.getSnapshot().query, 'new')
    assert.equal(store.getSnapshot().pageIds.length, 1)
  } finally { store.dispose() }
})

test('a fresh workbench restores an active Host task without generating again and recovers metadata errors', async () => {
  let fail = false, starts = 0
  const store = createDatasetStore({ context: () => ({ scope: 1, styleId: 'collection' }), invoke: async operation => {
    if (operation === 'export-start') starts++
    if (fail) throw new Error('metadata interrupted')
    return { styleId: 'collection', total: 1, allTotal: 1, entries: [row()] }
  } })
  try {
    store.sync(); await settle()
    assert.equal(store.needsPoll(), true)
    assert.equal(store.getSnapshot().entries[0]?.runId, 'dataset-run')
    assert.equal(starts, 0)
    fail = true; await store.poll(); assert.equal(store.getSnapshot().error, true)
    assert.equal(store.getSnapshot().entries[0]?.status, 'running')
    fail = false; await store.poll(); assert.equal(store.getSnapshot().error, false)
    assert.equal(starts, 0)
  } finally { store.dispose() }
})

test('sample pagination admits one page at a time, keeps observations after failure, and retries the same cursor', async () => {
  const pageGate = deferred<void>(), cursors: unknown[] = []
  let fail = true
  const detail = (ids: string[], nextSamplePageToken?: string) => ({ entry: row('completed'), summary: '', matchingPrompt: '', rules: [], groups: [], files: [], resources: { remote: 3, total: 3, pixelDigests: 0, humanAccepts: 0 }, sampleTotal: 3, samples: ids.map(referenceId => ({ referenceId, imageVersionId: `image-${referenceId}`, role: 'positive', unavailable: false, measuredCount: 0, observations: [{ field: 'color', value: referenceId, uncertain: false }] })), ...(nextSamplePageToken ? { nextSamplePageToken } : {}) })
  const store = createDatasetStore({ context: () => ({ scope: 1, styleId: 'collection' }), invoke: async (operation, args) => {
    if (operation === 'datasets-list') return { styleId: 'collection', total: 1, allTotal: 1, entries: [row('completed')] }
    cursors.push(args.pageToken)
    if (!args.pageToken) return detail(['one', 'two'], 'last-page')
    if (fail) { await pageGate.promise; throw new Error('page interrupted') }
    return detail(['three'])
  } })
  try {
    store.sync(); await settle(); await store.open('dataset-run')
    const pending = store.moreSamples(); await store.moreSamples()
    assert.deepEqual(cursors, [undefined, 'last-page'], 'scrolling repeatedly must not request the same pending page twice')
    pageGate.resolve(); await pending
    assert.equal(store.getSnapshot().detailError, true)
    assert.deepEqual(store.getSnapshot().detail?.samples.map(sample => sample.referenceId), ['one', 'two'])
    assert.equal(store.getSnapshot().detail?.nextSamplePageToken, 'last-page')
    fail = false; await store.moreSamples(); await store.moreSamples()
    assert.deepEqual(cursors, [undefined, 'last-page', 'last-page'])
    assert.deepEqual(store.getSnapshot().detail?.samples.map(sample => sample.referenceId), ['one', 'two', 'three'])
    assert.equal(store.getSnapshot().detailError, false); assert.equal(store.getSnapshot().detail?.nextSamplePageToken, undefined)
  } finally { store.dispose() }
})

test('each export scope retains its own unknown acknowledgement and retry identity', async () => {
  let sequence = 0
  const calls: { scope: unknown; id: unknown }[] = []
  const store = createDatasetStore({ context: () => ({ scope: 1, styleId: 'collection' }), operationId: () => `scope-${++sequence}`, invoke: async (operation, args) => {
    if (operation === 'export-start') { calls.push({ scope: args.sampleScope, id: args.operationId }); throw new Error('reply lost') }
    return { styleId: 'collection', total: 0, allTotal: 0, entries: [] }
  } })
  try {
    store.sync(); await settle()
    await store.start({ id: 'profile', styleId: 'collection', sampleScope: 'negative' })
    await store.start({ id: 'profile', styleId: 'collection', sampleScope: 'positive' })
    await store.start({ id: 'profile', styleId: 'collection', sampleScope: 'negative' })
    assert.deepEqual(calls, [{ scope: 'negative', id: 'scope-1' }, { scope: 'positive', id: 'scope-2' }, { scope: 'negative', id: 'scope-1' }])
    assert.equal(store.getSnapshot().submissions.length, 2)
  } finally { store.dispose() }
})

test('opening a saved package retains the latest-version marker from its list projection', async () => {
  const store = createDatasetStore({ context: () => ({ scope: 1, styleId: 'collection' }), invoke: async operation => operation === 'datasets-list' ? { styleId: 'collection', total: 1, allTotal: 1, entries: [{ ...row('completed'), isFinal: true, stale: true }] } : cachedDetail('all') })
  try {
    store.sync(); await settle(); await store.open('dataset-run')
    assert.equal(store.getSnapshot().entries[0]!.isFinal, true)
    assert.equal(store.getSnapshot().detail!.entry.stale, true)
  } finally { store.dispose() }
})

test('role changes retain the current samples and scroll container until the replacement page commits', async () => {
  const pending = Promise.withResolvers<ReturnType<typeof cachedDetail>>()
  const store = createDatasetStore({ context: () => ({ scope: 1, styleId: 'collection' }), invoke: async (operation, args) => operation === 'datasets-list' ? { styleId: 'collection', total: 1, allTotal: 1, entries: [row('completed')] } : args.sampleRole === 'negative' ? pending.promise : cachedDetail('all') })
  try {
    store.sync(); await settle(); await store.open('dataset-run')
    const original = store.getSnapshot().detail
    const changing = store.filterSamples('negative')
    assert.equal(store.getSnapshot().detail, original)
    assert.equal(store.getSnapshot().sampleRole, 'negative')
    assert.equal(store.getSnapshot().detailLoading, true)
    pending.resolve(cachedDetail('negative')); await changing
    assert.equal(store.getSnapshot().sampleRole, 'negative')
    assert.equal(store.getSnapshot().detail!.samples[0]!.role, 'negative')
  } finally { store.dispose() }
})

test('changing a sample role discards a late page from the previous filter', async () => {
  const delayed = deferred<unknown>(), calls: unknown[] = []
  const detail = (role: 'positive' | 'negative') => ({ entry: row('completed'), summary: '', matchingPrompt: '', rules: [], groups: [], files: [], resources: { remote: 0, total: 1, pixelDigests: 0, humanAccepts: 0 }, sampleTotal: 1, samples: [{ referenceId: role, imageVersionId: role, role, unavailable: false, measuredCount: 0, observations: [] }] })
  const store = createDatasetStore({ context: () => ({ scope: 1, styleId: 'collection' }), invoke: async (operation, args) => {
    if (operation === 'datasets-list') return { styleId: 'collection', total: 1, allTotal: 1, entries: [row('completed')] }
    calls.push(args.sampleRole)
    return args.sampleRole === 'all' ? delayed.promise : detail('negative')
  } })
  try {
    store.sync(); await settle()
    const previous = store.open('dataset-run')
    await store.filterSamples('negative')
    delayed.resolve(detail('positive')); await previous
    assert.deepEqual(calls, ['all', 'negative'])
    assert.equal(store.getSnapshot().sampleRole, 'negative')
    assert.deepEqual(store.getSnapshot().detail!.samples.map(row => row.role), ['negative'])
  } finally { store.dispose() }
})
