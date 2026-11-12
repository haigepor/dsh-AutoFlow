import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import { wallpaperGeometry, renderWallpaper } from '../src/media/wallpaper-render.ts'
import { wallpaperPlanSchema, wallpaperSettingsSchema } from '../src/shared/wallpaper.ts'
import { wallpaperProtectedBounds, fitWallpaperPlacement } from '../src/shared/wallpaper-geometry.ts'
import { wallpaperPromptBundle, wallpaperPrompts } from '../src/shared/wallpaper-prompts.ts'

const settings = wallpaperSettingsSchema.parse({})
const plan = (top: number) => wallpaperPlanSchema.parse({ version: 1, imageVersionId: 'source', mode: 'single', subject: 'Visible source', evidence: 'Source pixels', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: ['subject', 'critical'].map(role => ({ name: role, role, rect: { x: 0.1, y: top / 2000, width: 0.1, height: 0.1 } })), placement: { scale: 1, left: 400, top: 0 }, reason: 'Keep protected source content.' })

test('planning requests use the complete protected band while legacy planning text remains reconstructable', () => {
  assert.deepEqual(wallpaperProtectedBounds(settings), { top: 1032, clockBottom: 1032, critical: { left: 258, right: 1587, bottom: 2718 }, subject: { left: 192, right: 1653, bottom: 2802 } })
  assert.equal(wallpaperProtectedBounds({ ...settings, topBuffer: 0 }).top, 1032)
  assert.equal(wallpaperPromptBundle().plan.version, 'wallpaper-plan-v6')
  assert.equal(wallpaperPromptBundle().outpaint.version, 'wallpaper-outpaint-v4')
  assert.equal(wallpaperPromptBundle('wallpaper-review-v4', 'wallpaper-plan-v5').outpaint.version, 'wallpaper-outpaint-v3')
  assert.equal(wallpaperPromptBundle('wallpaper-review-v3', 'wallpaper-plan-v2').plan.version, 'wallpaper-plan-v2')
  assert.deepEqual(wallpaperPromptBundle('wallpaper-review-v1', 'wallpaper-plan-v1').plan, { version: 'wallpaper-plan-v1', text: wallpaperPrompts['wallpaper-plan'] })
})

test('the measured upper buffer begins at the safety line and permits its exact lower edge', () => {
  const settings = wallpaperSettingsSchema.parse({ processing: { clockContrast: {} } })
  const source = { width: 1000, height: 2000 }
  assert.ok(wallpaperGeometry(source, plan(1031), settings).checks.includes('clock-overlap:subject'))
  assert.ok(wallpaperGeometry(source, plan(1032), settings).checks.includes('top-buffer-overlap:subject'))
  assert.ok(wallpaperGeometry(source, plan(1063), settings).checks.includes('top-buffer-overlap:critical'))
  assert.deepEqual(wallpaperGeometry(source, plan(1064), settings).checks, [])
  assert.deepEqual(wallpaperGeometry(source, plan(1032), { ...settings, topBuffer: 0 }).checks, [])
})

test('Host placement fits distant and large subjects without dropping annotations or enlarging pixels', () => {
  for (const sample of [
    { source: { width: 3333, height: 5000 }, rect: { x: 0.42, y: 0.5, width: 0.21, height: 0.18 }, outpaint: false },
    { source: { width: 7074, height: 4716 }, rect: { x: 0.1, y: 0.45, width: 0.8, height: 0.4 }, outpaint: true },
    { source: { width: 960, height: 640 }, rect: { x: 0.05, y: 0.3, width: 0.9, height: 0.6 }, outpaint: true },
  ]) {
    const observed = { ...plan(1100), regions: ['subject', 'critical'].map(role => ({ name: role, role, rect: sample.rect })) }
    const next = wallpaperPlanSchema.parse({ ...observed, placement: fitWallpaperPlacement(sample.source, wallpaperPlanSchema.parse(observed), settings) })
    const geometry = wallpaperGeometry(sample.source, next, settings)
    assert.deepEqual(geometry.checks, [])
    assert.equal(geometry.needsOutpaint, sample.outpaint)
    assert.ok(next.placement.scale <= 1 && next.placement.scale > 0)
    assert.deepEqual(next.regions, observed.regions)
    assert.throws(() => wallpaperGeometry(sample.source, { ...next, placement: { ...next.placement, top: -10000 } }, settings))
  }
})

