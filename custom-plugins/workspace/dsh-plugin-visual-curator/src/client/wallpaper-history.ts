/** Read-only milestones for one image, projected from saved attempts and artifact creation times. */
import { wallpaperVerdict, type WallpaperItem, type WallpaperReview, type WallpaperSettings } from '../shared/wallpaper.ts'
import { wallpaperProtectedBounds } from '../shared/wallpaper-geometry.ts'
import type { WorkbenchText } from './workbench-locale.ts'

/** Explain failed checks using model-estimated rectangles, without claiming pixel segmentation.
 * @param review Saved independent review. @param settings Frozen safety limits. @param t Current UI locale.
 * @returns Distinct blocking or unresolved reasons, including failed checks without issue rows.
 */
export function wallpaperReviewReasons(review: WallpaperReview, settings: WallpaperSettings, t: WorkbenchText): string[] {
  const bounds = wallpaperProtectedBounds(settings)
  const explain = (reason: string) => reason.split('；').map(part => {
    const [code, ...names] = part.trim().split(':')
    const name = names.join(':').replace(' · complete-object core protection', '')
    const region = 'actualLayout' in review ? review.actualLayout.regions.find(region => region.name === name) : undefined
    if (region && (code === 'critical-outside' || code === 'subject-overflow' || code === 'safe-top-overlap' || code === 'clock-overlap' || code === 'top-buffer-overlap' || code === 'clipped')) {
      const limits = code === 'clipped' ? { left: 0, top: 0, right: settings.width, bottom: settings.height } : { ...(code === 'subject-overflow' ? bounds.subject : bounds.critical), top: bounds.top }
      const edges = [
        ['wallpaperBoundaryLeft', limits.left - region.rect.x * settings.width],
        ['wallpaperBoundaryRight', (region.rect.x + region.rect.width) * settings.width - limits.right],
        ['wallpaperBoundaryTop', limits.top - region.rect.y * settings.height],
        ['wallpaperBoundaryBottom', (region.rect.y + region.rect.height) * settings.height - limits.bottom],
      ] as const
      const overflow = edges.filter(([, pixels]) => pixels > 0).map(([side, pixels]) => `${t(side)} ${Math.ceil(pixels)} px`).join(' · ')
      return t(code === 'clipped' ? 'wallpaperFrameEstimate' : 'wallpaperBoundaryEstimate').replace('{name}', name).replace('{edges}', overflow)
    }
    if (code === 'critical-outside' || code === 'subject-overflow') return t('wallpaperBoundaryOutside').replace('{name}', name)
    return part
  }).join('；')
  return [...new Set([
    ...review.issues.map(issue => issue.reason),
    ...Object.values(review.checks).filter(check => check.result !== 'satisfied').map(check => check.reason),
    ...('sourceRepair' in review && review.sourceRepair.result !== 'satisfied' ? [review.sourceRepair.reason] : []),
    ...('sourceCorrespondence' in review && review.sourceCorrespondence.result !== 'satisfied' ? [review.sourceCorrespondence.reason] : []),
  ].filter(Boolean).map(explain))]
}

export type WallpaperHistoryEntry = {
  id: string
  revision?: number
  kind: 'original' | 'plan' | 'image' | 'review' | 'resolution' | 'final'
  time?: string | undefined
  imageId?: string | undefined
  verdict?: ReturnType<typeof wallpaperVerdict>
  reason?: string | undefined
  model?: string | undefined
  promptSaved?: boolean
  reused?: boolean
}

/** Preserve each revision's actual review and resolution order; missing old timestamps remain absent.
 * @param item Saved state of the selected image.
 * @param artifactTimes Verified creation times of its saved image versions.
 * @returns Chronological milestones without starting work or inventing times.
 */
export function wallpaperImageHistory(item: WallpaperItem, artifactTimes: Readonly<Record<string, string>> = {}): WallpaperHistoryEntry[] {
  const entries: WallpaperHistoryEntry[] = []
  if (item.originalId) entries.push({ id: 'original', kind: 'original', imageId: item.originalId, time: item.download?.savedAt ?? artifactTimes[item.originalId] })
  for (const attempt of item.attempts) {
    const revision = attempt.revision
    entries.push({ id: `${revision}:plan`, revision, kind: 'plan', time: attempt.createdAt, reason: attempt.plan.subject, promptSaved: attempt.generationBrief?.status === 'saved' })
    const reviewedImageId = attempt.preResolutionReview?.nativeId ?? attempt.clarity?.originalOutputId ?? attempt.generatedImageId ?? attempt.outputId
    if (attempt.generation || reviewedImageId) entries.push({ id: `${revision}:image`, revision, kind: 'image', imageId: reviewedImageId, time: reviewedImageId ? artifactTimes[reviewedImageId] : undefined, model: attempt.generation?.model, reused: attempt.retryTarget === 'reviewing' })
    const resolutionId = attempt.clarity?.enhancedOutputId ?? attempt.backgroundResolution?.enhancedId
    const resolution = resolutionId ? { id: `${revision}:resolution`, revision, kind: 'resolution' as const, imageId: resolutionId, time: artifactTimes[resolutionId] } : undefined
    const review = attempt.review ? { id: `${revision}:review`, revision, kind: 'review' as const, imageId: attempt.preResolutionReview?.nativeId ?? attempt.outputId, time: attempt.reviewedAt, verdict: wallpaperVerdict(attempt.review), reason: attempt.review.issues.map(issue => issue.reason).join('；') || undefined } : undefined
    if (attempt.preResolutionReview) {
      if (review) entries.push(review)
      if (resolution) entries.push(resolution)
    } else {
      if (resolution) entries.push(resolution)
      if (review) entries.push(review)
    }
  }
  const latest = item.attempts.at(-1)
  if (item.status === 'passed' && latest?.outputId) entries.push({ id: `${latest.revision}:final`, revision: latest.revision, kind: 'final', imageId: latest.outputId, time: artifactTimes[latest.outputId] })
  return entries
}
