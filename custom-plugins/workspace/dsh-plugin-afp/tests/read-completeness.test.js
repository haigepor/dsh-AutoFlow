import test from 'node:test'
import assert from 'node:assert/strict'
import { createAfpApiClient } from '../src/vendor/auto-afp-img/afp-api-client.mjs'
import { reservedIds, refreshRun } from '../src/host/afp-refresh-workflow.js'
import { createCandidateDedup } from '../src/host/afp-candidate-dedup.js'
import { resolveConfig } from '../config-schema.js'

const search = { operationName: 'getPhotos', query: 'query getPhotos { photos { docs { uno } } }', variables: {} }
const malformed = [['empty body', ''], ['invalid JSON', '{'], ['null payload', 'null'], ['missing result', '{}']]
const signal = () => new AbortController().signal
const clientFor = body => createAfpApiClient({ accessToken: 'fixture-only', retries: 0,
  fetchImpl: async () => new Response(body, { headers: { 'content-type': 'application/json' } }) })

for (const [label, body] of malformed) {
  for (const mode of ['full', 'candidate']) test(`${mode} dedup stops on a malformed directory (${label}) instead of admitting an empty account`, async () => {
    const client = clientFor(body), reserved = new Set(['previously-collected'])
    let checkpoints = 0, fallbacks = 0
    const operation = mode === 'full'
      ? () => reservedIds(client, signal(), { onCheckpoint: async () => { checkpoints++ } })
      : () => createCandidateDedup({ client, signal: signal(), reserved, pageSize: 2,
        readAll: async () => { fallbacks++; return new Set() } })
    await assert.rejects(operation)
    assert.equal(checkpoints, 0)
    assert.equal(fallbacks, 0)
    assert.deepEqual([...reserved], ['previously-collected'])
  })
}

for (const [label, body] of [...malformed,
  ['missing docs', JSON.stringify({ data: { photos: { hasMore: false } } })],
  ['non-array docs', JSON.stringify({ data: { photos: { docs: {} } } })]]) {
  test(`photo search reports a malformed response (${label}) instead of a successful empty result`, async () => {
    await assert.rejects(() => clientFor(body).searchPhotos(search))
  })
}

for (const [label, body] of [...malformed,
  ['non-array docs', JSON.stringify({ data: { docs: {} } })]]) {
  test(`photo detail reads report a malformed response (${label}) instead of a missing photo`, async () => {
    await assert.rejects(() => clientFor(body).photosByIds(['photo']))
  })
}

for (const [label, payload] of [['direct', []], ['selections', { selections: [] }], ['data', { data: [] }]]) {
  test(`an explicitly empty ${label} directory remains usable by both dedup modes`, async () => {
    const client = clientFor(JSON.stringify(payload)), reserved = new Set()
    assert.deepEqual([...await reservedIds(client, signal())], [])
    const reader = await createCandidateDedup({ client, signal: signal(), reserved, pageSize: 2,
      readAll: async () => { throw new Error('An explicitly empty directory does not need a full scan') } })
    assert.equal(reader.mode, 'candidate')
  })
}

for (const [label, payload] of [['missing id', [{}]], ['null row', [null]], ['empty id', [{ id: '' }]], ['non-string id', [{ id: 3 }]]]) {
  test(`a directory containing a wire row with ${label} stops before dedup`, async () => {
    const client = clientFor(JSON.stringify(payload))
    const [directory, full] = await Promise.allSettled([client.listSelections(), reservedIds(client, signal())])
    assert.equal(directory.status, 'rejected')
    assert.equal(full.status, 'rejected')
  })
}

test('directory system rows with valid ids remain compatible without display names', async () => {
  const rows = [{ id: 'system' }, { id: 'unnamed', name: '' }], client = clientFor(JSON.stringify(rows))
  assert.deepEqual(await client.listSelections(), rows)
  assert.deepEqual([...await reservedIds(client, signal())], [])
  const reader = await createCandidateDedup({ client, signal: signal(), reserved: new Set(), pageSize: 2,
    readAll: async () => { throw new Error('Unnamed system rows do not require a full scan') } })
  assert.equal(reader.mode, 'candidate')
})

for (const [label, payload] of [
  ['data.photos', { data: { photos: { docs: [], hasMore: false } } }],
  ['data.search', { data: { search: { docs: [], hasMore: false } } }],
  ['photos', { photos: { docs: [], hasMore: false } }],
  ['search', { search: { docs: [], hasMore: false } }],
]) test(`an explicitly empty ${label} search remains a successful empty result`, async () => {
  assert.deepEqual(await clientFor(JSON.stringify(payload)).searchPhotos(search), { docs: [], hasMore: false })
})

