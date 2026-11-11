import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createConversationFeedback } from '../src/client/conversation-feedback.ts'
import { resultCategory } from '../src/shared/search-feedback.ts'

const report = (sessionId: string, runId: string, status = 'running') => ({ runId, owner: { kind: 'session', sessionId }, kind: 'search', status, stage: 'retrieving', counts: { candidates: 3, qualified: 0 }, warnings: [], results: [], resultSummary: { selected: 0, needsReview: 1, candidates: 2, target: 10 } })

test('conversation pagination reads only new results while refresh revalidates the complete loaded window', async () => {
  const images = Array.from({ length: 127 }, (_, index) => ({ imageVersionId: `image-${index}`, name: `Image ${index}`, previewPath: '/preview', thumbnailPath: `/thumbnail-${index}`, resultCategory: index < 6 ? 'selected' : index < 9 ? 'review' : 'rejected' }))
  const requests: { filter: string; size: number; offset: number }[] = []
  const store = createConversationFeedback({ schedule: () => () => {}, invoke: async (operation, args) => {
    if (operation === 'session-open') return { sessionToken: 'owner-grant', expiresAt: Date.now() + 100000, pollIntervalMs: 10 }
    assert.equal(args.sessionId, 'owner'); assert.equal(args.sessionToken, 'owner-grant')
    const filter = String(args.resultFilter), size = Number(args.pageSize), offset = Number(args.pageToken ?? 0)
    requests.push({ filter, size, offset }); assert.ok(size > 0 && size <= 100)
    const filtered = images.filter(image => filter === 'all' || image.resultCategory === filter), end = offset + size
    return { ...report('owner', 'run'), resultFilter: filter, results: filtered.slice(offset, end), resultSummary: { selected: 6, needsReview: 3, candidates: 127, target: 10 }, ...(end < filtered.length ? { pageToken: String(end) } : {}) }
  } })
  const close = store.watch('owner', 'run'), entry = () => store.source('owner').getSnapshot().runs.run
  try {
    await setImmediate(); assert.equal(entry()?.run?.results.length, 4)
    assert.equal(entry()?.run?.results[0]?.thumbnailPath, '/thumbnail-0')
    for (let page = 0; page < 7; page++) {
      const previousCount = entry()!.run!.results.length, before = requests.length
      store.loadMore('owner', 'run'); await setImmediate()
      assert.deepEqual(requests.slice(before), [{ filter: 'all', size: 20, offset: previousCount }])
    }
    assert.equal(entry()?.run?.results.length, 127); assert.equal(entry()?.run?.pageToken, undefined)
    assert.equal(new Set(entry()?.run?.results.map(image => image.imageVersionId)).size, 127)
    assert.equal(requests.length, 8)
    const beforeRefresh = requests.length
    store.refresh('owner', 'run'); await setImmediate()
    assert.equal(entry()?.run?.results.length, 127, 'Live progress must not reset a loaded list to four images')
    assert.deepEqual(requests.slice(beforeRefresh), [{ filter: 'all', size: 100, offset: 0 }, { filter: 'all', size: 44, offset: 100 }])
    store.filterResults('owner', 'run', 'selected'); await setImmediate()
    assert.equal(entry()?.run?.results.length, 4); assert.equal(entry()?.resultFilter, 'selected')
    store.loadMore('owner', 'run'); await setImmediate()
    assert.deepEqual(entry()?.run?.results.map(image => image.imageVersionId), images.slice(0, 6).map(image => image.imageVersionId))
    store.filterResults('owner', 'run', 'review'); await setImmediate()
    assert.deepEqual(entry()?.run?.results.map(image => image.imageVersionId), ['image-6', 'image-7', 'image-8'])
  } finally { close(); store.dispose() }
})

