import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { profileProjectionFixture } from './helpers/profile-projection-fixture.ts'
import { createCuratorStore } from '../src/client/store.ts'

const samples = z.object({ samples: z.array(z.json()) })
const style = z.object({ styleId: z.string(), evidenceLoaded: z.boolean().optional(), analysis: samples.optional(), modelProfile: samples.optional() })

test('workspace summaries omit image observations while style details retain every positive and negative sample', async () => {
  const f = await profileProjectionFixture(40, 2)
  try {
    const full = z.object({ styles: z.array(style) }).parse(await f.action('snapshot'))
    const reads: string[] = [], get = f.repository.get.bind(f.repository)
    f.repository.get = (...args) => { if (args[0] === 'observation') reads.push(args[1]); return get(...args) }
    const compact = z.object({ styles: z.array(style) }).parse(await f.action('snapshot', { includeStyleSamples: false }))
    assert.deepEqual(compact.styles.map(item => item.styleId), full.styles.map(item => item.styleId))
    assert.ok(compact.styles.every(item => item.evidenceLoaded === false && !item.analysis?.samples.length && !item.modelProfile?.samples.length))
    assert.equal(reads.length, 0, 'A summary must not decode observations that are not requested')
    const detail = style.parse(await f.action('style-get', { styleId: f.styleIds[0]! }))
    assert.equal(detail.modelProfile!.samples.length, 40)
    assert.deepEqual(detail, full.styles.find(item => item.styleId === detail.styleId))
  } finally { await f.cleanup() }
})

test('style listing projects only the requested page and preserves full detail fields', async () => {
  const f = await profileProjectionFixture(16, 3)
  try {
    const get = f.repository.get.bind(f.repository), observationIds = new Set<string>()
    f.repository.get = (...args) => { if (args[0] === 'observation') observationIds.add(args[1]); return get(...args) }
    const page = z.object({ items: z.array(style), pageToken: z.string() }).parse(await f.action('style-list', { pageSize: 1 }))
    assert.equal(page.items[0]!.styleId, f.styleIds[0])
    assert.equal(observationIds.size, 16, 'Other collection pages must not decode their observations')
    assert.deepEqual(page.items[0], style.parse(await f.action('style-get', { styleId: f.styleIds[0]! })))
    const next = z.object({ items: z.array(style) }).parse(await f.action('style-list', { pageSize: 1, pageToken: page.pageToken }))
    assert.equal(next.items[0]!.styleId, f.styleIds[1])
  } finally { await f.cleanup() }
})

test('opening a profile loads evidence once and later workspace refreshes retain it for the same analysis', async () => {
  const f = await profileProjectionFixture(30)
  const reads: string[] = [], store = createCuratorStore({ invoke: (operation, args) => { reads.push(operation); return f.action(operation, args) } })
  try {
    await store.reload()
    const styleId = f.styleIds[0]!, summary = store.getSnapshot().snapshot!.styles.find(item => item.styleId === styleId)!
    assert.equal(summary.evidenceLoaded, false)
    assert.equal(summary.modelProfile!.samples.length, 0)
    reads.length = 0
    await store.reconcileProfile(styleId)
    const loaded = store.getSnapshot().snapshot!.styles.find(item => item.styleId === styleId)!
    assert.deepEqual(reads, ['style-get'])
    assert.equal(loaded.modelProfile!.samples.length, 30)
    assert.equal(loaded.modelProfile!.samples.filter(item => item.role === 'negative').length, 3)
    await store.reload()
    const refreshed = store.getSnapshot().snapshot!.styles.find(item => item.styleId === styleId)!
    assert.strictEqual(refreshed.modelProfile!.samples, loaded.modelProfile!.samples)
    reads.length = 0
    await store.reconcileProfile(styleId)
    assert.deepEqual(reads, ['profile-current'])
    assert.strictEqual(store.getSnapshot().snapshot!.styles.find(item => item.styleId === styleId)!.modelProfile!.samples, loaded.modelProfile!.samples)
  } finally { store.dispose(); await f.cleanup() }
})

test('a new completed analysis invalidates previously loaded evidence before reopening the dialog', async () => {
  const f = await profileProjectionFixture(12), store = createCuratorStore({ invoke: f.action })
  try {
    const styleId = f.styleIds[0]!
    await store.reload(); await store.reconcileProfile(styleId)
    const original = store.getSnapshot().snapshot!.styles.find(item => item.styleId === styleId)!
    await f.action('reference-analyze', { operationId: 'new-projection-analysis', styleId, buildDataset: true }); await f.jobs.drain()
    await store.reload()
    const summary = store.getSnapshot().snapshot!.styles.find(item => item.styleId === styleId)!
    assert.notEqual(summary.modelProfile!.analysisRunId, original.modelProfile!.analysisRunId)
    assert.equal(summary.evidenceLoaded, false)
    assert.equal(summary.modelProfile!.samples.length, 0)
    await store.reconcileProfile(styleId)
    assert.equal(store.getSnapshot().snapshot!.styles.find(item => item.styleId === styleId)!.modelProfile!.samples.length, 12)
  } finally { store.dispose(); await f.cleanup() }
})

test('a delayed profile detail cannot overwrite newer collection metadata', async () => {
  const f = await profileProjectionFixture(8)
  let release!: () => void, ready!: () => void, hold = true
  const gate = new Promise<void>(resolve => { release = resolve }), waiting = new Promise<void>(resolve => { ready = resolve })
  const store = createCuratorStore({ invoke: async (operation, args) => {
    const value = await f.action(operation, args)
    if (operation === 'style-get' && hold) { ready(); await gate }
    return value
  } })
  let loading: Promise<void> | undefined
  try {
    const styleId = f.styleIds[0]!
    await store.reload(); loading = store.reconcileProfile(styleId); await waiting
    await f.action('style-rename', { operationId: 'projection-rename', styleId, expectedRevision: 1, name: 'Newer collection name' })
    await store.reload(); release()
    await assert.rejects(loading, /revision-conflict/)
    const current = store.getSnapshot().snapshot!.styles.find(item => item.styleId === styleId)!
    assert.equal(current.name, 'Newer collection name')
    assert.equal(current.evidenceLoaded, false)
    hold = false; await store.reconcileProfile(styleId)
    assert.equal(store.getSnapshot().snapshot!.styles.find(item => item.styleId === styleId)!.modelProfile!.samples.length, 8)
  } finally { release(); await loading?.catch(() => {}); store.dispose(); await f.cleanup() }
})
