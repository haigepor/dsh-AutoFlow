/** Source transforms and protected-region checks run without image decoding. */
import type { WallpaperPlan, WallpaperSettings } from './wallpaper.ts'
import { CuratorError } from './errors.ts'

/** @param settings Frozen output and allowed noncritical overflow. @returns Exact protected limits used by geometry checks and model input. */
export function wallpaperProtectedBounds(settings: WallpaperSettings) {
  const { safe } = settings
  return { top: safe.top + settings.topBuffer, clockBottom: safe.top,
    critical: { left: safe.left, right: safe.left + safe.width, bottom: safe.top + safe.height },
    subject: { left: safe.left - settings.sideOverflow, right: safe.left + safe.width + settings.sideOverflow, bottom: safe.top + safe.height + settings.bottomOverflow } }
}

/** Measure the source transform and check the model's inferred regions.
 * @param source Oriented source dimensions.
 * @param plan Saved inferred layout.
 * @param settings Frozen output template.
 * @returns Measured canvas intersection, transformed regions and constraint failures.
 */
export function wallpaperGeometry(source: { width: number; height: number }, plan: WallpaperPlan, settings: WallpaperSettings) {
  const width = Math.max(1, Math.round(source.width * plan.placement.scale)), height = Math.max(1, Math.round(source.height * plan.placement.scale))
  const { left, top } = plan.placement, bounds = wallpaperProtectedBounds(settings)
  const target = { left: Math.max(0, left), top: Math.max(0, top), width: Math.min(settings.width, left + width) - Math.max(0, left), height: Math.min(settings.height, top + height) - Math.max(0, top) }
  if (target.width <= 0 || target.height <= 0) throw new CuratorError('invalid-input', 'wallpaper-layout', 'The source does not intersect the output canvas.')
  const regions = plan.regions.map(region => ({ ...region, left: left + region.rect.x * width, top: top + region.rect.y * height, width: region.rect.width * width, height: region.rect.height * height }))
  const checks: string[] = []
  if (plan.mode === 'uncertain' || plan.uncertainties.length || !regions.length) checks.push('uncertain-subject')
  if ((plan.mode === 'single' || plan.mode === 'group') && (!regions.some(region => region.role === 'subject') || !regions.some(region => region.role === 'critical'))) checks.push('missing-protected-regions')
  for (const region of regions) {
    const right = region.left + region.width, bottom = region.top + region.height
    if (region.left < 0 || region.top < 0 || right > settings.width || bottom > settings.height) checks.push(`clipped:${region.name}`)
    if (region.top < bounds.clockBottom) checks.push(`clock-overlap:${region.name}`)
    else if (region.top < bounds.top) checks.push(`top-buffer-overlap:${region.name}`)
    const critical = region.role === 'critical' || region.role === 'anchor'
    if (critical && (region.left < bounds.critical.left || right > bounds.critical.right || bottom > bounds.critical.bottom)) checks.push(`critical-outside:${region.name}`)
    if (!critical && (region.left < bounds.subject.left || right > bounds.subject.right || bottom > bounds.subject.bottom)) checks.push(`subject-overflow:${region.name}`)
  }
  return { width, height, left, top, target, regions, checks: [...new Set(checks)], needsOutpaint: target.width * target.height < settings.width * settings.height }
}
