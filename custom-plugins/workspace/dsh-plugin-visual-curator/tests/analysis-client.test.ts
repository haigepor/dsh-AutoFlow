import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCuratorStore } from '../src/client/store.ts'
import { resolveCurrentConfig } from '../src/host/config.ts'
import type { CuratorSnapshot } from '../src/client/contract.ts'

function snapshot(): CuratorSnapshot {
  return { collectionPaging: true, workspaceRevision: 'initial', styles: [], images: [], runs: [], usages: [], splits: [], evaluations: [], exports: [], suggestions: [], configuration: { ...resolveCurrentConfig({}), revision: 'one', sourceConfigured: false, visionConfigured: true, sourceCredentialConfigured: false, visionCredentialConfigured: false } }
}
test('saving applies the lightweight response without reloading image data and survives navigation', async () => {
  const operations: string[] = []
  let finish!: (value: unknown) => void
  const save = new Promise(resolve => { finish = resolve })
  const store = createCuratorStore({ invoke: async operation => { operations.push(operation); return operation === 'config-save' ? save : snapshot() } })
  try {
    await store.reload()
    const pending = store.saveConfiguration({ revision: 'one', vision: {}, source: {}, limits: {} })
    assert.equal(store.getSnapshot().configSaving, true)
    store.selectWorkspace('styles'); store.selectStyle('another')
    finish({ saved: true, configuration: { ...snapshot().configuration, revision: 'two' } })
    await pending
    assert.equal(store.getSnapshot().styleId, 'another')
    assert.equal(store.getSnapshot().snapshot?.configuration.revision, 'two')
    assert.equal(store.getSnapshot().configSaving, false)
    assert.deepEqual(operations.filter(value => value === 'snapshot'), ['snapshot'])
  } finally { store.dispose() }
})
test('task polling keeps collection selection and does not project all images during analysis', async () => {
  const operations: string[] = []
  const store = createCuratorStore({ invoke: async operation => {
    operations.push(operation)
    if (operation === 'snapshot') return snapshot()
    return { tasks: [], workspaceRevision: 'changed-by-checkpoint', analyses: [{ runId: 'run-a', styleId: 'a', name: 'A', status: 'running', observed: 8, total: 150, model: 'fixture', reasoningEffort: 'low', attempts: 1, startedAt: '2026-10-25', phase: 'receiving', autoResume: true }] }
  } })
  try {
    await store.reload()
    store.selectStyle('b')
    await store.refreshGalleryTasks()
    assert.equal(store.getSnapshot().styleId, 'b')
    assert.equal(store.getSnapshot().analysisTasks[0]?.observed, 8)
    assert.equal(operations.filter(value => value === 'snapshot').length, 1)
  } finally { store.dispose() }
})

test('saved inputs load only on inspection, share in-flight reads and ignore a closed dialog response', async () => {
  let reads = 0, finish!: (value: unknown) => void
  const response = new Promise(resolve => { finish = resolve })
  const store = createCuratorStore({ invoke: async operation => {
    if (operation === 'analysis-input') { reads++; return response }
    if (operation === 'analysis-detail') return { task: { runId: 'run-a', styleId: 'a', name: 'A', status: 'completed', observed: 1, total: 1, model: 'fixture', reasoningEffort: 'high', attempts: 1, startedAt: 'now', phase: 'completed', autoResume: false }, observations: [] }
    return snapshot()
  } })
  try {
    store.openAnalysis('run-a'); await store.refreshAnalysisDetail()
    assert.equal(reads, 0)
    const first = store.loadAnalysisInput('request-a'), second = store.loadAnalysisInput('request-a')
    assert.equal(reads, 1)
    store.closeAnalysis()
    finish({ requestId: 'request-a', instructions: 'saved system', inputText: 'saved user', images: [] })
    await Promise.all([first, second])
    assert.equal(store.getSnapshot().analysisRunId, '')
    assert.deepEqual(store.getSnapshot().analysisInputs, {})
    assert.deepEqual(store.getSnapshot().analysisInputLoading, [])
  } finally { store.dispose() }
})

test('input failures remain local, can retry, and successful reads are cached independently of polling', async () => {
  let reads = 0
  const store = createCuratorStore({ invoke: async operation => {
    if (operation === 'analysis-input') { if (++reads === 1) throw new Error('offline'); return { requestId: 'r', instructions: 'original', inputText: 'text', images: [] } }
    return { task: { runId: 'run', styleId: 'a', name: 'A', status: 'completed', observed: 1, total: 1, model: 'fixture', reasoningEffort: 'high', attempts: 1, startedAt: 'now', phase: 'completed', autoResume: false }, observations: [] }
  } })
  try {
    store.openAnalysis('run'); await store.refreshAnalysisDetail()
    await store.loadAnalysisInput('r')
    assert.ok(store.getSnapshot().analysisInputErrors.r)
    assert.equal(store.getSnapshot().analysisError, null)
    await store.loadAnalysisInput('r'); await store.refreshAnalysisDetail(); await store.loadAnalysisInput('r')
    assert.equal(reads, 2)
    assert.equal(store.getSnapshot().analysisInputs.r?.instructions, 'original')
    assert.equal(store.getSnapshot().analysisInputErrors.r, undefined)
    store.openAnalysis('another-run')
    assert.deepEqual(store.getSnapshot().analysisInputs, {})
  } finally { store.dispose() }
})
