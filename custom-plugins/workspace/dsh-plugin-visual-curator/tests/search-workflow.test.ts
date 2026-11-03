import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { z } from 'zod'
import sharp from 'sharp'
import { CuratorDomain } from '../src/domain/curator.ts'
import { contentDigest, DomainRepository, MemoryDomainAdapter } from '../src/domain/repository.ts'
import { createCropProcessor } from '../src/host/crop-workflow.ts'
import { createSearchWorker } from '../src/host/search-workflow.ts'
import { freezeSearchExclusions } from '../src/host/search-exclusions.ts'
import { importedRecords } from '../src/host/imports.ts'
import { projectRun } from '../src/host/projection.ts'
import { resolveConfig } from '../src/host/config.ts'
import { BudgetLedger, dataOf, specOf, RunEngine, toJson } from '../src/host/runtime.ts'
import { FixtureJobs } from './helpers/service-fixture.ts'
import type { ExecutionSpec, WorkContext } from '../src/host/runtime.ts'
import { AssetFiles, CompatibleVisionProvider, MediaError, SourceHttpProvider } from '../src/media/index.ts'
import type { HttpClient, HttpRequest, HttpResponse } from '../src/media/index.ts'
import { draftSchema, styleSchema, recipeSchema, releaseSchema, referenceSnapshotSchema, requestSchema as persistedRequestSchema, runSchema, usageSchema } from '../src/shared/model.ts'

const base = { schemaVersion: 1, profileId: 'p', createdAt: '2026-10-23T00:00:00.000Z' }
const human = { kind: 'authenticated-human', id: 'human', confirmationMethod: 'client-action', confirmedAt: base.createdAt }
const recipe = recipeSchema.parse({ ...base, id: 'recipe', kind: 'recipe', visionRevision: 'fixture', model: 'fixture', vendorVersion: null, promptVersion: 'v1', outputSchemaVersion: 'v1', preprocessingVersion: 'v1', referenceStrategy: { maxImages: 4, maxBytes: 1000000 }, preferenceScale: { min: 0, max: 1, weights: { color: 1 } }, unknownPolicy: 'needs-review', tieBreak: 'stable-id' })
const release = releaseSchema.parse({ ...base, id: 'release', kind: 'release', styleId: 'style', draftId: 'draft', draftRevision: 1, rules: ['source', 'final'].map(stage => ({ ruleId: `${stage}-rule`, dimension: 'subject', statement: 'Visible subject.', condition: {}, strength: 'required', stage, check: { kind: 'visual', criterion: 'Keep the subject.' }, exceptions: [], supportRefs: [], counterRefs: [], confirmation: { status: 'confirmed', actor: human } })), references: [], recipe, contentDigest: `sha256-v1:${'a'.repeat(64)}`, releaseNumber: 1, candidateSnapshotId: 'candidate', changeSummary: '', confirmedBy: human, validation: { status: 'provisional', evaluationIds: [], sampleCount: 0, limitations: [] } })
const usage = usageSchema.parse({ ...base, id: 'usage', kind: 'usage', presetId: 'preset', name: 'Square', revision: 1, output: { aspectP: 1, aspectQ: 1, targetWidth: 32, targetHeight: 32, acceptedFormats: ['png'], allowUpscale: false }, safeRegions: [], protectedContent: [] })
const requestSchema = z.object({ messages: z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())]) })) })
const promptSchema = z.object({ input: z.object({ operation: z.string(), stage: z.string().optional(), images: z.array(z.object({ imageVersionId: z.string() })), rules: z.array(z.object({ ruleId: z.string(), stage: z.string() })) }) })

interface SourceResult { items: { id: string; preview: string; original?: string }[]; next: string | null }
const item = (id: string, original = true) => ({ id, preview: `https://cdn.example.test/${id}-preview`, ...(original ? { original: `https://cdn.example.test/${id}-original` } : {}) })

