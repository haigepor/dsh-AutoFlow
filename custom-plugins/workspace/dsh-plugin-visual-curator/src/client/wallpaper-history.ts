/** Read-only milestones for one image, projected from saved attempts and artifact creation times. */
import { wallpaperVerdict, type WallpaperItem, type WallpaperReview, type WallpaperSettings } from '../shared/wallpaper.ts'
import { wallpaperPracticalRegionBoundary, wallpaperProtectedBounds } from '../shared/wallpaper-geometry.ts'
import { wallpaperPracticalAcceptance } from '../shared/wallpaper-policy.ts'
import type { WorkbenchText } from './workbench-locale.ts'

/** @param review Saved independent review. @param settings Frozen safety limits. @param issue Stored geometry reason. @returns The model-estimated rectangle and failed edges, if this issue has geometry. */
export function wallpaperReviewBoundaryEstimate(review: WallpaperReview, settings: WallpaperSettings, issue: string) {
  const [code, ...names] = issue.trim().split(':')
  if (!('actualLayout' in review) || !['critical-outside', 'subject-overflow', 'automobile-outside', 'safe-top-overlap', 'clock-overlap', 'top-buffer-overlap', 'clipped'].includes(code ?? '')) return undefined
  const name = names.join(':').replace(' · complete-object core protection', '')
  const current = review.reviewVersion === 'wallpaper-review-source-v4'
  const currentRegion = current ? review.actualLayout.regions.find(region => region.name === name && region.scope === 'core') : undefined
  const region = current ? currentRegion : review.actualLayout.regions.find(region => region.name === name)
  if (!region) return undefined
  const bounds = wallpaperProtectedBounds(settings), practical = wallpaperPracticalAcceptance(settings)
  const tolerance = practical?.version === 'practical-v1' ? practical.coordinateTolerancePixels : 0
  const frame = code === 'clipped'
  const whole = 'layoutChecks' in review && review.layoutChecks.includes(`critical-outside:${name}`)
  const wholeSubject = settings.sourceIntentPolicy?.alignment === 'subject-fill-v1' && settings.sourceIntentPolicy.wholeSubjectSafety === 'extrema-v1'
  const focus = code === 'subject-overflow' && !whole && !wholeSubject && settings.sourceIntentPolicy ? currentRegion?.layoutFocus : undefined
  const rect = focus && wallpaperPracticalRegionBoundary({ ...region, left: focus.x * settings.width, top: focus.y * settings.height, width: focus.width * settings.width, height: focus.height * settings.height }, settings)?.hard.includes(issue.trim()) ? focus : region.rect
  const protectedBounds = code === 'subject-overflow' && !practical ? bounds.subject : bounds.critical
  const top = code === 'clock-overlap' || code === 'safe-top-overlap' ? bounds.clockBottom : bounds.top
  const limits = frame ? { left: 0, top: 0, right: settings.width, bottom: settings.height } : { ...protectedBounds, top }
  const edges = [
    ['wallpaperBoundaryLeft', limits.left - rect.x * settings.width - tolerance],
    ['wallpaperBoundaryRight', (rect.x + rect.width) * settings.width - limits.right - tolerance],
    ['wallpaperBoundaryTop', limits.top - rect.y * settings.height - tolerance],
    ['wallpaperBoundaryBottom', (rect.y + rect.height) * settings.height - limits.bottom - tolerance],
  ] as const
  return { entityId: region.entityId, name, rect, frame, edges: edges.filter(([, pixels]) => pixels > 0) }
}

/** Explain failed checks using model-estimated rectangles, without claiming pixel segmentation.
 * @param review Saved independent review. @param settings Frozen safety limits. @param t Current UI locale.
 * @returns Distinct blocking or unresolved reasons, including failed checks without issue rows.
 */
