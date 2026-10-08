/**
 * The `shell.overlay` entry for Workspace and Session notices.
 * One notice is visible at a time; a parent rerender does not extend its hold.
 */
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { RowToastProps, RowToastState } from '../contract/slots.ts'

/**
 * Hold for the notices that take longer to read than a one-line warning: the
 * actionable archive or sidebar-dismissal notices and a refused Session
 * creation, which quotes the Host's reason.
 */
const LONG_TOAST_HOLD_MS = 6000

/**
 * Render the current notice: the archive and sidebar-dismissal notices
 * with their undo action — plus the show-archived action while archived rows
 * are hidden — on a 6 s hold, a refused Session creation with the Host's
 * reason on the same hold, or a plain warning for a failed pin, an archived
 * row that was clicked, or default Workspace creation.
 * @param props - the notice hook, the shared viewing store, the notice dismissal, the two archived-notice actions, and the locale seat.
 * @returns the notice on display, or null.
 */
export function RowActionToast({ useToast, useStore, dismissToast, undoArchive, undoDismiss, showArchived, t }: RowToastProps) {
  const toast = useToast(current => current)
  const archivedRowsVisible = useStore(state => (state.archivedFilter ?? 'default') !== 'default')
  if (toast === null) return null
  if (toast.kind === 'archived' || toast.kind === 'stoppedAndArchived') {
    const { sessionId } = toast
    return (
      <Toast
        key={`toast-${String(toast.seq)}`}
        text={t(toast.kind === 'archived' ? 'toast.archived' : 'toast.stoppedAndArchived')}
        tone="success"
        holdMs={LONG_TOAST_HOLD_MS}
        actions={[
          { label: t('toast.archivedUndo'), onClick: () => { dismissToast(); undoArchive(sessionId) } },
          ...archivedRowsVisible ? [] : [
            { prefix: t('toast.archivedOr'), label: t('toast.archivedFilter'), onClick: () => { dismissToast(); showArchived() } },
          ],
        ]}
        onDone={dismissToast}
      />
    )
  }
  if (toast.kind === 'dismissed') {
    const { sessionId } = toast
    return (
      <Toast
        key={`toast-${String(toast.seq)}`}
        text={t('toast.dismissed')}
        tone="success"
        holdMs={LONG_TOAST_HOLD_MS}
        actions={[{ label: t('toast.dismissUndo'), onClick: () => { dismissToast(); undoDismiss(sessionId) } }]}
        onDone={dismissToast}
      />
    )
  }
  if (toast.kind === 'titleRegenerated') {
    return <Toast key={`toast-${String(toast.seq)}`} text={t('toast.titleRegenerated')} tone="success" onDone={dismissToast} />
  }
  if (toast.kind === 'createFailed') {
    return (
      <Toast
        key={`toast-${String(toast.seq)}`}
        text={t('toast.createFailed', { message: toast.message })}
        icon={<IconWarningOutlineRegular />}
        holdMs={LONG_TOAST_HOLD_MS}
        onDone={dismissToast}
      />
    )
  }
  return (
    <Toast
      key={`toast-${String(toast.seq)}`}
      text={plainNoticeText(toast, t)}
      icon={<IconWarningOutlineRegular />}
      onDone={dismissToast}
    />
  )
}

/** The copy of one plain warning, keyed by the notice kind the union closes over. */
function plainNoticeText(
  toast: Exclude<RowToastState, { kind: 'archived' | 'stoppedAndArchived' | 'dismissed' | 'createFailed' | 'titleRegenerated' }>,
  t: RowToastProps['t'],
): string {
  switch (toast.kind) {
    case 'titleGenerationFailed': return t('toast.titleGenerationFailed', { reason: t(titleFailureKey(toast.message)) })
    case 'pinFailed': return t('toast.pinFailed')
    case 'unpinFailed': return t('toast.unpinFailed')
    case 'defaultWorkspaceFailed': return t('defaultWorkspace.failed')
    case 'archivedNotOpenable': return t('toast.archivedNotOpenable')
    /* v8 ignore next 2 -- closed-union backstop; only reached if a notice kind is forged */
    default:
      return assertNever(toast)
  }
}

/** Map sanitized Host codes to locale-owned failure copy. */
function titleFailureKey(code: string): 'title.error.auth' | 'title.error.config' | 'title.error.timeout' | 'title.error.network' | 'title.error.rateLimit' | 'title.error.empty' | 'title.error.cancelled' | 'title.error.output' {
  switch (code) {
    case 'TITLE_AUTH': return 'title.error.auth'
    case 'TITLE_CONFIG': return 'title.error.config'
    case 'TITLE_TIMEOUT': return 'title.error.timeout'
    case 'TITLE_NETWORK': return 'title.error.network'
    case 'TITLE_RATE_LIMIT': return 'title.error.rateLimit'
    case 'TITLE_EMPTY': return 'title.error.empty'
    case 'TITLE_INVALID_OUTPUT': return 'title.error.output'
    default: return 'title.error.cancelled'
  }
}
