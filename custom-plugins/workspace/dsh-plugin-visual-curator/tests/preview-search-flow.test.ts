import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { z } from 'zod'
import { CuratorDomain } from '../src/domain/curator.ts'
import { DomainRepository, MemoryDomainAdapter } from '../src/domain/repository.ts'
import { resolveConfig } from '../src/host/config.ts'
import { createSearchWorker } from '../src/host/search-workflow.ts'
import { RunEngine, dataOf, toJson, type ExecutionSpec } from '../src/host/runtime.ts'
import { projectRun } from '../src/host/projection.ts'
import { matchStyle } from '../src/host/style-execution.ts'
import { AssetFiles, CompatibleVisionProvider, type HttpClient } from '../src/media/index.ts'
import { UnsplashApi, UnsplashSourceProvider } from '../src/media/unsplash.ts'
import { modelProfileSchema, recipeSchema, styleSchema, draftSchema, assetSchema, imageVersionSchema, referenceSnapshotSchema } from '../src/shared/model.ts'
import { remoteReferenceBlob } from '../src/media/remote-reference.ts'
import { freezeSearchExclusions, searchHistoryRuns, sourceExclusion } from '../src/host/search-exclusions.ts'
import { searchOutputSchema } from '../src/shared/search-launch.ts'
import { FixtureJobs } from './helpers/service-fixture.ts'

const base = { schemaVersion: 1, profileId: 'preview-test', createdAt: '2026-10-29T00:00:00.000Z' }
const recipe = recipeSchema.parse({ ...base, id: 'recipe', kind: 'recipe', visionRevision: 'fixture', model: 'fixture', vendorVersion: null, promptVersion: 'visual-curator-rules-v2', outputSchemaVersion: 'v1', preprocessingVersion: 'v1', referenceStrategy: { maxImages: 4, maxBytes: 1000000 }, preferenceScale: { min: 0, max: 1, weights: { subject: 1, color: 1, composition: 1 } }, styleMatching: { version: 2, minSatisfiedRatio: 0.75 }, unknownPolicy: 'needs-review', tieBreak: 'stable-id' })
const rules = (['subject', 'color', 'composition'] as const).map(dimension => ({ ruleId: dimension, dimension, statement: `Match the reference ${dimension}.`, condition: {}, strength: 'preferred' as const, stage: 'source' as const, check: { kind: 'visual' as const, criterion: `Inspect ${dimension}.` }, exceptions: [], supportRefs: [], counterRefs: [], confirmation: { status: 'suggested' as const } }))
const profile = modelProfileSchema.parse({ ...base, id: 'model-profile-preview', kind: 'modelProfile', styleId: 'style', draftId: 'draft', draftRevision: 1, access: { kind: 'profile-library' }, analysisRunId: 'analysis', referenceDigest: `sha256-v1:${'a'.repeat(64)}`, contentDigest: `sha256-v1:${'b'.repeat(64)}`, revision: 1, model: 'fixture', matchingPrompt: 'A complete vehicle in an environmental portrait.', rules, references: [], recipe, groups: [], options: rules.map(rule => ({ rule, enabled: true, groupId: null, selectionSource: 'model', sourceStatement: rule.statement, reason: 'consistent' })) })

test('preview output is an explicit output choice without a crop usage', () => {
  assert.deepEqual(searchOutputSchema.parse({ kind: 'preview' }), { kind: 'preview' })
})

test('known violations reject even when the remaining unknown rule cannot reach the threshold', () => {
  const result = matchStyle(profile, [{ ruleId: 'subject', result: 'violated' }, { ruleId: 'color', result: 'violated' }, { ruleId: 'composition', result: 'unknown' }], 0.75)
  assert.equal(result.verdict, 'not-matched')
  assert.equal(matchStyle(profile, rules.map(rule => ({ ruleId: rule.ruleId, result: 'unknown' })), 0.75).verdict, 'unknown')
})