export function wallpaperReviewReasons(review: WallpaperReview, settings: WallpaperSettings, t: WorkbenchText): string[] {
  const explain = (reason: string) => reason.split('；').map(part => {
    const [code, ...names] = part.trim().split(':')
    const name = names.join(':').replace(' · complete-object core protection', '')
    if (code === 'subject-center-drift' && /^-?\d+,-?\d+$/.test(name)) {
      const [x = '0', y = '0'] = name.split(',')
      return t('wallpaperReviewCenterDrift').replace('{x}', x).replace('{y}', y)
    }
    if (code === 'subject-too-small' && name && 'actualLayout' in review && wallpaperPracticalAcceptance(settings)?.version === 'practical-v2') {
      const subject = review.actualLayout.regions.find(region => region.role === 'subject' && region.name === name)
      if (subject) {
        const span = Math.round(Math.max(subject.rect.width * settings.width, subject.rect.height * settings.height))
        return t('wallpaperReviewPlannedSize').replace('{name}', name).replace('{span}', String(span))
      }
    }
    if (code === 'subject-aspect-changed') return t('wallpaperReviewSubjectAspect').replace('{name}', name)
    if (code === 'subject-relative-scale') return t('wallpaperReviewRelativeScale').replace('{name}', name)
    if (code === 'subject-relative-position') return t('wallpaperReviewRelativePosition').replace('{name}', name)
    if (code === 'source-frame-lost') {
      const [edge, ...parts] = names
      const edgeKey = edge === 'left' ? 'wallpaperBoundaryLeft' : edge === 'right' ? 'wallpaperBoundaryRight' : edge === 'top' ? 'wallpaperBoundaryTop' : edge === 'bottom' ? 'wallpaperBoundaryBottom' : undefined
      if (edgeKey && parts.length) return t('wallpaperFrameContactLost').replace('{name}', parts.join(':')).replace('{edge}', t(edgeKey))
    }
    if (code === 'missing-action-part') return t('wallpaperReviewMissingActionPart').replace('{name}', name)
    if (code === 'action-part-too-small') return t('wallpaperReviewActionPartSpan').replace('{name}', name)
    const estimate = wallpaperReviewBoundaryEstimate(review, settings, part)
    if (estimate?.edges.length) {
      const overflow = estimate.edges.map(([side, pixels]) => `${t(side)} ${Math.ceil(pixels)} px`).join(' · ')
      return t(estimate.frame ? 'wallpaperFrameEstimate' : 'wallpaperBoundaryEstimate').replace('{name}', name).replace('{edges}', overflow)
    }
    if (code === 'critical-outside' || code === 'subject-overflow' || code === 'automobile-outside') return t('wallpaperBoundaryOutside').replace('{name}', name)
    return part
  })
  return [...new Set([
    ...review.issues.map(issue => issue.reason),
    ...Object.values(review.checks).filter(check => check.result !== 'satisfied').map(check => check.reason),
    ...('sourceRepair' in review && review.sourceRepair.result !== 'satisfied' ? [review.sourceRepair.reason] : []),
    ...('sourceCorrespondence' in review && review.sourceCorrespondence.result !== 'satisfied' ? [review.sourceCorrespondence.reason] : []),
  ].filter(Boolean).flatMap(explain))]
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
    const reviewedImageId = attempt.preResolutionReview?.nativeId ?? attempt.nativeReviewCandidate?.nativeId ?? attempt.clarity?.originalOutputId ?? attempt.generatedImageId ?? attempt.outputId
    if (attempt.generation || reviewedImageId) entries.push({ id: `${revision}:image`, revision, kind: 'image', imageId: reviewedImageId, time: reviewedImageId ? artifactTimes[reviewedImageId] : undefined, model: attempt.generation?.model, reused: attempt.retryTarget === 'reviewing' })
    const resolutionId = attempt.clarity?.enhancedOutputId ?? attempt.backgroundResolution?.enhancedId
    const resolution = resolutionId ? { id: `${revision}:resolution`, revision, kind: 'resolution' as const, imageId: resolutionId, time: artifactTimes[resolutionId] } : undefined
    const review = attempt.review ? { id: `${revision}:review`, revision, kind: 'review' as const, imageId: attempt.preResolutionReview?.nativeId ?? attempt.nativeReviewCandidate?.nativeId ?? attempt.outputId, time: attempt.reviewedAt, verdict: wallpaperVerdict(attempt.review), reason: attempt.review.issues.map(issue => issue.reason).join('；') || undefined } : undefined
    if (attempt.preResolutionReview) {
      if (review) entries.push(review)
      if (resolution) entries.push(resolution)
    } else {
      if (resolution) entries.push(resolution)
      if (review) entries.push(review)
    }
    const final = attempt.postResolutionReview
    if (final?.review) entries.push({ id: `${revision}:final-review`, revision, kind: 'review', imageId: final.imageVersionId, time: final.reviewedAt, verdict: wallpaperVerdict(final.review), reason: final.review.issues.map(issue => issue.reason).join('；') || undefined })
  }
  const latest = item.attempts.at(-1)
  if (item.status === 'passed' && latest?.outputId) entries.push({ id: `${latest.revision}:final`, revision: latest.revision, kind: 'final', imageId: latest.outputId, time: artifactTimes[latest.outputId] })
  return entries
}
