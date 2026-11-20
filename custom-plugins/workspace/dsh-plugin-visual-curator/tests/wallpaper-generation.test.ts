import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import sharp from 'sharp'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore, { prepareImageFile } from '../../../../packages/attachment/attachment-local/src/index.ts'
import { CompatibleVisionProvider, MediaError } from '../src/media/index.ts'
import type { VisionConfig, VisionInput } from '../src/media/index.ts'
import { wallpaperCompleteCanvasPrompt, wallpaperGenerationPrompt, wallpaperGenerationReferences, wallpaperOriginalScenePrompt, wallpaperPositionedGenerationReferences, wallpaperStackedGroupGuide, wallpaperTextureCanvasPrompt, wallpaperUsesFullFrameTexture } from '../src/media/wallpaper-generation.ts'
import { wallpaperPromptPreparationPolicySchema } from '../src/shared/wallpaper-generation-brief.ts'
import { renderWallpaper, wallpaperOverlays, wallpaperSourceSeams, wallpaperGeneratedFrameSeams, wallpaperPositionedSeamRegions, wallpaperSameFullFrame } from '../src/media/wallpaper-render.ts'
import { fitWallpaperPlacement, wallpaperPositionedLayout } from '../src/shared/wallpaper-geometry.ts'
import { wallpaperAttemptSchema, wallpaperGenerationInputSchema, wallpaperPlanSchema, wallpaperSettingsSchema, wallpaperSourceReviewSchema } from '../src/shared/wallpaper.ts'
import { wallpaperPromptBundle } from '../src/shared/wallpaper-prompts.ts'
import { resolveWallpaperProcessing } from '../src/shared/wallpaper-policy.ts'

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

test('a wide abstract pattern is reframed as a full portrait texture without carrying the old picture frame', () => {
  const original = { width: 1672, height: 941 }
  const abstract = wallpaperPlanSchema.parse({
    ...plan, mode: 'abstract', subject: '层叠纸艺', regions: [], objectRoles: [], actionPartIds: [],
    anchors: ['浅色纸带跨越画面'], priorities: ['保留半透明纸张、暖红与藏蓝'],
    editPrompt: '统一恢复到图1的旧位置，保留横向矩形内全部原图像素。',
  })
  assert.equal(wallpaperUsesFullFrameTexture(abstract, original, settings), true)
  const prompt = wallpaperTextureCanvasPrompt(abstract, settings, ['图1中部的旧矩形有接缝'])
  assert.match(prompt, /1845×3280竖幅/)
  assert.match(prompt, /半透明纸张、暖红与藏蓝/)
  assert.match(prompt, /纹理在整幅图中连贯流动并自然延伸到四边/)
  assert.match(prompt, /不要嵌入整张原图/)
  assert.match(prompt, /消除内嵌贴片和断纹/)
  assert.doesNotMatch(prompt, /图1|蒙版|安全区规划图/)

  assert.equal(wallpaperUsesFullFrameTexture(abstract, { width: 941, height: 1672 }, settings), false)
  assert.equal(wallpaperUsesFullFrameTexture(abstract, original, { width: 900, height: 1000 }), false)
  assert.equal(wallpaperUsesFullFrameTexture({ ...abstract, mode: 'scene' }, original, settings), false)
  assert.equal(wallpaperUsesFullFrameTexture({ ...abstract, regions: plan.regions }, original, settings), false)
  assert.equal(wallpaperUsesFullFrameTexture({ ...abstract, objectRoles: undefined }, original, settings), false)
  assert.equal(wallpaperUsesFullFrameTexture(plan, original, settings), false)
})

test('an original-only scene prompt carries planned output coordinates and only the verified adapted edge', () => {
  const source = { width: 1000, height: 1600 }
  const current = wallpaperSettingsSchema.parse({ ...settings, processing: { acceptance: { version: 'practical-v2' } } })
  const planning = wallpaperPlanSchema.parse({
    ...plan, mode: 'single', subject: 'A violinist with a cropped coat sleeve.',
    regions: [{ entityId: 'violinist', name: 'violinist', role: 'subject', rect: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 } }],
    placement: { scale: 1, left: 500, top: 1400, adaptedSourceEdges: [{ entityId: 'violinist', edge: 'left', detail: 'clothing-edge' }] },
  })
  const layout = wallpaperPositionedLayout(planning, source, current)
  const prompt = wallpaperOriginalScenePrompt(planning, current, layout)
  assert.ok(prompt.includes(JSON.stringify({ protectedNormalized: layout.protectedNormalized, positionedRegions: layout.positionedRegions })))
  assert.ok(prompt.includes(JSON.stringify([{ entityId: 'violinist', edge: 'left', feature: '已有衣料外缘' }])))
  assert.match(prompt, /完整可见车身和关键结构全部位于区内.*97%/)
  assert.doesNotMatch(prompt, /图1|蒙版|已有重复结构最后一片的外缘/)
})

