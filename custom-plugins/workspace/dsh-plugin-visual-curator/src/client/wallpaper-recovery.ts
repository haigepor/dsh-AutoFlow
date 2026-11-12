/** The task bar and step dialog use the same current-image recovery decision. */
import { wallpaperPendingDecision, wallpaperFailedStep, wallpaperReviewReworkAvailable, applyWallpaperRecoveryLimits, type WallpaperItem, type WallpaperView } from '../shared/wallpaper.ts'
import { wallpaperPlanConcerns } from '../shared/wallpaper-detail.ts'

/** Recovery never targets an older selected revision. */
export type WallpaperRecovery = { kind: 'none' | 'history' | 'download' | 'receipt' | 'canvas' | 'reinspect' | 'edit' | 'review' | 'rework' } | { kind: 'retry'; step: 'planning' | 'rendering' | 'reviewing' }

/** Manual decisions target one current blocked source and never replace receipt or saved-review recovery.
 * @param item Selected image. @param attempt Displayed saved plan. @param status Owning task lifecycle for an unfinished saved decision.
 * @returns Whether an explicit decision can be offered without dispatching any work.
 */
export function wallpaperCanDecide(item: WallpaperItem | undefined, attempt = item?.attempts.at(-1), status?: WallpaperView['status']): boolean {
  if (status === 'cancelled' || status === 'cancelling') return false
  if (wallpaperPendingDecision(item, attempt)) return status !== undefined && !['created', 'running', 'pausing', 'cancelling'].includes(status)
  return !!item?.originalId && !!attempt && attempt === item.attempts.at(-1) && ['needs-review', 'technical-failed'].includes(item.status)
    && !(attempt.generation && !attempt.outputId) && !(attempt.outputId && (item.status === 'needs-review' || wallpaperFailedStep(item) === 'reviewing'))
    && !item.decisions?.some(record => record.status === 'running')
}

/** Select the action for the displayed image and saved revision without dispatching work.
 * @param value The task currently displayed in this Tab.
 * @param item The selected source image.
 * @param attempt The displayed saved revision.
 * @returns An image-scoped action; batch pause and resume remain separate controls.
 */
export function wallpaperRecovery(value: WallpaperView, item: WallpaperItem | undefined, attempt: WallpaperItem['attempts'][number] | undefined): WallpaperRecovery {
  if (!item) return { kind: 'none' }
  const latest = item.attempts.at(-1)
  if (attempt?.revision !== latest?.revision) return { kind: 'history' }
  if (value.status === 'cancelled' || value.status === 'cancelling') return { kind: 'none' }
  if (item.status === 'passed') return { kind: 'none' }
  if (value.state.version === 2 && item.originalId && item.status === 'needs-review' && attempt?.generation && attempt.generationInput && !attempt.outputId && !['generated-canvas-v1', 'generated-canvas-protected-v2'].includes(attempt.compositionMode ?? '') && ['misaligned-source', 'reframed-source'].includes(attempt.generationAlignment?.result ?? '')) return { kind: 'canvas' }
  const recoverySettings = { ...value.settings }
  applyWallpaperRecoveryLimits(recoverySettings)
  if (wallpaperReviewReworkAvailable(item, recoverySettings)) return { kind: 'rework' }
  if (item.status === 'cancelled') return !item.originalId ? { kind: 'download' } : attempt?.generation && !attempt.outputId ? { kind: 'receipt' } : attempt?.outputId ? { kind: 'review' } : { kind: 'retry', step: attempt ? 'rendering' : 'planning' }
  if (wallpaperPendingDecision(item, attempt)) return { kind: 'none' }
  const failed = wallpaperFailedStep(item)
  if (!item.originalId) return failed === 'downloading' || item.status === 'queued' ? { kind: 'download' } : { kind: 'none' }
  if (item.status === 'rejected') return attempt?.outputId ? { kind: 'edit' } : attempt?.detailAnalysis?.protectedSubjectExtent === 'cut-off' ? { kind: 'reinspect' } : { kind: 'none' }
  if (attempt?.generation && !attempt.outputId && (item.status === 'needs-review' || item.status === 'technical-failed')) return { kind: 'receipt' }
  if (attempt?.generationOperation && !attempt.outputId && item.status === 'needs-review') return { kind: 'none' }
  if (item.status === 'technical-failed' && failed === 'reviewing' && attempt?.outputId && ['vision-invalid-output', 'vision-output-truncated'].includes(item.errorCode ?? '')) return { kind: 'review' }
  if (item.status === 'technical-failed') {
    if (failed === 'planning' && attempt && wallpaperPlanConcerns(attempt.plan).length) return { kind: 'reinspect' }
    return { kind: 'retry', step: failed && failed !== 'downloading' ? failed : (!attempt ? 'planning' : !attempt.outputId ? 'rendering' : 'reviewing') }
  }
  if (item.status === 'needs-review' && attempt?.outputId) return { kind: 'review' }
  if (item.status === 'needs-review' && attempt) return { kind: wallpaperPlanConcerns(attempt.plan).length && attempt.detailAnalysis?.outcome !== 'resolved' && attempt.detailAnalysis?.outcome !== 'ready-for-edit' ? 'reinspect' : 'edit' }
  if (!['created', 'running', 'pausing', 'cancelling'].includes(value.status) && ['queued', 'planning', 'rendering', 'reviewing'].includes(item.status)) return { kind: 'retry', step: !attempt ? 'planning' : !attempt.outputId ? 'rendering' : 'reviewing' }
  return { kind: 'none' }
}