async function fixture(block = false, scenario: { queries?: string[]; targetCount?: number; maxSearchPages?: number; blockPhoto?: string; page?(query: string, page: number): { ids: string[]; totalPages: number } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'visual-preview-flow-'))
  const repository = new DomainRepository(base.profileId, new MemoryDomainAdapter())
  const domain = new CuratorDomain(base.profileId, repository)
  const jobs = new FixtureJobs(), engine = new RunEngine(repository, jobs)
  const config = resolveConfig({ source: { provider: 'unsplash' }, limits: { maxRetryAttempts: 0, maxSearchPages: scenario.maxSearchPages ?? 4, maxVisionCalls: 8, pageSize: 2 } })
  const files = new AssetFiles(root, { maxFileBytes: 1000000, maxPixels: 1000000, maxDimension: 2000, previewMaxDimension: 200, maxStorageBytes: 10000000 })
  files.read = async () => { throw new Error('Preview flow must not read local subject pixels') }
  const queries: string[] = [], sourceCalls: { query: string; page: number }[] = [], remoteInputs: string[] = []
  const blocked = Promise.withResolvers<void>()
  let downloads = 0
  let entered!: () => void
  const reviewing = new Promise<void>(resolve => { entered = resolve })
  const photo = (id: string) => ({ id, width: 1200, height: 800, premium: true, urls: { small: `https://images.unsplash.com/photo-${id}`, regular: `https://images.unsplash.com/photo-${id}` } })
  const source = new UnsplashSourceProvider(new UnsplashApi({ async request(path, params) {
    if (path.startsWith('/photos/')) return photo(path.slice('/photos/'.length))
    assert.equal(path, '/search/photos')
    queries.push(String(params.query))
    const query = String(params.query), page = Number(params.page ?? 1)
    sourceCalls.push({ query, page })
    const found = scenario.page?.(query, page) ?? { ids: params.query === 'broad car photography' ? ['portrait', 'portrait-again'] : ['matching-car'], totalPages: 2 }
    return { results: found.ids.map(photo), total_pages: found.totalPages }
  } }))
  const http: HttpClient = { async request(url, request) {
    assert.equal(url, 'https://vision.example.test/chat')
    const body = z.object({ messages: z.array(z.object({ role: z.string(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })).or(z.string()) })) }).parse(JSON.parse(Buffer.from(request.body ?? []).toString('utf8')))
    const content = body.messages.find(message => message.role === 'user')!.content
    assert.ok(Array.isArray(content))
    const input = z.object({ input: z.object({ stage: z.string(), images: z.array(z.object({ imageVersionId: z.string(), remoteUrl: z.string() })), rules: z.array(z.object({ ruleId: z.string() })) }) }).parse(JSON.parse(content[0]!.text!)).input
    const subject = input.images[0]!
    remoteInputs.push(subject.remoteUrl); entered()
    if (block && (scenario.blockPhoto === undefined || subject.remoteUrl.includes(scenario.blockPhoto))) {
      blocked.resolve()
      await new Promise<void>((_resolve, reject) => { request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true }) })
    }
    const good = subject.remoteUrl.includes('matching-car')
    const output = { ruleResults: input.rules.map(rule => ({ ruleId: rule.ruleId, status: good ? 'satisfied' : rule.ruleId === 'composition' ? 'unknown' : 'violated', source: 'inferred', reason: good ? 'The complete vehicle matches the reference style.' : 'A person and camera dominate the image.', evidenceImageVersionIds: [subject.imageVersionId] })), cropPotential: 'unknown', preferenceScores: rules.map(rule => ({ dimension: rule.dimension, score: good ? 0.9 : 0.1 })), taskRelevance: good ? 'relevant' : 'irrelevant' }
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] })) }
  } }
  const vision = new CompatibleVisionProvider({ endpoint: 'https://vision.example.test/chat', model: 'fixture', supportsMultiImage: true, maxImages: 10, maxImageBytes: 1000000, maxRequestBytes: 1000000, maxOutputTokens: 2000, temperature: 0 }, http)
  const worker = createSearchWorker({ domain, files, source: async () => source, vision: async () => vision, media: () => ({ async request() { downloads++; throw new Error('Preview mode must not download originals') } }), crop: async () => { throw new Error('Preview mode must not crop') } })
  const actor = { kind: 'human' as const, id: 'owner', profileId: base.profileId }
  const style = styleSchema.parse({ ...base, id: 'style', kind: 'style', name: 'Vehicle references', archived: false, draftId: 'draft', revision: 1, committedReleaseIds: [], defaultReleaseId: null, nextReleaseNumber: 1 })
  const draft = draftSchema.parse({ ...base, id: 'draft', kind: 'draft', styleId: 'style', revision: 1, status: 'editing', rules: [], referenceIds: [], feedbackIds: [], conflicts: [] })
  await repository.commit({ aggregateId: 'fixture', expectedRevision: 0, operationId: 'seed', request: {}, records: [style, draft, profile], state: {} })
  const spec: ExecutionSpec = { kind: 'search', config, input: { taskBrief: 'Find complete vehicle environmental portraits.', queries: scenario.queries ?? ['broad car photography', 'red car autumn forest'], targetCount: scenario.targetCount ?? 1 }, fixed: { release: toJson(profile), output: { kind: 'preview' }, executionRecipe: toJson(recipe) }, specDigest: 'fixture' }
  return { root, repository, domain, engine, jobs, actor, worker, spec, queries, sourceCalls, remoteInputs, reviewing, blocked: blocked.promise, unblock: () => { block = false }, get downloads() { return downloads }, cleanup: async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }) } }
}

