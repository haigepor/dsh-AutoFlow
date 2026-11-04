/** Bulk archive confirmations shared by Workspace menus and the ungrouped bucket. */
import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceActionRequest, WorkspaceBrowserProps } from '../contract/slots.ts'
import { deriveFlat } from '../tree.ts'
import css from './WorkspaceBrowser.module.css'

/** Captured archive selection; skipped active work remains visible in the confirmation. */
export interface BulkArchiveTarget {
  sessionIds: readonly SessionId[]
  skipped: number
  workspaceName?: string
}

type ArchiveProps = Pick<WorkspaceBrowserProps, 'archiveSessions' | 't'> & {
  target: BulkArchiveTarget
  onClose: () => void
}

/**
 * Confirm archive of the supplied Session selection without stopping active work.
 * @param props - eligible ids, skipped count, archive operation and close action.
 * @returns the confirmation with pending and recoverable failure feedback.
 */
export function ArchiveSessionsDialog({ target, archiveSessions, onClose, t }: ArchiveProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = () => { if (!busy) onClose() }
  const confirm = () => {
    if (busy || target.sessionIds.length === 0) return
    setBusy(true)
    setError(null)
    archiveSessions(target.sessionIds).then(({ failed }) => {
      setBusy(false)
      if (failed === 0) onClose()
      else setError(t('archive.ungrouped.failed', { count: failed }))
    }).catch((reason: unknown) => {
      setBusy(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  const workspace = target.workspaceName
  return <Modal open onClose={close} closeLabel={t('close')}
    title={t(workspace === undefined ? 'archive.ungrouped.title' : 'archive.workspace.title')}
    description={workspace === undefined
      ? t('archive.ungrouped.desc', { count: target.sessionIds.length })
      : t('archive.workspace.desc', { name: workspace, count: target.sessionIds.length })}
    footer={<>
      <Button variant="outline" disabled={busy} onClick={close}>{t('cancel')}</Button>
      <Button variant="primary" disabled={busy || target.sessionIds.length === 0} onClick={confirm}>{t('archive.ungrouped.action')}</Button>
    </>}>
    {target.skipped > 0 && <div className={css.archiveNotice}>{t('archive.ungrouped.skip', { count: target.skipped })}</div>}
    {target.sessionIds.length === 0 && <div className={css.archiveNotice}>{t(workspace === undefined ? 'archive.ungrouped.empty' : 'archive.workspace.empty')}</div>}
    {busy && <div className={css.deleteStatus} role="status">{t(workspace === undefined ? 'archive.ungrouped.pending' : 'archive.workspace.pending')}</div>}
    {error !== null && <div className={css.renameError} role="alert">{error}</div>}
  </Modal>
}

type WorkspaceArchiveProps = Pick<WorkspaceBrowserProps, 'useSessions' | 'useSessionStatus' | 'archiveSessions' | 't'> & {
  request: WorkspaceActionRequest
  workspaces: readonly WorkspaceView[]
  archivedSessionIds: readonly SessionId[]
  onClose: () => void
}

/**
 * Resolve a captured Workspace's complete membership independently of the visible list mode.
 * @param props - menu request, live membership and status hooks, archive operation and close action.
 * @returns the confirmation including folded, filtered and locally dismissed members.
 */
export function WorkspaceArchiveDialog({ request, workspaces, archivedSessionIds, useSessions, useSessionStatus,
  archiveSessions, onClose, t }: WorkspaceArchiveProps) {
  const list = useSessions(state => state)
  const statuses = useSessionStatus(state => state)
  const workspace = workspaces.find(candidate => candidate.workspaceId === request.workspaceId)
  const candidates = deriveFlat(list, workspace?.sessionIds ?? [], {
    pinnedSessionIds: [], archivedSessionIds, archivedFilter: 'show',
  }, statuses).filter(session => !session.blank && !session.archived)
  const eligible = candidates.filter(session => !session.running && session.runningSubagentCount === 0)
  return <ArchiveSessionsDialog target={{ sessionIds: eligible.map(session => session.id),
    skipped: candidates.length - eligible.length, workspaceName: workspace?.title ?? request.displayTitle }}
  archiveSessions={archiveSessions} onClose={onClose} t={t} />
}