class SearchFixture implements HttpClient {
  readonly images = new Map<string, Buffer>()
  readonly sourceRequests: { query: string; cursor: string | null }[] = []
  readonly downloads: string[] = []
  readonly visionOperations: string[] = []
  readonly reviewedImages: { imageId: string; stage: string }[] = []
  relevance: (imageId: string) => 'relevant' | 'irrelevant' | 'unknown' = () => 'relevant'
  rejectFinal = false
  unknownFinal = false
  failDownloadAttempts = 0
  downloadStatus = 200
  constructor(readonly bytes: Buffer, readonly pages: (query: string, cursor: string | null) => SourceResult | Error) {}
  async request(url: string, input: HttpRequest): Promise<HttpResponse> {
    const parsed = new URL(url)
    let result: unknown
    if (parsed.hostname === 'source.example.test') {
      const query = parsed.searchParams.get('q') ?? '', cursor = parsed.searchParams.get('cursor')
      this.sourceRequests.push({ query, cursor })
      const page = this.pages(query, cursor)
      if (page instanceof Error) throw page
      result = page
    } else if (parsed.hostname === 'cdn.example.test') {
      this.downloads.push(parsed.pathname)
      assert.equal(input.headers?.authorization, undefined, 'source credentials must not reach media CDN')
      assert.equal(input.headers?.['x-api-key'], undefined)
      if (this.failDownloadAttempts-- > 0) throw new MediaError('remote-timeout', 'network', true, 'The request timed out.', 'Retry within budgets.')
      return { status: this.downloadStatus, headers: { 'content-type': 'image/png' }, bytes: this.images.get(parsed.pathname) ?? this.bytes }
    } else {
      const body = requestSchema.parse(JSON.parse(Buffer.from(input.body ?? []).toString('utf8')))
      const content = body.messages.find(message => message.role === 'user')?.content
      assert.ok(Array.isArray(content))
      const prompt = promptSchema.parse(JSON.parse(content[0]?.text ?? '{}')).input
      this.visionOperations.push(`${prompt.operation}:${prompt.stage ?? ''}`)
      if (prompt.operation !== 'propose-crop') this.reviewedImages.push({ imageId: prompt.images[0]!.imageVersionId, stage: prompt.stage! })
      const output = prompt.operation === 'propose-crop' ? { feasibility: 'feasible', reason: 'Full square can retain the subject.', candidates: [{ requestedRect: { x: 0, y: 0, width: 1, height: 1 }, reason: 'Full image.', protectedContent: 'preserved' }] } : { ruleResults: prompt.rules.filter(rule => rule.stage === prompt.stage).map(rule => ({ ruleId: rule.ruleId, status: this.unknownFinal && prompt.stage === 'final' ? 'unknown' : this.rejectFinal && prompt.stage === 'final' ? 'violated' : 'satisfied', source: 'inferred', reason: 'Visible image evidence.', evidenceImageVersionIds: [prompt.images[0]?.imageVersionId] })), cropPotential: 'crop-candidate', preferenceScores: [{ dimension: 'color', score: 0.8 }], taskRelevance: this.relevance(prompt.images[0]!.imageVersionId) }
      result = { choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] }
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify(result)) }
  }
}