test('a new preview search skips exact selections from its collection without rejecting a different photo on the same host', async () => {
  const f = await fixture(false, { queries: ['cars'], targetCount: 1, page: () => ({ ids: ['matching-car-prior', 'matching-car-new'], totalPages: 1 }) })
  try {
    const first = await f.engine.create(f.spec, f.actor, f.worker, 'prior-search'); await f.jobs.drain()
    const policy = freezeSearchExclusions(f.domain, profile, f.actor, searchHistoryRuns(f.domain, profile.styleId).map(run => ({ run, actor: f.actor })))
    const second = await f.engine.create({ ...f.spec, fixed: { ...f.spec.fixed, searchExclusions: toJson(policy) } }, f.actor, f.worker, 'novel-search'); await f.jobs.drain()
    assert.equal(f.domain.require('run', second.id).outcome, 'target-met')
    assert.equal(dataOf(f.domain.require('run', second.id)).counts.excludedPrevious, 1)
    const selected = f.repository.list('selection').find(row => row.runId === second.id)!
    const asset = f.domain.require('asset', f.domain.require('imageVersion', selected.imageVersionId).assetId)
    assert.equal(asset.source.kind === 'provider' ? asset.source.providerAssetId : '', 'matching-car-new')
    assert.deepEqual(f.remoteInputs.map(url => new URL(url).pathname), ['/photo-matching-car-prior', '/photo-matching-car-new'])
    assert.equal(dataOf(f.domain.require('run', first.id)).budget.vision, 1)
    assert.equal(dataOf(f.domain.require('run', second.id)).budget.vision, 1)
    const other = modelProfileSchema.parse({ ...profile, styleId: 'other-collection' })
    assert.deepEqual(searchHistoryRuns(f.domain, other.styleId), [])
    assert.deepEqual(freezeSearchExclusions(f.domain, other, f.actor, []).sources, {})
  } finally { await f.cleanup() }
})

