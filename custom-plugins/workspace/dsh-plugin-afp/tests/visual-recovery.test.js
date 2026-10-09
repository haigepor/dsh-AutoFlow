import test from 'node:test'
import assert from 'node:assert/strict'
import { reservedIds, refreshRun, summary } from '../src/host/afp-refresh-workflow.js'
import { createPhotoSearchSession } from '../src/vendor/auto-afp-img/afp-photo-search.mjs'
import { createHttpClient } from '../src/vendor/auto-afp-img/http-client.mjs'
import { resolveConfig } from '../config-schema.js'
import { triageCandidates, validateLandscapeWallpaperComposition } from '../src/vendor/auto-afp-img/afp-visual-triage.mjs'
import { CATEGORY_PROFILES } from '../src/vendor/auto-afp-img/afp-photo-search.mjs'
import { selectionDocIds } from '../src/vendor/auto-afp-img/afp-collection-run.mjs'
import { Store } from '../src/host/afp-state-store.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const profile = { key: 'food', selectionName: 'Synthetic', queryVariants: ['synthetic'], metadataRequiredAny: [], metadataExclusions: [] }
const signal = () => new AbortController().signal

test('collection membership accepts string and object IDs and refuses incomplete or malformed bodies', () => {
  assert.deepEqual([...selectionDocIds({ docs: ['p1', { id: 'p2' }, { uno: 'p3' }, ' p1 '] })], ['p1', 'p2', 'p3'])
  assert.throws(() => selectionDocIds({}), /contents/)
  assert.throws(() => selectionDocIds({ docs: [{}] }), /member/)
  assert.deepEqual([...selectionDocIds({ docs: [] })], [])
})

test('collection checkpoints resume completed reads and bound concurrent detail requests', async () => {
  const checkpoint = {}, calls = [], pending = new Map()
  let releaseAll = false
  const client = { listSelections: async () => [1, 2, 3].map(id => ({ id: String(id), name: 'Synthetic', docsCount: 1 })),
    getSelection: id => { calls.push(id); return releaseAll ? Promise.resolve({ docs: [{ id: `photo-${id}` }] }) : new Promise(resolve => pending.set(id, resolve)) } }
  let snapshots = 0
  const task = reservedIds(client, signal(), { concurrency: 2, checkpoint, ttlMs: 60000, onCheckpoint: async () => { snapshots++ } })
  await new Promise(resolve => setImmediate(resolve))
  if (pending.size !== 2) {
    const admitted = pending.size
    releaseAll = true
    for (const [id, resolve] of pending) resolve({ docs: [{ id: `photo-${id}` }] })
    await task
    assert.equal(admitted, 2)
  }
  pending.get('1')({ docs: [{ id: 'photo-1' }] })
  await new Promise(resolve => setImmediate(resolve))
  pending.get('2')({ docs: [{ id: 'photo-2' }] })
  pending.get('3')({ docs: [{ id: 'photo-3' }] })
  assert.equal((await task).size, 3)
  assert.equal(snapshots, 3)
  await reservedIds(client, signal(), { concurrency: 2, checkpoint, ttlMs: 60000 })
  assert.equal(calls.length, 3)
})

test('page budget stops a cursor that keeps returning empty pages and resumes from the saved cursor', async () => {
  const requests = [], checkpoints = []
  const client = { searchPhotos: async request => { requests.push(request); if (requests.length > 2) throw new Error('synthetic request budget exceeded'); return { docs: [], hasMore: true, cursor: `next-${requests.length}` } } }
  const options = { client, profiles: [profile], pageSize: 1, maxPages: 1, readRetries: 0, searchConcurrency: 1, maxSearchRequests: 1,
    onStateChange: async state => checkpoints.push(structuredClone(state)) }
  const first = createPhotoSearchSession(options)
  const batch = await first.nextBatch('food', { batchSize: 1 })
  assert.equal(requests.length, 1)
  assert.equal(batch.exhausted, false)
  assert.equal(batch.budgetReached, true)
  assert.ok(checkpoints.length)
  const resumed = createPhotoSearchSession({ ...options, searchState: first.exportState() })
  await resumed.nextBatch('food', { batchSize: 1 })
  assert.equal(requests.length, 2)
  assert.match(JSON.stringify(requests[1]), /next-1/)
})

