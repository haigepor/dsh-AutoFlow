/** Native Client slots and a shared Toast host that outlives the workbench. */
import { createStore } from './store.js'
import { createWorkbench } from './workbench.js'
import { createArtwork } from './artwork.js'
import en from './locales/en.json'
import zh from './locales/zh.json'
import css from '../../assets/workbench.css'

window.__ModuleLoader__.load({ id: 'dsh-plugin-article-image', factory(require) {
  const React = require('react'), ui = require('@deepseek-ai/dsh-client-ui-primitives')
  const { Mark } = createArtwork(React)
  return { inject: ['slots', 'locale', 'remote', 'remote.pluginManager', 'layout'], apply(ctx) {
    const namespace = 'articleImage', panel = 'article-image-workbench', store = createStore(ctx)
    ctx.effect(() => ctx.locale.register(namespace, { en, zh }), 'Article image locale')
    const translate = ctx.locale.bind(namespace), t = key => translate(key) === key ? '' : translate(key)
    let notify = () => {}
    function ToastHost() {
      const [notice, setNotice] = React.useState(null)
      React.useEffect(() => { notify = (text, tone) => setNotice({ text, tone, id: Date.now() }); return () => { notify = () => {} } }, [])
      return notice ? React.createElement(ui.Toast, { ...notice, key: notice.id, holdMs: 4000, onDone: () => setNotice(null) }) : null
    }
    const Workbench = createWorkbench(React, ui, store, t, (text, tone) => notify(text, tone))
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'article-image-toast', locale: namespace }, ToastHost))
    let view
    const sync = () => {
      const enabled = store.getSnapshot().status?.features.includes('ui-panel')
      if (enabled && !view) view = ctx.plugin({ name: 'article-image-workbench', apply(child) {
        child.slots.inject('main', () => child.slots.register({ name: 'main', key: panel, locale: namespace }, Workbench))
        child.slots.inject('sidebar.panellist', () => child.slots.register({ name: 'sidebar.panellist', id: panel, order: 46, label: () => t('navTitle'), locale: namespace }, Mark))
      } })
      if (!enabled && view) {
        if (ctx.layout.panelInfo.getSnapshot().activePanelId === panel) ctx.layout.selectPanel(null)
        void view.dispose(); view = null
      }
    }
    ctx.effect(() => {
      const unsubscribe = store.subscribe(sync), changes = ctx.remote.$on('plugin-manager/changed', () => { void store.reload() })
      const reset = ctx.on('connection/reset', () => { void store.reload() })
      sync()
      return () => { unsubscribe(); changes(); reset(); if (view) void view.dispose(); store.dispose() }
    }, 'Article image workbench lifecycle')
    ctx.effect(() => { const style = document.createElement('style'); style.textContent = css; document.head.append(style); return () => style.remove() }, 'Article image styles')
  } }
} })