test('an exact negative photo is excluded across account and URL changes before an always-passing visual review', async () => {
  const f = await fixture(false, { queries: ['cars'], targetCount: 1, page: () => ({ ids: ['matching-car-blocked'], totalPages: 1 }) })
  try {
    const blob = remoteReferenceBlob({ providerId: 'unsplash', photoId: 'matching-car-blocked', accountId: 'reference-account', url: 'https://images.unsplash.com/photo-matching-car-blocked?w=1000', thumbnailUrl: 'https://images.unsplash.com/photo-matching-car-blocked?w=320' })
    const asset = assetSchema.parse({ ...base, id: 'negative-asset', kind: 'asset', familyId: 'negative-family', source: { kind: 'provider', providerId: 'unsplash', providerAssetId: 'matching-car-blocked', accountIdentity: 'reference-account', description: 'Rejected exact photo', obtainedAt: base.createdAt }, access: { kind: 'profile-library' }, exportPermission: 'references-only', groupingStatus: 'unreviewed' })
    const image = imageVersionSchema.parse({ ...base, id: 'negative-image', kind: 'imageVersion', assetId: asset.id, versionKind: 'remote-reference', blob, geometry: { width: 1200, height: 800, colorSpace: 'unverified', processorVersion: 'fixture' } })
    const reference = referenceSnapshotSchema.parse({ reference: { ...base, id: 'negative-ref', kind: 'reference', styleId: profile.styleId, imageVersionId: image.id, role: 'negative', intent: { kind: 'overall' }, context: {}, feedbackThreadIds: [] }, imageDigest: blob.digest, familyId: asset.familyId, feedbackIds: [] })
    await f.repository.commit({ aggregateId: 'negative-ref', expectedRevision: 0, operationId: 'negative-ref', request: {}, records: [asset, image], state: {} })
    const standard = modelProfileSchema.parse({ ...profile, references: [reference] }), policy = freezeSearchExclusions(f.domain, standard, f.actor, [])
    const started = await f.engine.create({ ...f.spec, fixed: { ...f.spec.fixed, release: toJson(standard), searchExclusions: toJson(policy) } }, f.actor, f.worker, 'negative-search'); await f.jobs.drain()
    const run = f.domain.require('run', started.id)
    assert.equal(run.outcome, 'source-exhausted'); assert.equal(dataOf(run).counts.excludedNegative, 1)
    assert.equal(f.remoteInputs.length, 0); assert.equal(dataOf(run).budget.vision, 0); assert.equal(dataOf(run).budget.search, 1)
    assert.equal(f.repository.list('selection').length, 0)
    const legacy = await f.engine.create({ ...f.spec, fixed: { ...f.spec.fixed, release: toJson(standard) } }, f.actor, f.worker, 'legacy-no-policy'); await f.jobs.drain()
    assert.equal(f.domain.require('run', legacy.id).outcome, 'target-met', 'Existing specs without the new policy keep their saved behavior')
    assert.equal(dataOf(f.domain.require('run', legacy.id)).counts.excludedNegative, undefined)
  } finally { await f.cleanup() }
})

test('a paused preview task retains its admitted exclusions when a selection and negative reference are added later', async () => {
  const f = await fixture(true, { queries: ['first'], targetCount: 1, blockPhoto: 'matching-car-new', page: query => ({ ids: query === 'first' ? ['matching-car-prior', 'matching-car-new'] : ['matching-car-new'], totalPages: 1 }) })
  try {
    await f.engine.create(f.spec, f.actor, f.worker, 'first-selection'); await f.jobs.drain()
    const policy = freezeSearchExclusions(f.domain, profile, f.actor, searchHistoryRuns(f.domain, profile.styleId).map(run => ({ run, actor: f.actor })))
    const second = await f.engine.create({ ...f.spec, fixed: { ...f.spec.fixed, searchExclusions: toJson(policy) } }, f.actor, f.worker, 'paused-novel-search')
    await f.blocked; await f.engine.control(second.id, 'pause', f.actor)
    assert.equal(f.domain.require('run', second.id).status, 'paused')
    f.unblock()
    const late = await f.engine.create({ ...f.spec, input: { ...f.spec.input, queries: ['late'] } }, f.actor, f.worker, 'late-selection'); await f.jobs.drain()
    const selection = f.repository.list('selection').find(row => row.runId === late.id)!, image = f.domain.require('imageVersion', selection.imageVersionId), asset = f.domain.require('asset', image.assetId)
    const reference = referenceSnapshotSchema.parse({ reference: { ...base, id: 'late-negative', kind: 'reference', styleId: profile.styleId, imageVersionId: image.id, role: 'negative', intent: { kind: 'overall' }, context: {}, feedbackThreadIds: [] }, imageDigest: image.blob.digest, familyId: asset.familyId, feedbackIds: [] })
    await f.repository.commit({ aggregateId: 'late-negative', expectedRevision: 0, operationId: 'late-negative', request: {}, records: [reference.reference], state: {} })
    const updated = modelProfileSchema.parse({ ...profile, id: 'later-profile', revision: 2, references: [reference] })
    const refreshed = freezeSearchExclusions(f.domain, updated, f.actor, searchHistoryRuns(f.domain, profile.styleId).map(run => ({ run, actor: f.actor })))
    assert.equal(Object.keys(policy.sources).length, 1); assert.equal(Object.keys(refreshed.sources).length, 2)
    assert.equal(sourceExclusion(refreshed, { providerId: 'unsplash', providerAssetId: 'matching-car-new', accountIdentity: 'public' }), 'negative-reference')
    await f.engine.control(second.id, 'resume', f.actor, f.worker); await f.jobs.drain()
    const run = f.domain.require('run', second.id)
    assert.equal(run.outcome, 'target-met'); assert.equal(dataOf(run).budget.search, 1); assert.equal(dataOf(run).budget.vision, 2)
    assert.equal(dataOf(run).counts.excludedPrevious, 1)
    assert.deepEqual(f.sourceCalls.map(call => call.query), ['first', 'first', 'late'])
    assert.equal(f.repository.list('selection').filter(row => row.runId === second.id).length, 1)
  } finally { await f.cleanup() }
})

