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

/** Fit all inferred protected regions with the same rounded source geometry used by rendering.
 * @param source Oriented original dimensions. @param observed Model observations without pixel placement. @param settings Frozen safe area and output size. @param policy V2 fills the permitted object area with available native pixels when a direct crop cannot fit.
 * @returns Source placement that prefers a direct crop and never enlarges the original; semantic uncertainty remains in the plan.
 */
export function fitWallpaperPlacement(source: { width: number; height: number }, observed: Omit<WallpaperPlan, 'placement'>, settings: WallpaperSettings, policy: 'crop-first-v1' | 'subject-first-v2' = 'crop-first-v1'): WallpaperPlan['placement'] {
  const bounds = wallpaperProtectedBounds(settings)
  const intervals = (scale: number) => {
    const width = Math.max(1, Math.round(source.width * scale)), height = Math.max(1, Math.round(source.height * scale))
    let left = -width + 1, right = settings.width - 1, top = -height + 1, bottom = settings.height - 1
    for (const region of observed.regions) {
      const allowed = region.role === 'subject' ? bounds.subject : bounds.critical
      left = Math.max(left, Math.ceil(Math.max(0, allowed.left) - region.rect.x * width))
      right = Math.min(right, Math.floor(Math.min(settings.width, allowed.right) - (region.rect.x + region.rect.width) * width))
      top = Math.max(top, Math.ceil(bounds.top - region.rect.y * height))
      bottom = Math.min(bottom, Math.floor(Math.min(settings.height, allowed.bottom) - (region.rect.y + region.rect.height) * height))
    }
    return { width, height, left, right, top, bottom, feasible: left <= right && top <= bottom }
  }
  const cropScale = Math.min(1, Math.max(settings.width / source.width, settings.height / source.height))
  const crop = intervals(cropScale)
  const canCrop = crop.feasible && crop.width >= settings.width && crop.height >= settings.height && Math.max(crop.left, settings.width - crop.width) <= Math.min(crop.right, 0) && Math.max(crop.top, settings.height - crop.height) <= Math.min(crop.bottom, 0)
  let scale = policy === 'subject-first-v2' && (observed.mode === 'single' || observed.mode === 'group') && !canCrop ? 1 : cropScale, limits = intervals(scale)
  if (!limits.feasible) {
    let lower = 0, upper = scale
    // Rounded dimensions make feasibility monotonic; the final interval is checked again by wallpaperGeometry.
    for (let i = 0; i < 40; i++) { const middle = (lower + upper) / 2; if (intervals(middle).feasible) lower = middle; else upper = middle }
    scale = lower; limits = intervals(scale)
  }
  if (!scale || !limits.feasible) throw new CuratorError('constraint-conflict', 'wallpaper-layout', 'The protected regions cannot fit the frozen safe area.')
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(value)))
  const cropLeft = Math.max(limits.left, settings.width - limits.width), cropRight = Math.min(limits.right, 0)
  const cropTop = Math.max(limits.top, settings.height - limits.height), cropBottom = Math.min(limits.bottom, 0)
  if (limits.width >= settings.width && limits.height >= settings.height && cropLeft <= cropRight && cropTop <= cropBottom) return { scale, left: clamp((settings.width - limits.width) / 2, cropLeft, cropRight), top: clamp((settings.height - limits.height) / 2, cropTop, cropBottom) }
  const subjects = observed.regions.filter(region => region.role === 'subject'), focus = subjects.length ? subjects : observed.regions
  const centerY = focus.length ? (Math.min(...focus.map(region => region.rect.y)) + Math.max(...focus.map(region => region.rect.y + region.rect.height))) / 2 : 0.5
  return { scale, left: clamp((settings.width - limits.width) / 2, limits.left, limits.right), top: clamp((bounds.top + bounds.critical.bottom) / 2 - centerY * limits.height, limits.top, limits.bottom) }
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
