/** Optional native page entries; the plugin detail itself stays entirely owned by Plugin Manager. */
import type { ComponentType } from 'react'
import css from './entry.css'
import welcomeImage from '../../assets/welcome-photo-stack-v2.webp'
import logoImage from '../../assets/visual-curator-logo-v1.png'
import executionEmptyImage from '../../assets/execution-empty-v1.webp'
import { createTaskToolView } from './task-tool-view.tsx'
import { createCuratorStore } from './store.ts'
import { createCuratorTransport } from './transport.ts'
import { createGalleryCache } from './gallery-cache.ts'
import { resolveGalleryCachePolicy } from '../shared/gallery-cache.ts'
import { createWorkbench, type WorkbenchProps } from './workbench.tsx'
import { publishStyle } from './workbench-actions.ts'
import { en, zh } from './workbench-locale.ts'
import { analysisActive } from '../shared/analysis-process.ts'
import { galleryTaskActive } from '../shared/gallery-task.ts'
import { createSearchLaunchStore } from './search-launch-store.ts'

type Page = 'settings' | 'panel' | 'conversation'
type Result<T> = { ok: true; value: T } | { ok: false; error: object }
interface Bundle {
  name: string
  enabled: boolean
  rows: { rowId: string; entryId?: string }[]
  features?: { id: string; rowId: string; enabled: boolean }[]
}
interface Row { entryId: string; enabled: boolean; fiberPhase?: string }
interface SlotOptions { name: string; id?: string; key?: string; order?: number; label?: () => string; locale: string; inject?: ((sessionId: string) => object) | (() => object) }
interface EntryContext {
  get?(name: 'uiWorkspace'): { openSession(id: string): void } | undefined
  effect(callback: () => (() => void), label: string): void
  on(event: 'connection/reset', callback: () => void): () => void
  plugin(plugin: { name: string; apply(ctx: EntryContext): void }): { dispose(): Promise<void> }
  slots: {
    inject(name: string, register: () => (() => void)): void
    register<P extends object>(options: SlotOptions, component: ComponentType<P>): () => void
  }
  locale: {
    register(namespace: string, locales: { en: typeof en; zh: typeof en }): () => void
    bind(namespace: string): (key: keyof typeof en) => string
  }
  remote: {
    $on(event: 'plugin-manager/changed', callback: () => void): () => void
    pluginManager: { listBundles(): Promise<Result<Bundle[]>>; listPlugins(): Promise<Result<Row[]>>; invokeAction(name: string, action: string, input: Record<string, string>): Promise<Result<{ output: string }>> }
    credentials: { set(ref: string, value: string): Promise<Result<object>> }
  }
  layout: { panelInfo: { getSnapshot(): { activePanelId: string | null } }; selectPanel(id: string | null): void }
  uiConversation: { views: { register(view: { target: string; create(): { empty: null; replace(): null; apply(): null } }): () => void } }
}
interface ModuleLoader {
  load(module: { id: string; factory(require: <T>(name: string) => T): { inject: string[]; apply(ctx: EntryContext): void } }): void
}
declare global { interface Window { __ModuleLoader__: ModuleLoader } }

