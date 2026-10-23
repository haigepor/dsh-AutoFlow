import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { z } from 'zod'
import sharp from 'sharp'
import { CuratorDomain } from '../src/domain/curator.ts'
import { contentDigest, DomainRepository, MemoryDomainAdapter } from '../src/domain/repository.ts'
import { createCropProcessor, createCropWorker } from '../src/host/crop-workflow.ts'
import { resolveConfig } from '../src/host/config.ts'
import { BudgetLedger, dataOf, toJson } from '../src/host/runtime.ts'
import type { ExecutionSpec, WorkContext } from '../src/host/runtime.ts'
import { AssetFiles, CompatibleVisionProvider } from '../src/media/index.ts'
import type { HttpClient, HttpRequest, HttpResponse } from '../src/media/index.ts'
import { assetSchema, imageVersionSchema, recipeSchema, releaseSchema, requestSchema as persistedRequestSchema, runSchema, usageSchema } from '../src/shared/model.ts'

const base = { schemaVersion: 1, profileId: 'p', createdAt: '2026-10-23T00:00:00.000Z' }
const human = { kind: 'authenticated-human', id: 'human', confirmationMethod: 'client-action', confirmedAt: base.createdAt }
const recipe = recipeSchema.parse({ ...base, id: 'recipe', kind: 'recipe', visionRevision: 'vision-revision', model: 'fixture', vendorVersion: null, promptVersion: 'v1', outputSchemaVersion: 'v1', preprocessingVersion: 'v1', referenceStrategy: { maxImages: 4, maxBytes: 1000000 }, preferenceScale: { min: 0, max: 1, weights: { color: 1, lighting: 0, texture: 0, subject: 0, composition: 0, density: 0, depth: 0 } }, unknownPolicy: 'needs-review', tieBreak: 'stable-id' })
const rules = ['source', 'final'].map(stage => ({ ruleId: `${stage}-rule`, dimension: 'subject', statement: 'Preserve the visible subject.', condition: {}, strength: 'required', stage, check: { kind: 'visual', criterion: 'Subject is intact.' }, exceptions: [], supportRefs: [], counterRefs: [], confirmation: { status: 'confirmed', actor: human } }))
const release = releaseSchema.parse({ ...base, id: 'release', kind: 'release', styleId: 'style', draftId: 'draft', draftRevision: 1, rules, references: [], recipe, contentDigest: `sha256-v1:${'a'.repeat(64)}`, releaseNumber: 1, candidateSnapshotId: 'style-candidate', changeSummary: 'Test', confirmedBy: human, validation: { status: 'provisional', evaluationIds: [], sampleCount: 0, limitations: [] } })
const usage = usageSchema.parse({ ...base, id: 'usage', kind: 'usage', presetId: 'preset', name: 'Square', revision: 1, output: { aspectP: 1, aspectQ: 1, targetWidth: 50, targetHeight: 50, acceptedFormats: ['png'], allowUpscale: false }, safeRegions: [], protectedContent: ['the required subject'] })
const messageSchema = z.object({ messages: z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional(), image_url: z.object({ url: z.string() }).optional() }))]) })) })
const promptSchema = z.object({ input: z.object({ operation: z.string(), stage: z.string().optional(), images: z.array(z.object({ imageVersionId: z.string() })), rules: z.array(z.object({ ruleId: z.string(), stage: z.string() })) }) })

