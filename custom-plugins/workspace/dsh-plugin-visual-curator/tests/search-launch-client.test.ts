import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSearchLaunchStore } from '../src/client/search-launch-store.ts'
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'

const draft = () => ({ operationId: randomUUID(), workspaceId: 'photos', modelProfileId: 'profile', taskBrief: 'Muted green photos.', targetCount: 10, output: { kind: 'original' as const } })
const view = (input: ReturnType<typeof draft>) => ({ id: input.operationId, input, sessionId: 'native-session', status: 'accepted', stage: 'accepted', createdAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T00:00:00Z', runIds: [], qualified: 0 })

test('empty and terminal launch directories stay idle while observed active launches keep refreshing', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let kind: 'empty' | 'active' | 'settled' = 'empty', calls = 0
  const input = draft(), store = createSearchLaunchStore({ context: () => ({ scope: 1, styleId: 'style', pollMs: 2000 }), openSession: () => {}, async invoke() {
    calls++
    return kind === 'empty' ? [] : [{ ...view(input), runIds: ['run'], runStatus: kind === 'active' ? 'running' : 'completed' }]
  } })
  store.sync()
  try {
    assert.equal(calls, 0, 'scope synchronization alone does not create an observer')
    let close = store.subscribe(() => {}), duplicate = store.subscribe(() => {})
    await setImmediate(); assert.equal(calls, 1)
    context.mock.timers.tick(60000); await setImmediate(); assert.equal(calls, 1)
    kind = 'active'; await store.refresh()
    context.mock.timers.tick(2000); await setImmediate(); assert.equal(calls, 3)
    close(); duplicate(); context.mock.timers.tick(60000); await setImmediate(); assert.equal(calls, 3)
    close = store.subscribe(() => {}); await setImmediate(); assert.equal(calls, 4)
    kind = 'settled'; context.mock.timers.tick(2000); await setImmediate(); assert.equal(calls, 5)
    context.mock.timers.tick(60000); await setImmediate(); assert.equal(calls, 5)
    close()
  } finally { store.dispose(); context.mock.timers.reset() }
})

test('unknown launch acknowledgements survive closing and reconcile without another submission', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const input = draft()
  let reads = 0, starts = 0, accepted = false
  const store = createSearchLaunchStore({ context: () => ({ scope: 1, styleId: 'style', pollMs: 2000 }), openSession: () => {}, async invoke(operation) {
    if (operation === 'search-launch-start') { starts++; throw { code: 'connection-unavailable' } }
    reads++; return accepted ? [view(input)] : []
  } })
  try {
    await store.start(input)
    assert.equal(store.getSnapshot().submission?.status, 'unknown')
    let close = store.subscribe(() => {}); await setImmediate()
    assert.equal(store.getSnapshot().submission?.input.operationId, input.operationId)
    context.mock.timers.tick(2000); await setImmediate(); assert.equal(reads, 2)
    close(); const beforeClosed = reads
    context.mock.timers.tick(60000); await setImmediate()
    assert.equal(reads, beforeClosed); assert.equal(store.getSnapshot().submission?.status, 'unknown')
    accepted = true; close = store.subscribe(() => {}); await setImmediate()
    assert.equal(reads, beforeClosed + 1); assert.equal(starts, 1)
    assert.equal(store.getSnapshot().submission, null); assert.equal(store.getSnapshot().entries[0]?.id, input.operationId)
    close()
  } finally { store.dispose(); context.mock.timers.reset() }
})

test('closing a launch observer leaves its dispatched admission running', async () => {
  const input = draft()
  let resolve: (value: object) => void = () => {}, signal: AbortSignal | undefined
  const store = createSearchLaunchStore({ context: () => ({ scope: 1, styleId: 'style', pollMs: 60000 }), openSession: () => {}, invoke: async (operation, _args, requestSignal) => {
    if (operation !== 'search-launch-start') return []
    signal = requestSignal
    return new Promise<object>(done => { resolve = done })
  } })
  const close = store.subscribe(() => {})
  try {
    await setImmediate(); const submitting = store.start(input); close()
    assert.equal(signal?.aborted, false)
    resolve(view(input)); await submitting
    assert.equal(store.getSnapshot().entries[0]?.id, input.operationId)
    assert.equal(store.getSnapshot().submission, null)
  } finally { store.dispose() }
})

