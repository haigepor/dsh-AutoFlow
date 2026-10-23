import test from 'node:test'
import assert from 'node:assert/strict'
import { createCuratorStore, encodeUpload, safeResourcePath } from '../src/client/store.ts'
import type { CuratorSnapshot, ImageView, RunView } from '../src/client/contract.ts'
import { resolveConfig } from '../src/host/config.ts'

function snapshot(): CuratorSnapshot {
  const config = resolveConfig({})
  return { styles: [], images: [], usages: [], runs: [], splits: [], evaluations: [], exports: [], suggestions: [], configuration: {
    ...config, revision: 'r1', sourceConfigured: false, visionConfigured: false, sourceCredentialConfigured: false, visionCredentialConfigured: false,
  } }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('background refresh retains filters, image selection, open preview and task identity', async () => {
  let current = snapshot()
  const store = createCuratorStore({ invoke: async () => current })
  await store.reload()
  store.selectWorkspace('tasks'); store.selectRun('run-open'); store.setFilter('needs-review'); store.setPage(2)
  store.select('image-open'); store.preview('image-open')
  current = { ...snapshot(), configuration: { ...snapshot().configuration, revision: 'r2' } }
  await store.reload()
  const state = store.getSnapshot()
  assert.equal(state.snapshot?.configuration.revision, 'r2')
  assert.equal(state.runId, 'run-open'); assert.equal(state.workspace, 'tasks'); assert.equal(state.filter, 'needs-review'); assert.equal(state.page, 2)
  assert.deepEqual(state.selectedImageIds, ['image-open']); assert.equal(state.previewId, 'image-open')
  store.dispose()
})

test('failed refresh retains visible records and exposes no raw transport secrets', async () => {
  let fail = false
  const store = createCuratorStore({ invoke: async () => { if (fail) throw new Error('Bearer secret-token https://signed.invalid/?token=secret'); return snapshot() } })
  await store.reload(); const original = store.getSnapshot().snapshot
  fail = true; await store.reload()
  assert.equal(store.getSnapshot().snapshot, original)
  assert.equal(store.getSnapshot().error?.code, 'operation-failed')
  assert.doesNotMatch(JSON.stringify(store.getSnapshot().error), /secret|Bearer|signed\.invalid/)
  store.dispose()
})

test('connection reset suppresses an old response without cancelling durable Host tasks', async () => {
  const first = deferred<CuratorSnapshot>(), second = deferred<CuratorSnapshot>()
  let calls = 0
  const operations: string[] = []
  const store = createCuratorStore({ invoke: operation => { operations.push(operation); return ++calls === 1 ? first.promise : second.promise } })
  const oldRead = store.reload()
  store.reset()
  second.resolve({ ...snapshot(), configuration: { ...snapshot().configuration, revision: 'new-host' } })
  await second.promise; await Promise.resolve()
  first.resolve({ ...snapshot(), configuration: { ...snapshot().configuration, revision: 'stale-host' } })
  await oldRead
  assert.equal(store.getSnapshot().snapshot?.configuration.revision, 'new-host')
  assert.deepEqual(operations, ['snapshot', 'snapshot'])
  store.dispose()
})

test('duplicate mutation gestures share the in-flight guard; failures retain user selection', async () => {
  const action = deferred<unknown>()
  let mutations = 0
  const store = createCuratorStore({ invoke: async operation => { if (operation === 'snapshot') return snapshot(); mutations++; return action.promise } })
  store.select('image-a')
  const first = store.execute('feedback-confirm', { operationId: 'same-operation' })
  assert.equal(await store.execute('feedback-confirm', { operationId: 'same-operation' }), undefined)
  action.resolve({ feedbackId: 'feedback-a' }); await first
  assert.equal(mutations, 1); assert.deepEqual(store.getSnapshot().selectedImageIds, ['image-a'])
  assert.equal(store.getSnapshot().toast?.success, true); assert.deepEqual(store.getSnapshot().pending, [])
  store.dispose()
})

test('mutation rejection keeps data and publishes a structured failure for the long-lived overlay', async () => {
  const store = createCuratorStore({ invoke: async operation => {
    if (operation === 'snapshot') return snapshot()
    throw { code: 'revision-conflict', stage: 'feedback', retryable: false, safeMessage: 'Record changed', suggestedAction: 'Refresh' }
  } })
  await store.reload(); store.select('image-a')
  await assert.rejects(store.execute('feedback-confirm', {}), error => typeof error === 'object' && error !== null && 'code' in error && error.code === 'revision-conflict')
  assert.equal(store.getSnapshot().toast?.code, 'revision-conflict'); assert.equal(store.getSnapshot().snapshot?.configuration.revision, 'r1')
  assert.deepEqual(store.getSnapshot().selectedImageIds, ['image-a']); assert.deepEqual(store.getSnapshot().pending, [])
  store.dispose()
})

test('Session scope requires an authenticated grant and injects it into later reads and mutations', async () => {
  const calls: { operation: string; args: Record<string, unknown> }[] = []
  const store = createCuratorStore({ invoke: async (operation, args) => {
    calls.push({ operation, args })
    if (operation === 'session-open') return { sessionToken: 'private-memory-grant', sessionId: 'session-a' }
    return operation === 'snapshot' ? snapshot() : { saved: true }
  } })
  await store.reload(); store.select('profile-image'); store.preview('profile-image')
  await store.openSession('session-a')
  assert.equal(store.getSnapshot().scopeSessionId, 'session-a')
  assert.deepEqual(store.getSnapshot().selectedImageIds, []); assert.equal(store.getSnapshot().previewId, '')
  await store.execute('feedback-confirm', {})
  const confirmation = calls.find(call => call.operation === 'feedback-confirm')
  assert.equal(confirmation?.args.sessionToken, 'private-memory-grant')
  assert.deepEqual(calls.find(call => call.operation === 'session-open')?.args, { sessionId: 'session-a' })
  store.closeSession(); await store.reload()
  assert.equal(store.getSnapshot().sessionToken, '')
  assert.equal(calls.at(-1)?.args.sessionToken, undefined)
  store.dispose()
})

test('only exact private resource routes become image or download destinations', () => {
  assert.equal(safeResourcePath('api/visual-curator/resource?imageVersionId=image-a'), '/api/visual-curator/resource?imageVersionId=image-a')
  assert.equal(safeResourcePath('/api/visual-curator/resource?exportId=export-a&sessionId=s1'), '/api/visual-curator/resource?exportId=export-a&sessionId=s1')
  for (const path of ['https://cdn.invalid/image.jpg', '//evil.invalid/api/visual-curator/resource?x=1', 'javascript:alert(1)',
    '/api/visual-curator/resource/../../admin', '/api/visual-curator/resource\n?imageVersionId=a', '/api/other?imageVersionId=a']) assert.equal(safeResourcePath(path), '')
})

test('server page tokens load more images and selected run results without polling away loaded pages', async () => {
  const image = (id: string): ImageView => ({ imageVersionId: id, assetId: `asset-${id}`, familyId: `family-${id}`, width: 100, height: 100,
    kind: 'normalized', previewPath: `/api/visual-curator/resource?imageVersionId=${id}`, name: id, source: 'local-import', exportPermission: 'references-only', groupingStatus: 'confirmed' })
  const a = image('a'), b = image('b')
  const run: RunView = { runId: 'run-a', kind: 'search', status: 'completed', taskBrief: 'Green', counts: {}, results: [], warnings: [] }
  const calls: string[] = []
  const store = createCuratorStore({ invoke: async (operation, args) => {
    calls.push(`${operation}:${String(args.pageToken ?? 'first')}`)
    if (operation === 'run-get') return { ...run, results: args.pageToken ? [b] : [a], ...args.pageToken ? {} : { pageToken: 'run-two' } }
    return { ...snapshot(), runs: [run], images: args.pageToken ? [b] : [a], ...args.pageToken ? {} : { nextPageToken: 'images-two' } }
  } })
  await store.reload()
  assert.deepEqual(store.getSnapshot().snapshot?.runs[0]?.results.map(item => item.imageVersionId), ['a'])
  await store.loadMoreImages(); await store.loadRun('run-a', true)
  store.select('b'); store.preview('b'); store.setFilter('pass')
  await store.reload()
  assert.deepEqual(store.getSnapshot().snapshot?.images.map(item => item.imageVersionId), ['a', 'b'])
  assert.deepEqual(store.getSnapshot().snapshot?.runs[0]?.results.map(item => item.imageVersionId), ['a', 'b'])
  assert.equal(store.getSnapshot().snapshot?.nextPageToken, undefined)
  assert.equal(store.getSnapshot().snapshot?.runs[0]?.pageToken, undefined)
  assert.deepEqual(store.getSnapshot().selectedImageIds, ['b']); assert.equal(store.getSnapshot().previewId, 'b'); assert.equal(store.getSnapshot().filter, 'pass')
  assert.ok(calls.includes('snapshot:images-two')); assert.ok(calls.includes('run-get:run-two'))
  store.dispose()
})

test('upload encoding preserves binary bytes', () => {
  const bytes = Uint8Array.from({ length: 20_000 }, (_, index) => index % 256)
  assert.deepEqual(Buffer.from(encodeUpload(bytes), 'base64'), Buffer.from(bytes))
})

test('inline crop refreshes its child job while retaining the source task, selection and loaded results on failure', async () => {
  const source: RunView = { runId: 'search', kind: 'search', status: 'completed', taskBrief: 'Source', counts: {}, results: [], warnings: [] }
  const crop: RunView = { ...source, runId: 'crop', kind: 'crop', status: 'running' }
  const image: ImageView = { imageVersionId: 'derivative', assetId: 'asset', familyId: 'family', width: 90, height: 160,
    kind: 'crop', previewPath: '/api/visual-curator/resource?imageVersionId=derivative', name: 'Crop', source: 'images', exportPermission: 'references-only', groupingStatus: 'confirmed', parentImageVersionId: 'original' }
  let failCrop = false, complete = false
  const reads: string[] = []
  const store = createCuratorStore({ invoke: async (operation, args) => {
    if (operation === 'snapshot') return { ...snapshot(), runs: [source, crop] }
    reads.push(String(args.runId))
    if (args.runId === 'crop') {
      if (failCrop) throw new Error('offline')
      return { ...crop, status: complete ? 'completed' : 'running', results: complete ? [image] : [] }
    }
    return source
  } })
  await store.reload(); store.selectCandidate('original')
  await store.followCrop('crop', store.getSnapshot().cropSelection)
  assert.equal(store.getSnapshot().runId, 'search')
  reads.length = 0; complete = true
  await store.reload()
  assert.deepEqual(reads, ['search', 'crop'])
  assert.equal(store.getSnapshot().snapshot?.runs.find(run => run.runId === 'crop')?.status, 'completed')
  failCrop = true; await store.reload()
  assert.equal(store.getSnapshot().runError?.code, 'operation-failed')
  assert.equal(store.getSnapshot().candidateId, 'original')
  assert.equal(store.getSnapshot().cropRunId, 'crop')
  assert.deepEqual(store.getSnapshot().snapshot?.runs.find(run => run.runId === 'crop')?.results, [image])
  failCrop = false; await store.reload()
  assert.equal(store.getSnapshot().runError, null)
  assert.equal(store.getSnapshot().runId, 'search')
  store.dispose()
})

test('a delayed crop start cannot attach after candidate, filter, page, task, workspace or authorization changes', async () => {
  const store = createCuratorStore({ invoke: async operation => operation === 'session-open' ? { sessionToken: 'grant' } : snapshot() })
  await store.reload()
  for (const change of [() => store.selectCandidate('other'), () => store.setFilter('reject'), () => store.setPage(1),
    () => store.selectRun('other-run'), () => store.selectWorkspace('styles'), () => store.openSession('session'), () => store.closeSession(), () => store.reset()]) {
    store.selectCandidate('original')
    const epoch = store.getSnapshot().cropSelection
    await store.followCrop('current', epoch)
    assert.equal(store.getSnapshot().cropRunId, 'current')
    await change()
    await store.followCrop('late', epoch)
    assert.equal(store.getSnapshot().cropRunId, '')
  }
  store.dispose()
})