test('an original-only scene retry changes the prompt with the rejected candidate’s measured layout', () => {
  const layout = wallpaperPositionedLayout(plan, { width: 1000, height: 1600 }, settings)
  const first = wallpaperOriginalScenePrompt(plan, settings, layout)
  const rejectedLayout = { checks: ['subject-center-drift:35,-381'], actualCore: [{ name: 'first vehicle', rect: { x: 0.43, y: 0.29, width: 0.31, height: 0.28 } }] }
  const retry = wallpaperOriginalScenePrompt(plan, settings, layout, rejectedLayout)
  assert.notEqual(retry, first)
  assert.ok(retry.includes(JSON.stringify(rejectedLayout)))
  assert.ok(retry.includes(JSON.stringify({ protectedNormalized: layout.protectedNormalized, positionedRegions: layout.positionedRegions })))
  assert.doesNotMatch(retry, /图1|蒙版/)
})

test('original-only correction states the desired position and movement without repeating the rejected coordinates', () => {
  const current = wallpaperSettingsSchema.parse({ ...settings, processing: { acceptance: { version: 'practical-v2' } } })
  const planning = wallpaperPlanSchema.parse({
    ...plan, mode: 'single', subject: 'A dish of cherries on a wooden counter.',
    regions: [{ entityId: 'fruit', name: '主盘车厘子', role: 'subject', rect: { x: 0.23, y: 0.44, width: 0.54, height: 0.26 } }],
    placement: { scale: 1, left: 0, top: 0 },
  })
  const layout = wallpaperPositionedLayout(planning, current, current)
  const rejectedLayout = { checks: ['subject-center-drift:111,-426'], actualCore: [{ entityId: 'fruit', name: '中央车厘子', rect: { x: 0.31, y: 0.31, width: 0.50, height: 0.26 } }] }
  const prompt = wallpaperOriginalScenePrompt(planning, current, layout, rejectedLayout, 'focal-target-v1')
  assert.match(prompt, /成品高度57\.0%，上缘在44\.0%，下缘在70\.0%/)
  assert.match(prompt, /向左移约画宽的6\.0%、向下移约画高的13\.0%/)
  assert.match(prompt, /主盘车厘子的主体核心位于横向23\.0%–77\.0%、纵向44\.0%–70\.0%/)
  assert.doesNotMatch(prompt, /中央车厘子|actualCore|subject-center-drift|图1|蒙版/)
})

test('pure overflow changes the automatic prompt and fits the whole visible structure together', () => {
  const current = wallpaperSettingsSchema.parse({ ...settings, processing: resolveWallpaperProcessing() })
  const planning = wallpaperPlanSchema.parse({ ...plan, mode: 'single', subject: 'Orbital station and connected panels', placement: { scale: 1, left: 0, top: 0 },
    regions: [{ name: 'Station', entityId: 'station', role: 'subject', rect: { x: 0.25, y: 0.44, width: 0.5, height: 0.25 } }],
  })
  const layout = wallpaperPositionedLayout(planning, current, current)
  const initial = wallpaperOriginalScenePrompt(planning, current, layout, undefined, 'focal-target-v2')
  const corrected = wallpaperOriginalScenePrompt(planning, current, layout, { checks: ['subject-overflow:Station'], actualCore: [
    { name: 'Station', entityId: 'station', role: 'subject', rect: { x: 0.25, y: 0.44, width: 0.5, height: 0.25 }, outline: { x: 0.01, y: 0.44, width: 0.98, height: 0.25 } },
  ] }, 'focal-target-v2')
  assert.notEqual(corrected, initial)
  assert.match(corrected, /完整轮廓控制在横向21\.2%–78\.8%/)
  assert.match(corrected, /所有相连结构跟随主体/)
})

