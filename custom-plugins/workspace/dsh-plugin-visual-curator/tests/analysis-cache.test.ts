import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAnalysisDetailCache } from '../src/client/analysis-detail-cache.ts'
import { analysisDetailSchema } from '../src/shared/analysis-process.ts'
import { createCuratorStore } from '../src/client/store.ts'
import { resolveCurrentConfig, limitsSchema } from '../src/host/config.ts'
import type { CuratorSnapshot } from '../src/client/contract.ts'

const detail = (runId = 'run', status = 'completed') => analysisDetailSchema.parse({ task: { runId, styleId: 's', name: 'Saved analysis', status, observed: 1, total: 1, model: 'vision', reasoningEffort: null, attempts: 1, startedAt: 'now', phase: status === 'running' ? 'receiving' : 'completed', autoResume: false }, observations: [] })
const input = { requestId: 'request', instructions: 'Saved instructions', inputText: 'Saved input', images: [] }
const snapshot = (): CuratorSnapshot => ({ styles: [], images: [], runs: [], usages: [], splits: [], evaluations: [], exports: [], suggestions: [], configuration: { ...resolveCurrentConfig({}), revision: 'config', sourceConfigured: false, visionConfigured: true, sourceCredentialConfigured: false, visionCredentialConfigured: false } })

test('cache lifetime starts at the successful read and is not extended by reopening or retained input', () => {
  const cache = createAnalysisDetailCache(), saved = detail()
  cache.save(saved, {}, 1_000)
  assert.equal(cache.read('run', 60_000, 60_999)?.detail, saved)
  cache.update(saved, {})
  assert.equal(cache.read('run', 60_000, 61_000), undefined)
  cache.save(saved, {}, 1_000)
  assert.equal(cache.read('run', 0, 1_001), undefined)
  cache.save(saved, {}, 1_000)
  assert.equal(cache.read('run', 60_000, 999), undefined)
})

test('cache keeps one task, marks newer task facts stale and can revoke a specific run or the whole scope', () => {
  const cache = createAnalysisDetailCache(), saved = detail()
  cache.save(saved, {}, 1_000)
  assert.equal(cache.read('another', 60_000, 1_001), undefined)
  assert.equal(cache.read('run', 60_000, 1_001, { ...saved.task, status: 'running' })?.stale, true)
  cache.save(saved, {}, 1_000); cache.save(detail('another'), {}, 1_001)
  assert.equal(cache.read('run', 60_000, 1_002), undefined)
  cache.invalidate('another')
  assert.equal(cache.read('another', 60_000, 1_002), undefined)
  cache.save(saved, {}, 1_000); cache.invalidate()
  assert.equal(cache.read('run', 60_000, 1_001), undefined)
})

test('a live completion frame cannot make unrefreshed observations look like a fresh completed detail', () => {
  const cache = createAnalysisDetailCache(), saved = detail('run', 'running')
  cache.save(saved, {}, 1000)
  const completed = { ...saved, task: { ...saved.task, status: 'completed' as const } }
  cache.update(completed, {})
  assert.equal(cache.read('run', 60000, 1001, completed.task)?.stale, true)
  cache.save(completed, {}, 1002)
  assert.equal(cache.read('run', 60000, 1003, completed.task)?.stale, undefined)
})

test('reopening a completed dialog immediately restores detail and inputs without another read; explicit refresh invalidates it', async () => {
  let reads = 0, inputs = 0
  const store = createCuratorStore({ invoke: async operation => {
    if (operation === 'snapshot') return snapshot()
    if (operation === 'analysis-input') { inputs++; return input }
    if (operation === 'analysis-detail') { reads++; return detail() }
    throw new Error(`Unexpected ${operation}`)
  } })
  try {
    await store.reload(); store.openAnalysis('run'); await store.refreshAnalysisDetail(); await store.loadAnalysisInput('request')
    store.closeAnalysis(); store.openAnalysis('run')
    assert.equal(store.getSnapshot().analysisLoading, false)
    assert.equal(store.getSnapshot().analysisDetail?.task.runId, 'run')
    assert.equal(store.getSnapshot().analysisInputs.request?.inputText, 'Saved input')
    await store.loadAnalysisInput('request')
    assert.deepEqual({ reads, inputs }, { reads: 1, inputs: 1 })
    store.closeAnalysis(); await store.reload(); store.openAnalysis('run'); await store.refreshAnalysisDetail()
    assert.equal(reads, 2)
  } finally { store.dispose() }
})

