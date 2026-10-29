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
import { resolveConfig } from '../src/host/config.ts'
import { BudgetLedger, dataOf, specOf, RunEngine, toJson } from '../src/host/runtime.ts'
import { FixtureJobs } from './helpers/service-fixture.ts'
import type { ExecutionSpec, WorkContext } from '../src/host/runtime.ts'
import { AssetFiles, CompatibleVisionProvider, MediaError, SourceHttpProvider } from '../src/media/index.ts'
import type { HttpClient, HttpRequest, HttpResponse } from '../src/media/index.ts'
import { recipeSchema, releaseSchema, requestSchema as persistedRequestSchema, runSchema, usageSchema } from '../src/shared/model.ts'

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
  rejectFinal = false
  unknownFinal = false
  failDownloadAttempts = 0
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
      return { status: 200, headers: { 'content-type': 'image/png' }, bytes: this.images.get(parsed.pathname) ?? this.bytes }
    } else {
      const body = requestSchema.parse(JSON.parse(Buffer.from(input.body ?? []).toString('utf8')))
      const content = body.messages.find(message => message.role === 'user')?.content
      assert.ok(Array.isArray(content))
      const prompt = promptSchema.parse(JSON.parse(content[0]?.text ?? '{}')).input
      this.visionOperations.push(`${prompt.operation}:${prompt.stage ?? ''}`)
      const output = prompt.operation === 'propose-crop' ? { feasibility: 'feasible', reason: 'Full square can retain the subject.', candidates: [{ requestedRect: { x: 0, y: 0, width: 1, height: 1 }, reason: 'Full image.', protectedContent: 'preserved' }] } : { ruleResults: prompt.rules.filter(rule => rule.stage === prompt.stage).map(rule => ({ ruleId: rule.ruleId, status: this.unknownFinal && prompt.stage === 'final' ? 'unknown' : this.rejectFinal && prompt.stage === 'final' ? 'violated' : 'satisfied', source: 'inferred', reason: 'Visible image evidence.', evidenceImageVersionIds: [prompt.images[0]?.imageVersionId] })), cropPotential: 'crop-candidate', preferenceScores: [{ dimension: 'color', score: 0.8 }], taskRelevance: 'relevant' }
      result = { choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] }
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify(result)) }
  }
}

async function setup(pages: SearchFixture['pages'], options: { original?: boolean; targetCount?: number; queries?: string[]; maxDownloadBytes?: number; maxImportBytes?: number; maxCandidates?: number; maxVisionCalls?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'visual-search-'))
  const bytes = await sharp({ create: { width: 100, height: 100, channels: 3, background: 'red' } }).png().toBuffer()
  const fixture = new SearchFixture(bytes, pages)
  const config = resolveConfig({ source: { endpoint: 'https://source.example.test/search', allowedMediaOrigins: ['https://cdn.example.test'] }, limits: { pageSize: 10, maxVisionCalls: options.maxVisionCalls ?? 100, ...(options.maxDownloadBytes === undefined ? {} : { maxDownloadBytes: options.maxDownloadBytes }), ...(options.maxImportBytes === undefined ? {} : { maxImportBytes: options.maxImportBytes }), ...(options.maxCandidates === undefined ? {} : { maxCandidates: options.maxCandidates }) } })
  const files = new AssetFiles(directory, { maxFileBytes: config.limits.maxImportBytes, maxPixels: 1000000, maxDimension: 1000, previewMaxDimension: 32, maxStorageBytes: 10000000 })
  const repository = new DomainRepository('p', new MemoryDomainAdapter())
  const domain = new CuratorDomain('p', repository, { verifyImage: async image => { await files.read(image.blob) } })
  const spec: ExecutionSpec = { kind: 'search', config, input: { queries: options.queries ?? ['cats'], taskBrief: 'Clear subjects.', targetCount: options.targetCount ?? 10 }, fixed: { release: toJson(release), ...(options.original ? { output: { kind: 'original' } } : { usage: toJson(usage) }) }, specDigest: 'fixed-spec' }
  const ledger = new BudgetLedger(config.limits)
  const run = runSchema.parse({ ...base, id: 'run', kind: 'run', owner: { kind: 'profile' }, revision: 1, status: 'running', stage: 'retrieving', spec: toJson(spec), data: { attemptId: 'attempt', attempts: 1, budget: ledger.snapshot(), checkpoint: {}, counts: {}, warnings: [], resultIds: [], requestIds: [] } })
  await repository.commit({ aggregateId: 'run:run', expectedRevision: 0, operationId: 'initial', request: {}, records: [recipe, release, usage, run], state: {} })
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
  return { worker, context, fixture, domain, files, controller, bytes, setSignal: (signal: AbortSignal) => { currentSignal = signal }, setAfterSave: (callback: typeof afterSave) => { afterSave = callback }, cleanup: async () => { await rm(directory, { recursive: true, force: true }) } }
}

test('original search qualifies source and final pixels without a usage or crop and preserves source bytes', async () => {
  const fixture = await setup(() => ({ items: [item('original')], next: null }), { original: true, targetCount: 1 })
  try {
    assert.equal(await fixture.worker(fixture.context), 'target-met')
    assert.deepEqual(fixture.fixture.visionOperations, ['review:source', 'review:final'])
    const [selection] = fixture.domain.repository.list('selection')
    assert.ok(selection)
    const { asset, image } = fixture.domain.authorizedImage(selection.imageVersionId, { kind: 'human', id: 'owner', profileId: 'p' })
    assert.equal(image.versionKind, 'normalized')
    assert.ok(asset.originalBlob)
    assert.deepEqual(await fixture.files.read(asset.originalBlob), fixture.bytes)
    assert.equal(fixture.domain.repository.list('cropCandidate').length, 0)
  } finally { await fixture.cleanup() }
})

for (const verdict of ['rejectFinal', 'unknownFinal'] as const) test(`original search does not count ${verdict} evidence`, async () => {
  const fixture = await setup(() => ({ items: [item('original')], next: null }), { original: true, targetCount: 1 })
  try {
    fixture.fixture[verdict] = true
    assert.equal(await fixture.worker(fixture.context), 'source-exhausted')
    assert.equal(fixture.domain.repository.list('selection').length, 0)
  } finally { await fixture.cleanup() }
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
