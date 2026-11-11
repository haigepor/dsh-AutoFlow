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
import { styleReviewBrief } from '../src/host/review.ts'
import { resolveConfig } from '../src/host/config.ts'
import { BudgetLedger, dataOf, toJson } from '../src/host/runtime.ts'
import type { ExecutionSpec, WorkContext } from '../src/host/runtime.ts'
import { AssetFiles, CompatibleVisionProvider } from '../src/media/index.ts'
import type { HttpClient, HttpRequest, HttpResponse } from '../src/media/index.ts'
import { assetSchema, imageVersionSchema, modelProfileSchema, recipeSchema, releaseSchema, requestSchema as persistedRequestSchema, runSchema, usageSchema } from '../src/shared/model.ts'
import type { StyleStandard } from '../src/shared/model.ts'

const base = { schemaVersion: 1, profileId: 'p', createdAt: '2026-10-23T00:00:00.000Z' }
const human = { kind: 'authenticated-human', id: 'human', confirmationMethod: 'client-action', confirmedAt: base.createdAt }
const recipe = recipeSchema.parse({ ...base, id: 'recipe', kind: 'recipe', visionRevision: 'vision-revision', model: 'fixture', vendorVersion: null, promptVersion: 'v1', outputSchemaVersion: 'v1', preprocessingVersion: 'v1', referenceStrategy: { maxImages: 4, maxBytes: 1000000 }, preferenceScale: { min: 0, max: 1, weights: { color: 1, lighting: 0, texture: 0, subject: 0, composition: 0, density: 0, depth: 0 } }, unknownPolicy: 'needs-review', tieBreak: 'stable-id' })
const rules = ['source', 'final'].map(stage => ({ ruleId: `${stage}-rule`, dimension: 'subject', statement: 'Preserve the visible subject.', condition: {}, strength: 'required', stage, check: { kind: 'visual', criterion: 'Subject is intact.' }, exceptions: [], supportRefs: [], counterRefs: [], confirmation: { status: 'confirmed', actor: human } }))
const release = releaseSchema.parse({ ...base, id: 'release', kind: 'release', styleId: 'style', draftId: 'draft', draftRevision: 1, rules, references: [], recipe, contentDigest: `sha256-v1:${'a'.repeat(64)}`, releaseNumber: 1, candidateSnapshotId: 'style-candidate', changeSummary: 'Test', confirmedBy: human, validation: { status: 'provisional', evaluationIds: [], sampleCount: 0, limitations: [] } })
const usage = usageSchema.parse({ ...base, id: 'usage', kind: 'usage', presetId: 'preset', name: 'Square', revision: 1, output: { aspectP: 1, aspectQ: 1, targetWidth: 50, targetHeight: 50, acceptedFormats: ['png'], allowUpscale: false }, safeRegions: [], protectedContent: ['the required subject'] })
const messageSchema = z.object({ messages: z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional(), image_url: z.object({ url: z.string() }).optional() }))]) })) })
const promptSchema = z.object({ outputSchema: z.object({ properties: z.record(z.string(), z.json()) }), input: z.object({ operation: z.string(), stage: z.string().optional(), taskBrief: z.string(), images: z.array(z.object({ imageVersionId: z.string() })), rules: z.array(z.object({ ruleId: z.string(), stage: z.string(), dimension: z.string() })) }) })

