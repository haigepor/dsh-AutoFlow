/** Optional native page entries; the plugin detail itself stays entirely owned by Plugin Manager. */
import type { ComponentType } from 'react'
import css from './entry.css'

type Page = 'settings' | 'panel' | 'conversation'
type Result<T> = { ok: true; value: T } | { ok: false; error: object }
interface Bundle {
  name: string
  enabled: boolean
  rows: { rowId: string; entryId?: string }[]
  features?: { id: string; rowId: string; enabled: boolean }[]
}
interface Row { entryId: string; enabled: boolean; fiberPhase?: string }
interface SlotOptions { name: string; id?: string; key?: string; order?: number; label?: () => string; locale: string }
interface EntryContext {
  effect(callback: () => (() => void), label: string): void
  on(event: 'connection/reset', callback: () => void): () => void
  plugin(plugin: { name: string; apply(ctx: EntryContext): void }): { dispose(): Promise<void> }
  slots: {
    inject(name: string, register: () => (() => void)): void
    register(options: SlotOptions, component: ComponentType): () => void
  }
  locale: {
    register(namespace: string, locales: { en: typeof en; zh: typeof en }): () => void
    bind(namespace: string): (key: keyof typeof en) => string
  }
  remote: {
    $on(event: 'plugin-manager/changed', callback: () => void): () => void
    pluginManager: { listBundles(): Promise<Result<Bundle[]>>; listPlugins(): Promise<Result<Row[]>> }
  }
  layout: { panelInfo: { getSnapshot(): { activePanelId: string | null } }; selectPanel(id: string | null): void }
  uiConversation: { views: { register(view: { target: string; create(): { empty: null; replace(): null; apply(): null } }): () => void } }
}
interface ModuleLoader {
  load(module: { id: string; factory(require: <T>(name: string) => T): { inject: string[]; apply(ctx: EntryContext): void } }): void
}
declare global { interface Window { __ModuleLoader__: ModuleLoader } }

const en = {
  title: 'Visual Curator', stage: 'Page design pending',
  description: 'The page entry is ready. Reference styles, image search, cropping and data views will be added with the new design.',
  note: 'Manage optional Skills and tools on the plugin detail page. Existing records and background tasks are retained.',
}
const zh: typeof en = {
  title: '视觉策展', stage: '页面待设计',
  description: '页面入口已就绪。参考风格、找图、裁图和数据页面将按新的设计逐步搭建。',
  note: '可在插件详情页管理技能与工具开关。已保存记录与后台任务保留。',
}

window.__ModuleLoader__.load({
  id: 'dsh-plugin-visual-curator',
  factory(require) {
    const React = require<typeof import('react')>('react')
    const { Tag, IconPanelLeftOutlineRegular } = require<typeof import('@deepseek-ai/dsh-client-ui-primitives')>('@deepseek-ai/dsh-client-ui-primitives')
    return {
      inject: ['slots', 'locale', 'remote', 'remote.pluginManager', 'layout', 'uiConversation'],
      apply(ctx) {
        const namespace = 'visualCuratorEntry', panel = 'visual-curator-page'
        ctx.effect(() => ctx.locale.register(namespace, { en, zh }), 'Visual Curator entry locale')
        const t = ctx.locale.bind(namespace)
        // 所有入口共用明确标注的占位页，不恢复旧工作台或读取业务数据。
        function PageEntry() {
          return React.createElement('section', { className: 'vc-entry' },
            React.createElement('header', null, React.createElement('h1', null, t('title')),
              React.createElement(Tag, null, t('stage'))),
            React.createElement('p', null, t('description')), React.createElement('p', null, t('note')))
        }
        function EntryIcon() { return React.createElement(IconPanelLeftOutlineRegular, { size: 18 }) }
        const registrations = new Map<Page, () => void>()
        let stopped = false, sequence = 0
        function remove(page: Page) {
          registrations.get(page)?.()
          registrations.delete(page)
        }
        function mount(page: Page) {
          const child = ctx.plugin({ name: `visual-curator-ui-${page}`, apply(scope) {
            const options = { id: panel, order: 46, label: () => t('title'), locale: namespace }
            if (page === 'settings') scope.slots.inject('settings.section', () => scope.slots.register({ ...options, name: 'settings.section' }, PageEntry))
            if (page === 'panel') {
              scope.slots.inject('main', () => scope.slots.register({ name: 'main', key: panel, locale: namespace }, PageEntry))
              scope.slots.inject('sidebar.panellist', () => scope.slots.register({ ...options, name: 'sidebar.panellist' }, EntryIcon))
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
          } catch (error) {
            // 重连与停用会拒绝在途 Remote；旧入口不得继续保留。
            if (!stopped && current === sequence) for (const page of [...registrations.keys()]) remove(page)
          }
        }
        ctx.effect(() => {
          const style = document.createElement('style'); style.textContent = css; document.head.append(style)
          return () => style.remove()
        }, 'Visual Curator entry styles')
        ctx.effect(() => {
          const changed = ctx.remote.$on('plugin-manager/changed', () => { void sync() })
          const reset = ctx.on('connection/reset', () => {
            ++sequence
            for (const page of [...registrations.keys()]) remove(page)
            void sync()
          })
          void sync()
          return () => { stopped = true; ++sequence; changed(); reset(); for (const page of [...registrations.keys()]) remove(page) }
        }, 'Visual Curator optional entry lifecycle')
      },
    }
  },
})

export {}
