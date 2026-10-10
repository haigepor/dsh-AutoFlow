import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../config-schema.js'
import { Store } from '../src/host/afp-state-store.js'
import { refreshRun, summary, reservedIds } from '../src/host/afp-refresh-workflow.js'
import { Changes } from '../src/host/afp-change-plans.js'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-afp-test-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const config = resolveConfig({ targetPerCategory: 1, batchSize: 1, maxBatches: 1 })
  const store = new Store(home, 'test-profile', config.maxStateBytes)
  return { config, store }
}

test('account deduplication excludes unnamed directory rows and still reads shared named collections', async () => {
  const calls = []
  const client = { listSelections: async () => [{ id: 'directory', name: '' }, { id: 'private', name: 'Private' }, { id: 'shared', name: 'Shared', isPrivate: false }],
    getSelection: async id => { calls.push(id); if (id === 'directory') throw new Error('HTTP 400'); return { docs: [{ id: `${id}-photo` }] } } }
  assert.deepEqual([...await reservedIds(client, new AbortController().signal)], ['private-photo', 'shared-photo'])
  assert.deepEqual(calls, ['private', 'shared'])
  client.getSelection = async () => { throw new Error('HTTP 403') }
  await assert.rejects(reservedIds(client, new AbortController().signal), /HTTP 403/)
})

test('configuration validates limits, credential names and network addresses', () => {
  assert.equal(resolveConfig({}).allowWrites, false)
  for (const value of [{ concurrency: 0 }, { maxPages: 11 }, { accessTokenRef: '../secret' }, { visionBaseUrl: 'http://localhost' }, { surprise: true }]) {
    assert.throws(() => resolveConfig(value))
  }
})

test('a cancelled visual batch remains pending and resumes without fetching again', async t => {
  const { config, store } = await fixture(t)
  const run = await store.createRun(['food'], config)
  const controller = new AbortController()
  let fetches = 0
  const primitives = {
    session: () => ({
      nextBatch: async () => { fetches++; return { candidates: [{ id: 'doc-1', title: 'Food', guid: 'g', provider: 'AFP' }], rejectedMetadataCandidates: [] } },
      exportState: () => ({ version: 1, categories: [] }),
      getStatus: () => ({ rawCandidateCount: 1 }),
    }),
    triage: async () => { controller.abort(); return [] },
  }
  await assert.rejects(refreshRun({ run, store, config, client: {}, signal: controller.signal, primitives }))
  const saved = await store.readRun(run.id)
  assert.equal(saved.pending.candidates.length, 1)
  primitives.triage = async ({ onProgress }) => {
    onProgress({ completed: 1, total: 1, previewed: 1, pixelReviewed: 1, requestFailures: 0 })
    return [{ id: 'doc-1', category: 'food', keep: true, confidence: 0.99, appliedThreshold: 0.85 }]
  }
  const progress = []
  const complete = await refreshRun({ run: saved, store, config, client: {}, signal: new AbortController().signal, primitives, onProgress: event => progress.push(event) })
  assert.equal(fetches, 1)
  assert.equal(summary(complete).categories[0].kept, 1)
  assert.equal(complete.pending, null)
  assert.equal(progress.at(-1).previewed, 1); assert.equal(progress.at(-1).pixelReviewed, 1)
  assert.equal(progress.at(-1).requestFailures, 0)
  assert.deepEqual(progress.at(-1).reviewedPhotos, [{ id: 'doc-1', title: 'Food', category: 'food', keep: true, requestFailed: false, reasonCode: null }])
})

test('plans refuse foreign sessions, remote drift and repeated writes', async t => {
  const { config, store } = await fixture(t)
  let docs = ['old']
  let writes = 0
  const client = {
    listSelections: async () => [{ id: 's', name: 'AutoFlow_食物', isPrivate: true }],
    getSelection: async () => ({ docs: docs.map(id => ({ id })) }),
    clearSelectionDocs: async () => { writes++; docs = [] },
  }
  const changes = new Changes({ store, config, connect: async () => ({ client, account: 'test-account' }) })
  const signal = new AbortController().signal
  const plan = await changes.plan({ operation: 'clear', categories: ['food'] }, 'session-a', signal)
  await assert.rejects(changes.check(plan.planId, 'session-b'), /owner/)
  docs = ['changed']
  await assert.rejects(changes.execute(plan.planId, 'session-a', signal), /changed/)
  assert.equal(writes, 0)
  const next = await changes.plan({ operation: 'clear', categories: ['food'] }, 'session-a', signal)
  const result = await changes.execute(next.planId, 'session-a', signal)
  assert.equal(result.status, 'completed')
  assert.equal(writes, 1)
  await assert.rejects(changes.execute(next.planId, 'session-a', signal), /used/)
})

for (const phase of ['preview', 'vision', 'confirmation']) test(`pause preserves the ${phase} checkpoint and resume finishes the pending photo`, async t => {
  const { config, store } = await fixture(t), run = await store.createRun(['food'], config)
  const controller = new AbortController()
  let searches = 0
  const primitives = {
    session: () => ({ nextBatch: async () => { searches++; return { candidates: [{ id: 'photo', title: 'Food' }] } },
      exportState: () => ({ version: 1, categories: [] }), getStatus: () => ({ rawCandidateCount: 1 }) }),
    triage: async ({ onReviewState }) => {
      await onReviewState({ id: 'photo', category: 'food', attempts: 1, phase })
      controller.abort(new DOMException('pause fixture', 'AfpPause')); controller.signal.throwIfAborted()
    },
  }
  await assert.rejects(refreshRun({ run, store, config, client: {}, signal: controller.signal, primitives }), { name: 'AfpPause' })
  const saved = await store.readRun(run.id)
  assert.equal(saved.status, 'paused'); assert.equal(saved.reviews[0].phase, phase)
  assert.equal(saved.pending.candidates[0].id, 'photo')
  primitives.triage = async ({ reviewStates }) => {
    assert.equal(reviewStates[0].phase, phase)
    return [{ id: 'photo', category: 'food', keep: true, confidence: .99, appliedThreshold: .85 }]
  }
  const completed = await refreshRun({ run: saved, store, config, client: {}, signal: new AbortController().signal, primitives })
  assert.equal(completed.status, 'ready'); assert.equal(completed.pending, null); assert.equal(searches, 1)
})

