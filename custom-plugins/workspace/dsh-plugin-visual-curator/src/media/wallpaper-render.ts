/** Deterministic layout protects source subjects and keeps diagnostic and lock-screen layers separate. */
import sharp from 'sharp'
import { wallpaperClockSvg } from './wallpaper-clock.ts'
import type { WallpaperPlan, WallpaperSettings, WallpaperCompositionMode } from '../shared/wallpaper.ts'
import { wallpaperProcessingSchema } from '../shared/wallpaper-policy.ts'
import { CuratorError } from '../shared/errors.ts'
import { wallpaperGeometry } from '../shared/wallpaper-geometry.ts'

export { wallpaperGeometry } from '../shared/wallpaper-geometry.ts'

/** Render an isotropic placement; only unprotected source-background edges may blend with generated pixels.
 * @param bytes Verified oriented original.
 * @param plan Inferred layout.
 * @param settings Frozen template.
 * @param background Optional generated background; omission leaves transparent uncovered pixels.
 * @param compositionMode Explicit saved-output recovery; generated-canvas-v1 keeps only generated pixels, while generated-canvas-protected-v2 restores healthy original pixels.
 * @returns Actual image, alpha mask and measured transform.
 */
export async function renderWallpaper(bytes: Uint8Array, plan: WallpaperPlan, settings: WallpaperSettings, background?: Uint8Array, compositionMode: WallpaperCompositionMode = 'source-edge-v1') {
  const metadata = await sharp(bytes).metadata()
  if (!metadata.width || !metadata.height) throw new CuratorError('invalid-input', 'wallpaper-render', 'Source dimensions are unavailable.')
  const geometry = wallpaperGeometry({ width: metadata.width, height: metadata.height }, plan, settings)
  // Native-size crops retain decoded pixels; scaled placements resample once from the original.
  const placed = geometry.width === metadata.width && geometry.height === metadata.height ? sharp(bytes) : sharp(bytes).resize(geometry.width, geometry.height, { fit: 'fill', kernel: sharp.kernel.lanczos3, withoutEnlargement: true })
  const patch = await placed.extract({ left: geometry.target.left - geometry.left, top: geometry.target.top - geometry.top, width: geometry.target.width, height: geometry.target.height }).png().toBuffer()
  const canvas = { width: settings.width, height: settings.height, channels: 4 as const, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  const seed = await sharp({ create: canvas }).composite([{ input: patch, left: geometry.target.left, top: geometry.target.top }]).png().toBuffer()
  const mask = await sharp(seed).ensureAlpha().extractChannel('alpha').raw().toBuffer({ resolveWithObject: true })
  geometry.needsOutpaint ||= mask.data.some(alpha => alpha < 255)
  const raw = { width: settings.width, height: settings.height, channels: 1 as const }
  let protection = mask.data, blend = mask.data
  if (geometry.needsOutpaint && settings.backgroundTransitionPixels > 0) {
    const blurred = await sharp(mask.data, { raw }).blur(settings.backgroundTransitionPixels / 2).toColourspace('b-w').raw().toBuffer()
    protection = Buffer.alloc(mask.data.length); blend = Buffer.alloc(mask.data.length)
    for (let i = 0; i < blend.length; i++) {
      blend[i] = Math.min(mask.data[i]!, Math.max(0, 2 * blurred[i]! - 255))
      protection[i] = blend[i] === 255 ? 255 : 0
    }
    for (const region of geometry.regions) {
      const left = Math.max(0, Math.floor(region.left)), right = Math.min(settings.width, Math.ceil(region.left + region.width))
      const top = Math.max(0, Math.floor(region.top)), bottom = Math.min(settings.height, Math.ceil(region.top + region.height))
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
        const index = y * settings.width + x
        protection[index] = mask.data[index]!; blend[index] = mask.data[index]!
      }
    }
    for (let i = 0; i < blend.length; i++) { protection[i] = Math.min(protection[i]!, mask.data[i]!); blend[i] = Math.min(blend[i]!, mask.data[i]!) }
  }
  if (geometry.needsOutpaint && (compositionMode === 'protected-context-v1' || compositionMode === 'protected-context-v2')) {
    const regions = geometry.regions.map(region => ({ left: Math.max(0, Math.floor(region.left)), right: Math.min(settings.width, Math.ceil(region.left + region.width)), top: Math.max(0, Math.floor(region.top)), bottom: Math.min(settings.height, Math.ceil(region.top + region.height)) }))
    const protectedPixels = Buffer.alloc(mask.data.length)
    for (const region of regions) for (let y = region.top; y < region.bottom; y++) protectedPixels.fill(255, y * settings.width + region.left, y * settings.width + region.right)
    blend = Buffer.from(blend)
    for (let y = 0; y < settings.height; y++) for (let x = 0; x < settings.width; x++) {
      const index = y * settings.width + x
      if (!mask.data[index]) continue
      if (protectedPixels[index]) { blend[index] = mask.data[index]!; continue }
      let distanceSquared = Infinity
      for (const region of regions) { const dx = Math.max(region.left - x, 0, x - (region.right - 1)), dy = Math.max(region.top - y, 0, y - (region.bottom - 1)); distanceSquared = Math.min(distanceSquared, dx * dx + dy * dy) }
      const distance = Math.sqrt(distanceSquared), context = settings.backgroundContextPixels, feather = settings.backgroundTransitionPixels
      const weight = distance <= context ? 1 : distance >= context + feather ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * (distance - context) / feather)
      blend[index] = Math.round(blend[index]! * weight)
    }
    if (compositionMode === 'protected-context-v2') {
      // Generation and composition share the editable background; V1 keeps its original request mask for saved receipts.
      protection = Buffer.alloc(mask.data.length)
      for (let i = 0; i < protection.length; i++) protection[i] = protectedPixels[i] || blend[i] === 255 ? mask.data[i]! : 0
    }
  }
  const editMask = await sharp({ create: { width: settings.width, height: settings.height, channels: 3, background: { r: 255, g: 255, b: 255 } } }).joinChannel(protection, { raw }).png().toBuffer()
  let image: Buffer<ArrayBufferLike> = seed
  let generatedSize: { width: number; height: number } | undefined
  if (background && (geometry.needsOutpaint || compositionMode === 'generated-canvas-v1' || compositionMode === 'generated-canvas-protected-v2')) {
    const generated = await sharp(background).metadata()
    if (!generated.width || !generated.height || Math.abs(generated.width - generated.height * settings.width / settings.height) > 1) throw new CuratorError('constraint-conflict', 'wallpaper-background', 'The generated background aspect ratio differs from the edit canvas. Replan or choose an output size with the same ratio.')
    generatedSize = { width: generated.width, height: generated.height }
    if (compositionMode === 'generated-canvas-v1') image = await sharp(background).resize(settings.width, settings.height, { fit: 'fill' }).toColourspace('srgb').png().toBuffer()
    else {
      const rgb = await sharp(seed).removeAlpha().png().toBuffer()
      // Restored generation keeps every existing source pixel, including deliberately cropped objects at the extension edge.
      const retained = await sharp(rgb).joinChannel(compositionMode === 'generated-canvas-protected-v2' ? mask.data : blend, { raw }).png().toBuffer()
      const generatedBackground = sharp(background).resize(settings.width, settings.height, { fit: 'fill' })
      // Some image edits return partial alpha across the whole frame; only the new source-restored mode uses their RGB as the reviewed opaque canvas.
      if (compositionMode === 'generated-canvas-protected-v2') generatedBackground.removeAlpha()
      image = await generatedBackground.composite([{ input: retained, left: 0, top: 0 }]).toColourspace('srgb').png().toBuffer()
      if (compositionMode === 'generated-canvas-protected-v2') image = await blendWallpaperSourceExterior(image, geometry.target, settings)
    }
  }
  return { image, mask: editMask, geometry, generatedSize }
}