window.__ModuleLoader__.load({
  id: 'dsh-plugin-visual-curator',
  factory(require) {
    const React = require<typeof import('react')>('react')
    const ui = require<typeof import('@deepseek-ai/dsh-client-ui-primitives')>('@deepseek-ai/dsh-client-ui-primitives')
    const { IconPanelLeftOutlineRegular } = ui
    const PageEntry = createWorkbench(React, ui)
    const TaskToolView = createTaskToolView(React, ui)
    return {
      inject: ['slots', 'locale', 'remote', 'remote.pluginManager', 'remote.credentials', 'layout', 'uiConversation'],
      apply(ctx) {
        const namespace = 'visualCuratorEntry', panel = 'visual-curator-page'
        ctx.effect(() => ctx.locale.register(namespace, { en, zh }), 'Visual Curator entry locale')
        const t = ctx.locale.bind(namespace)
        const readLifetime = new AbortController()
        const transport = createCuratorTransport({ baseUrl: document.baseURI, signal: readLifetime.signal, fetch: (input, init) => fetch(input, init),
          async action(operation, args) {
            const response = await ctx.remote.pluginManager.invokeAction('dsh-plugin-visual-curator', 'workbench', { operation, args: JSON.stringify(args) })
            if (!response.ok) throw response.error
            return JSON.parse(response.value.output)
          },
        })
        const store = createCuratorStore(transport)
        const launches = createSearchLaunchStore({ invoke: store.invoke, context: () => ({ scope: store.getScopeId(), styleId: store.getSnapshot().snapshot ? store.getSnapshot().styleId : '', pollMs: store.getSnapshot().snapshot?.configuration.limits.pollIntervalMs ?? 2000 }), openSession(id) {
          const navigation = ctx.get?.('uiWorkspace')
          if (!navigation) throw new Error('native-navigation-unavailable')
          navigation.openSession(id)
        } })
        ctx.effect(() => {
          const follow = store.subscribe(() => launches.sync()); launches.sync()
          return () => { follow(); launches.dispose() }
        }, 'Visual Curator native search launches')
        for (const toolName of ['visual_search_start', 'visual_crop_start', 'visual_run_get']) ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: toolName, locale: namespace, inject: (sessionId: string) => ({ t, async openTask(runId: string) { if (!registrations.has('panel')) throw new Error('panel-disabled'); await store.openSession(sessionId); store.selectWorkspace('tasks'); store.selectRun(runId); ctx.layout.selectPanel(panel) } }) }, TaskToolView))
        let sessionCache: Storage | undefined
        try { sessionCache = window.sessionStorage } catch (error) { /* 浏览器禁用本地存储时，仅使用内存缓存。 */ }
        const gallery = createGalleryCache({ ...(sessionCache ? { storage: sessionCache } : {}), context: () => {
          const configuration = store.getSnapshot().snapshot?.configuration
          if (!configuration) throw new Error('gallery-configuration-unavailable')
          return { namespace: `${new URL(document.baseURI).origin}:${store.getSnapshot().scopeSessionId}`, revision: configuration.revision, accounts: configuration.source.unsplash.accounts.map(({ id, userId, credentialRef }) => ({ id, userId, credentialRef })), policy: resolveGalleryCachePolicy(configuration.source.unsplash.cache) }
        }, read: (operation, args, signal) => transport.invoke(operation, { ...args, ...(store.getSnapshot().sessionToken ? { sessionToken: store.getSnapshot().sessionToken } : {}) }, signal) })
        ctx.effect(() => () => gallery.dispose(), 'Visual Curator gallery cache')
        const actions: WorkbenchProps['actions'] = { selectWorkspace: store.selectWorkspace, openSession: store.openSession, closeSession: store.closeSession, prepareTask: store.prepareTask, startAnalysis: store.startAnalysis, stopAnalysis: store.stopAnalysis, openAnalysis: store.openAnalysis, closeAnalysis: store.closeAnalysis, refreshAnalysisDetail: store.refreshAnalysisDetail, loadAnalysisInput: store.loadAnalysisInput, saveConfiguration: store.saveConfiguration, execute: store.execute, reload: store.reload, getSnapshot: store.getSnapshot,
          selectStyle: store.selectStyle, selectRun: store.selectRun, loadMoreImages: store.loadMoreImages, loadRun: store.loadRun, loadReferences: store.loadReferences, startGalleryReferences: store.startGalleryReferences, stopGalleryReferences: store.stopGalleryReferences,
          launches,
          publish: style => publishStyle(store, style),
          pickLocalReferences: (kind, signal) => transport.invoke('local-reference-pick', { kind, title: t(kind === 'file' ? 'upload' : kind === 'folder' ? 'uploadFolder' : 'referenceLocal'), ...(kind === 'references' ? { folderLabel: t('referenceCurrentFolder'), imagesLabel: t('upload') } : {}) }, signal),
          listLocalReferences: (path, kind, signal) => transport.invoke('local-files-list', { path, kind }, signal),
          galleryRead: gallery.read,
          async saveCredential(ref, value) { const response = await ctx.remote.credentials.set(ref, value); if (!response.ok) throw response.error },
        }
        const face = () => ({ t, actions, welcomeImage, logoImage, hooks: { workbench: { getSnapshot: store.getSnapshot, subscribe: store.subscribe }, launches: { getSnapshot: launches.getSnapshot, subscribe: launches.subscribe } } })
        function EntryIcon() { return React.createElement(IconPanelLeftOutlineRegular, { size: 18 }) }
        const registrations = new Map<Page, () => void>()
        let stopped = false, sequence = 0
        function remove(page: Page) {
          registrations.get(page)?.()
          registrations.delete(page)
        }
        function mount(page: Page) {
          const child = ctx.plugin({ name: `visual-curator-ui-${page}`, apply(scope) {
            const options = { id: panel, order: 46, label: () => t('title'), locale: namespace, inject: face }
            if (page === 'settings') scope.slots.inject('settings.section', () => scope.slots.register({ ...options, name: 'settings.section' }, PageEntry))
            if (page === 'panel') {
              scope.slots.inject('main', () => scope.slots.register({ ...options, name: 'main', key: panel }, PageEntry))
              scope.slots.inject('sidebar.panellist', () => scope.slots.register({ id: panel, order: 46, label: () => t('title'), locale: namespace, name: 'sidebar.panellist' }, EntryIcon))
            }
            if (page === 'conversation') {
              scope.effect(() => scope.uiConversation.views.register({ target: panel, create: () => ({ empty: null, replace: () => null, apply: () => null }) }), 'Visual Curator conversation entry')
              scope.slots.inject('conversation.view', () => scope.slots.register({ ...options, name: 'conversation.view' }, PageEntry))
            }
          } })
          registrations.set(page, () => {
            if (page === 'panel' && ctx.layout.panelInfo.getSnapshot().activePanelId === panel) ctx.layout.selectPanel(null)
            void child.dispose()
          })
          void store.ensureLoaded()
        }
        async function sync() {
          const current = ++sequence
          try {
            const [bundles, plugins] = await Promise.all([ctx.remote.pluginManager.listBundles(), ctx.remote.pluginManager.listPlugins()])
            if (stopped || current !== sequence) return
            // 连接或清单读取失败时撤下入口，避免把未确认的 Host 状态显示为可用。
            if (!bundles.ok || !plugins.ok) { for (const page of [...registrations.keys()]) remove(page); return }
            const bundle = bundles.value.find(item => item.name === 'dsh-plugin-visual-curator')
            for (const page of ['settings', 'panel', 'conversation'] as const) {
              const feature = bundle?.features?.find(item => item.id === `ui-${page}`)
              const entryId = bundle?.rows.find(row => row.rowId === feature?.rowId)?.entryId
              const active = bundle?.enabled && feature?.enabled && plugins.value.some(row => row.entryId === entryId && row.enabled && row.fiberPhase === 'active')
              if (active && !registrations.has(page)) mount(page)
              else if (!active) remove(page)
            }
          } catch (error) {
            // 重连与停用会拒绝在途 Remote；旧入口不得继续保留。
            if (!stopped && current === sequence) for (const page of [...registrations.keys()]) remove(page)
          }
        }
        ctx.effect(() => {
          const style = document.createElement('style'); style.textContent = css.replace('__VC_EXECUTION_EMPTY_ART__', executionEmptyImage); document.head.append(style)
          return () => style.remove()
        }, 'Visual Curator entry styles')
        ctx.effect(() => {
          const changed = ctx.remote.$on('plugin-manager/changed', () => { void sync() })
          const reset = ctx.on('connection/reset', () => {
            ++sequence; store.reset()
            for (const page of [...registrations.keys()]) remove(page)
            void sync()
          })
          void sync()
          let timer: ReturnType<typeof setTimeout> | undefined, detailTimer: ReturnType<typeof setTimeout> | undefined, polling = false
          let referencing = store.getSnapshot().galleryTasks.some(task => galleryTaskActive(task.status))
          const pollDetail = () => {
            detailTimer = setTimeout(async () => {
              const state = store.getSnapshot()
              if (registrations.size && state.analysisRunId && !state.analysisStreaming && (!state.analysisDetail || analysisActive(state.analysisDetail.task.status))) await store.refreshAnalysisDetail()
              if (!stopped) pollDetail()
            }, store.getSnapshot().snapshot?.configuration.limits.processPollIntervalMs ?? 500)
          }
          const poll = () => {
            timer = setTimeout(async () => {
              timer = undefined; polling = true
              try {
                if (registrations.size) {
                  if (store.getSnapshot().snapshot?.collectionPaging) await store.refreshGalleryTasks()
                  else await store.reload()
                }
              } finally { polling = false; if (!stopped) poll() }
            }, referencing ? store.getSnapshot().snapshot?.configuration.limits.processPollIntervalMs ?? 500 : store.getSnapshot().snapshot?.configuration.limits.pollIntervalMs ?? 2000)
          }
          const followReferences = store.subscribe(() => {
            const active = store.getSnapshot().galleryTasks.some(task => galleryTaskActive(task.status))
            if (active === referencing) return
            referencing = active
            if (!polling && !stopped) { clearTimeout(timer); poll() }
          })
          poll()
          pollDetail()
          return () => { stopped = true; ++sequence; clearTimeout(timer); clearTimeout(detailTimer); followReferences(); changed(); reset(); readLifetime.abort(); store.dispose(); for (const page of [...registrations.keys()]) remove(page) }
        }, 'Visual Curator optional entry lifecycle')
      },
    }
  },
})

export {}
