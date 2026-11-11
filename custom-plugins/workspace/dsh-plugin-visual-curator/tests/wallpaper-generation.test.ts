import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import sharp from 'sharp'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore, { prepareImageFile } from '../../../../packages/attachment/attachment-local/src/index.ts'
import { CompatibleVisionProvider, MediaError } from '../src/media/index.ts'
import type { VisionConfig, VisionInput } from '../src/media/index.ts'
import { wallpaperGenerationPrompt, wallpaperGenerationReferences } from '../src/media/wallpaper-generation.ts'
import { renderWallpaper, wallpaperOverlays } from '../src/media/wallpaper-render.ts'
import { wallpaperAttemptSchema, wallpaperPlanSchema, wallpaperSettingsSchema, wallpaperSourceReviewSchema } from '../src/shared/wallpaper.ts'
import { wallpaperPromptBundle } from '../src/shared/wallpaper-prompts.ts'

const settings = wallpaperSettingsSchema.parse({ backgroundTransitionPixels: 0 })
const plan = wallpaperPlanSchema.parse({
  version: 1, imageVersionId: 'source', mode: 'group', subject: 'Two vehicles at a warm coastal overlook.', evidence: 'Native source pixels show both vehicles, a sea horizon and gravel.',
  priorities: ['Keep both complete vehicles.'], anchors: ['Keep the sea horizon continuous.'], truncations: [], uncertainties: [],
  regions: [
    { name: 'first vehicle', role: 'subject', rect: { x: 0.125, y: 0.25, width: 0.5, height: 0.5 } },
    { name: 'second vehicle', role: 'subject', rect: { x: 0.625, y: 0.375, width: 0.25, height: 0.25 } },
    { name: 'vehicle structure', role: 'critical', rect: { x: 0.25, y: 0.375, width: 0.5, height: 0.25 } },
    { name: 'tank marking', role: 'critical', rect: { x: 0.3125, y: 0.4375, width: 0.125, height: 0.125 } },
  ],
  placement: { scale: 1, left: 500, top: 1400 }, reason: 'Preserve both visible subjects and keep the horizon continuous in the editable background.',
})

function nativePixels(width: number, height: number) {
  const pixels = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 3
    pixels[offset] = (19 * x + 31 * y) % 256
    pixels[offset + 1] = (7 * x + 23 * y) % 256
    pixels[offset + 2] = (41 * x + 3 * y) % 256
  }
  return pixels
}

function pixelRectangle(pixels: Buffer, sourceWidth: number, left: number, top: number, width: number, height: number) {
  return Buffer.concat(Array.from({ length: height }, (_, y) => pixels.subarray(((top + y) * sourceWidth + left) * 3, ((top + y) * sourceWidth + left + width) * 3)))
}