test('preview scheduling leaves an off-subject page and spends later pages on committed matches', async () => {
  const f = await fixture(false, { queries: ['off-subject', 'productive', 'empty', 'unexplored'], targetCount: 4, maxSearchPages: 3,
    page: (query, page) => ({ ids: query === 'off-subject' ? ['portrait', 'portrait-again'] : query === 'empty' ? [] : [`matching-car-${page}-a`, `matching-car-${page}-b`], totalPages: 3 }) })
  try {
    const started = await f.engine.create(f.spec, f.actor, f.worker, 'preview-quality-budget')
    await f.jobs.drain()
    const run = f.domain.require('run', started.id)
    assert.equal(run.status, 'completed'); assert.equal(run.outcome, 'target-met')
    assert.deepEqual(f.sourceCalls, [{ query: 'off-subject', page: 1 }, { query: 'productive', page: 1 }, { query: 'productive', page: 2 }])
    assert.equal(dataOf(run).budget.search, 3)
    assert.equal(f.repository.list('selection').length, 4)
    assert.equal(f.remoteInputs.filter(url => url.includes('portrait')).length, 1)
  } finally { await f.cleanup() }
})

test('preview scheduling preserves spent quota and saved candidates through a paused review', async () => {
  const f = await fixture(true, { queries: ['off-subject', 'productive'], targetCount: 1, maxSearchPages: 2, blockPhoto: 'matching-car',
    page: query => ({ ids: query === 'off-subject' ? ['portrait', 'portrait-again'] : ['matching-car'], totalPages: 1 }) })
  try {
    const started = await f.engine.create(f.spec, f.actor, f.worker, 'preview-quality-resume')
    await f.blocked
    await f.engine.control(started.id, 'pause', f.actor)
    const paused = f.domain.require('run', started.id)
    assert.equal(paused.status, 'paused'); assert.equal(dataOf(paused).budget.search, 2)
    f.unblock()
    await f.engine.control(started.id, 'resume', f.actor, f.worker); await f.jobs.drain()
    const run = f.domain.require('run', started.id)
    assert.equal(run.status, 'completed'); assert.equal(run.outcome, 'target-met')
    assert.deepEqual(f.sourceCalls, [{ query: 'off-subject', page: 1 }, { query: 'productive', page: 1 }])
    assert.equal(dataOf(run).budget.search, 2)
    assert.equal(dataOf(run).budget.vision, 3)
    assert.equal(f.repository.list('selection').length, 1)
  } finally { await f.cleanup() }
})

test('a duplicate-only preview page gives remaining search budget to a fresh direction', async () => {
  const f = await fixture(false, { queries: ['repeating', 'fresh'], targetCount: 2, maxSearchPages: 3,
    page: query => ({ ids: [query === 'repeating' ? 'matching-car-repeated' : 'matching-car-fresh'], totalPages: 3 }) })
  try {
    const started = await f.engine.create(f.spec, f.actor, f.worker, 'preview-duplicate-budget')
    await f.jobs.drain()
    const run = f.domain.require('run', started.id)
    assert.equal(run.outcome, 'target-met')
    assert.deepEqual(f.sourceCalls, [{ query: 'repeating', page: 1 }, { query: 'repeating', page: 2 }, { query: 'fresh', page: 1 }])
    assert.equal(f.remoteInputs.length, 2)
    assert.equal(dataOf(run).budget.search, 3)
    assert.equal(f.repository.list('selection').length, 2)
  } finally { await f.cleanup() }
})

