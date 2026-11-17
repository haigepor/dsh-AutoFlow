/** Complete provider canvases cannot be replaced by pasted sources; inventory findings and receipt outcomes constrain automatic recovery. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import LlmRuntime, { type ImageGenerationTask, type ImageGenerationTaskId } from '@deepseek-ai/dsh-llm'
import LocalAttachmentStore from '../../../../packages/attachment/attachment-local/src/index.ts'
import { MediaError } from '../src/media/index.ts'
import { dataOf, specOf } from '../src/host/runtime.ts'
import { contentDigest } from '../src/domain/repository.ts'
import { wallpaperPlanSchema, wallpaperSettingsSchema, wallpaperStateSchema, wallpaperStoredSourceReviewV4Schema, wallpaperVerdict } from '../src/shared/wallpaper.ts'
import { wallpaperPreservationPlanSchema, wallpaperPreservationObservation, wallpaperCanPreserveSource, fitWallpaperPreservedSource, wallpaperPreservedInventorySchema, wallpaperPreservedReview } from '../src/shared/wallpaper-preservation.ts'
import { resolveWallpaperProcessing, wallpaperReviewNeedsSubjectEdit } from '../src/shared/wallpaper-policy.ts'
import { renderWallpaper, renderCompleteWallpaper } from '../src/media/wallpaper-render.ts'
import { wallpaperObjectProtectionRegions } from '../src/shared/wallpaper-geometry.ts'
import { serviceFixture } from './helpers/service-fixture.ts'

const backgroundBrief = { version: 'background-only-v1', setting: 'An empty green studio backdrop.', light: 'Diffuse daylight.', palette: 'Muted green.', texture: 'Smooth uniform background.', perspective: 'A flat backdrop with no visible horizon.' }
const observation = { version: 1, imageVersionId: 'source', mode: 'single', subject: 'Intact colored subject', evidence: 'The entire colored subject is visible.', priorities: ['Retain the source subject'], anchors: ['Uniform green background'], truncations: [], uncertainties: [], sourceAssessment: { classification: 'ready', reason: 'Every visible contour is complete.' }, backgroundBrief, objectRoles: [{ entityId: 'subject-1', name: 'Colored subject', role: 'primary', evidence: 'The foreground subject is complete.', rect: { x: 0.48, y: 0.09, width: 0.19, height: 0.45 } }], reason: 'Host places the intact subject.', editPrompt: 'Extend the uniform green backdrop without adding foreground objects.' }

test('canonical source observations reject uncertain readiness and derive one protection region per entity', () => {
  const parsed = wallpaperPreservationPlanSchema.parse(observation), result = wallpaperPreservationObservation(parsed)
  assert.equal(result.regions.length, 1)
  assert.deepEqual(result.objectRoles[0]?.sourceEdges, [])
  assert.equal(wallpaperPreservationPlanSchema.safeParse({ ...observation, uncertainties: ['An indispensable contour is hidden.'] }).success, false)
  assert.equal(wallpaperPreservationPlanSchema.safeParse({ ...observation, objectRoles: [observation.objectRoles[0], observation.objectRoles[0]] }).success, false)
  const plan = wallpaperPlanSchema.parse({ ...result, placement: { scale: 1, left: 0, top: 0 } })
  assert.equal(wallpaperCanPreserveSource(plan), true)
  assert.equal(wallpaperCanPreserveSource({ ...plan, sourceAssessment: { classification: 'repair-required', reason: 'Real source damage.' } }), false)
  assert.equal(wallpaperCanPreserveSource({ ...plan, objectRoles: plan.objectRoles?.map(object => ({ ...object, sourceEdges: ['left'] })) }), false)
})

test('all former source restoration modes are forbidden and complete output retains only provider pixels', async () => {
  const settings = wallpaperSettingsSchema.parse({ processing: resolveWallpaperProcessing() })
  const observed = wallpaperPreservationObservation(wallpaperPreservationPlanSchema.parse(observation))
  const plan = wallpaperPlanSchema.parse({ ...observed, placement: fitWallpaperPreservedSource({ width: 1845, height: 3280 }, settings) })
  const source = await sharp({ create: { width: 1845, height: 3280, channels: 3, background: '#ff0000' } }).png().toBuffer()
  const provider = await sharp({ create: { width: 1845, height: 3280, channels: 3, background: '#00ff00' } }).png().toBuffer()
  for (const mode of ['background-plate-v1', 'background-plate-v2', 'generated-canvas-protected-v2', 'protected-context-v2', 'source-edge-v1'] as const) {
    await assert.rejects(renderWallpaper(source, plan, settings, provider, mode), /disabled|complete|overlay/i)
  }
  const final = await renderCompleteWallpaper(provider, settings)
  assert.deepEqual(await sharp(final.image).removeAlpha().raw().toBuffer(), await sharp(provider).removeAlpha().raw().toBuffer())
})

test('complete provider output rejects aspect distortion instead of stretching it', async () => {
  const settings = wallpaperSettingsSchema.parse({})
  const wrong = await sharp({ create: { width: 500, height: 500, channels: 3, background: '#527f61' } }).png().toBuffer()
  await assert.rejects(renderCompleteWallpaper(wrong, settings), /aspect|ratio/i)
})

test('an independent duplicated-object inventory rejects an otherwise all-green final review', () => {
  const settings = wallpaperSettingsSchema.parse({ processing: resolveWallpaperProcessing() }), source = { id: 'source', digest: 'source-digest', width: 1845, height: 3280 }
  const observed = wallpaperPreservationObservation(wallpaperPreservationPlanSchema.parse(observation)), plan = wallpaperPlanSchema.parse({ ...observed, regions: wallpaperObjectProtectionRegions(observed), placement: fitWallpaperPreservedSource(source, settings) })
  const raw = { version: 'wallpaper-preserved-quality-v2', backgroundBrief, checks: Object.fromEntries(['subject', 'clock', 'readability', 'composition', 'background', 'style', 'clarity'].map(check => [check, { result: 'satisfied', reason: 'The general visual opinion is favorable.' }])), issues: [], inventory: [{ entityId: 'subject-1', status: 'retained', instances: [{ x: 0.4, y: 0.5, width: 0.1, height: 0.1 }, { x: 0.8, y: 0.5, width: 0.1, height: 0.1 }], reason: 'Two instances are visible.' }], newForeground: [], transitions: ['left', 'top', 'right', 'bottom'].map(edge => ({ edge, result: 'satisfied', reason: 'No seam.' })) }
  const quality = wallpaperPreservedInventorySchema(plan).parse(raw)
  const result = wallpaperPreservedReview(quality, plan, source, { id: 'output', digest: 'output-digest' }, settings, 1508598, true)
  assert.equal(wallpaperVerdict(result), 'reject'); assert.equal(result.checks.background.result, 'violated'); assert.equal(result.sourceCorrespondence.result, 'violated')
  assert.equal(result.preservationProof?.changedPixels, 0, 'Exact retained pixels do not waive extra objects elsewhere')
  const compositionFailed = wallpaperPreservedInventorySchema(plan).parse({ ...raw, checks: { ...raw.checks, composition: { result: 'violated', reason: 'The extra object disrupts the scene layout.' } }, issues: [{ check: 'composition', reason: 'The duplicated foreground disrupts the scene.', rect: { x: 0.8, y: 0.5, width: 0.1, height: 0.1 } }] })
  const backgroundTarget = wallpaperPreservedReview(compositionFailed, plan, source, { id: 'output', digest: 'output-digest' }, settings, 1508598, true)
  assert.equal(backgroundTarget.preservationRepairTarget, 'background')
  assert.equal(wallpaperReviewNeedsSubjectEdit(backgroundTarget), false, 'A duplicate outside intact source pixels must not redraw the healthy source')
})

for (const mode of ['first-pass', 'background-retry', 'inventory-retry', 'saved-recheck', 'transient-retry', 'unknown-receipt', 'resolution-resume', 'rejected-recheck'] as const) test(`new direct workflow ${mode} uses complete canvases and retains receipt outcomes`, async () => {
  const retry = mode === 'background-retry' || mode === 'inventory-retry', transient = mode === 'transient-retry', unknown = mode === 'unknown-receipt'
  const f = await serviceFixture(undefined, { maxVisionCalls: 10, maxRetryAttempts: transient || unknown ? 1 : 0 })
  const context = new Context(), llm = new LlmRuntime(context), attachments = new LocalAttachmentStore(context, { dshHome: f.root })
  f.host.llm = llm; f.host.attachments = attachments
  f.service.config.wallpaper.processing = resolveWallpaperProcessing({ ...f.service.config.wallpaper.processing, sourcePreservation: false, reviewStages: 'final-only-v1' })
  f.service.config.wallpaper.repairPolicy = { version: 'subject-repair-v1', mode: 'repair-when-needed', maxRepeatedDefects: 2 }
  f.service.config.wallpaper.imageProvider = 'isolated-images'; f.service.config.wallpaper.imageModel = 'isolated-model'
  const width = 1845, height = 3280
  const subject = await sharp({ create: { width: 350, height: 1476, channels: 3, background: '#b64e77' } }).png().toBuffer()
  const background = await sharp({ create: { width, height, channels: 3, background: '#527f61' } }).png().toBuffer()
  const pixels = await sharp(background).composite([{ input: subject, left: 886, top: 296 }]).png().toBuffer()
  const generated = await sharp(background).composite([{ input: subject, left: 886, top: 1150 }]).png().toBuffer()
  const path = join(f.root, 'source.png'); await writeFile(path, pixels)
  const tasks = new Map<string, ImageGenerationTask>(), requests: string[] = []
  let generations = 0, correctedCoordinates = false
  if (mode === 'rejected-recheck') f.service.config.wallpaper.maxEditsPerImage = 1
  llm.getImageGeneration = async handle => { const task = tasks.get(handle.id); if (!task) throw Object.assign(new Error('No saved receipt'), { code: 'IMAGE_GENERATION_NOT_FOUND' }); return task }
  llm.startImageGeneration = async request => {
    generations++
    assert.equal(request.references?.length, 1, 'Generation receives a single complete reference')
    assert.equal(request.mask, undefined); assert.match(request.prompt, /严禁.*嵌入/)
    if ((transient || unknown) && generations === 1) {
      const task: ImageGenerationTask = { id: request.id, provider: request.provider, model: request.model, taskId: brandString<ImageGenerationTaskId>('failed-background'), state: unknown ? 'outcome-unknown' : 'failed', images: [], error: { code: unknown ? 'interrupted-after-send' : 'IMAGE_GENERATION_FAILED', message: unknown ? 'The remote outcome is unknown.' : 'OpenAI rejected the image edit (HTTP 503)' } }
      tasks.set(request.id, task); return task
    }
    const output = retry && generations === 1 ? await sharp(generated).composite([{ input: { create: { width: 80, height: 100, channels: 3, background: '#ff00ff' } }, left: 0, top: 0 }]).png().toBuffer() : generated
    const providerOutput = mode === 'resolution-resume' ? await sharp(output).resize(941, 1672).png({ compressionLevel: 1 }).toBuffer() : output
    const original = await attachments.saveFile({ data: providerOutput, name: 'background.png' }), [preview] = await attachments.saveImages([{ data: providerOutput, mediaType: 'image/png' }]); assert.ok(preview)
    const task: ImageGenerationTask = { id: request.id, provider: request.provider, model: request.model, taskId: brandString<ImageGenerationTaskId>('background-' + generations), state: 'succeeded', images: [{ original, preview }] }
    tasks.set(request.id, task); return task
  }
  const send = f.http.request.bind(f.http)
  f.http.request = async (url, request) => {
    if (!url.startsWith('https://vision.example.test')) return send(url, request)
    const messages = z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() })) }).parse(JSON.parse(Buffer.from(request.body!).toString('utf8'))).messages
    const content = z.array(z.object({ text: z.string().optional() }).passthrough()).parse(messages.find(message => message.role === 'user')?.content)
    const descriptor = z.object({ input: z.object({ operation: z.string(), promptVersion: z.string().optional(), images: z.array(z.object({ imageVersionId: z.string(), role: z.string() })) }), outputSchema: z.object({ properties: z.record(z.string(), z.unknown()) }) }).parse(JSON.parse(content[0]!.text!))
    const version = descriptor.input.operation === 'wallpaper-review' ? 'wallpaper-review-source-v4' : String(z.object({ const: z.union([z.string(), z.number()]) }).parse(descriptor.outputSchema.properties.version ?? descriptor.outputSchema.properties.reviewVersion).const)
    requests.push(version)
    let output: object
    if (descriptor.input.operation === 'wallpaper-plan') output = { ...wallpaperPreservationObservation(wallpaperPreservationPlanSchema.parse(observation)), imageVersionId: descriptor.input.images[0]!.imageVersionId }
    else {
      assert.equal(version, 'wallpaper-review-source-v4')
      assert.deepEqual(descriptor.input.images.slice(0, 2).map(image => image.role), ['actual-wallpaper', 'wallpaper-original'])
      const outputId = descriptor.input.images[0]!.imageVersionId, sourceId = descriptor.input.images[1]!.imageVersionId
      const failed = retry && generations === 1, inventoryFailure = mode === 'inventory-retry' && failed
      output = { subject: 'One intact colored subject', reviewVersion: version,
        checks: Object.fromEntries(['subject', 'protection', 'clock', 'readability', 'composition', 'background', 'style', 'clarity'].map(check => [check, { result: check === 'background' && failed && !inventoryFailure ? 'violated' : 'satisfied', reason: check === 'background' && failed && !inventoryFailure ? 'A magenta artifact is visible at the top left.' : 'The actual final quality is acceptable.' }])),
        subjectIntegrity: { mode: 'single', source: { imageVersionId: sourceId, extent: 'complete', reason: 'The source contour is complete.' }, output: { imageVersionId: outputId, extent: 'complete', reason: 'The generated contour is complete.' }, task: { result: 'satisfied', reason: 'One complete subject is retained.' } },
        sourceRepair: { result: 'satisfied', reason: 'No missing source structure.' }, sourceCorrespondence: { result: 'satisfied', reason: 'Same colored subject.' }, styleResults: [],
        actualLayout: { imageVersionId: outputId, regions: [{ entityId: 'subject-1', name: 'Colored subject', role: 'subject', scope: 'core', rect: { x: 886 / width, y: mode === 'rejected-recheck' && !correctedCoordinates ? 0.09 : 1150 / height, width: 350 / width, height: 1476 / height } }] },
        issues: failed && !inventoryFailure ? [{ kind: 'background', check: 'background', code: 'other', reason: 'Remove the magenta artifact.', evidence: { kind: 'background-artifact', entityIds: [], imageVersionId: outputId, outputRect: { x: 0, y: 0, width: 0.05, height: 0.04 } } }] : [],
        inventory: [{ entityId: 'subject-1', status: 'retained', sourceInstances: [{ x: 0.48, y: 0.09, width: 0.19, height: 0.45 }], instances: [{ x: 886 / width, y: 1150 / height, width: 350 / width, height: 1476 / height }, ...(inventoryFailure ? [{ x: 0, y: 0, width: 0.05, height: 0.04 }] : [])], reason: inventoryFailure ? 'A duplicate foreground is visible.' : 'One subject is present.' }], newForeground: [],
      }
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] })) }
  }
  try {
    await f.service.initialize()
    let interrupted = false
    const importBytes = f.files.importBytes.bind(f.files)
    if (mode === 'resolution-resume') f.files.importBytes = async (...args) => {
      if (!interrupted && f.repository.list('run').some(run => wallpaperStateSchema.safeParse(dataOf(run).checkpoint.wallpaper).data?.items.some(item => item.attempts.at(-1)?.backgroundResolution?.status === 'enhancing'))) { interrupted = true; throw new MediaError('budget-exhausted', 'storage', false, 'Simulated storage full after the reconstructed output was computed.', 'Resume from the saved provider canvas.') }
      return await importBytes(...args)
    }
    const receipt = z.object({ runId: z.string() }).parse(await f.action('direct-crop-start', { operationId: 'preserved-' + mode, name: 'Preserved source regression', source: { kind: 'local', files: [{ path, name: 'source.png' }] } }))
    await f.jobs.drain()
    let run = f.domain.require('run', receipt.runId), item = wallpaperStateSchema.parse(dataOf(run).checkpoint.wallpaper).items[0]; assert.ok(item)
    if (mode === 'rejected-recheck') {
      assert.equal(item.status, 'needs-review'); const parentDigest = contentDigest(run), savedOutput = item.attempts.at(-1)?.outputId
      correctedCoordinates = true
      const next = z.object({ runId: z.string() }).parse(await f.action('wallpaper-continue', { runId: run.id, operationId: 'recheck-rejected-output', recheckAll: 'current' }))
      await f.jobs.drain(); assert.equal(contentDigest(f.domain.require('run', run.id)), parentDigest)
      run = f.domain.require('run', next.runId); item = wallpaperStateSchema.parse(dataOf(run).checkpoint.wallpaper).items[0]!
      assert.equal(item.status, 'passed', item.reason); assert.equal(generations, 1); assert.equal(item.attempts.at(-1)?.outputId, savedOutput)
      return
    }
    if (mode === 'resolution-resume') {
      assert.equal(interrupted, true); assert.equal(item.errorCode, 'budget-exhausted'); assert.ok(item.attempts[0]?.generatedImageId); assert.ok(item.attempts[0]?.backgroundResolution?.input.digest)
      const parentDigest = contentDigest(run)
      const next = z.object({ runId: z.string() }).parse(await f.action('wallpaper-continue', { runId: run.id, operationId: 'resume-normalized-resolution' }))
      await f.jobs.drain()
      assert.equal(contentDigest(f.domain.require('run', run.id)), parentDigest)
      run = f.domain.require('run', next.runId); item = wallpaperStateSchema.parse(dataOf(run).checkpoint.wallpaper).items[0]!
      assert.equal(generations, 1, 'Storage recovery consumes the original receipt without another paid generation')
    }
    assert.equal(specOf(run).fixed.completeCanvasPolicy, 'provider-canvas-v1'); assert.equal(specOf(run).fixed.sourcePipeline, undefined)
    if (unknown) {
      assert.equal(item.status, 'technical-failed'); assert.equal(generations, 1); assert.equal(item.attempts[0]?.generationFailure?.outcome, 'unknown'); assert.deepEqual(requests, ['1']); return
    }
    assert.equal(item.status, 'passed', JSON.stringify({ reason: item.reason, errorCode: item.errorCode, requests, attempts: item.attempts.map(attempt => ({ checks: attempt.checks, output: !!attempt.outputId, review: !!attempt.review })) }))
    assert.equal(generations, retry || transient ? 2 : 1)
    assert.deepEqual(requests, retry ? ['1', 'wallpaper-review-source-v4', 'wallpaper-review-source-v4'] : ['1', 'wallpaper-review-source-v4'])
    assert.equal(item.attempts.length, retry || transient ? 2 : 1)
    const attempt = item.attempts.at(-1); assert.ok(attempt?.review && attempt.outputId && item.originalId)
    assert.equal(attempt.compositionMode, 'generated-canvas-v1'); assert.equal(attempt.generationInput?.version, 'wallpaper-edit-input-v4'); assert.equal(attempt.generationBrief, undefined); assert.equal(attempt.preResolutionReview, undefined); assert.equal(attempt.boundaryReview, undefined)
    const review = wallpaperStoredSourceReviewV4Schema.parse(attempt.review)
    assert.equal(review.preservationProof, undefined); assert.equal(wallpaperVerdict(review), 'pass')
    const actual = f.domain.require('imageVersion', attempt.outputId), source = f.domain.require('imageVersion', item.originalId)
    const expected = attempt.backgroundResolution?.enhancedId ? await f.files.read(f.domain.require('imageVersion', attempt.backgroundResolution.enhancedId).blob) : generated
    assert.deepEqual(await sharp(await f.files.read(actual.blob)).removeAlpha().raw().toBuffer(), await sharp(expected).removeAlpha().raw().toBuffer(), 'No source or candidate pixel may be restored over the complete generated canvas')
    assert.equal((await sharp(await f.files.read(source.blob)).metadata()).width, width)
    if (mode === 'saved-recheck') {
      const parentDigest = contentDigest(run), outputId = attempt.outputId
      const child = z.object({ runId: z.string() }).parse(await f.action('wallpaper-continue', { runId: run.id, operationId: 'recheck-current-quality', recheckAll: 'current' }))
      await f.jobs.drain()
      const next = wallpaperStateSchema.parse(dataOf(f.domain.require('run', child.runId)).checkpoint.wallpaper).items[0]; assert.ok(next)
      assert.equal(next.status, 'passed', next.reason); assert.equal(generations, 1); assert.equal(next.edits, 1); assert.equal(next.attempts.at(-1)?.outputId, outputId)
      assert.equal(contentDigest(f.domain.require('run', run.id)), parentDigest)
      assert.deepEqual(requests, ['1', 'wallpaper-review-source-v4', 'wallpaper-review-source-v4'])
    }
  } finally { await f.cleanup(); await context.fiber.dispose() }
})