class CropFixture implements HttpClient {
  readonly operations: string[] = []
  constructor(private readonly mode: 'green-passes' | 'all-rejected' | 'invalid-output' | 'unknown' | 'not-applicable' = 'green-passes') {}
  async request(_url: string, input: HttpRequest): Promise<HttpResponse> {
    const body = messageSchema.parse(JSON.parse(Buffer.from(input.body ?? []).toString('utf8')))
    const content = body.messages.find(message => message.role === 'user')?.content
    assert.ok(Array.isArray(content))
    const prompt = promptSchema.parse(JSON.parse(content[0]?.text ?? '{}')).input
    this.operations.push(`${prompt.operation}:${prompt.stage ?? ''}`)
    let output: unknown
    if (prompt.operation === 'propose-crop') output = { feasibility: 'feasible', reason: 'Two distinct square compositions.', candidates: [{ requestedRect: { x: 0, y: 0, width: 0.5, height: 1 }, reason: 'Left subject.', protectedContent: 'preserved' }, { requestedRect: { x: 0.5, y: 0, width: 0.5, height: 1 }, reason: 'Right subject.', protectedContent: 'preserved' }] }
    else {
      const firstImage = content.find(part => part.type === 'image_url')?.image_url?.url
      assert.ok(firstImage)
      const pixels = await sharp(Buffer.from(firstImage.split(',')[1] ?? '', 'base64')).raw().toBuffer()
      const status = prompt.stage === 'source' ? 'satisfied' : this.mode === 'unknown' ? 'unknown' : this.mode === 'not-applicable' ? 'not-applicable' : this.mode === 'all-rejected' || (pixels[0] ?? 0) > (pixels[1] ?? 0) ? 'violated' : 'satisfied'
      output = { ruleResults: prompt.rules.filter(rule => rule.stage === prompt.stage).map(rule => ({ ruleId: rule.ruleId, status, source: 'inferred', reason: 'Based on the transmitted image pixels.', evidenceImageVersionIds: [prompt.images[0]?.imageVersionId] })), cropPotential: 'crop-candidate', preferenceScores: [{ dimension: 'color', score: 0.9 }], taskRelevance: 'relevant' }
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: this.mode === 'invalid-output' ? 'invalid' : JSON.stringify(output) }, finish_reason: 'stop' }] })) }
  }
}