test('the 5393 by 3744 motorcycle fills the safe area while retained legacy horizon protection still constrains it', () => {
  const source = { width: 5393, height: 3744 }
  const observed = wallpaperPlanSchema.parse({ ...plan(1100), anchors: ['Keep the sea horizon continuous across editable background.'], regions: [
    { name: 'complete motorcycle', role: 'subject', rect: { x: 0.11, y: 0.17, width: 0.78, height: 0.79 } },
    { name: 'tank branding', role: 'critical', rect: { x: 0.47, y: 0.42, width: 0.16, height: 0.11 } },
    { name: 'front wheel and brake', role: 'critical', rect: { x: 0.11, y: 0.5, width: 0.28, height: 0.42 } },
    { name: 'rear wheel', role: 'critical', rect: { x: 0.62, y: 0.54, width: 0.27, height: 0.36 } },
    { name: 'handlebar and mirror', role: 'critical', rect: { x: 0.4, y: 0.17, width: 0.28, height: 0.2 } },
  ] })
  const next = { ...observed, placement: fitWallpaperPlacement(source, observed, settings, 'subject-first-v2') }
  const geometry = wallpaperGeometry(source, next, settings)
  assert.deepEqual(geometry.checks, [])
  assert.ok(geometry.regions[0]!.width >= 1300)
  assert.ok(next.placement.scale <= 1)
  assert.deepEqual(next.regions, observed.regions)
  assert.deepEqual(next.anchors, observed.anchors)

  const legacy = wallpaperPlanSchema.parse({ ...observed, regions: [...observed.regions, { name: 'retained full-width horizon', role: 'anchor', rect: { x: 0, y: 0.5, width: 1, height: 0.1 } }] })
  const retained = { ...legacy, placement: fitWallpaperPlacement(source, legacy, settings, 'subject-first-v2') }
  const retainedGeometry = wallpaperGeometry(source, retained, settings)
  assert.deepEqual(retainedGeometry.checks, [])
  assert.deepEqual(retained.regions, legacy.regions)
  assert.equal(retainedGeometry.regions.length, 6)
  assert.ok(retainedGeometry.regions[0]!.width < geometry.regions[0]!.width)
  assert.ok(retainedGeometry.regions[5]!.width <= settings.safe.width)

  const smallSource = { width: 960, height: 666 }
  const small = { ...observed, placement: fitWallpaperPlacement(smallSource, observed, settings, 'subject-first-v2') }
  const smallGeometry = wallpaperGeometry(smallSource, small, settings)
  assert.deepEqual(smallGeometry.checks, [])
  assert.equal(small.placement.scale, 1)
  assert.ok(smallGeometry.width <= smallSource.width && smallGeometry.height <= smallSource.height)
  assert.deepEqual(small.regions, observed.regions)
})

test('an opaque full-canvas source is cropped without requesting background generation', async () => {
  const source = await sharp({ create: { width: 1845, height: 3280, channels: 3, background: '#ac3922' } }).png().toBuffer()
  const result = await renderWallpaper(source, { ...plan(1100), placement: { scale: 1, left: 0, top: 0 } }, settings)
  assert.equal(result.geometry.needsOutpaint, false)
  assert.deepEqual(await sharp(result.image).removeAlpha().raw().toBuffer(), await sharp(source).raw().toBuffer())
})

test('transparent pixels inside a geometrically full source still require background extension', async () => {
  const hole = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer()
  const source = await sharp({ create: { width: 1845, height: 3280, channels: 4, background: '#ac3922' } }).composite([{ input: hole, left: 50, top: 50, blend: 'dest-out' }]).png().toBuffer()
  const result = await renderWallpaper(source, { ...plan(1100), placement: { scale: 1, left: 0, top: 0 } }, settings)
  assert.equal(result.geometry.target.width * result.geometry.target.height, 1845 * 3280)
  assert.equal(result.geometry.needsOutpaint, true)
  const alpha = await sharp(result.mask).ensureAlpha().extractChannel('alpha').raw().toBuffer()
  assert.equal(alpha[55 * 1845 + 55], 0)
  assert.equal(alpha[1000 * 1845 + 1000], 255)
})

