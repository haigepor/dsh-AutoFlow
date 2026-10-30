/** @jsxRuntime classic */
/** @jsx React.createElement */
/** Shared native artwork, progress and action layout for background operations. */
import type { ReactNode } from 'react'
import loadingArtwork from '../../assets/gallery-import-loading-v1.webp'

/** Presentation only; adapters own task semantics, localized copy and commands. */
export interface BackgroundTaskCardProps {
  id: string; kind: 'gallery' | 'dataset' | 'search'; status: string; active: boolean; success: boolean
  label: ReactNode; progressLabel: string; hint?: ReactNode; actions?: ReactNode
  progress?: { completed: number; total: number; color?: string } | undefined
}

/** @param React Shell runtime. @param ui Native status primitive. @returns Reusable background task presentation. */
export function createBackgroundTaskCard(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  return function BackgroundTaskCard({ id, kind, status, active, success, label, progressLabel, progress, hint, actions }: BackgroundTaskCardProps) {
    const determinate = !!progress && progress.total > 0, percent = determinate ? Math.min(100, progress.completed / progress.total * 100) : 0
    return <div className={`vc-gallery-task-status${kind === 'dataset' ? ' vc-dataset-task-status' : kind === 'search' ? ' vc-search-launch-status' : ''}`} data-gallery-task={kind === 'gallery' ? id : undefined} data-dataset-task={kind === 'dataset' ? id : undefined} data-task-status={status} data-active={active} role="status" aria-live="polite">
      {active ? <span className="vc-gallery-import-art" aria-hidden="true"><img src={loadingArtwork} alt="" width={72} height={54} /></span> : <ui.StateDot state={success ? 'done' : 'warning'} />}
      <div className="vc-gallery-import-copy"><span>{label}</span>
        {active && <div className="vc-gallery-import-track" data-empty={!determinate || progress.completed === 0} data-indeterminate={!determinate} role="progressbar" aria-label={progressLabel} aria-valuemin={determinate ? 0 : undefined} aria-valuemax={determinate ? progress.total : undefined} aria-valuenow={determinate ? progress.completed : undefined}><span style={{ width: `${percent}%`, ...(progress?.color ? { backgroundColor: progress.color } : {}) }} /></div>}
        {hint && <small>{hint}</small>}
      </div>
      {actions}
    </div>
  }
}