test('an original-only group correction leaves breathing room below the complete base', () => {
  const current = wallpaperSettingsSchema.parse({ ...settings, processing: resolveWallpaperProcessing() })
  const subjects = [
    { name: 'Three-part table including the base', entityId: 'table', role: 'subject' as const, rect: { x: 0.31, y: 0.51, width: 0.38, height: 0.31 } },
    { name: 'Sculpture', entityId: 'sculpture', role: 'subject' as const, rect: { x: 0.39, y: 0.322, width: 0.14, height: 0.125 } },
  ]
  const planning = wallpaperPlanSchema.parse({ ...plan, mode: 'group', subject: 'A three-part table and sculpture', placement: { scale: 1, left: 0, top: 0 }, regions: subjects })
  const prompt = wallpaperOriginalScenePrompt(planning, current, wallpaperPositionedLayout(planning, current, current), {
    checks: ['subject-overflow:Three-part table including the base'], actualCore: [
      { ...subjects[0]!, rect: { x: 0.279, y: 0.519, width: 0.456, height: 0.401 } }, subjects[1]!,
    ],
  }, 'focal-target-v2')
  assert.match(prompt, /下缘在77\.7%/)
  assert.match(prompt, /画布下沿留约22\.3%画高/)
  assert.match(prompt, /Three-part table including the base的主体核心位于/)
  assert.doesNotMatch(prompt, /按上一版尺寸|向[上下左右]移|图1|蒙版/)
})

test('a stacked group has one complete-outline guide and a measured bottom miss moves the correction up', async () => {
  const current = wallpaperSettingsSchema.parse({ ...settings, processing: resolveWallpaperProcessing() })
  const roles = [
    { entityId: 'head', name: 'Sculpture', rect: { x: 0.389, y: 0.322, width: 0.14, height: 0.125 } },
    { entityId: 'table', name: 'Table with base', rect: { x: 0.31, y: 0.51, width: 0.38, height: 0.31 } },
  ]
  const planning = wallpaperPlanSchema.parse({ ...plan, subject: 'Stacked room objects', regions: roles.map(region => ({ ...region, role: 'subject' })),
    objectRoles: roles.map(region => ({ ...region, role: 'primary', safetyClass: 'general', sourceEdges: [], evidence: 'Both outlines are visible through the top and base.',
      sourceIntent: { framing: 'whole', visibility: 'visible', preserve: ['Complete outlines.'], relationships: ['The sculpture sits on the table.'] } })),
  })
  const layout = wallpaperPositionedLayout(planning, current, current)
  const first = await wallpaperStackedGroupGuide(planning, current, layout)
  const corrected = await wallpaperStackedGroupGuide(planning, current, layout, {
    checks: ['subject-overflow:Table with base'], actualCore: [{ ...roles[0]!, role: 'subject' }, { ...roles[1]!, role: 'subject', rect: { x: 0.32, y: 0.568, width: 0.386, height: 0.304 } }],
  })
  assert.ok(first && corrected)
  const frame = await sharp(corrected.reference.data).metadata()
  assert.equal(frame.width, current.width); assert.equal(frame.height, current.height)
  assert.equal(corrected.reference.role, 'layout-only')
  assert.notDeepEqual(first.reference.data, corrected.reference.data)
  assert.match(first.instructions, /最低点到底边约留24\.8%/)
  assert.match(corrected.instructions, /最低点到底边约留27\.4%/)
  const prompt = wallpaperOriginalScenePrompt(planning, current, layout, undefined, 'focal-target-v3', [], corrected.instructions)
  assert.match(prompt, /图1确定成品构图，图2提供原场景外观/)
  assert.match(prompt, /保持原来的视角、上下承托关系和形状比例/)
  assert.equal(await wallpaperStackedGroupGuide(wallpaperPlanSchema.parse({ ...planning, objectRoles: planning.objectRoles?.map(object => ({ ...object, sourceEdges: ['bottom'] })) }), current, layout), undefined)
})

