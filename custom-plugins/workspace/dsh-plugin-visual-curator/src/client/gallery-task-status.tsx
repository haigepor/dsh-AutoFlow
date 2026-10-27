/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** One persisted task drives both the collection page and its dialog status. */
import { galleryTaskActive, galleryTaskProgress, type GalleryTaskView } from '../shared/gallery-task.ts'
import type { WorkbenchText } from './workbench-locale.ts'
import loadingArtwork from '../../assets/gallery-import-loading-v1.webp'

/** @param React Host runtime. @param ui Existing status and button primitives. @returns Collection reference progress component. */
export function createGalleryTaskStatus(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const { StateDot, Button } = ui
  return function GalleryTaskStatus({ task, t, onStop }: { task: GalleryTaskView; t: WorkbenchText; onStop(): void }) {
    const active = galleryTaskActive(task.status)
    const progress = galleryTaskProgress(task)
    const successPercent = task.total ? progress.referenced / task.total * 100 : 0
    const labels = { queued: 'galleryTaskQueued', running: 'galleryTaskRunning', cancelling: 'galleryStopping', completed: 'galleryTaskCompleted', partial: 'partialImport', failed: 'failed', cancelled: 'galleryReferenceCancelled', interrupted: 'galleryTaskInterrupted', 'needs-review': 'importUnknown' } as const
    return <div className="vc-gallery-task-status" data-gallery-task={task.id} data-task-status={task.status} data-active={active} role="status" aria-live="polite">
      {active ? <span className="vc-gallery-import-art" aria-hidden="true"><img src={loadingArtwork} alt="" width={72} height={54} /></span> : <StateDot state={task.status === 'completed' ? 'done' : 'warning'} />}
      <div className="vc-gallery-import-copy"><span>{t(labels[task.status])} <strong>{progress.referenced} / {task.total}</strong>{task.failed > 0 && ` · ${t('failed')} ${task.failed}`}</span>
        {active && <><div className="vc-gallery-import-track" data-empty={progress.processed === 0} role="progressbar" aria-label={t('galleryImportProgress')} aria-valuemin={0} aria-valuemax={task.total} aria-valuenow={progress.processed}><span style={{ width: `${progress.percent}%`, backgroundColor: `color-mix(in srgb, var(--vc-accent), var(--dsw-alias-state-success-primary) ${successPercent}%)` }} /></div>{progress.referenced === 0 && <small>{t(task.phase === 'verifying' ? 'galleryVerifyingReference' : 'galleryBackgroundHint')}</small>}</>}
      </div>
      {active && <Button size="sm" variant="ghost" disabled={task.status === 'cancelling'} onClick={onStop}>{t(task.status === 'cancelling' ? 'galleryStopping' : 'galleryStopImport')}</Button>}
    </div>
  }
}
