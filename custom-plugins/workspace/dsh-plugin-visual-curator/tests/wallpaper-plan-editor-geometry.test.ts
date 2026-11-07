/** Graphical edits retain the rendering transform and immutable scene evidence. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { wallpaperPlanSchema, wallpaperSettingsSchema } from '../src/shared/wallpaper.ts'
import { dragWallpaperPlan, editWallpaperRegion, wallpaperEditorImageSize } from '../src/client/wallpaper-plan-editor-geometry.ts'
import { wallpaperGeometry } from '../src/media/wallpaper-render.ts'
import { wallpaperGeometry as sharedGeometry } from '../src/shared/wallpaper-geometry.ts'

const source = { width: 3376, height: 6000 }
const plan = wallpaperPlanSchema.parse({ version: 1, imageVersionId: 'source', mode: 'uncertain', subject: 'Unconfirmed source subject', evidence: 'Saved observation', priorities: ['Preserve the subject'], anchors: ['Ground'], truncations: ['Existing source edge'], uncertainties: ['Subject completeness is unknown'], regions: [{ name: 'Protected detail', role: 'critical', rect: { x: 0.2, y: 0.3, width: 0.3, height: 0.2 } }], placement: { left: 300, top: 1100, scale: 0.20317 }, reason: 'Saved placement reason' })

test('image movement uses integer output pixels and preserves unconfirmed evidence and normalized regions', () => {
  const frozen = structuredClone(plan)
  const moved = dragWallpaperPlan(plan, source, { x: -39.4, y: 12.9 })
  assert.deepEqual(moved.placement, { ...plan.placement, left: 261, top: 1113 })
  assert.deepEqual(moved.regions, plan.regions)
  assert.deepEqual(moved.uncertainties, ['Subject completeness is unknown'])
  assert.equal(moved.mode, 'uncertain')
  assert.equal(moved.reason, plan.reason)
  assert.deepEqual(plan, frozen)
})

test('region drags follow rounded full-source placement and agree with the Host render geometry', () => {
  const size = wallpaperEditorImageSize(source, plan)
  const moved = dragWallpaperPlan(plan, source, { x: size.width * 0.1, y: size.height * -0.1 }, 0)
  assert.ok(Math.abs(moved.regions[0]!.rect.x - 0.3) < 1e-10)
  assert.ok(Math.abs(moved.regions[0]!.rect.y - 0.2) < 1e-10)
  const before = wallpaperGeometry(source, plan, wallpaperSettingsSchema.parse({}))
  const after = wallpaperGeometry(source, moved, wallpaperSettingsSchema.parse({}))
  assert.deepEqual(size, { width: before.width, height: before.height })
  assert.ok(Math.abs(after.regions[0]!.left - before.regions[0]!.left - size.width * 0.1) < 1e-10)
  assert.deepEqual(moved.placement, plan.placement)
})

test('moving and resizing cannot create out-of-source or empty protection rectangles', () => {
  const rect = plan.regions[0]!.rect
  assert.deepEqual(editWallpaperRegion(rect, { x: -2, y: 2 }), { x: 0, y: 0.8, width: 0.3, height: 0.2 })
  const enlarged = dragWallpaperPlan(plan, source, { x: 1e6, y: 1e6 }, 0, true)
  assert.deepEqual(enlarged.regions[0]!.rect, { x: 0.2, y: 0.3, width: 0.8, height: 0.7 })
  const reduced = dragWallpaperPlan(plan, source, { x: -1e6, y: -1e6 }, 0, true)
  assert.ok(reduced.regions[0]!.rect.width > 0 && reduced.regions[0]!.rect.height > 0)
  assert.equal(wallpaperPlanSchema.safeParse(reduced).success, true)
  assert.deepEqual(plan.regions[0]!.rect, rect)
})

test('manual placement uses the same safety and upper-buffer checks through the shared and renderer imports', () => {
  assert.equal(sharedGeometry, wallpaperGeometry)
  const settings = wallpaperSettingsSchema.parse({}), source = { width: 1000, height: 2000 }
  const editable = wallpaperPlanSchema.parse({ ...plan, mode: 'single', uncertainties: [], placement: { left: 400, top: 900, scale: 0.5 }, regions: [
    { name: 'Subject', role: 'subject', rect: { x: 0.2, y: 0.2, width: 0.4, height: 0.5 } },
    { name: 'Critical', role: 'critical', rect: { x: 0.3, y: 0.25, width: 0.2, height: 0.4 } },
  ] })
  assert.deepEqual(sharedGeometry(source, editable, settings).checks, [])
  assert.ok(sharedGeometry(source, { ...editable, placement: { ...editable.placement, top: 0 } }, settings).checks.includes('clock-overlap:Critical'))
  assert.ok(sharedGeometry(source, { ...editable, placement: { ...editable.placement, top: 863 } }, settings).checks.includes('top-buffer-overlap:Subject'))
  assert.deepEqual(sharedGeometry(source, { ...editable, placement: { ...editable.placement, top: 864 } }, settings).checks, [])
  assert.throws(() => sharedGeometry(source, { ...editable, placement: { ...editable.placement, left: 1846 } }, settings), /does not intersect/)
})