/** Blend narrow newly exposed edges toward the source boundary, leaving every retained source pixel unchanged.
 * @param image Opaque source-restored canvas.
 * @param target Placed source rectangle within the canvas.
 * @param settings Frozen exterior blend distance.
 * @returns Canvas with a continuous source-to-extension transition outside the original.
 */
async function blendWallpaperSourceExterior(image: Uint8Array, target: { left: number; top: number; width: number; height: number }, settings: WallpaperSettings): Promise<Buffer> {
  const { blendPixels } = wallpaperProcessingSchema.parse(settings.processing ?? {}).sourceSeam
  const right = target.left + target.width, bottom = target.top + target.height
  const narrow = { left: target.left > 0 && target.left <= blendPixels, right: settings.width > right && settings.width - right <= blendPixels, top: target.top > 0 && target.top <= blendPixels, bottom: settings.height > bottom && settings.height - bottom <= blendPixels }
  if (!Object.values(narrow).some(Boolean)) return Buffer.isBuffer(image) ? image : Buffer.from(image)
  const decoded = await sharp(image).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = decoded.info, pixels = decoded.data
  const leftLimit = Math.max(0, target.left - blendPixels), rightLimit = Math.min(width, right + blendPixels)
  const topLimit = Math.max(0, target.top - blendPixels), bottomLimit = Math.min(height, bottom + blendPixels)
  for (let y = topLimit; y < bottomLimit; y++) for (let x = leftLimit; x < rightLimit; x++) {
    const dx = x < target.left ? target.left - x : x >= right ? x - right + 1 : 0
    const dy = y < target.top ? target.top - y : y >= bottom ? y - bottom + 1 : 0
    const distance = Math.max(dx, dy)
    if (!distance || distance >= blendPixels || dx && !(x < target.left ? narrow.left : narrow.right) || dy && !(y < target.top ? narrow.top : narrow.bottom)) continue
    const reflectedX = Math.max(target.left, Math.min(right - 1, x < target.left ? target.left + dx - 1 : x >= right ? right - dx : x))
    const reflectedY = Math.max(target.top, Math.min(bottom - 1, y < target.top ? target.top + dy - 1 : y >= bottom ? bottom - dy : y))
    const weight = (1 + Math.cos(Math.PI * (distance - 1) / (blendPixels - 1 || 1))) / 2
    const at = (y * width + x) * channels, source = (reflectedY * width + reflectedX) * channels
    for (let channel = 0; channel < 3; channel++) pixels[at + channel] = Math.round(pixels[source + channel]! * weight + pixels[at + channel]! * (1 - weight))
  }
  return sharp(pixels, { raw: { width, height, channels } }).png().toBuffer()
}

