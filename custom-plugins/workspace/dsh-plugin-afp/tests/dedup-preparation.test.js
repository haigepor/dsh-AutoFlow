import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../config-schema.js'
import { AfpService } from '../src/host/afp-service.js'
import { reservedIds } from '../src/host/afp-refresh-workflow.js'

const signal = () => new AbortController().signal
const revision = '2026-10-26T01:00:00.000Z'

async function fixture(t, overrides = {}) {
  const home = await mkdtemp(join(tmpdir(), 'afp-dedup-'))
  const jobs = [], reads = []
  const config = resolveConfig({ targetPerCategory: 1, batchSize: 1, maxBatches: 1, ...overrides })
  let account = 'account-one', lists = 0
  const selections = [{ id: 'private', name: 'Private', docsCount: 1, lastContentUpdate: revision, isPrivate: true },
    { id: 'shared', name: 'Shared', docsCount: 1, lastContentUpdate: revision, isPrivate: false }]
  const client = { listSelections: async () => { lists++; return structuredClone(selections) },
    getSelection: async id => { reads.push(id); return { docs: [`${id}-photo`] } },
    searchPhotos: async () => ({ docs: [], hasMore: false }) }
  const ctx = { profileContext: { home, dir: join(home, 'profile') },
    jobs: { start(spec) { jobs.push(spec.run({ append() {}, updateProgress() {} })); return `job-${jobs.length}` } } }
  const connection = { open: async () => ({ client, account }), status: async () => ({ credentials: {} }) }
  const service = new AfpService(ctx, config, { connection })
  t.after(async () => { await service.dispose(); await rm(home, { recursive: true, force: true }) })
  const disableRefresh = await service.enable('refresh')
  return { service, client, reads, selections, jobs, disableRefresh, lists: () => lists, account: value => { account = value },
    async run(expectedStatus = 'completed', args = { categories: ['food'] }) {
      const task = await service.startRefresh(args, undefined, signal())
      const result = await jobs.at(-1).done
      assert.equal(result.status, expectedStatus, result.detail)
      return service.store.readRun(task.runId)
    } }
}

test('fresh tasks reuse verified account membership while reloading the collection directory', async t => {
  const f = await fixture(t)
  const first = await f.run(), next = await f.run()
  assert.notEqual(first.id, next.id)
  assert.equal(f.lists(), 2)
  assert.deepEqual(f.reads, ['private', 'shared'])
  assert.deepEqual(next.dedup.collections, first.dedup.collections)
})

test('same-count replacements invalidate resumed membership when lastContentUpdate changes', async () => {
  const checkpoint = {}, row = { id: 'collection', name: 'Named', docsCount: 1, lastContentUpdate: revision }
  let member = 'before'
  const client = { listSelections: async () => [row], getSelection: async () => ({ docs: [member] }) }
  assert.deepEqual([...await reservedIds(client, signal(), { checkpoint, ttlMs: 60000 })], ['before'])
  member = 'after'; row.lastContentUpdate = '2026-10-26T01:00:01.000Z'
  assert.deepEqual([...await reservedIds(client, signal(), { checkpoint, ttlMs: 60000 })], ['after'])
})

test('cross-task membership never crosses accounts', async t => {
  const f = await fixture(t)
  await f.run(); f.account('account-two'); await f.run()
  assert.equal(f.reads.length, 4)
})

test('zero snapshot TTL makes every task read every named collection', async t => {
  const f = await fixture(t, { dedupSnapshotTtlMs: 0 })
  await f.run(); await f.run()
  assert.equal(f.reads.length, 4)
})

test('collections without a valid content revision are read again for every fresh task', async t => {
  const f = await fixture(t)
  delete f.selections[0].lastContentUpdate
  f.selections[1].lastContentUpdate = 'invalid-revision'
  await f.run(); await f.run()
  assert.equal(f.reads.length, 4)
})

test('reusing membership does not extend its TTL and expiration reloads the account', async t => {
  let now = 1000000
  t.mock.method(Date, 'now', () => now)
  const f = await fixture(t, { dedupSnapshotTtlMs: 1000 })
  await f.run(); now += 999; await f.run()
  assert.equal(f.reads.length, 2)
  now++; await f.run()
  assert.equal(f.reads.length, 4)
})

test('same-count content changes reload only the changed collection for a new task', async t => {
  const f = await fixture(t)
  await f.run()
  f.selections[0].lastContentUpdate = '2026-10-26T02:00:00.000Z'
  f.client.getSelection = async id => { f.reads.push(id); return { docs: [`${id}-replacement`] } }
  const next = await f.run()
  assert.deepEqual(f.reads, ['private', 'shared', 'private'])
  assert.deepEqual(next.dedup.collections.private.ids, ['private-replacement'])
  assert.deepEqual(next.dedup.collections.shared.ids, ['shared-photo'])
})

test('fresh directories prune removed collections and load newly visible shared collections', async t => {
  const f = await fixture(t)
  await f.run()
  f.selections.shift()
  f.selections.push({ id: 'new-shared', name: 'New shared', docsCount: 1, lastContentUpdate: revision, isPrivate: false })
  const next = await f.run()
  assert.deepEqual(Object.keys(next.dedup.collections).sort(), ['new-shared', 'shared'])
  assert.deepEqual(f.reads, ['private', 'shared', 'new-shared'])
})