test('reopening running tasks restores their view while still fetching current progress', async () => {
  let reads = 0
  const store = createCuratorStore({ invoke: async operation => operation === 'snapshot' ? snapshot() : { ...detail('run', 'running'), observations: [], task: { ...detail('run', 'running').task, observed: ++reads } } })
  try {
    await store.reload(); store.openAnalysis('run'); await store.refreshAnalysisDetail(); store.closeAnalysis(); store.openAnalysis('run')
    assert.equal(store.getSnapshot().analysisLoading, false)
    assert.equal(store.getSnapshot().analysisDetail?.task.observed, 1)
    await store.refreshAnalysisDetail()
    assert.equal(store.getSnapshot().analysisDetail?.task.observed, 2)
    assert.equal(reads, 2)
  } finally { store.dispose() }
})

test('scope changes and late aborted reads never revive cached private details', async () => {
  let reads = 0, finish!: (value: unknown) => void, hold = false
  const pending = new Promise(resolve => { finish = resolve })
  const store = createCuratorStore({ invoke: async operation => {
    if (operation === 'snapshot') return snapshot()
    if (operation === 'analysis-detail') { reads++; return hold ? pending : detail() }
    return { tasks: [], analyses: [] }
  } })
  try {
    await store.reload(); store.openAnalysis('run'); await store.refreshAnalysisDetail(); store.closeAnalysis(); store.closeSession(); await store.reload()
    hold = true; store.openAnalysis('run'); const reading = store.refreshAnalysisDetail()
    assert.equal(store.getSnapshot().analysisLoading, true)
    store.closeAnalysis(); finish(detail()); await reading
    hold = false; store.openAnalysis('run'); await store.refreshAnalysisDetail()
    assert.equal(reads, 3)
  } finally { finish(detail()); store.dispose() }
})

test('a configurable nonnegative cache lifetime defaults to one minute', () => {
  assert.equal(limitsSchema.parse({}).analysisCacheTtlMs, 60_000)
  assert.equal(limitsSchema.parse({ analysisCacheTtlMs: 0 }).analysisCacheTtlMs, 0)
  for (const value of [-1, 0.5]) assert.equal(limitsSchema.safeParse({ analysisCacheTtlMs: value }).success, false)
})

test('a failed refresh retains the cached result and revalidates it when reopened', async () => {
  let reads = 0, fail = false
  const store = createCuratorStore({ invoke: async operation => {
    if (operation === 'snapshot') return snapshot()
    reads++
    if (fail) throw new Error('offline')
    return detail()
  } })
  try {
    await store.reload(); store.openAnalysis('run'); await store.refreshAnalysisDetail()
    fail = true; await store.refreshAnalysisDetail()
    assert.equal(store.getSnapshot().analysisDetail?.task.runId, 'run')
    assert.ok(store.getSnapshot().analysisError)
    store.closeAnalysis(); fail = false; store.openAnalysis('run')
    assert.equal(store.getSnapshot().analysisLoading, false)
    assert.equal(store.getSnapshot().analysisDetail?.task.runId, 'run')
    await store.refreshAnalysisDetail()
    assert.equal(reads, 3)
  } finally { store.dispose() }
})

test('an owner rejection clears cached scope data and a mismatched task response is never admitted', async () => {
  let denied = false, foreign = false
  const store = createCuratorStore({ invoke: async operation => {
    if (operation === 'session-open') return { sessionToken: 'authorized-scope' }
    if (denied) throw { code: 'owner-denied', safeMessage: 'Scope expired', suggestedAction: 'Reopen the task' }
    if (operation === 'snapshot') return snapshot()
    if (operation === 'analysis-detail') return detail(foreign ? 'foreign' : 'run')
    return { tasks: [], analyses: [] }
  } })
  try {
    await store.openSession('session'); store.openAnalysis('run'); await store.refreshAnalysisDetail(); store.closeAnalysis()
    denied = true; store.openAnalysis('run'); await store.refreshAnalysisDetail()
    assert.equal(store.getSnapshot().sessionToken, '')
    assert.equal(store.getSnapshot().analysisDetail, null)
    denied = false; foreign = true; store.openAnalysis('run')
    assert.equal(store.getSnapshot().analysisLoading, true)
    await store.refreshAnalysisDetail()
    assert.equal(store.getSnapshot().analysisDetail, null)
    assert.ok(store.getSnapshot().analysisError)
  } finally { store.dispose() }
})