async function setup(pages: SearchFixture['pages'], options: { original?: boolean; targetCount?: number; queries?: string[]; maxDownloadBytes?: number; maxImportBytes?: number; maxCandidates?: number; maxVisionCalls?: number; maxSearchPages?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'visual-search-'))
  const bytes = await sharp({ create: { width: 100, height: 100, channels: 3, background: 'red' } }).png().toBuffer()
  const fixture = new SearchFixture(bytes, pages)
  const config = resolveConfig({ source: { endpoint: 'https://source.example.test/search', allowedMediaOrigins: ['https://cdn.example.test'] }, limits: { pageSize: 10, maxVisionCalls: options.maxVisionCalls ?? 100, ...(options.maxSearchPages === undefined ? {} : { maxSearchPages: options.maxSearchPages }), ...(options.maxDownloadBytes === undefined ? {} : { maxDownloadBytes: options.maxDownloadBytes }), ...(options.maxImportBytes === undefined ? {} : { maxImportBytes: options.maxImportBytes }), ...(options.maxCandidates === undefined ? {} : { maxCandidates: options.maxCandidates }) } })
  const files = new AssetFiles(directory, { maxFileBytes: config.limits.maxImportBytes, maxPixels: 1000000, maxDimension: 1000, previewMaxDimension: 32, maxStorageBytes: 10000000 })
  const adapter = new MemoryDomainAdapter(), repository = new DomainRepository('p', adapter)
  const domain = new CuratorDomain('p', repository, { verifyImage: async image => { await files.read(image.blob) } })
  const spec: ExecutionSpec = { kind: 'search', config, input: { queries: options.queries ?? ['cats'], taskBrief: 'Clear subjects.', targetCount: options.targetCount ?? 10 }, fixed: { release: toJson(release), ...(options.original ? { output: { kind: 'original' } } : { usage: toJson(usage) }) }, specDigest: 'fixed-spec' }
  const ledger = new BudgetLedger(config.limits)
  const run = runSchema.parse({ ...base, id: 'run', kind: 'run', owner: { kind: 'profile' }, revision: 1, status: 'running', stage: 'retrieving', spec: toJson(spec), data: { attemptId: 'attempt', attempts: 1, budget: ledger.snapshot(), checkpoint: {}, counts: {}, warnings: [], resultIds: [], requestIds: [] } })
  const style = styleSchema.parse({ ...base, id: 'style', kind: 'style', name: 'Test style', archived: false, draftId: 'draft', revision: 1, committedReleaseIds: [release.id], defaultReleaseId: release.id, nextReleaseNumber: 2 })
  const draft = draftSchema.parse({ ...base, id: 'draft', kind: 'draft', styleId: 'style', revision: 1, status: 'editing', rules: release.rules, referenceIds: [], feedbackIds: [], conflicts: [] })
  await repository.commit({ aggregateId: 'run:run', expectedRevision: 0, operationId: 'initial', request: {}, records: [style, draft, recipe, release, usage, run], state: {} })
  const controller = new AbortController()
  let currentSignal = controller.signal
  let saveCount = 0
  let afterSave: ((records: readonly { kind: string }[]) => void) | undefined
  const context: WorkContext = { runId: run.id, get signal() { return currentSignal }, spec, ledger, current: () => domain.require('run', run.id),
    report: () => { /* 此夹具只运行搜图与裁图，不产生分析消息。 */ },
    save: async (stage, patch, records = []) => {
      currentSignal.throwIfAborted()
      const current = context.current()
      const next = runSchema.parse({ ...current, revision: current.revision + 1, stage, data: toJson({ ...dataOf(current), ...patch, budget: ledger.snapshot() }) })
      await repository.commit({ aggregateId: 'run:run', expectedRevision: repository.manifest('run:run')?.revision ?? 0, operationId: `save-${++saveCount}`, request: { next, records }, records: [next, ...records], state: {} })
      afterSave?.(records)
    },
    request: async (kind, _bundle, work) => {
      for (let attempt = 0; ; attempt++) {
        currentSignal.throwIfAborted(); await ledger.reserve(kind)
        try { return await work(currentSignal, async () => {}) } catch (error) {
          if (currentSignal.aborted || !(error instanceof MediaError) || !error.retryable || attempt >= config.limits.maxRetryAttempts) throw error
        }
      }
    },
  }
  const source = new SourceHttpProvider({ endpoint: config.source.endpoint, method: 'GET', request: { query: 'q', cursor: 'cursor', pageSize: 'limit' }, response: { items: '/items', nextCursor: '/next', id: '/id', previewUrl: '/preview', originalUrl: '/original' }, maxPageSize: 10 }, fixture, { authorization: 'Bearer source-only' })
  const vision = new CompatibleVisionProvider({ endpoint: 'https://vision.example.test', model: 'fixture', supportsMultiImage: true, maxImages: 10, maxImageBytes: 1000000, maxRequestBytes: 1000000, maxOutputTokens: 2000, temperature: 0 }, fixture)
  const crop = createCropProcessor({ domain, files, vision: async () => vision })
  const worker = createSearchWorker({ domain, files, source: async () => source, media: () => fixture, vision: async () => vision, crop: async (ctx, ids) => { for (const id of ids) await crop(ctx, id, release, usage) } })
  return { worker, context, fixture, domain, files, controller, bytes, source, adapter, setSignal: (signal: AbortSignal) => { currentSignal = signal }, setAfterSave: (callback: typeof afterSave) => { afterSave = callback }, cleanup: async () => { await rm(directory, { recursive: true, force: true }) } }
}

test('exact local negative pixels under another source id are skipped without spending vision quota', async () => {
  const f = await setup(() => ({ items: [item('same-bytes'), item('fresh-bytes')], next: null }), { original: true, targetCount: 1, maxSearchPages: 1 })
  try {
    const actor = { kind: 'human' as const, id: 'owner', profileId: 'p' }
    const media = await f.files.importBytes(f.bytes, 'image/png', f.context.signal)
    const negative = importedRecords('p', actor, media, { kind: 'local-import', description: 'Negative reference' })
    await f.domain.repository.commit({ aggregateId: 'negative', expectedRevision: 0, operationId: 'negative', request: {}, records: negative.records, state: {} })
    const reference = referenceSnapshotSchema.parse({ reference: { ...base, id: 'negative-reference', kind: 'reference', styleId: release.styleId, imageVersionId: negative.image.id, role: 'negative', intent: { kind: 'overall' }, context: {}, feedbackThreadIds: [] }, imageDigest: negative.image.blob.digest, familyId: negative.asset.familyId, feedbackIds: [] })
    const standard = releaseSchema.parse({ ...release, references: [reference] })
    f.context.spec.fixed.searchExclusions = toJson(freezeSearchExclusions(f.domain, standard, actor, [], 'Check the frozen style.'))
    const fresh = await sharp({ create: { width: 100, height: 100, channels: 3, background: 'blue' } }).png().toBuffer()
    f.fixture.images.set('/fresh-bytes-original', fresh)
    assert.equal(await f.worker(f.context), 'target-met')
    const run = f.context.current(), data = dataOf(run)
    assert.equal(data.counts.excludedNegative, 1); assert.equal(data.counts.technicalFailed, 0)
    assert.equal(data.budget.search, 1); assert.equal(data.budget.vision, 2)
    assert.equal(data.budget.downloadBytes, f.bytes.length + fresh.length)
    assert.deepEqual(f.fixture.downloads, ['/same-bytes-original', '/fresh-bytes-original'])
    assert.equal(f.fixture.reviewedImages.length, 2)
    const selection = f.domain.repository.list('selection')[0]!, asset = f.domain.require('asset', f.domain.require('imageVersion', selection.imageVersionId).assetId)
    assert.equal(asset.source.kind === 'provider' ? asset.source.providerAssetId : '', 'fresh-bytes')
    assert.equal(f.domain.repository.list('selection').length, 1)
  } finally { await f.cleanup() }
})