test('expired Session grants refresh the loaded prefix before adding more results', async context => {
  let now = 1000, grants = 0
  context.mock.method(Date, 'now', () => now)
  const requests: { token: string; offset: number; size: number }[] = []
  const store = createConversationFeedback({ schedule: () => () => {}, invoke: async (operation, args) => {
    if (operation === 'session-open') return { sessionToken: `grant-${++grants}`, expiresAt: now + 100, pollIntervalMs: 10 }
    const offset = Number(args.pageToken ?? 0), size = Number(args.pageSize), token = String(args.sessionToken)
    requests.push({ token, offset, size })
    return { ...report('owner', 'run'), results: Array.from({ length: size }, (_, index) => ({ imageVersionId: `image-${offset + index}`, name: `Image ${offset + index}`, previewPath: `/preview?grant=${token}` })), pageToken: String(offset + size) }
  } })
  const close = store.watch('owner', 'run')
  try {
    await setImmediate(); now += 101
    store.loadMore('owner', 'run'); await setImmediate()
    assert.deepEqual(requests, [{ token: 'grant-1', offset: 0, size: 4 }, { token: 'grant-2', offset: 0, size: 24 }])
    const entry = store.source('owner').getSnapshot().runs.run!
    assert.equal(entry.run?.results.length, 24)
    assert.ok(entry.run?.results.every(image => image.previewPath === '/preview?grant=grant-2'))
  } finally { close(); store.dispose() }
})

test('reopening and loading more cannot merge an old grant prefix or publish a cancelled refresh', async () => {
  let grants = 0, release: (value: object) => void = () => {}, cancelled: AbortSignal | undefined
  const requests: { token: string; offset: number; size: number }[] = []
  const value = (token: string, size: number) => ({ ...report('owner', 'run'), results: Array.from({ length: size }, (_, index) => ({ imageVersionId: `image-${index}`, name: `Image ${index}`, previewPath: `/preview?grant=${token}` })), pageToken: String(size) })
  const store = createConversationFeedback({ schedule: () => () => {}, invoke: async (operation, args, signal) => {
    if (operation === 'session-open') return { sessionToken: `grant-${++grants}`, expiresAt: Date.now() + 100000, pollIntervalMs: 10 }
    const token = String(args.sessionToken), size = Number(args.pageSize)
    requests.push({ token, offset: Number(args.pageToken ?? 0), size })
    if (token === 'grant-2' && size === 4) { cancelled = signal; return new Promise<object>(resolve => { release = resolve }) }
    return value(token, size)
  } })
  let close = store.watch('owner', 'run')
  try {
    await setImmediate(); close(); close = store.watch('owner', 'run'); await setImmediate()
    store.loadMore('owner', 'run'); await setImmediate()
    assert.equal(cancelled?.aborted, true)
    assert.deepEqual(requests.at(-1), { token: 'grant-2', offset: 0, size: 24 })
    const entry = () => store.source('owner').getSnapshot().runs.run!
    assert.equal(entry().run?.results.length, 24)
    assert.ok(entry().run?.results.every(image => image.previewPath === '/preview?grant=grant-2'))
    release(value('grant-2', 4)); await setImmediate()
    assert.equal(entry().run?.results.length, 24)
  } finally { close(); store.dispose() }
})