test('the grouped edit receipt binds a first layout guide and one original without a mask', () => {
  const guide = { role: 'layout-only', attachmentId: 'guide', width: 1845, height: 3280 }
  const original = { role: 'original', attachmentId: 'original', width: 2010, height: 3520 }
  const input = { version: 'wallpaper-edit-input-v7', prompt: 'Use the geometry-only guide and the original appearance.', references: [guide, original] }
  assert.equal(wallpaperGenerationInputSchema.safeParse(input).success, true)
  assert.equal(wallpaperGenerationInputSchema.safeParse({ ...input, references: [original, guide] }).success, false)
  assert.equal(wallpaperGenerationInputSchema.safeParse({ ...input, mask: { attachmentId: 'mask', width: 1845, height: 3280 } }).success, false)
})

test('pixel corroboration accepts a full-frame resize and rejects a visible repositioning', async () => {
  const block = await sharp({ create: { width: 36, height: 42, channels: 3, background: '#fca0a0' } }).png().toBuffer()
  const frame = (left: number) => sharp({ create: { width: 180, height: 320, channels: 3, background: '#152e22' } }).composite([{ input: block, left, top: 112 }]).png().toBuffer()
  const native = await frame(45)
  const delivery = await sharp(native).resize(360, 640).png().toBuffer()
  assert.equal(await wallpaperSameFullFrame(native, delivery), true)
  assert.equal(await wallpaperSameFullFrame(native, await frame(60)), false)
})

test('previous safe placement guides a seam-only repair and the integral accessory stays on the canvas', () => {
  const core = { x: 0.24, y: 0.42, width: 0.50, height: 0.30 }
  const planning = wallpaperPlanSchema.parse({
    ...plan, mode: 'single', subject: 'A leather handbag with a gold chain on a display stand.',
    regions: [{ entityId: 'bag', name: '绿色手袋', role: 'subject', safetyClass: 'general', rect: core }],
    objectRoles: [{ entityId: 'bag', name: '绿色手袋', role: 'primary', safetyClass: 'general', rect: core, sourceEdges: [], evidence: 'The bag is the product on display.',
      sourceIntent: { framing: 'whole', visibility: 'visible', preserve: ['Chain from top attachment to the loose end.'], relationships: ['The chain hangs from the bag.'], visibleAccessoryExtent: { x: 0.24, y: 0.46, width: 0.50, height: 0.49 } },
    }],
    placement: { scale: 1, left: 0, top: 0 },
  })
  const layout = wallpaperPositionedLayout(planning, settings, settings)
  const safePrior = { checks: [], actualCore: [{ entityId: 'bag', name: '橄榄色链包', rect: { x: 0.25, y: 0.43, width: 0.48, height: 0.28 } }] }
  const prompt = wallpaperOriginalScenePrompt(planning, settings, layout, safePrior, 'focal-target-v1')
  assert.match(prompt, /上一版已核实的主体位置与尺度合格/)
  assert.match(prompt, /绿色手袋的主体核心位于横向25\.0%–73\.0%、纵向43\.0%–71\.0%/)
  assert.match(prompt, /从接点到最后一环或末端都须保留在完整画框内。主体核心下缘之下约需留出画高的21\.5%/)
  assert.doesNotMatch(prompt, /蒙版|成品归一化坐标/)
  const wholeScene = wallpaperOriginalScenePrompt(planning, settings, layout, safePrior, 'focal-target-v2')
  assert.match(wholeScene, /从画布上沿到主体核心组最高轮廓留约43\.0%画高，从主体核心组最低轮廓到画布下沿留约29\.0%画高/)
  assert.ok(wholeScene.indexOf('最终构图') < wholeScene.indexOf('场景：'))
  assert.match(wholeScene, /绿色手袋的主体核心位于横向25\.0%–73\.0%、纵向43\.0%–71\.0%/)
  assert.doesNotMatch(prompt, /从画布上沿到主体核心组最高轮廓/)

  const positioned = wallpaperCompleteCanvasPrompt(planning, settings, [], undefined, layout)
  assert.match(positioned, /绿色手袋的主体核心位于横向24\.0%–74\.0%、纵向42\.0%–72\.0%/)
  assert.match(positioned, /主体核心下缘之下约需留出画高的23\.0%/)
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
  assert.deepEqual(payload.template, { width: 1845, height: 3280, safe: settings.safe, topBuffer: 0 })
  assert.doesNotMatch(prompt, /雪地应沿|脚印与车辙/)
  assert.doesNotMatch(prompt, /A superseded cloud seam/)

  const legacy = wallpaperGenerationPrompt(instruction, plan, settings, referenceRoles, [])
  const legacyPayload = JSON.parse(legacy.slice(legacy.lastIndexOf('\n') + 1))
  assert.deepEqual(legacyPayload.sceneEditPrompt, { subject: plan.subject, evidence: plan.evidence, priorities: plan.priorities, anchors: plan.anchors, reason: plan.reason })
  assert.deepEqual(legacyPayload.previousDefects, [])
  assert.equal(plan.editPrompt, undefined)
})