for (const interrupt of [false, true]) test(`original search yields an off-subject query and follows productive pages${interrupt ? ' after checkpoint recovery' : ''}`, async () => {
  const f = await setup((query, cursor) => query === 'off-subject'
    ? { items: [item('bad-1'), item('bad-2')], next: 'bad-next' }
    : { items: cursor === null ? [item('good-1')] : [item('good-2'), item('good-3')], next: cursor === null ? 'good-next' : null },
  { original: true, targetCount: 3, queries: ['off-subject', 'productive', 'unexplored'], maxSearchPages: 3 })
  try {
    for (const [index, id] of ['bad-1', 'bad-2', 'good-1', 'good-2', 'good-3'].entries()) f.fixture.images.set(`/${id}-original`, await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 20 + index * 30, g: 80, b: 120 } } }).png().toBuffer())
    f.fixture.relevance = imageId => {
      const source = f.domain.require('asset', f.domain.require('imageVersion', imageId).assetId).source
      return source.kind === 'provider' && source.providerAssetId.startsWith('bad-') ? 'irrelevant' : 'relevant'
    }
    if (interrupt) {
      f.setAfterSave(records => { if (records.some(record => record.kind === 'selection')) f.controller.abort() })
      await assert.rejects(f.worker(f.context))
      const saved = z.object({ queryRemainders: z.array(z.object({ queryIndex: z.number(), pageDone: z.array(z.string()) })) }).parse(dataOf(f.context.current()).checkpoint.search)
      assert.ok(saved.queryRemainders.some(query => query.queryIndex === 0 && query.pageDone.includes('bad-1')))
      f.setAfterSave(undefined); f.setSignal(new AbortController().signal)
    }
    assert.equal(await f.worker(f.context), 'target-met')
    assert.deepEqual(f.fixture.sourceRequests, [{ query: 'off-subject', cursor: null }, { query: 'productive', cursor: null }, { query: 'productive', cursor: 'good-next' }])
    assert.equal(f.context.ledger.snapshot().search, 3)
    assert.equal(f.domain.repository.list('selection').length, 3)
    assert.equal(f.fixture.reviewedImages.filter(review => review.stage === 'source').length, 4)
    assert.equal(f.fixture.downloads.length, 4)
  } finally { await f.cleanup() }
})

test('legacy query checkpoints do not reopen directions completed before their saved index', async () => {
  const f = await setup(query => { assert.equal(query, 'remaining'); return { items: [item('remaining-image')], next: null } }, { original: true, targetCount: 1, queries: ['already-completed', 'remaining'], maxSearchPages: 1 })
  try {
    await f.context.save('retrieving', { checkpoint: { search: { queryIndex: 1, cursor: null, seenCursors: [], seenIds: [], seenDigests: [], pageIds: [], pageDone: [], nextCursor: null, pageLoaded: false, failedQueries: 0, successfulPages: 0, importedImages: {}, duplicateIds: [] } } })
    assert.equal(await f.worker(f.context), 'target-met')
    assert.deepEqual(f.fixture.sourceRequests, [{ query: 'remaining', cursor: null }])
    assert.equal(f.context.ledger.snapshot().search, 1)
  } finally { await f.cleanup() }
})