async function setup(mode?: ConstructorParameters<typeof CropFixture>[0], maxVisionCalls = 10) {
  const directory = await mkdtemp(join(tmpdir(), 'visual-crop-'))
  const files = new AssetFiles(directory, { maxFileBytes: 1000000, maxPixels: 1000000, maxDimension: 1000, previewMaxDimension: 32, maxStorageBytes: 10000000 })
  const left = await sharp({ create: { width: 100, height: 100, channels: 3, background: 'red' } }).png().toBuffer()
  const right = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#00ff00' } }).png().toBuffer()
  const bytes = await sharp({ create: { width: 200, height: 100, channels: 3, background: 'black' } }).composite([{ input: left, left: 0, top: 0 }, { input: right, left: 100, top: 0 }]).png().toBuffer()
  const imported = await files.importBytes(bytes)
  const asset = assetSchema.parse({ ...base, id: 'asset', kind: 'asset', familyId: 'family', source: { kind: 'local-import', description: 'Fixture' }, access: { kind: 'profile-library' }, originalBlob: imported.originalBlob, exportPermission: 'references-only', groupingStatus: 'unreviewed' })
  const image = imageVersionSchema.parse({ ...base, id: 'parent', kind: 'imageVersion', assetId: asset.id, versionKind: 'normalized', blob: imported.normalized.blob, geometry: { width: imported.normalized.width, height: imported.normalized.height, sourceOrientation: imported.normalized.sourceOrientation, colorSpace: 'srgb', processorVersion: files.processorVersion } })
  const repository = new DomainRepository('p', new MemoryDomainAdapter())
  const config = resolveConfig({ limits: { maxVisionCalls, maxCropCandidatesPerImage: 2 } })
  const spec: ExecutionSpec = { kind: 'crop', config, input: { imageVersionIds: [image.id], taskBrief: 'A clear subject.' }, fixed: { release: toJson(release), usage: toJson(usage) }, specDigest: 'fixed-spec' }
  const ledger = new BudgetLedger(config.limits)
  const run = runSchema.parse({ ...base, id: 'run', kind: 'run', owner: { kind: 'profile' }, revision: 1, status: 'running', stage: 'cropping', spec: toJson(spec), data: { attemptId: 'attempt', attempts: 1, budget: ledger.snapshot(), checkpoint: {}, counts: {}, warnings: [], resultIds: [], requestIds: [] } })
  await repository.commit({ aggregateId: 'run:run', expectedRevision: 0, operationId: 'initial', request: {}, records: [asset, image, recipe, release, usage, run], state: {} })
  const domain = new CuratorDomain('p', repository, { verifyImage: async image => { await files.read(image.blob) } })
  const fixture = new CropFixture(mode)
  const provider = new CompatibleVisionProvider({ endpoint: 'https://vision.example.test', model: 'fixture', supportsMultiImage: true, maxImages: 10, maxImageBytes: 1000000, maxRequestBytes: 1000000, maxOutputTokens: 2000, temperature: 0 }, fixture)
  const controller = new AbortController()
  let saveCounter = 0
  let afterSave: ((records: readonly { kind: string }[]) => void) | undefined
  let currentSignal = controller.signal
  const context: WorkContext = { runId: run.id, get signal() { return currentSignal }, spec, ledger, current: () => domain.require('run', run.id),
    save: async (stage, patch, records = []) => {
      context.signal.throwIfAborted()
      const current = context.current()
      const next = runSchema.parse({ ...current, revision: current.revision + 1, stage, data: toJson({ ...dataOf(current), ...patch, budget: ledger.snapshot() }) })
      await repository.commit({ aggregateId: 'run:run', expectedRevision: repository.manifest('run:run')?.revision ?? 0, operationId: `save-${++saveCounter}`, request: { next, records }, records: [next, ...records], state: {} })
      afterSave?.(records)
    },
    request: async (kind, _bundle, work) => { context.signal.throwIfAborted(); await ledger.reserve(kind); return await work(context.signal) },
  }
  return { directory, files, domain, fixture, provider, context, controller, image, bytes, setAfterSave: (callback: typeof afterSave) => { afterSave = callback }, setSignal: (signal: AbortSignal) => { currentSignal = signal }, cleanup: async () => { await rm(directory, { recursive: true, force: true }) } }
}

test('source pass cannot replace actual crop review; only the undamaged exact-size derivative is selected', async () => {
  const fixture = await setup()
  try {
    const outcome = await createCropWorker({ domain: fixture.domain, files: fixture.files, vision: async () => fixture.provider })(fixture.context)
    assert.equal(outcome, 'target-met', JSON.stringify(fixture.domain.repository.list('assessment')))
    assert.deepEqual(fixture.fixture.operations, ['review:source', 'propose-crop:', 'review:final', 'review:final'])
    const selections = fixture.domain.repository.list('selection')
    assert.equal(selections.length, 1)
    const selected = fixture.domain.require('imageVersion', selections[0]?.imageVersionId ?? '')
    const pixels = await sharp(await fixture.files.read(selected.blob)).raw().toBuffer({ resolveWithObject: true })
    assert.equal(pixels.info.width, 50)
    assert.equal(pixels.info.height, 50)
    assert.deepEqual([...pixels.data.subarray(0, 3)], [0, 255, 0])
    assert.equal(fixture.domain.repository.list('cropCandidate').length, 2)
    assert.equal(fixture.domain.repository.list('assessment').filter(a => a.stage === 'final' && a.verdict === 'reject').length, 1)
    assert.deepEqual(await fixture.files.read(fixture.image.blob), fixture.bytes)
    await createCropWorker({ domain: fixture.domain, files: fixture.files, vision: async () => fixture.provider })(fixture.context)
    assert.equal(fixture.fixture.operations.length, 4, 'committed images must not be reviewed again on resume')
  } finally { await fixture.cleanup() }
})

