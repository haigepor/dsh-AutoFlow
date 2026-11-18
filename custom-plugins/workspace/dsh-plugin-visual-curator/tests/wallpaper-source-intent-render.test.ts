/** Full provider canvases remain independent of source pixels, source alpha and diagnostic placement. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import sharp from 'sharp'
import { z } from 'zod'
import { renderCompleteWallpaper, renderWallpaper } from '../src/media/wallpaper-render.ts'
import { wallpaperPlanSchema, wallpaperSettingsSchema } from '../src/shared/wallpaper.ts'

const dimensions = z.strictObject({ width: z.number(), height: z.number() })
const fixture = z.strictObject({
  protocol: z.literal('generated-canvas-v1'), source: dimensions, canvas: dimensions, native: dimensions,
  placement: z.strictObject({ scale: z.number(), left: z.number(), top: z.number() }),
  alphaHole: z.strictObject({ x: z.number(), y: z.number() }),
}).parse(JSON.parse(await readFile(new URL('./fixtures/wallpaper-source-intent-render.expected.json', import.meta.url), 'utf8')))
const settings = wallpaperSettingsSchema.parse({ ...fixture.canvas, backgroundTransitionPixels: 0, sourceIntentPolicy: { version: 'source-intent-v1' } })
const plan = wallpaperPlanSchema.parse({ version: 1, imageVersionId: 'source', mode: 'single', subject: 'Visible partial source subject', evidence: 'Synthetic source content.', priorities: [], anchors: [], truncations: [], uncertainties: [],
  regions: [{ entityId: 'subject', name: 'Visible subject', role: 'subject', rect: { x: 0, y: 0, width: 1, height: 1 } }],
  objectRoles: [{ entityId: 'subject', name: 'Visible subject', role: 'primary', evidence: 'Visible source framing.', rect: { x: 0, y: 0, width: 1, height: 1 }, sourceEdges: ['left', 'top', 'right', 'bottom'], sourceIntent: { framing: 'partial', visibility: 'frame-cropped', preserve: ['Keep the visible framing and appearance.'], relationships: [] } }],
  placement: fixture.placement, reason: 'The placement is a planning reference, not a pasted final image.' })

async function patternedImage(size: { width: number; height: number }) {
  const pixels = Buffer.alloc(size.width * size.height * 3)
  for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
    const offset = (y * size.width + x) * 3
    pixels[offset] = (x * 17 + y * 5) % 256; pixels[offset + 1] = (x * 3 + y * 23) % 256; pixels[offset + 2] = (x * 11 + y * 7) % 256
  }
  return sharp(pixels, { raw: { ...size, channels: 3 } }).png().toBuffer()
}

test('changing the entire source or its alpha cannot change one pixel of the complete provider result', async () => {
  const original = await patternedImage(fixture.source), provider = await patternedImage(fixture.native)
  const changed = await sharp(original).negate().png().toBuffer()
  const transparent = await sharp({ create: { ...fixture.source, channels: 4, background: { r: 30, g: 90, b: 170, alpha: 0 } } }).png().toBuffer()
  const expected = await sharp(provider).resize(fixture.canvas.width, fixture.canvas.height, { fit: 'fill' }).toColourspace('srgb').raw().toBuffer()
  for (const source of [original, changed, transparent]) {
    const output = await renderWallpaper(source, plan, settings, provider, fixture.protocol, settings.sourceIntentPolicy)
    assert.deepEqual(output.generatedSize, fixture.native)
    assert.deepEqual(await sharp(output.image).raw().toBuffer(), expected, 'No source-dependent rectangle, boundary or alpha blend may enter the delivered full scene')
  }
})

test('a transparent provider hole stays detectable even when opaque source pixels cover the same canvas', async () => {
  const source = await sharp({ create: { ...fixture.canvas, channels: 3, background: '#336699' } }).png().toBuffer()
  const pixels = Buffer.alloc(fixture.native.width * fixture.native.height * 4, 255)
  pixels[(fixture.alphaHole.y * fixture.native.width + fixture.alphaHole.x) * 4 + 3] = 0
  const provider = await sharp(pixels, { raw: { ...fixture.native, channels: 4 } }).png().toBuffer()
  const output = await renderWallpaper(source, { ...plan, placement: { scale: 1, left: 0, top: 0 } }, settings, provider, fixture.protocol)
  const expected = await sharp(provider).resize(fixture.canvas.width, fixture.canvas.height, { fit: 'fill' }).toColourspace('srgb').raw().toBuffer()
  assert.deepEqual(await sharp(output.image).raw().toBuffer(), expected)
  assert.equal((await sharp(output.image).stats()).isOpaque, false, 'Source pixels cannot hide a provider transparency defect from final acceptance')
})

test('a full provider result with a different aspect ratio cannot be repaired by cropping or source restoration', async () => {
  const provider = await sharp({ create: { width: fixture.native.height, height: fixture.native.width, channels: 3, background: '#996633' } }).png().toBuffer()
  await assert.rejects(renderCompleteWallpaper(provider, settings), /different aspect ratio/)
})