test('logical request retry budget covers transport and body without multiplication', async () => {
  let requests = 0
  const http = createHttpClient({ retries: 2, sleep: async () => {}, fetchImpl: async () => { requests++; throw new TypeError('synthetic network failure') } })
  await assert.rejects(http.retryOperation(async request => request('https://example.invalid')))
  assert.equal(requests, 3)
  requests = 0
  await assert.rejects(http.retryOperation(() => http.request('https://example.invalid')))
  assert.equal(requests, 3)
})

test('failed photo is retried on resume, replaced in place, and never counted as judged', async () => {
  const config = resolveConfig({ targetPerCategory: 1, batchSize: 1, maxBatches: 1 })
  const run = { id: 'synthetic', categories: ['food'], settings: config, status: 'created', groups: {}, decisions: [], pending: null, searchState: null }
  const store = { saveRun: async () => {} }
  let attempts = 0, fetches = 0
  const primitives = { session: () => ({ nextBatch: async () => { fetches++; return { candidates: [{ id: 'p', title: 'Synthetic', provider: 'AFP' }], exhausted: true } }, exportState: () => ({}) }),
    triage: async () => { attempts++; return [{ id: 'p', category: 'food', keep: attempts > 1, confidence: attempts > 1 ? .99 : 0,
      reason: attempts > 1 ? 'accepted' : 'preview or vision request failed', appliedThreshold: .85 }] } }
  await refreshRun({ run, store, config, client: {}, signal: signal(), primitives })
  assert.equal(summary(run).categories[0].reviewed, 0)
  await refreshRun({ run, store, config, client: {}, signal: signal(), primitives })
  assert.equal(attempts, 2)
  assert.equal(fetches, 1)
  assert.equal(run.decisions.length, 1)
  assert.equal(run.status, 'ready')
})

test('landscape source fanout is bounded and authorization failure cannot trigger field fallback', async () => {
  let active = 0, peak = 0, requests = 0
  const client = { async searchPhotos() { requests++; active++; peak = Math.max(active, peak)
    await new Promise(resolve => setImmediate(resolve)); active--
    throw Object.assign(new Error('secret'), { afpFailure: { category: 'authorization' } }) } }
  const session = createPhotoSearchSession({ client, profiles: [CATEGORY_PROFILES.find(item => item.key === 'landscape')],
    searchConcurrency: 2, maxSearchRequests: 3, readRetries: 0 })
  await assert.rejects(session.nextBatch('landscape', { batchSize: 10 }), /secret/)
  assert.equal(peak, 2)
  assert.equal(requests, 2)
  assert.equal(active, 0)
})

test('successful pages survive another source failing and resume from queued candidates without rereading', async () => {
  let requests = 0, saved
  const client = { async searchPhotos() { requests++
    if (requests === 2) throw new Error('synthetic source failure')
    return { docs: [{ id: 'p', guid: 'g', title: 'Food' }], hasMore: true, cursor: 'next' } } }
  const options = { client, profiles: [{ ...profile, queryVariants: ['first', 'second'] }], searchConcurrency: 2, readRetries: 0,
    onStateChange: async state => { saved = structuredClone(state) } }
  const session = createPhotoSearchSession(options)
  await assert.rejects(session.nextBatch('food', { batchSize: 1 }), /synthetic source/)
  const resumed = createPhotoSearchSession({ ...options, searchState: saved })
  const batch = await resumed.nextBatch('food', { batchSize: 1 })
  assert.deepEqual(batch.candidates.map(item => item.id), ['p'])
  assert.equal(requests, 2)
})

const landscape = { category: 'landscape', confidence: .99, keep: true, reason: 'visible landscape',
  presentation: 'wallpaper', primaryFocus: 'natural-landscape', environmentCoverage: .9, spatialDepth: 'strong',
  foregroundDistraction: 'none', sourceImageText: false, frameOrientation: 'landscape', compositionSignals: ['layered-depth', 'clear-anchor'],
  subjectClarity: 'clear', horizonPlacement: 'centered', visualCalmness: 'high', visualBalance: 'balanced',
  humanPresence: 'none', builtEnvironmentRole: 'none', aestheticScore: 5, excludedRegionSignal: 'not-evident',
  sceneType: 'natural-scenery', vesselRole: 'none', crowdScale: 'none', editorialContext: 'none', urbanOpenness: 'not-applicable',
  compositeImage: false, anchorStrength: 'strong', negativeSpaceDominance: 'balanced', artificialLightRole: 'none',
  skylineProminence: 'not-applicable', industrialDocumentary: false, cityInfrastructureRole: 'not-applicable',
  coastalStructureRole: 'none', terrainInfrastructureRole: 'none' }