test('single-canvas edits distinguish requested native output from normalized input and template coordinates', () => {
  const references = [{ role: 'canvas' as const, width: 1536, height: 2730 }]
  const current = { ...plan, editPrompt: 'Extend the existing coastal scene.' }
  const prompt = wallpaperGenerationPrompt('Keep original pixels.', current, settings, references, [], { width: 941, height: 1672 })
  const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1))
  assert.deepEqual(payload.output, { size: '1872x3328', quality: 'high' })
  assert.deepEqual(payload.canvas, references[0])
  assert.deepEqual(payload.template, { width: 1845, height: 3280, safe: settings.safe, topBuffer: 0 })
  const clockSettings = wallpaperSettingsSchema.parse({ ...settings, processing: { clockContrast: {} } })
  const clockPrompt = wallpaperGenerationPrompt('Keep original pixels.', current, clockSettings, references, [], { width: 941, height: 1672 })
  assert.equal(JSON.parse(clockPrompt.slice(clockPrompt.lastIndexOf('\n') + 1)).template.topBuffer, 32)
  assert.match(prompt, /1872x3328/)
  assert.match(prompt, /high/)
  const custom = wallpaperGenerationPrompt('Keep original pixels.', current, { ...settings, imageSize: '2048x3072', imageQuality: 'medium' }, references, [], { width: 941, height: 1672 })
  assert.deepEqual(JSON.parse(custom.slice(custom.lastIndexOf('\n') + 1)).output, { size: '2048x3072', quality: 'medium' })
  const legacy = wallpaperGenerationPrompt('Frozen legacy instructions.', current, settings, references, [])
  assert.equal(JSON.parse(legacy.slice(legacy.lastIndexOf('\n') + 1)).output, undefined)
})

test('opaque edit canvases preserve the complete frame and source placement while the separate mask owns editability', async () => {
  const original = await sharp({ create: { width: 320, height: 480, channels: 3, background: '#416e92' } }).png().toBuffer()
  const canvas = await sharp({ create: { width: 1845, height: 3280, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: original, left: 500, top: 1400 }]).png().toBuffer()
  const [reference] = await wallpaperGenerationReferences(original, canvas, canvas, plan, 'opaque')
  const pixels = await sharp(reference!.data).raw().toBuffer({ resolveWithObject: true })
  assert.deepEqual({ width: pixels.info.width, height: pixels.info.height, channels: pixels.info.channels }, { width: 1845, height: 3280, channels: 3 })
  assert.deepEqual([...pixels.data.subarray(0, 3)], [128, 128, 128])
  const retained = await sharp(reference!.data).extract({ left: 500, top: 1400, width: 320, height: 480 }).raw().toBuffer()
  assert.deepEqual(retained, await sharp(original).raw().toBuffer())
  const [legacy] = await wallpaperGenerationReferences(original, canvas, canvas, plan, true)
  assert.equal((await sharp(legacy!.data).metadata()).hasAlpha, true)
})

test('standalone generated canvases retain one complete image instead of pasting a second source over it', async () => {
  const sourcePixels = nativePixels(320, 480)
  const original = await sharp(sourcePixels, { raw: { width: 320, height: 480, channels: 3 } }).png().toBuffer()
  const generated = await sharp({ create: { width: 1845, height: 3280, channels: 3, background: '#c17d43' } }).png().toBuffer()
  const sourceLockSettings = wallpaperSettingsSchema.parse({ ...settings, backgroundContextPixels: 0 })
  const result = await renderWallpaper(original, plan, sourceLockSettings, generated, 'generated-canvas-v1')
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  const expected = digest(await sharp(generated).raw().toBuffer())
  assert.equal(digest(await sharp(result.image).removeAlpha().raw().toBuffer()), expected)
  for (const mode of ['protected-context-v2', 'generated-canvas-protected-v2'] as const) await assert.rejects(renderWallpaper(original, plan, sourceLockSettings, generated, mode), /overlays are disabled/)
  const translucent = await sharp({ create: { width: 1845, height: 3280, channels: 4, background: { r: 193, g: 125, b: 67, alpha: 0.5 } } }).png().toBuffer()
  assert.equal((await sharp((await renderWallpaper(original, plan, sourceLockSettings, translucent, 'generated-canvas-v1')).image).stats()).isOpaque, false, 'An incomplete provider canvas cannot be concealed by restoring opaque source pixels')
})

