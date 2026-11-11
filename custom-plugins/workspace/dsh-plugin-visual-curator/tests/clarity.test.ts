import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { enhanceWallpaper } from '../src/media/clarity.ts'
import { superResolveWallpaperBackground } from '../src/media/background-resolution.ts'
import { claritySettingsSchema } from '../src/shared/clarity.ts'
import { backgroundResolutionSettingsSchema } from '../src/shared/background-resolution.ts'

test('super-resolution creates independent same-size pixels and preserves critical regions and every pixel outside the subject', async () => {
  const width = 480, height = 400, pixels = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const at = (y * width + x) * 3; pixels[at] = (x * 3 + y) % 256; pixels[at + 1] = (x + y * 2) % 256; pixels[at + 2] = Math.floor(x / 8) % 2 ? 180 : 80 }
  const bytes = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer(), before = Buffer.from(bytes)
  const region = { left: 20, top: 40, width: 420, height: 300 }, protectedRegion = { left: 200, top: 160, width: 40, height: 30 }
  const result = await enhanceWallpaper({ bytes, regions: [region], protectedRegions: [protectedRegion], maxPixels: width * height, policy: claritySettingsSchema.parse({}) }, new AbortController().signal)
  const actual = await sharp(result.bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  assert.equal(actual.info.width, width); assert.equal(actual.info.height, height)
  assert.deepEqual(bytes, before)
  let changed = 0
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 3, inside = x >= region.left && x < region.left + region.width && y >= region.top && y < region.top + region.height
    const critical = x >= protectedRegion.left && x < protectedRegion.left + protectedRegion.width && y >= protectedRegion.top && y < protectedRegion.top + protectedRegion.height
    if (!inside || critical) assert.deepEqual(actual.data.subarray(at, at + 3), pixels.subarray(at, at + 3))
    else if (actual.data[at] !== pixels[at] || actual.data[at + 1] !== pixels[at + 1] || actual.data[at + 2] !== pixels[at + 2]) changed++
  }
  assert.ok(changed > 0)
  assert.equal(result.model, 'espcn-x3-luma'); assert.ok(result.tiles > 1)
})

test('cancelled and oversized enhancement jobs stop without changing the source or bypassing their pixel budget', async () => {
  const bytes = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#56789a' } }).png().toBuffer()
  const input = { bytes, regions: [{ left: 0, top: 0, width: 100, height: 100 }], protectedRegions: [], maxPixels: 10000, policy: claritySettingsSchema.parse({ maxSubjectPixels: 4096 }) }
  await assert.rejects(enhanceWallpaper(input, new AbortController().signal), { code: 'clarity-region-budget-exceeded' })
  const controller = new AbortController(); controller.abort(new Error('stop-test'))
  await assert.rejects(enhanceWallpaper(input, controller.signal), /stop-test/)
})