test('empty preview results honor source exhaustion while another direction remains searchable', async () => {
  const f = await fixture(false, { queries: ['sparse', 'productive'], targetCount: 2, maxSearchPages: 3,
    page: (query, page) => ({ ids: query === 'sparse' && page === 1 ? [] : [`matching-car-${query}`], totalPages: query === 'sparse' ? 2 : 1 }) })
  try {
    const started = await f.engine.create(f.spec, f.actor, f.worker, 'preview-sparse-exploration')
    await f.jobs.drain()
    const run = f.domain.require('run', started.id)
    assert.equal(run.outcome, 'source-exhausted')
    assert.deepEqual(f.sourceCalls, [{ query: 'sparse', page: 1 }, { query: 'productive', page: 1 }])
    assert.equal(dataOf(run).budget.search, 2)
    assert.equal(f.repository.list('selection').length, 1)
  } finally { await f.cleanup() }
})

test('preview failure and empty results reach a terminal outcome without repeated source calls', async () => {
  for (const failure of [false, true]) {
    const f = await fixture(false, { queries: ['first', 'second'], maxSearchPages: 2, page: () => { if (failure) throw new Error('Isolated source failure'); return { ids: [], totalPages: 1 } } })
    try {
      const started = await f.engine.create(f.spec, f.actor, f.worker, `preview-empty-${failure}`)
      await f.jobs.drain()
      const run = f.domain.require('run', started.id)
      assert.equal(run.status, 'completed'); assert.equal(run.outcome, failure ? 'partial-failure' : 'source-exhausted')
      assert.equal(f.sourceCalls.length, 2); assert.equal(dataOf(run).budget.search, 2)
      assert.equal(f.repository.list('selection').length, 0)
    } finally { await f.cleanup() }
  }
})

test('real search worker rotates query pages, reviews preview URLs and retains links without downloading originals', async () => {
  const f = await fixture()
  try {
    const started = await f.engine.create(f.spec, f.actor, f.worker, 'preview-flow')
    await f.jobs.drain()
    const run = f.domain.require('run', started.id), view = projectRun(f.domain, run, f.actor)
    assert.equal(run.status, 'completed')
    assert.equal(dataOf(run).counts.qualified, 1)
    assert.deepEqual(f.queries, ['broad car photography', 'red car autumn forest'])
    assert.deepEqual(f.remoteInputs.map(url => new URL(url).pathname), ['/photo-portrait', '/photo-matching-car'])
    assert.equal(f.downloads, 0)
    assert.equal(dataOf(run).budget.downloadBytes, 0)
    assert.equal(f.repository.list('assessment').find(row => row.verdict === 'reject')?.technicalStatus, 'completed')
    assert.equal(f.repository.list('assessment').some(row => row.verdict === 'needs-review'), false)
    assert.equal(view.delivery, undefined)
    assert.equal(view.results[0]?.selection?.kind, 'selected')
    assert.equal(f.repository.list('asset').some(asset => asset.originalBlob !== undefined), false)
    assert.deepEqual(await readdir(f.root), [])
  } finally { await f.cleanup() }
})

test('cancelling the real background engine aborts an in-flight preview review and preserves its terminal state', async () => {
  const f = await fixture(true)
  try {
    const started = await f.engine.create(f.spec, f.actor, f.worker, 'preview-cancel')
    await f.reviewing
    await f.engine.control(started.id, 'cancel', f.actor)
    await f.jobs.drain()
    assert.equal(f.domain.require('run', started.id).status, 'cancelled')
    assert.equal(f.downloads, 0)
    assert.equal(f.repository.list('selection').length, 0)
  } finally { await f.cleanup() }
})