test('source-edge continuity catches a hard generated seam without rejecting an unbroken edge', async () => {
  const source = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#205080' } }).png().toBuffer()
  const extension = await sharp({ create: { width: 64, height: 8, channels: 3, background: '#f0d0a0' } }).png().toBuffer()
  const broken = await sharp(source).composite([{ input: extension, left: 0, top: 0 }]).png().toBuffer()
  const target = { left: 0, top: 8, width: 64, height: 56 }
  assert.deepEqual(await wallpaperSourceSeams(source, target, settings), [])
  assert.deepEqual((await wallpaperSourceSeams(broken, target, settings)).map(seam => seam.edge), ['top'])
})

test('native generated-frame check finds an authorized hard cut before super-resolution', async () => {
  const outside = await sharp({ create: { width: 120, height: 200, channels: 3, background: '#f0d0a0' } }).png().toBuffer()
  const inside = await sharp({ create: { width: 40, height: 60, channels: 3, background: '#205080' } }).png().toBuffer()
  const broken = await sharp(outside).composite([{ input: inside, left: 10, top: 20 }]).png().toBuffer()
  const target = { left: 20, top: 40, width: 80, height: 120 }
  const canvas = { width: 240, height: 400 }, native = { width: 120, height: 200 }
  const seams = await wallpaperGeneratedFrameSeams(broken, target, canvas, native, ['top'], settings)
  assert.deepEqual(seams.map(seam => seam.edge), ['top'])
  assert.deepEqual(await wallpaperGeneratedFrameSeams(broken, target, canvas, native, [], settings), [])
  assert.deepEqual(await wallpaperGeneratedFrameSeams(outside, target, canvas, native, ['top'], settings), [])
  const feathered = await sharp(broken).composite([{ input: await sharp({ create: { width: 40, height: 1, channels: 3, background: '#a09070' } }).png().toBuffer(), left: 10, top: 19 }]).png().toBuffer()
  assert.deepEqual((await wallpaperSourceSeams(feathered, { left: 10, top: 20, width: 40, height: 60 }, settings)).filter(seam => seam.edge === 'top'), [])
  assert.deepEqual((await wallpaperGeneratedFrameSeams(feathered, target, canvas, native, ['top'], settings)).map(seam => seam.edge), ['top'])
})

test('native seam screen sends aligned paired cuts for confirmation and leaves a single natural edge alone', async () => {
  const canvas = { ...settings, width: 400, height: 600 }
  const target = { left: 64, top: 80, width: 272, height: 400 }
  const base = await sharp({ create: { width: 200, height: 300, channels: 3, background: '#d7bfb0' } }).png().toBuffer()
  const stripe = await sharp({ create: { width: 136, height: 116, channels: 3, background: '#254362' } }).png().toBuffer()
  const paired = await sharp(base).composite([{ input: stripe, left: 33, top: 72 }]).png().toBuffer()
  const stripToEdge = await sharp({ create: { width: 168, height: 300, channels: 3, background: '#254362' } }).png().toBuffer()
  const single = await sharp(base).composite([{ input: stripToEdge, left: 32, top: 0 }]).png().toBuffer()
  const details = await wallpaperPositionedSeamRegions(paired, target, canvas)
  assert.equal(details.length, 2)
  assert.ok(details[0]!.x < 0.16 && details[1]!.x > 0.5)
  assert.deepEqual(await wallpaperPositionedSeamRegions(single, target, canvas, undefined, 'positioned-edge-v2'), [])
  assert.deepEqual(await wallpaperPositionedSeamRegions(base, target, canvas, undefined, 'positioned-edge-v2'), [])
})