test('landscape confirmation recovery reuses the saved first pass and still requires aesthetic score five', async () => {
  const states = [], results = [], prompts = []
  const options = { candidateManifest: { categories: [{ category: 'landscape', candidates: [{ id: 'p', guid: 'g' }] }] },
    previewClient: { getPreviewBytes: async () => ({ bytes: new Uint8Array([255, 216, 255]), contentType: 'image/jpeg' }) },
    visionClient: { classify: async ({ prompt }) => { prompts.push(prompt); if (prompts.length === 2) throw new TypeError('fetch failed'); return landscape } },
    onReviewState: async state => states.push(structuredClone(state)), onResult: async result => results.push(result) }
  await triageCandidates(options)
  assert.equal(results[0].failure.stage, 'confirmation')
  assert.equal(results[0].failure.retryable, true)
  const saved = states.at(-1)
  assert.ok(saved.firstPass)
  assert.doesNotMatch(JSON.stringify(saved), /bytes|base64|https:/)
  await triageCandidates({ ...options, reviewStates: [saved] })
  assert.equal(prompts.length, 3)
  assert.match(prompts[2], /confirmation/i)
  assert.equal(results[1].keep, true)
  assert.equal(states.at(-1).attempts, 2)
  assert.equal(validateLandscapeWallpaperComposition({ ...landscape, aestheticScore: 4 }).keep, false)
})

test('cancellation saves a completed image and drains an active peer before resuming unfinished work', async t => {
  const config = resolveConfig({ targetPerCategory: 2, batchSize: 2, maxBatches: 1, concurrency: 2 })
  const home = await mkdtemp(join(tmpdir(), 'afp-recovery-store-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const store = new Store(home, join(home, 'profile'), config.maxStateBytes)
  const run = await store.createRun(['food'], config)
  const controller = new AbortController(), attempts = []
  let secondAdmitted
  const barrier = new Promise(resolve => { secondAdmitted = resolve })
  const client = { getPreviewBytes: async id => { attempts.push(id); if (id === 'two') { secondAdmitted(); await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true })); controller.signal.throwIfAborted() }
    await barrier; return { bytes: new Uint8Array([255, 216, 255]), contentType: 'image/jpeg' } } }
  const args = { run, config, store, client: {}, previewClient: client,
    visionClient: { classify: async () => ({ category: 'food', confidence: .99, keep: true, reason: 'food' }) }, signal: controller.signal,
    primitives: { session: () => ({ nextBatch: async () => ({ candidates: ['one', 'two'].map(id => ({ id, guid: id, title: id })) }), exportState: () => ({}) }) },
    onProgress: event => { if (event.pixelReviewed === 1) controller.abort() } }
  await assert.rejects(refreshRun(args))
  const saved = await store.readRun(run.id)
  assert.deepEqual(saved.decisions.map(item => item.id), ['one'])
  await refreshRun({ ...args, run: saved, signal: signal(), onProgress: () => {}, previewClient: { getPreviewBytes: async id => { attempts.push(id); return { bytes: new Uint8Array([255, 216, 255]), contentType: 'image/jpeg' } } } })
  assert.deepEqual(attempts, ['one', 'two', 'two'])
  assert.equal((await store.readRun(run.id)).status, 'ready')
})

test('photo failure attempts stay bounded across resumes and minimum judged count is independent of kept quota', async () => {
  const config = resolveConfig({ targetPerCategory: 1, minimumReviewedPerCategory: 2, batchSize: 2, maxBatches: 1, maxPhotoAttempts: 2 })
  const run = { id: 'synthetic', categories: ['food'], settings: config, status: 'created', groups: {}, decisions: [], pending: null, searchState: null }
  let calls = 0
  const primitives = { session: () => ({ nextBatch: async (_category, args) => { assert.equal(args.batchSize, 2); return { candidates: calls ? [] : ['one', 'two'].map(id => ({ id, guid: id, title: id })) } }, exportState: () => ({}) }),
    triage: async ({ candidateManifest }) => { calls++; return candidateManifest.categories[0].candidates.map(photo => ({ id: photo.id, category: 'food', keep: false, confidence: 0, reason: 'preview or vision request failed' })) } }
  const args = { run, config, primitives, client: {}, store: { saveRun: async () => {} }, signal: signal() }
  await refreshRun(args); await refreshRun(args); await refreshRun(args)
  assert.equal(calls, 2)
  assert.equal(summary(run).categories[0].reviewed, 0)
  assert.equal(run.status, 'paused')
})

