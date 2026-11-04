/** Real search workers, image decoding and persistence with only external source/model boundaries scripted. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { DomainRepository, MemoryDomainAdapter } from '../src/domain/repository.ts'
import { CuratorDomain } from '../src/domain/curator.ts'
import { resolveConfig } from '../src/host/config.ts'
import { createSearchWorker } from '../src/host/search-workflow.ts'
import { RunEngine, dataOf, toJson, type ExecutionSpec } from '../src/host/runtime.ts'
import { searchScreeningSummary } from '../src/host/search-screening-state.ts'
import { freezeSearchExclusions, searchSourceKey } from '../src/host/search-exclusions.ts'
import { AssetFiles, CompatibleVisionProvider, type HttpClient } from '../src/media/index.ts'
import type { SourceQuery } from '../src/media/source.ts'
import { modelProfileSchema, recipeSchema, styleSchema, draftSchema, type RunRecord } from '../src/shared/model.ts'
import { FixtureJobs } from './helpers/service-fixture.ts'

const base = { schemaVersion: 1, profileId: 'screening-test', createdAt: '2026-11-04T00:00:00.000Z' }
const rule = { ruleId: 'green', statement: 'Use a green palette.', dimension: 'color', condition: {}, strength: 'preferred', stage: 'source', check: { kind: 'visual', criterion: 'Green colors dominate.' }, exceptions: [], supportRefs: [], counterRefs: [], confirmation: { status: 'suggested' } }
const recipe = recipeSchema.parse({ ...base, id: 'recipe', kind: 'recipe', visionRevision: 'fixture', model: 'fixture', vendorVersion: 'fixture-v1', promptVersion: 'visual-curator-rules-v3', outputSchemaVersion: 'v1', preprocessingVersion: 'v1', referenceStrategy: { maxImages: 4, maxBytes: 1000000 }, preferenceScale: { min: 0, max: 1, weights: { color: 1 } }, styleMatching: { version: 2, minSatisfiedRatio: 0.75 }, unknownPolicy: 'needs-review', tieBreak: 'stable-id' })
const profile = modelProfileSchema.parse({ ...base, id: 'profile', kind: 'modelProfile', styleId: 'style', draftId: 'draft', draftRevision: 1, access: { kind: 'profile-library' }, analysisRunId: 'analysis', referenceDigest: `sha256-v1:${'a'.repeat(64)}`, contentDigest: `sha256-v1:${'b'.repeat(64)}`, revision: 1, model: 'fixture', matchingPrompt: 'Inspect the green palette.', rules: [rule], references: [], recipe, groups: [], options: [{ rule, enabled: true, groupId: null, selectionSource: 'model', sourceStatement: rule.statement, reason: 'consistent' }] })
const requestSchema = z.object({ messages: z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional(), image_url: z.object({ url: z.string() }).optional() }))]) })) })
const payloadSchema = z.object({ input: z.object({ operation: z.string(), stage: z.string().optional(), requestId: z.string(), images: z.array(z.object({ imageVersionId: z.string() })), rules: z.array(z.object({ ruleId: z.string() })) }) })

async function fixture(options: { count?: number; pool?: 50 | 100; target?: number; allReject?: boolean; rejectFinal?: boolean; malformed?: boolean; maxVisionCalls?: number; retryAttempts?: number; output?: 'preview' | 'original'; duplicatePages?: boolean; pauseScreen?: boolean; overlapScreening?: boolean; restrictedOriginals?: boolean; ruleStatus?(ruleId: string, stage?: string): 'satisfied' | 'violated' | 'unknown'; queries?: string[]; color?(id: string): 'green' | 'red' | 'blue'; page?(query: string, page: number): { ids: string[]; nextCursor: string | null } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'visual-screening-'))
  const repository = new DomainRepository(base.profileId, new MemoryDomainAdapter()), domain = new CuratorDomain(base.profileId, repository)
  const jobs = new FixtureJobs(), engine = new RunEngine(repository, jobs)
  const config = resolveConfig({ source: { provider: 'unsplash' }, limits: { maxConcurrentRequests: 3, maxSearchPages: 12, maxCandidates: 300, maxVisionCalls: options.maxVisionCalls ?? 60, maxDownloadBytes: 50_000_000, maxRetryAttempts: options.retryAttempts ?? 0, retryDelayMs: 0, pageSize: 30 } })
  const files = new AssetFiles(root, { maxFileBytes: 1_000_000, maxPixels: 3_000_000, maxDimension: 2000, previewMaxDimension: 200, maxStorageBytes: 10_000_000 })
  const count = options.count ?? 12, ids = Array.from({ length: count }, (_, index) => `photo-${index}`)
  const green = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#00dd00' } }).png().toBuffer()
  const red = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#dd0000' } }).png().toBuffer()
  const blue = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#0000dd' } }).png().toBuffer()
  const pixels = (id: string) => ({ green, red, blue })[options.color?.(id) ?? (!options.allReject && id === ids.at(-1) ? 'green' : !options.allReject && id === ids.at(-2) ? 'blue' : 'red')]
  const item = (id: string) => ({ providerAssetId: id, width: 1200, height: 800, previewUrl: `https://images.unsplash.com/${id}/regular`, thumbnailUrl: `https://images.unsplash.com/${id}/small`, ...(options.restrictedOriginals ? { originalUnavailable: 'restricted' as const } : { originalUrl: `https://images.unsplash.com/${id}/original` }) })
  const sourcePages: number[] = [], mediaRequests: string[] = [], calls: { operation: string; imageIds: string[]; requestId: string }[] = []
  const sourceQueries: { query: string; page: number }[] = []
  let active = 0, peak = 0, failCheckpoint = false, pauseScreen = options.pauseScreen === true
  const screeningEntered = Promise.withResolvers<void>()
  const screeningOverlap = Promise.withResolvers<void>()
  let screeningArrivals = 0, overlapDeadline: ReturnType<typeof setTimeout> | undefined
  const originalCommit = repository.commit.bind(repository)
  repository.commit = async input => {
    if (failCheckpoint && input.records.some(record => record.kind === 'run' && searchScreeningSummary(record)?.screeningReviewed)) {
      failCheckpoint = false
      throw new Error('Simulated checkpoint interruption')
    }
    return originalCommit(input)
  }
  const http: HttpClient = { async request(url, request) {
    request.signal?.throwIfAborted()
    if (url.startsWith('https://images.unsplash.com/')) {
      mediaRequests.push(url)
      return { status: 200, headers: { 'content-type': 'image/png' }, bytes: pixels(new URL(url).pathname.split('/')[1]!) }
    }
    const messages = requestSchema.parse(JSON.parse(Buffer.from(request.body ?? []).toString('utf8'))).messages
    const content = messages.find(message => message.role === 'user')!.content
    assert.ok(Array.isArray(content))
    const input = payloadSchema.parse(JSON.parse(content[0]!.text!)).input
    calls.push({ operation: input.operation, imageIds: input.images.map(image => image.imageVersionId), requestId: input.requestId })
    const imageUrls = content.flatMap(part => part.image_url ? [part.image_url.url] : [])
    let result: unknown
    if (input.operation === 'screen') {
      screeningEntered.resolve()
      if (pauseScreen) await new Promise<void>((_resolve, reject) => {
        if (request.signal?.aborted) reject(request.signal.reason)
        else request.signal?.addEventListener('abort', () => reject(request.signal!.reason), { once: true })
      })
      active++; peak = Math.max(peak, active)
      try {
        if (options.overlapScreening && screeningArrivals < 3) {
          screeningArrivals++
          if (screeningArrivals === 1) overlapDeadline = setTimeout(() => screeningOverlap.reject(new Error('Three screening requests did not enter the fixture')), 30_000)
          if (screeningArrivals === 3) { clearTimeout(overlapDeadline); screeningOverlap.resolve() }
          await screeningOverlap.promise
        }
        const colors = await Promise.all(imageUrls.map(async imageUrl => {
          assert.ok(imageUrl.startsWith('data:image/png;base64,'), 'Coarse screening receives actual independent thumbnail pixels')
          const bytes = Buffer.from(imageUrl.split(',')[1]!, 'base64'), image = sharp(bytes), metadata = await image.metadata(), stats = await image.stats()
          assert.ok(metadata.width! <= 384 && metadata.height! <= 384)
          return stats.channels[0]!.mean > 150 ? 'obvious-reject' : stats.channels[2]!.mean > 150 ? 'uncertain' : 'deep-review'
        }))
        result = { items: input.images.map((image, index) => ({ imageVersionId: image.imageVersionId, decision: colors[index], reason: 'Decision from the candidate thumbnail pixels.' })) }
        if (options.malformed) result = { items: [] }
      } finally { active-- }
    } else {
      const sourceUrl = imageUrls[0]!
      const bytes = sourceUrl.startsWith('data:') ? Buffer.from(sourceUrl.split(',')[1]!, 'base64') : pixels(new URL(sourceUrl).pathname.split('/')[1]!)
      const stats = await sharp(bytes).stats(), good = !options.rejectFinal && stats.channels[1]!.mean > 150
      result = { ruleResults: input.rules.map(rule => ({ ruleId: rule.ruleId, status: options.ruleStatus?.(rule.ruleId, input.stage) ?? (good ? 'satisfied' : 'violated'), source: 'inferred', reason: 'Full image color review.', evidenceImageVersionIds: [input.images[0]!.imageVersionId] })), cropPotential: 'direct', preferenceScores: [{ dimension: 'color', score: good ? 0.9 : 0.1 }], taskRelevance: good ? 'relevant' : 'irrelevant', subjectFocus: [] }
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] })) }
  } }
  const vision = new CompatibleVisionProvider({ endpoint: 'https://vision.example.test/chat', model: 'fixture', supportsMultiImage: true, maxImages: 10, maxImageBytes: 1_000_000, maxRequestBytes: 10_000_000, maxOutputTokens: 3000, temperature: 0 }, http)
  const source = { config: { lookup: { endpoint: 'https://source.example.test/lookup', method: 'GET' as const, idField: 'id', response: { id: '/id', previewUrl: '/preview' } } }, async lookup(id: string) { return item(id) }, async search(query: SourceQuery, cursor: string | null) {
    const page = Number(cursor ?? 0); sourcePages.push(page); sourceQueries.push({ query: query.query, page })
    const found = options.page?.(query.query, page) ?? { ids: ids.slice(page * 30, page * 30 + 30), nextCursor: (page + 1) * 30 < ids.length ? String(page + 1) : null }
    return { items: [...(options.duplicatePages && page > 0 ? [item(ids[0]!)] : []), ...found.ids.map(item)], nextCursor: found.nextCursor }
  } }
  const worker = createSearchWorker({ domain, files, source: async () => source, media: () => http, vision: async () => vision, crop: async () => { throw new Error('This fixture does not crop') } })
  const actor = { kind: 'human' as const, id: 'owner', profileId: base.profileId }
  await repository.commit({ aggregateId: 'fixture', expectedRevision: 0, operationId: 'seed', request: {}, records: [styleSchema.parse({ ...base, id: 'style', kind: 'style', name: 'Green', archived: false, draftId: 'draft', revision: 1, committedReleaseIds: [], defaultReleaseId: null, nextReleaseNumber: 1 }), draftSchema.parse({ ...base, id: 'draft', kind: 'draft', styleId: 'style', revision: 1, status: 'editing', rules: [], referenceIds: [], feedbackIds: [], conflicts: [] }), profile], state: {} })
  const spec: ExecutionSpec = { kind: 'search', config, input: { taskBrief: 'Find green color samples.', queries: options.queries ?? ['color samples'], targetCount: options.target ?? 1 }, fixed: { release: toJson(profile), output: { kind: options.output ?? 'preview' }, executionRecipe: toJson(recipe), searchScreening: { version: 1, candidatePoolSize: options.pool ?? 50, batchSize: 6, maxScreeningImageEdge: 384 } }, specDigest: 'fixture' }
  return { root, repository, domain, files, jobs, engine, worker, actor, spec, ids, calls, sourcePages, sourceQueries, mediaRequests, screeningEntered: screeningEntered.promise, allowScreening() { pauseScreen = false }, get peak() { return peak }, interruptCheckpoint() { failCheckpoint = true }, async run(id = 'search') { const started = await engine.create(spec, actor, worker, id); await jobs.drain(); return domain.require('run', started.id) }, async cleanup() { clearTimeout(overlapDeadline); screeningOverlap.resolve(); await engine.dispose(); await rm(root, { recursive: true, force: true }) } }
}

test('collects 50 and 100 unique candidates across real source pages and only final review qualifies a result', async () => {
  for (const count of [50, 100] as const) {
    const f = await fixture({ count, pool: count, duplicatePages: true, overlapScreening: true })
    try {
      const run = await f.run()
      assert.equal(run.outcome, 'target-met')
      assert.equal(dataOf(run).counts.qualified, 1)
      assert.equal(dataOf(run).counts.candidates, count)
      assert.equal(dataOf(run).counts.screeningReviewed, count)
      assert.equal(dataOf(run).counts.screeningRejected, count - 2)
      assert.equal(dataOf(run).counts.deepReviewed, 2, 'An uncertain thumbnail is fully reviewed, never silently discarded')
      assert.equal(f.calls.filter(call => call.operation === 'screen').length, Math.ceil(count / 6))
      assert.equal(f.calls.filter(call => call.operation === 'review').length, 2)
      assert.deepEqual(f.sourcePages, Array.from({ length: Math.ceil(count / 30) }, (_, index) => index))
      assert.equal(f.peak, 3, 'Screening fills the configured request slots while the first group is held')
      const selection = f.repository.list('selection')[0]!
      assert.equal(f.domain.require('assessment', selection.assessmentId).stage, 'final')
      assert.equal(f.domain.require('assessment', selection.assessmentId).verdict, 'pass')
      assert.equal(f.repository.list('assessment').length, 2, 'Coarse rejections never become final assessments')
      assert.ok(f.repository.list('request').filter(row => row.state === 'committed').every(row => dataOf(run).requestIds.includes(row.id)))
      const imagesSchema = z.object({ bundle: z.object({ operation: z.literal('screen'), images: z.array(z.object({ digest: z.string(), mime: z.string(), storedImage: z.object({ storageRef: z.string(), byteLength: z.number() }) })) }) })
      const logged = f.repository.list('request').map(row => imagesSchema.safeParse(row.data)).find(parsed => parsed.success)
      assert.ok(logged?.success)
      for (const image of logged.data.bundle.images) assert.equal((await f.files.read({ ...image.storedImage, digest: image.digest, mime: image.mime })).byteLength, image.storedImage.byteLength, 'Logged coarse pixels remain reconstructable for compatible and native providers')
    } finally { await f.cleanup() }
  }
})

test('a plausible coarse result cannot replace a rejecting deep review', async () => {
  const f = await fixture({ count: 6, rejectFinal: true })
  try {
    const run = await f.run()
    assert.equal(run.outcome, 'source-exhausted')
    assert.equal(f.repository.list('selection').length, 0)
    assert.equal(dataOf(run).counts.screeningRejected, 4)
    assert.equal(dataOf(run).counts.deepReviewed, 2)
  } finally { await f.cleanup() }
})

test('malformed batch output retries within the shared budget then falls back to full single-image reviews', async () => {
  const f = await fixture({ count: 6, malformed: true, retryAttempts: 1 })
  try {
    const run = await f.run()
    assert.equal(run.outcome, 'target-met')
    assert.equal(dataOf(run).counts.screeningReviewed, 0)
    assert.equal(dataOf(run).counts.screeningRejected, 0)
    assert.equal(dataOf(run).counts.screeningFallback, 6)
    assert.equal(f.calls.filter(call => call.operation === 'screen').length, 2)
    assert.equal(dataOf(run).budget.vision, 8)
    assert.equal(dataOf(run).counts.technicalFailed, 0)
    assert.equal(f.repository.list('selection').length, 1)
  } finally { await f.cleanup() }
})

test('original searches discard obvious mismatches before downloading source originals', async () => {
  const f = await fixture({ count: 6, output: 'original' })
  try {
    const run = await f.run()
    assert.equal(run.outcome, 'target-met')
    assert.deepEqual(f.mediaRequests.filter(url => url.endsWith('/original')).map(url => new URL(url).pathname.split('/')[1]).sort(), ['photo-4', 'photo-5'])
    assert.equal(f.repository.list('selection').length, 1)
    assert.equal(f.calls.filter(call => call.operation === 'review').length, 3, 'One rejected source and one source/final pair retain the original qualification path')
  } finally { await f.cleanup() }
})

test('a shared vision limit cannot turn successful coarse screening into a qualified image', async () => {
  const f = await fixture({ count: 6, maxVisionCalls: 1 })
  try {
    const run = await f.run()
    assert.equal(run.outcome, 'budget-exhausted')
    assert.equal(dataOf(run).budget.vision, 1)
    assert.equal(f.repository.list('selection').length, 0)
  } finally { await f.cleanup() }
})

test('coarse rejections retain only source positions and never masquerade as final visual history', async () => {
  const f = await fixture({ count: 6, allReject: true })
  try {
    const run = await f.run()
    assert.equal(run.outcome, 'source-exhausted')
    const summary = searchScreeningSummary(run)!
    assert.equal(summary.screeningRejected, 6)
    assert.equal(summary.deepReviewed, 0)
    assert.equal(f.repository.list('assessment').length, 0)
    assert.equal(f.repository.list('imageVersion').length, 0)
    assert.ok(!JSON.stringify(dataOf(run).checkpoint.searchScreening).includes('https://'))
    const policy = freezeSearchExclusions(f.domain, profile, f.actor, [], String(f.spec.input.taskBrief))
    assert.equal(Object.keys(policy.sources).length, 0)
    assert.equal(searchScreeningSummary({ ...run, data: {} }), undefined)
  } finally { await f.cleanup() }
})

test('exact source exclusions precede thumbnail downloads and model admission', async () => {
  const f = await fixture({ count: 6 })
  try {
    f.spec.fixed.searchExclusions = { version: 1, sources: { [searchSourceKey({ providerId: 'unsplash', accountIdentity: 'public', providerAssetId: 'photo-0' })]: 'negative-reference' }, digests: {} }
    const run = await f.run()
    assert.equal(run.outcome, 'target-met')
    assert.equal(dataOf(run).counts.excludedNegative, 1)
    assert.equal(dataOf(run).counts.screeningReviewed, 5)
    assert.ok(f.mediaRequests.every(url => !url.includes('/photo-0/')))
    assert.equal(f.calls[0]!.imageIds.length, 5)
  } finally { await f.cleanup() }
})

test('pausing an in-flight batch preserves its pool and spent quota, then resumes only the unfinished work', async () => {
  const f = await fixture({ count: 6, pauseScreen: true })
  try {
    const started = await f.engine.create(f.spec, f.actor, f.worker, 'pause-screening')
    await f.screeningEntered
    await f.engine.control(started.id, 'pause', f.actor)
    const paused = f.domain.require('run', started.id)
    assert.equal(paused.status, 'paused')
    assert.equal(dataOf(paused).budget.vision, 1)
    assert.equal(searchScreeningSummary(paused)!.pendingSourceIds.length, 6)
    f.allowScreening()
    await f.engine.control(started.id, 'resume', f.actor, f.worker); await f.jobs.drain()
    const completed = f.domain.require('run', started.id)
    assert.equal(completed.outcome, 'target-met')
    assert.equal(dataOf(completed).budget.vision, 4)
    assert.equal(dataOf(completed).counts.deepReviewed, 2)
    assert.equal(f.calls.filter(call => call.operation === 'screen').length, 2)
    assert.deepEqual(f.sourcePages, [0], 'The durable candidate pool is not retrieved again')
    assert.equal(f.repository.list('selection').length, 1)
  } finally { f.allowScreening(); await f.cleanup() }
})

test('a committed coarse response is replayed after interruption before its pool checkpoint', async () => {
  const f = await fixture({ count: 6 })
  try {
    f.interruptCheckpoint()
    const failed = await f.run('checkpoint-gap')
    assert.equal(failed.status, 'failed')
    assert.equal(dataOf(failed).counts.screeningReviewed, 0)
    assert.equal(f.calls.filter(call => call.operation === 'screen').length, 1)
    // A process restart retains the same committed request and marks its unsettled Run interrupted.
    const revision = f.repository.manifest(`run:${failed.id}`)!.revision
    const interrupted: RunRecord = { ...failed, revision: revision + 1, status: 'interrupted' }
    await f.repository.commit({ aggregateId: `run:${failed.id}`, expectedRevision: revision, operationId: 'recover-gap', request: {}, records: [interrupted], state: { runId: failed.id } })
    await f.engine.control(failed.id, 'resume', f.actor, f.worker); await f.jobs.drain()
    const completed = f.domain.require('run', failed.id)
    assert.equal(completed.outcome, 'target-met')
    assert.equal(f.calls.filter(call => call.operation === 'screen').length, 1, 'Committed coarse output never incurs another model call')
    assert.equal(dataOf(completed).budget.vision, 3)
    assert.equal(dataOf(completed).counts.screeningReviewed, 6)
  } finally { await f.cleanup() }
})

test('source-stage required visual rules are rechecked on final original pixels', async () => {
  const f = await fixture({ count: 1, output: 'original', ruleStatus: (id, stage) => id === 'required-exclusion' && stage === 'final' ? 'violated' : 'satisfied' })
  try {
    const required = { ...profile.rules[0]!, ruleId: 'required-exclusion', strength: 'required' as const }
    const frozen = modelProfileSchema.parse({ ...profile, rules: [...profile.rules, required], options: [...profile.options, { ...profile.options[0]!, rule: required }] })
    f.spec.fixed.release = toJson(frozen)
    const run = await f.run()
    assert.equal(run.outcome, 'source-exhausted')
    assert.equal(f.repository.list('selection').length, 0)
    const source = f.repository.list('assessment').find(row => row.stage === 'source')!, final = f.repository.list('assessment').find(row => row.stage === 'final')!
    assert.equal(source.verdict, 'pass')
    assert.equal(final.verdict, 'reject')
    assert.equal(final.ruleResults.find(row => row.ruleId === required.ruleId)?.result, 'violated')
  } finally { await f.cleanup() }
})

test('a required violation in one alternative group does not veto another fully satisfied group', async () => {
  const f = await fixture({ count: 1, output: 'original', ruleStatus: id => id === 'required-a' ? 'violated' : 'satisfied' })
  try {
    const a = { ...profile.rules[0]!, ruleId: 'required-a', strength: 'required' as const }, b = { ...a, ruleId: 'required-b' }
    const frozen = modelProfileSchema.parse({ ...profile, rules: [...profile.rules, a, b], groups: [{ groupId: 'a', name: 'A', description: '', imageVersionIds: [] }, { groupId: 'b', name: 'B', description: '', imageVersionIds: [] }], options: [...profile.options, { ...profile.options[0]!, rule: a, groupId: 'a' }, { ...profile.options[0]!, rule: b, groupId: 'b' }] })
    f.spec.fixed.release = toJson(frozen)
    const run = await f.run()
    assert.equal(run.outcome, 'target-met')
    const selection = f.repository.list('selection')[0]!, final = f.domain.require('assessment', selection.assessmentId)
    assert.equal(final.verdict, 'pass')
    assert.equal(final.ruleResults.find(row => row.ruleId === a.ruleId)?.result, 'violated')
    assert.equal(final.ruleResults.find(row => row.ruleId === b.ruleId)?.result, 'satisfied')
  } finally { await f.cleanup() }
})

test('later candidate pools deepen a productive query using committed coarse and final results', async () => {
  const f = await fixture({ target: 3, queries: ['broad direction', 'focused direction'], color: id => ['focused-0', 'focused-1', 'focused-30'].includes(id) ? 'green' : 'red',
    page: (query, page) => ({ ids: Array.from({ length: 30 }, (_, offset) => `${query === 'focused direction' ? 'focused' : 'broad'}-${page * 30 + offset}`), nextCursor: page < 3 ? String(page + 1) : null }) })
  try {
    const run = await f.run()
    assert.equal(run.outcome, 'target-met')
    assert.deepEqual(f.sourceQueries.slice(0, 2), [{ query: 'broad direction', page: 0 }, { query: 'focused direction', page: 0 }])
    assert.deepEqual(f.sourceQueries.slice(2), [{ query: 'focused direction', page: 1 }, { query: 'focused direction', page: 2 }], 'The first pool proves the broad query low-yield before the second pool chooses deeper source pages')
    assert.equal(f.repository.list('selection').length, 3)
    assert.equal(dataOf(run).counts.screeningReviewed, 100)
  } finally { await f.cleanup() }
})

test('known restricted originals consume no image downloads or visual calls', async () => {
  const f = await fixture({ count: 3, output: 'original', restrictedOriginals: true })
  try {
    const run = await f.run()
    assert.equal(run.outcome, 'source-exhausted')
    assert.equal(dataOf(run).counts.unavailable, 3)
    assert.equal(dataOf(run).counts.technicalFailed, 0)
    assert.equal(dataOf(run).budget.vision, 0)
    assert.deepEqual(f.mediaRequests, [])
  } finally { await f.cleanup() }
})
