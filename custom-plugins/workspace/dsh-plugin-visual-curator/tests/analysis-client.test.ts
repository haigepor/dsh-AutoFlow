import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCuratorStore } from '../src/client/store.ts'
import { resolveCurrentConfig } from '../src/host/config.ts'
import type { CuratorSnapshot } from '../src/client/contract.ts'

function snapshot(): CuratorSnapshot {
  return { collectionPaging: true, workspaceRevision: 'initial', styles: [], images: [], runs: [], usages: [], splits: [], evaluations: [], exports: [], suggestions: [], configuration: { ...resolveCurrentConfig({}), revision: 'one', sourceConfigured: false, visionConfigured: true, sourceCredentialConfigured: false, visionCredentialConfigured: false } }
}
test('cancellation reaches the Host even when a pause request for that run is still pending', async () => {
  const commands: string[] = []
  let snapshots = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const store = createCuratorStore({ invoke: async (operation, args) => {
    if (operation === 'snapshot') { snapshots++; return snapshot() }
    if (operation === 'run-control') {
      commands.push(String(args.command))
      if (args.command === 'pause') await gate
      return { runId: 'control-run', kind: 'analyze', taskBrief: '', status: args.command === 'pause' ? 'pausing' : 'cancelling', counts: {}, results: [], warnings: [] }
    }
    return { tasks: [], analyses: [] }
  } })
  let pausing: Promise<unknown> | undefined
  try {
    await store.reload()
    pausing = store.execute('run-control', { runId: 'control-run', command: 'pause' })
    await store.execute('run-control', { runId: 'control-run', command: 'cancel' })
    assert.deepEqual(commands, ['pause', 'cancel'])
    release(); await pausing
    assert.equal(store.getSnapshot().snapshot?.runs.find(run => run.runId === 'control-run')?.status, 'cancelling', 'A late pause receipt cannot replace the newer cancel receipt')
    assert.equal(snapshots, 1, 'Task controls must not reload the image workspace')
  } finally { release(); await pausing; store.dispose() }
})
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

test('analysis start does not wait for a stale task poll begun before acceptance', async () => {
  let release!: (value: unknown) => void, polls = 0
  const oldPoll = new Promise(resolve => { release = resolve })
  const task = { runId: 'new-run', styleId: 'a', name: 'A', status: 'running', observed: 0, total: 218, model: 'fixture', reasoningEffort: 'low', attempts: 1, startedAt: '2026-10-26', phase: 'analyzing', autoResume: true }
  const store = createCuratorStore({ invoke: async operation => {
    if (operation === 'snapshot') return snapshot()
    if (operation === 'reference-analyze') return { runId: task.runId }
    return ++polls === 1 ? oldPoll : { tasks: [], analyses: [task] }
  } })
  let old: Promise<void> | undefined
  try {
    await store.reload()
    old = store.refreshGalleryTasks()
    let accepted = false
    const start = store.startAnalysis({ styleId: 'a' }).then(() => { accepted = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(accepted, true, 'An unrelated older poll must not hold the accepted start')
    release({ tasks: [], analyses: [] }); await old; await start
    assert.equal(store.getSnapshot().analysisTasks[0]?.runId, task.runId)
  } finally { release({ tasks: [], analyses: [] }); await old; store.dispose() }
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


test('deleting history invalidates old reads, preserves loaded images and chooses the next task', async () => {
  let releaseRun!: (value: unknown) => void, releasePoll!: (value: unknown) => void, snapshots = 0
  const oldRun = new Promise(resolve => { releaseRun = resolve }), oldPoll = new Promise(resolve => { releasePoll = resolve })
  const run = (runId: string) => ({ runId, kind: 'analyze' as const, status: 'failed' as const, styleId: 'a', taskBrief: '', counts: {}, results: [], warnings: [] })
  let hold = false
  const store = createCuratorStore({ invoke: async (operation, args) => {
    if (operation === 'snapshot') { snapshots++; return { ...snapshot(), runs: [run('deleted'), run('kept')] } }
    if (operation === 'run-get') return hold ? oldRun : run(String(args.runId))
    if (operation === 'gallery-reference-tasks') return hold ? oldPoll : { tasks: [], analyses: [] }
    if (operation === 'run-delete') return { runId: args.runId, deleted: true }
    throw new Error('Unexpected operation')
  } })
  try {
    await store.reload(); store.selectRun('deleted'); await store.loadRun('deleted')
    hold = true
    const reading = store.loadRun('deleted'), polling = store.refreshGalleryTasks()
    const images = store.getSnapshot().snapshot!.images
    await store.execute('run-delete', { runId: 'deleted', operationId: 'delete' })
    assert.equal(store.getSnapshot().runId, 'kept')
    assert.equal(store.getSnapshot().runLoading, false)
    releaseRun(run('deleted')); releasePoll({ tasks: [], analyses: [{ runId: 'deleted', styleId: 'a', name: 'A', status: 'failed', observed: 0, total: 1, model: 'Fixture', reasoningEffort: null, attempts: 1, startedAt: 'now', phase: 'failed', autoResume: false }] })
    await reading; await polling
    assert.deepEqual(store.getSnapshot().snapshot?.runs.map(item => item.runId), ['kept'])
    assert.equal(store.getSnapshot().snapshot?.images, images)
    assert.equal(snapshots, 1)
  } finally { releaseRun(run('deleted')); releasePoll({ tasks: [], analyses: [] }); store.dispose() }
})