test('a yielded original query restores its saved next cursor after another direction exhausts', async () => {
  const f = await setup((query, cursor) => query === 'first'
    ? { items: [item(cursor === null ? 'bad-first' : 'good-returned')], next: cursor === null ? 'saved-next' : null }
    : { items: [item('good-second')], next: null }, { original: true, queries: ['first', 'second'], targetCount: 2, maxSearchPages: 3 })
  try {
    for (const [index, id] of ['bad-first', 'good-second', 'good-returned'].entries()) f.fixture.images.set(`/${id}-original`, await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 50 + index * 50, g: 100, b: 30 } } }).png().toBuffer())
    f.fixture.relevance = imageId => {
      const source = f.domain.require('asset', f.domain.require('imageVersion', imageId).assetId).source
      return source.kind === 'provider' && source.providerAssetId === 'bad-first' ? 'irrelevant' : 'relevant'
    }
    f.setAfterSave(records => { if (records.some(record => record.kind === 'selection')) f.controller.abort() })
    await assert.rejects(f.worker(f.context))
    const paused = z.object({ queryRemainders: z.array(z.object({ queryIndex: z.number(), cursor: z.string().nullable(), pageLoaded: z.boolean() })) }).parse(dataOf(f.context.current()).checkpoint.search)
    assert.ok(paused.queryRemainders.some(query => query.queryIndex === 0 && query.cursor === 'saved-next' && !query.pageLoaded))
    f.setAfterSave(undefined); f.setSignal(new AbortController().signal)
    assert.equal(await f.worker(f.context), 'target-met')
    assert.deepEqual(f.fixture.sourceRequests, [{ query: 'first', cursor: null }, { query: 'second', cursor: null }, { query: 'first', cursor: 'saved-next' }])
    assert.equal(f.context.ledger.snapshot().search, 3)
    assert.equal(f.fixture.downloads.length, 3)
    assert.equal(f.domain.repository.list('selection').length, 2)
  } finally { await f.cleanup() }
})

test('unproductive directions end at the saved search-call budget instead of extending it', async () => {
  const f = await setup((_query, cursor) => ({ items: [item(`bad-${cursor ?? 'first'}`)], next: `page-${cursor ?? 'first'}` }), { original: true, targetCount: 1, maxSearchPages: 2 })
  try {
    f.fixture.relevance = () => 'irrelevant'
    assert.equal(await f.worker(f.context), 'budget-exhausted')
    assert.equal(f.fixture.sourceRequests.length, 2)
    assert.equal(f.context.ledger.snapshot().search, 2)
    assert.equal(f.domain.repository.list('selection').length, 0)
  } finally { await f.cleanup() }
})

test('a duplicate-only original page cannot turn earlier selections into new query yield', async () => {
  const f = await setup((query, cursor) => query === 'repeating'
    ? { items: [item('first-match')], next: cursor === null ? 'duplicate-page' : 'another-duplicate-page' }
    : { items: [item('second-match')], next: null }, { original: true, queries: ['repeating', 'fresh'], targetCount: 2, maxSearchPages: 3 })
  try {
    f.fixture.images.set('/second-match-original', await sharp({ create: { width: 100, height: 100, channels: 3, background: 'blue' } }).png().toBuffer())
    assert.equal(await f.worker(f.context), 'target-met')
    assert.deepEqual(f.fixture.sourceRequests, [{ query: 'repeating', cursor: null }, { query: 'repeating', cursor: 'duplicate-page' }, { query: 'fresh', cursor: null }])
    assert.equal(f.fixture.downloads.length, 2)
    assert.equal(f.domain.repository.list('selection').length, 2)
    assert.equal(f.context.ledger.snapshot().search, 3)
  } finally { await f.cleanup() }
})

test('a failed checkpoint stops query scheduling and resumes the committed image without another fetch', async () => {
  const f = await setup(() => ({ items: [item('saved-image')], next: null }), { original: true, targetCount: 1, maxSearchPages: 1 })
  try {
    f.setAfterSave(records => { if (records.some(record => record.kind === 'asset')) f.adapter.failNextManifest = true })
    await assert.rejects(f.worker(f.context), { code: 'storage-commit-failed' })
    assert.equal(f.domain.repository.list('assessment').length, 0)
    assert.equal(f.domain.repository.list('selection').length, 0)
    f.setAfterSave(undefined)
    assert.equal(await f.worker(f.context), 'target-met')
    assert.equal(f.fixture.sourceRequests.length, 1)
    assert.equal(f.fixture.downloads.length, 1)
    assert.equal(f.context.ledger.snapshot().search, 1)
  } finally { await f.cleanup() }
})

