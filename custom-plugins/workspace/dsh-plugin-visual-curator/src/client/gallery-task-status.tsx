/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** One persisted task drives both the collection page and its dialog status. */
import { galleryTaskActive, galleryTaskRecoverable, galleryTaskProgress, type GalleryTaskView } from '../shared/gallery-task.ts'
import type { WorkbenchText } from './workbench-locale.ts'
import { createBackgroundTaskCard } from './background-task-card.tsx'
import recoveryArtwork from '../../assets/gallery-recovery-v2.webp'

function recoveryFailureMessage(code: string, stage: string, t: WorkbenchText, source?: GalleryTaskView['source']): string {
  switch (code) {
    case 'source-request-timeout': return t('galleryRequestTimeout')
    case 'source-network-failed': case 'source-response-incomplete': return t('galleryNetworkError')
    case 'source-dns-failed': return t('galleryDnsError')
    case 'source-tls-failed': return t('galleryTlsError')
    case 'owner-denied': return t(source === 'completed-search' ? 'taskReferenceSourceUnavailable' : stage === 'data-read' ? 'galleryRecoveryHostRestart' : 'gallerySessionError')
    case 'source-auth-required': return t('gallerySessionError')
    case 'constraint-conflict': case 'writer-occupied': return t('galleryRecoveryBusy')
    case 'reference-unavailable': case 'invalid-input': return t('galleryRecoveryUnavailable')
    case 'capability-unavailable': return t('galleryRecoveryServiceUnavailable')
    default: return t('galleryRecoveryError')
  }
}

/** @param React Host runtime. @param ui Existing status and button primitives. @returns Collection reference progress component. */
export function createGalleryTaskStatus(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const { Button } = ui
  const BackgroundTaskCard = createBackgroundTaskCard(React, ui)
  return function GalleryTaskStatus({ task, t, onStop }: { task: GalleryTaskView; t: WorkbenchText; onStop(): void }) {
    if (galleryTaskRecoverable(task.status)) return null
    const active = galleryTaskActive(task.status)
    const progress = galleryTaskProgress(task)
    const successPercent = task.total ? progress.referenced / task.total * 100 : 0
    const labels = { queued: 'galleryTaskQueued', running: 'galleryTaskRunning', cancelling: 'galleryStopping', completed: 'galleryTaskCompleted', partial: 'partialImport', failed: 'failed', cancelled: 'galleryReferenceCancelled', interrupted: 'galleryTaskInterrupted', 'needs-review': 'importUnknown' } as const
    return <BackgroundTaskCard id={task.id} kind="gallery" status={task.status} active={active} success={task.status === 'completed'}
      label={<>{t(labels[task.status])} <strong>{progress.referenced} / {task.total}</strong>{task.failed > 0 && ` · ${t('failed')} ${task.failed}`}</>}
      progressLabel={t('galleryImportProgress')} progress={{ completed: progress.processed, total: task.total, color: `color-mix(in srgb, var(--vc-accent), var(--dsw-alias-state-success-primary) ${successPercent}%)` }}
      hint={active && progress.referenced === 0 ? t(task.source === 'completed-search' ? 'taskReferenceBackgroundHint' : task.phase === 'verifying' ? 'galleryVerifyingReference' : 'galleryBackgroundHint') : undefined}
      actions={active && <Button size="sm" variant="ghost" disabled={task.status === 'cancelling'} onClick={onStop}>{t(task.status === 'cancelling' ? 'galleryStopping' : 'galleryStopImport')}</Button>} />
  }
}