test('ambiguous and shared-only collection names refuse dry-run plans', async t => {
  const { config, store } = await fixture(t)
  for (const selections of [
    [{ id: 'shared', name: 'AutoFlow_食物', isPrivate: false }],
    [{ id: 'one', name: 'AutoFlow_食物', isPrivate: true }, { id: 'two', name: 'AutoFlow_食物', isPrivate: true }],
  ]) {
    const changes = new Changes({ store, config, connect: async () => ({ client: { listSelections: async () => selections }, account: 'a' }) })
    await assert.rejects(changes.plan({ operation: 'clear', categories: ['food'] }, 's', new AbortController().signal))
  }
})

test('store rejects model paths and serializes active owners', async t => {
  const { store } = await fixture(t)
  await assert.rejects(store.readRun('../other'), /id/)
  await store.lock('account', async () => {
    await assert.rejects(store.lock('account', async () => {}), /busy/)
  })
  await store.lock('account', async () => {})
})

test('a partial remote clear failure is recorded once and cannot be replayed', async t => {
  const { config, store } = await fixture(t)
  const collections = [{ id: 'food', name: 'AutoFlow_食物', isPrivate: true }, { id: 'animals', name: 'AutoFlow_动物', isPrivate: true }]
  const docs = new Map(collections.map(item => [item.id, ['old']]))
  let clears = 0
  const client = { listSelections: async () => collections, getSelection: async id => ({ docs: docs.get(id).map(id => ({ id })) }),
    clearSelectionDocs: async id => { clears++; if (id === 'animals') throw new Error('mock network failure'); docs.set(id, []) } }
  const changes = new Changes({ store, config, connect: async () => ({ client, account: 'mock' }) })
  const signal = new AbortController().signal
  const plan = await changes.plan({ operation: 'clear', categories: ['food', 'animals'] }, 's', signal)
  assert.equal(plan.categories.reduce((sum, item) => sum + item.remove, 0), 2)
  const result = await changes.execute(plan.planId, 's', signal)
  assert.equal(result.status, 'failed'); assert.equal(result.categories[0].removed, 1)
  assert.match(result.error, /partial/); assert.equal(clears, 2)
  assert.equal((await store.readPlan(plan.planId)).state, 'failed')
  await assert.rejects(changes.execute(plan.planId, 's', signal), /used/)
  assert.equal(clears, 2)
})

test('expired plans and changed accounts refuse writes before mutation', async t => {
  const { config, store } = await fixture(t)
  let account = 'first', writes = 0
  const client = { listSelections: async () => [{ id: 's', name: 'AutoFlow_食物', isPrivate: true }],
    getSelection: async () => ({ docs: [] }), clearSelectionDocs: async () => { writes++ } }
  const changes = new Changes({ store, config, connect: async () => ({ client, account }) }), signal = new AbortController().signal
  const preview = await changes.plan({ operation: 'clear', categories: ['food'] }, 's', signal)
  account = 'second'
  await assert.rejects(changes.execute(preview.planId, 's', signal), /account changed/)
  const saved = await store.readPlan(preview.planId); saved.expiresAt = 0; await store.savePlan(saved)
  await assert.rejects(changes.execute(preview.planId, 's', signal), /expired/)
  assert.equal(writes, 0)
})

test('confirmed writes hold the run lock and archival makes referenced plans unavailable before mutation', async t => {
  const { store, config } = await fixture(t), run = await store.createRun(['food'], config)
  run.account = 'account'; run.status = 'ready'
  run.groups.food = { candidates: [{ id: 'photo', title: 'Food', guid: 'guid', provider: 'AFP' }], batches: 1 }
  run.decisions = [{ id: 'photo', category: 'food', keep: true, confidence: .99, appliedThreshold: .85 }]
  await store.saveRun(run)
  let entered, finish, writes = 0
  const writing = new Promise(resolve => { entered = resolve }), waiting = new Promise(resolve => { finish = resolve })
  const client = { listSelections: async () => [{ id: 'food', name: 'AutoFlow_食物', isPrivate: true }],
    getSelection: async () => ({ docs: writes ? [{ id: 'photo' }] : [] }),
    addSelectionDoc: async () => { entered(); await waiting; writes++ } }
  const changes = new Changes({ store, config, connect: async () => ({ client, account: 'account' }) })
  const signal = new AbortController().signal
  const plan = await changes.plan({ operation: 'append', categories: ['food'], runId: run.id }, 'owner', signal)
  const executing = changes.execute(plan.planId, 'owner', signal)
  await writing
  await assert.rejects(store.archiveRun(run.id), /busy/)
  finish(); assert.equal((await executing).status, 'completed')
  const next = await changes.plan({ operation: 'append', categories: ['food'], runId: run.id }, 'owner', signal)
  await store.archiveRun(run.id)
  await assert.rejects(changes.check(next.planId, 'owner'), /Missing AFP record/)
  await assert.rejects(changes.execute(next.planId, 'owner', signal), /Missing AFP record/)
  assert.equal(writes, 1)
})