test('member count mismatch prevents cross-task reuse even when the revision matches', async t => {
  const f = await fixture(t)
  f.selections[0].docsCount = 2
  await f.run(); await f.run()
  assert.deepEqual(f.reads, ['private', 'shared', 'private'])
})

test('directory failure stops preparation instead of accepting cached membership', async t => {
  const f = await fixture(t)
  await f.run()
  f.client.listSelections = async () => { throw new Error('HTTP 403') }
  const failed = await f.run('failed')
  assert.equal(failed.stage, 'collections')
  assert.equal(f.reads.length, 2)
})

test('failed scans retain their run checkpoint but never publish a partial account snapshot', async t => {
  const f = await fixture(t, { collectionConcurrency: 1 })
  const original = f.client.getSelection
  f.client.getSelection = async id => { if (id === 'shared') throw new Error('HTTP 403'); return original(id) }
  const failed = await f.run('failed')
  assert.deepEqual(Object.keys(failed.dedup.collections), ['private'])
  f.client.getSelection = original
  await f.run()
  assert.deepEqual(f.reads, ['private', 'private', 'shared'])
})

test('disabling refresh drains its jobs and discards cross-task membership', async t => {
  const f = await fixture(t)
  await f.run()
  await f.disableRefresh(); await f.service.enable('refresh'); await f.run()
  assert.equal(f.reads.length, 4)
})

test('write previews always reread remote membership after preparation has warmed its cache', async t => {
  const f = await fixture(t)
  f.selections[0].name = 'AutoFlow_食物'
  await f.run(); await f.run()
  assert.equal(f.reads.length, 2)
  const plan = await f.service.changes.plan({ operation: 'clear', categories: ['food'] }, 'session', signal())
  assert.equal(plan.categories[0].existing, 1)
  assert.deepEqual(f.reads, ['private', 'shared', 'private', 'shared'])
})

test('in-flight and completed write jobs invalidate cross-task membership even before directory metadata changes', async t => {
  const f = await fixture(t)
  await f.run(); await f.service.enable('write')
  let enter, release
  const entered = new Promise(resolve => { enter = resolve }), pending = new Promise(resolve => { release = resolve })
  f.service.job('write', undefined, 'Synthetic membership write', async () => { enter(); await pending; return { status: 'completed' } })
  const write = f.jobs.at(-1)
  await entered
  try { await f.run(); assert.equal(f.reads.length, 4) }
  finally { release(); await write.done }
  await f.run()
  assert.equal(f.reads.length, 6)
})

test('cache-only preparation commits its checkpoint once before returning global membership', async () => {
  const first = {}, next = {}, rows = [1, 2, 3, 4].map(id => ({ id: String(id), name: 'Named', docsCount: 1, lastContentUpdate: revision }))
  const client = { listSelections: async () => rows, getSelection: async id => ({ docs: [`photo-${id}`] }) }
  await reservedIds(client, signal(), { checkpoint: first, ttlMs: 60000 })
  let saves = 0
  const ids = await reservedIds(client, signal(), { checkpoint: next, cachedCollections: first.collections, ttlMs: 60000,
    onCheckpoint: async snapshot => { saves++; assert.equal(Object.keys(snapshot.collections).length, 4) } })
  assert.equal(saves, 1)
  assert.deepEqual([...ids].sort(), ['photo-1', 'photo-2', 'photo-3', 'photo-4'])
})

test('resuming an older run after a local write reloads its otherwise fresh membership checkpoint', async t => {
  const f = await fixture(t)
  const first = await f.run(); await f.service.enable('write')
  f.service.job('write', undefined, 'Synthetic membership write', async () => ({ status: 'completed' }))
  await f.jobs.at(-1).done
  await f.run('completed', { runId: first.id })
  assert.equal(f.reads.length, 4)
})

test('cancellation while saving reused membership never returns a completed preparation', async () => {
  const checkpoint = {}, controller = new AbortController()
  const client = { listSelections: async () => [{ id: 'one', name: 'Named', docsCount: 1, lastContentUpdate: revision }],
    getSelection: async () => ({ docs: ['photo'] }) }
  await reservedIds(client, signal(), { checkpoint, ttlMs: 60000 })
  await assert.rejects(reservedIds(client, controller.signal, { checkpoint: {}, cachedCollections: checkpoint.collections, ttlMs: 60000,
    onCheckpoint: async () => { controller.abort(new DOMException('Synthetic pause', 'AbortError')) } }), { name: 'AbortError' })
})

test('workbench membership writes invalidate reuse before unchanged directory metadata can hide a replacement', async t => {
  const f = await fixture(t)
  await f.run(); await f.service.enable('write')
  let added = false
  f.client.photosByIds = async () => [{ id: 'new-photo', title: 'Synthetic photo' }]
  f.client.addSelectionDoc = async () => { added = true }
  f.client.getSelection = async id => {
    f.reads.push(id)
    return { docs: [id === 'private' && added ? 'new-photo' : `${id}-photo`] }
  }
  const result = await f.service.collectionOperation({ action: 'copy', photoIds: ['new-photo'],
    photoSources: { 'new-photo': [] }, targetCollectionId: 'private' }, signal())
  assert.equal(result.completed, 1)
  const next = await f.run()
  assert.equal(f.reads.length, 6)
  assert.deepEqual(next.dedup.collections.private.ids, ['new-photo'])
})
