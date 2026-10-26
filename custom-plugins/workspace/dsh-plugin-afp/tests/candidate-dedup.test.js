import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../config-schema.js'
import { createAfpApiClient } from '../src/vendor/auto-afp-img/afp-api-client.mjs'
import { createCandidateDedup } from '../src/host/afp-candidate-dedup.js'
import { createPhotoSearchSession } from '../src/vendor/auto-afp-img/afp-photo-search.mjs'
import { AfpService } from '../src/host/afp-service.js'
import { refreshRun } from '../src/host/afp-refresh-workflow.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const signal = () => new AbortController().signal
const collection = { id: 'private', name: 'Named', isPrivate: true, docsCount: 1, lastContentUpdate: '2026-10-26T00:00:00Z' }

function fixture(overrides = {}) {
  let lists = 0, full = 0
  const calls = [], reserved = new Set(), rows = [structuredClone(collection)]
  const client = { listSelections: async () => { lists++; return structuredClone(rows) },
    photoSelectionsByIds: async ids => { calls.push(ids); return ids.map(id => ({ id, selections: id === 'existing' ? [{ id: 'private' }] : [] })) }, ...overrides }
  return { client, rows, calls, reserved, counts: () => ({ lists, full }),
    async create(options = {}) { return createCandidateDedup({ client, signal: signal(), reserved, pageSize: 2,
      readAll: async () => { full++; return new Set(['existing', 'fallback-photo']) }, ...options }) } }
}

test('candidate dedup is opt-in and saved full-scan settings stay explicit', () => {
  assert.equal(resolveConfig().dedupReadMode, 'full')
  assert.equal(resolveConfig({ dedupReadMode: 'candidate' }).dedupReadMode, 'candidate')
  assert.throws(() => resolveConfig({ dedupReadMode: 'cached' }), /dedupReadMode/)
})

test('membership reads request only canonical photo identities and selection ids', async () => {
  let body
  const client = createAfpApiClient({ accessToken: 'fixture', retries: 0, fetchImpl: async (_url, options) => {
    body = JSON.parse(options.body)
    return Response.json({ data: { docs: [{ id: 'photo', selections: [] }] } })
  } })
  assert.deepEqual(await client.photoSelectionsByIds(['photo']), [{ id: 'photo', selections: [] }])
  assert.deepEqual(body.variables, { ids: ['photo'], input: { isUno: true } })
  assert.match(body.query, /selections\s*\{\s*id\s*\}/)
  assert.doesNotMatch(body.query, /medias|caption|title/)
})

test('private candidate reads avoid collection bodies and validate fresh directory metadata on each batch', async () => {
  const f = fixture(), reader = await f.create()
  await reader.update([{ id: 'existing' }, { id: 'new' }, { id: 'another' }])
  assert.deepEqual([...f.reserved], ['existing'])
  assert.deepEqual(f.calls, [['existing', 'new'], ['another']])
  assert.equal(f.counts().full, 0)
  assert.equal(f.counts().lists, 3)
  await reader.update([{ id: 'new' }])
  assert.equal(f.counts().lists, 5)
})

for (const kind of ['shared', 'unclassified', 'unversioned']) test(`${kind} collections use a full scan before visual work`, async () => {
  const f = fixture()
  if (kind === 'shared') f.rows[0].isPrivate = false
  if (kind === 'unclassified') delete f.rows[0].isPrivate
  if (kind === 'unversioned') delete f.rows[0].lastContentUpdate
  const reader = await f.create()
  assert.equal(reader.mode, 'full')
  assert.deepEqual([...f.reserved], ['existing', 'fallback-photo'])
  assert.equal(f.counts().full, 1)
  assert.equal(f.calls.length, 0)
})

for (const docs of [[], [{ id: 'new', selections: null }], [{ id: 'new' }], [{ id: 'new', selections: [{ id: '' }] }],
  [{ id: 'other', selections: [] }], [{ id: 'new', selections: [] }, { id: 'new', selections: [] }]]) {
  test(`unresolved membership falls back to complete fresh membership (${JSON.stringify(docs)})`, async () => {
    const f = fixture({ photoSelectionsByIds: async () => docs }), reader = await f.create()
    await reader.update([{ id: 'new' }])
    assert.ok(f.reserved.has('fallback-photo'))
    assert.equal(f.counts().full, 1)
  })
}

test('unnamed collections do not exclude candidates and unknown selection ids trigger full verification', async () => {
  const f = fixture({ photoSelectionsByIds: async () => [{ id: 'new', selections: [{ id: 'sandbox' }] }] })
  f.rows.push({ id: 'sandbox', name: '' })
  const reader = await f.create(); await reader.update([{ id: 'new' }])
  assert.equal(f.reserved.size, 0)
  f.client.photoSelectionsByIds = async () => [{ id: 'new', selections: [{ id: 'unknown' }] }]
  await reader.update([{ id: 'new' }])
  assert.equal(f.counts().full, 1)
})

test('a membership replacement or local write during a reverse read cannot publish an incomplete exclusion set', async () => {
  for (const local of [false, true]) {
    let generation = 0
    const f = fixture({ photoSelectionsByIds: async () => {
      if (local) generation++
      else f.rows[0].lastContentUpdate = '2026-10-26T00:00:01Z'
      return [{ id: 'new', selections: [] }]
    } }), reader = await f.create({ version: () => generation })
    await reader.update([{ id: 'new' }])
    assert.equal(f.counts().full, 1)
    assert.ok(f.reserved.has('fallback-photo'))
  }
})

