/** Original style references and explicit overlay removal remain distinct from final qualification. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import { wallpaperGenerationBriefOutputSchema, wallpaperGenerationBriefPrompt } from '../src/shared/wallpaper-generation-brief.ts'
import { wallpaperGenerationReferences, wallpaperGenerationPrompt } from '../src/media/wallpaper-generation.ts'
import { wallpaperPlanSchema, wallpaperSettingsSchema } from '../src/shared/wallpaper.ts'

const brief = { version: 'wallpaper-generation-brief-v1', sourceImageVersionId: 'source', canvasImageVersionId: 'canvas', styleAnchors: ['Paper grain', 'Broken dry brush', 'Layered pigments'], detailAnchors: ['Directional fur strokes', 'Radial mushroom gills', 'Original overlapping leaves'], preserveInstructions: 'Retain the healthy watercolor subject.', extensionInstructions: 'Extend the layered forest in the same medium.', repairInstructions: 'Erase generated clock digits and restore natural sky.', negativeInstructions: ['No clock UI in the wallpaper.'], generationPrompt: 'Preserve original watercolor paper grain, layered pigments, directional fur strokes and radial mushroom gills. Extend only the natural forest background. Erase the generated clock digits and restore clean background pixels.', clockText: { evidence: 'generated-overlay', action: 'remove-generated-overlay', reason: 'The candidate has clock digits absent from the original.' } }

test('a generated clock overlay requires removal while required original text remains preservable', () => {
  assert.equal(wallpaperGenerationBriefOutputSchema.safeParse(brief).success, true)
  assert.equal(wallpaperGenerationBriefOutputSchema.safeParse({ ...brief, clockText: { ...brief.clockText, action: 'background-only' } }).success, false)
  assert.equal(wallpaperGenerationBriefOutputSchema.safeParse({ ...brief, clockText: { evidence: 'original-required-text', action: 'preserve-original-text', reason: 'The original sign is explicitly required.' } }).success, true)
})

test('authored edits retain exact whole-canvas safety bounds and state that candidate positioning is already applied', async () => {
  const settings = wallpaperSettingsSchema.parse({})
  const plan = wallpaperPlanSchema.parse({ version: 1, imageVersionId: 'saved-candidate', mode: 'single', subject: 'Complete bowl', evidence: 'Same content', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [], placement: { scale: 1, left: 0, top: 243 }, reason: 'Uniform candidate correction' })
  const latest = { revision: 2, plan, checks: [], needsOutpaint: true, compositionMode: 'generated-canvas-v1' as const, layoutCorrection: { version: 'candidate-placement-v1' as const, plan } }
  const prompt = wallpaperGenerationPrompt('Frozen instruction', plan, settings, [{ role: 'canvas', width: 941, height: 1672 }], [latest], settings, true, wallpaperGenerationBriefOutputSchema.parse(brief))
  const layout = JSON.parse(prompt.split('Host布局数据：')[1]!.split('。所有坐标')[0]!)
  assert.deepEqual(layout.protectedPixels, { left: 258, top: 1032, right: 1587, bottom: 2718 })
  assert.equal(layout.protectedNormalized.top, 1032 / 3280)
  assert.equal(layout.referenceImageVersionId, 'saved-candidate')
  assert.equal(layout.referenceTransformAlreadyApplied, true)
  assert.equal(layout.layoutCorrectionApplied, true)
  const expected = JSON.parse(await readFile(new URL('./fixtures/wallpaper-layout-recovery.expected.json', import.meta.url), 'utf8'))
  assert.deepEqual({ protectedPixels: layout.protectedPixels, referenceImageVersionId: layout.referenceImageVersionId, referenceTransformAlreadyApplied: layout.referenceTransformAlreadyApplied, layoutCorrectionApplied: layout.layoutCorrectionApplied, placement: layout.placement }, expected.generationRequest)
  assert.match(prompt, /历史复审中的下移、缩小等动作已经完成/)
  assert.match(prompt, /Preserve original watercolor paper grain/)
})

test('a cropped product edge receives an explicit local closure instruction even when an authored brief forbids invented products', () => {
  const settings = wallpaperSettingsSchema.parse({ repairPolicy: { mode: 'repair-when-needed' }, sourceFrameRepair: { enabled: true, marginPixels: 128 } })
  const plan = wallpaperPlanSchema.parse({ version: 1, imageVersionId: 'source', mode: 'single', subject: 'Cosmetic bottle', evidence: 'Cap is cut by the original top frame', priorities: [], anchors: [], truncations: ['顶部米色瓶盖被原图上边框截断'], uncertainties: [], regions: [{ name: '米色瓶', role: 'subject', rect: { x: 0.3, y: 0, width: 0.3, height: 0.5 } }, { name: '瓶盖', role: 'critical', rect: { x: 0.35, y: 0, width: 0.2, height: 0.1 } }], placement: { scale: 0.5, left: 450, top: 1100 }, reason: 'Leave room for local closure' })
  const prompt = wallpaperGenerationPrompt('Frozen instruction', plan, settings, [{ role: 'canvas', width: 941, height: 1672 }], [], { width: 1845, height: 3280 }, true, wallpaperGenerationBriefOutputSchema.parse({ ...brief, negativeInstructions: ['不要补出完整瓶盖或额外产品'] }))
  assert.match(wallpaperGenerationBriefPrompt.text, /局部外轮廓/)
  assert.match(prompt, /顶部米色瓶盖被原图上边框截断/)
  assert.match(prompt, /局部可见外轮廓完整闭合/)
  assert.match(prompt, /不能阻止这里明确授权的小范围自然收口/)
  assert.match(prompt, /"edges":\["top"\]/)
})

test('the positioned canvas stays first while the original supplies its unscaled style pixels separately', async () => {
  const source = await sharp({ create: { width: 127, height: 191, channels: 3, background: '#cf751e' } }).png().toBuffer()
  const canvas = await sharp({ create: { width: 180, height: 320, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer()
  const plan = wallpaperPlanSchema.parse({ version: 1, imageVersionId: 'source', mode: 'scene', subject: 'Watercolor fixture', evidence: 'Isolated native pixels', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [], placement: { scale: 1, left: 0, top: 0 }, reason: 'Frozen canvas' })
  const references = await wallpaperGenerationReferences(source, canvas, canvas, plan, 'opaque', true)
  assert.deepEqual(references.map(row => row.role), ['canvas', 'original'])
  assert.deepEqual(await sharp(references[1]!.data).raw().toBuffer(), await sharp(source).raw().toBuffer())
  assert.deepEqual(await sharp(references[1]!.data).metadata().then(({ width, height }) => ({ width, height })), { width: 127, height: 191 })
  assert.equal((await sharp(references[0]!.data).metadata()).hasAlpha, false)
})

test('complete-canvas requests without prompt authoring do not turn a correlation signal into an established framing defect', () => {
  const settings = wallpaperSettingsSchema.parse({})
  const plan = wallpaperPlanSchema.parse({ version: 1, imageVersionId: 'source', mode: 'scene', subject: 'Saved scene', evidence: 'Visible pixels', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [], placement: { scale: 1, left: 0, top: 0 }, reason: 'Frozen layout' })
  const attempt = { revision: 1, plan, checks: [], needsOutpaint: true, compositionMode: 'generated-canvas-v1' as const, generationAlignment: { result: 'misaligned-source' as const, wholeSourceCorrelation: 0.7, placedSourceCorrelation: 0.6, protectedSourceCorrelation: 0.5 } }
  const prompt = wallpaperGenerationPrompt('Frozen instruction', plan, settings, [{ role: 'canvas', width: 941, height: 1672 }], [attempt], settings, true)
  const request = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1))
  assert.equal(request.framingFailure, undefined)
  assert.deepEqual(request.alignmentDiagnostic.measurement, attempt.generationAlignment)
})
