/** Deterministic layout preserves source pixels and creates separate diagnostic and lock-screen layers. */
import sharp from 'sharp'
import type { WallpaperPlan, WallpaperSettings } from '../shared/wallpaper.ts'
import { CuratorError } from '../shared/errors.ts'

/** Measure the source transform and check the model's inferred regions.
 * @param source Oriented source dimensions.
 * @param plan Saved inferred layout.
 * @param settings Frozen output template.
 * @returns Measured canvas intersection, transformed regions and constraint failures.
 */
export function wallpaperGeometry(source: { width: number; height: number }, plan: WallpaperPlan, settings: WallpaperSettings) {
  const width = Math.max(1, Math.round(source.width * plan.placement.scale)), height = Math.max(1, Math.round(source.height * plan.placement.scale))
  const { left, top } = plan.placement, safe = settings.safe
  const target = { left: Math.max(0, left), top: Math.max(0, top), width: Math.min(settings.width, left + width) - Math.max(0, left), height: Math.min(settings.height, top + height) - Math.max(0, top) }
  if (target.width <= 0 || target.height <= 0) throw new CuratorError('invalid-input', 'wallpaper-layout', 'The source does not intersect the output canvas.')
  const regions = plan.regions.map(region => ({ ...region, left: left + region.rect.x * width, top: top + region.rect.y * height, width: region.rect.width * width, height: region.rect.height * height }))
  const checks: string[] = []
  if (plan.mode === 'uncertain' || plan.uncertainties.length || !regions.length) checks.push('uncertain-subject')
  if ((plan.mode === 'single' || plan.mode === 'group') && (!regions.some(region => region.role === 'subject') || !regions.some(region => region.role === 'critical'))) checks.push('missing-protected-regions')
  for (const region of regions) {
    const right = region.left + region.width, bottom = region.top + region.height
    if (region.left < 0 || region.top < 0 || right > settings.width || bottom > settings.height) checks.push(`clipped:${region.name}`)
    if (region.top < safe.top) checks.push(`clock-overlap:${region.name}`)
    const critical = region.role === 'critical' || region.role === 'anchor'
    if (critical && (region.left < safe.left || right > safe.left + safe.width || bottom > safe.top + safe.height)) checks.push(`critical-outside:${region.name}`)
    if (!critical && (region.left < safe.left - settings.sideOverflow || right > safe.left + safe.width + settings.sideOverflow || bottom > safe.top + safe.height + settings.bottomOverflow)) checks.push(`subject-overflow:${region.name}`)
  }
  return { width, height, left, top, target, regions, checks: [...new Set(checks)], needsOutpaint: target.width * target.height < settings.width * settings.height }
}

/** Render an isotropic source placement; generated backgrounds never replace retained source pixels.
 * @param bytes Verified oriented original.
 * @param plan Inferred layout.
 * @param settings Frozen template.
 * @param background Optional generated background; omission leaves transparent uncovered pixels.
 * @returns Actual image, alpha mask and measured transform.
 */
export async function renderWallpaper(bytes: Uint8Array, plan: WallpaperPlan, settings: WallpaperSettings, background?: Uint8Array) {
  const metadata = await sharp(bytes).metadata()
  if (!metadata.width || !metadata.height) throw new CuratorError('invalid-input', 'wallpaper-render', 'Source dimensions are unavailable.')
  const geometry = wallpaperGeometry({ width: metadata.width, height: metadata.height }, plan, settings)
  const patch = await sharp(bytes).resize(geometry.width, geometry.height, { fit: 'fill', withoutEnlargement: true }).extract({ left: geometry.target.left - geometry.left, top: geometry.target.top - geometry.top, width: geometry.target.width, height: geometry.target.height }).png().toBuffer()
  const canvas = { width: settings.width, height: settings.height, channels: 4 as const, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  const seed = await sharp({ create: canvas }).composite([{ input: patch, left: geometry.target.left, top: geometry.target.top }]).png().toBuffer()
  const mask = await sharp(seed).ensureAlpha().extractChannel('alpha').toBuffer({ resolveWithObject: true })
  const editMask = await sharp({ create: { width: settings.width, height: settings.height, channels: 3, background: { r: 255, g: 255, b: 255 } } }).joinChannel(mask.data).png().toBuffer()
  const image = background ? await sharp(background).resize(settings.width, settings.height, { fit: 'cover' }).composite([{ input: patch, left: geometry.target.left, top: geometry.target.top }]).toColourspace('srgb').png().toBuffer() : seed
  return { image, mask: editMask, geometry }
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
  const guides = svg(`<rect width="${width}" height="${safe.top}" fill="#f44848" fill-opacity=".18"/><rect x="${safe.left}" y="${safe.top}" width="${safe.width}" height="${safe.height}" fill="#41d88d" fill-opacity=".08"/><path d="M${safe.left} 0V${height}M${safe.left + safe.width} 0V${height}M0 ${safe.top}H${width}M0 ${safe.top + safe.height}H${width}" stroke="#32d8e8" stroke-width="5"/><line x1="${width / 2}" x2="${width / 2}" y1="0" y2="${height}" stroke="#fff" stroke-opacity=".4" stroke-width="3" stroke-dasharray="14 14"/>${regions}`)
  const clock = svg(`<g fill="white" font-family="Arial,sans-serif" text-anchor="middle"><text x="${width / 2}" y="550" font-size="80">12 / 09</text><text x="${width / 2}" y="970" font-size="430">09:40</text></g><g fill="white" fill-opacity=".8"><circle cx="150" cy="${height - 155}" r="60"/><circle cx="${width - 150}" cy="${height - 155}" r="60"/><rect x="${width / 2 - 190}" y="${height - 65}" width="380" height="18" rx="9"/></g>`)
  return { analysis: await sharp(image).composite([{ input: guides }]).png().toBuffer(), simulation: await sharp(image).composite([{ input: clock }]).png().toBuffer() }
}
