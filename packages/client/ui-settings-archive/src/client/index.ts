/** Native archive settings registers beside the Workspace browser without changing it. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { ArchiveDeleteError, ArchiveOperations } from './operations.ts'
import { ArchivePage } from './ArchivePage.tsx'
import { ArchiveFeedback } from './ArchiveFeedback.tsx'
import type { ArchiveInjected } from './contract.ts'
import { en, zh, ja, es, fr, de, ru, pt } from './locales.ts'
import type { ArchivePreferences } from '../types.ts'

/** Existing data owners and navigation provide all archive behavior. */
export const inject = ['slots', 'locale', 'sessions', 'workspaces', 'uiWorkspace', 'remoteAccess', 'layout', 'configForms', 'remote', 'remote.sessionDeletion']

/** @param ctx - browser plugin context. @returns after lifetime-owned registrations are installed. */
export function apply(ctx: Context): void {
  const namespace = 'settings.archive'
  const t = ctx.locale.bind(namespace)
  const favorites = ctx.configForms.get<ArchivePreferences>('ui-settings-archive')
  const operations = new ArchiveOperations({
    change: async (operation, id) => {
      if (operation === 'archive') await ctx.uiWorkspace.archiveSession(id)
      else if (operation === 'restore') await ctx.uiWorkspace.unarchiveSession(id)
      else {
        const result = await ctx.remote.sessionDeletion.deleteSession({ sessionId: id })
        if (!result.ok) throw new ArchiveDeleteError(result.error.code === 'sessionDeletion/cleanup-failed' ? 'cleanupFailure'
          : result.error.code === 'sessionDeletion/active' ? 'activeFailure' : 'deleteFailure')
        const snapshot = favorites.getSnapshot()
        if (snapshot.value?.favoriteSessionIds.includes(id)) {
          const accepted = await favorites.mutate([{ path: ['favoriteSessionIds'], op: 'set', value: snapshot.value.favoriteSessionIds.filter(value => value !== id) }], snapshot.revision)
          if (!accepted) throw new ArchiveDeleteError('cleanupFailure')
        }
      }
    },
    favorite: async (id, favorited) => {
      const snapshot = favorites.getSnapshot()
      if (snapshot.value === undefined || snapshot.revision === undefined) throw new Error('Archive preferences are unavailable')
      const ids = snapshot.value.favoriteSessionIds.filter(value => value !== id)
      if (favorited) ids.push(id)
      const accepted = await favorites.mutate([{ path: ['favoriteSessionIds'], op: 'set', value: ids }], snapshot.revision)
      if (!accepted) throw new Error('Archive favorites were not saved')
    },
    prepareOpen: (id) => {
      const navigation = ctx.layout.beginNavigation()
      return () => { if (!navigation.aborted) ctx.uiWorkspace.openSession(id) }
    },
    archived: id => ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(id),
    title: id => ctx.sessions.list.getSnapshot().byId[id]?.title ?? t('untitled'),
  })
  ctx.effect(() => () => { operations.dispose() }, 'archive-settings: operation lifetime')
  ctx.effect(() => ctx.locale.register(namespace, { zh, en, ja, es, fr, de, ru, pt }), 'archive-settings: dictionaries')
  const injected = (): ArchiveInjected => ({
    hooks: { operation: operations.state, favorites },
    run: (operation, ids, openAfter) => operations.run(operation, ids, openAfter),
    favorite: (id, favorited) => operations.favorite(id, favorited),
    retry: () => operations.retry(),
    dismissResult: () => { operations.dismissResult() },
    dismissNotice: () => { operations.dismissNotice() },
    refresh: () => ctx.sessions.refresh(),
    open: (id) => { ctx.uiWorkspace.openSession(id) },
    canChange: (id, archived) => ctx.remoteAccess.source('session', id, archived ? 'workspace/unarchiveSession' : 'workspace/archiveSession').getSnapshot(),
    canDelete: id => ctx.remoteAccess.source('session', id, 'sessionDeletion/deleteSession').getSnapshot(),
  })
  ctx.remoteAccess.whenAccess('workspace/follow', () => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'archived-sessions', order: 50, locale: namespace, label: () => t('nav'), inject: injected,
  }, ArchivePage)))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'archive-settings.feedback', locale: namespace, inject: injected,
  }, ArchiveFeedback))
}