test('a changed continuation retries the complete window once without dropping confirmed results', async () => {
  const offsets: number[] = []
  let changed = false, grants = 0, failWindow = false
  const store = createConversationFeedback({ schedule: () => () => {}, invoke: async (operation, args) => {
    if (operation === 'session-open') return { sessionToken: `grant-${++grants}`, expiresAt: Date.now() + 100000, pollIntervalMs: 10 }
    const offset = Number(args.pageToken ?? 0), size = Number(args.pageSize)
    offsets.push(offset)
    if (args.pageToken) { changed = true; throw { code: 'invalid-input' } }
    if (failWindow) throw { code: 'invalid-input' }
    return { ...report('owner', 'run'), results: Array.from({ length: size }, (_, index) => ({ imageVersionId: `${changed ? 'updated' : 'before'}-${index}`, name: `Image ${index}`, previewPath: '/preview' })), pageToken: String(size) }
  } })
  const close = store.watch('owner', 'run')
  try {
    await setImmediate(); store.loadMore('owner', 'run'); await setImmediate()
    assert.deepEqual(offsets, [0, 4, 0]); assert.equal(grants, 1)
    const entry = store.source('owner').getSnapshot().runs.run!
    assert.equal(entry.freshness, 'current'); assert.equal(entry.error, undefined)
    assert.equal(entry.run?.results.length, 24); assert.equal(entry.run?.results[0]?.imageVersionId, 'updated-0')
    offsets.length = 0; failWindow = true
    store.loadMore('owner', 'run'); await setImmediate()
    assert.deepEqual(offsets, [24, 0], 'an invalid first page must not restart the window again')
    assert.equal(store.source('owner').getSnapshot().runs.run?.freshness, 'stale')
    assert.equal(store.source('owner').getSnapshot().runs.run?.run?.results.length, 24)
  } finally { close(); store.dispose() }
})

test('changing an image filter discards a late page while a failed load retains confirmed images for retry', async () => {
  let delay = false, fail = false, finish: ((value: object) => void) | undefined
  const image = { imageVersionId: 'saved', name: 'Saved image', previewPath: '/preview', resultCategory: 'selected' }
  const images = Array.from({ length: 4 }, (_, index) => ({ ...image, imageVersionId: index === 0 ? 'saved' : `saved-${index}` }))
  const store = createConversationFeedback({ schedule: () => () => {}, invoke: async (operation, args) => {
    if (operation === 'session-open') return { sessionToken: 'grant', expiresAt: Date.now() + 100000, pollIntervalMs: 10 }
    const value = { ...report('owner', 'run'), resultFilter: args.resultFilter, results: args.resultFilter === 'review' || args.pageToken ? [] : images, ...(args.resultFilter === 'all' && !args.pageToken ? { pageToken: 'next' } : {}) }
    if (fail) throw new Error('offline')
    if (delay) return new Promise<object>(resolve => { finish = resolve })
    return value
  } })
  const close = store.watch('owner', 'run'), entry = () => store.source('owner').getSnapshot().runs.run
  try {
    await setImmediate(); fail = true; store.loadMore('owner', 'run'); await setImmediate()
    assert.equal(entry()?.loadingMore, undefined); assert.equal(entry()?.freshness, 'stale'); assert.equal(entry()?.run?.results[0]?.imageVersionId, 'saved')
    fail = false; delay = true; store.loadMore('owner', 'run'); await setImmediate()
    delay = false; store.filterResults('owner', 'run', 'review'); await setImmediate()
    finish?.({ ...report('owner', 'run'), resultFilter: 'all', results: [image] }); await setImmediate()
    assert.equal(entry()?.resultFilter, 'review'); assert.deepEqual(entry()?.run?.results, [])
  } finally { close(); store.dispose() }
})

const pendingLaunch = (sessionId: string) => {
  const id = '949d1789-e443-4ba7-b3d0-9f34f7a3392e'
  return { id, input: { operationId: id, workspaceId: 'photos', modelProfileId: 'profile', datasetId: 'profile-export-fixture', taskBrief: 'Find muted green landscape images.', targetCount: 10, output: { kind: 'preview' } }, sessionId, status: 'working', stage: 'attaching', createdAt: '2026-10-31T00:00:00Z', updatedAt: '2026-10-31T00:00:00Z', runIds: [], qualified: 0 }
}