test('workspace changes recheck idle launch directories only while observed', async () => {
  let workspaceRevision = 'first', reads = 0
  const store = createSearchLaunchStore({ context: () => ({ scope: 1, styleId: 'style', pollMs: 60000, workspaceRevision }), openSession: () => {}, async invoke() { reads++; return [] } })
  try {
    let close = store.subscribe(() => {}); await setImmediate(); assert.equal(reads, 1)
    workspaceRevision = 'second'; store.sync(); await setImmediate(); assert.equal(reads, 2)
    store.sync(); await setImmediate(); assert.equal(reads, 2)
    close(); workspaceRevision = 'third'; store.sync(); await setImmediate(); assert.equal(reads, 2)
    close = store.subscribe(() => {}); await setImmediate(); assert.equal(reads, 3)
    close()
  } finally { store.dispose() }
})

test('workspace changes during a directory read queue one fresh result and discard its obsolete response', async () => {
  let workspaceRevision = 'first', reads = 0, releaseStale: (value: object[]) => void = () => {}, releaseLatest: (value: object[]) => void = () => {}
  const before = draft(), after = draft()
  const store = createSearchLaunchStore({ context: () => ({ scope: 1, styleId: 'style', pollMs: 60000, workspaceRevision }), openSession: () => {}, invoke: async () => {
    if (++reads === 1) return [view(before)]
    if (reads === 2) return new Promise<object[]>(resolve => { releaseStale = resolve })
    return new Promise<object[]>(resolve => { releaseLatest = resolve })
  } })
  const close = store.subscribe(() => {})
  try {
    await setImmediate(); const reading = store.refresh()
    workspaceRevision = 'second'; store.sync(); workspaceRevision = 'third'; store.sync()
    assert.equal(reads, 2)
    releaseStale([]); await reading; await setImmediate()
    assert.equal(reads, 3, 'several revision changes share one subsequent read')
    assert.equal(store.getSnapshot().entries[0]?.id, before.operationId, 'the obsolete directory cannot clear confirmed cards')
    releaseLatest([view(after)]); await setImmediate()
    assert.equal(store.getSnapshot().entries[0]?.id, after.operationId)
  } finally { close(); store.dispose() }
})

test('reopening during an older directory read requests a fresh list after it settles', async () => {
  let reads = 0, release: (value: object[]) => void = () => {}
  const input = draft(), store = createSearchLaunchStore({ context: () => ({ scope: 1, styleId: 'style', pollMs: 60000 }), openSession: () => {}, invoke: async () => {
    if (++reads === 1) return new Promise<object[]>(resolve => { release = resolve })
    return [view(input)]
  } })
  let close = store.subscribe(() => {})
  try {
    close(); close = store.subscribe(() => {}); assert.equal(reads, 1)
    release([]); await setImmediate()
    assert.equal(reads, 2); assert.equal(store.getSnapshot().entries[0]?.id, input.operationId)
  } finally { close(); store.dispose() }
})

test('an explicit conversation model requires Host support and remains in the frozen launch request', async () => {
  for (const supported of [false, true]) {
    const input = { ...draft(), conversationModel: { provider: 'fixture', model: 'alternate' } }, calls: Record<string, unknown>[] = []
    const store = createSearchLaunchStore({ context: () => ({ scope: 1, styleId: 'style', pollMs: 60000 }), openSession: () => {}, async invoke(operation, args) {
      if (operation === 'search-launch-options') return { workspaces: [], usages: [], defaultTargetCount: 10, maxTargetCount: 200, ...(supported ? { conversationModelSelection: true, conversationModels: [{ ...input.conversationModel, label: 'Alternate' }] } : {}) }
      calls.push(args); return { ...view(input), input }
    } })
    try {
      await store.start(input)
      assert.equal(calls.length, supported ? 1 : 0)
      if (supported) assert.deepEqual(calls[0]!.conversationModel, input.conversationModel)
      else assert.equal(store.getSnapshot().submission?.error, 'launch-update-required')
    } finally { store.dispose() }
  }
})