test('all damaged crops are rejected; unknown or unconditionally waived required content remains needs-review', async () => {
  for (const mode of ['all-rejected', 'unknown', 'not-applicable'] as const) {
    const fixture = await setup(mode)
    try {
      assert.equal(await createCropWorker({ domain: fixture.domain, files: fixture.files, vision: async () => fixture.provider })(fixture.context), 'source-exhausted')
      assert.equal(fixture.domain.repository.list('selection').length, 0)
      const counts = dataOf(fixture.context.current()).counts
      assert.equal(mode === 'all-rejected' ? counts.rejected : counts.needsReview, 1)
      assert.equal(counts.technicalFailed, 0)
    } finally { await fixture.cleanup() }
  }
})

test('bad visual output is a saved technical failure without aesthetic rejection', async () => {
  const fixture = await setup('invalid-output')
  try {
    assert.equal(await createCropWorker({ domain: fixture.domain, files: fixture.files, vision: async () => fixture.provider })(fixture.context), 'partial-failure')
    const failed = fixture.domain.repository.list('assessment')
    assert.equal(failed.length, 1)
    assert.equal(failed[0]?.technicalStatus, 'failed')
    assert.equal(failed[0]?.verdict, undefined)
    assert.equal(dataOf(fixture.context.current()).counts.technicalFailed, 1)
    assert.equal(dataOf(fixture.context.current()).counts.rejected, 0)
  } finally { await fixture.cleanup() }
})

test('budget exhaustion retains generated candidates and resumes without repeating committed source/proposals', async () => {
  const fixture = await setup('green-passes', 2)
  try {
    assert.equal(await createCropWorker({ domain: fixture.domain, files: fixture.files, vision: async () => fixture.provider })(fixture.context), 'budget-exhausted')
    assert.equal(fixture.fixture.operations.length, 2)
    assert.equal(dataOf(fixture.context.current()).counts.cropGenerated, 1)
    assert.equal(fixture.domain.repository.list('imageVersion').filter(image => image.versionKind === 'crop').length, 1)
    assert.equal(fixture.domain.repository.list('selection').length, 0)
    assert.equal(dataOf(fixture.context.current()).counts.pending, 1)
  } finally { await fixture.cleanup() }
})

test('cancellation after derivative commit publishes no late selection; resume reviews saved pixels once', async () => {
  const fixture = await setup()
  try {
    const dependencies = { domain: fixture.domain, files: fixture.files, vision: async () => fixture.provider }
    fixture.setAfterSave(records => { if (records.some(record => record.kind === 'imageVersion')) fixture.controller.abort() })
    await assert.rejects(createCropWorker(dependencies)(fixture.context))
    assert.equal(fixture.domain.repository.list('selection').length, 0)
    assert.equal(fixture.fixture.operations.length, 2)
    fixture.setAfterSave(undefined)
    const resumed = { ...fixture.context, signal: new AbortController().signal }
    // Test context dispatch uses the current controller supplied by the resumed execution owner.
    fixture.setSignal(resumed.signal)
    assert.equal(await createCropWorker(dependencies)(resumed), 'target-met')
    assert.equal(fixture.fixture.operations.length, 4)
  } finally { await fixture.cleanup() }
})

test('embedded crop uses the search Run and preserves its source checkpoint and counters', async () => {
  const fixture = await setup()
  try {
    await fixture.context.save('cropping', { checkpoint: { doneImageIds: ['previous-search-image'], queryCursor: 'saved-cursor' }, counts: { retrievedUnique: 9, sourceReviewed: 8 } })
    const embedded = { ...fixture.context, spec: { ...fixture.context.spec, kind: 'search' as const } }
    await createCropProcessor({ domain: fixture.domain, files: fixture.files, vision: async () => fixture.provider })(embedded, fixture.image.id, release, usage)
    const data = dataOf(fixture.context.current())
    assert.deepEqual(data.checkpoint.doneImageIds, ['previous-search-image'])
    assert.equal(data.checkpoint.queryCursor, 'saved-cursor')
    assert.equal(data.counts.retrievedUnique, 9)
    assert.equal(data.counts.sourceReviewed, 8)
    assert.equal(fixture.context.ledger.snapshot().vision, 4)
  } finally { await fixture.cleanup() }
})

