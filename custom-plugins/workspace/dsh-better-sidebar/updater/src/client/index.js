import enResource from '../../locale/en.json'
import zhResource from '../../locale/zh.json'
import styles from './styles.css'
import { installChangesMotion } from './changes-motion.js'
import { installSettingsPage } from './settings-slot.js'
import { SidebarSettingsPage } from './settings-page.tsx'
import { attachLocale } from '../../../src/client/locales.ts'

const { meta: _enMetadata, ...en } = enResource
const { meta: _zhMetadata, ...zh } = zhResource


  const React = require('react')
  const { Button, StateDot, IconChevronRightOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
  export const inject = ['slots', 'locale', 'remote', 'remote.pluginManager']
export function apply(ctx) {
    const namespace = 'betterSidebarUpdater'
    attachLocale(ctx.locale)
    ctx.effect(() => ctx.locale.register(namespace, { en, zh }), 'Sidebar updater copy')
    let snapshot = { status: 'unchecked' }, disposed = false, pending = false, reading = false, generation = 0
    const listeners = new Set()
    const publish = next => { snapshot = next; for (const listener of listeners) listener() }
    const reload = async operation => {
      const read = operation === 'read'
      if (disposed || (read ? reading : pending)) return
      if (read) reading = true
      else { pending = true; generation++ }
      const observed = generation
      if (operation !== 'read') publish({ ...snapshot, status: operation === 'install' ? 'installing' : 'checking' })
      try {
        const result = await ctx.remote.pluginManager.invokeAction('dsh-plugin-better-sidebar-updater', 'update', { operation })
        if (!result.ok) throw new Error(result.error.message)
        if (!disposed && observed === generation) publish(JSON.parse(result.value.output))
      } catch (error) {
        if (!disposed && observed === generation && (!read || !pending)) publish({ ...snapshot, status: 'error' })
      } finally {
        if (read) reading = false
        else { pending = false; generation++ }
      }
    }
    function UpdatePanel({ subject, t }) {
      const state = React.useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, () => snapshot)
      const [expanded, setExpanded] = React.useState(subject?.pkg?.updateManager !== undefined)
      const show = subject?.kind === 'bundle' && ['dsh-better-sidebar', 'dsh-plugin-better-sidebar-updater'].includes(subject.pkg.name)
      const busy = ['checking', 'installing'].includes(state.status)
      React.useEffect(() => { if (state.status === 'error') setExpanded(true) }, [state.status])
      React.useEffect(() => { if (show) void reload('read') }, [show])
      React.useEffect(() => {
        if (!show || !busy || !state.pollIntervalMs) return
        let cancelled = false, timer
        const poll = async () => {
          await reload('read')
          if (!cancelled) timer = setTimeout(poll, state.pollIntervalMs)
        }
        timer = setTimeout(poll, state.pollIntervalMs)
        return () => { cancelled = true; clearTimeout(timer) }
      }, [show, busy, state.pollIntervalMs])
      if (!show) return null
      const restart = () => {
        // 共享确认窗口负责桌面重启与 Web 新进程就绪检查。
        const navigation = ctx.get('pluginNavigation')
        if (navigation) navigation.showUpdateRestart('dsh-better-sidebar')
        else publish({ ...snapshot, restartUnavailable: true })
      }
      const row = (label, version) => version ? React.createElement('div', { className: 'better-sidebar-updater-version', key: label },
        React.createElement('dt', null, t(label)), React.createElement('dd', null, version)) : null
      const status = attribute => {
        const compact = attribute === 'data-update-summary'
        const label = t('status_' + state.status)
        return React.createElement(compact ? 'span' : 'div', { [attribute]: '', role: 'status', 'aria-live': 'polite', 'data-error': state.status === 'error' },
          busy && !state.restartRequired ? React.createElement(compact ? 'span' : 'div', { 'data-update-activity': '', 'aria-busy': true },
            React.createElement('span', { 'data-update-activity-label': '' }, React.createElement(StateDot, { state: 'ongoing', size: 14 }),
              React.createElement('span', null, label)),
            compact ? null : React.createElement('div', { 'data-update-progress-track': '', 'data-plugin-update-progress': '', role: 'progressbar', 'aria-label': label },
              React.createElement('span', { 'data-update-progress-sweep': '' }))) : label)
      }
      return React.createElement('details', { 'data-plugin-update-card': '', 'data-sidebar-updater': '', 'aria-busy': busy,
        open: expanded, onToggle: event => { setExpanded(event.currentTarget.open) } },
        React.createElement('summary', null,
          React.createElement(IconChevronRightOutlineRegular, { size: 14, 'aria-hidden': true }),
          React.createElement('span', { 'data-update-title': '' }, t('title')),
          state.installedVersion ? React.createElement('span', { 'data-update-version': '' }, t('installedSummary', { version: state.installedVersion })) : null,
          expanded ? null : status('data-update-summary')),
        React.createElement('div', { 'data-update-body': '' },
          React.createElement('div', { 'data-update-release': '' },
            expanded ? status('data-update-status') : null,
            React.createElement('div', { 'data-update-actions': '' },
              React.createElement(Button, { variant: 'outline', size: 'sm', disabled: busy || state.restartRequired, onClick: () => { void reload('check') } }, t(busy && state.status === 'checking' ? 'status_checking' : 'check')),
              state.restartRequired ? React.createElement(Button, { size: 'sm', onClick: restart }, t('restart'))
                : state.status === 'available' ? React.createElement(Button, { size: 'sm', disabled: busy, onClick: () => { void reload('install') } }, t('install')) : null)),
          React.createElement('p', { className: 'better-sidebar-updater-description', 'data-update-hint': '' }, t('description')),
          state.restartRequired || state.latestVersion && state.latestVersion !== state.installedVersion ? React.createElement('dl', { className: 'better-sidebar-updater-versions' },
            state.restartRequired ? row('activeVersion', state.currentVersion) : null,
            row('latestVersion', state.latestVersion)) : null,
          state.releaseUrl ? React.createElement('a', { className: 'better-sidebar-updater-release', href: state.releaseUrl, target: '_blank', rel: 'noopener noreferrer' }, t('release')) : null,
          state.restartUnavailable ? React.createElement('p', { 'data-update-hint': '' }, t('restartManually')) : null))
    }
    ctx.effect(() => ctx.slots.inject('plugins.detail.updates', () => ctx.slots.register({ name: 'plugins.detail.updates', id: namespace, locale: namespace }, UpdatePanel)), 'Sidebar update detail section')
    ctx.effect(() => {
      const style = document.createElement('style')
      style.textContent = styles
      document.head.append(style)
      return () => style.remove()
    }, 'Sidebar updater styles')
    ctx.effect(() => installChangesMotion(document), 'Sidebar file-change selection motion')
    ctx.effect(() => ctx.slots.inject('settings.section', () => installSettingsPage(ctx.slots, SidebarSettingsPage, namespace)), 'Local sidebar settings presentation')
    ctx.effect(() => {
      const unsubscribe = ctx.remote.$on('plugin-manager/changed', () => { void reload('read') })
      return () => { disposed = true; unsubscribe(); listeners.clear() }
    }, 'Sidebar updater view lifetime')
}
