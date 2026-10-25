/** Parallel collection analysis must not freeze the search or crop being viewed. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCuratorStore } from '../src/client/store.ts'
import { resolveCurrentConfig } from '../src/host/config.ts'
import { createGalleryCache } from '../src/client/gallery-cache.ts'
import type { CuratorSnapshot, ImageView, RunView } from '../src/client/contract.ts'

test('selected search and followed crop receive results while another collection keeps analyzing', async () => {
  const configuration = { ...resolveCurrentConfig({}), revision: 'config', sourceConfigured: true, visionConfigured: true, sourceCredentialConfigured: false, visionCredentialConfigured: false }
  const search: RunView = { runId: 'search', kind: 'search', status: 'running', taskBrief: 'A landscape', counts: { reviewed: 0 }, results: [], warnings: [] }
  const crop: RunView = { runId: 'crop', kind: 'crop', status: 'running', taskBrief: 'A vertical crop', counts: { reviewed: 0 }, results: [], warnings: [] }
  const image = (imageVersionId: string): ImageView => ({ imageVersionId, assetId: 'asset', familyId: 'family', width: 100, height: 100, kind: 'normalized', previewPath: `/api/visual-curator/resource?imageVersionId=${imageVersionId}`, name: imageVersionId, source: 'fixture', exportPermission: 'references-only', groupingStatus: 'confirmed' })
  const snapshot: CuratorSnapshot = { collectionPaging: true, workspaceRevision: 'before', configuration, styles: [], images: [], runs: [search, crop], usages: [], splits: [], evaluations: [], exports: [], suggestions: [] }
  let settled = false, snapshots = 0, runReads = 0
  const store = createCuratorStore({ invoke: async (operation, args) => {
    if (operation === 'snapshot') { snapshots++; return snapshot }
    if (operation === 'run-get') {
      runReads++
      const run = args.runId === 'search' ? search : crop
      return settled ? { ...run, status: 'completed', counts: { reviewed: 1 }, results: [image(String(args.runId) + '-result')] } : run
    }
    if (operation === 'gallery-reference-tasks') return { tasks: [], workspaceRevision: 'after-results', analyses: [{ runId: 'analysis', styleId: 'other-collection', name: 'Other collection', status: 'running', observed: 2, total: 20, model: 'fixture', reasoningEffort: 'high', attempts: 1, startedAt: '2026-10-25T00:00:00.000Z', phase: 'receiving', autoResume: true }] }
    throw new Error(`Unexpected operation: ${operation}`)
  } })
  try {
    await store.reload()
    store.selectCandidate('original')
    await store.followCrop('crop', store.getSnapshot().cropSelection)
    settled = true
    await store.refreshGalleryTasks()
    const state = store.getSnapshot()
    for (const id of ['search', 'crop']) {
      const run = state.snapshot?.runs.find(item => item.runId === id)
      assert.equal(run?.status, 'completed', `${id} must update before the other collection analysis ends`)
      assert.deepEqual(run?.results.map(item => item.imageVersionId), [id + '-result'])
    }
    assert.equal(state.analysisTasks[0]?.status, 'running')
    assert.equal(state.runId, 'search')
    assert.equal(state.cropRunId, 'crop')
    assert.equal(snapshots, 1, 'parallel progress does not require rebuilding the complete workspace')
    const readsAfterCompletion = runReads
    await store.refreshGalleryTasks()
    assert.equal(runReads, readsAfterCompletion, 'settled viewed tasks must not be fetched on every analysis poll')
    assert.equal(snapshots, 1)
  } finally { store.dispose() }
})

test('gallery memory cache evicts old pages when browser storage is unavailable', async () => {
  let reads = 0
  const cache = createGalleryCache({ context: () => ({ namespace: 'isolated', revision: 'one', accounts: [], policy: { ttlMs: 10000, maxPages: 1, maxBytes: 10000 } }), now: () => 1,
    read: async () => { reads++; return { items: [{ id: String(reads), title: 'Folder', description: '', private: false, totalPhotos: 1 }], nextCursor: null } } })
  const signal = new AbortController().signal
  try {
    await cache.read('gallery-collections', {}, signal)
    await cache.read('gallery-collections', { cursor: 'next' }, signal)
    await cache.read('gallery-collections', {}, signal)
    assert.equal(reads, 3, 'the first page must be evicted from memory after reaching maxPages')
  } finally { cache.dispose() }
})

test('gallery memory cache does not retain a page larger than maxBytes without browser storage', async () => {
  let reads = 0
  const cache = createGalleryCache({ context: () => ({ namespace: 'isolated', revision: 'one', accounts: [], policy: { ttlMs: 10000, maxPages: 10, maxBytes: 10 } }), now: () => 1,
    read: async () => { reads++; return { items: [{ id: String(reads), title: 'Folder', description: '', private: false, totalPhotos: 1 }], nextCursor: null } } })
  const signal = new AbortController().signal
  try {
    await cache.read('gallery-collections', {}, signal)
    await cache.read('gallery-collections', {}, signal)
    assert.equal(reads, 2, 'an oversized page must not become an unbounded in-memory cache entry')
  } finally { cache.dispose() }
})

test('a refreshed search adopts the new ranking and discards pages from the old cursor generation', async () => {
  const configuration = { ...resolveCurrentConfig({}), revision: 'config', sourceConfigured: true, visionConfigured: true, sourceCredentialConfigured: false, visionCredentialConfigured: false }
  const image = (imageVersionId: string, reason = imageVersionId): ImageView => ({ imageVersionId, assetId: imageVersionId, familyId: imageVersionId, width: 100, height: 100, kind: 'normalized', previewPath: `/api/visual-curator/resource?imageVersionId=${imageVersionId}`, name: imageVersionId, reason, source: 'fixture', exportPermission: 'references-only', groupingStatus: 'confirmed' })
  const run: RunView = { runId: 'search', kind: 'search', status: 'running', taskBrief: 'Ranked candidates', counts: {}, results: [], warnings: [] }
  const snapshot: CuratorSnapshot = { configuration, styles: [], images: [], runs: [run], usages: [], splits: [], evaluations: [], exports: [], suggestions: [] }
  let revised = false
  const store = createCuratorStore({ invoke: async (operation, args) => {
    if (operation === 'snapshot') return snapshot
    if (args.pageToken) return { ...run, results: [image(revised ? 'new-tail' : 'old-tail')] }
    return revised ? { ...run, results: [image('high', 'Best current match'), image('low', 'Lower current match')], pageToken: 'new-order' }
      : { ...run, results: [image('low'), image('high')], pageToken: 'old-order' }
  } })
  try {
    await store.reload()
    await store.loadRun('search', true)
    assert.deepEqual(store.getSnapshot().snapshot?.runs[0]?.results.map(image => image.imageVersionId), ['low', 'high', 'old-tail'])
    revised = true
    await store.loadRun('search')
    const refreshed = store.getSnapshot().snapshot?.runs[0]
    assert.deepEqual(refreshed?.results.map(image => image.imageVersionId), ['high', 'low'])
    assert.equal(refreshed?.results[0]?.reason, 'Best current match')
    assert.equal(refreshed?.pageToken, 'new-order')
    await store.loadRun('search', true)
    assert.deepEqual(store.getSnapshot().snapshot?.runs[0]?.results.map(image => image.imageVersionId), ['high', 'low', 'new-tail'])
  } finally { store.dispose() }
})

test('a stable search cursor refreshes result fields while retaining loaded pages and their next cursor', async () => {
  const configuration = { ...resolveCurrentConfig({}), revision: 'config', sourceConfigured: true, visionConfigured: true, sourceCredentialConfigured: false, visionCredentialConfigured: false }
  const image = (imageVersionId: string, reason = imageVersionId): ImageView => ({ imageVersionId, assetId: imageVersionId, familyId: imageVersionId, width: 100, height: 100, kind: 'normalized', previewPath: `/api/visual-curator/resource?imageVersionId=${imageVersionId}`, name: imageVersionId, reason, source: 'fixture', exportPermission: 'references-only', groupingStatus: 'confirmed' })
  const run: RunView = { runId: 'search', kind: 'search', status: 'running', taskBrief: 'Stable candidates', counts: {}, results: [], warnings: [] }
  const snapshot: CuratorSnapshot = { configuration, styles: [], images: [], runs: [run], usages: [], splits: [], evaluations: [], exports: [], suggestions: [] }
  let revised = false
  const store = createCuratorStore({ invoke: async (operation, args) => {
    if (operation === 'snapshot') return snapshot
    if (args.pageToken === 'after-first') return { ...run, results: [image('second')], pageToken: 'after-second' }
    if (args.pageToken === 'after-second') return { ...run, results: [image('third')] }
    return { ...run, results: [image('first', revised ? 'Fresh explanation' : 'Old explanation')], pageToken: 'after-first' }
  } })
  try {
    await store.reload()
    await store.loadRun('search', true)
    revised = true
    await store.loadRun('search')
    const refreshed = store.getSnapshot().snapshot?.runs[0]
    assert.deepEqual(refreshed?.results.map(image => image.imageVersionId), ['first', 'second'])
    assert.equal(refreshed?.results[0]?.reason, 'Fresh explanation')
    assert.equal(refreshed?.pageToken, 'after-second')
    await store.loadRun('search', true)
    assert.deepEqual(store.getSnapshot().snapshot?.runs[0]?.results.map(image => image.imageVersionId), ['first', 'second', 'third'])
  } finally { store.dispose() }
})
