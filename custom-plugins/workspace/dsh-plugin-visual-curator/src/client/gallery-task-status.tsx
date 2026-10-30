/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** One persisted task drives both the collection page and its dialog status. */
import { galleryTaskActive, galleryTaskProgress, type GalleryTaskView } from '../shared/gallery-task.ts'
import type { WorkbenchText } from './workbench-locale.ts'
import { createBackgroundTaskCard } from './background-task-card.tsx'

/** @param React Host runtime. @param ui Existing status and button primitives. @returns Collection reference progress component. */
export function createGalleryTaskStatus(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const { Button } = ui
  const BackgroundTaskCard = createBackgroundTaskCard(React, ui)
  return function GalleryTaskStatus({ task, t, onStop }: { task: GalleryTaskView; t: WorkbenchText; onStop(): void }) {
    const active = galleryTaskActive(task.status)
    const progress = galleryTaskProgress(task)
    const successPercent = task.total ? progress.referenced / task.total * 100 : 0
    const labels = { queued: 'galleryTaskQueued', running: 'galleryTaskRunning', cancelling: 'galleryStopping', completed: 'galleryTaskCompleted', partial: 'partialImport', failed: 'failed', cancelled: 'galleryReferenceCancelled', interrupted: 'galleryTaskInterrupted', 'needs-review': 'importUnknown' } as const
    return <BackgroundTaskCard id={task.id} kind="gallery" status={task.status} active={active} success={task.status === 'completed'}
      label={<>{t(labels[task.status])} <strong>{progress.referenced} / {task.total}</strong>{task.failed > 0 && ` · ${t('failed')} ${task.failed}`}</>}
      progressLabel={t('galleryImportProgress')} progress={{ completed: progress.processed, total: task.total, color: `color-mix(in srgb, var(--vc-accent), var(--dsw-alias-state-success-primary) ${successPercent}%)` }}
      hint={active && progress.referenced === 0 ? t(task.phase === 'verifying' ? 'galleryVerifyingReference' : 'galleryBackgroundHint') : undefined}
      actions={active && <Button size="sm" variant="ghost" disabled={task.status === 'cancelling'} onClick={onStop}>{t(task.status === 'cancelling' ? 'galleryStopping' : 'galleryStopImport')}</Button>} />
  }
}