test('read failures and cancellation stop visual admission instead of treating unknown membership as empty', async () => {
  const failure = new Error('fixture read failed'), f = fixture({ photoSelectionsByIds: async () => { throw failure } })
  const reader = await f.create()
  await assert.rejects(reader.update([{ id: 'new' }]), error => error === failure)
  assert.equal(f.counts().full, 0)
  const controller = new AbortController(), stopped = fixture(), cancelled = await stopped.create({ signal: controller.signal })
  controller.abort()
  await assert.rejects(cancelled.update([{ id: 'new' }]), { name: 'AbortError' })
  assert.equal(stopped.calls.length, 0)
})

test('an active local write and incomplete membership bypass complete-scan caches', async () => {
  for (const pending of [false, true]) {
    const f = fixture({ photoSelectionsByIds: async () => [] })
    const reader = await f.create({ writesPending: () => pending, readAll: async options => {
      assert.deepEqual(options, { fresh: true })
      return new Set(['verified-fresh'])
    } })
    await reader.update([{ id: 'new' }])
    assert.deepEqual([...f.reserved], ['verified-fresh'])
  }
})

test('search excludes fresh memberships before consuming pages and rechecks restored queues', async () => {
  const f = fixture(), reader = await f.create(), blocked = new Set()
  let searches = 0
  const profile = { key: 'food', selectionName: 'Synthetic', queryVariants: ['synthetic'], metadataRequiredAny: [], metadataExclusions: [] }
  const options = { profiles: [profile], pageSize: 3, maxPages: 1, readRetries: 0,
    client: { searchPhotos: async () => { searches++; return { docs: ['existing', 'new1', 'new2'].map(id => ({ id, guid: id, title: id })), hasMore: false } } },
    onCandidates: async values => { await reader.update(values); for (const id of f.reserved) blocked.add(id) } }
  const first = createPhotoSearchSession(options)
  const batch = await first.nextBatch('food', { batchSize: 1, excludedIds: blocked })
  assert.deepEqual(batch.candidates.map(x => x.id), ['new1'])
  assert.equal(batch.stats.globallyExcludedCount, 1)
  f.client.photoSelectionsByIds = async ids => ids.map(id => ({ id, selections: [{ id: 'private' }] }))
  const resumed = createPhotoSearchSession({ ...options, searchState: first.exportState() })
  const next = await resumed.nextBatch('food', { batchSize: 1, excludedIds: blocked })
  assert.deepEqual(next.candidates, [])
  assert.equal(next.stats.globallyExcludedCount, 1)
  assert.equal(searches, 1)
})

test('candidate service reaches visual admission without full collection reads and excludes collected photos', async t => {
  const home = await mkdtemp(join(tmpdir(), 'afp-candidate-')), jobs = [], previewed = []
  let full = 0, lookups = 0
  const client = { listSelections: async () => [collection],
    getSelection: async () => { full++; return { docs: ['existing'] } },
    photoSelectionsByIds: async ids => { lookups++; return ids.map(id => ({ id, selections: id === 'existing' ? [{ id: collection.id }] : [] })) },
    searchPhotos: async () => ({ docs: ['existing', 'new'].map(id => ({ id, guid: id, title: id,
      caption: 'Fresh homemade meal with roasted food and vegetables on a plate' })), hasMore: false }) }
  const service = new AfpService({ profileContext: { home, dir: join(home, 'profile') },
    jobs: { start(spec) { jobs.push(spec.run({ append() {}, updateProgress() {} })); return `job-${jobs.length}` } } },
  resolveConfig({ dedupReadMode: 'candidate', targetPerCategory: 1, batchSize: 1, pageSize: 2, maxPages: 1, maxBatches: 1, maxSearchRequests: 1 }),
  { connection: { open: async () => ({ client, account: 'fixture-account',
    previewClient: { getPreviewBytes: async id => { previewed.push(id); throw new Error('fixture stops before model work') } }, visionClient: {} }) } })
  t.after(async () => { await service.dispose(); await rm(home, { recursive: true, force: true }) })
  await service.enable('refresh')
  await service.startRefresh({ categories: ['food'] }, undefined, signal())
  assert.equal((await jobs.at(-1).done).status, 'completed')
  assert.equal(full, 0)
  assert.equal(lookups, 1)
  assert.deepEqual(previewed, ['new'])
  assert.equal(service.dedupSnapshot, null)
})

test('a restored pending visual batch rechecks membership without searching again', async () => {
  const f = fixture(), reader = await f.create(), reviewed = []
  const run = { categories: ['food'], groups: {}, decisions: [], searchState: null,
    pending: { category: 'food', candidates: ['existing', 'new'].map(id => ({ id, title: id })), exhausted: true } }
  await refreshRun({ run, config: resolveConfig({ targetPerCategory: 1, maxBatches: 1 }),
    store: { saveRun: async () => {} }, client: {}, signal: signal(), reserved: f.reserved,
    readReserved: values => reader.update(values), primitives: {
      session: () => ({ nextBatch: async () => { throw new Error('Restored batch must not search again') } }),
      triage: async ({ candidateManifest }) => candidateManifest.categories.flatMap(group => group.candidates.map(photo => {
        reviewed.push(photo.id)
        return { id: photo.id, category: 'food', keep: true, confidence: .99 }
      })),
    } })
  assert.deepEqual(f.calls, [['existing', 'new']])
  assert.deepEqual(reviewed, ['new'])
  assert.equal(run.status, 'ready')
  assert.equal(f.counts().full, 0)
})
