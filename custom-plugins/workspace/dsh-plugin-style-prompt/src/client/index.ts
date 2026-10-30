/** Lifecycle-bound native sidebar entry; all business callbacks are injected into React components. */
import type { ComponentType } from 'react'
import css from './entry.css'
import { createWorkbench } from './workbench.tsx'
import { createTransport, createWorkspace } from './workspace.ts'
import { en, zh } from './locale.ts'

type Result<T> = { ok: true; value: T } | { ok: false; error: object }
interface EntryContext {
  effect(callback: () => (() => void), label: string): void
  on(event: 'connection/reset', callback: () => void): () => void
  plugin(plugin: { name: string; apply(ctx: EntryContext): void }): { dispose(): Promise<void> }
  slots: {
    inject(name: string, register: () => (() => void)): void
    register<P extends object>(options: { name: string; id?: string; key?: string; order?: number; label?: () => string; locale: string; inject?: () => object }, component: ComponentType<P>): () => void
  }
  locale: { register(namespace: string, values: { en: typeof en; zh: typeof en }): () => void; bind(namespace: string): (key: keyof typeof en) => string }
  remote: {
    $on(event: 'plugin-manager/changed' | 'llm/adapters-updated', callback: () => void): () => void
    pluginManager: {
      listBundles(): Promise<Result<{ name: string; enabled: boolean; rows: { rowId: string; entryId?: string }[] }[]>>
      listPlugins(): Promise<Result<{ entryId: string; enabled: boolean; fiberPhase?: string }[]>>
    }
  }
  layout: { panelInfo: { getSnapshot(): { activePanelId: string | null } }; selectPanel(id: string | null): void }
}
interface ModuleLoader { load(module: { id: string; factory(require: <T>(name: string) => T): { inject: string[]; apply(ctx: EntryContext): void } }): void }
declare global { interface Window { __ModuleLoader__: ModuleLoader } }

window.__ModuleLoader__.load({ id: 'dsh-plugin-style-prompt', factory(require) {
  const React = require<typeof import('react')>('react')
  const ui = require<typeof import('@deepseek-ai/dsh-client-ui-primitives')>('@deepseek-ai/dsh-client-ui-primitives')
  const { Workbench, Notice } = createWorkbench(React, ui)
  function Icon() { return React.createElement(ui.IconPanelLeftOutlineRegular, { size: 18 }) }
  function OpenEntry({ open, label }: { open(): void; label: string }) { return React.createElement(ui.Button, { onClick: open }, label) }
  return { inject: ['slots', 'locale', 'remote', 'remote.pluginManager', 'layout'], apply(ctx) {
    const namespace = 'stylePrompt', panel = 'style-prompt-page'
    ctx.effect(() => ctx.locale.register(namespace, { en, zh }), 'Style Prompt locale')
    const t = ctx.locale.bind(namespace)
    let workspace = createWorkspace(createTransport({ baseUrl: document.baseURI, fetch: (input, init) => fetch(input, init) }))
    const useWorkspace = () => React.useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, workspace.getSnapshot)
    const referenceUrl = (id: string, reference: string) => { const url = new URL('api/style-prompt/image', document.baseURI); url.searchParams.set('id', id); url.searchParams.set('reference', reference); return url.href }
    let child: { dispose(): Promise<void> } | undefined, stopped = false, sequence = 0
    function unmount() {
      if (ctx.layout.panelInfo.getSnapshot().activePanelId === panel) ctx.layout.selectPanel(null)
      if (child) {
        void child.dispose(); child = undefined
        workspace.dispose()
        if (!stopped) workspace = createWorkspace(createTransport({ baseUrl: document.baseURI, fetch: (input, init) => fetch(input, init) }))
      }
    }
    async function sync() {
      const current = ++sequence
      try {
        const [bundles, plugins] = await Promise.all([ctx.remote.pluginManager.listBundles(), ctx.remote.pluginManager.listPlugins()])
        if (stopped || current !== sequence) return
        const bundle = bundles.ok ? bundles.value.find(value => value.name === 'dsh-plugin-style-prompt') : undefined
        const entryId = bundle?.rows.find(row => row.rowId === 'style-prompt')?.entryId
        const active = bundle?.enabled && plugins.ok && plugins.value.some(row => row.entryId === entryId && row.enabled && row.fiberPhase === 'active')
        if (!active) { unmount(); return }
        if (child) return
        child = ctx.plugin({ name: 'style-prompt-workbench', apply(scope) {
          const face = () => ({ t, useWorkspace, actions: workspace, referenceUrl })
          scope.slots.inject('main', () => scope.slots.register({ name: 'main', key: panel, id: panel, locale: namespace, inject: face }, Workbench))
          scope.slots.inject('sidebar.panellist', () => scope.slots.register({ name: 'sidebar.panellist', id: panel, order: 47, label: () => t('title'), locale: namespace }, Icon))
          scope.slots.inject('plugins.bundle.config', () => scope.slots.register({ name: 'plugins.bundle.config', key: 'dsh-plugin-style-prompt', locale: namespace, inject: () => ({ label: t('title'), open: () => ctx.layout.selectPanel(panel) }) }, OpenEntry))
          scope.slots.inject('shell.overlay', () => scope.slots.register({ name: 'shell.overlay', id: 'style-prompt-notice', locale: namespace, inject: face }, Notice))
        } })
        void workspace.refresh()
      } catch (error) {
        // 无法确认 Host 是否启用时撤下入口，重连事件再读取实际状态。
        if (!stopped && current === sequence) unmount()
      }
    }
    ctx.effect(() => {
      const style = document.createElement('style'); style.textContent = css; document.head.append(style)
      return () => style.remove()
    }, 'Style Prompt scoped styles')
    ctx.effect(() => {
      const changed = ctx.remote.$on('plugin-manager/changed', () => { void sync() })
      const models = ctx.remote.$on('llm/adapters-updated', () => { if (child) void workspace.refresh() })
      const reset = ctx.on('connection/reset', () => { ++sequence; unmount(); workspace.dispose(); workspace = createWorkspace(createTransport({ baseUrl: document.baseURI, fetch: (input, init) => fetch(input, init) })); void sync() })
      void sync()
      return () => { stopped = true; ++sequence; changed(); models(); reset(); unmount(); workspace.dispose() }
    }, 'Style Prompt entry lifecycle')
  } }
} })

export {}
