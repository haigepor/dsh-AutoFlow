/** Original style references and explicit overlay removal remain distinct from final qualification. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import { wallpaperGenerationBriefOutputSchema } from '../src/shared/wallpaper-generation-brief.ts'
import { wallpaperGenerationReferences } from '../src/media/wallpaper-generation.ts'
import { wallpaperPlanSchema } from '../src/shared/wallpaper.ts'

const brief = { version: 'wallpaper-generation-brief-v1', sourceImageVersionId: 'source', canvasImageVersionId: 'canvas', styleAnchors: ['Paper grain', 'Broken dry brush', 'Layered pigments'], detailAnchors: ['Directional fur strokes', 'Radial mushroom gills', 'Original overlapping leaves'], preserveInstructions: 'Retain the healthy watercolor subject.', extensionInstructions: 'Extend the layered forest in the same medium.', repairInstructions: 'Erase generated clock digits and restore natural sky.', negativeInstructions: ['No clock UI in the wallpaper.'], generationPrompt: 'Preserve original watercolor paper grain, layered pigments, directional fur strokes and radial mushroom gills. Extend only the natural forest background. Erase the generated clock digits and restore clean background pixels.', clockText: { evidence: 'generated-overlay', action: 'remove-generated-overlay', reason: 'The candidate has clock digits absent from the original.' } }

test('a generated clock overlay requires removal while required original text remains preservable', () => {
  assert.equal(wallpaperGenerationBriefOutputSchema.safeParse(brief).success, true)
  assert.equal(wallpaperGenerationBriefOutputSchema.safeParse({ ...brief, clockText: { ...brief.clockText, action: 'background-only' } }).success, false)
  assert.equal(wallpaperGenerationBriefOutputSchema.safeParse({ ...brief, clockText: { evidence: 'original-required-text', action: 'preserve-original-text', reason: 'The original sign is explicitly required.' } }).success, true)
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