test('completed search keeps observing wallpaper production and discovers its external continuation', async () => {
  const timers = new Set<() => void>()
  let childStatus = 'running', childId = 'wallpaper', passed = 0, detailReads = 0
  const store = createConversationFeedback({ schedule: work => { timers.add(work); return () => timers.delete(work) }, invoke: async operation => {
    if (operation === 'session-open') return { sessionToken: 'grant', expiresAt: Date.now() + 100000, pollIntervalMs: 17 }
    const wallpaper = { runId: childId, status: childStatus, total: 1, passed, attention: childStatus === 'completed' && !passed ? 1 : 0 }
    if (operation === 'conversation-runs') return { sessionId: 'owner', tasks: [{ runId: 'run', kind: 'search', status: 'completed', revision: 7, taskBrief: 'Wallpaper' }], launch: { ...pendingLaunch('owner'), status: 'accepted', runIds: ['run'], wallpaper } }
    detailReads++
    return { ...report('owner', 'run', 'completed'), revision: 7, launchId: pendingLaunch('owner').id, wallpaperRequired: true, workflowComplete: passed === 1, wallpaper: { ...wallpaper, sourceRunId: 'run', complete: passed === 1, attentionTotal: wallpaper.attention } }
  } })
  const source = store.sessionSource('owner'), close = source.subscribe(() => {})
  const poll = async () => { const pending = [...timers]; timers.clear(); pending.forEach(work => work()); await setImmediate() }
  try {
    await setImmediate()
    assert.equal(source.getSnapshot().runs.run?.run?.wallpaper?.status, 'running')
    childStatus = 'completed'; await poll()
    assert.equal(source.getSnapshot().runs.run?.run?.wallpaper?.status, 'completed')
    const stoppedAt = detailReads
    await poll(); assert.equal(detailReads, stoppedAt, 'settled production must stop detail polling')
    childStatus = 'running'; childId = 'continued-wallpaper'; await poll()
    assert.equal(source.getSnapshot().runs.run?.run?.wallpaper?.runId, childId, 'a child continuation changes without changing the parent revision')
    childStatus = 'completed'; passed = 1; await poll()
    assert.equal(source.getSnapshot().runs.run?.run?.workflowComplete, true)
  } finally { close(); store.dispose() }
  assert.equal(timers.size, 0)
})

test('a saved launch shows its requirements before the first Run and stops through its owning Session grant', async () => {
  const launch = pendingLaunch('owner'), calls: string[] = [], timers = new Set<() => void>()
  let offline = false
  const store = createConversationFeedback({ schedule: work => { timers.add(work); return () => timers.delete(work) }, invoke: async (operation, args) => {
    calls.push(operation)
    if (operation === 'session-open') return { sessionToken: 'grant', expiresAt: Date.now() + 100000, pollIntervalMs: 10 }
    if (operation === 'conversation-runs') { if (offline) throw new Error('offline'); return { sessionId: 'owner', tasks: [], launch } }
    if (operation === 'search-launch-stop') { assert.equal(args.sessionId, 'owner'); assert.equal(args.sessionToken, 'grant'); assert.equal(args.id, launch.id); return { ...launch, status: 'stopped', stage: 'stopped' } }
    throw new Error(operation)
  } })
  const source = store.sessionSource('owner'), close = source.subscribe(() => {})
  try {
    await setImmediate()
    assert.deepEqual(source.getSnapshot().tasks?.items, [])
    assert.equal(source.getSnapshot().tasks?.launch?.input.taskBrief, launch.input.taskBrief)
    assert.equal(source.getSnapshot().tasks?.launch?.input.targetCount, 10)
    assert.equal(calls.includes('run-get'), false)
    offline = true; store.refresh('owner'); await setImmediate()
    assert.equal(source.getSnapshot().tasks?.freshness, 'stale')
    assert.equal(source.getSnapshot().tasks?.launch?.id, launch.id)
    await store.stopLaunch('owner', launch.id)
    assert.equal(source.getSnapshot().tasks?.launch?.status, 'stopped')
    offline = false; store.refresh('owner'); await setImmediate()
    assert.equal(source.getSnapshot().tasks?.launch?.status, 'stopped')
  } finally { close(); store.dispose() }
})