test('a completed-review minimum continues after reaching the quota and retains candidates in stable order', async () => {
  const config = resolveConfig({ targetPerCategory: 1, minimumReviewedPerCategory: 2, batchSize: 2, maxBatches: 1, concurrency: 2 })
  const run = { id: 'synthetic', categories: ['food'], settings: config, status: 'created', groups: {}, decisions: [], pending: null, searchState: null }
  let secondFinished
  const barrier = new Promise(resolve => { secondFinished = resolve })
  const previewClient = { getPreviewBytes: async id => {
    if (id === 'one') await barrier
    return { bytes: new Uint8Array([id === 'one' ? 1 : 2]), contentType: 'image/jpeg' }
  } }
  const visionClient = { classify: async ({ bytes }) => { if (bytes[0] === 2) secondFinished(); return { category: 'food', confidence: .99, keep: true, reason: 'visible food' } } }
  await refreshRun({ run, config, store: { saveRun: async () => {} }, client: {}, previewClient, visionClient, signal: signal(),
    primitives: { session: () => ({ nextBatch: async (_category, args) => { assert.equal(args.batchSize, 2); return { candidates: ['one', 'two'].map(id => ({ id, guid: id, title: id })) } }, exportState: () => ({}) }) } })
  assert.equal(run.status, 'ready')
  assert.equal(summary(run).categories[0].reviewed, 2)
  assert.deepEqual(run.decisions.filter(item => item.keep).map(item => item.id), ['one'])
})

test('logical response-body retries and Retry-After honor the same three-attempt budget', async () => {
  let requests = 0
  const sleeps = []
  const http = createHttpClient({ retries: 2, sleep: async ms => sleeps.push(ms), fetchImpl: async () => {
    requests++
    if (requests === 1) return new Response('', { status: 429, headers: { 'retry-after': '1' } })
    if (requests === 2) return { status: 200, headers: new Headers(), arrayBuffer: async () => { throw new TypeError('network failure') } }
    return Response.json({ ok: true })
  } })
  const result = await http.retryOperation(async request => http.readResponseJson(await request('https://example.invalid')))
  assert.deepEqual(result, { ok: true })
  assert.equal(requests, 3)
  assert.deepEqual(sleeps, [1000, 500])
})

test('per-category search budgets stop batches without starving another selected category', async () => {
  let calls = 0
  const session = createPhotoSearchSession({ profiles: [profile, { ...profile, key: 'movie-poster' }], readRetries: 2,
    maxSearchRequests: 1, client: { searchPhotos: async () => { calls++; return { docs: [], hasMore: true, cursor: `next-${calls}` } } } })
  await session.nextBatch('food', { batchSize: 1 })
  await session.nextBatch('food', { batchSize: 1 })
  assert.equal(calls, 1)
  await session.nextBatch('movie-poster', { batchSize: 1 })
  assert.equal(calls, 2)
})

test('a preferred structured source reaching its page cap reports the budget without trying fallback fields', async () => {
  let calls = 0
  const session = createPhotoSearchSession({ profiles: [{ ...profile, sources: [{ id: 'synthetic-source', criteria: 'food', countryCode: 'FR' }] }],
    maxPages: 1, maxSearchRequests: 20, client: { searchPhotos: async () => {
      calls++; return { docs: [{ id: 'p', guid: 'g', title: 'Food' }], hasMore: true, cursor: 'next' }
    } } })
  const batch = await session.nextBatch('food', { batchSize: 2 })
  assert.equal(calls, 1)
  assert.equal(batch.exhausted, false)
  assert.equal(batch.budgetReached, true)
})

test('a supplied search client owns retries and saved error projection discards unexpected private fields', async () => {
  let calls = 0
  const session = createPhotoSearchSession({ profiles: [profile], readRetries: 2,
    client: { searchPhotos: async () => { calls++; throw new TypeError('synthetic network failure') } } })
  await assert.rejects(session.nextBatch('food', { batchSize: 1 }))
  assert.equal(calls, 1)
  const report = summary({ id: 'synthetic', status: 'failed', categories: [], settings: {}, groups: {}, decisions: [], pending: null,
    failure: { code: 'read-timeout', stage: 'collections', retryable: true, body: 'https://secret.example/token' } })
  assert.deepEqual(report.failure, { code: 'read-timeout', stage: 'collections', retryable: true })
  assert.doesNotMatch(JSON.stringify(report), /secret|body/)
})