test('missing source originals retain candidate diagnostics without becoming reference or visual failures', async () => {
  const fixture = await setup(() => ({ items: [item('preview-only', false)], next: null }), { original: true, targetCount: 1 })
  try {
    assert.equal(await fixture.worker(fixture.context), 'source-exhausted')
    const data = dataOf(fixture.context.current())
    assert.equal(data.counts.unavailable, 1)
    assert.deepEqual(z.object({ issues: z.array(z.object({ candidateId: z.string(), stage: z.string(), category: z.string(), code: z.string() })) }).parse(data.checkpoint.search).issues,
      [{ candidateId: 'preview-only', stage: 'lookup', category: 'unavailable', code: 'source-original-unavailable' }])
    assert.equal(fixture.fixture.downloads.length, 0)
    assert.equal(fixture.fixture.visionOperations.length, 0)
    assert.equal(fixture.domain.repository.list('assessment').length, 0)
    assert.ok(data.warnings.every(warning => !warning.includes('reference-unavailable')))
  } finally { await fixture.cleanup() }
})

test('known restricted originals skip lookup and HTTP download failures retain their actual stage', async () => {
  const restricted = await setup(() => ({ items: [], next: null }), { original: true })
  try {
    let lookups = 0
    restricted.source.config.lookup = { endpoint: 'https://source.example.test/lookup', method: 'GET', idField: 'id', response: { id: '/id', previewUrl: '/preview' } }
    restricted.source.search = async () => ({ items: [{ providerAssetId: 'premium', previewUrl: '', originalUnavailable: 'restricted' }], nextCursor: null })
    restricted.source.lookup = async () => { lookups++; return { providerAssetId: 'premium', previewUrl: '' } }
    assert.equal(await restricted.worker(restricted.context), 'source-exhausted')
    assert.equal(lookups, 0); assert.equal(restricted.fixture.downloads.length, 0)
    assert.equal(dataOf(restricted.context.current()).counts.unavailable, 1)
  } finally { await restricted.cleanup() }
  const failed = await setup(() => ({ items: [item('denied')], next: null }), { original: true })
  try {
    failed.fixture.downloadStatus = 503
    assert.equal(await failed.worker(failed.context), 'partial-failure')
    const data = dataOf(failed.context.current())
    assert.equal(data.counts.technicalFailed, 1)
    assert.deepEqual(z.object({ issues: z.array(z.json()) }).parse(data.checkpoint.search).issues,
      [{ candidateId: 'denied', stage: 'download', category: 'technical', code: 'source-download-http', httpStatus: 503 }])
    assert.equal(failed.domain.repository.list('assessment').length, 0)
  } finally { await failed.cleanup() }
})

test('original search qualifies source and final pixels without a usage or crop and preserves source bytes', async () => {
  const fixture = await setup(() => ({ items: [item('original')], next: null }), { original: true, targetCount: 1 })
  try {
    let sawProcessing = false
    fixture.setAfterSave(records => {
      if (!records.some(record => record.kind === 'imageVersion')) return
      const view = projectRun(fixture.domain, fixture.context.current(), { kind: 'human', id: 'owner', profileId: 'p' })
      assert.equal(view.results[0]?.resultCategory, 'processing')
      assert.equal(view.resultSummary?.selected, 0)
      sawProcessing = true
    })
    assert.equal(await fixture.worker(fixture.context), 'target-met')
    assert.equal(sawProcessing, true)
    assert.deepEqual(fixture.fixture.visionOperations, ['review:source', 'review:final'])
    const [selection] = fixture.domain.repository.list('selection')
    assert.ok(selection)
    const { asset, image } = fixture.domain.authorizedImage(selection.imageVersionId, { kind: 'human', id: 'owner', profileId: 'p' })
    assert.equal(image.versionKind, 'normalized')
    assert.ok(asset.originalBlob)
    assert.deepEqual(await fixture.files.read(asset.originalBlob), fixture.bytes)
    assert.equal(fixture.domain.repository.list('cropCandidate').length, 0)
    const view = projectRun(fixture.domain, fixture.context.current(), { kind: 'human', id: 'owner', profileId: 'p' })
    assert.equal(view.resultSummary?.selected, 1)
    assert.equal(view.resultSummary?.needsReview, 0)
  } finally { await fixture.cleanup() }
})

for (const verdict of ['rejectFinal', 'unknownFinal'] as const) test(`original search does not count ${verdict} evidence`, async () => {
  const fixture = await setup(() => ({ items: [item('original')], next: null }), { original: true, targetCount: 1 })
  try {
    fixture.fixture[verdict] = true
    assert.equal(await fixture.worker(fixture.context), 'source-exhausted')
    assert.equal(fixture.domain.repository.list('selection').length, 0)
    const view = projectRun(fixture.domain, fixture.context.current(), { kind: 'human', id: 'owner', profileId: 'p' })
    assert.equal(view.resultSummary?.selected, 0)
    assert.equal(view.results[0]?.resultCategory, verdict === 'unknownFinal' ? 'review' : 'rejected')
  } finally { await fixture.cleanup() }
})