test('a task list cannot expose a launch belonging to another Session', async () => {
  const store = createConversationFeedback({ schedule: () => () => {}, invoke: async operation => operation === 'session-open' ? { sessionToken: 'grant', expiresAt: Date.now() + 100000, pollIntervalMs: 10 } : { sessionId: 'owner', tasks: [], launch: pendingLaunch('other') } })
  const source = store.sessionSource('owner'), close = source.subscribe(() => {})
  try { await setImmediate(); assert.equal(source.getSnapshot().tasks?.launch, undefined); assert.equal(source.getSnapshot().tasks?.error, 'owner-denied') }
  finally { close(); store.dispose() }
})

test('dock stop uses the owning launch and a late running reply cannot replace its cancelled revision', async () => {
  const calls: string[] = [], timers = new Set<() => void>()
  let cancelled = false
  const launchId = '949d1789-e443-4ba7-b3d0-9f34f7a3392e'
  const store = createConversationFeedback({
    schedule: work => { timers.add(work); return () => timers.delete(work) },
    invoke: async (operation, args) => {
      calls.push(operation)
      if (operation === 'session-open') return { sessionToken: 'grant', expiresAt: Date.now() + 100000, pollIntervalMs: 10 }
      if (operation === 'search-launch-stop') { assert.equal(args.id, launchId); assert.equal(args.sessionToken, 'grant'); cancelled = true; return {} }
      if (operation === 'conversation-runs') return { sessionId: 'owner', tasks: [{ runId: 'run', kind: 'search', status: 'running', taskBrief: 'Vehicles', revision: 1 }] }
      return { ...report('owner', 'run', cancelled ? 'cancelled' : 'running'), launchId, revision: cancelled ? 3 : 1 }
    },
  })
  const source = store.sessionSource('owner'), close = source.subscribe(() => {})
  try {
    await setImmediate()
    await store.stop('owner', 'run')
    assert.equal(source.getSnapshot().runs.run?.run?.status, 'cancelled')
    assert.equal(source.getSnapshot().tasks?.items[0]?.status, 'cancelled')
    for (const poll of [...timers]) { timers.delete(poll); poll() }
    await setImmediate()
    assert.equal(source.getSnapshot().tasks?.items[0]?.status, 'cancelled')
    assert.equal(calls.includes('run-control'), false)
  } finally { close(); store.dispose() }
})

test('source passes without a final selection cannot claim ongoing review after the Run settles', () => {
  assert.equal(resultCategory({ selected: false, technicalFailed: false, verdict: 'pass' }), 'processing')
  assert.equal(resultCategory({ selected: false, technicalFailed: false, verdict: 'pass', settled: true }), 'pending')
  assert.equal(resultCategory({ selected: false, technicalFailed: false, verdict: 'pass', settled: true, source: true }), 'source')
  assert.equal(resultCategory({ selected: false, technicalFailed: true, settled: true }), 'failed')
})

test('conversation observations share one scoped read, stop on close and retain terminal history', async () => {
  const calls: string[] = [], timers = new Map<number, () => void>()
  let sequence = 0, terminal = false
  const store = createConversationFeedback({
    invoke: async (operation, args) => { calls.push(operation); return operation === 'session-open' ? { sessionToken: 'grant', expiresAt: Date.now() + 100000, pollIntervalMs: 17 } : report(String(args.sessionId), String(args.runId), terminal ? 'completed' : 'running') },
    schedule: (work, delay) => { assert.equal(delay, 17); const id = ++sequence; timers.set(id, work); return () => timers.delete(id) },
  })
  const first = store.watch('a', 'run'), second = store.watch('a', 'run')
  await setImmediate()
  assert.deepEqual(calls, ['session-open', 'run-get'])
  assert.equal(store.source('a').getSnapshot().runs.run?.run?.counts.candidates, 3)
  first(); assert.equal(timers.size, 1)
  terminal = true; const poll = [...timers.values()][0]!; timers.clear(); poll(); await setImmediate()
  assert.equal(store.source('a').getSnapshot().runs.run?.run?.status, 'completed')
  assert.equal(timers.size, 0)
  second(); store.dispose()
})