/** Measure visible discontinuities where generated pixels meet the exact retained source.
 * @param image Native composed canvas before optional super-resolution.
 * @param target Placed source intersection with the canvas.
 * @param settings Frozen segmentation and jump thresholds.
 * @param comparison Generated candidates compare with the placed source interior; source-restored composites compare with both sides.
 * @returns Edge segments whose cross-boundary color jump greatly exceeds the selected adjacent rows or columns.
 */
export async function wallpaperSourceSeams(image: Uint8Array, target: { left: number; top: number; width: number; height: number }, settings: WallpaperSettings, comparison: 'both' | 'source-interior' = 'both') {
  const decoded = await sharp(image).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = decoded.info, pixels = decoded.data
  const policy = wallpaperProcessingSchema.parse(settings.processing ?? {}).sourceSeam
  const value = (x: number, y: number, channel: number) => pixels[(y * width + x) * channels + channel]!
  const defects: { edge: 'top' | 'bottom' | 'left' | 'right'; from: number; to: number; across: number; adjacent: number }[] = []
  const assess = (edge: 'top' | 'bottom' | 'left' | 'right', start: number, end: number, boundary: number, vertical: boolean) => {
    for (let from = start; from < end; from += policy.segmentPixels) {
      const to = Math.min(end, from + policy.segmentPixels)
      let before = 0, across = 0, after = 0
      for (let position = from; position < to; position++) for (let channel = 0; channel < 3; channel++) {
        const sample = (offset: number) => vertical ? value(position, boundary + offset, channel) : value(boundary + offset, position, channel)
        before += Math.abs(sample(-2) - sample(-1))
        across += Math.abs(sample(-1) - sample(0))
        after += Math.abs(sample(0) - sample(1))
      }
      const count = (to - from) * 3, crossMean = across / count
      const neighborMean = (comparison === 'source-interior' ? edge === 'top' || edge === 'left' ? after : before : Math.max(before, after)) / count
      if (crossMean >= policy.minimumCrossMean && crossMean >= policy.minimumRelative * neighborMean) defects.push({ edge, from, to, across: Math.round(crossMean * 10) / 10, adjacent: Math.round(neighborMean * 10) / 10 })
    }
  }
  if (target.top >= 2 && target.top + 1 < height) assess('top', target.left, target.left + target.width, target.top, true)
  const bottom = target.top + target.height
  if (bottom >= 2 && bottom + 1 < height) assess('bottom', target.left, target.left + target.width, bottom, true)
  if (target.left >= 2 && target.left + 1 < width) assess('left', target.top, target.top + target.height, target.left, false)
  const right = target.left + target.width
  if (right >= 2 && right + 1 < width) assess('right', target.top, target.top + target.height, right, false)
  return defects
}

