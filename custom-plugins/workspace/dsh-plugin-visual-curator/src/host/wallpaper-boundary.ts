/** Measure small peripheral details against the frozen wallpaper safety policy. */
import { wallpaperEnclosingRect, wallpaperGeometry, wallpaperProtectedBounds, wallpaperObjectProtectionRegions, wallpaperPracticalRegionBoundary } from '../shared/wallpaper-geometry.ts'
import { wallpaperProcessingSchema, wallpaperGenerativeRepair, wallpaperPracticalAcceptance } from '../shared/wallpaper-policy.ts'
import type { WallpaperPlan, WallpaperSettings } from '../shared/wallpaper.ts'
import type { z } from 'zod'
import type { WallpaperSourceLayout } from '../shared/wallpaper-geometry.ts'
import { wallpaperSourceReviewV4Schema } from '../shared/wallpaper.ts'

type ActualLayout = z.infer<typeof wallpaperSourceReviewV4Schema>['actualLayout']
type Rect = ActualLayout['regions'][number]['rect']

/** @param layout Independently observed final-pixel regions. @param mode Observed subject mode. @param settings Frozen output and tolerance. @param sourceLayout New-task output focus and size targets; omission retains historical complete-region checks. @returns Hard geometry failures and measured nonblocking warnings. */
export function wallpaperActualBoundary(layout: ActualLayout, mode: WallpaperPlan['mode'], settings: WallpaperSettings, sourceLayout?: WallpaperSourceLayout) {
  const visible = layout.regions.filter(region => region.scope === 'core')
  const focus = sourceLayout ? visible.map(region => region.role === 'subject' && region.safetyClass !== 'automobile' && region.layoutFocus ? { ...region, rect: region.layoutFocus } : region) : visible
  const core = sourceLayout?.reviewWholeSubjects ? visible : focus
  const protectedCore = wallpaperGenerativeRepair(settings) ? wallpaperObjectProtectionRegions({ mode, regions: core }, settings) : core
  const geometry = wallpaperGeometry(settings, { version: 1, imageVersionId: layout.imageVersionId, mode, subject: 'Actual output', evidence: 'Actual output', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: protectedCore, placement: { scale: 1, left: 0, top: 0 }, reason: 'Actual output coordinates' }, settings, sourceLayout, focus)
  const hard = [...geometry.checks], warnings = [...geometry.warnings]
  const bounds = wallpaperProtectedBounds(settings), policy = wallpaperProcessingSchema.parse(settings.processing ?? {})
  if (sourceLayout?.reviewWholeSubjects) for (const region of geometry.regions) {
    if (region.left < bounds.critical.left || region.top < bounds.top ||
        region.left + region.width > bounds.critical.right || region.top + region.height > bounds.critical.bottom) hard.push(`critical-outside:${region.name}`)
  }
  if (sourceLayout?.alignment === 'subject-fill-v1') {
    const planned = sourceLayout.expectedSubjects ?? []
    const observed = planned.flatMap(expected => {
      const region = core.find(region => region.role === 'subject' && region.entityId === expected.entityId)
      return region ? [region.rect] : []
    })
    const targetGroup = wallpaperEnclosingRect(planned.map(expected => expected.rect))
    const actualGroup = observed.length === planned.length ? wallpaperEnclosingRect(observed) : undefined
    if (targetGroup && actualGroup) {
      const x = (actualGroup.x + actualGroup.width / 2 - targetGroup.x - targetGroup.width / 2) * settings.width
      const y = (actualGroup.y + actualGroup.height / 2 - targetGroup.y - targetGroup.height / 2) * settings.height
      if (Math.abs(x) > settings.safe.width * sourceLayout.fill.maximumCenterDrift || Math.abs(y) > (bounds.critical.bottom - bounds.top) * sourceLayout.fill.maximumCenterDrift) hard.push(`subject-center-drift:${Math.round(x)},${Math.round(y)}`)
    }
    const relative = sourceLayout.fill.relativeLayout
    if (relative) {
      const span = (rect: Rect) => Math.max(rect.width * settings.width, rect.height * settings.height)
      const center = (rect: Rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })
      const matches = planned.flatMap(expected => {
        const actual = visible.find(region => region.role === 'subject' && region.entityId === expected.entityId)
        if (!actual) return []
        if (expected.wholeRect) {
          const xScale = actual.rect.width / expected.wholeRect.width, yScale = actual.rect.height / expected.wholeRect.height
          if (Math.min(xScale, yScale) / Math.max(xScale, yScale) < relative.minimumWholeAspectRatio) hard.push(`subject-aspect-changed:${actual.name}`)
        }
        const target = expected.focus ?? expected.rect
        const measured = actual.safetyClass === 'automobile' ? actual.rect : actual.layoutFocus ?? actual.rect
        return [{ name: actual.name, sourceCenter: center(target), actualCenter: center(measured), scale: span(measured) / span(target) }]
      })
      for (const [index, first] of matches.entries()) for (const second of matches.slice(index + 1)) {
        const pair = `${first.name} · ${second.name}`
        if (Math.min(first.scale, second.scale) / Math.max(first.scale, second.scale) < relative.minimumRelativeScaleRatio) hard.push(`subject-relative-scale:${pair}`)
        // Compare the displacement after removing the group's common scale and translation.
        const groupScale = (first.scale + second.scale) / 2
        const x = second.actualCenter.x - first.actualCenter.x - (second.sourceCenter.x - first.sourceCenter.x) * groupScale
        const y = second.actualCenter.y - first.actualCenter.y - (second.sourceCenter.y - first.sourceCenter.y) * groupScale
        if (Math.abs(x) * settings.width > settings.safe.width * sourceLayout.fill.maximumCenterDrift ||
            Math.abs(y) * settings.height > (bounds.critical.bottom - bounds.top) * sourceLayout.fill.maximumCenterDrift) hard.push(`subject-relative-position:${pair}`)
      }
      for (const expected of sourceLayout.expectedActionParts ?? []) {
        const actual = visible.find(region => region.role === 'critical' && region.entityId === expected.entityId)
        if (!actual) hard.push(`missing-action-part:${expected.name}`)
        else if (span(actual.rect) / span(expected.rect) < relative.minimumRelativeScaleRatio) hard.push(`action-part-too-small:${expected.name}`)
      }
    }
  }
  const practical = wallpaperPracticalAcceptance(settings)
  const canvasArea = settings.width * settings.height
  let outsideTotal = 0
  for (const region of layout.regions.filter(region => region.scope === 'peripheral')) {
    const left = region.rect.x * settings.width, top = region.rect.y * settings.height
    const right = (region.rect.x + region.rect.width) * settings.width, bottom = (region.rect.y + region.rect.height) * settings.height
    if (region.role !== 'subject') hard.push(`peripheral-critical:${region.name}`)
    if (practical?.version === 'practical-v2' && region.safetyClass === 'automobile') {
      const automobile = wallpaperPracticalRegionBoundary({ ...region, left, top, width: right - left, height: bottom - top }, settings)
      if (automobile) { hard.push(...automobile.hard); warnings.push(...automobile.warnings) }
      continue
    }
    if (!practical && top < bounds.clockBottom) hard.push(`${settings.processing?.clockContrast ? 'clock-overlap' : 'safe-top-overlap'}:${region.name}`)
    else if (!practical && top < bounds.top) hard.push(`top-buffer-overlap:${region.name}`)
    const area = (right - left) * (bottom - top)
    const insideWidth = Math.max(0, Math.min(right, bounds.critical.right) - Math.max(left, bounds.critical.left))
    const insideHeight = Math.max(0, Math.min(bottom, bounds.critical.bottom) - Math.max(top, bounds.top))
    const outside = Math.max(0, area - insideWidth * insideHeight)
    outsideTotal += outside
    if (!practical && outside > canvasArea * policy.maxPeripheralOutsideAreaRatio) hard.push(`peripheral-overflow:${region.name}`)
    else if (outside > 0) warnings.push(`peripheral-outside:${region.name}`)
  }
  if (outsideTotal > canvasArea * policy.maxTotalOutsideAreaRatio) (practical ? warnings : hard).push('peripheral-total-overflow')
  if (hard.length) warnings.length = 0
  return { hard: [...new Set(hard)], warnings }
}
