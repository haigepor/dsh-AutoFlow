import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDatasetStore } from '../src/client/dataset-store.ts'
import { datasetEntrySchema } from '../src/shared/datasets.ts'

const row = (status = 'running') => datasetEntrySchema.parse({ id: 'dataset-run', runId: 'dataset-run', styleId: 'collection', name: 'Collection', modelProfileId: 'profile', profileRevision: 1, model: 'fixture', contentDigest: 'digest', createdAt: '2026-10-28T00:00:00Z', status, counts: { references: 10, rules: 7, candidates: 14, groups: 5, enabledGroups: 3, files: status === 'completed' ? 5 : 0 } })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept }); return { promise, resolve } }
const settle = async () => { await new Promise<void>(resolve => setImmediate(resolve)) }

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