test('automatic preparation and default negative references require explicit Host capabilities before mutation', async () => {
  for (const supported of [false, true]) {
    const input = { ...draft(), autoPrepareDataset: true, includeNegativeDatasets: true }, calls: Record<string, unknown>[] = []
    const store = createSearchLaunchStore({ context: () => ({ scope: 1, styleId: 'style', pollMs: 60000 }), openSession: () => {}, invoke: async (operation, args) => {
      if (operation === 'search-launch-options') return { workspaces: [], defaultTargetCount: 10, maxTargetCount: 200, ...(supported ? { automaticDatasetPreparation: true, negativeReferenceDatasets: true } : {}) }
      calls.push(args); return { ...view(input), input }
    } })
    try {
      await store.start(input)
      assert.equal(calls.length, supported ? 1 : 0)
      if (supported) { assert.equal(calls[0]!.autoPrepareDataset, true); assert.equal(calls[0]!.includeNegativeDatasets, true) }
      else assert.equal(store.getSnapshot().submission?.error, 'launch-update-required')
    } finally { store.dispose() }
  }
})

test('empty main-package choices retain negative counts and allow automatic launch without a dataset id', async () => {
  const operations: string[] = [], input = { ...draft(), autoPrepareDataset: true, includeNegativeDatasets: true }
  const store = createSearchLaunchStore({ context: () => ({ scope: 1, styleId: 'style', pollMs: 60000 }), openSession: () => {}, invoke: async (operation, args) => {
    operations.push(operation)
    if (operation === 'search-launch-list') return []
    if (operation === 'search-launch-datasets') { assert.equal(args.modelProfileId, 'profile'); return { styleId: 'style', entries: [], total: 0, allTotal: 2, negativeReferences: { datasets: 2, references: 30 } } }
    if (operation === 'search-launch-options') return { workspaces: [], automaticDatasetPreparation: true, negativeReferenceDatasets: true, defaultTargetCount: 10, maxTargetCount: 200 }
    return { ...view(input), input }
  } })
  try {
    store.sync(); await store.loadDatasets('profile')
    assert.deepEqual(store.getSnapshot().datasetOptions?.negativeReferences, { datasets: 2, references: 30 })
    assert.equal(store.getSnapshot().datasetOptions?.entries.length, 0)
    await store.start(input)
    assert.ok(operations.includes('search-launch-start'))
    assert.equal(store.getSnapshot().entries[0]!.input.datasetId, undefined)
  } finally { store.dispose() }
})

test('preview launches check Host support before sending any launch mutation', async () => {
  for (const capability of [undefined, false, true]) {
    const input = { ...draft(), datasetId: 'profile-export-preview', output: { kind: 'preview' as const } }, calls: string[] = []
    const store = createSearchLaunchStore({ context: () => ({ scope: 1, styleId: 'style', pollMs: 60000 }), openSession: () => {}, invoke: async operation => {
      calls.push(operation)
      if (operation === 'search-launch-options') return { workspaces: [], usages: [], datasetSelection: 'required', ...(capability === undefined ? {} : { previewSearch: capability }), defaultTargetCount: 10, maxTargetCount: 200 }
      return { ...view(draft()), id: input.operationId, input }
    } })
    try {
      await store.start(input)
      assert.equal(calls.includes('search-launch-start'), capability === true)
      if (capability !== true) assert.equal(store.getSnapshot().submission?.error, capability === undefined ? 'launch-update-required' : 'preview-source-unsupported')
      else assert.equal(store.getSnapshot().entries[0]?.input.output.kind, 'preview')
    } finally { store.dispose() }
  }
})