test('source-restoring composition is forbidden even for a narrow generated margin', async () => {
  const source = await sharp({ create: { width: settings.width, height: settings.height - 8, channels: 3, background: '#205080' } }).png().toBuffer()
  const generated = await sharp({ create: { width: settings.width, height: settings.height, channels: 3, background: '#f0d0a0' } }).png().toBuffer()
  const sourcePlan = { ...plan, placement: { scale: 1, left: 0, top: 8 }, regions: [] }
  await assert.rejects(renderWallpaper(source, sourcePlan, settings, generated, 'generated-canvas-protected-v2'), /overlays are disabled/)
})

test('wide margins cannot enable the retired source restoration compositor', async () => {
  const source = await sharp({ create: { width: settings.width - 200, height: settings.height - 100, channels: 3, background: '#205080' } }).png().toBuffer()
  const generated = await sharp({ create: { width: settings.width, height: settings.height, channels: 3, background: '#f0d0a0' } }).png().toBuffer()
  const sourcePlan = { ...plan, placement: { scale: 1, left: 100, top: 100 }, regions: [] }
  await assert.rejects(renderWallpaper(source, sourcePlan, settings, generated, 'generated-canvas-protected-v2'), /overlays are disabled/)
})

test('a full-size source moves only far enough to put its complete subject inside the safe area', () => {
  const region = { name: 'complete glass', rect: { x: 0.39, y: 0.305, width: 0.4, height: 0.463 } }
  const { placement: _placement, ...observed } = { ...plan, regions: [{ ...region, role: 'subject' as const }, { ...region, role: 'critical' as const }] }
  const minimal = fitWallpaperPlacement({ width: 1845, height: 3280 }, observed, settings, 'source-preserving-v3')
  const centered = fitWallpaperPlacement({ width: 1845, height: 3280 }, observed, settings, 'subject-first-v2')
  assert.deepEqual(minimal, { scale: 1, left: 0, top: 32 })
  assert.ok(centered.top > minimal.top)
})