test('unselected result pagination is independent of repository enumeration order', async () => {
  const fixture = await setup(() => ({ items: [item('rejected')], next: null }))
  const list = fixture.domain.repository.list.bind(fixture.domain.repository)
  try {
    fixture.fixture.rejectFinal = true
    await fixture.worker(fixture.context)
    const actor = { kind: 'human' as const, id: 'owner', profileId: 'p' }
    const before = projectRun(fixture.domain, fixture.context.current(), actor).results.map(image => image.imageVersionId)
    assert.ok(before.length > 1)
    fixture.domain.repository.list = kind => list(kind).toReversed()
    assert.deepEqual(projectRun(fixture.domain, fixture.context.current(), actor).results.map(image => image.imageVersionId), before)
  } finally { fixture.domain.repository.list = list; await fixture.cleanup() }
})

test('search uses real pagination, deduplicates bytes without losing independent source associations and reports shortfall', async () => {
  const fixture = await setup((_query, cursor) => ({ items: [item(cursor === null ? 'one' : 'two')], next: cursor === null ? 'page-2' : null }))
  try {
    assert.equal(await fixture.worker(fixture.context), 'source-exhausted')
    assert.deepEqual(fixture.fixture.sourceRequests, [{ query: 'cats', cursor: null }, { query: 'cats', cursor: 'page-2' }])
    assert.equal(fixture.domain.repository.list('selection').length, 1)
    assert.equal(fixture.domain.repository.list('asset').length, 2, 'equal bytes retain separate source identity associations')
    assert.equal(fixture.fixture.downloads.length, 2)
  } finally { await fixture.cleanup() }
})

test('target count stops after distinct final selections and never counts source-only pass or preview pixels', async () => {
  const fixture = await setup(() => ({ items: [item('one'), item('two')], next: 'unneeded-page' }), { targetCount: 1 })
  try {
    assert.equal(await fixture.worker(fixture.context), 'target-met')
    assert.equal(fixture.fixture.downloads.length, 1)
    assert.equal(fixture.fixture.sourceRequests.length, 1)
  } finally { await fixture.cleanup() }
  const preview = await setup(() => ({ items: [item('preview-only', false)], next: null }), { targetCount: 1 })
  try {
    assert.equal(await preview.worker(preview.context), 'source-exhausted')
    assert.equal(preview.fixture.downloads.length, 0)
    assert.equal(preview.domain.repository.list('selection').length, 0)
  } finally { await preview.cleanup() }
  const rejected = await setup(() => ({ items: [item('original')], next: null }), { targetCount: 1 })
  try {
    rejected.fixture.rejectFinal = true
    assert.equal(await rejected.worker(rejected.context), 'source-exhausted')
    assert.equal(rejected.domain.repository.list('selection').length, 0)
    assert.ok(rejected.domain.repository.list('assessment').some(assessment => assessment.stage === 'source' && assessment.verdict === 'pass'))
    assert.ok(rejected.domain.repository.list('assessment').some(assessment => assessment.stage === 'final' && assessment.verdict === 'reject'))
  } finally { await rejected.cleanup() }
})

test('resume at the candidate limit finishes a committed original without another source page or media download', async () => {
  const fixture = await setup(() => ({ items: [item('pending-original')], next: null }), { targetCount: 1, maxCandidates: 1 })
  try {
    fixture.setAfterSave(records => { if (records.some(record => record.kind === 'asset')) fixture.controller.abort() })
    await assert.rejects(fixture.worker(fixture.context))
    assert.equal(fixture.fixture.downloads.length, 1)
    fixture.setAfterSave(undefined)
    fixture.setSignal(new AbortController().signal)
    assert.equal(await fixture.worker(fixture.context), 'target-met')
    assert.equal(fixture.fixture.downloads.length, 1)
    assert.equal(fixture.fixture.sourceRequests.length, 1, 'a committed page must not be fetched again for saved originals')
  } finally { await fixture.cleanup() }
})