class CropFixture implements HttpClient {
  readonly operations: string[] = []
  readonly reviewScopes: { stage?: string; requested: string[]; context: string[] }[] = []
  constructor(private readonly mode: 'green-passes' | 'all-rejected' | 'invalid-output' | 'unknown' | 'not-applicable' | 'focal-only' | 'focal-protection-failed' | 'style-context' = 'green-passes') {}
  async request(_url: string, input: HttpRequest): Promise<HttpResponse> {
    const body = messageSchema.parse(JSON.parse(Buffer.from(input.body ?? []).toString('utf8')))
    const content = body.messages.find(message => message.role === 'user')?.content
    assert.ok(Array.isArray(content))
    const descriptor = promptSchema.parse(JSON.parse(content[0]?.text ?? '{}')), prompt = descriptor.input
    this.operations.push(`${prompt.operation}:${prompt.stage ?? ''}`)
    let output: unknown
    if (prompt.operation === 'propose-crop') output = { feasibility: 'feasible', reason: 'Two distinct square compositions.', candidates: [{ requestedRect: { x: 0, y: 0, width: 0.5, height: 1 }, reason: 'Left subject.', protectedContent: 'preserved' }, { requestedRect: { x: 0.5, y: 0, width: 0.5, height: 1 }, reason: 'Right subject.', protectedContent: 'preserved' }] }
    else {
      const firstImage = content.find(part => part.type === 'image_url')?.image_url?.url
      assert.ok(firstImage)
      const pixels = await sharp(Buffer.from(firstImage.split(',')[1] ?? '', 'base64')).raw().toBuffer()
      const focal = this.mode.startsWith('focal-') || this.mode === 'style-context'
      const contextRules = this.mode === 'style-context' ? z.object({ currentStyle: z.object({ rules: promptSchema.shape.input.shape.rules }) }).parse(JSON.parse(prompt.taskBrief)).currentStyle.rules : undefined
      const reviewRules = contextRules ? [...contextRules.map(rule => ({ ...rule, stage: prompt.stage })), ...prompt.rules.filter(rule => rule.ruleId.startsWith('usage:'))] : prompt.rules
      if (contextRules) this.reviewScopes.push({ ...(prompt.stage ? { stage: prompt.stage } : {}), requested: prompt.rules.map(rule => rule.ruleId), context: contextRules.map(rule => rule.ruleId) })
      const status = focal || prompt.stage === 'source' ? 'satisfied' : this.mode === 'unknown' ? 'unknown' : this.mode === 'not-applicable' ? 'not-applicable' : this.mode === 'all-rejected' || (pixels[0] ?? 0) > (pixels[1] ?? 0) ? 'violated' : 'satisfied'
      output = { ruleResults: reviewRules.filter(rule => rule.stage === prompt.stage).map(rule => ({ ruleId: rule.ruleId, status: this.mode === 'focal-protection-failed' && prompt.stage === 'final' && rule.ruleId.startsWith('usage:') ? 'violated' : status, source: 'inferred', reason: 'Based on the transmitted image pixels.', evidenceImageVersionIds: [prompt.images[0]?.imageVersionId] })), cropPotential: 'crop-candidate', preferenceScores: (focal ? ['subject', 'color', 'lighting', 'texture', 'composition', 'density', 'depth'] : ['color']).map(dimension => ({ dimension, score: 0.9 })), taskRelevance: 'relevant', ...(descriptor.outputSchema.properties.subjectFocus ? { subjectFocus: reviewRules.filter(rule => rule.dimension === 'subject').map(rule => ({ ruleId: rule.ruleId, requirement: rule.ruleId.startsWith('usage:') ? 'presence-or-exclusion' : 'dominant', observed: prompt.stage === 'source' || (pixels[1] ?? 0) > (pixels[0] ?? 0) ? 'dominant' : 'incidental', reason: 'The actual crop pixels identify the focal fixture region.', evidenceImageVersionIds: [prompt.images[0]?.imageVersionId] })) } : {}) }
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: this.mode === 'invalid-output' ? 'invalid' : JSON.stringify(output) }, finish_reason: 'stop' }] })) }
  }
}

