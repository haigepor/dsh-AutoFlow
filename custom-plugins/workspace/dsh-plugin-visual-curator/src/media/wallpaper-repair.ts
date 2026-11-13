/** Authorized edits open defective regions without unlocking healthy source pixels by default. */
import sharp from 'sharp'
import type { WallpaperItem, WallpaperPlan, WallpaperSettings } from '../shared/wallpaper.ts'
import { wallpaperGenerativeRepair, wallpaperReviewNeedsSubjectEdit } from '../shared/wallpaper-policy.ts'
import { wallpaperSourceExtensionEdges } from '../shared/wallpaper-geometry.ts'

/** @param plan Source observations. @param settings Frozen authorization. @returns Whether observed source truncation needs a generated candidate; truncation alone never unlocks healthy subject interiors. */
export function wallpaperSourceRepairNeeded(plan: WallpaperPlan, settings: WallpaperSettings): boolean {
  return wallpaperGenerativeRepair(settings) && (plan.truncations.length > 0 || wallpaperSourceExtensionEdges(plan, settings).length > 0)
}

/** @param mask Existing saved full-canvas edit mask. @param plan Source placement. @param settings Frozen task policy. @param attempts Retained independent defects. @param source Original dimensions. @param clockBackgroundNeedsEdit Measured first-pass defect under an explicitly configured clock policy. @returns An alpha mask opening authorized repair targets; conservative tasks keep their mask. */
export async function wallpaperRepairMask(mask: Buffer<ArrayBuffer>, plan: WallpaperPlan, settings: WallpaperSettings, attempts: WallpaperItem['attempts'], source: { width: number; height: number }, clockBackgroundNeedsEdit = false): Promise<Buffer<ArrayBuffer>> {
  if (!wallpaperGenerativeRepair(settings)) return mask
  const review = attempts.findLast(attempt => attempt.review)?.review
  const subjectDefect = wallpaperReviewNeedsSubjectEdit(review)
  const edges = wallpaperSourceExtensionEdges(plan, settings)
  const readabilityDefect = !!settings.processing?.clockContrast && (clockBackgroundNeedsEdit || review?.checks.readability.result !== undefined && review.checks.readability.result !== 'satisfied')
  if (!subjectDefect && !readabilityDefect && !edges.length) return mask
  const width = Math.round(source.width * plan.placement.scale), height = Math.round(source.height * plan.placement.scale)
  const regions = review && 'actualLayout' in review ? review.actualLayout.regions.map(region => ({ left: region.rect.x * settings.width, top: region.rect.y * settings.height, width: region.rect.width * settings.width, height: region.rect.height * settings.height })) : plan.regions.map(region => ({ left: plan.placement.left + region.rect.x * width, top: plan.placement.top + region.rect.y * height, width: region.rect.width * width, height: region.rect.height * height }))
  const targets = subjectDefect ? regions : []
  const { data, info } = await sharp(mask).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const margin = settings.sourceFrameRepair?.marginPixels ?? 0
  for (const edge of edges) {
    const left = Math.max(0, plan.placement.left), top = Math.max(0, plan.placement.top)
    const right = Math.min(info.width, plan.placement.left + width), bottom = Math.min(info.height, plan.placement.top + height)
    const x0 = edge === 'right' ? Math.max(left, right - margin) : left
    const y0 = edge === 'bottom' ? Math.max(top, bottom - margin) : top
    const x1 = edge === 'left' ? Math.min(right, left + margin) : right
    const y1 = edge === 'top' ? Math.min(bottom, top + margin) : bottom
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[(y * info.width + x) * info.channels + info.channels - 1] = 0
  }
  for (const target of targets) {
    const left = Math.max(0, Math.floor(target.left - target.width * 0.05)), top = Math.max(0, Math.floor(target.top - target.height * 0.05))
    const right = Math.min(info.width, Math.ceil(target.left + target.width * 1.05)), bottom = Math.min(info.height, Math.ceil(target.top + target.height * 1.05))
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) data[(y * info.width + x) * info.channels + info.channels - 1] = 0
  }
  if (readabilityDefect) {
    const left = Math.floor(info.width * 0.2), right = Math.ceil(info.width * 0.8), bottom = Math.min(info.height, Math.ceil(settings.safe.top * info.height / settings.height))
    for (let y = 0; y < bottom; y++) for (let x = left; x < right; x++) data[(y * info.width + x) * info.channels + info.channels - 1] = 0
  }
  return sharp(data, { raw: info }).png().toBuffer()
}