test('new prompt preparation freezes the complete generated canvas while saved V1 and V2 policies remain decodable', () => {
  assert.equal(wallpaperPromptPreparationPolicySchema.parse({}).version, 'style-brief-v3')
  assert.equal(wallpaperPromptPreparationPolicySchema.parse({ version: 'style-brief-v1' }).version, 'style-brief-v1')
  assert.equal(wallpaperPromptPreparationPolicySchema.parse({ version: 'style-brief-v2' }).version, 'style-brief-v2')
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

test('the complete-image request exposes one output safe area and a concise edit description', async () => {
  const prompt = wallpaperCompleteCanvasPrompt(plan, settings)
  const expected = await readFile(new URL('./fixtures/wallpaper-complete-canvas.expected.txt', import.meta.url), 'utf8')
  assert.equal(prompt + '\n', expected)
  assert.match(prompt, /Keep both complete vehicles/)
  assert.match(prompt, /Keep the sea horizon continuous/)
  assert.equal(prompt.match(/安全区为/g)?.length, 1)
})

test('three-reference instructions name the master instead of dumping raster coordinates', () => {
  const prompt = wallpaperCompleteCanvasPrompt(plan, settings)
  assert.doesNotMatch(prompt, /desiredSourceTransform|desiredRegions|referenceTransformAlreadyApplied|必须拉远镜头|等比缩小整组主体/)
  assert.equal(prompt, wallpaperCompleteCanvasPrompt({ ...plan, placement: { scale: 0.1, left: 700, top: 2000 } }, settings))
  assert.ok(prompt.length < 1500)
})

test('planned-canvas references keep the master, original and marked guide separate and ordered', async () => {
  const original = await sharp({ create: { width: 4, height: 6, channels: 3, background: '#c87842' } }).png().toBuffer()
  const canvas = await sharp({ create: { width: 8, height: 12, channels: 3, background: '#808080' } }).composite([{ input: original, left: 2, top: 5 }]).png().toBuffer()
  const guide = await sharp(canvas).composite([{ input: await sharp({ create: { width: 1, height: 12, channels: 3, background: '#32d8e8' } }).png().toBuffer(), left: 1, top: 0 }]).png().toBuffer()
  const references = wallpaperPositionedGenerationReferences({ data: original, mediaType: 'image/png' }, canvas, guide)
  assert.deepEqual(references.map(reference => reference.role), ['canvas', 'original', 'layout-only'])
  assert.equal(references[0]?.data, canvas); assert.equal(references[2]?.data, guide)
  const source = references[1]; assert.ok(source)
  assert.deepEqual(await sharp(source.data).raw().toBuffer(), await sharp(original).raw().toBuffer())
  const input = { version: 'wallpaper-edit-input-v5', prompt: 'Expand image 1; preserve image 2 details and use image 3 only for placement.', references: [{ role: 'canvas', attachmentId: 'master', width: 8, height: 12 }, { role: 'original', attachmentId: 'source', width: 4, height: 6 }, { role: 'layout-only', attachmentId: 'guide', width: 8, height: 12 }] }
  assert.equal(wallpaperGenerationInputSchema.safeParse(input).success, true)
  assert.equal(wallpaperGenerationInputSchema.safeParse({ ...input, references: input.references.slice(0, 2) }).success, false)
  assert.equal(wallpaperGenerationInputSchema.safeParse({ ...input, references: [...input.references].reverse() }).success, false)
  assert.equal(wallpaperGenerationInputSchema.safeParse({ ...input, references: input.references.map(reference => reference.role === 'layout-only' ? { ...reference, height: 10 } : reference) }).success, false)
  assert.equal(wallpaperGenerationInputSchema.safeParse({ ...input, version: 'wallpaper-edit-input-v4', references: input.references.slice(0, 1) }).success, true)
  const masked = { ...input, version: 'wallpaper-edit-input-v6', mask: { attachmentId: 'mask', width: 8, height: 12 } }
  assert.equal(wallpaperGenerationInputSchema.safeParse(masked).success, true)
  assert.equal(wallpaperGenerationInputSchema.safeParse({ ...input, version: 'wallpaper-edit-input-v6' }).success, false)
  assert.equal(wallpaperGenerationInputSchema.safeParse({ ...masked, mask: { ...masked.mask, width: 9 } }).success, false)
})

test('masked positioned editing has one spatial authority and ignores free-form replan movement', async () => {
  const current = wallpaperSettingsSchema.parse({ ...settings, sourceIntentPolicy: { version: 'source-intent-v2' } })
  const prompt = wallpaperCompleteCanvasPrompt({ ...plan, editPrompt: 'Move only the violin and rotate its arm.' }, current)
  assert.equal(prompt + '\n', await readFile(new URL('./fixtures/wallpaper-positioned-edit.expected.txt', import.meta.url), 'utf8'))
  assert.doesNotMatch(prompt, /Move only the violin|rotate its arm|desiredSourceTransform|本轮编辑/)
  assert.ok(prompt.length < 450)
  assert.match(wallpaperCompleteCanvasPrompt(plan, current, ['right overflow']), /right overflow.*恢复到图1/)
})

test('the first masked edit anchors the rendered frame and keeps the original as an appearance reference', async () => {
  const current = wallpaperSettingsSchema.parse({ ...settings, sourceIntentPolicy: { version: 'source-intent-v2' } })
  const positioned = { ...plan, placement: { scale: 1.125, left: -5, top: 1400 } }
  const original = await sharp({ create: { width: 96, height: 64, channels: 3, background: '#c87842' } }).png().toBuffer()
  const { geometry, mask } = await renderWallpaper(original, positioned, current, undefined, 'generated-canvas-v1', current.sourceIntentPolicy)
  const prompt = wallpaperCompleteCanvasPrompt(positioned, current, [], geometry.target)
  assert.match(prompt, /图1已有画面的外框约在成品横向0\.0%–5\.6%、纵向42\.7%–44\.9%/)
  assert.match(prompt, /图2是完整原图，仅核对外观、动作、细节和画风。禁止按图2重新取景/)
  const alpha = await sharp(mask).extractChannel('alpha').raw().toBuffer()
  assert.equal(alpha[1400 * current.width - 1], 0)
  assert.equal(alpha[1400 * current.width], 255)
  assert.equal(alpha[1400 * current.width + 102], 255)
  assert.equal(alpha[1400 * current.width + 103], 0)
})

test('scene and abstract edits retain their composition without inventing a separate main subject', () => {
  for (const mode of ['scene', 'abstract'] as const) {
    const prompt = wallpaperCompleteCanvasPrompt({ ...plan, mode, regions: [], objectRoles: [] }, settings)
    assert.match(prompt, /保留原有整体构图与视觉重心，不新增主角/)
    assert.doesNotMatch(prompt, /各主角与重要结构放入/)
  }
})
