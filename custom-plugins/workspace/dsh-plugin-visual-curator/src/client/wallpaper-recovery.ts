/** The task bar and step dialog use the same current-image recovery decision. */
import { wallpaperHasRendered, wallpaperImageWorkStatus, wallpaperPendingDecision, wallpaperFailedStep, wallpaperReviewReworkAvailable, wallpaperCompositionEligible, wallpaperReworkCount, applyWallpaperRecoveryLimits, type WallpaperItem, type WallpaperView } from '../shared/wallpaper.ts'
import { wallpaperCanReinspectPlan } from '../shared/wallpaper-detail.ts'

/** Recovery never targets an older selected revision. */
export type WallpaperRecovery = { kind: 'none' | 'history' | 'download' | 'receipt' | 'reinspect' | 'edit' | 'review' | 'rework' } | { kind: 'retry'; step: 'planning' | 'rendering' | 'reviewing' }

/** @param recovery Selected image action. @param item Current image. @param value Owning task and active image scope. @returns Whether retry may be recorded while other images continue. */
export function wallpaperCanQueueRetry(recovery: WallpaperRecovery, item: WallpaperItem | undefined, value: WallpaperView): boolean {
  if (!item || value.status !== 'running' && value.status !== 'created' || !['download', 'retry', 'receipt'].includes(recovery.kind)) return false
  return item.status === 'technical-failed' || item.status === 'needs-review' && recovery.kind === 'receipt' ||
    wallpaperImageWorkStatus(value, item.imageVersionId) === 'paused' && ['queued', 'downloading', 'planning', 'rendering', 'reviewing'].includes(item.status)
}

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
  if (item.framingConflict && item.framingConflict.resolution !== 'cleared') return item.framingConflict.inspection?.status === 'resolved' || item.framingConflict.inspection?.status === 'uncertain' || !value.settings.decision?.maxDetailRequests ? { kind: 'none' } : { kind: 'reinspect' }
  if (!attempt && item.originalId && item.status === 'technical-failed' && item.failedStep === 'planning' && item.errorCode === 'constraint-conflict' && value.settings.sourceIntentPolicy?.version === 'source-intent-v2') return { kind: 'reinspect' }
  if (wallpaperCanReinspectPlan(item, attempt)) return { kind: 'reinspect' }
  if (attempt && !wallpaperCompositionEligible(attempt) && (attempt.outputId || attempt.generation || attempt.generationOperation || attempt.generatedImageId)) return { kind: 'none' }
  const recoverySettings = { ...value.settings }
  applyWallpaperRecoveryLimits(recoverySettings)
  if (wallpaperReviewReworkAvailable(item, recoverySettings)) return { kind: 'rework' }
  if (item.status === 'cancelled' && !item.originalId) return { kind: 'download' }
  if (wallpaperPendingDecision(item, attempt)) return { kind: 'none' }
  const failed = wallpaperFailedStep(item)
  if ((failed === 'reviewing' || attempt?.postResolutionReview) && wallpaperHasRendered(attempt)) return { kind: 'retry', step: 'reviewing' }
  const workStatus = wallpaperImageWorkStatus(value, item.imageVersionId)
  if (!item.originalId) return failed === 'downloading' || item.status === 'queued' || workStatus === 'paused' && item.status === 'downloading' ? { kind: 'download' } : { kind: 'none' }
  if (item.status === 'rejected') return { kind: attempt?.outputId ? 'edit' : 'none' }
  if (attempt?.generation && !attempt.outputId && ['needs-review', 'technical-failed', 'cancelled', 'rendering'].includes(item.status)) {
    const receipt = value.generationReceipts?.[attempt.generation.id]
    if (receipt === 'failed' || receipt === 'cancelled') {
      return item.edits < value.settings.maxEditsPerImage && wallpaperReworkCount(item) < value.settings.maxReworks ? { kind: 'retry', step: 'rendering' } : { kind: 'none' }
    }
    return { kind: 'receipt' }
  }
  if (item.status === 'cancelled') return attempt?.outputId ? { kind: 'review' } : { kind: 'retry', step: attempt ? 'rendering' : 'planning' }
  if (attempt?.generationOperation && !attempt.outputId && item.status === 'needs-review') return { kind: 'none' }
  if (item.status === 'technical-failed' && failed === 'reviewing' && attempt?.outputId && ['vision-invalid-output', 'vision-output-truncated'].includes(item.errorCode ?? '')) return { kind: 'review' }
  if (item.status === 'technical-failed') return { kind: 'retry', step: failed && failed !== 'downloading' ? failed : (!attempt ? 'planning' : !attempt.outputId ? 'rendering' : 'reviewing') }
  if (item.status === 'needs-review' && attempt?.outputId) return { kind: 'review' }
  if (item.status === 'needs-review' && attempt) return { kind: 'edit' }
  if (!['created', 'running', 'pausing', 'cancelling'].includes(workStatus) && ['queued', 'planning', 'rendering', 'reviewing'].includes(item.status)) return { kind: 'retry', step: !attempt ? 'planning' : !attempt.outputId ? 'rendering' : 'reviewing' }
  return { kind: 'none' }
}
