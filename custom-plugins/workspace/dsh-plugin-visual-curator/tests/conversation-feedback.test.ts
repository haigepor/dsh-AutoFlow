import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createConversationFeedback } from '../src/client/conversation-feedback.ts'
import { resultCategory } from '../src/shared/search-feedback.ts'

const report = (sessionId: string, runId: string, status = 'running') => ({ runId, owner: { kind: 'session', sessionId }, kind: 'search', status, stage: 'retrieving', counts: { candidates: 3, qualified: 0 }, warnings: [], results: [], resultSummary: { selected: 0, needsReview: 1, candidates: 2, target: 10 } })

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