test('generated background cannot replace protected source pixels; unprotected edges blend at the exact final size', async () => {
  const source = await sharp({ create: { width: 1000, height: 2000, channels: 3, background: '#ac3922' } }).png().toBuffer()
  const background = await sharp({ create: { width: 1845, height: 3280, channels: 3, background: '#1933d1' } }).png().toBuffer()
  const placed = { ...plan(1100), placement: { scale: 0.5, left: 500, top: 1100 } }
  const result = await renderWallpaper(source, placed, settings, background)
  const metadata = await sharp(result.image).metadata()
  assert.equal(metadata.width, 1845); assert.equal(metadata.height, 3280)
  const retained = await sharp(result.image).extract({ left: 550, top: 1650, width: 50, height: 100 }).removeAlpha().raw().toBuffer()
  assert.equal(retained.every((value, index) => value === [172, 57, 34][index % 3]), true)
  const outer = await sharp(result.image).extract({ left: 0, top: 0, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
  assert.deepEqual([...outer], [25, 51, 209])
  const alpha = await sharp(result.mask).extractChannel('alpha').raw().toBuffer()
  assert.equal(alpha[1650 * 1845 + 550], 255)
  assert.equal(alpha[1100 * 1845 + 500], 0)
  const edge = await sharp(result.image).extract({ left: 500, top: 1100, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
  assert.deepEqual([...edge], [25, 51, 209])
  assert.equal((await sharp(result.image).stats()).isOpaque, true)
})

test('an edit result with another aspect ratio is rejected before composition', async () => {
  const source = await sharp({ create: { width: 1000, height: 2000, channels: 3, background: '#ac3922' } }).png().toBuffer()
  const background = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#1933d1' } }).png().toBuffer()
  await assert.rejects(renderWallpaper(source, plan(1100), settings, background), /aspect ratio/)
})

test('one-pixel provider rounding maps the whole edit canvas instead of cropping it', async () => {
  const source = await sharp({ create: { width: 1000, height: 2000, channels: 3, background: '#ac3922' } }).png().toBuffer()
  const background = await sharp({ create: { width: 941, height: 1672, channels: 3, background: '#1933d1' } }).png().toBuffer()
  const result = await renderWallpaper(source, plan(1100), settings, background)
  assert.deepEqual(result.generatedSize, { width: 941, height: 1672 })
  assert.deepEqual(await sharp(result.image).extract({ left: 0, top: 0, width: 1, height: 1 }).removeAlpha().raw().toBuffer(), Buffer.from([25, 51, 209]))
})

test('explicit protected context keeps every annotated source pixel, opaque output and the original generation mask', async () => {
  const source = await sharp({ create: { width: 1000, height: 2000, channels: 3, background: '#ac3922' } }).png().toBuffer()
  const background = await sharp({ create: { width: 941, height: 1672, channels: 3, background: '#1933d1' } }).png().toBuffer()
  const placed = { ...plan(1100), placement: { scale: 0.5, left: 500, top: 1100 } }
  const original = await renderWallpaper(source, placed, settings, background)
  const explicit = await renderWallpaper(source, placed, settings, background, 'source-edge-v1')
  const context = await renderWallpaper(source, placed, settings, background, 'protected-context-v1')
  assert.deepEqual(explicit.image, original.image); assert.deepEqual(context.mask, original.mask); assert.deepEqual(context.geometry, original.geometry)
  const retained = await sharp(context.image).extract({ left: 550, top: 1650, width: 50, height: 100 }).removeAlpha().raw().toBuffer()
  assert.equal(retained.every((value, index) => value === [172, 57, 34][index % 3]), true)
  const distant = await sharp(context.image).extract({ left: 950, top: 2050, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
  assert.deepEqual([...distant], [25, 51, 209]); assert.equal((await sharp(context.image).stats()).isOpaque, true)
  assert.equal(wallpaperSettingsSchema.safeParse({ backgroundContextPixels: -1 }).success, false)
  assert.equal(wallpaperSettingsSchema.safeParse({ backgroundContextPixels: 513 }).success, false)
})

test('new subject-context generation edits distant old background while retaining protected pixels and nearby context', async () => {
  const source = await sharp({ create: { width: 1000, height: 2000, channels: 3, background: '#ac3922' } }).png().toBuffer()
  const background = await sharp({ create: { width: 941, height: 1672, channels: 3, background: '#1933d1' } }).png().toBuffer()
  const original = await renderWallpaper(source, plan(1100), settings, background)
  const result = await renderWallpaper(source, plan(1100), settings, background, 'protected-context-v2')
  const priorAlpha = await sharp(original.mask).extractChannel('alpha').raw().toBuffer(), alpha = await sharp(result.mask).extractChannel('alpha').raw().toBuffer()
  assert.equal(priorAlpha[500 * 1845 + 1000], 255)
  assert.equal(alpha[500 * 1845 + 1000], 0)
  assert.equal(alpha[1150 * 1845 + 550], 255)
  assert.equal(alpha[1150 * 1845 + 700], 255)
  assert.equal(alpha[1150 * 1845 + 800], 0)
  const retained = await sharp(result.image).extract({ left: 500, top: 1100, width: 100, height: 200 }).removeAlpha().raw().toBuffer()
  assert.equal(retained.every((value, index) => value === [172, 57, 34][index % 3]), true)
  assert.deepEqual([...await sharp(result.image).extract({ left: 1000, top: 500, width: 1, height: 1 }).removeAlpha().raw().toBuffer()], [25, 51, 209])
  assert.equal((await sharp(result.image).stats()).isOpaque, true)
})
