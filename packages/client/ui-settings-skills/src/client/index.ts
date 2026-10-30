/** Native settings registration, live resources and typed management operations. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SkillOperationResult } from '@deepseek-ai/dsh-skill-manager/types'
import { SkillFeedback } from './SkillFeedback.tsx'
import type { SkillSettingsInjected } from './contract.ts'
import { createSkillSettingsStore } from './store.ts'
import { SkillSettings } from './SkillSettings.tsx'
import { en, zh } from './locales.ts'
/** Services supplying settings, resources and generated management RPC. */
export const inject = [
  'slots',
  'locale',
  'resources',
  'remote',
  'remote.skillManagement',
  'remote.session',
  'sessions',
  'uiWorkspace',
  'conversation',
  'layout',
]
declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    skillCreation: unknown
  }
}
/** Mount the page and operation overlay; owned resources stop on disposal.
 *
 * @param ctx - browser plugin context.

 */
export function apply(ctx: Context): void {
  const store = createSkillSettingsStore()
  const refreshers = new Set<() => void>()
  let writing = false
  ctx.effect(() => ctx.locale.register('settings.skills', { zh, en }), 'skill-settings: locale')
  const refresh = (): void => {
    for (const changed of refreshers) changed()
  }
  ctx.effect(() => ctx.remote.$on('llm/models-updated', refresh), 'skill-settings: model catalog')
  ctx.effect(() => ctx.remote.$on('llm/adapters-updated', refresh), 'skill-settings: model providers')
  async function* frames<T>(
    read: () => Promise<RemoteResult<T>>,
    signal: AbortSignal,
  ): AsyncGenerator<RemoteResult<T>> {
    let revision = 0
    let wake: (() => void) | undefined
    const changed = (): void => {
      revision++
      wake?.()
    }
    const off = ctx.remote.$on('skills/change', changed)
    refreshers.add(changed)
    signal.addEventListener('abort', changed, { once: true })
    try {
      while (!signal.aborted) {
        const current = revision
        yield await read()
        if (revision === current)
          await new Promise<void>((resolve) => {
            wake = resolve
            if (signal.aborted || revision !== current) resolve()
          })
        wake = undefined
      }
    } finally {
      off()
      refreshers.delete(changed)
      signal.removeEventListener('abort', changed)
    }
  }
  ctx.effect(
    () =>
      ctx.resources.register<'skill-models'>({
        protocol: 'skill-models',
        open: (_address, { signal }) => frames(() => ctx.remote.session.modelCatalog(), signal),
      }),
    'skill-settings: creation models',
  )
  ctx.effect(
    () =>
      ctx.resources.register<'skill-inventory'>({
        protocol: 'skill-inventory',
        open: (address, { signal }) =>
          frames(() => ctx.remote.skillManagement.list(new URL(address).searchParams.get('workspace') ?? ''), signal),
      }),
    'skill-settings: inventory',
  )
  ctx.effect(
    () =>
      ctx.resources.register<'skill-detail'>({
        protocol: 'skill-detail',
        open: (address, { signal }) => {
          const url = new URL(address)
          return frames(
            () =>
              ctx.remote.skillManagement.detail(
                decodeURIComponent(url.pathname.slice(1)) as Parameters<typeof ctx.remote.skillManagement.detail>[0],
                url.searchParams.get('workspace') ?? '',
              ),
            signal,
          )
        },
      }),
    'skill-settings: detail',
  )
  ctx.effect(
    () =>
      ctx.resources.register<'skill-backups'>({
        protocol: 'skill-backups',
        open: (_address, { signal }) => frames(() => ctx.remote.skillManagement.backups(), signal),
      }),
    'skill-settings: backups',
  )
  ctx.effect(
    () =>
      ctx.resources.register<'skill-repositories'>({
        protocol: 'skill-repositories',
        open: (_address, { signal }) => frames(() => ctx.remote.skillManagement.repositories(), signal),
      }),
    'skill-settings: repositories',
  )
  function injected(actions: BoundActions<ReturnType<typeof createSkillSettingsStore>>): SkillSettingsInjected {
    async function run(task: () => Promise<RemoteResult<SkillOperationResult>>): Promise<boolean> {
      if (writing) return false
      writing = true
      actions.busy(true)
      try {
        const result = await task()
        const ok = result.ok && result.value.status === 'saved'
        actions.announce(
          !result.ok ? 'failed' : result.value.status === 'rejected' ? `error.${result.value.code}` : 'success',
          ok,
        )
        return ok
      } catch (_requestFailed) {
        actions.announce('failed', false)
        return false
      } finally {
        writing = false
        actions.busy(false)
        refresh()
      }
    }
    return {
      createConversation: async (workspaceId, model) => {
        const navigation = ctx.layout.beginNavigation()
        try {
          const sessionId = await ctx.sessions.create({ workspaceId })
          navigation.throwIfAborted()
          return await ctx.sessions.using(
            sessionId,
            { source: 'skillCreation', signal: navigation },
            async (reference) => {
              await reference.ready
              const selected = await ctx.remote.session.selectModel({ sessionId, ...model })
              if (!selected.ok) throw new Error('Model selection failed')
              navigation.throwIfAborted()
              const prepared = ctx.conversation.input.requestDraftInitialization(reference.binding, {
                prompt: ctx.locale.bind('settings.skills')('creationPrompt'),
                whenDraftExists: 'replace',
              })
              if (prepared === 'blocked') throw new Error('Draft preparation blocked')
              ctx.uiWorkspace.openSession(sessionId)
              return true
            },
          )
        } catch (_creationFailed) {
          if (!navigation.aborted) actions.announce('creationFailed', false)
          return false
        }
      },
      refresh,
      setEnabled: (id, enabled, workspace) => run(() => ctx.remote.skillManagement.setEnabled(id, enabled, workspace)),
      save: (id, document, revision, workspace) =>
        run(() => ctx.remote.skillManagement.save(id, document, revision, workspace)),
      importFiles: (directory, files, overwrite, workspace) =>
        run(() => ctx.remote.skillManagement.importFiles(directory, files, overwrite, workspace)),
      trash: (id, workspace) => run(() => ctx.remote.skillManagement.trash(id, workspace)),
      restore: (id, remove, workspace) => run(() => ctx.remote.skillManagement.restore(id, remove, workspace)),
      source: (path, remove) => run(() => ctx.remote.skillManagement.source(path, remove)),
      arrange: (id, category, order, workspace) =>
        run(() => ctx.remote.skillManagement.arrange(id, category, order, workspace)),
      discover: async (repository, ref) => {
        try {
          const result = await ctx.remote.skillManagement.discover(repository, ref)
          if (result.ok) return result.value
        } catch (_requestFailed) {
          /* The global notice owns the failure below. */
        }
        actions.announce('error.network', false)
        return undefined
      },
      install: (candidate, directory, overwrite, workspace) =>
        run(() => ctx.remote.skillManagement.installSkill(candidate, directory, overwrite, workspace)),
      preview: async (id, ref, workspace) => {
        try {
          const result = await ctx.remote.skillManagement.preview(id, ref, workspace)
          if (result.ok) return result.value
        } catch (_requestFailed) {
          /* The global notice owns the failure below. */
        }
        actions.announce('error.network', false)
        return undefined
      },
      update: (token, overwrite) => run(() => ctx.remote.skillManagement.update(token, overwrite)),
      subscribe: (repository, ref, remove) => run(() => ctx.remote.skillManagement.subscribe(repository, ref, remove)),
      marketplace: async (catalog, query) => {
        try {
          const result = await ctx.remote.skillManagement.marketplace(catalog, query)
          if (result.ok) return result.value
        } catch (_requestFailed) {
          /* The global notice owns the failure below. */
        }
        actions.announce('error.network', false)
        return undefined
      },
      installMarketplace: (skill, directory, overwrite, workspace) =>
        run(() => ctx.remote.skillManagement.installMarketplace(skill, directory, overwrite, workspace)),
      setCategoryEnabled: (category, enabled, workspace) =>
        run(() => ctx.remote.skillManagement.setCategoryEnabled(category, enabled, workspace)),
      copy: async (document) => {
        try {
          await navigator.clipboard.writeText(document)
          actions.announce('copied', true)
        } catch (_clipboardDenied) {
          actions.announce('failed', false)
        }
      },
    }
  }
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'skills',
        order: 35,
        locale: 'settings.skills',
        label: () => ctx.locale.bind('settings.skills')('nav'),
        store,
        inject: injected,
      },
      SkillSettings,
    ),
  )
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'skill-settings.feedback', store, locale: 'settings.skills' },
      SkillFeedback,
    ),
  )
  ctx.inject(['settingsSearch'], (scope) => {
    scope.effect(
      () =>
        scope.settingsSearch.register({
          id: 'skills.management',
          sectionId: 'skills',
          label: () => ctx.locale.bind('settings.skills')('nav'),
          target: '[data-skill-settings]',
        }),
      'skill-settings: search',
    )
  })
}