/** Check authorized source-frame contacts in the native generated image before super-resolution can hide a hard cut.
 * @param image Complete native generated candidate.
 * @param target Placed source rectangle in target-canvas pixels.
 * @param canvas Frozen target-canvas dimensions.
 * @param native Actual candidate dimensions.
 * @param edges Source edges with authorized local continuation.
 * @param settings Frozen seam thresholds.
 * @returns Measured hard cuts at authorized contacts only.
 */
export async function wallpaperGeneratedFrameSeams(image: Uint8Array, target: { left: number; top: number; width: number; height: number }, canvas: { width: number; height: number }, native: { width: number; height: number }, edges: readonly ('top' | 'bottom' | 'left' | 'right')[], settings: WallpaperSettings) {
  if (!edges.length) return []
  const left = Math.round(target.left * native.width / canvas.width), top = Math.round(target.top * native.height / canvas.height)
  const right = Math.round((target.left + target.width) * native.width / canvas.width)
  const bottom = Math.round((target.top + target.height) * native.height / canvas.height)
  return (await wallpaperSourceSeams(image, { left, top, width: right - left, height: bottom - top }, settings, 'source-interior')).filter(seam => edges.includes(seam.edge))
}

/** Produce separate annotations and a simulated lock screen; clean output bytes remain unchanged.
 * @param image Actual seed or final pixels.
 * @param geometry Inferred-region transform.
 * @param settings Frozen template.
 * @returns Diagnostic and simulated images.
 */
export async function wallpaperOverlays(image: Uint8Array, geometry: ReturnType<typeof wallpaperGeometry>, settings: WallpaperSettings) {
  const { width, height, safe } = settings
  const topBuffer = settings.processing?.clockContrast ? settings.topBuffer : 0
  const regions = geometry.regions.map((region, i) => `<rect x="${region.left}" y="${region.top}" width="${region.width}" height="${region.height}" fill="none" stroke="${region.role === 'critical' ? '#ffb84d' : '#92d5ff'}" stroke-width="6"/><text x="${region.left + 8}" y="${region.top + 30}" font-size="30" fill="white">${i + 1}</text>`).join('')
  const svg = (body: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`)
  const guides = svg(`<rect width="${width}" height="${safe.top}" fill="#f44848" fill-opacity=".18"/><rect x="${safe.left}" y="${safe.top}" width="${safe.width}" height="${safe.height}" fill="#41d88d" fill-opacity=".08"/>${topBuffer ? `<rect y="${safe.top}" width="${width}" height="${topBuffer}" fill="#ffb84d" fill-opacity=".16"/>` : ''}<path d="M${safe.left} 0V${height}M${safe.left + safe.width} 0V${height}M0 ${safe.top}H${width}M0 ${safe.top + safe.height}H${width}" stroke="#32d8e8" stroke-width="5"/><path d="M${width / 2} 0V${height}M0 ${height / 2}H${width}${topBuffer ? `M0 ${safe.top + topBuffer}H${width}` : ''}" stroke="#fff" stroke-opacity=".4" stroke-width="3" stroke-dasharray="14 14"/>${regions}`)
  const clock = wallpaperClockSvg(settings)
  return { analysis: await sharp(image).composite([{ input: guides }]).png().toBuffer(), simulation: await sharp(image).composite([{ input: clock }]).png().toBuffer() }
}
