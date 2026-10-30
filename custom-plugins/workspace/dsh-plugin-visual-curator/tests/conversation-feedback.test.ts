import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createConversationFeedback } from '../src/client/conversation-feedback.ts'
import { resultCategory } from '../src/shared/search-feedback.ts'

const report = (sessionId: string, runId: string, status = 'running') => ({ runId, owner: { kind: 'session', sessionId }, kind: 'search', status, stage: 'retrieving', counts: { candidates: 3, qualified: 0 }, warnings: [], results: [], resultSummary: { selected: 0, needsReview: 1, candidates: 2, target: 10 } })

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
