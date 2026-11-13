/** Real rendering, storage and request routing with explicit isolated model and image-provider responses. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { type ImageGenerationTask, type ImageGenerationTaskId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import LocalAttachmentStore from '../../../../packages/attachment/attachment-local/src/index.ts'
import { useHistoricalWallpaperCpu, serviceFixture } from './helpers/service-fixture.ts'
import { dataOf, specOf, toJson } from '../src/host/runtime.ts'
import { runSchema } from '../src/shared/model.ts'
import { wallpaperDirectReviewPrompt } from '../src/shared/wallpaper-edit-prompts.ts'
import { wallpaperSettingsSchema, wallpaperStateSchema, wallpaperReviewKeys, wallpaperVerdict, wallpaperReviewOutputSchema } from '../src/shared/wallpaper.ts'
import { applyWallpaperSourceReview } from '../src/host/wallpaper-review.ts'
import { wallpaperGenerationAlignment } from '../src/media/wallpaper-alignment.ts'
import { renderWallpaper } from '../src/media/wallpaper-render.ts'
import { realWallpaperEdgeEvidence, realWallpaperEdgeDetail } from './helpers/wallpaper-edge-real.ts'
import { contentDigest } from '../src/domain/repository.ts'
import { MediaError } from '../src/media/index.ts'

for (const mode of ['recover', 'framing-limit', 'real-response', 'whole-canvas-review', 'whole-canvas-clarity', 'authorized-repair', 'authorized-repair-placement', 'authorized-repair-clock', 'authorized-repair-budget', 'authorized-repair-ratio', 'authorized-repair-ratio-large', 'pre-review-repair', 'pre-review-resolution', 'pre-review-resume', 'pre-review-alignment', 'pre-review-alignment-reject', 'pre-review-boundary'] as const) test(`saved source-edge repair ${mode} retains its frozen composition and independent acceptance`, async () => {
  const newOrder = mode.startsWith('pre-review'), authorized = mode.startsWith('authorized-repair') || newOrder, wholeCanvas = mode.startsWith('whole-canvas') || authorized
  const f = await serviceFixture(undefined, { maxVisionCalls: 30, maxImportBytes: 8_000_000 }), context = new Context()
  const attachments = new LocalAttachmentStore(context, { dshHome: f.root }), llm = new LlmRuntime(context)
  useHistoricalWallpaperCpu(f)
  if (authorized) f.service.config.wallpaper.repairPolicy = { version: 'subject-repair-v1', mode: 'repair-when-needed', maxRepeatedDefects: 2 }
  if (mode === 'authorized-repair-clock') f.service.config.wallpaper.processing = wallpaperSettingsSchema.parse({ processing: { clockContrast: {} } }).processing
  f.host.attachments = attachments; f.host.llm = llm
  f.service.config.wallpaper.imageModel = 'isolated-edit-model'
  if (mode === 'framing-limit' || wholeCanvas) f.service.config.wallpaper.maxEditsPerImage = authorized && !mode.startsWith('pre-review-alignment') && mode !== 'pre-review-boundary' ? 2 : 1
  const width = 941, height = 1672, pixels = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 3
    pixels[index] = Math.floor(x / 100) % 2 ? 190 : 40
    pixels[index + 1] = Math.floor(y / 170) % 2 ? 180 : 60
    pixels[index + 2] = Math.floor((x + y) / 90) % 2 ? 120 : 220
    if (authorized && y < height * 0.34) for (let channel = 0; channel < 3; channel++) pixels[index + channel] = Math.round(pixels[index + channel]! * 0.25)
  }
  const original = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer(), sourcePath = join(f.root, 'edge-source.png')
  await writeFile(sourcePath, original)
  const generations = new Map<string, ImageGenerationTask>(), prompts: string[] = [], operations: string[] = []
  let reviews = 0, failedReview = false
  llm.getImageGeneration = async handle => {
    const task = generations.get(handle.id)
    if (!task) throw Object.assign(new Error('No isolated generation'), { code: 'IMAGE_GENERATION_NOT_FOUND' })
    return task
  }
  llm.startImageGeneration = async request => {
    assert.equal(request.references.length, 1, 'Only the target canvas defines composition')
    assert.ok(request.mask); assert.equal(generations.has(request.id), false)
    prompts.push(request.prompt)
    const input = await attachments.readImage(request.references[0]!)
    assert.equal((await sharp(input.data).stats()).isOpaque, true, 'The complete canvas extent remains visible')
    const maskChunks: Uint8Array[] = []
    for await (const chunk of attachments.readFileStream(request.mask!)) maskChunks.push(chunk)
    const mask = await sharp(Buffer.concat(maskChunks)).extractChannel('alpha').resize(1845, 3280, { kernel: 'nearest' }).raw().toBuffer()
    const rgb = await sharp(input.data).resize(1845, 3280).removeAlpha().png().toBuffer()
    const canvas = await sharp(rgb).joinChannel(mask, { raw: { width: 1845, height: 3280, channels: 1 } }).png().toBuffer()
    const output = generations.size === 0 ? mode.startsWith('authorized-repair-ratio') || mode === 'pre-review-resolution' ? await sharp(original).resize(mode === 'authorized-repair-ratio' || mode === 'pre-review-resolution' ? 928 : 500, 1695).png().toBuffer() : mode === 'authorized-repair-clock' ? await sharp(original).composite([{ input: await sharp({ create: { width, height: Math.ceil(height * 0.34), channels: 3, background: '#ffffff' } }).png().toBuffer(), left: 0, top: 0 }]).png().toBuffer() : original : await sharp({ create: { width: 1845, height: 3280, channels: 3, background: generations.size === 1 ? '#31402e' : '#829779' } }).composite([{ input: canvas }]).png().toBuffer()
    const directOutput = mode === 'pre-review-repair' && generations.size > 0 ? await sharp(output).composite([{ input: await sharp({ create: { width: 20, height: 20, channels: 3, background: '#0000ff' } }).png().toBuffer(), left: 900, top: 1500 }]).png().toBuffer() : output
    const providerOutput = newOrder ? await sharp(directOutput).png({ compressionLevel: generations.size === 0 ? 0 : 1 }).toBuffer() : directOutput
    const file = await attachments.saveFile({ data: providerOutput, name: 'isolated-result.png' }), [preview] = await attachments.saveImages([{ data: providerOutput, mediaType: 'image/png' }])
    const task: ImageGenerationTask = { id: request.id, provider: request.provider, model: request.model, taskId: brandString<ImageGenerationTaskId>('isolated-' + generations.size), state: 'succeeded', images: [{ original: file, preview: preview! }] }
    generations.set(request.id, task); return task
  }
  const send = f.http.request.bind(f.http)
  f.http.request = async (url, request) => {
    if (!url.startsWith('https://vision.example.test')) return send(url, request)
    const messages = z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() })) }).parse(JSON.parse(Buffer.from(request.body!).toString('utf8'))).messages
    const content = z.array(z.object({ text: z.string().optional() }).passthrough()).parse(messages.find(row => row.role === 'user')!.content)
    const input = z.object({ input: z.object({ operation: z.string(), images: z.array(z.object({ imageVersionId: z.string(), role: z.string() })), usage: z.record(z.string(), z.unknown()) }) }).parse(JSON.parse(content[0]!.text!)).input
    if (mode === 'pre-review-resume' && input.operation === 'wallpaper-review' && !failedReview) { failedReview = true; throw new MediaError('vision-image-digest-mismatch', 'wallpaper-vision', false, 'The wallpaper source does not match its saved digest.', 'Restore the saved source before continuing.') }
    const source = input.images.find(image => image.role === 'wallpaper-original')!, final = input.images.find(image => image.role === 'actual-wallpaper')
    const detail = input.images.find(image => image.role === 'wallpaper-original-detail-only')
    operations.push(input.operation === 'wallpaper-plan' && detail ? 'detail' : input.operation)
    const { placement: _savedPlacement, ...savedObservation } = realWallpaperEdgeEvidence.plan
    const noFrameCrop = mode.startsWith('pre-review-alignment') || mode === 'pre-review-boundary'
    const vineRect = { x: 0.2, y: 0.18, width: 0.6, height: noFrameCrop ? 0.79 : 0.82 }
    const potRect = { x: 0.35, y: 0.25, width: 0.3, height: 0.3 }
    const observation = mode === 'real-response' ? { ...savedObservation, imageVersionId: source.imageVersionId } : { version: 1, imageVersionId: source.imageVersionId, mode: 'single', subject: 'An isolated vine touching the bottom frame.', evidence: 'Scripted source observation.', priorities: [], anchors: [], truncations: ['The vine continues across the bottom source edge.'], uncertainties: [],
      ...(authorized ? { objectRoles: [{ entityId: 'vine', name: 'Vine', role: 'primary', evidence: 'The primary plant.', rect: vineRect, sourceEdges: noFrameCrop ? [] : ['bottom'] }, { entityId: 'pot', name: 'Pot', role: 'critical-part', evidence: 'Required supporting structure for the vine.', rect: potRect, sourceEdges: [] }] } : {}),
      regions: [{ name: 'Vine', ...(authorized ? { entityId: 'vine' } : {}), role: 'subject', rect: vineRect }, { name: 'Pot', ...(authorized ? { entityId: 'pot' } : {}), role: 'critical', rect: potRect }], reason: 'Keep the source pixels and leave room for the trailing edge.', editPrompt: 'Continue the existing vine naturally below the saved source edge without changing visible leaves or the pot.' }
    if (mode.startsWith('pre-review-alignment') || mode === 'pre-review-boundary') observation.truncations = []
    let result: object = observation
    if (input.operation === 'wallpaper-plan' && detail) {
      const { truncations: _truncations, ...updated } = observation
      const concerns = z.array(z.object({ id: z.string() })).parse(input.usage.concerns)
      const sourceRegion = { x: 0.2, y: 0.9, width: 0.2, height: 0.1 }
      result = mode === 'real-response' ? realWallpaperEdgeDetail(source.imageVersionId, z.array(z.object({ imageVersionId: z.string(), sourceRect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional() })).parse(input.usage.imageRepresentations)) : { version: 'wallpaper-plan-detail-v5', imageVersionId: source.imageVersionId, protectedSubjectExtent: { extent: 'cut-off', reason: 'The original vine crosses the bottom frame.', evidenceImageVersionIds: [detail.imageVersionId] }, backgroundTruncations: [], edgeRepair: { classification: 'edge-continuation', edges: ['bottom'], concernIds: concerns.map(concern => concern.id), sourceRegion, evidenceImageVersionIds: [detail.imageVersionId], reason: 'The connection and leaf direction are visible at the source edge.', instruction: 'Extend the same vine to a natural endpoint below the original frame; preserve the existing leaves.' }, findings: concerns.map(concern => ({ concernId: concern.id, result: 'resolved', scope: 'subject', classification: 'edge-continuation', blocking: false, sourceRegion, reason: 'The repair target is localized, not already complete.', evidenceImageVersionIds: [detail.imageVersionId] })), retainedUncertainties: [], observation: updated }
    } else if (input.operation === 'wallpaper-review') {
      if (newOrder) {
        const composition = z.object({ mode: z.literal('generated-canvas-v1'), nativeSourceRestored: z.literal(false), sourcePlacement: z.object({ scale: z.number(), left: z.number(), top: z.number() }) }).parse(input.usage.composition)
        assert.ok(composition.sourcePlacement.scale > 0)
        assert.match(String(messages[0]?.content), /整张图由模型重绘，不能仅凭健康区域像素不同/)
      }
      if (!authorized) assert.equal(z.object({ classification: z.string() }).parse(input.usage.edgeRepair).classification, 'edge-continuation')
      if (wholeCanvas && !authorized && reviews === 1) {
        const views = z.array(z.object({ sourceImageVersionId: z.string().optional(), sourceRect: z.object({ width: z.number(), height: z.number() }).optional() }).passthrough()).parse(input.usage.imageRepresentations)
        const detail = views.find(view => view.sourceImageVersionId === final!.imageVersionId)
        assert.ok(detail?.sourceRect && detail.sourceRect.width < 0.8 && detail.sourceRect.height < 0.8, 'Known output bounds produce a native foreground crop, not another reduced full-frame view')
      }
      const failed = (++reviews === 1 || mode === 'authorized-repair-budget') && !mode.startsWith('authorized-repair-ratio') && mode !== 'authorized-repair-clock' && mode !== 'pre-review-resolution' && mode !== 'pre-review-resume' && mode !== 'pre-review-alignment', failedKey = mode === 'authorized-repair-placement' || mode === 'pre-review-boundary' ? 'protection' : mode === 'whole-canvas-clarity' ? 'clarity' : 'background', failedReason = failedKey === 'clarity' ? 'The actual subject edges are blurred.' : 'The editable background has a visible seam.'
      result = { reviewVersion: wholeCanvas ? 'wallpaper-review-source-v4' : 'wallpaper-review-source-v2', ...(wholeCanvas ? { actualLayout: { imageVersionId: final!.imageVersionId, regions: [{ name: 'Whole vine', ...(authorized ? { entityId: 'vine' } : {}), role: 'subject', scope: 'core', rect: (mode === 'authorized-repair-placement' || mode === 'pre-review-boundary') && failed ? { x: 0.01, y: 0.1, width: 0.98, height: 0.88 } : { x: 0.3, y: 0.4, width: 0.4, height: 0.2 } }, { name: 'Pot', ...(authorized ? { entityId: 'pot' } : {}), role: 'critical', scope: 'core', rect: { x: 0.35, y: 0.5, width: 0.2, height: 0.1 } }] }, sourceCorrespondence: { result: 'satisfied', reason: 'Same visible structure' } } : {}), sourceRepair: { result: 'satisfied', reason: 'Scripted independent edge-completion observation.' }, subject: observation.subject, styleResults: [], checks: { ...Object.fromEntries([...wallpaperReviewKeys, 'clarity'].map(key => [key, { result: failed && key === failedKey ? 'violated' : 'satisfied', reason: failed && key === failedKey ? failedReason : 'Scripted actual-pixel observation.' }])) }, issues: failed ? [{ kind: failedKey === 'protection' ? 'layout' : failedKey === 'clarity' ? 'preservation' : 'background', ...(wholeCanvas ? { check: failedKey, code: 'other' } : {}), reason: failedReason }] : [], subjectIntegrity: { mode: 'single', source: { extent: 'cut-off', reason: 'Original frame damage stays recorded.', imageVersionId: source.imageVersionId }, output: { extent: 'complete', reason: 'The scripted completed edge is visible.', imageVersionId: final!.imageVersionId }, task: { result: 'satisfied', reason: 'Existing source content is preserved.' } } }
      if (mode === 'pre-review-boundary' && reviews === 2) {
        assert.ok(input.images.some(image => image.role === 'wallpaper-layout-only'), 'A separate safety guide accompanies the independent boundary measurement')
        assert.ok(input.usage.layoutCoordinates)
      }
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] })) }
  }
  try {
    await f.service.initialize()
    let release!: () => void
    const ready = new Promise<void>(resolve => { release = resolve })
    const startJob = f.jobs.start
    f.jobs.start = spec => startJob({ ...spec, run: handle => {
      let hooks: ReturnType<typeof spec.run> | undefined, cancelled = false
      return { cancel: () => { cancelled = true; hooks?.cancel() }, done: ready.then(() => { hooks = spec.run(handle); if (cancelled) hooks.cancel(); return hooks.done }) }
    } })
    const start = z.object({ runId: z.string() }).parse(await f.action('direct-crop-start', { operationId: 'edge-pipeline', name: 'Isolated edge completion', source: { kind: 'local', files: [{ path: sourcePath, name: 'edge-source.png' }] } }))
    try {
      {
      const created = f.domain.require('run', start.runId), spec = specOf(created)
      const prompts = authorized ? z.record(z.string(), z.json()).parse(spec.fixed.prompts) : { ...z.record(z.string(), z.json()).parse(spec.fixed.prompts), review: { version: 'wallpaper-review-source-v2', text: wallpaperDirectReviewPrompt } }
      // This fixture exercises the saved legacy order; the new order has its own focused cases.
      const { reviewOrder: _reviewOrder, ...legacyFixed } = spec.fixed
      const fixed = { ...legacyFixed, ...(newOrder ? { reviewOrder: 'generation-before-resolution-v1' } : {}), ...(!authorized ? { prompts, promptDigest: contentDigest(prompts), directPolicy: { version: 'source-faithful-v2', promptDigest: contentDigest(prompts) } } : {}) }
      const recorded = runSchema.parse({ ...created, spec: toJson({ ...spec, fixed, specDigest: contentDigest({ kind: spec.kind, config: spec.config, input: spec.input, fixed }) }) })
      const aggregateId = 'run:' + created.id
      await f.repository.commit({ aggregateId, expectedRevision: f.repository.manifest(aggregateId)!.revision, operationId: 'freeze-historical-canvas-policy', request: {}, records: [recorded], state: { runId: created.id } })
      }
    } finally { f.jobs.start = startJob; release() }
    await f.jobs.drain()
    let completedRunId = start.runId
    if (mode === 'pre-review-resume') {
      const failedItem = wallpaperStateSchema.parse(dataOf(f.domain.require('run', start.runId)).checkpoint.wallpaper).items[0]!
      assert.equal(failedItem.errorCode, 'vision-image-digest-mismatch', failedItem.reason)
      assert.equal(failedItem.attempts[0]?.generation !== undefined, true)
      completedRunId = z.object({ runId: z.string() }).parse(await f.action('wallpaper-continue', { runId: start.runId, operationId: 'resume-saved-generation' })).runId
      await f.jobs.drain()
    }
    const run = f.domain.require('run', completedRunId), item = wallpaperStateSchema.parse(dataOf(run).checkpoint.wallpaper).items[0]!
    if (mode.startsWith('pre-review-alignment') || mode === 'pre-review-boundary') {
      const final = item.attempts.at(-1)!
      const expected = JSON.parse(await readFile(new URL('./fixtures/wallpaper-layout-recovery.expected.json', import.meta.url), 'utf8'))
      assert.deepEqual({ status: item.status, edits: item.edits, generations: generations.size, nativeReviews: reviews,
        correlationIsDiagnostic: final.generationAlignment?.result !== 'not-detected', boundaryReview: !!(final.review && 'criticalDetail' in final.review && final.review.criticalDetail?.requestId.endsWith(':boundary-detail')),
        superResolution: !!final.backgroundResolution, model: final.backgroundResolution?.model ?? null }, expected[mode])
      if (final.backgroundResolution) assert.equal(final.backgroundResolution.input.digest, `sha256-v1:${final.preResolutionReview!.nativeDigest}`, 'ESPCN receives exactly the native image that passed review')
    }
    if (mode === 'pre-review-alignment-reject') {
      assert.equal(item.status, 'needs-review'); assert.equal(item.edits, 1)
      assert.equal(reviews, 1, 'The final edit retains its reserved native review despite low correlation')
      assert.notEqual(item.attempts[0]!.generationAlignment?.result, 'not-detected')
      assert.ok(item.attempts[0]!.preResolutionReview)
      assert.equal(item.attempts[0]!.backgroundResolution, undefined, 'A rejected native image never reaches super-resolution')
      return
    }
    if (newOrder) {
      assert.equal(item.status, 'passed', item.reason)
      assert.equal(z.object({ version: z.literal('style-brief-v3') }).parse(specOf(run).fixed.generationPromptPolicy).version, 'style-brief-v3')
      assert.deepEqual(item.attempts[0]!.generationInput?.references.map(reference => reference.role), ['canvas'])
      assert.equal(reviews, mode === 'pre-review-repair' || mode === 'pre-review-boundary' ? 2 : 1)
      assert.equal(generations.size, mode === 'pre-review-repair' ? 2 : 1)
      assert.ok(item.attempts.every(attempt => attempt.preResolutionReview))
      if (mode === 'pre-review-repair') assert.equal(item.attempts[0]!.backgroundResolution, undefined, 'A rejected generated image never reaches super-resolution')
      const final = item.attempts.at(-1)!
      assert.equal(final.compositionMode, 'generated-canvas-v1')
      assert.equal(final.preResolutionReview!.finalId, final.outputId)
      assert.equal(!!final.backgroundResolution, mode === 'pre-review-resolution' || mode === 'pre-review-resume' || mode === 'pre-review-alignment' || mode === 'pre-review-boundary')
      if (mode === 'pre-review-alignment') assert.notEqual(final.generationAlignment?.result, 'not-detected', 'A semantic review can accept legitimate whole-canvas changes despite the diagnostic signal')
      if (mode === 'pre-review-boundary') assert.ok(final.review && 'criticalDetail' in final.review && final.review.criticalDetail?.requestId.endsWith(':boundary-detail'))
      if (mode === 'pre-review-repair') {
        const output = f.domain.require('imageVersion', final.outputId!)
        const pixel = await sharp(await f.files.read(output.blob)).extract({ left: 900, top: 1500, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
        assert.deepEqual([...pixel], [0, 0, 255], 'The model result remains visible inside the placed original instead of being pasted over')
      }
      assert.equal(operations.filter(operation => operation === 'wallpaper-review').length, reviews, 'No model review follows super-resolution')
      return
    }
    if (mode === 'framing-limit') {
      assert.equal(item.status, 'needs-review'); assert.equal(item.edits, 1); assert.equal(generations.size, 1); assert.equal(reviews, 0)
      assert.equal(item.attempts.at(-1)?.generationAlignment?.result, 'reframed-source')
      assert.ok(item.attempts.at(-1)?.generatedImageId); assert.equal(item.attempts.at(-1)?.outputId, undefined); assert.equal(f.repository.list('selection').length, 0)
      assert.deepEqual(operations, ['wallpaper-plan', 'detail'])
      return
    }
    if (mode.startsWith('authorized-repair-ratio')) {
      assert.equal(item.status, 'passed', item.reason)
      assert.equal(reviews, 1); assert.deepEqual(operations, ['wallpaper-plan', 'wallpaper-review'])
      assert.ok(item.attempts[0]!.generatedImageId, 'Original model output is retained')
      if (mode === 'authorized-repair-ratio') {
        assert.equal(item.edits, 1); assert.equal(generations.size, 1)
        const crop = item.attempts[0]!.generationCanvasCrop!
        assert.deepEqual([crop.sourceWidth, crop.sourceHeight, crop.left, crop.top, crop.width, crop.height], [928, 1695, 0, 23, 928, 1649])
        assert.notEqual(crop.croppedId, crop.originalId)
        assert.ok(item.attempts[0]!.backgroundResolution)
      } else {
        assert.equal(item.edits, 2); assert.equal(generations.size, 2)
        assert.equal(item.attempts[0]!.generationCanvasCrop, undefined)
        assert.equal(item.attempts[0]!.backgroundResolution, undefined, 'Large aspect errors do not enter superresolution')
        assert.match(prompts[1]!, /canvasAspectFailure/)
      }
      return
    }
    if (authorized) {
      assert.equal(operations.includes('detail'), false, 'Known source truncation proceeds directly to candidate production')
      assert.equal(item.edits, 2, JSON.stringify({ status: item.status, reason: item.reason, errorCode: item.errorCode, operations, attempts: item.attempts.map(row => ({ checks: row.checks, generationAlignment: row.generationAlignment, backgroundResolution: row.backgroundResolution })) })); assert.equal(generations.size, 2); assert.equal(reviews, 2, JSON.stringify({ status: item.status, reason: item.reason, errorCode: item.errorCode, operations, attempts: item.attempts.map(row => ({ checks: row.checks, generationAlignment: row.generationAlignment, backgroundResolution: row.backgroundResolution })) }))
      assert.equal(item.attempts.every(attempt => !attempt.detailAnalysis), true)
      assert.ok(prompts.every(prompt => prompt.includes('taskPolicy') && prompt.includes('generatedRepair')))
      if (mode === 'authorized-repair-clock') {
        const first = item.attempts[0]!, corrected = item.attempts.at(-1)!
        assert.equal(first.review && 'modelReadabilityCheck' in first.review ? first.review.modelReadabilityCheck?.result : undefined, 'satisfied')
        assert.equal(first.review!.checks.readability.result, 'violated')
        assert.deepEqual(corrected.layoutCorrection?.plan.placement, { scale: 1, left: 0, top: 0 })
        assert.equal(corrected.layoutCorrection?.plan.imageVersionId, first.outputId)
        assert.equal(corrected.review && 'clockContrast' in corrected.review ? corrected.review.clockContrast?.readableFraction : undefined, 1)
        const expected = JSON.parse(await readFile(new URL('./fixtures/wallpaper-clock-repair.expected.json', import.meta.url), 'utf8'))
        assert.deepEqual({ operations, generations: generations.size, reviews, edits: item.edits, sourceObservationRetained: contentDigest(first.plan) === contentDigest(corrected.plan), status: item.status }, expected)
      }
      if (mode === 'authorized-repair-placement') {
        const corrected = item.attempts.at(-1)!
        assert.equal(corrected.layoutCorrection?.plan.imageVersionId, item.attempts[0]!.outputId)
        assert.equal(corrected.plan.imageVersionId, item.originalId, 'Original source observation remains separate')
        assert.ok(corrected.layoutCorrection!.plan.placement.scale < 1)
        assert.match(prompts[1]!, /candidatePlacement/)
        assert.equal(corrected.layoutCorrection!.plan.truncations.length, 0, 'Already completed source damage is not reopened')
        assert.deepEqual(operations, ['wallpaper-plan', 'wallpaper-review', 'wallpaper-review'])
        const expected = JSON.parse(await readFile(new URL('./fixtures/wallpaper-candidate-placement.expected.json', import.meta.url), 'utf8'))
        assert.deepEqual({ operations, generations: generations.size, reviews, edits: item.edits, referencesPerGeneration: 1, originalObservationRetained: contentDigest(corrected.plan) === contentDigest(item.attempts[0]!.plan), referenceIsPreviousOutput: corrected.layoutCorrection?.plan.imageVersionId === item.attempts[0]!.outputId, completedDamageNotReopened: corrected.layoutCorrection?.plan.truncations.length === 0, status: item.status }, expected)
      }
      const expected = JSON.parse(await readFile(new URL('./fixtures/wallpaper-authorized-repair.expected.json', import.meta.url), 'utf8'))
      assert.deepEqual({ operations, generations: generations.size, reviews, edits: item.edits, referencesPerGeneration: 1 }, expected)
      if (mode === 'authorized-repair-budget') { assert.equal(item.status, 'needs-review'); assert.equal(item.reason, 'edit-limit'); assert.equal(f.repository.list('selection').length, 0) }
      else { assert.equal(item.status, 'passed', item.reason); assert.equal(f.repository.list('selection').length, 1); assert.equal(item.attempts.at(-1)!.review!.checks.subject.result, 'satisfied') }
      return
    }
    if (wholeCanvas) {
      const previous = contentDigest(run), saved = item.attempts.at(-1)!
      const next = z.object({ runId: z.string() }).parse(await f.action('wallpaper-continue', { runId: run.id, operationId: 'whole-canvas-only', recompose: { imageVersionId: item.imageVersionId, revision: saved.revision, mode: 'generated-canvas-v1', reviewPolicy: 'current', backgroundResolution: 'current' } }))
      await f.jobs.drain()
      const child = f.domain.require('run', next.runId), checked = wallpaperStateSchema.parse(dataOf(child).checkpoint.wallpaper).items[0]!, attempt = checked.attempts.at(-1)!
      assert.equal(generations.size, 1); assert.equal(checked.edits, 1)
      assert.equal(attempt.compositionMode, 'generated-canvas-v1'); assert.ok(attempt.outputId, JSON.stringify({ status: checked.status, reason: checked.reason, errorCode: checked.errorCode, failedStep: checked.failedStep, generations: checked.attempts.map(row => ({ revision: row.revision, generation: !!row.generation, output: !!row.outputId, review: !!row.review, alignment: row.generationAlignment?.result, framing: row.generationFramingFailure, retryFrom: row.retryFrom, retryTarget: row.retryTarget, preReview: !!row.preResolutionReview })), edits: checked.edits }))
      if (mode === 'whole-canvas-clarity') {
        assert.equal(checked.status, 'passed'); assert.ok(attempt.clarity?.enhancedOutputId); assert.equal(reviews, 2)
        assert.equal(generations.size, 1); assert.equal(checked.edits, 1)
        assert.equal(contentDigest(f.domain.require('run', run.id)), previous)
        return
      }
      assert.equal(checked.status, 'needs-review'); assert.equal(wallpaperVerdict(attempt.review!), 'reject')
      assert.equal(f.repository.list('selection').length, 0); assert.equal(contentDigest(f.domain.require('run', run.id)), previous)
      const detailReview = z.object({ runId: z.string() }).parse(await f.action('wallpaper-continue', { runId: child.id, operationId: 'native-actual-subject-review', review: { outputId: attempt.outputId! } }))
      await f.jobs.drain()
      const verified = wallpaperStateSchema.parse(dataOf(f.domain.require('run', detailReview.runId)).checkpoint.wallpaper).items[0]!
      assert.equal(verified.status, 'passed'); assert.equal(verified.edits, 1); assert.equal(generations.size, 1)
      assert.equal(verified.attempts.at(-1)!.outputId, attempt.outputId, 'Review evidence changes without changing the saved candidate pixels')
      return
    }
    assert.equal(item.status, 'passed', JSON.stringify({ status: item.status, reason: item.reason, errorCode: item.errorCode, edits: item.edits, operations, requests: f.repository.list('request').map(record => ({ state: record.state, detail: z.object({ error: z.unknown(), diagnostics: z.unknown().optional() }).safeParse(record.data).data })) }))
    const expected = JSON.parse(await readFile(new URL('./fixtures/wallpaper-edit-pipeline.expected.json', import.meta.url), 'utf8'))
    assert.deepEqual({ operations, generations: generations.size, reviews, edits: item.edits, referencesPerGeneration: 1 }, expected)
    assert.equal(item.attempts.filter(attempt => attempt.generationAlignment?.result === 'reframed-source').length, 1)
    assert.equal(item.attempts.filter(attempt => attempt.generation).length, 3)
    assert.ok(item.attempts.filter(attempt => attempt.generation).every(attempt => attempt.generatedImageId))
    assert.ok(item.attempts.at(-1)?.retryTarget === 'rendering')
    assert.match(prompts[1]!, /reframed-source/); assert.match(prompts[2]!, /visible seam/)
    assert.equal(item.attempts.at(-1)?.detailAnalysis?.protectedSubjectExtent, 'cut-off')
    assert.equal(item.attempts.at(-1)?.detailAnalysis?.outcome, 'ready-for-edit')
    assert.equal(item.decisions?.length ?? 0, 0, 'Native readiness proceeds directly to editing without another routing round')
    if (mode === 'real-response') {
      assert.equal(item.attempts.at(-1)?.detailAnalysis?.retainedUncertainties?.length, 3)
      assert.equal(item.attempts.at(-1)?.detailAnalysis?.findings?.filter(finding => finding.result === 'unresolved').length, 4)
      assert.match(prompts[0]!, /retainedUnknowns/)
    }
    assert.equal(f.repository.list('selection').length, 1)
    const output = f.domain.require('imageVersion', item.attempts.at(-1)!.outputId!)
    assert.deepEqual({ width: output.geometry.width, height: output.geometry.height }, { width: 1845, height: 3280 })
    const last = item.attempts.at(-1)!, settings = wallpaperSettingsSchema.parse(specOf(run).fixed.wallpaper)
    const baseline = await renderWallpaper(original, last.plan, settings, undefined, last.compositionMode)
    const actualPixels = await sharp(await f.files.read(output.blob)).removeAlpha().raw().toBuffer(), originalPixels = await sharp(baseline.image).removeAlpha().raw().toBuffer()
    for (const region of baseline.geometry.regions) for (let y = Math.floor(region.top); y < Math.ceil(region.top + region.height); y++) {
      const start = (y * settings.width + Math.floor(region.left)) * 3, end = (y * settings.width + Math.ceil(region.left + region.width)) * 3
      assert.ok(actualPixels.subarray(start, end).equals(originalPixels.subarray(start, end)), 'Protected native pixels remain byte-identical')
    }
  } finally { await f.cleanup(); await context.fiber.dispose() }
})

test('a source-repair claim cannot waive original completeness without Host authorization or pass an incomplete final subject', () => {
  const checks = Object.fromEntries([...wallpaperReviewKeys, 'clarity'].map(key => [key, { result: 'satisfied', reason: 'Independent test observation.' }]))
  const value = { reviewVersion: 'wallpaper-review-source-v2', sourceRepair: { result: 'satisfied', reason: 'An edge continuation was inspected.' }, subject: 'Vine', styleResults: [], checks, issues: [], subjectIntegrity: { mode: 'single', source: { extent: 'cut-off', reason: 'Source frame edge.', imageVersionId: 'source' }, output: { extent: 'complete', reason: 'Actual complete result.', imageVersionId: 'final' }, task: { result: 'satisfied', reason: 'Task observation.' } } }
  const schema = wallpaperReviewOutputSchema('wallpaper-review-source-v2', [], ['source', 'final'], 'final', 'source')
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(schema.parse(value))), 'reject')
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(schema.parse(value), true)), 'pass')
  for (const extent of ['cut-off', 'unknown', 'occluded']) assert.notEqual(wallpaperVerdict(applyWallpaperSourceReview(schema.parse({ ...value, subjectIntegrity: { ...value.subjectIntegrity, output: { ...value.subjectIntegrity.output, extent } } }), true)), 'pass')
  assert.equal(schema.safeParse({ ...value, sourceRepairAuthorized: true }).success, false)
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(schema.parse({ ...value, sourceRepair: { result: 'unknown', reason: 'No sufficient pixels.' } }), true)), 'needs-review')
})

test('framing detection never approves uniform imagery and leaves the final visual judgment to independent review', async () => {
  const settings = wallpaperSettingsSchema.parse({ backgroundAlignment: {} })
  const original = await sharp({ create: { width: 941, height: 1672, channels: 3, background: '#777777' } }).png().toBuffer()
  const plan = { version: 1 as const, imageVersionId: 'original', mode: 'single' as const, subject: 'Fixture', evidence: 'Fixture', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [], placement: { scale: 1, left: 452, top: 871 }, reason: 'Fixture' }
  assert.equal((await wallpaperGenerationAlignment(original, original, plan, settings))?.result, 'not-detected')
  assert.equal(await wallpaperGenerationAlignment(original, original, plan, wallpaperSettingsSchema.parse({})), undefined)
})

test('protected placement rejects a repainted full-source view before source pixels can be pasted over it', async () => {
  const settings = wallpaperSettingsSchema.parse({ backgroundAlignment: {} })
  const width = 941, height = 1672, rgb = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 3
    rgb[at] = Math.floor(x / 100) % 2 ? 190 : 40
    rgb[at + 1] = Math.floor(y / 170) % 2 ? 180 : 60
    rgb[at + 2] = Math.floor((x + y) / 90) % 2 ? 120 : 220
  }
  const original = await sharp(rgb, { raw: { width, height, channels: 3 } }).png().toBuffer()
  const plan = { version: 1 as const, imageVersionId: 'source', mode: 'single' as const, subject: 'Fixture', evidence: 'Fixture', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [{ name: 'Subject', role: 'subject' as const, rect: { x: .2, y: .2, width: .6, height: .6 } }], placement: { scale: 1, left: 452, top: 871 }, reason: 'Fixture' }
  const repaint = await sharp(original).composite([{ input: await sharp({ create: { width: 500, height: 500, channels: 3, background: '#c7bca4' } }).png().toBuffer(), left: 100, top: 200 }]).png().toBuffer()
  const rejected = await wallpaperGenerationAlignment(original, repaint, plan, settings, true)
  assert.equal(rejected?.result, 'misaligned-source')
  const correct = await sharp({ create: { width: 1845, height: 3280, channels: 3, background: '#c7bca4' } }).composite([{ input: original, left: 452, top: 871 }]).png().toBuffer()
  assert.equal((await wallpaperGenerationAlignment(original, correct, plan, settings, true))?.result, 'not-detected')
})

test('a direct review with a reported defect cannot qualify a contradictory all-satisfied check list', () => {
  const value = { reviewVersion: 'wallpaper-review-source-v2', sourceRepair: { result: 'satisfied', reason: 'No repair needed.' }, subject: 'Subject', styleResults: [], checks: Object.fromEntries([...wallpaperReviewKeys, 'clarity'].map(key => [key, { result: 'satisfied', reason: 'Scripted check.' }])), issues: [{ kind: 'background', reason: 'A visible rectangular seam remains.' }], subjectIntegrity: { mode: 'single', source: { extent: 'complete', reason: 'Source.', imageVersionId: 'source' }, output: { extent: 'complete', reason: 'Output.', imageVersionId: 'final' }, task: { result: 'satisfied', reason: 'Task.' } } }
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(value)), 'needs-review')
})