/** @param React Host runtime. @param ui Existing modal and button primitives. @returns Owner controls for interrupted reference tasks, separate from sidebar progress. */
export function createGalleryTaskRecovery(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const { Modal, Button, StateDot } = ui
  return function GalleryTaskRecovery({ task, name, t, onClose, onResume, onCancel }: { task: GalleryTaskView; name: string; t: WorkbenchText; onClose(): void; onResume(): Promise<void>; onCancel(): Promise<void> }) {
    const [pending, setPending] = React.useState<'resume' | 'cancel' | null>(null)
    const [error, setError] = React.useState<{ command: 'resume' | 'cancel'; code: string; stage: string } | null>(null)
    const working = React.useRef(false), alive = React.useRef(true)
    React.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
    const control = async (command: 'resume' | 'cancel') => {
      if (working.current) return
      working.current = true; setPending(command); setError(null)
      try { await (command === 'resume' ? onResume() : onCancel()) }
      catch (failure) {
        const code = failure && typeof failure === 'object' && 'code' in failure && typeof failure.code === 'string' ? failure.code : ''
        const stage = failure && typeof failure === 'object' && 'stage' in failure && typeof failure.stage === 'string' ? failure.stage : ''
        if (alive.current) setError({ command, code, stage })
      }
      finally { working.current = false; if (alive.current) setPending(null) }
    }
    const progress = galleryTaskProgress(task)
    const savedPercent = task.total ? progress.referenced / task.total * 100 : 0
    return <Modal open={galleryTaskRecoverable(task.status)} onClose={onClose} closeOnBackdropClick={false}
      title={t(task.source === 'completed-search' ? 'taskReferenceRecoveryTitle' : 'galleryRecoveryTitle')} closeLabel={t('close')} className="vc-gallery-recovery-modal" contentClassName="vc-gallery-recovery-content"
      footer={<div className="vc-task-footer vc-gallery-recovery-actions"><Button variant="ghost" disabled={!!pending} onClick={() => { void control('cancel') }}>{pending === 'cancel' && <StateDot state="ongoing" />}{t('galleryRecoveryCancel')}</Button><Button variant="primary" disabled={!!pending} onClick={() => { void control('resume') }}>{pending === 'resume' ? <StateDot state="ongoing" /> : <ui.IconPlayOutlineMedium size={16} />}{t(pending === 'resume' ? 'galleryRecoveryResuming' : 'galleryRecoveryResume')}</Button></div>}>
      <div className="vc-gallery-recovery-body">
        <div className="vc-gallery-recovery-intro"><div className="vc-gallery-recovery-copy" role={error ? 'alert' : undefined}><span className="vc-gallery-recovery-badge">{error ? <ui.IconInfoOutlineRegular size={14} /> : <ui.IconArchiveCheckOutlineRegular size={14} />}{t(error ? error.command === 'resume' ? 'galleryRecoveryResumeFailed' : 'galleryRecoveryCancelFailed' : 'galleryRecoveryCheckpoint')}</span><p>{error ? recoveryFailureMessage(error.code, error.stage, t, task.source) : t('galleryRecoveryHint')}</p>{error?.code && <span className="vc-gallery-recovery-error-code">{t('analysisFailureCode')} <code>{error.code}</code></span>}</div><img className="vc-gallery-recovery-art" src={recoveryArtwork} alt="" width={480} height={328} aria-hidden="true" /></div>
        <section className="vc-gallery-recovery-summary" aria-label={t('galleryImportProgress')}>
          <p className="vc-gallery-recovery-name">{name}</p>
          <div className="vc-gallery-recovery-metrics"><div><span className="vc-gallery-recovery-label">{t('galleryRecoverySaved')}</span><div className="vc-gallery-recovery-count"><strong>{progress.referenced}</strong><span> / {task.total}</span></div></div><span className="vc-gallery-recovery-remaining">{t('galleryRecoveryRemaining')} <strong>{Math.max(0, task.total - progress.referenced)}</strong></span></div>
          <div className="vc-gallery-recovery-track" role="progressbar" aria-label={t('galleryImportProgress')} aria-valuemin={0} aria-valuemax={task.total} aria-valuenow={progress.referenced}><span style={{ width: `${savedPercent}%` }} /></div>
        </section>
      </div>
    </Modal>
  }
}