test('Session changes and reconnect discard obsolete replies while keeping confirmed counts', async () => {
  let resolveOld: (value: unknown) => void = () => {}
  const store = createConversationFeedback({ invoke: async (operation, args) => operation === 'session-open'
    ? { sessionToken: String(args.sessionId), expiresAt: Date.now() + 100000, pollIntervalMs: 10000 }
    : args.sessionId === 'a' ? new Promise(resolve => { resolveOld = resolve }) : report('b', 'same', 'completed') })
  const closeA = store.watch('a', 'same'); await setImmediate(); closeA()
  const closeB = store.watch('b', 'same'); await setImmediate()
  resolveOld(report('a', 'same')); await setImmediate()
  assert.equal(store.source('a').getSnapshot().runs.same?.run, undefined)
  assert.equal(store.source('b').getSnapshot().runs.same?.run?.owner.sessionId, 'b')
  store.reset(); await setImmediate()
  assert.equal(store.source('b').getSnapshot().runs.same?.run?.counts.candidates, 3)
  closeB(); store.dispose()
})

test('foreign Run replies and failed reads cannot become authorized previews or qualified counts', async () => {
  const store = createConversationFeedback({ invoke: async operation => operation === 'session-open'
    ? { sessionToken: 'grant', expiresAt: Date.now() + 100000, pollIntervalMs: 10000 } : report('foreign', 'run') })
  const close = store.watch('owner', 'run'); await setImmediate()
  const state = store.source('owner').getSnapshot().runs.run
  assert.equal(state?.run, undefined); assert.equal(state?.error, 'owner-denied')
  close(); store.dispose()
})

test('a Session dock discovers saved tasks without mounting any tool view and retains them on disconnect', async () => {
  const calls: string[] = [], timers = new Set<() => void>()
  let offline = false
  const store = createConversationFeedback({
    invoke: async (operation, args) => {
      calls.push(operation)
      if (offline) throw new Error('offline')
      if (operation === 'session-open') return { sessionToken: 'grant', expiresAt: Date.now() + 100000, pollIntervalMs: 17 }
      assert.equal(operation, 'conversation-runs'); assert.equal(args.sessionId, 'a')
      return { sessionId: 'a', tasks: [{ runId: 'one', kind: 'search', status: 'cancelled', taskBrief: 'Saved search' }, { runId: 'two', kind: 'crop', status: 'completed', taskBrief: 'Saved crop' }] }
    },
    schedule: work => { timers.add(work); return () => { timers.delete(work) } },
  })
  const close = store.watchSession('a'), duplicate = store.watchSession('a')
  await setImmediate()
  assert.deepEqual(calls, ['session-open', 'conversation-runs'])
  assert.deepEqual(store.source('a').getSnapshot().tasks?.items.map(task => task.runId), ['one', 'two'])
  assert.equal(Object.keys(store.source('a').getSnapshot().runs).length, 0)
  offline = true; store.reset(); await setImmediate()
  assert.equal(store.source('a').getSnapshot().tasks?.freshness, 'stale')
  assert.equal(store.source('a').getSnapshot().tasks?.items.length, 2)
  close(); duplicate(); assert.equal(timers.size, 0); store.dispose()
})

test('a Session dock ignores late discovery and rejects a task list belonging to another Session', async () => {
  let resolveA: (value: unknown) => void = () => {}
  const store = createConversationFeedback({ invoke: async (operation, args) => operation === 'session-open'
    ? { sessionToken: 'grant', expiresAt: Date.now() + 100000, pollIntervalMs: 17 }
    : args.sessionId === 'a' ? new Promise(resolve => { resolveA = resolve }) : { sessionId: 'foreign', tasks: [] } })
  const closeA = store.watchSession('a'); await setImmediate(); closeA()
  const closeB = store.watchSession('b'); await setImmediate()
  resolveA({ sessionId: 'a', tasks: [{ runId: 'late', kind: 'search', status: 'running', taskBrief: 'Late response' }] }); await setImmediate()
  assert.deepEqual(store.source('a').getSnapshot().tasks?.items, [])
  assert.equal(store.source('b').getSnapshot().tasks?.error, 'owner-denied')
  closeB(); store.dispose()
})