test('resume replays a committed source review after a crash before the assessment checkpoint', async () => {
  const fixture = await setup(() => ({ items: [item('committed-review')], next: null }), { targetCount: 1 })
  try {
    const interrupted: WorkContext = { ...fixture.context, request: async (kind, bundle, work, summarize) => {
      const output = await fixture.context.request(kind, bundle, work, summarize)
      if (kind === 'vision') {
        const record = persistedRequestSchema.parse({ ...base, id: 'source-response-before-crash', kind: 'request', runId: fixture.context.runId, state: 'committed', requestDigest: contentDigest(bundle), data: toJson({ bundle, output }) })
        await fixture.context.save('screening', {}, [record])
        fixture.controller.abort()
        throw new Error('Crash after the committed source response')
      }
      return output
    } }
    await assert.rejects(fixture.worker(interrupted))
    assert.equal(fixture.domain.repository.list('assessment').length, 0)
    assert.deepEqual(fixture.fixture.visionOperations, ['review:source'])
    fixture.setSignal(new AbortController().signal)
    assert.equal(await fixture.worker(fixture.context), 'target-met')
    assert.deepEqual(fixture.fixture.visionOperations, ['review:source', 'propose-crop:', 'review:final'])
    assert.equal(fixture.fixture.downloads.length, 1)
    assert.equal(fixture.fixture.sourceRequests.length, 1)
    assert.equal(fixture.context.ledger.snapshot().vision, 3)
  } finally { await fixture.cleanup() }
})

test('a bad-protocol query stops while other queries complete and preserve partial results', async () => {
  const fixture = await setup(query => query === 'bad' ? { items: [item('bad')], next: '' } : { items: [item('good')], next: null }, { queries: ['bad', 'good'], targetCount: 2 })
  try {
    assert.equal(await fixture.worker(fixture.context), 'partial-failure')
    assert.equal(fixture.domain.repository.list('selection').length, 1)
    assert.equal(fixture.fixture.sourceRequests.length, 2)
    assert.ok(dataOf(fixture.context.current()).warnings.some(warning => warning.includes('source-protocol-error')))
  } finally { await fixture.cleanup() }
})

test('all failed queries fail visibly rather than normal exhaustion, while mixed transport failures remain partial', async () => {
  const failure = new MediaError('remote-request-failed', 'network', false, 'Remote request failed.', 'Check service configuration.')
  const mixed = await setup(query => query === 'bad' ? failure : { items: [item('good')], next: null }, { queries: ['bad', 'good'], targetCount: 2 })
  try { assert.equal(await mixed.worker(mixed.context), 'partial-failure'); assert.equal(mixed.domain.repository.list('selection').length, 1) } finally { await mixed.cleanup() }
  const all = await setup(() => failure, { queries: ['bad'] })
  try { await assert.rejects(all.worker(all.context)); assert.equal(all.domain.repository.list('selection').length, 0) } finally { await all.cleanup() }
})

test('unknown failed download spends its byte reservation and a retry cannot bypass the hard byte budget', async () => {
  const fixture = await setup(() => ({ items: [item('one')], next: null }), { maxDownloadBytes: 1024, maxImportBytes: 1024 })
  try {
    fixture.fixture.failDownloadAttempts = 1
    await assert.rejects(fixture.worker(fixture.context), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'budget-exhausted')
    assert.equal(fixture.fixture.downloads.length, 1, 'the second attempt needs a new reservation before any I/O')
    assert.equal(fixture.context.ledger.snapshot().downloadBytes, 1024)
  } finally { await fixture.cleanup() }
})

test('a ten-image target retains eight qualified derivatives without repeating source review before the shared budget stops the Run', async () => {
  const fixture = await setup(() => ({ items: Array.from({ length: 10 }, (_, index) => item(`image-${index}`)), next: null }), { targetCount: 10, maxVisionCalls: 24 })
  const jobs = new FixtureJobs(), engine = new RunEngine(fixture.domain.repository, jobs)
  try {
    for (let index = 0; index < 10; index++) fixture.fixture.images.set(`/image-${index}-original`, await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 50 + index, g: 90, b: 60 } } }).png().toBuffer())
    const before = contentDigest(release)
    const run = await engine.create(fixture.context.spec, { kind: 'human', id: 'owner', profileId: 'p' }, fixture.worker, 'ten-target')
    await jobs.drain()
    const complete = fixture.domain.require('run', run.id)
    assert.equal(complete.status, 'completed')
    assert.equal(complete.outcome, 'budget-exhausted')
    const selections = fixture.domain.repository.list('selection').filter(item => item.runId === run.id)
    assert.equal(selections.length, 8)
    assert.equal(new Set(selections.map(item => fixture.domain.require('imageVersion', item.imageVersionId).blob.digest)).size, 8)
    assert.equal(dataOf(complete).counts.qualified, 8)
    assert.equal(dataOf(complete).budget.vision, 24)
    assert.equal(fixture.fixture.visionOperations.length, 24)
    assert.equal(contentDigest(specOf(complete).fixed.release), before)
    assert.equal(contentDigest(fixture.domain.require('release', release.id)), before)
  } finally { await engine.dispose(); await fixture.cleanup() }
})
