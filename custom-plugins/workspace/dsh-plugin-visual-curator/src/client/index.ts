import { createConversationFeedback } from './conversation-feedback.ts'
import { resolvePreviewConcurrency, sharedPreviewLoader } from './preview-loader.ts'
import { createSearchBatchesStore } from './search-batches-store.ts'
/** Optional native page entries; the plugin detail itself stays entirely owned by Plugin Manager. */
import type { ComponentType } from 'react'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { z } from 'zod'
import * as React from 'react'
import * as ui from '@deepseek-ai/dsh-client-ui-primitives'
import css from './entry.css'
import flowCss from '@xyflow/react/dist/style.css'
import workflowCss from './workflow-canvas.css'
import wallpaperPlanEditorCss from './wallpaper-plan-editor.css'
import welcomeImage from '../../assets/welcome-photo-stack-v2.webp'
import logoImage from '../../assets/plugin-logo-v2.webp'
import taskMetricArtwork from '../../assets/task-metric-plates-v2.webp'
import searchLaunchArtwork from '../../assets/search-launch-whale-maid-v1.webp'
import { createTaskToolView } from './task-tool-view.tsx'
import { createConversationTaskDock } from './conversation-task-dock.tsx'
import { createCuratorStore } from './store.ts'
import { createCuratorTransport } from './transport.ts'
import { createGalleryCache } from './gallery-cache.ts'
import { resolveGalleryCachePolicy, resolvePreviewCachePolicy } from '../shared/gallery-cache.ts'
import { directCropVisible } from './direct-crop.tsx'
import { createWorkbench, type WorkbenchProps } from './workbench.tsx'
import { publishStyle } from './workbench-actions.ts'
import { en, zh } from './workbench-locale.ts'
import { analysisActive } from '../shared/analysis-process.ts'
import { galleryTaskActive } from '../shared/gallery-task.ts'
import { createVisionModelDirectory } from './vision-models.ts'
import { createDatasetStore } from './dataset-store.ts'
import { createSearchLaunchStore } from './search-launch-store.ts'
import { searchBatchDetailSchema } from '../shared/search-batches.ts'

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
    $on(event: 'plugin-manager/changed' | 'llm/adapters-updated' | 'settings/document-updated' | 'credentials/record-updated' | 'credentials/reference-updated', callback: () => void): () => void
    pluginManager: { listBundles(): Promise<Result<Bundle[]>>; listPlugins(): Promise<Result<Row[]>>; invokeAction(name: string, action: string, input: Record<string, string>): Promise<Result<{ output: string }>> }
    credentials: { set(ref: string, value: string): Promise<Result<object>> }
  }
  layout: { panelInfo: { getSnapshot(): { activePanelId: string | null } }; selectPanel(id: string | null, options?: { fullWindow?: boolean }): void }
  uiConversation: {
    views: { register(view: { target: string; create(): { empty: null; replace(): null; apply(): null } }): () => void }
    events: { register<State>(definition: ConversationNodeDefinition<State>): () => void }
  }
}
function createEntry() {
    const PageEntry = createWorkbench(React, ui)
    const TaskToolView = createTaskToolView(React, ui)
    const ConversationTaskDock = createConversationTaskDock(React, ui)
    return {
      inject: ['slots', 'locale', 'remote', 'remote.pluginManager', 'remote.credentials', 'layout', 'uiConversation'],
      apply(ctx: EntryContext) {
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
        const directActive = () => { const scope = store.getSnapshot().snapshot?.ownerScopeId; return !!scope && directCropVisible(scope) }
        ctx.effect(() => {
          const configure = () => { const options = store.getSnapshot().snapshot?.configuration.source.unsplash; sharedPreviewLoader.configure(resolvePreviewConcurrency(options?.previewConcurrency), resolvePreviewCachePolicy(options?.previewCache), store.getOwnerScopeId()) }
          const follow = store.subscribe(configure); configure()
          return () => { follow(); void sharedPreviewLoader.dispose() }
        }, 'Visual Curator bounded preview loading')
        const batches = createSearchBatchesStore({ ...transport, scope: store.getOwnerScopeId, pollMs: () => store.getSnapshot().snapshot?.configuration.limits.pollIntervalMs ?? 2000, cachePolicy() {
          const limits = store.getSnapshot().snapshot?.configuration.limits
          return { ttlMs: limits?.batchCacheTtlMs ?? 0, maxViews: limits?.batchCacheMaxViews ?? 0, resourceTtlMs: limits?.sessionGrantTtlMs ?? 0 }
        } })
        ctx.effect(() => () => batches.dispose(), 'Visual Curator collection search batches')
        const feedback = createConversationFeedback(transport)
        ctx.effect(() => () => feedback.dispose(), 'Visual Curator conversation feedback')
        const datasets = createDatasetStore({ invoke: (operation, args, signal) => operation === 'dataset-delete' ? store.execute(operation, args) : store.invoke(operation, args, signal), context: () => ({ scope: store.getScopeId(), styleId: !directActive() && store.getSnapshot().snapshot && !store.getSnapshot().runLoading ? store.getSnapshot().styleId : '', workspaceRevision: store.getSnapshot().snapshot?.workspaceRevision }), cachePolicy() {
          const limits = store.getSnapshot().snapshot?.configuration.limits
          return { ttlMs: limits?.datasetCacheTtlMs ?? 0, maxViews: limits?.datasetCacheMaxViews ?? 0, maxBytes: limits?.datasetCacheMaxBytes ?? 0, resourceTtlMs: limits?.sessionGrantTtlMs ?? 0 }
        } })
        const launches = createSearchLaunchStore({ invoke: store.invoke, context: () => ({ scope: store.getScopeId(), styleId: !directActive() && store.getSnapshot().snapshot ? store.getSnapshot().styleId : '', workspaceRevision: store.getSnapshot().snapshot?.workspaceRevision, pollMs: store.getSnapshot().snapshot?.configuration.limits.pollIntervalMs ?? 2000 }), openSession(id) {
          const navigation = ctx.get?.('uiWorkspace')
          if (!navigation) throw new Error('native-navigation-unavailable')
          navigation.openSession(id)
        } })
        ctx.effect(() => {
          const follow = store.subscribe(() => launches.sync()); launches.sync()
          return () => { follow(); launches.dispose() }
        }, 'Visual Curator native search launches')
        ctx.effect(() => {
          const follow = store.subscribe(() => datasets.sync())
          datasets.sync()
          return () => { follow(); datasets.dispose() }
        }, 'Visual Curator dataset observation')
        const modelDirectory = createVisionModelDirectory(() => transport.invoke('vision-models', {}))
        ctx.effect(() => {
          const events = ['llm/adapters-updated', 'settings/document-updated', 'credentials/record-updated', 'credentials/reference-updated'] as const
          const disposers = events.map(event => ctx.remote.$on(event, () => modelDirectory.invalidate()))
          return () => { for (const dispose of disposers) dispose(); modelDirectory.dispose() }
        }, 'Visual Curator project model catalog')
        for (const toolName of ['visual_search_start', 'visual_crop_start', 'visual_run_get']) ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: toolName, locale: namespace, inject: () => ({ t }) }, TaskToolView))
        const taskDockFace = (sessionId: string) => ({ t, hooks: { feedback: feedback.sessionSource(sessionId) }, selectTask: (runId: string) => feedback.select(sessionId, runId), refreshTask: (runId?: string) => feedback.refresh(sessionId, runId), stopTask: (runId: string) => feedback.stop(sessionId, runId), stopLaunch: (launchId: string) => feedback.stopLaunch(sessionId, launchId), retryPresentation: (launchId: string) => taskPresentationFace(sessionId).operate('sync', launchId), filterTask: (runId: string, filter: import('../shared/search-feedback.ts').RunResultFilter) => feedback.filterResults(sessionId, runId, filter), loadMoreTask: (runId: string) => feedback.loadMore(sessionId, runId), async openTask(runId: string) { if (!registrations.has('panel')) throw new Error('panel-disabled'); const opening = store.openTask(runId, sessionId, true); ctx.layout.selectPanel(panel); await opening } })
        ctx.slots.inject('conversation.body.overlay', () => ctx.slots.register({ name: 'conversation.body.overlay', id: 'visual-curator-task', order: 30, locale: namespace, inject: taskDockFace }, ConversationTaskDock))
        const taskPresentationFace = (sessionId: string) => ({ t,
          async operate(operation: 'stop' | 'resume' | 'sync', launchId: string, runId?: string) {
            const grant = z.object({ sessionToken: z.string() }).parse(await transport.invoke('session-open', { sessionId }))
            const args = { sessionId, sessionToken: grant.sessionToken }
            if (operation === 'resume' && runId) await transport.invoke('run-control', { ...args, runId, command: 'resume', waitForCompletion: false })
            else await transport.invoke(operation === 'stop' ? 'search-launch-stop' : operation === 'resume' ? 'search-launch-resume' : 'search-launch-presentation', { ...args, id: launchId })
            feedback.refresh(sessionId)
          },
          async readTask(styleId: string, runId: string, signal: AbortSignal) {
            return searchBatchDetailSchema.parse(await transport.invoke('search-batch-detail', { styleId, runId }, signal))
          },
        })
        let sessionCache: Storage | undefined
        try { sessionCache = window.sessionStorage } catch (error) { /* 浏览器禁用本地存储时，仅使用内存缓存。 */ }
        const gallery = createGalleryCache({ ...(sessionCache ? { storage: sessionCache } : {}), context: () => {
          const configuration = store.getSnapshot().snapshot?.configuration
          if (!configuration) throw new Error('gallery-configuration-unavailable')
          return { namespace: `${new URL(document.baseURI).origin}:${store.getSnapshot().scopeSessionId}`, revision: configuration.revision, accounts: configuration.source.unsplash.accounts.map(({ id, userId, credentialRef }) => ({ id, userId, credentialRef })), policy: resolveGalleryCachePolicy(configuration.source.unsplash.cache) }
        }, read: (operation, args, signal) => transport.invoke(operation, { ...args, ...(store.getSnapshot().sessionToken ? { sessionToken: store.getSnapshot().sessionToken } : {}) }, signal) })
        ctx.effect(() => () => gallery.dispose(), 'Visual Curator gallery cache')
        const actions: WorkbenchProps['actions'] = { directCrop: (operation, args, signal) => transport.invoke(operation, args, signal), directScope: () => store.getSnapshot().snapshot?.ownerScopeId ?? 'uninitialized', directView: () => { datasets.sync(); launches.sync(); observationChanged() }, wallpaper: (operation, args, signal) => store.invoke(operation, args, signal), selectWorkspace: store.selectWorkspace, openSession: store.openSession, closeSession: store.closeSession, openTask: store.openTask, prepareTask: store.prepareTask, startAnalysis: store.startAnalysis, referenceState: store.referenceState, stopAnalysis: store.stopAnalysis, pauseAnalysis: store.pauseAnalysis, resumeAnalysis: store.resumeAnalysis, openAnalysis: store.openAnalysis, closeAnalysis: store.closeAnalysis, refreshAnalysisDetail: store.refreshAnalysisDetail, loadAnalysisInput: store.loadAnalysisInput, saveConfiguration: store.saveConfiguration, execute: store.execute, reload: store.reload, getSnapshot: store.getSnapshot, reconcileProfile: store.reconcileProfile,
          selectStyle: store.selectStyle, selectRun: store.selectRun, loadMoreImages: store.loadMoreImages, loadRun: store.loadRun, loadReferences: store.loadReferences, startGalleryReferences: store.startGalleryReferences, resumeGalleryReferences: store.resumeGalleryReferences, stopGalleryReferences: store.stopGalleryReferences,
          datasets, launches, batches,
          publish: style => publishStyle(store, style),
          pickLocalReferences: (kind, signal, title) => transport.invoke('local-reference-pick', { kind, title: title ?? t(kind === 'file' ? 'upload' : kind === 'folder' ? 'uploadFolder' : 'referenceLocal'), ...(kind === 'references' ? { folderLabel: t('referenceCurrentFolder'), imagesLabel: t('upload') } : {}) }, signal),
          listLocalReferences: (path, kind, signal) => transport.invoke('local-files-list', { path, kind }, signal),
          galleryRead: gallery.read,
          readTaskReferences: (args, signal) => transport.invoke('task-reference-list', args, signal),
          imageOptions: () => store.invoke('wallpaper-options', {}),
          loadVisionModels: modelDirectory.load,
          reloadVisionModels: () => modelDirectory.invalidate(),
          openModelSettings: () => ctx.layout.selectPanel('settings', { fullWindow: true }),
          async saveCredential(ref, value) { const response = await ctx.remote.credentials.set(ref, value); if (!response.ok) throw response.error },
        }
        let workbenchObservers = 0, observationChanged = () => {}
        const observeWorkbench = (listener: () => void) => {
          const unsubscribe = store.subscribe(listener), first = workbenchObservers++ === 0
          if (first) observationChanged()
          let closed = false
          return () => { if (closed) return; closed = true; unsubscribe(); if (--workbenchObservers === 0) observationChanged() }
        }
        const face = () => ({ t, actions, welcomeImage, logoImage, hooks: { workbench: { getSnapshot: store.getSnapshot, subscribe: observeWorkbench }, visionModels: { getSnapshot: modelDirectory.getSnapshot, subscribe: modelDirectory.subscribe }, datasets: { getSnapshot: datasets.getSnapshot, subscribe: datasets.subscribe }, launches: { getSnapshot: launches.getSnapshot, subscribe: launches.subscribe }, searchBatches: { getSnapshot: batches.getSnapshot, subscribe: batches.subscribe } } })
        function EntryIcon({ size = 18 }: { size?: number }) { return React.createElement(ui.IconInspectOutlineRegular, { size }) }
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
            observationChanged()
          } catch (error) {
            // 重连与停用会拒绝在途 Remote；旧入口不得继续保留。
            if (!stopped && current === sequence) for (const page of [...registrations.keys()]) remove(page)
          }
        }
        ctx.effect(() => {
          const executionEmptyImage = new URL('api/visual-curator/artwork/execution-empty-v1.webp', document.baseURI).href
          const style = document.createElement('style'); style.textContent = flowCss + '\n' + css.replace('__VC_EXECUTION_EMPTY_ART__', executionEmptyImage).replace('__VC_TASK_METRIC_ART__', taskMetricArtwork).replace('__VC_SEARCH_LAUNCH_ART__', searchLaunchArtwork) + '\n' + workflowCss + '\n' + wallpaperPlanEditorCss; document.head.append(style)
          return () => style.remove()
        }, 'Visual Curator entry styles')
        ctx.effect(() => {
          const changed = ctx.remote.$on('plugin-manager/changed', () => { void sync() })
          const reset = ctx.on('connection/reset', () => {
            ++sequence; feedback.reset(); batches.reset(); store.reset(); modelDirectory.reset()
            for (const page of [...registrations.keys()]) remove(page)
            void sync()
          })
          void sync()
          let timer: ReturnType<typeof setTimeout> | undefined, detailTimer: ReturnType<typeof setTimeout> | undefined, datasetTimer: ReturnType<typeof setTimeout> | undefined, polling = false, opening: Promise<void> | undefined
          let referencing = store.getSnapshot().galleryTasks.some(task => galleryTaskActive(task.status))
          const hasWork = () => {
            const state = store.getSnapshot()
            return state.pending.length > 0 || state.analysisTasks.some(task => analysisActive(task.status)) || state.snapshot?.styles.some(style => style.analysis && analysisActive(style.analysis.status)) === true
          }
          let working = hasWork()
          const observed = () => !stopped && !directActive() && workbenchObservers > 0 && registrations.size > 0 && document.hidden !== true
          const pollDetail = () => {
            if (!observed() || detailTimer) return
            detailTimer = setTimeout(async () => {
              detailTimer = undefined
              const state = store.getSnapshot()
              if (observed() && state.analysisRunId && !state.analysisStreaming && (!state.analysisDetail || analysisActive(state.analysisDetail.task.status))) await store.refreshAnalysisDetail()
              pollDetail()
            }, store.getSnapshot().snapshot?.configuration.limits.processPollIntervalMs ?? 500)
          }
          const pollDatasets = () => {
            if (!observed() || datasetTimer) return
            datasetTimer = setTimeout(async () => {
              datasetTimer = undefined
              try { if (observed() && datasets.needsPoll()) await datasets.poll() }
              finally { pollDatasets() }
            }, store.getSnapshot().snapshot?.configuration.limits.processPollIntervalMs ?? 500)
          }
          const poll = () => {
            if (!observed() || timer || polling) return
            timer = setTimeout(async () => {
              timer = undefined; polling = true
              try {
                if (observed()) {
                  if (store.getSnapshot().snapshot?.collectionPaging) await store.refreshGalleryTasks()
                  else await store.reload()
                }
              } finally { polling = false; poll() }
            }, referencing ? store.getSnapshot().snapshot?.configuration.limits.processPollIntervalMs ?? 500 : working ? store.getSnapshot().snapshot?.configuration.limits.pollIntervalMs ?? 2000 : Math.max(store.getSnapshot().snapshot?.configuration.limits.pollIntervalMs ?? 2000, store.getSnapshot().snapshot?.configuration.limits.idlePollIntervalMs ?? 2000))
          }
          const clearPolling = () => { clearTimeout(timer); clearTimeout(detailTimer); clearTimeout(datasetTimer); timer = detailTimer = datasetTimer = undefined }
          observationChanged = () => {
            if (!observed()) { clearPolling(); return }
            if (!opening) opening = store.reload(false, true).finally(() => { opening = undefined; poll() })
            pollDetail(); pollDatasets()
          }
          const followReferences = store.subscribe(() => {
            const active = store.getSnapshot().galleryTasks.some(task => galleryTaskActive(task.status))
            const nextWorking = hasWork()
            if (active === referencing && nextWorking === working) return
            referencing = active; working = nextWorking
            if (!polling) { clearTimeout(timer); timer = undefined; poll() }
          })
          const visibilityChanged = () => observationChanged()
          document.addEventListener('visibilitychange', visibilityChanged)
          observationChanged()
          return () => { stopped = true; ++sequence; clearPolling(); document.removeEventListener('visibilitychange', visibilityChanged); followReferences(); changed(); reset(); readLifetime.abort(); store.dispose(); for (const page of [...registrations.keys()]) remove(page) }
        }, 'Visual Curator optional entry lifecycle')
      },
    }
}

const entry = createEntry()
/** Client services required by the existing native page registrations. */
export const inject = entry.inject
/** Register the existing workbench with the application React runtime.
 * @param ctx Native client services. @returns Completion after lifecycle registrations.
 */
export const apply = entry.apply
