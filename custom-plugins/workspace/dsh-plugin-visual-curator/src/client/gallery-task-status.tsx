/** @jsxRuntime classic */
/** @jsx React.createElement */
/** One persisted task drives both the collection page and its dialog status. */
import { galleryTaskActive, type GalleryTaskView } from '../shared/gallery-task.ts'
import type { WorkbenchText } from './workbench-locale.ts'

/** @param React Host runtime. @param ui Existing status and button primitives. @returns Collection reference progress component. */
export function createGalleryTaskStatus(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const { StateDot, Button } = ui
  return function GalleryTaskStatus({ task, t, onStop }: { task: GalleryTaskView; t: WorkbenchText; onStop(): void }) {
    const active = galleryTaskActive(task.status)
    const labels = { queued: 'galleryTaskQueued', running: 'galleryTaskRunning', cancelling: 'galleryStopping', completed: 'galleryTaskCompleted', partial: 'partialImport', failed: 'failed', cancelled: 'galleryReferenceCancelled', interrupted: 'galleryTaskInterrupted', 'needs-review': 'importUnknown' } as const
    return <div className="vc-gallery-task-status" data-gallery-task={task.id} data-task-status={task.status} role="status" aria-live="polite">
      <StateDot state={active ? 'ongoing' : task.status === 'completed' ? 'done' : 'warning'} />
      <span>{t(labels[task.status])} <strong>{task.completed} / {task.total}</strong>{task.failed > 0 && ` · ${t('failed')} ${task.failed}`}{task.registered > 0 && ` · ${t('gallerySavingReference')} ${task.registered}`}</span>
      {active && <Button size="sm" variant="ghost" disabled={task.status === 'cancelling'} onClick={onStop}>{t(task.status === 'cancelling' ? 'galleryStopping' : 'galleryStopImport')}</Button>}
    </div>
  }
}