for (const docs of [[], [{ id: 'photo', guid: 'known-guid' }]]) {
  test(`photo detail reads preserve an explicit ${docs.length ? 'photo list' : 'empty list'}`, async () => {
    assert.deepEqual(await clientFor(JSON.stringify({ data: { docs } })).photosByIds(['photo']), docs)
  })
}

for (const scenario of [
  { name: 'refills while search remains available', exhausted: false, budgetReached: false, searches: 1 },
  { name: 'does not search after exhaustion', exhausted: true, budgetReached: false, searches: 0 },
  { name: 'does not exceed the search budget', exhausted: false, budgetReached: true, searches: 0 },
]) test(`a restored visual batch whose photos are now collected ${scenario.name}`, async () => {
  const config = resolveConfig({ dedupReadMode: 'candidate', targetPerCategory: 1, batchSize: 1,
    maxBatches: 1, pageSize: 2, maxSearchRequests: 1, maxPages: 1, searchConcurrency: 1 })
  const old = { id: 'collected', guid: 'old-guid', title: 'Existing meal', caption: 'Fresh homemade meal and roasted food on a plate' }
  const replacement = { ...old, id: 'replacement', guid: 'new-guid', title: 'Another homemade meal' }
  const run = { schema: 1, id: 'afe59e58-d7cd-4ed0-a86c-7d8830d7de13', status: 'paused', stage: 'visual',
    categories: ['food'], settings: config, createdAt: 1, searchState: null, decisions: [],
    groups: { food: { candidates: [old], batches: 0, exhausted: false } },
    pending: { category: 'food', candidates: [old], exhausted: scenario.exhausted, budgetReached: scenario.budgetReached } }
  const reserved = new Set(), reviewed = []
  let searches = 0
  await refreshRun({ run, config, reserved, signal: signal(), store: { saveRun: async () => {} },
    readReserved: async () => { reserved.add(old.id) },
    client: { searchPhotos: async () => { searches++; return { docs: [replacement], hasMore: false } } },
    primitives: { triage: async ({ candidateManifest }) => candidateManifest.categories.flatMap(group => group.candidates.map(photo => {
      reviewed.push(photo.id)
      return { id: photo.id, category: 'food', keep: true, confidence: .99 }
    })) } })
  assert.equal(searches, scenario.searches)
  assert.deepEqual(reviewed, scenario.searches ? [replacement.id] : [])
  assert.equal(run.status, scenario.searches ? 'ready' : 'paused')
  assert.equal(run.pending, null)
})

for (const completed of [false, true]) test(`fresh membership removal ${completed ? 'keeps a completed review excluded' : 'allows an unreviewed photo into visual work'}`, async () => {
  const config = resolveConfig({ dedupReadMode: 'candidate', targetPerCategory: 1, batchSize: 1,
    maxBatches: 1, pageSize: 2, maxSearchRequests: 1, maxPages: 1, searchConcurrency: 1 })
  const photo = { id: 'removed-photo', guid: 'known-guid', title: 'Fresh homemade meal',
    caption: 'Fresh homemade meal and roasted food on a plate' }
  const run = { schema: 1, id: 'afe59e58-d7cd-4ed0-a86c-7d8830d7de13', status: 'paused', stage: 'visual',
    categories: ['food'], settings: config, createdAt: 1, searchState: null, pending: null,
    groups: { food: { candidates: [photo], batches: 0, exhausted: false } },
    decisions: completed ? [{ id: photo.id, category: 'food', keep: false, reason: 'visual rule' }] : [] }
  const reserved = new Set(), reviewed = []
  let removed = false, membershipReads = 0
  const client = {
    listSelections: async () => [{ id: 'private', name: 'Private', isPrivate: true, docsCount: removed ? 0 : 1,
      lastContentUpdate: removed ? '2026-10-26T00:00:01Z' : '2026-10-26T00:00:00Z' }],
    photoSelectionsByIds: async ids => { membershipReads++; return ids.map(id => ({ id, selections: removed ? [] : [{ id: 'private' }] })) },
    searchPhotos: async () => { removed = true; return { docs: [photo], hasMore: false } },
  }
  const reader = await createCandidateDedup({ client, signal: signal(), reserved, pageSize: 2,
    readAll: async () => { throw new Error('Stable private directory does not need a full scan') } })
  await refreshRun({ run, config, reserved, client, signal: signal(), store: { saveRun: async () => {} },
    readReserved: values => reader.update(values),
    primitives: { triage: async ({ candidateManifest }) => candidateManifest.categories.flatMap(group => group.candidates.map(candidate => {
      reviewed.push(candidate.id)
      return { id: candidate.id, category: 'food', keep: true, confidence: .99 }
    })) } })
  assert.equal(membershipReads, 2)
  assert.equal(reserved.has(photo.id), false)
  assert.deepEqual(reviewed, completed ? [] : [photo.id])
  assert.equal(run.status, completed ? 'paused' : 'ready')
})
