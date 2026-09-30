import { createWorkbench } from './afp-workbench.js'
import { createAfpClientStore } from './afp-client-store.js'
import { createConfigurationForm } from './afp-configuration-form.js'
import zh from './locales/zh.json'
import en from './locales/en.json'
import css from '../../assets/workbench.css'

window.__ModuleLoader__.load({ id: 'dsh-plugin-afp', factory(require) {
  const React = require('react'), { Switch, Input, Button, StateDot } = require('@deepseek-ai/dsh-client-ui-primitives')
  return { inject: ['slots', 'locale', 'remote', 'remote.pluginManager', 'remote.credentials', 'layout', 'uiConversation'], apply(ctx) {
    const namespace = 'afpWorkbench', panel = 'afp-workbench'
    ctx.effect(() => ctx.locale.register(namespace, { en, zh }), 'AFP locale')
    const t = ctx.locale.bind(namespace), store = createAfpClientStore(ctx)
    const Workbench = createWorkbench(React, Switch, ctx, t, store)
    const ConfigurationForm = createConfigurationForm(React, { Input, Button, StateDot }, ctx, t)
    for (const row of ['afp-read', 'afp-refresh', 'afp-write']) ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
      name: 'plugins.row.config', key: `dsh-plugin-afp#${row}`, locale: namespace,
    }, ConfigurationForm))
    ctx.effect(() => { const style = document.createElement('style'); style.textContent = css; document.head.append(style); return () => style.remove() }, 'AFP styles')
    ctx.effect(() => () => store.dispose(), 'AFP store')
    const registrations = new Map()
    function icon({ size = 18 }) {
      return React.createElement('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        React.createElement('rect', { x: 3, y: 4, width: 18, height: 16, rx: 4, stroke: 'currentColor', strokeWidth: 1.6 }),
        React.createElement('circle', { cx: 8.5, cy: 9, r: 1.5, fill: 'currentColor' }),
        React.createElement('path', { d: 'm5 17 5-5 3 3 3-4 3 6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }
    function sync() {
      const flags = store.getSnapshot().status?.features ?? []
      for (const feature of ['ui-settings', 'ui-panel', 'ui-conversation']) {
        if (flags.includes(feature) === registrations.has(feature)) continue
        if (!flags.includes(feature)) { registrations.get(feature)(); registrations.delete(feature); continue }
        const options = { id: panel, order: 45, label: () => t('title'), locale: namespace }
        const child = ctx.plugin({ name: `afp-${feature}`, apply(child) {
        if (feature === 'ui-settings') child.slots.inject('settings.section', () => child.slots.register({ ...options, name: 'settings.section' }, Workbench))
        if (feature === 'ui-panel') {
          child.slots.inject('main', () => child.slots.register({ name: 'main', key: panel, locale: namespace }, Workbench))
          child.slots.inject('sidebar.panellist', () => child.slots.register({ ...options, name: 'sidebar.panellist' }, icon))
        }
        if (feature === 'ui-conversation') {
          child.effect(() => child.uiConversation.views.register({ target: panel, create: () => ({ empty: null, replace: () => null, apply: () => null }) }), 'AFP view definition')
          child.slots.inject('conversation.view', () => child.slots.register({ ...options, name: 'conversation.view' }, Workbench))
        }
        } })
        registrations.set(feature, () => {
          if (feature === 'ui-panel' && ctx.layout.panelInfo.getSnapshot().activePanelId === panel) ctx.layout.selectPanel(null)
          void child.dispose()
        })
      }
    }
    ctx.effect(() => {
      const unsubscribe = store.subscribe(sync)
      const changed = ctx.remote.$on('plugin-manager/changed', () => { void store.reload() })
      const reset = ctx.on('connection/reset', () => { void store.reload() })
      let timer, stopped = false
      const poll = async () => {
        await store.reload()
        if (!stopped) timer = setTimeout(poll, store.getSnapshot().status?.pollIntervalMs ?? 2000)
      }
      void poll()
      return () => { stopped = true; clearTimeout(timer); unsubscribe(); changed(); reset(); for (const remove of registrations.values()) remove(); registrations.clear() }
    }, 'AFP entry lifecycle')
  } }
} })
