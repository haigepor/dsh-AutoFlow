/** Business-owned mappings into the keyed Workspace Toast slot. */
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RowToastActions, WorkspaceViewStoreHandle } from '../contract/slots.ts'
import type { ArchiveToastInjected, ToastDisplayInjected } from '../contract/toast.ts'
import { ArchiveToastEntry, ToastEntry, WorkspaceToast } from './Toast.tsx'

/** Register notice presentations with their business-owned display fields and actions.
 * @param ctx - Workspace plugin context.
 * @param viewStore - Viewing store, read only by archive notices.
 * @param actions - Archive and source-opening callbacks.
 */
export function registerToasts(
  ctx: Context,
  viewStore: WorkspaceViewStoreHandle,
  actions: Pick<RowToastActions, 'undoArchive' | 'undoDismiss' | 'showArchived' | 'openForkSource'>,
): void {
  const archiveFilterAction: ArchiveToastInjected['filterAction'] = (t, dismiss) => ({
    prefix: t('toast.archivedOr'), label: t('toast.archivedFilter'),
    onClick: () => { dismiss(); actions.showArchived() },
  })
  ctx.slots.registerFactory({ name: 'workspace.toast.content', scope: 'root' }, WorkspaceToast)
  ctx.slots.inject('workspace.toast', function* () {
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'dismissed', locale: 'workspace',
      inject: (): ToastDisplayInjected<'dismissed'> => ({
        display: (notice, t, dismiss) => ({
          text: t('toast.dismissed'), tone: 'success', holdMs: 6000,
          actions: [{ label: t('toast.dismissUndo'), onClick: () => { dismiss(); actions.undoDismiss(notice.sessionId) } }],
        }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'dismissed'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'titleRegenerated', locale: 'workspace',
      inject: (): ToastDisplayInjected<'titleRegenerated'> => ({
        display: (_notice, t) => ({ text: t('toast.titleRegenerated'), tone: 'success' }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'titleRegenerated'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'titleGenerationFailed', locale: 'workspace',
      inject: (): ToastDisplayInjected<'titleGenerationFailed'> => ({
        display: (notice, t) => ({ text: t('toast.titleGenerationFailed', { reason: t(titleFailureKey(notice.message)) }), tone: 'warning' }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'titleGenerationFailed'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'sessionIdCopied', locale: 'workspace',
      inject: (): ToastDisplayInjected<'sessionIdCopied'> => ({
        display: (_notice, t) => ({ text: t('toast.sessionIdCopied'), tone: 'success' }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'sessionIdCopied'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'sessionIdCopyFailed', locale: 'workspace',
      inject: (): ToastDisplayInjected<'sessionIdCopyFailed'> => ({
        display: (_notice, t) => ({ text: t('toast.sessionIdCopyFailed'), tone: 'warning' }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'sessionIdCopyFailed'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'pinFailed', locale: 'workspace',
      inject: (): ToastDisplayInjected<'pinFailed'> => ({
        display: (_notice, t) => ({ text: t('toast.pinFailed'), tone: 'warning' }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'pinFailed'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'unpinFailed', locale: 'workspace',
      inject: (): ToastDisplayInjected<'unpinFailed'> => ({
        display: (_notice, t) => ({ text: t('toast.unpinFailed'), tone: 'warning' }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'unpinFailed'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'archivedNotOpenable', locale: 'workspace',
      inject: (): ToastDisplayInjected<'archivedNotOpenable'> => ({
        display: (_notice, t) => ({ text: t('toast.archivedNotOpenable'), tone: 'warning' }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'archivedNotOpenable'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'defaultWorkspaceFailed', locale: 'workspace',
      inject: (): ToastDisplayInjected<'defaultWorkspaceFailed'> => ({
        display: (_notice, t) => ({ text: t('defaultWorkspace.failed'), tone: 'warning' }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'defaultWorkspaceFailed'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'shortcutForkFailed', locale: 'workspace',
      inject: (): ToastDisplayInjected<'shortcutForkFailed'> => ({
        display: (notice, t) => ({
          text: t(notice.reason === 'unavailable' ? 'shortcut.noCompletedTurn' : 'shortcut.forkFailed'), tone: 'plain',
        }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'shortcutForkFailed'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'createFailed', locale: 'workspace',
      inject: (): ToastDisplayInjected<'createFailed'> => ({
        display: (notice, t) => ({ text: t('toast.createFailed', { message: notice.message }), tone: 'warning', holdMs: 6000 }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'createFailed'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'forkRequiresOpen', locale: 'workspace',
      inject: (): ToastDisplayInjected<'forkRequiresOpen'> => ({
        display: (notice, t, dismiss) => ({
          text: t('toast.forkRequiresOpen'), tone: 'warning', holdMs: 6000,
          actions: [{ label: t('toast.openForkSource'), onClick: () => { dismiss(); actions.openForkSource(notice.sessionId) } }],
        }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'forkRequiresOpen'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'archived', locale: 'workspace', store: viewStore,
      inject: (): ArchiveToastInjected => ({
        display: (notice, t, dismiss) => ({
          text: t('toast.archived'), tone: 'success', holdMs: 6000,
          actions: [{ label: t('toast.archivedUndo'), onClick: () => { dismiss(); actions.undoArchive(notice.sessionId) } }],
        }),
        filterAction: archiveFilterAction,
      }),
    }, ArchiveToastEntry)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'stoppedAndArchived', locale: 'workspace', store: viewStore,
      inject: (): ArchiveToastInjected => ({
        display: (notice, t, dismiss) => ({
          text: t('toast.stoppedAndArchived'), tone: 'success', holdMs: 6000,
          actions: [{ label: t('toast.archivedUndo'), onClick: () => { dismiss(); actions.undoArchive(notice.sessionId) } }],
        }),
        filterAction: archiveFilterAction,
      }),
    }, ArchiveToastEntry)
  })
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
