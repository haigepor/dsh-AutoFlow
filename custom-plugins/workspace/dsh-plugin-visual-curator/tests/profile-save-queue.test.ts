import assert from 'node:assert/strict'
import test from 'node:test'
import { createProfileSaveQueue, type ProfileSaveInput } from '../src/client/profile-save-queue.ts'

const context = { styleId: 'collection', analysisRunId: 'analysis', profileId: 'profile-1' }
const settle = async () => { await new Promise<void>(resolve => setImmediate(resolve)) }
function gate<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(accept => { resolve = accept }), resolve: (value: T) => resolve(value) } }

test('checkbox edits remain responsive and coalesce while each save follows the last immutable receipt', async () => {
  const first = gate<{ id: string }>(), calls: ProfileSaveInput[] = []
  const queue = createProfileSaveQueue({ changed() {}, operationId: () => `save-${calls.length}`, save: async input => { calls.push(input); return calls.length === 1 ? first.promise : { id: 'profile-3' } } })
  queue.sync(context)
  queue.change({ ruleId: 'a', enabled: false }); await settle()
  queue.change({ ruleId: 'b', enabled: false }); queue.change({ ruleId: 'a', enabled: true }); queue.change({ ruleId: 'b', enabled: true }); queue.change({ ruleId: 'b', enabled: false })
  assert.equal(queue.getSnapshot().saving, true)
  assert.deepEqual(queue.getSnapshot().changes, [{ ruleId: 'a', enabled: true }, { ruleId: 'b', enabled: false }])
  assert.equal(calls.length, 1)
  first.resolve({ id: 'profile-2' }); assert.equal(await queue.flush(), true)
  assert.equal(calls.length, 2)
  assert.equal(calls[1]!.expectedProfileId, 'profile-2')
  assert.deepEqual(calls[1]!.changes, [{ ruleId: 'a', enabled: true }, { ruleId: 'b', enabled: false }])
  assert.equal(queue.getSnapshot().profileId, 'profile-3'); assert.equal(queue.getSnapshot().changes.length, 0)
})

test('a lost acknowledgement keeps the same envelope for retry before sending newer edits', async () => {
  const calls: ProfileSaveInput[] = []
  const queue = createProfileSaveQueue({ changed() {}, operationId: () => `save-${calls.length}`, save: async input => { calls.push(input); if (calls.length === 1) throw new Error('lost acknowledgement'); return { id: calls.length === 2 ? 'profile-2' : 'profile-3' } } })
  queue.sync(context); queue.change({ ruleId: 'a', enabled: false }); await settle()
  assert.equal(queue.getSnapshot().failed, true)
  queue.sync({ ...context, profileId: 'profile-2' })
  queue.change({ ruleId: 'a', enabled: true }); await settle()
  assert.equal(calls.length, 1, 'new edits must not silently replay an unconfirmed action')
  assert.equal(await queue.flush(), true)
  assert.deepEqual(calls[0], calls[1], 'explicit retry must reconcile the same immutable operation')
  assert.deepEqual(calls[2]!.changes, [{ ruleId: 'a', enabled: true }]); assert.equal(calls[2]!.expectedProfileId, 'profile-2')
})

test('a rejected revision can reapply retained edits only after refreshing the saved profile identity', async () => {
  const calls: ProfileSaveInput[] = []
  const queue = createProfileSaveQueue({ changed() {}, operationId: () => `save-${calls.length}`, save: async input => { calls.push(input); if (calls.length === 1) throw { code: 'revision-conflict' }; return { id: 'profile-3' } } })
  queue.sync(context); queue.change({ ruleId: 'a', enabled: false }); await settle()
  queue.sync({ ...context, profileId: 'profile-2' })
  assert.equal(queue.getSnapshot().failed, true, 'refreshing alone must not write the draft')
  assert.equal(calls.length, 1)
  assert.equal(await queue.flush(), true)
  assert.equal(calls[1]!.expectedProfileId, 'profile-2'); assert.notEqual(calls[1]!.operationId, calls[0]!.operationId)
  assert.deepEqual(calls[1]!.changes, [{ ruleId: 'a', enabled: false }])
})

test('new collection scopes and disposal ignore late save acknowledgements', async () => {
  const held = gate<{ id: string }>()
  const queue = createProfileSaveQueue({ changed() {}, save: () => held.promise })
  queue.sync(context); queue.change({ ruleId: 'a', enabled: false }); await settle()
  const old = queue.flush()
  queue.sync({ styleId: 'other', analysisRunId: 'other-analysis', profileId: 'other-profile' })
  held.resolve({ id: 'late-profile' }); assert.equal(await old, false)
  assert.equal(queue.getSnapshot().profileId, 'other-profile'); assert.equal(queue.getSnapshot().changes.length, 0)
  queue.dispose()
})
