/** Isolated Host workflows bind source-preserving files to an independent final review. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import sharp from 'sharp'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import LlmRuntime, { type ImageGenerationRequest, type ImageGenerationTask, type ImageGenerationTaskId } from '@deepseek-ai/dsh-llm'
import LocalAttachmentStore from '../../../../packages/attachment/attachment-local/src/index.ts'
import { contentDigest } from '../src/domain/repository.ts'
import { dataOf, specOf, toJson } from '../src/host/runtime.ts'
import { runSchema } from '../src/shared/model.ts'
import { backgroundResolutionSettingsSchema } from '../src/shared/background-resolution.ts'
import { resolveWallpaperProcessing, wallpaperRepairPolicySchema } from '../src/shared/wallpaper-policy.ts'
import { completeCanvasWallpaperPrompts } from '../src/shared/wallpaper-prompts.ts'
import { wallpaperSettingsSchema, wallpaperStateSchema, wallpaperStoredSourceReviewV4Schema, wallpaperPlanSchema, wallpaperGenerationInputSchema, type WallpaperState } from '../src/shared/wallpaper.ts'
import { serviceFixture } from './helpers/service-fixture.ts'

const receipt = z.object({ runId: z.string() })
const subjectRect = { x: 0.2, y: 0.3, width: 0.6, height: 0.6 }
const sourceFocus = { x: 0.35, y: 0.35, width: 0.3, height: 0.3 }
const defaultSubjectFill = { version: 'source-intent-v2', minimumSubjectScaleRatio: 0.9, alignment: 'subject-fill-v1', fill: { safeOccupancy: 0.86, minimumRetainedAxis: 0.4, maximumCenterDrift: 0.08, relativeLayout: { minimumRelativeScaleRatio: 0.8, minimumWholeAspectRatio: 0.65 } } }
type ReviewResult = 'pass' | 'unknown' | 'legacy-response' | 'layout-correction' | 'invalid-replan' | 'layout-retry'

async function sourceWorkflow(t: TestContext, result: ReviewResult = 'pass', uncertainSource = false, historical = false) {
  let exportDirectory = ''
  const legacyPlacement = result === 'layout-correction' || result === 'invalid-replan'
  const actionPart = result === 'layout-retry' ? { entityId: 'award', name: 'Held award', rect: { x: 0.6, y: 0.56, width: 0.08, height: 0.1 } } : undefined
  const f = await serviceFixture(undefined, {}, { pickLocalPaths: async kind => kind === 'folder' ? [exportDirectory] : null })
  const context = new Context(), llm = new LlmRuntime(context), attachments = new LocalAttachmentStore(context, { dshHome: f.root })
  const startJob = f.jobs.start
  let historicalJob: Parameters<typeof f.jobs.start>[0] | undefined
  if (historical || legacyPlacement) f.jobs.start = spec => { historicalJob = spec; return brandString<JobId>('isolated-held-historical-job') }
  t.after(async () => { try { await f.cleanup() } finally { await context.fiber.dispose() } })
  f.host.llm = llm; f.host.attachments = attachments
  f.service.config.wallpaper.processing = resolveWallpaperProcessing()
  f.service.config.wallpaper.repairPolicy = wallpaperRepairPolicySchema.parse({})
  f.service.config.wallpaper.imageProvider = 'isolated-source-intent'
  f.service.config.wallpaper.imageModel = 'isolated-background'
  f.service.config.wallpaper.decision = { version: 'wallpaper-decision-v1', enabled: false, maxRoundsPerImage: 2, maxDetailRequests: 1 }
  f.service.config.wallpaper.clarity = { ...f.service.config.wallpaper.clarity!, enabled: false }
  f.service.config.wallpaper.backgroundResolution = { ...f.service.config.wallpaper.backgroundResolution!, enabled: false }
  exportDirectory = join(f.root, 'exports'); await mkdir(exportDirectory)
  const source = await sharp({ create: { width: 400, height: 640, channels: 3, background: '#314f66' } }).composite([
    { input: await sharp({ create: { width: 180, height: 240, channels: 3, background: '#d5b389' } }).png().toBuffer(), left: 110, top: 200 },
    { input: await sharp({ create: { width: 200, height: 100, channels: 3, background: '#30241a' } }).png().toBuffer(), left: 100, top: 430 },
  ]).resize(historical ? 1000 : 400, historical ? 1600 : 640).png().toBuffer()
  const path = join(f.root, 'synthetic-partial-portrait.png'); await writeFile(path, source)
  const requests: ImageGenerationRequest[] = [], tasks = new Map<string, ImageGenerationTask>(), reviews: { id: string; requestId: string; protocol: string; roles: string[]; guideId?: string }[] = []
  const generated = await sharp({ create: { width: 1845, height: 3280, channels: 3, background: '#df3158' } }).png().toBuffer()
  let runId = '', plans = 0
  const replanFields: string[][] = [], frozenPlans: Omit<z.infer<typeof wallpaperPlanSchema>, 'placement' | 'editPrompt'>[] = []
  const state = (id = runId) => wallpaperStateSchema.parse(dataOf(f.domain.require('run', id)).checkpoint.wallpaper)
  llm.getImageGeneration = async handle => {
    const task = tasks.get(handle.id)
    if (!task) throw Object.assign(new Error('No isolated receipt.'), { code: 'IMAGE_GENERATION_NOT_FOUND' })
    return task
  }
  llm.startImageGeneration = async request => {
    requests.push(request)
    const moving = result === 'layout-correction' || result === 'invalid-replan' || result === 'layout-retry'
    const background = result === 'layout-retry' ? '#456b55' : '#314f66'
    const pixels = moving ? await sharp(Buffer.from(`<svg width="1845" height="3280"><rect width="1845" height="3280" fill="${background}"/><rect x="553" y="${requests.length === 1 ? 328 : 1246}" width="553" height="1312" fill="#d5b389"/></svg>`)).png().toBuffer() : generated
    const original = await attachments.saveFile({ data: pixels, name: 'synthetic-provider-canvas.png' })
    const [preview] = await attachments.saveImages([{ data: pixels, mediaType: 'image/png' }]); assert.ok(preview)
    const task: ImageGenerationTask = { id: request.id, provider: request.provider, model: request.model, taskId: brandString<ImageGenerationTaskId>('isolated-source-task'), state: 'succeeded', images: [{ original, preview }] }
    tasks.set(request.id, task)
    return task
  }
  const send = f.http.request.bind(f.http)
  f.http.request = async (url, request) => {
    if (!url.startsWith('https://vision.example.test')) return send(url, request)
    const messages = z.object({ messages: z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ text: z.string().optional() }).passthrough())]) })) }).parse(JSON.parse(Buffer.from(request.body!).toString('utf8'))).messages
    const content = messages.find(message => message.role === 'user')?.content; assert.ok(Array.isArray(content))
    const descriptor = z.object({ input: z.object({ operation: z.string(), requestId: z.string(), usage: z.unknown().optional(), images: z.array(z.object({ imageVersionId: z.string(), role: z.string() })) }), outputSchema: z.json() }).parse(JSON.parse(content[0]!.text!))
    const input = descriptor.input, original = input.images.find(image => image.role === 'wallpaper-original'); assert.ok(original)
    let output: object
    if (input.operation === 'wallpaper-plan') {
      plans++
      const fields = Object.keys(z.object({ properties: z.record(z.string(), z.unknown()) }).parse(descriptor.outputSchema).properties).sort()
      if (fields.join(',') === 'editPrompt,imageVersionId,reason') {
        replanFields.push(fields)
        const frozen = z.object({ frozenSourcePlan: wallpaperPlanSchema.omit({ placement: true, editPrompt: true }).strict() }).parse(input.usage).frozenSourcePlan
        frozenPlans.push(frozen)
        output = { imageVersionId: original.imageVersionId, editPrompt: 'Move the entire group down to the Host target layout while retaining the original cropped upper body, smile, glasses, clothing and lectern occlusion.', reason: 'Correct only the observed top overflow; retain the frozen source facts.', ...(result === 'invalid-replan' ? { objectRoles: [] } : {}) }
      } else output = { version: 1, imageVersionId: original.imageVersionId, mode: 'single', subject: 'Synthetic half-length portrait behind a lectern', evidence: 'The fixture records a visible upper body and the original foreground occlusion.',
        ...(historical ? {} : { sourceMedium: 'photograph', ...(legacyPlacement ? {} : { actionPartIds: actionPart ? [actionPart.entityId] : [] }) }), priorities: ['Keep the original smile and glasses.'], anchors: ['Continue the same dark blue stage.'], truncations: [], uncertainties: [],
        objectRoles: [{ entityId: 'portrait', name: 'Portrait', role: 'primary', safetyClass: 'general', evidence: 'This is the single focal subject.', rect: subjectRect, sourceEdges: [], ...(historical ? {} : { sourceIntent: { framing: uncertainSource ? 'uncertain' : 'partial', visibility: 'occluded', preserve: ['Keep the original smile, glasses and clothing.'], relationships: ['The original lectern occludes the lower body.'], ...(uncertainSource ? {} : { layoutFocus: sourceFocus }) } }) },
          ...(actionPart ? [{ ...actionPart, role: 'critical-part', evidence: 'The subject holds the visible award.', sourceEdges: [], sourceIntent: { framing: 'whole', visibility: 'visible', preserve: ['Keep the visible award.'], relationships: ['The award remains in the subject’s hand.'] } }] : [])],
        regions: [{ entityId: 'portrait', name: 'Portrait', role: 'subject', rect: subjectRect }, ...(actionPart ? [{ ...actionPart, role: 'critical' }] : [])], reason: 'Retain the source view and keep its focal upper body prominent.', editPrompt: 'Extend only the dark blue stage; keep the upper-body framing and do not reveal legs.' }
    } else {
      assert.equal(input.operation, 'wallpaper-review')
      const actual = input.images.find(image => image.role === 'actual-wallpaper'); assert.ok(actual)
      const protocol = historical ? 'practical-v1' : 'practical-v2'
      assert.ok(JSON.stringify(descriptor.outputSchema).includes(protocol), 'The actual final request retains the task-frozen preservation protocol')
      const guide = input.images.find(image => image.role === 'wallpaper-layout-only')
      reviews.push({ id: actual.imageVersionId, requestId: input.requestId, protocol, roles: input.images.map(image => image.role), ...(guide ? { guideId: guide.imageVersionId } : {}) })
      const currentRun = f.repository.list('run').find(row => input.requestId.startsWith(row.id + ':')); assert.ok(currentRun)
      const attempt = state(currentRun.id).items[0]?.attempts.at(-1); assert.ok(attempt)
      const sourceImage = f.domain.require('imageVersion', original.imageVersionId), settings = wallpaperSettingsSchema.parse(specOf(currentRun).fixed.wallpaper)
      const positioned = (rect: typeof subjectRect) => ({ x: (attempt.plan.placement.left + rect.x * sourceImage.geometry.width * attempt.plan.placement.scale) / settings.width, y: (attempt.plan.placement.top + rect.y * sourceImage.geometry.height * attempt.plan.placement.scale) / settings.height, width: rect.width * sourceImage.geometry.width * attempt.plan.placement.scale / settings.width, height: rect.height * sourceImage.geometry.height * attempt.plan.placement.scale / settings.height })
      const moving = result === 'layout-correction' || result === 'invalid-replan'
      const measured = (rect: typeof subjectRect) => result === 'layout-retry' && requests.length === 1 ? { ...positioned(rect), y: rect === subjectRect ? 0.1 : 0.15 } : moving ? rect === subjectRect ? { x: 0.3, y: requests.length === 1 ? 0.1 : 0.38, width: 0.3, height: 0.4 } : { x: 0.35, y: requests.length === 1 ? 0.15 : 0.45, width: 0.2, height: 0.2 } : positioned(rect)
      const satisfied = { result: 'satisfied', reason: 'The independently scripted final finding retains this source property.' }
      output = { reviewVersion: 'wallpaper-review-source-v4', protocol: historical || result === 'legacy-response' ? 'practical-v1' : 'practical-v2', sourceImageVersionId: original.imageVersionId, outputImageVersionId: actual.imageVersionId, mode: 'single', subject: 'Synthetic half-length portrait',
        actualLayout: { regions: [{ entityId: 'portrait', name: 'Portrait', role: 'subject', scope: 'core', rect: measured(subjectRect), ...(historical || result === 'legacy-response' ? {} : { layoutFocus: measured(sourceFocus) }) },
          ...(actionPart ? [{ ...actionPart, role: 'critical', scope: 'core', rect: positioned(actionPart.rect) }] : [])] }, defects: [], uncertainties: [],
        ...(historical || result === 'legacy-response' ? {} : { sourcePreservation: [{ entityId: 'portrait', framing: satisfied, appearance: result === 'unknown' ? { result: 'unknown', reason: 'The final eye detail cannot be established from the isolated observation.' } : satisfied, relationships: satisfied },
          ...(actionPart ? [{ entityId: actionPart.entityId, framing: satisfied, appearance: satisfied, relationships: satisfied }] : [])], sourceStyle: satisfied }) }
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] })) }
  }
  await f.service.initialize()
  const start = async () => {
    runId = receipt.parse(await f.action('direct-crop-start', { operationId: 'source-intent-isolated', name: 'Isolated source-intent batch', source: { kind: 'local', files: [{ path, name: 'synthetic-partial-portrait.png' }] } })).runId
    if (historical || legacyPlacement) {
      const run = f.domain.require('run', runId), spec = specOf(run), settings = wallpaperSettingsSchema.parse(spec.fixed.wallpaper)
      if (historical) delete settings.sourceIntentPolicy
      else settings.sourceIntentPolicy = { version: 'source-intent-v1', minimumSubjectScaleRatio: 0.9 }
      const prompts = completeCanvasWallpaperPrompts(settings, !historical), fixed = { ...spec.fixed, wallpaper: toJson(settings), prompts: toJson(prompts), promptDigest: contentDigest(prompts) }
      const record = runSchema.parse({ ...run, spec: toJson({ ...spec, fixed, specDigest: contentDigest({ kind: spec.kind, config: spec.config, input: spec.input, fixed }) }) })
      const aggregateId = 'run:' + runId, manifest = f.repository.manifest(aggregateId); assert.ok(manifest)
      await f.repository.commit({ aggregateId, expectedRevision: manifest.revision, operationId: 'record-isolated-historical-policy', request: { sourceIntentPolicy: 'absent' }, records: [record], state: { runId } })
      assert.ok(historicalJob)
      f.jobs.start = startJob; startJob(historicalJob)
    }
    await f.jobs.drain()
    return runId
  }
  const replaceState = async (next: WallpaperState) => {
    const run = f.domain.require('run', runId), data = dataOf(run), aggregateId = 'run:' + runId, manifest = f.repository.manifest(aggregateId); assert.ok(manifest)
    const record = runSchema.parse({ ...run, data: toJson({ ...data, checkpoint: { ...data.checkpoint, wallpaper: toJson(next) } }) })
    await f.repository.commit({ aggregateId, expectedRevision: manifest.revision, operationId: 'isolated-tamper-' + manifest.revision, request: {}, records: [record], state: { runId } })
  }
  const diagnostics = (id = runId) => JSON.stringify({ items: state(id).items.map(item => ({ status: item.status, reason: item.reason, errorCode: item.errorCode, failedStep: item.failedStep, checks: item.attempts.map(attempt => attempt.checks) })), requests: f.repository.list('request').map(row => ({ state: row.state, diagnostics: z.object({ diagnostics: z.unknown().optional() }).parse(row.data).diagnostics })) })
  return { f, start, state, requests, generated, reviews, source, replanFields, frozenPlans, plans: () => plans, attachments, replaceState, diagnostics }
}

test('a new batch sends a positioned master, original and safety guide and adopts the entire provider canvas', async t => {
  const w = await sourceWorkflow(t), runId = await w.start(), item = w.state().items[0]; assert.ok(item)
  assert.equal(item.status, 'passed', w.diagnostics())
  const attempt = item.attempts.at(-1); assert.ok(attempt?.outputId && attempt.canvasId)
  const settings = wallpaperSettingsSchema.parse(specOf(w.f.domain.require('run', runId)).fixed.wallpaper)
  assert.deepEqual(settings.sourceIntentPolicy, defaultSubjectFill)
  assert.equal(attempt.compositionMode, 'generated-canvas-v1'); assert.equal(attempt.sourceIntentProof, undefined)
  assert.equal(attempt.generationInput?.version, 'wallpaper-edit-input-v6')
  assert.deepEqual(attempt.generationInput.references.map(reference => reference.role), ['canvas', 'original', 'layout-only'])
  assert.equal(w.requests.length, 1); assert.equal(w.plans(), 1); assert.equal(w.reviews.length, 1)
  const request = w.requests[0]; assert.ok(request)
  assert.ok(request.mask)
  assert.equal(request.mask.attachmentId, attempt.generationInput.mask.attachmentId)
  assert.ok(attempt.plan.editPrompt && !request.prompt.includes(attempt.plan.editPrompt))
  assert.doesNotMatch(request.prompt, /"preserve"|"relationships"|desiredSourceTransform|desiredRegions/)
  assert.ok(request.prompt.length < 1000)
  assert.match(request.prompt, /不补造画外身体/)
  assert.equal(request.prompt.includes('必须拉远镜头'), false)
  assert.equal(request.references.length, 3)
  assert.match(request.prompt, /图1.*主画布/)
  assert.match(request.prompt, /图1已有画面的外框约在成品横向/)
  assert.match(request.prompt, /图2.*完整原图/)
  assert.match(request.prompt, /图3.*安全区规划图/)
  const reference = request.references[1]; assert.ok(reference)
  assert.deepEqual({ width: reference.width, height: reference.height }, { width: 400, height: 640 })
  const canvas = w.f.domain.require('imageVersion', attempt.canvasId)
  assert.deepEqual({ width: canvas.geometry.width, height: canvas.geometry.height }, { width: settings.width, height: settings.height })
  const master = request.references[0], guideReference = request.references[2]; assert.ok(master && guideReference)
  assert.deepEqual({ width: master.width, height: master.height }, { width: guideReference.width, height: guideReference.height })
  assert.ok(Math.abs(master.height - master.width * settings.height / settings.width) <= 1, 'Attachment admission may uniformly normalize both references but cannot change the target field of view')
  const canvasBytes = await w.f.files.read(canvas.blob)
  const sourcePatch = await sharp(canvasBytes).extract({ left: Math.round(attempt.plan.placement.left + 200 * attempt.plan.placement.scale), top: Math.round(attempt.plan.placement.top + 300 * attempt.plan.placement.scale), width: 1, height: 1 }).removeAlpha().raw().toBuffer()
  assert.deepEqual([...sourcePatch], [213, 179, 137], 'The enlarged unmarked reference retains the known portrait patch at the planned position')
  assert.ok(attempt.plan.placement.scale > 1)
  assert.ok(attempt.layoutAnalysisId)
  const guide = w.f.domain.require('imageVersion', attempt.layoutAnalysisId)
  const guideBytes = await w.f.files.read(guide.blob)
  const border = await sharp(guideBytes).extract({ left: settings.safe.left, top: 100, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
  assert.deepEqual([...border], [50, 216, 232], 'The separate guide includes the actual cyan safety boundary')
  const output = w.f.domain.require('imageVersion', attempt.outputId)
  assert.deepEqual(await sharp(await w.f.files.read(output.blob)).raw().toBuffer(), await sharp(w.generated).raw().toBuffer(), 'Even source-covered positions must contain provider pixels; this transport test does not assess visual quality')
  const exported = z.object({ files: z.number(), directory: z.string() }).parse(await w.f.action('direct-crop-export', { runId, title: 'Export isolated complete canvas' }))
  assert.equal(exported.files, 1)
  const manifest = z.object({ files: z.array(z.object({ name: z.string(), outputDigest: z.string(), review: z.object({ practicalReview: z.object({ version: z.string() }) }) })) }).parse(JSON.parse(await readFile(join(exported.directory, 'manifest.json'), 'utf8')))
  const row = manifest.files[0]; assert.ok(row)
  assert.equal(row.outputDigest, output.blob.digest); assert.equal(row.review.practicalReview.version, 'practical-v2')
  assert.deepEqual(await readFile(join(exported.directory, row.name)), await w.f.files.read(output.blob))
})

test('unknown final preservation retains the saved output without another generation or export qualification', async t => {
  const w = await sourceWorkflow(t, 'unknown'), runId = await w.start(), item = w.state().items[0]; assert.ok(item)
  assert.equal(item.status, 'needs-review', w.diagnostics())
  assert.equal(w.requests.length, 1); assert.equal(w.reviews.length, 1); assert.equal(w.plans(), 1)
  assert.ok(item.attempts.at(-1)?.outputId); assert.equal(item.attempts.at(-1)?.sourceIntentProof, undefined)
  assert.equal(w.f.repository.list('selection').length, 0)
  await assert.rejects(w.f.action('direct-crop-export', { runId, title: 'Unknown is not approved' }), /no independently approved/)
})

test('a V2 layout deviation measures the actual candidate before retrying the same positioned master and mask', async t => {
  const w = await sourceWorkflow(t, 'layout-retry'); await w.start()
  const item = w.state().items[0]; assert.ok(item)
  assert.equal(item.status, 'passed', w.diagnostics())
  assert.equal(w.requests.length, 2); assert.equal(w.plans(), 1); assert.equal(w.replanFields.length, 0)
  const first = item.attempts[0], last = item.attempts.at(-1); assert.ok(first?.generationInput && last?.generationInput)
  assert.ok(first.outputId && first.layoutAnalysisId)
  assert.equal(w.reviews[0]?.guideId, first.layoutAnalysisId, 'The independent first review compares the planned guide when the portrait carries an action part')
  const confirmation = w.reviews.find(review => review.requestId.endsWith(':layout-confirm'))
  assert.ok(confirmation?.guideId)
  assert.equal(confirmation.id, first.outputId)
  assert.notEqual(confirmation.guideId, first.layoutAnalysisId)
  const guide = w.f.domain.require('imageVersion', confirmation.guideId)
  const unmarkedPixel = await sharp(await w.f.files.read(guide.blob)).extract({ left: 40, top: 2000, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
  assert.deepEqual([...unmarkedPixel], [69, 107, 85], 'The same-output guide shows provider pixels at the unannotated location')
  assert.equal(first.generationInput.version, 'wallpaper-edit-input-v6')
  assert.equal(last.generationInput.version, 'wallpaper-edit-input-v6')
  assert.deepEqual(last.plan, first.plan)
  assert.deepEqual(last.generationInput.references, first.generationInput.references)
  assert.deepEqual(last.generationInput.mask, first.generationInput.mask)
  assert.match(last.generationInput.prompt, /位置与大小统一恢复到图1/)
})

test('manual plan admission accepts the saved V2 enlarged reference without changing its parent history', async t => {
  const w = await sourceWorkflow(t), runId = await w.start(), item = w.state().items[0], attempt = item?.attempts.at(-1)
  assert.ok(item && attempt && attempt.plan.placement.scale > 1)
  const parentDigest = contentDigest(w.f.domain.require('run', runId))
  w.f.jobs.start = () => brandString<JobId>('isolated-held-manual-plan')
  const next = receipt.parse(await w.f.action('wallpaper-plan-update', { runId, imageVersionId: item.imageVersionId, plan: toJson(attempt.plan), operationId: 'same-enlarged-reference' }))
  assert.notEqual(next.runId, runId)
  assert.equal(contentDigest(w.f.domain.require('run', runId)), parentDigest)
  const initial = wallpaperStateSchema.parse(specOf(w.f.domain.require('run', next.runId)).fixed.initialWallpaperState)
  assert.equal(initial.items[0]?.attempts.at(-1)?.plan.placement.scale, attempt.plan.placement.scale)
})

test('the new final-review request rejects a legacy empty-defect response without regenerating', async t => {
  const w = await sourceWorkflow(t, 'legacy-response'), runId = await w.start(), item = w.state().items[0]; assert.ok(item)
  assert.equal(item.status, 'technical-failed', w.diagnostics())
  assert.equal(item.errorCode, 'vision-invalid-output'); assert.equal(item.failedStep, 'reviewing')
  assert.equal(w.requests.length, 1); assert.equal(w.reviews.length, 1)
  assert.ok(item.attempts.at(-1)?.outputId); assert.equal(item.attempts.at(-1)?.sourceIntentProof, undefined)
  assert.equal(w.f.repository.list('selection').length, 0)
  await assert.rejects(w.f.action('direct-crop-export', { runId, title: 'Legacy response is not current evidence' }), /no independently approved/)
})

test('uncertain original framing stops before the image provider is called', async t => {
  const w = await sourceWorkflow(t, 'pass', true); await w.start()
  const item = w.state().items[0]; assert.ok(item)
  assert.equal(item.status, 'needs-review', w.diagnostics())
  assert.equal(item.reason, 'source-intent-unconfirmed')
  assert.equal(w.plans(), 1); assert.equal(w.requests.length, 0); assert.equal(w.reviews.length, 0)
  assert.equal(w.f.repository.list('selection').length, 0)
})

test('a frozen historical task without source intent retains its original full-canvas generation and compact protocol', async t => {
  const w = await sourceWorkflow(t, 'pass', false, true), runId = await w.start(), item = w.state().items[0]; assert.ok(item)
  assert.equal(item.status, 'passed', w.diagnostics())
  const settings = wallpaperSettingsSchema.parse(specOf(w.f.domain.require('run', runId)).fixed.wallpaper), attempt = item.attempts.at(-1); assert.ok(attempt?.outputId)
  assert.equal(settings.sourceIntentPolicy, undefined)
  assert.equal(attempt.compositionMode, 'generated-canvas-v1'); assert.equal(attempt.sourceIntentProof, undefined)
  assert.equal(attempt.plan.sourceMedium, undefined); assert.equal(attempt.plan.objectRoles?.[0]?.sourceIntent, undefined)
  assert.equal(w.requests.length, 1); assert.equal(w.requests[0]?.mask, undefined)
  assert.equal(w.reviews[0]?.protocol, 'practical-v1')
  assert.equal(wallpaperStoredSourceReviewV4Schema.parse(attempt.review).practicalReview?.sourcePreservation, undefined)
  assert.deepEqual(await sharp(await w.f.files.read(w.f.domain.require('imageVersion', attempt.outputId).blob)).raw().toBuffer(), await sharp(w.generated).raw().toBuffer())
})

test('complete-canvas reprocessing reuses its full-reference receipt and retains source intent and final V2 review', async t => {
  const w = await sourceWorkflow(t), parentId = await w.start(), original = w.state().items[0]; assert.ok(original)
  assert.equal(original.status, 'passed', w.diagnostics())
  const prior = original.attempts.at(-1); assert.ok(prior?.generation && prior.outputId)
  const parentDigest = contentDigest(w.f.domain.require('run', parentId)), reviewCount = w.reviews.length
  w.f.service.config.wallpaper.backgroundResolution = backgroundResolutionSettingsSchema.parse({ version: 'espcn-background-v1' })
  const request = { runId: parentId, operationId: 'reprocess-preserved-background', recompose: { imageVersionId: original.imageVersionId, revision: prior.revision, mode: 'generated-canvas-v1', reviewPolicy: 'current', backgroundResolution: 'current' } }
  const childId = receipt.parse(await w.f.action('wallpaper-continue', request)).runId
  await w.f.jobs.drain()
  const childRun = w.f.domain.require('run', childId), child = w.state(childId).items[0]; assert.ok(child)
  assert.equal(child.status, 'passed', w.diagnostics(childId))
  const latest = child.attempts.at(-1); assert.ok(latest?.outputId)
  const settings = wallpaperSettingsSchema.parse(specOf(childRun).fixed.wallpaper), output = w.f.domain.require('imageVersion', latest.outputId)
  assert.deepEqual(settings.sourceIntentPolicy, defaultSubjectFill)
  assert.equal(latest.compositionMode, 'generated-canvas-v1')
  assert.deepEqual(latest.generation, prior.generation); assert.deepEqual(latest.generationInput, prior.generationInput)
  assert.equal(w.requests.length, 1, 'Reprocessing must retrieve the saved provider receipt without another generation')
  assert.equal(child.edits, original.edits); assert.equal(w.plans(), 1)
  assert.ok(w.reviews.length > reviewCount)
  assert.equal(w.reviews.at(-1)?.id, output.id)
  assert.ok(w.reviews.slice(reviewCount).every(review => review.protocol === 'practical-v2'))
  assert.equal(wallpaperStoredSourceReviewV4Schema.parse(latest.postResolutionReview?.review ?? latest.review).practicalReview?.version, 'practical-v2')
  assert.equal(latest.sourceIntentProof, undefined)
  assert.equal(contentDigest(w.f.domain.require('run', parentId)), parentDigest)
  const exported = z.object({ files: z.number() }).parse(await w.f.action('direct-crop-export', { runId: childId, title: 'Export reprocessed source-intent result' }))
  assert.equal(exported.files, 1)
})

test('a saved V4 single-original receipt remains unchanged when resumed by the three-reference implementation', async t => {
  const w = await sourceWorkflow(t), runId = await w.start(), saved = w.state(), item = saved.items[0], prior = item?.attempts.at(-1)
  assert.ok(item?.originalId && prior?.generationInput)
  const original = prior.generationInput.references.find(reference => reference.role === 'original'); assert.ok(original)
  prior.generationInput = wallpaperGenerationInputSchema.parse({ version: 'wallpaper-edit-input-v4', prompt: 'Historical single-original complete-canvas request.', references: [{ ...original, role: 'canvas' }] })
  prior.canvasId = item.originalId
  const frozen = structuredClone(prior.generationInput)
  await w.replaceState(saved)
  const parentDigest = contentDigest(w.f.domain.require('run', runId))
  const childId = receipt.parse(await w.f.action('wallpaper-continue', { runId, operationId: 'resume-legacy-v4-reference', recompose: { imageVersionId: item.imageVersionId, revision: prior.revision, mode: 'generated-canvas-v1', reviewPolicy: 'current' } })).runId
  await w.f.jobs.drain()
  const current = w.state(childId).items[0]; assert.ok(current)
  assert.equal(current.status, 'passed', w.diagnostics(childId))
  assert.deepEqual(current.attempts.at(-1)?.generationInput, frozen)
  assert.equal(current.edits, item.edits); assert.equal(w.requests.length, 1)
  assert.equal(contentDigest(w.f.domain.require('run', runId)), parentDigest)
})

test('retired restoration receipts cannot be relabeled, recomposed or exported while historical records remain unchanged', async t => {
  const w = await sourceWorkflow(t), runId = await w.start(), saved = w.state(), item = saved.items[0], attempt = item?.attempts.at(-1)
  assert.ok(item && attempt?.outputId && attempt.generationInput)
  for (const mode of ['source-intent-background-v1', 'generated-canvas-protected-v2', 'generated-canvas-v1'] as const) {
    const history = structuredClone(saved), pasted = history.items[0]?.attempts.at(-1); assert.ok(pasted)
    pasted.compositionMode = mode
    pasted.sourceIntentProof = { version: 'source-intent-pixels-v1', sourceDigest: 'historical-source', outputDigest: 'historical-pasted', comparedPixels: 100, changedPixels: 0, sourceRect: { left: 0, top: 0, width: 10, height: 10 } }
    await w.replaceState(history)
    const unchanged = contentDigest(w.f.domain.require('run', runId))
    const listing = z.object({ batches: z.array(z.object({ runId: z.string(), wallpaper: z.object({ passed: z.number() }) })) }).parse(await w.f.action('direct-crop-list', {}))
    assert.equal(listing.batches.find(batch => batch.runId === runId)?.wallpaper.passed, 0)
    await assert.rejects(w.f.action('direct-crop-export', { runId, title: 'Reject pasted output' }), /no independently approved|complete generated canvas/)
    await assert.rejects(w.f.action('wallpaper-continue', { runId, operationId: 'reject-retag-' + mode, recompose: { imageVersionId: item.imageVersionId, revision: attempt.revision, mode: 'generated-canvas-v1', reviewPolicy: 'current' } }), /pixel overlays are disabled/)
    assert.equal(contentDigest(w.f.domain.require('run', runId)), unchanged)
  }
  assert.equal(w.requests.length, 1, 'Blocking historical recompose must not dispatch a replacement image')
})

test('layout correction carries frozen source facts in the Host and sends only editing fields to the replanner', async t => {
  const w = await sourceWorkflow(t, 'layout-correction'); await w.start()
  const item = w.state().items[0]; assert.ok(item)
  assert.equal(item.status, 'passed', w.diagnostics())
  assert.equal(w.requests.length, 2); assert.equal(item.edits, 2); assert.equal(item.attempts.length, 2)
  assert.deepEqual(w.replanFields, [['editPrompt', 'imageVersionId', 'reason']])
  const first = item.attempts[0], corrected = item.attempts[1]; assert.ok(first?.review && corrected?.review)
  assert.equal(first.review.checks.protection.result, 'violated')
  assert.equal(corrected.review.checks.protection.result, 'satisfied')
  assert.deepEqual(corrected.plan.objectRoles, first.plan.objectRoles)
  assert.equal(corrected.plan.sourceMedium, first.plan.sourceMedium)
  assert.equal(corrected.plan.mode, first.plan.mode)
  assert.deepEqual(corrected.plan.regions, first.plan.regions)
  assert.deepEqual(w.frozenPlans[0]?.objectRoles, first.plan.objectRoles)
  assert.equal(corrected.layoutCorrection, undefined); assert.equal(corrected.sourceIntentProof, undefined)
  assert.ok(w.requests.every(request => !request.mask))
  assert.notEqual(first.outputId, corrected.outputId)
})

test('a replanner that attempts to return source entities fails at planning and cannot trigger another generation', async t => {
  const w = await sourceWorkflow(t, 'invalid-replan'); await w.start()
  const item = w.state().items[0]; assert.ok(item)
  assert.equal(item.status, 'technical-failed', w.diagnostics())
  assert.equal(item.errorCode, 'vision-invalid-output'); assert.equal(item.failedStep, 'planning')
  assert.equal(item.edits, 1); assert.equal(w.requests.length, 1)
  assert.ok(item.attempts[0]?.outputId && item.attempts[0]?.review)
  assert.equal(w.f.repository.list('selection').length, 0)
})