test('a lost acknowledgement retains launch input and retry identity without navigating to an unsent draft', async () => {
  const input = draft(), ids: unknown[] = [], opened: string[] = []
  let fail = true
  const store = createSearchLaunchStore({ context: () => ({ scope: 1, styleId: 'style', pollMs: 60000 }), openSession: id => opened.push(id), invoke: async (operation, args) => {
    if (operation === 'search-launch-start') { ids.push(args.operationId); if (fail) { fail = false; throw new Error('lost ack') } return view(input) }
    return []
  } })
  try {
    await store.start(input)
    assert.equal(store.getSnapshot().submission?.status, 'unknown')
    assert.deepEqual(store.getSnapshot().submission?.input, input)
    await store.start(store.getSnapshot().submission!.input)
    assert.deepEqual(ids, [input.operationId, input.operationId]); assert.equal(store.getSnapshot().submission, null)
    assert.deepEqual(opened, [])
    store.openSession(store.getSnapshot().entries[0]!.sessionId); assert.deepEqual(opened, ['native-session'])
  } finally { store.dispose() }
})

test('scoped late acknowledgement and stale lists never restore another collection’s launch', async () => {
  let scope = 1, styleId = 'first', resolve!: (value: unknown) => void
  const input = draft(), pending = new Promise<unknown>(done => { resolve = done })
  const store = createSearchLaunchStore({ context: () => ({ scope, styleId, pollMs: 60000 }), openSession: () => {}, invoke: async operation => operation === 'search-launch-start' ? pending : [] })
  try {
    store.sync(); const submission = store.start(input)
    scope++; styleId = 'second'; store.sync(); resolve(view(input)); await submission
    assert.deepEqual(store.getSnapshot().entries, []); assert.equal(store.getSnapshot().submission, null)
  } finally { store.dispose() }
})

test('preparation observes real Workspace choices and stops only the selected launch', async () => {
  const input = draft(), commands: string[] = []
  const store = createSearchLaunchStore({ context: () => ({ scope: 1, styleId: 'style', pollMs: 60000 }), openSession: () => {}, invoke: async (operation, args) => {
    if (operation === 'search-launch-options') return { workspaces: [{ id: 'photos', title: 'Photos', path: 'D:/Photos' }], defaultTargetCount: 10, maxTargetCount: 200 }
    if (operation === 'search-launch-start') return view(input)
    if (operation === 'search-launch-stop') { commands.push(String(args.id)); return { ...view(input), stage: 'stopped', status: 'stopped' } }
    return []
  } })
  try {
    await store.loadOptions(); assert.equal(store.getSnapshot().options?.workspaces[0]?.path, 'D:/Photos')
    await store.start(input); await store.stop(input.operationId)
    assert.deepEqual(commands, [input.operationId]); assert.equal(store.getSnapshot().entries[0]?.status, 'stopped')
  } finally { store.dispose() }
})

test('size presets load from their paginated source instead of the lightweight image snapshot', async () => {
  const cursors: unknown[] = []
  const store = createSearchLaunchStore({ context: () => ({ scope: 1, styleId: 'style', pollMs: 60000 }), openSession: () => {}, invoke: async (_operation, args) => {
    cursors.push(args.usagePageToken)
    return { workspaces: [], usages: [{ usageRevisionId: args.usagePageToken ? 'portrait' : 'landscape', name: 'Preset', targetWidth: 400, targetHeight: 200 }], ...(args.usagePageToken ? {} : { usagePageToken: 'next-presets' }), defaultTargetCount: 10, maxTargetCount: 200 }
  } })
  try {
    await store.loadOptions(); await store.loadOptions(true)
    assert.deepEqual(cursors, [undefined, 'next-presets'])
    assert.deepEqual(store.getSnapshot().options?.usages.map(item => item.usageRevisionId), ['landscape', 'portrait'])
  } finally { store.dispose() }
})

test('switching collections inside the same Session discards an older launch acknowledgement', async () => {
  let styleId = 'first', resolve!: (value: unknown) => void
  const input = draft(), pending = new Promise<unknown>(done => { resolve = done })
  const store = createSearchLaunchStore({ context: () => ({ scope: 1, styleId, pollMs: 60000 }), openSession: () => {}, invoke: async operation => operation === 'search-launch-start' ? pending : [] })
  try {
    store.sync(); const submission = store.start(input)
    styleId = 'second'; store.sync(); resolve(view(input)); await submission
    assert.deepEqual(store.getSnapshot().entries, []); assert.equal(store.getSnapshot().submission, null)
  } finally { store.dispose() }
})
