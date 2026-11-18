/** Pixel equality cannot authorize a pasted source rectangle or revive a retired renderer mode. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import { renderWallpaper } from '../src/media/wallpaper-render.ts'
import { wallpaperAttemptSchema, wallpaperCompositionEligible, wallpaperDisplayState, wallpaperPlanSchema, wallpaperSettingsSchema, wallpaperStateSchema } from '../src/shared/wallpaper.ts'

const settings = wallpaperSettingsSchema.parse({ backgroundTransitionPixels: 0 })
const plan = wallpaperPlanSchema.parse({ version: 1, imageVersionId: 'original', mode: 'single', subject: 'Visible source subject', evidence: 'Known synthetic source pixels.', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [{ name: 'Visible subject', role: 'subject', rect: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 } }], placement: { scale: 1, left: 700, top: 1400 }, reason: 'Retain the saved diagnostic placement.' })
const restored = wallpaperAttemptSchema.parse({ revision: 1, plan, checks: [], needsOutpaint: true, outputId: 'pasted-final', compositionMode: 'source-intent-background-v1', sourceIntentProof: { version: 'source-intent-pixels-v1', sourceDigest: 'original-digest', outputDigest: 'pasted-digest', comparedPixels: 96_000, changedPixels: 0, sourceRect: { left: 700, top: 1400, width: 240, height: 400 } } })

test('a matching zero-change proof never qualifies a source-intent pasted output or changes its historical record', () => {
  assert.equal(wallpaperCompositionEligible(restored), false)
  assert.equal(wallpaperCompositionEligible({ ...restored, outputId: undefined, needsOutpaint: false, sourceIntentProof: undefined }), false)
  const relabeled = { ...restored, compositionMode: 'generated-canvas-v1' as const }
  assert.equal(wallpaperCompositionEligible(relabeled), false, 'Changing the mode cannot qualify a saved source-restoration proof')
  const saved = wallpaperStateSchema.parse({ version: 2, sourceRunId: 'history', skillVersion: 'saved-skill', items: [{ imageVersionId: 'original', originalId: 'original', familyId: 'source-family', status: 'passed', edits: 1, attempts: [restored] }] })
  const before = structuredClone(saved), shown = wallpaperDisplayState(saved)
  assert.equal(shown.items[0]?.status, 'needs-review')
  assert.equal(shown.items[0]?.reason, 'complete-canvas-required')
  assert.deepEqual(saved, before, 'Historical proof and output metadata remain readable and unchanged')
  assert.deepEqual(wallpaperStateSchema.parse(saved), before)
})

test('complete provider canvases remain eligible while historical pasted generation modes remain ineligible', () => {
  const complete = wallpaperAttemptSchema.parse({ ...restored, compositionMode: 'generated-canvas-v1', sourceIntentProof: undefined })
  assert.equal(wallpaperCompositionEligible(complete), true)
  for (const compositionMode of ['protected-context-v1', 'protected-context-v2', 'generated-canvas-protected-v2', 'background-plate-v1', 'background-plate-v2', 'source-intent-background-v1'] as const) assert.equal(wallpaperCompositionEligible({ ...complete, compositionMode, needsOutpaint: false }), false, 'Clearing the generation flag cannot qualify ' + compositionMode)
  assert.equal(wallpaperCompositionEligible({ ...complete, compositionMode: 'source-edge-v1' }), false)
  assert.equal(wallpaperCompositionEligible({ ...complete, compositionMode: 'source-edge-v1', needsOutpaint: false }), true, 'A pure source crop does not require generated background composition')
})

test('the renderer refuses retired source-intent placement and all pasted generated modes but delivers an entire provider canvas', async () => {
  const source = await sharp({ create: { width: 240, height: 400, channels: 3, background: '#804020' } }).png().toBuffer()
  const generated = await sharp({ create: { width: 1845, height: 3280, channels: 3, background: '#205080' } }).png().toBuffer()
  await assert.rejects(renderWallpaper(source, plan, settings, undefined, 'source-intent-background-v1'), /pixel overlays are disabled/)
  for (const compositionMode of ['source-intent-background-v1', 'source-edge-v1', 'protected-context-v2', 'generated-canvas-protected-v2', 'background-plate-v2'] as const) await assert.rejects(renderWallpaper(source, plan, settings, generated, compositionMode), /pixel overlays are disabled/)
  const output = await renderWallpaper(source, plan, settings, generated, 'generated-canvas-v1')
  assert.deepEqual(await sharp(output.image).raw().toBuffer(), await sharp(generated).raw().toBuffer(), 'The delivered full scene contains the provider pixels without restoring a source rectangle')
})