async function setup(mode?: ConstructorParameters<typeof CropFixture>[0], maxVisionCalls = 10, standard: StyleStandard = release, focused = false, modelViews?: { source: Buffer; maxImageBytes: number; dimension: number; outputSize: number }) {
  const directory = await mkdtemp(join(tmpdir(), 'visual-crop-'))
  const files = new AssetFiles(directory, { maxFileBytes: modelViews ? 30000000 : 1000000, maxPixels: modelViews ? 10000000 : 1000000, maxDimension: modelViews ? 6000 : 1000, previewMaxDimension: 32, maxStorageBytes: modelViews ? 100000000 : 10000000 })
  const left = await sharp({ create: { width: 100, height: 100, channels: 3, background: 'red' } }).png().toBuffer()
  const right = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#00ff00' } }).png().toBuffer()
  const bytes = modelViews?.source ?? await sharp({ create: { width: 200, height: 100, channels: 3, background: 'black' } }).composite([{ input: left, left: 0, top: 0 }, { input: right, left: 100, top: 0 }]).png().toBuffer()
  const imported = await files.importBytes(bytes)
  const asset = assetSchema.parse({ ...base, id: 'asset', kind: 'asset', familyId: 'family', source: { kind: 'local-import', description: 'Fixture' }, access: { kind: 'profile-library' }, originalBlob: imported.originalBlob, exportPermission: 'references-only', groupingStatus: 'unreviewed' })
  const image = imageVersionSchema.parse({ ...base, id: 'parent', kind: 'imageVersion', assetId: asset.id, versionKind: 'normalized', blob: imported.normalized.blob, geometry: { width: imported.normalized.width, height: imported.normalized.height, sourceOrientation: imported.normalized.sourceOrientation, colorSpace: 'srgb', processorVersion: files.processorVersion } })
  const repository = new DomainRepository('p', new MemoryDomainAdapter())
  const config = resolveConfig({ limits: { maxVisionCalls, maxCropCandidatesPerImage: 2, ...(modelViews ? { previewMaxDimension: modelViews.dimension } : {}) } })
  const outputUsage = modelViews ? { ...usage, output: { ...usage.output, targetWidth: modelViews.outputSize, targetHeight: modelViews.outputSize } } : usage
  const spec: ExecutionSpec = { kind: 'crop', config, input: { imageVersionIds: [image.id], taskBrief: 'A clear subject.' }, fixed: { release: toJson(standard), usage: toJson(outputUsage), ...(modelViews ? { cropModelViews: 'bounded-v1' } : {}), ...(focused ? { cropReviewPolicy: 'candidate-focus-v1' } : {}) }, specDigest: 'fixed-spec' }
  const ledger = new BudgetLedger(config.limits)
  const run = runSchema.parse({ ...base, id: 'run', kind: 'run', owner: { kind: 'profile' }, revision: 1, status: 'running', stage: 'cropping', spec: toJson(spec), data: { attemptId: 'attempt', attempts: 1, budget: ledger.snapshot(), checkpoint: {}, counts: {}, warnings: [], resultIds: [], requestIds: [] } })
  await repository.commit({ aggregateId: 'run:run', expectedRevision: 0, operationId: 'initial', request: {}, records: [asset, image, standard.recipe, standard, usage, run], state: {} })
  const domain = new CuratorDomain('p', repository, { verifyImage: async image => { await files.read(image.blob) } })
  const fixture = new CropFixture(mode)
  const provider = new CompatibleVisionProvider({ endpoint: 'https://vision.example.test', model: 'fixture', supportsMultiImage: true, maxImages: 10, maxImageBytes: modelViews?.maxImageBytes ?? 1000000, maxRequestBytes: 1000000, maxOutputTokens: 2000, temperature: 0 }, fixture)
  const controller = new AbortController()
  let saveCounter = 0
  let afterSave: ((records: readonly { kind: string }[]) => void) | undefined
  let currentSignal = controller.signal
  const context: WorkContext = { runId: run.id, get signal() { return currentSignal }, spec, ledger, current: () => domain.require('run', run.id),
    checkAdmission: () => currentSignal.throwIfAborted(),
    report: () => { /* 此夹具只运行搜图与裁图，不产生分析消息。 */ },
    save: async (stage, patch, records = []) => {
      context.signal.throwIfAborted()
      const current = context.current()
      const next = runSchema.parse({ ...current, revision: current.revision + 1, stage, data: toJson({ ...dataOf(current), ...patch, budget: ledger.snapshot() }) })
      await repository.commit({ aggregateId: 'run:run', expectedRevision: repository.manifest('run:run')?.revision ?? 0, operationId: `save-${++saveCounter}`, request: { next, records }, records: [next, ...records], state: {} })
      afterSave?.(records)
    },
    request: async (kind, _bundle, work) => { context.signal.throwIfAborted(); await ledger.reserve(kind); return await work(context.signal, async () => {}) },
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

test('v3 crop review rejects lost focal subjects on actual derivatives while preserving usage requirements and frozen legacy behavior', async () => {
  const dimensions = ['subject', 'color', 'lighting', 'texture', 'composition', 'density', 'depth'] as const
  const rules = dimensions.map(dimension => ({ ruleId: dimension, dimension, statement: dimension === 'subject' ? 'The subject must remain the clear visual focus.' : `Match ${dimension}.`, condition: {}, strength: 'preferred', stage: dimension === 'subject' ? 'source' : 'final', check: { kind: 'visual', criterion: 'Inspect actual pixels.' }, exceptions: [], supportRefs: [], counterRefs: [], confirmation: { status: 'suggested' } }))
  const standard = modelProfileSchema.parse({ ...base, id: 'focal-profile', kind: 'modelProfile', styleId: 'style', draftId: 'draft', draftRevision: 1, access: { kind: 'profile-library' }, analysisRunId: 'analysis', referenceDigest: `sha256-v1:${'a'.repeat(64)}`, contentDigest: `sha256-v1:${'b'.repeat(64)}`, revision: 1, model: 'fixture', matchingPrompt: 'A clear focal subject.', rules, references: [], groups: [], options: rules.map(rule => ({ rule, enabled: true, groupId: null, selectionSource: 'model', sourceStatement: rule.statement, reason: 'consistent' })), recipe: { ...recipe, promptVersion: 'visual-curator-rules-v3', styleMatching: { version: 2, minSatisfiedRatio: 0.75 }, preferenceScale: { ...recipe.preferenceScale, weights: Object.fromEntries(dimensions.map(dimension => [dimension, 1])) } } })
  for (const mode of ['focal-only', 'focal-protection-failed'] as const) {
    const f = await setup(mode, 10, standard, true)
    try {
      await createCropWorker({ domain: f.domain, files: f.files, vision: async () => f.provider })(f.context)
      const finals = f.domain.repository.list('assessment').filter(item => item.stage === 'final')
      assert.equal(finals.length, 2)
      const rejected = finals.find(item => item.ruleResults.find(rule => rule.ruleId === 'subject')?.result === 'violated')!
      assert.equal(rejected.verdict, 'reject', 'Other matching preferences cannot compensate for focal loss in actual cropped pixels')
      assert.equal(z.object({ subjectFocusVerdict: z.string(), styleMatch: z.object({ verdict: z.string() }) }).parse(rejected.data).subjectFocusVerdict, 'not-matched')
      const selected = f.domain.repository.list('selection')
      assert.equal(selected.length, mode === 'focal-only' ? 1 : 0)
      if (selected[0]) {
        const image = f.domain.require('imageVersion', selected[0].imageVersionId)
        const output = await sharp(await f.files.read(image.blob)).raw().toBuffer({ resolveWithObject: true })
        assert.equal(output.info.width, 50); assert.equal(output.info.height, 50)
        assert.deepEqual([...output.data.subarray(0, 3)], [0, 255, 0])
      }
      assert.equal(standard.rules[0]?.strength, 'preferred')
      assert.deepEqual(await f.files.read(f.image.blob), f.bytes)
    } finally { await f.cleanup() }
  }
  const finalRules = standard.rules.map(rule => ({ ...rule, stage: 'final' as const }))
  const finalOnly = modelProfileSchema.parse({ ...standard, rules: finalRules, options: standard.options.map(option => ({ ...option, rule: finalRules.find(rule => rule.ruleId === option.rule.ruleId)! })) })
  const scoped = await setup('style-context', 10, finalOnly, true)
  try {
    assert.equal(await createCropWorker({ domain: scoped.domain, files: scoped.files, vision: async () => scoped.provider })(scoped.context), 'target-met')
    assert.deepEqual(scoped.fixture.reviewScopes[0], { stage: 'source', requested: [], context: [] })
    assert.ok(scoped.fixture.reviewScopes.filter(scope => scope.stage === 'final').every(scope => scope.context.length === 7 && scope.requested.length === 8))
    assert.equal(scoped.domain.repository.list('assessment').find(assessment => assessment.stage === 'source')?.ruleResults.length, 0)
    assert.equal(scoped.domain.repository.list('selection').length, 1)
    const brief = '寻找清晰主体的汽车环境摄影，排除无关图片。'
    const input = { requestId: 'scope-metric', promptVersion: 'visual-curator-rules-v3' as const, stage: 'source' as const, rules: [], images: [{ imageVersionId: scoped.image.id, digest: scoped.image.blob.digest, mime: 'image/png', role: 'subject', bytes: scoped.bytes }] }
    const before = scoped.provider.describeRequest({ ...input, taskBrief: styleReviewBrief(finalOnly, brief) }, 'review').inputText
    const after = scoped.provider.describeRequest({ ...input, taskBrief: styleReviewBrief(finalOnly, brief, []) }, 'review').inputText
    assert.ok(after.length < before.length)
    assert.ok(Buffer.byteLength(after, 'utf8') < Buffer.byteLength(before, 'utf8'))
    console.info(JSON.stringify({ emptySourceReviewBrief: { beforeChars: before.length, afterChars: after.length, beforeBytes: Buffer.byteLength(before, 'utf8'), afterBytes: Buffer.byteLength(after, 'utf8') } }))
  } finally { await scoped.cleanup() }
  const oldScope = await setup('style-context', 10, finalOnly)
  try {
    assert.equal(await createCropWorker({ domain: oldScope.domain, files: oldScope.files, vision: async () => oldScope.provider })(oldScope.context), 'partial-failure')
    assert.equal(oldScope.fixture.reviewScopes[0]?.requested.length, 0)
    assert.equal(oldScope.fixture.reviewScopes[0]?.context.length, 7)
    assert.equal(oldScope.domain.repository.list('selection').length, 0, 'Extra model-generated rules remain a technical failure under the strict decoder')
  } finally { await oldScope.cleanup() }
  const legacy = await setup('focal-only', 10, standard)
  try {
    await createCropWorker({ domain: legacy.domain, files: legacy.files, vision: async () => legacy.provider })(legacy.context)
    assert.ok(legacy.domain.repository.list('assessment').every(assessment => !Object.hasOwn(z.record(z.string(), z.json()).parse(assessment.data), 'subjectFocus')))
    assert.equal(legacy.domain.repository.list('selection').length, 1)
  } finally { await legacy.cleanup() }
})

test('bounded crop model views fit a small route while full-size PNG pixels determine 1000px output', async () => {
  const width = 2000, height = 1000, raw = Buffer.alloc(width * height * 3)
  let state = 20261107
  for (let index = 0; index < raw.length; index++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; raw[index] = state & 255 }
  const source = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer()
  const maxImageBytes = 200000, dimension = 128
  assert.ok(source.length > maxImageBytes)
  const f = await setup('focal-only', 10, release, false, { source, maxImageBytes, dimension, outputSize: 1000 })
  const representations: { sourceWidth: number; sourceHeight: number; viewWidth: number; viewHeight: number }[][] = []
  const describe = f.provider.describeRequest.bind(f.provider)
  f.provider.describeRequest = (input, operation) => {
    assert.ok(input.images.every(image => image.bytes && image.bytes.length < maxImageBytes))
    assert.ok(input.images.every(image => image.storedImage))
    representations.push(z.object({ imageRepresentations: z.array(z.object({ sourceWidth: z.number(), sourceHeight: z.number(), viewWidth: z.number(), viewHeight: z.number() })) }).parse(input.usage).imageRepresentations)
    return describe(input, operation)
  }
  try {
    assert.equal(await createCropWorker({ domain: f.domain, files: f.files, vision: async () => f.provider })(f.context), 'target-met', JSON.stringify({ operations: f.fixture.operations, geometry: f.image.geometry, warnings: dataOf(f.context.current()).warnings, candidates: f.domain.repository.list('cropCandidate').map(candidate => ({ geometryResult: candidate.geometryResult })) }))
    assert.deepEqual(f.fixture.operations, ['review:source', 'propose-crop:', 'review:final', 'review:final'])
    assert.ok(representations.every(rows => rows.every(row => Math.max(row.viewWidth, row.viewHeight) <= dimension)))
    assert.deepEqual(representations[0]?.map(row => [row.sourceWidth, row.sourceHeight]), [[width, height]])
    assert.ok(representations.filter(rows => rows.length === 2).every(rows => rows[0]?.sourceWidth === 1000 && rows[0]?.sourceHeight === 1000 && rows[1]?.sourceWidth === width))
    const selection = f.domain.repository.list('selection')[0]!, image = f.domain.require('imageVersion', selection.imageVersionId)
    const output = await sharp(await f.files.read(image.blob)).raw().toBuffer({ resolveWithObject: true })
    assert.equal(output.info.width, 1000); assert.equal(output.info.height, 1000)
    const left = await sharp(source).extract({ left: 0, top: 0, width: 1000, height: 1000 }).raw().toBuffer()
    const right = await sharp(source).extract({ left: 1000, top: 0, width: 1000, height: 1000 }).raw().toBuffer()
    assert.ok(output.data.equals(left) || output.data.equals(right), 'The delivered image uses exact full-resolution pixels, not resized model-view pixels')
    assert.deepEqual(await f.files.read(f.image.blob), source)
    assert.equal(f.domain.require('imageVersion', f.image.id).geometry.width, width)
  } finally { await f.cleanup() }
})