test('a terminal task summary replaces an in-flight stale detail read without waiting for it', async () => {
  const late = Promise.withResolvers<unknown>()
  let completed = false, detailReads = 0
  const store = createConversationFeedback({ schedule: () => () => {}, invoke: async operation => {
    if (operation === 'session-open') return { sessionToken: 'grant', expiresAt: Date.now() + 100000, pollIntervalMs: 17 }
    if (operation === 'conversation-runs') return { sessionId: 'owner', tasks: [{ runId: 'run', kind: 'search', status: completed ? 'completed' : 'running', taskBrief: 'Vehicles', revision: completed ? 2 : 1 }] }
    if (++detailReads === 2) return late.promise
    return { ...report('owner', 'run', completed ? 'completed' : 'running'), revision: completed ? 2 : 1 }
  } })
  const source = store.sessionSource('owner'), close = source.subscribe(() => {})
  try {
    await setImmediate()
    store.refresh('owner', 'run'); await setImmediate()
    assert.equal(detailReads, 2)
    completed = true
    store.refresh('owner'); await setImmediate()
    assert.equal(source.getSnapshot().runs.run?.run?.status, 'completed')
    assert.equal(detailReads, 3)
    late.resolve({ ...report('owner', 'run'), revision: 1 }); await setImmediate()
    assert.equal(source.getSnapshot().runs.run?.run?.status, 'completed')
  } finally { late.resolve(report('owner', 'run')); close(); store.dispose() }
})

test('one dock subscription owns discovery and the selected Run, including external resume and manual switching', async () => {
  const calls: string[] = [], timers = new Set<() => void>()
  let resumed = false
  const store = createConversationFeedback({
    invoke: async (operation, args) => {
      calls.push(`${operation}:${args.runId ?? ''}`)
      if (operation === 'session-open') return { sessionToken: 'grant', expiresAt: Date.now() + 100000, pollIntervalMs: 17 }
      if (operation === 'conversation-runs') return { sessionId: 'a', tasks: [{ runId: 'new', kind: 'search', status: resumed ? 'running' : 'paused', taskBrief: 'Newest' }, { runId: 'old', kind: 'crop', status: 'completed', taskBrief: 'Older' }] }
      return args.runId === 'new' ? report('a', 'new', resumed ? 'running' : 'paused') : { ...report('a', 'old', 'completed'), kind: 'crop', counts: { candidates: 8 } }
    },
    schedule: work => { timers.add(work); return () => { timers.delete(work) } },
  })
  const source = store.sessionSource('a'), close = source.subscribe(() => {}), second = source.subscribe(() => {})
  await setImmediate()
  assert.equal(source.getSnapshot().selectedRunId, 'new')
  assert.equal(calls.filter(call => call === 'run-get:new').length, 1)
  resumed = true
  const poll = [...timers][0]!; timers.clear(); poll(); await setImmediate()
  assert.equal(source.getSnapshot().runs.new?.run?.status, 'running')
  store.select('a', 'old'); await setImmediate()
  assert.equal(source.getSnapshot().selectedRunId, 'old')
  assert.equal(source.getSnapshot().runs.old?.run?.kind, 'crop')
  assert.equal(source.getSnapshot().runs.old?.run?.counts.candidates, 8)
  assert.equal(source.getSnapshot().runs.new?.run?.counts.candidates, 3)
  store.select('a', 'foreign'); assert.equal(source.getSnapshot().selectedRunId, 'old')
  close(); second(); assert.equal(timers.size, 0)
  store.dispose()
})