test('manual completion bypasses proposals, retains warnings as human selection and does not fabricate learning feedback', async () => {
  const fixture = await setup('all-rejected')
  try {
    const manual = { ...fixture.context, spec: { ...fixture.context.spec, input: { ...fixture.context.spec.input, manualRect: { x: 0, y: 0, width: 0.5, height: 1 }, allowWarning: true, includeInLearning: true }, fixed: { ...fixture.context.spec.fixed, humanConfirmation: toJson(human) } } }
    assert.equal(await createCropWorker({ domain: fixture.domain, files: fixture.files, vision: async () => fixture.provider })(manual), 'target-met')
    assert.deepEqual(fixture.fixture.operations, ['review:source', 'review:final'])
    const selections = fixture.domain.repository.list('selection')
    assert.equal(selections[0]?.qualification, 'human-selected')
    assert.ok(selections[0]?.warnings.some(warning => warning.includes('reject')))
    assert.equal(fixture.domain.repository.list('cropCandidate')[0]?.origin, 'human')
    assert.equal(fixture.domain.repository.list('feedback').length, 0)
    assert.equal(dataOf(fixture.context.current()).counts.finalPassed, 0)
    assert.equal(dataOf(fixture.context.current()).counts.humanSelected, 1)
  } finally { await fixture.cleanup() }
})

test('invalid manual geometry and absent human confirmation fail before any vision attempt', async () => {
  const fixture = await setup()
  try {
    const worker = createCropWorker({ domain: fixture.domain, files: fixture.files, vision: async () => fixture.provider })
    const manual = { ...fixture.context, spec: { ...fixture.context.spec, input: { ...fixture.context.spec.input, manualRect: { x: 0, y: 0, width: 1.5, height: 1 } }, fixed: { ...fixture.context.spec.fixed, humanConfirmation: toJson(human) } } }
    await assert.rejects(worker(manual))
    await assert.rejects(worker({ ...manual, spec: { ...manual.spec, input: { ...manual.spec.input, manualRect: { x: 0, y: 0, width: 0.5, height: 1 } }, fixed: fixture.context.spec.fixed } }))
    assert.equal(fixture.fixture.operations.length, 0)
  } finally { await fixture.cleanup() }
})

test('a committed auxiliary visual response is replayed after a crash before the assessment checkpoint', async () => {
  const fixture = await setup()
  try {
    const dependencies = { domain: fixture.domain, files: fixture.files, vision: async () => fixture.provider }
    const interrupted: WorkContext = { ...fixture.context, request: async (kind, bundle, work) => {
      const output = await fixture.context.request(kind, bundle, work)
      const request = persistedRequestSchema.parse({ ...base, id: 'committed-before-crash', kind: 'request', runId: fixture.context.runId, state: 'committed', requestDigest: contentDigest(bundle), data: toJson({ bundle, output }) })
      await fixture.context.save('reviewing', {}, [request])
      fixture.controller.abort()
      throw new Error('Crash after auxiliary response commit')
    } }
    await assert.rejects(createCropWorker(dependencies)(interrupted))
    assert.equal(fixture.domain.repository.list('assessment').length, 0)
    assert.equal(fixture.fixture.operations.length, 1)
    fixture.setSignal(new AbortController().signal)
    assert.equal(await createCropWorker(dependencies)(fixture.context), 'target-met')
    assert.deepEqual(fixture.fixture.operations, ['review:source', 'propose-crop:', 'review:final', 'review:final'])
    assert.equal(fixture.context.ledger.snapshot().vision, 4)
  } finally { await fixture.cleanup() }
})
