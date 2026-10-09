import test from 'node:test'
import assert from 'node:assert/strict'
import { afpProgressModel, registerAfpProgress } from '../src/client/afp-conversation-progress.js'
import { registerAfpConversationPhotos } from '../src/client/afp-conversation-photos.js'

test('AFP inline presenters register once without adding a capsule dock', () => {
  const keys = new Set()
  const ctx = { slots: {
    register(options) {
      if (options.key) { assert.equal(keys.has(options.key), false, options.key); keys.add(options.key) }
      return () => {}
    },
    inject(name, factory) { assert.notEqual(name, 'conversation.input.dock'); const result = factory(); if (result?.[Symbol.iterator]) for (const item of result) void item },
  } }
  registerAfpProgress(ctx, () => null, 'afp')
  registerAfpConversationPhotos(ctx, () => null, 'afp')
  assert.ok(keys.has('afp_result_page'))
})

test('successful status checks complete setup without claiming a confirmed AFP read', () => {
  const rows = [{ root: { callId: 'status', kind: 'tool-result', call: { name: 'afp_status' }, content: [{ type: 'text', text: '{}' }] } },
    { root: { callId: 'search', kind: 'tool-call', call: { name: 'afp_photo_search_start' } } }]
  const model = afpProgressModel(rows, { status: 'open' }, [])
  assert.equal(model.states[0], 'done')
  assert.equal(model.connectionRead, false)
  assert.equal(model.states[1], 'running')
  rows[0].root.isError = true
  assert.equal(afpProgressModel(rows, { status: 'open' }, []).states[0], 'pending')
})

test('visual jobs retain real progress after their start tool returns a job handle', () => {
  const rows = [{ root: { callId: 'refresh', kind: 'tool-result', call: { name: 'afp_refresh' },
    content: [{ type: 'text', text: JSON.stringify({ jobId: 'job', runId: 'run' }) }] } }]
  const live = [{ callId: 'refresh', name: 'afp_refresh', state: 'running', stage: 'visual', completed: 3, total: 10 }]
  const model = afpProgressModel(rows, { status: 'open' }, live)
  assert.deepEqual(model.active, live[0])
  assert.equal(model.waiting, false); assert.equal(model.stage, 3)
  assert.equal(model.states[3], 'running'); assert.equal(model.operation, 'agentVisualReview')
  assert.equal(model.complete, false); assert.equal(model.selectionSaved, false)
})

test('closed and interrupted turns cannot keep a stale visual job running or claim final selection', () => {
  const rows = [{ root: { callId: 'refresh', kind: 'tool-result', call: { name: 'afp_refresh' },
    content: [{ type: 'text', text: '{"jobId":"job"}' }] } }]
  const live = [{ callId: 'refresh', name: 'afp_refresh', state: 'running', stage: 'visual', completed: 3, total: 10 }]
  for (const kind of ['completed', 'aborted', 'interrupted']) {
    const model = afpProgressModel(rows, { status: 'closed', end: { data: { reason: { kind } } } }, live)
    assert.equal(model.active, undefined, kind)
    assert.equal(model.complete, false); assert.equal(model.selectionSaved, false)
    assert.equal(model.states.includes('running'), false)
    assert.equal(model.status, kind === 'completed' ? 'agentNoFinalSelection' : 'agentStopped')
    if (kind !== 'completed') assert.equal(model.states[4], 'stopped')
  }
})

test('settled synchronous calls and rejected visual launches ignore stale running polls', () => {
  for (const [name, isError] of [['afp_photo_search_start', false], ['afp_refresh', true]]) {
    const rows = [{ root: { callId: 'settled', kind: 'tool-result', call: { name }, isError,
      content: [{ type: 'text', text: isError ? '{"code":"invalid-arguments"}' : '{"items":[]}' }] } }]
    const model = afpProgressModel(rows, { status: 'open' }, [{ callId: 'settled', name, state: 'running', stage: 'visual', completed: 3, total: 10 }])
    assert.equal(model.active, undefined)
    assert.equal(model.complete, false)
  }
})

test('owned failed and stopped visual jobs show terminal states before the turn closes', () => {
  const rows = [{ root: { callId: 'refresh', kind: 'tool-result', call: { name: 'afp_refresh' }, content: [{ type: 'text', text: '{"jobId":"job"}' }] } }]
  for (const state of ['failed', 'stopped']) {
    const live = [{ callId: 'refresh', name: 'afp_refresh', state, stage: state, completed: 3, total: 10 }]
    for (const status of ['open', 'closed']) {
      const model = afpProgressModel(rows, { status, end: { data: { reason: { kind: 'completed' } } } }, live)
      assert.equal(model.status, state === 'failed' ? 'agentOperationFailed' : 'agentStopped')
      assert.equal(model.states[3], state); assert.equal(model.states[4], state)
      assert.equal(model.operation, null); assert.equal(model.waiting, false); assert.equal(model.complete, false)
      assert.deepEqual(model.visualProgress, live[0])
    }
  }
  const unowned = afpProgressModel(rows, { status: 'open' }, [{ callId: 'foreign', name: 'afp_refresh', state: 'failed', stage: 'failed' }])
  assert.equal(unowned.failed, false); assert.equal(unowned.visualProgress, undefined)
})

test('a newer visual launch or successful final selection supersedes older job failure', () => {
  const root = (callId, name, value) => ({ root: { callId, kind: 'tool-result', call: { name }, content: [{ type: 'text', text: JSON.stringify(value) }] } })
  const first = root('old', 'afp_refresh', { jobId: 'old-job' })
  const stale = { callId: 'old', name: 'afp_refresh', state: 'failed', stage: 'failed', completed: 3, total: 10 }
  const current = { callId: 'new', name: 'afp_refresh', state: 'running', stage: 'visual', completed: 1, total: 4 }
  const restarted = afpProgressModel([first, root('new', 'afp_refresh', { jobId: 'new-job' })], { status: 'open' }, [stale, current])
  assert.equal(restarted.failed, false); assert.equal(restarted.stopped, false)
  assert.deepEqual(restarted.active, current)
  const completed = afpProgressModel([first, root('selected', 'afp_photo_selection', { items: [{ id: 'p1' }] })],
    { status: 'closed', end: { data: { reason: { kind: 'completed' } } } }, [stale])
  assert.equal(completed.failed, false); assert.equal(completed.complete, true); assert.equal(completed.selectedCount, 1)
  const jobOnly = afpProgressModel([first], { status: 'open' }, [{ ...stale, state: 'completed', stage: 'completed', completed: 10 }])
  assert.equal(jobOnly.complete, false); assert.equal(jobOnly.selectionSaved, false)
  assert.equal(jobOnly.waiting, true); assert.equal(jobOnly.operation, 'agentWaitingModel')
})
