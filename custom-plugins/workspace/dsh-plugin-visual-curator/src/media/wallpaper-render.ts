/** Deterministic layout protects source subjects and keeps diagnostic and lock-screen layers separate. */
import sharp from 'sharp'
import type { WallpaperPlan, WallpaperSettings, WallpaperCompositionMode } from '../shared/wallpaper.ts'
import { CuratorError } from '../shared/errors.ts'
import { wallpaperGeometry } from '../shared/wallpaper-geometry.ts'

export { wallpaperGeometry } from '../shared/wallpaper-geometry.ts'

/** Render an isotropic placement; only unprotected source-background edges may blend with generated pixels.
 * @param bytes Verified oriented original.
 * @param plan Inferred layout.
 * @param settings Frozen template.
 * @param background Optional generated background; omission leaves transparent uncovered pixels.
 * @param compositionMode Explicit saved-output recovery; absence retains source-edge blending and the original request mask.
 * @returns Actual image, alpha mask and measured transform.
 */
export async function renderWallpaper(bytes: Uint8Array, plan: WallpaperPlan, settings: WallpaperSettings, background?: Uint8Array, compositionMode: WallpaperCompositionMode = 'source-edge-v1') {
  const metadata = await sharp(bytes).metadata()
  if (!metadata.width || !metadata.height) throw new CuratorError('invalid-input', 'wallpaper-render', 'Source dimensions are unavailable.')
  const geometry = wallpaperGeometry({ width: metadata.width, height: metadata.height }, plan, settings)
  const patch = await sharp(bytes).resize(geometry.width, geometry.height, { fit: 'fill', withoutEnlargement: true }).extract({ left: geometry.target.left - geometry.left, top: geometry.target.top - geometry.top, width: geometry.target.width, height: geometry.target.height }).png().toBuffer()
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
  let image = seed
  let generatedSize: { width: number; height: number } | undefined
  if (background && geometry.needsOutpaint) {
    const generated = await sharp(background).metadata()
    if (!generated.width || !generated.height || Math.abs(generated.width - generated.height * settings.width / settings.height) > 1) throw new CuratorError('constraint-conflict', 'wallpaper-background', 'The generated background aspect ratio differs from the edit canvas. Replan or choose an output size with the same ratio.')
    generatedSize = { width: generated.width, height: generated.height }
    const rgb = await sharp(seed).removeAlpha().png().toBuffer()
    const retained = await sharp(rgb).joinChannel(blend, { raw }).png().toBuffer()
    image = await sharp(background).resize(settings.width, settings.height, { fit: 'fill' }).composite([{ input: retained, left: 0, top: 0 }]).toColourspace('srgb').png().toBuffer()
  }
  return { image, mask: editMask, geometry, generatedSize }
}

/** Produce separate annotations and a simulated lock screen; clean output bytes remain unchanged.
 * @param image Actual seed or final pixels.
 * @param geometry Inferred-region transform.
 * @param settings Frozen template.
 * @returns Diagnostic and simulated images.
 */
export async function wallpaperOverlays(image: Uint8Array, geometry: ReturnType<typeof wallpaperGeometry>, settings: WallpaperSettings) {
  const { width, height, safe } = settings
  const regions = geometry.regions.map((region, i) => `<rect x="${region.left}" y="${region.top}" width="${region.width}" height="${region.height}" fill="none" stroke="${region.role === 'critical' ? '#ffb84d' : '#92d5ff'}" stroke-width="6"/><text x="${region.left + 8}" y="${region.top + 30}" font-size="30" fill="white">${i + 1}</text>`).join('')
  const svg = (body: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`)
  const guides = svg(`<rect width="${width}" height="${safe.top}" fill="#f44848" fill-opacity=".18"/><rect x="${safe.left}" y="${safe.top}" width="${safe.width}" height="${safe.height}" fill="#41d88d" fill-opacity=".08"/><rect y="${safe.top}" width="${width}" height="${settings.topBuffer}" fill="#ffb84d" fill-opacity=".16"/><path d="M${safe.left} 0V${height}M${safe.left + safe.width} 0V${height}M0 ${safe.top}H${width}M0 ${safe.top + safe.height}H${width}" stroke="#32d8e8" stroke-width="5"/><path d="M${width / 2} 0V${height}M0 ${height / 2}H${width}M0 ${safe.top + settings.topBuffer}H${width}" stroke="#fff" stroke-opacity=".4" stroke-width="3" stroke-dasharray="14 14"/>${regions}`)
  const clock = svg(`<g fill="white" font-family="Arial,sans-serif" text-anchor="middle"><text x="${width / 2}" y="550" font-size="80">12 / 09</text><text x="${width / 2}" y="970" font-size="430">09:40</text></g><g fill="white" fill-opacity=".8"><circle cx="150" cy="${height - 155}" r="60"/><circle cx="${width - 150}" cy="${height - 155}" r="60"/><rect x="${width / 2 - 190}" y="${height - 65}" width="380" height="18" rx="9"/></g>`)
  return { analysis: await sharp(image).composite([{ input: guides }]).png().toBuffer(), simulation: await sharp(image).composite([{ input: clock }]).png().toBuffer() }
}
