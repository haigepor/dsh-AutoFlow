/** Measure small peripheral details against the frozen wallpaper safety policy. */
import { wallpaperGeometry, wallpaperProtectedBounds, wallpaperObjectProtectionRegions } from '../shared/wallpaper-geometry.ts'
import { wallpaperProcessingSchema, wallpaperGenerativeRepair } from '../shared/wallpaper-policy.ts'
import type { WallpaperPlan, WallpaperSettings } from '../shared/wallpaper.ts'
import type { z } from 'zod'
import { wallpaperSourceReviewV4Schema } from '../shared/wallpaper.ts'

type ActualLayout = z.infer<typeof wallpaperSourceReviewV4Schema>['actualLayout']

/** @param layout Independently observed final-pixel regions. @param mode Observed subject mode. @param settings Frozen output and tolerance. @returns Hard geometry failures and measured nonblocking warnings. */
export function wallpaperActualBoundary(layout: ActualLayout, mode: WallpaperPlan['mode'], settings: WallpaperSettings) {
  const core = layout.regions.filter(region => region.scope === 'core')
  const protectedCore = wallpaperGenerativeRepair(settings) ? wallpaperObjectProtectionRegions({ mode, regions: core }) : core
  const geometry = wallpaperGeometry(settings, { version: 1, imageVersionId: layout.imageVersionId, mode, subject: 'Actual output', evidence: 'Actual output', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: protectedCore, placement: { scale: 1, left: 0, top: 0 }, reason: 'Actual output coordinates' }, settings)
  const hard = [...geometry.checks], warnings: string[] = []
  const bounds = wallpaperProtectedBounds(settings), policy = wallpaperProcessingSchema.parse(settings.processing ?? {})
  const canvasArea = settings.width * settings.height
  let outsideTotal = 0
  for (const region of layout.regions.filter(region => region.scope === 'peripheral')) {
    const left = region.rect.x * settings.width, top = region.rect.y * settings.height
    const right = (region.rect.x + region.rect.width) * settings.width, bottom = (region.rect.y + region.rect.height) * settings.height
    if (region.role !== 'subject') hard.push(`peripheral-critical:${region.name}`)
    if (top < bounds.clockBottom) hard.push(`${settings.processing?.clockContrast ? 'clock-overlap' : 'safe-top-overlap'}:${region.name}`)
    else if (top < bounds.top) hard.push(`top-buffer-overlap:${region.name}`)
    const area = (right - left) * (bottom - top)
    const insideWidth = Math.max(0, Math.min(right, bounds.critical.right) - Math.max(left, bounds.critical.left))
    const insideHeight = Math.max(0, Math.min(bottom, bounds.critical.bottom) - Math.max(top, bounds.top))
    const outside = Math.max(0, area - insideWidth * insideHeight)
    outsideTotal += outside
    if (outside > canvasArea * policy.maxPeripheralOutsideAreaRatio) hard.push(`peripheral-overflow:${region.name}`)
    else if (outside > 0) warnings.push(`peripheral-outside:${region.name}`)
  }
  if (outsideTotal > canvasArea * policy.maxTotalOutsideAreaRatio) hard.push('peripheral-total-overflow')
  if (hard.length) warnings.length = 0
  return { hard: [...new Set(hard)], warnings }
}
