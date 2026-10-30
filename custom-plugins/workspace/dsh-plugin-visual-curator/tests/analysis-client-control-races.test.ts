import test from 'node:test'
import assert from 'node:assert/strict'
import { createCuratorStore } from '../src/client/store.ts'
import { resolveCurrentConfig } from '../src/host/config.ts'
import type { CuratorSnapshot } from '../src/client/contract.ts'
import type { AnalysisTask, AnalysisDetail } from '../src/shared/analysis-process.ts'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept }); return { promise, resolve } }
const snapshot = (): CuratorSnapshot => ({ collectionPaging: true, styles: [], images: [], runs: [], usages: [], splits: [], evaluations: [], exports: [], suggestions: [], configuration: { ...resolveCurrentConfig({}), revision: 'one', sourceConfigured: false, visionConfigured: true, sourceCredentialConfigured: false, visionCredentialConfigured: false } })
const task = (runId = 'run', status: AnalysisTask['status'] = 'running'): AnalysisTask => ({ runId, styleId: 'style', name: 'Synthetic', status, observed: 1, total: 2, model: 'synthetic', reasoningEffort: null, attempts: 1, startedAt: 'now', phase: status === 'paused' ? 'paused' : 'receiving', autoResume: status === 'running' })
const detail = (runId: string): AnalysisDetail => ({ task: task(runId), observations: [], images: [], requests: [] })

test('continuation failure from the profile has visible feedback without opening a dialog', async () => {
  const store = createCuratorStore({ invoke: async () => { throw new Error('offline') } })
  try {
    await store.resumeAnalysis('run')
    assert.ok(store.getSnapshot().error)
    assert.deepEqual(store.getSnapshot().pending, [])
  } finally { store.dispose() }
})

test('task history cancellation supersedes an older analysis-dialog pause receipt', async () => {
  const pause = deferred<AnalysisTask>()
  const store = createCuratorStore({ invoke: async operation => {
    if (operation === 'snapshot') return snapshot()
    if (operation === 'analysis-detail') return detail('run')
    if (operation === 'analysis-pause') return pause.promise
    if (operation === 'run-control') return { runId: 'run', kind: 'analyze', taskBrief: '', status: 'cancelling', counts: {}, results: [], warnings: [] }
    return { tasks: [], analyses: [] }
  } })
  try {
    await store.reload(); store.openAnalysis('run'); await store.refreshAnalysisDetail()
    const pending = store.pauseAnalysis('run')
    await store.execute('run-control', { runId: 'run', command: 'cancel' })
    pause.resolve(task('run', 'pausing')); await pending
    assert.equal(store.getSnapshot().analysisDetail?.task.status, 'cancelling')
  } finally { pause.resolve(task()); store.dispose() }
})

test('a failed pause restarts the superseded detail read instead of leaving the initial skeleton stuck', async () => {
  const old = deferred<AnalysisDetail>(); let reads = 0
  const store = createCuratorStore({ invoke: async operation => {
    if (operation === 'snapshot') return snapshot()
    if (operation === 'analysis-detail') return ++reads === 1 ? old.promise : detail('run')
    if (operation === 'analysis-pause') throw new Error('offline')
    return { tasks: [], analyses: [task()] }
  } })
  try {
    await store.reload(); await store.refreshGalleryTasks(); store.openAnalysis('run')
    const first = store.refreshAnalysisDetail(); await store.pauseAnalysis('run')
    old.resolve(detail('run')); await first; await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(store.getSnapshot().analysisLoading, false)
    assert.equal(store.getSnapshot().analysisDetail?.task.runId, 'run')
    assert.ok(reads >= 2)
  } finally { old.resolve(detail('run')); store.dispose() }
})

for (const failed of [false, true]) test(`a prior task control ${failed ? 'failure' : 'receipt'} cannot abort or report errors in the newly opened task`, async () => {
  const pause = deferred<AnalysisTask>(), next = deferred<AnalysisDetail>(); let aborted = false
  const store = createCuratorStore({ invoke: async (operation, args, signal) => {
    if (operation === 'snapshot') return snapshot()
    if (operation === 'analysis-detail') {
      if (args.runId === 'first') return detail('first')
      signal?.addEventListener('abort', () => { aborted = true }, { once: true }); return next.promise
    }
    if (operation === 'analysis-pause') { await pause.promise; if (failed) throw new Error('offline'); return task('first', 'paused') }
    return { tasks: [], analyses: [] }
  } })
  try {
    await store.reload(); store.openAnalysis('first'); await store.refreshAnalysisDetail()
    const pending = store.pauseAnalysis('first'); store.openAnalysis('second')
    pause.resolve(task('first', 'paused')); await pending
    assert.equal(aborted, false)
    assert.equal(store.getSnapshot().analysisError, null)
    next.resolve(detail('second')); await store.refreshAnalysisDetail()
    assert.equal(store.getSnapshot().analysisDetail?.task.runId, 'second')
    assert.equal(store.getSnapshot().analysisLoading, false)
  } finally { pause.resolve(task()); next.resolve(detail('second')); store.dispose() }
})