test('generation references keep the masked canvas first and preserve original and detail pixels without resizing', async () => {
  const pixels = nativePixels(96, 64), original = await sharp(pixels, { raw: { width: 96, height: 64, channels: 3 } }).png().toBuffer()
  const rendered = await renderWallpaper(original, plan, settings)
  const guide = (await wallpaperOverlays(rendered.image, rendered.geometry, settings)).analysis
  const references = await wallpaperGenerationReferences(original, rendered.image, guide, plan)
  assert.deepEqual(references.map(reference => reference.role), ['canvas', 'original', 'subject-detail', 'critical-detail', 'layout-only'])
  assert.equal(references.length, 5)
  assert.strictEqual(references[0]!.data, rendered.image)
  assert.strictEqual(references[4]!.data, guide)
  assert.notDeepEqual(references[0]!.data, references[4]!.data)
  assert.equal(references[0]!.mediaType, 'image/png')
  assert.equal(references[1]!.mediaType, 'image/webp')
  assert.equal(references[2]!.mediaType, 'image/png')
  assert.equal(references[3]!.mediaType, 'image/png')
  assert.equal(references[4]!.mediaType, 'image/png')
  const canvas = await sharp(references[0]!.data).metadata(), mask = await sharp(rendered.mask).metadata()
  assert.deepEqual({ width: mask.width, height: mask.height }, { width: canvas.width, height: canvas.height })
  const maskAlpha = await sharp(rendered.mask).extractChannel('alpha').raw().toBuffer()
  assert.equal(maskAlpha[1428 * settings.width + 530], 255)
  assert.equal(maskAlpha[0], 0)
  const canvasPixel = await sharp(references[0]!.data).extract({ left: 530, top: 1428, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
  assert.deepEqual(canvasPixel, pixelRectangle(pixels, 96, 30, 28, 1, 1))
  assert.deepEqual(await sharp(references[1]!.data).raw().toBuffer(), pixels)
  assert.deepEqual(await sharp(references[2]!.data).raw().toBuffer(), pixelRectangle(pixels, 96, 12, 16, 72, 32))
  assert.deepEqual(await sharp(references[3]!.data).raw().toBuffer(), pixelRectangle(pixels, 96, 30, 28, 12, 8))
  assert.deepEqual(references[2]!.sourceRect, { x: 0.125, y: 0.25, width: 0.75, height: 0.5 })
  assert.deepEqual(references[3]!.sourceRect, { x: 0.3125, y: 0.4375, width: 0.125, height: 0.125 })
  for (const [index, dimensions] of [[2, { width: 72, height: 32 }], [3, { width: 12, height: 8 }]] as const) {
    const metadata = await sharp(references[index]!.data).metadata()
    assert.equal(metadata.format, 'png')
    assert.deepEqual({ width: metadata.width, height: metadata.height }, dimensions)
  }
})

test('lossless original reference transport preserves native RGBA pixels and uses the unchanged attachment admission policy', async () => {
  const width = 96, height = 64, rgb = nativePixels(width, height), pixels = Buffer.alloc(width * height * 4)
  for (let index = 0; index < width * height; index++) {
    pixels.set(rgb.subarray(index * 3, index * 3 + 3), index * 4)
    pixels[index * 4 + 3] = index % 256
  }
  const original = await sharp(pixels, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer(), before = Buffer.from(original)
  const canvas = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#56789a' } }).png().toBuffer()
  const references = await wallpaperGenerationReferences(original, canvas, canvas, plan), reference = references[1]!
  const decoded = await sharp(reference.data).raw().toBuffer({ resolveWithObject: true })
  assert.equal(reference.mediaType, 'image/webp'); assert.equal(reference.name, 'wallpaper-original.webp')
  assert.deepEqual({ width: decoded.info.width, height: decoded.info.height, channels: decoded.info.channels }, { width, height, channels: 4 })
  assert.deepEqual(decoded.data, pixels, 'Lossless transport must preserve RGB even underneath fully transparent pixels')
  assert.deepEqual(original, before)
  const attachments = new LocalAttachmentStore(new Context(), { maxImageBytes: original.byteLength - 1 })
  assert(reference.data.byteLength < attachments.imageLimits.maxImageBytes)
  await assert.rejects(prepareImageFile({ data: original, mediaType: 'image/png' }, attachments.imageLimits, attachments.normalizationPolicy), { code: 'IMAGE_TOO_LARGE' })
  const admitted = await prepareImageFile(reference, attachments.imageLimits, attachments.normalizationPolicy)
  assert.deepEqual({ width: admitted.ref.width, height: admitted.ref.height }, { width, height })
  assert.deepEqual(attachments.normalizationPolicy, { maxPixels: 4194304, maxDimension: 8192, maxBytes: 4194304 })
  await assert.rejects(prepareImageFile(reference, { ...attachments.imageLimits, maxImageBytes: reference.data.byteLength - 1 }, attachments.normalizationPolicy), { code: 'IMAGE_TOO_LARGE' })
  await assert.rejects(prepareImageFile(reference, { ...attachments.imageLimits, maxImagePixels: width * height - 1 }, attachments.normalizationPolicy), { code: 'IMAGE_TOO_MANY_PIXELS' })
})

test('scene-specific editing retains the latest failed checks and labels the guide as auxiliary', () => {
  const editPrompt = 'Keep the black motorcycles, readable tank markings and wheel geometry intact. Extend the warm coastal sky and gravel using the original low side light. Join both sides of the sea horizon without rectangular bands or doubled coastline.'
  const scenePlan = { ...plan, editPrompt }
  const review = wallpaperSourceReviewSchema.parse({
    subject: 'The original coastal vehicles remain visible.', reviewVersion: 'wallpaper-review-source-v1', styleResults: [],
    checks: { subject: { result: 'satisfied', reason: 'Both vehicles are complete.' }, protection: { result: 'satisfied', reason: 'The vehicles fit inside the safe area.' }, clock: { result: 'satisfied', reason: 'The clock clears the vehicles.' }, readability: { result: 'satisfied', reason: 'The clock contrasts with the sky.' }, composition: { result: 'satisfied', reason: 'The vehicles remain the focal content.' }, background: { result: 'violated', reason: 'The sea horizon has horizontal ghost bands on both sides.' }, style: { result: 'violated', reason: 'The extension changes the original gray cloud color.' }, clarity: { result: 'unknown', reason: 'The wheel spokes are not resolved by the current output pixels.' } },
    issues: [{ kind: 'background', reason: 'The sea horizon has horizontal ghost bands on both sides.' }],
    subjectIntegrity: { mode: 'group', source: { extent: 'complete', reason: 'Both vehicles are in the original frame.', imageVersionId: 'source' }, output: { extent: 'complete', reason: 'Both vehicles remain in the output frame.', imageVersionId: 'output' }, task: { result: 'violated', reason: 'The background continuity requirement is unmet.' } },
  })
  const previous = wallpaperAttemptSchema.parse({ revision: 1, plan, checks: [], needsOutpaint: true, review: { ...review, checks: { ...review.checks, background: { result: 'violated', reason: 'A superseded cloud seam.' } } } })
  const latest = wallpaperAttemptSchema.parse({ revision: 2, plan: scenePlan, checks: [], needsOutpaint: true, review })
  const current = wallpaperAttemptSchema.parse({ revision: 3, plan: scenePlan, checks: [], needsOutpaint: true })
  const referenceRoles = [
    { role: 'canvas', width: 1845, height: 3280 }, { role: 'original', width: 96, height: 64 },
    { role: 'subject-detail', width: 72, height: 32, sourceRect: { x: 0.125, y: 0.25, width: 0.75, height: 0.5 } },
    { role: 'critical-detail', width: 12, height: 8, sourceRect: { x: 0.3125, y: 0.4375, width: 0.125, height: 0.125 } },
    { role: 'layout-only', width: 1845, height: 3280 },
  ] as const
  const instruction = wallpaperPromptBundle().outpaint.text
  const prompt = wallpaperGenerationPrompt(instruction, scenePlan, settings, referenceRoles, [previous, latest, current])
  const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1))
  assert.equal(payload.sceneEditPrompt, editPrompt)
  assert.deepEqual(payload.referenceRoles, referenceRoles.map((reference, index) => ({ image: index + 1, ...reference })))
  assert.equal(payload.referenceRoles[0].role, 'canvas')
  assert.equal(payload.referenceRoles[4].role, 'layout-only')
  assert.deepEqual(payload.previousDefects, [
    { check: 'background', result: 'violated', reason: review.checks.background.reason },
    { check: 'style', result: 'violated', reason: review.checks.style.reason },
    { check: 'clarity', result: 'unknown', reason: review.checks.clarity.reason },
  ])
  assert.deepEqual(payload.protectedRegions, scenePlan.regions)
  assert.deepEqual(payload.placement, scenePlan.placement)
  assert.deepEqual(payload.template, { width: 1845, height: 3280, safe: settings.safe, topBuffer: settings.topBuffer })
  assert.doesNotMatch(prompt, /雪地应沿|脚印与车辙/)
  assert.doesNotMatch(prompt, /A superseded cloud seam/)

  const legacy = wallpaperGenerationPrompt(instruction, plan, settings, referenceRoles, [])
  const legacyPayload = JSON.parse(legacy.slice(legacy.lastIndexOf('\n') + 1))
  assert.deepEqual(legacyPayload.sceneEditPrompt, { subject: plan.subject, evidence: plan.evidence, priorities: plan.priorities, anchors: plan.anchors, reason: plan.reason })
  assert.deepEqual(legacyPayload.previousDefects, [])
  assert.equal(plan.editPrompt, undefined)
})

test('legacy plans remain decodable while plan v6 requires the model scene edit brief and rejects placement', async () => {
  const bytes = await sharp(nativePixels(96, 64), { raw: { width: 96, height: 64, channels: 3 } }).png().toBuffer()
  const config: VisionConfig = { endpoint: 'https://vision.example.test/v1/chat/completions', model: 'fixture-vision', supportsMultiImage: true, maxImages: 1, maxImageBytes: 65536, maxRequestBytes: 1024 * 1024, maxOutputTokens: 2048, temperature: 0 }
  const provider = (output: object) => new CompatibleVisionProvider(config, { async request() { return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] })) } } })
  const bounds = { maxBytes: 65536, timeoutMs: 5000, maxRedirects: 0 }
  const input: VisionInput = { requestId: 'plan-request', taskBrief: 'Preserve the original coastal vehicles.', rules: [], images: [{ imageVersionId: 'source', digest: createHash('sha256').update(bytes).digest('hex'), mime: 'image/png', bytes, role: 'wallpaper-original' }] }
  const { placement: _placement, ...observation } = plan
  for (const version of ['wallpaper-plan-v1', 'wallpaper-plan-v2', 'wallpaper-plan-v3', 'wallpaper-plan-v4', 'wallpaper-plan-v5'] as const) {
    const output = version === 'wallpaper-plan-v4' || version === 'wallpaper-plan-v5' ? observation : plan
    const prompts = wallpaperPromptBundle('wallpaper-review-v4', version)
    assert.deepEqual(await provider(output).wallpaper({ ...input, wallpaperPrompt: prompts.plan }, 'wallpaper-plan', bounds), output)
    assert.equal(prompts.outpaint.version, 'wallpaper-outpaint-v3')
  }
  const wallpaperPrompt = wallpaperPromptBundle().plan
  assert.equal(wallpaperPrompt.version, 'wallpaper-plan-v6')
  await assert.rejects(provider(observation).wallpaper({ ...input, wallpaperPrompt }, 'wallpaper-plan', bounds), (error: unknown) => error instanceof MediaError && error.code === 'vision-invalid-output' && error.diagnostics?.issues.some(issue => issue.includes('editPrompt')) === true)
  const complete = { ...observation, editPrompt: 'Continue the real coastal sky and gravel while preserving both vehicles and the sea horizon.' }
  assert.deepEqual(await provider(complete).wallpaper({ ...input, wallpaperPrompt }, 'wallpaper-plan', bounds), complete)
  await assert.rejects(provider({ ...complete, placement: plan.placement }).wallpaper({ ...input, wallpaperPrompt }, 'wallpaper-plan', bounds), (error: unknown) => error instanceof MediaError && error.code === 'vision-invalid-output')
})