test('a 941 by 1672 background uses real tiled 3x inference before one resize to the exact wallpaper dimensions', async context => {
  const sourceWidth = 941, sourceHeight = 1672, width = 1845, height = 3280
  const rgb = Buffer.alloc(sourceWidth * sourceHeight * 3)
  for (let y = 0; y < sourceHeight; y++) for (let x = 0; x < sourceWidth; x++) {
    const at = (y * sourceWidth + x) * 3
    rgb[at] = (x * 3 + y) % 256; rgb[at + 1] = (x + y * 2) % 256; rgb[at + 2] = Math.floor(x / 8) % 2 ? 180 : 80
  }
  const bytes = await sharp(rgb, { raw: { width: sourceWidth, height: sourceHeight, channels: 3 } }).png().toBuffer(), before = Buffer.from(bytes)
  const result = await superResolveWallpaperBackground({ bytes, width, height, maxPixels: sourceWidth * sourceHeight * 9, policy: backgroundResolutionSettingsSchema.parse({}) }, new AbortController().signal)
  const actual = await sharp(result.bytes).raw().toBuffer({ resolveWithObject: true })
  assert.equal(actual.info.width, width); assert.equal(actual.info.height, height); assert.equal(actual.info.channels, 3)
  assert.deepEqual(bytes, before)
  assert.equal(result.model, 'espcn-x3-luma'); assert.equal(result.modelSha256, '85f36ff88cc504a24af5e0602148bc56a8aa09a58eca8c0da2756f3e8186035e')
  assert.equal(result.sourceWidth, sourceWidth); assert.equal(result.sourceHeight, sourceHeight)
  assert.equal(result.outputWidth, width); assert.equal(result.outputHeight, height)
  assert.equal(result.pixels, sourceWidth * sourceHeight); assert.equal(result.tiles, 45)
  const interpolated = await sharp(rgb, { raw: { width: sourceWidth, height: sourceHeight, channels: 3 } }).resize(sourceWidth * 3, sourceHeight * 3, { kernel: 'cubic' }).raw().toBuffer()
  const baseline = await sharp(interpolated, { raw: { width: sourceWidth * 3, height: sourceHeight * 3, channels: 3 } }).resize(width, height, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer()
  let changed = 0
  for (let pixel = 0; pixel < width * height; pixel++) if (actual.data[pixel * 3] !== baseline[pixel * 3] || actual.data[pixel * 3 + 1] !== baseline[pixel * 3 + 1] || actual.data[pixel * 3 + 2] !== baseline[pixel * 3 + 2]) changed++
  assert(changed > width * height * 0.01, 'Learned luminance must change actual decoded pixels compared with the same interpolation-only pipeline')
  context.diagnostic(JSON.stringify({ durationMs: result.durationMs, pixels: result.pixels, tiles: result.tiles, changedAgainstInterpolation: changed }))
})

test('background inference rejects disabled, over-budget, distorted and more-than-3x requests before publishing pixels', async () => {
  const bytes = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#56789a' } }).png().toBuffer(), before = Buffer.from(bytes)
  const input = { bytes, width: 200, height: 200, maxPixels: 100000, policy: backgroundResolutionSettingsSchema.parse({}) }
  await assert.rejects(superResolveWallpaperBackground({ ...input, policy: { ...input.policy, enabled: false } }, new AbortController().signal), { code: 'background-resolution-disabled' })
  await assert.rejects(superResolveWallpaperBackground({ ...input, policy: { ...input.policy, maxInputPixels: 4096 } }, new AbortController().signal), { code: 'background-resolution-input-budget-exceeded' })
  await assert.rejects(superResolveWallpaperBackground({ ...input, maxPixels: 89999 }, new AbortController().signal), { code: 'background-resolution-intermediate-budget-exceeded' })
  await assert.rejects(superResolveWallpaperBackground({ ...input, maxPixels: 39999 }, new AbortController().signal), { code: 'background-resolution-output-budget-exceeded' })
  await assert.rejects(superResolveWallpaperBackground({ ...input, width: 301, height: 301 }, new AbortController().signal), { code: 'background-resolution-scale-exceeded' })
  await assert.rejects(superResolveWallpaperBackground({ ...input, height: 210 }, new AbortController().signal), { code: 'background-resolution-ratio-mismatch' })
  assert.deepEqual(bytes, before)
})

test('background cancellation terminates active worker work and leaves the shared enhancement queue usable', async () => {
  const bytes = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#56789a' } }).png().toBuffer(), before = Buffer.from(bytes)
  const input = { bytes, width: 200, height: 200, maxPixels: 100000, policy: backgroundResolutionSettingsSchema.parse({}) }
  const controller = new AbortController(); controller.abort(new Error('background-cancelled-before-start'))
  await assert.rejects(superResolveWallpaperBackground(input, controller.signal), /background-cancelled-before-start/)
  const running = new AbortController(), cancelled = superResolveWallpaperBackground(input, running.signal)
  const timer = setTimeout(() => running.abort(new Error('background-cancelled-in-flight')), 25)
  try { await assert.rejects(cancelled, /background-cancelled-in-flight/) }
  finally { clearTimeout(timer) }
  const recovered = await superResolveWallpaperBackground(input, new AbortController().signal)
  assert.equal(recovered.outputWidth, 200); assert.equal(recovered.outputHeight, 200)
  assert.deepEqual(bytes, before)
})
