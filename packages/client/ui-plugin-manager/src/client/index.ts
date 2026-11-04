/**
 * Plugin manager, browser half: the **Plugins** entry of the sidebar and the
 * management page it opens in the main column. The page installs, enables,
 * disables, and removes the bundles of the Host's profile through the
 * `pluginManager` Remote and switches their rows in the profile's user layer.
 * A plugin that carries its own configuration renders it on this page through
 * the slots the page declares (`slot-contract.ts`).
 */
import type {} from '@deepseek-ai/dsh-client-product-analytics/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the root `main` keyed slot the page registers into, declared by
// ui-layout with the panel id brand, and the `sidebar.panellist` list the
// entry registers into, declared by ui-sidebar.
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remoteAccess Context merge.
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the forwarded events' own declaration (`$on`'s key face resolves
// through the owning package's client-safe types subpath).
import type {} from '@deepseek-ai/dsh-plugin-manager/types'
import { PluginManagerPage } from './PluginManagerPage.tsx'
import { createPluginHeaderRef } from './header-scroll.ts'
import { PluginRefreshToast, type PluginRefreshToastFace } from './PluginRefreshToast.tsx'
import { PluginsPanelIcon } from './PluginsPanelIcon.tsx'
import { configLedgerSource } from './config-ledger.ts'
import { tabLedgerSource } from './tab-ledger.ts'
import { PluginManagerController } from './manager-store.ts'
import { PluginUpdateRestartModal, type PluginUpdateRestartFace } from './PluginUpdateRestartModal.tsx'
import { waitForUpdatedWebHost, waitForAutomaticPluginRestart } from './update-restart.ts'
import { en, ja, es, fr, de, ru, pt, zh, type PluginManagerLocaleKey } from './locales.ts'
import { createNavigationStore } from './navigation-store.ts'
import type {} from './slot-contract.ts'
import { pluginMentionSource } from './plugin-mention.ts'
import { PluginReference, pluginReferenceRule } from './PluginReference.tsx'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Read-only management activity, independent of the visible Plugins page. */
    pluginChanges: {
      /**
       * Observe whether a bundle or one of its rows is being changed.
       * @param packageName Bundle package name.
       * @returns A snapshot source whose subscriptions belong to the caller.
       */
      bundle(packageName: string): HostObservable<boolean>
    }

    /** Cross-plugin navigation to the Plugins panel. */
    pluginNavigation: {
      /**
       * Open a bundle's details without changing the current Session.
       * An absent bundle displays the plugin list after loading.
       * @param packageName - npm package name of the bundle.
       */
      openBundle(packageName: string): void
      /**
       * Show the shared save-work and restart dialog after an independent update.
       * @param packageName - Updated npm bundle awaiting application restart.
       */
      showUpdateRestart(packageName: string): void
      /** Open the Plugins main list without opening a dialog or changing the current Session. */
      openList(): void
    }
  }
}

export type { PluginManagerPageProps } from './PluginManagerPage.tsx'
export type { ConfigLedger, OfficialItem } from './config-ledger.ts'
export type { PluginManagerFace } from './manager-store.ts'
export type { PluginManagerLocaleKey } from './locales.ts'
export type {
  ConfigPageForm, PluginActivationOwnerProps, PluginAddActionsProps, PluginTabInstall, PluginTabProps,
  PluginConfigViewProps, PluginDetailProps, PluginPackageRef, PluginRowRef, PluginsSubject,
} from './slot-contract.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Plugin manager tab copy. */
    'pluginManager': PluginManagerLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'pluginManager'

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'plugins' as MainPanelId

/** Services required by the sidebar registration and the Remote methods; the inventory says whether the Host manages a profile. */
export const inject = ['slots', 'locale', 'remote', 'remote.pluginManager', 'remote.pluginInventory', 'remote.pluginRegistryProbe', 'configForms', 'layout', 'uiWorkspace', 'sessions', 'conversation', 'inputTriggers', 'remoteAccess']

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A plugin reference was selected.
     * @mode parallel
     * @param selection Selected plugin and Session.
     */
    'plugin/reference-picked'(selection: { sessionId: import('@deepseek-ai/dsh-session/types').SessionId; name: string }): void
    /** Prepare a plugin reference before sending it.
     * @mode parallel
     * @param selection Plugin, Session and submission lifetime.
     */
    'plugin/reference-prepare'(selection: { sessionId: import('@deepseek-ai/dsh-session/types').SessionId; name: string; signal: AbortSignal }): Promise<void> | void
  }
}

/**
 * Contribute the Plugins entry to the sidebar with the management page it
 * opens, and keep it current on the Host's change events, while the current
 * Peer may list the installed bundles.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.inject(['uiConversation'], (scope) => { scope.uiConversation.userText.register(pluginReferenceRule) })
  ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
    name: 'conversation.user.text.node', key: 'plugin', priority: 100,
  }, PluginReference))
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-plugin-manager: dictionaries')
  const t = ctx.locale.bind(NS)
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  const mentionSource = pluginMentionSource(async () => {
    const result = await ctx.remote.pluginManager.listBundles()
    if (!result.ok) throw result.error
    return result.value
  }, value => ctx.locale.resolveText(value), t, {
    picked: (session, name) => { ctx.emit('plugin/reference-picked', { sessionId: session.sessionId, name }) },
    prepare: async (session, name, signal) => { await ctx.parallel('plugin/reference-prepare', { sessionId: session.sessionId, name, signal }) },
  })
  ctx.effect(() => inputTriggers.registerSource(mentionSource), 'ui-plugin-manager: @ bundles')
  const controller = new PluginManagerController(ctx)
  ctx.effect(() => () => { controller.dispose() }, 'ui-plugin-manager: controller')
  ctx.provide('pluginChanges', { bundle: packageName => controller.observeChanges(packageName) })
  // The page is a global panel: it belongs to the profile, not to a Session,
  // and the sidebar's entry selects it. What is installed and switched on is
  // the page's own; a plugin's configuration arrives through the slots the
  // page declares here, so the page never names a configurable plugin.
  const configLedger = configLedgerSource(ctx)
  const face = controller.inject(configLedger, tabLedgerSource(ctx), text => ctx.locale.resolveText(text))
  ctx.remoteAccess.whenAccess('pluginManager/listBundles', function* () {
    // The Host says when what is installed, enabled, or composed changed — from
    // this page, the CLI, or another browser — and streams install output.
    // A page never rendered holds no snapshot to refresh.
    const refresh = (): void => {
      mentionSource.invalidateInventory()
      inputTriggers.invalidateCandidates(mentionSource)
      // A profile change can replace a bundle's files, and a restarted Host is read afresh.
      controller.details.reset()
      if (controller.getSnapshot().status !== 'idle') void controller.load()
    }
    // Host changes made while access was withdrawn reached no subscription below.
    refresh()
    yield ctx.remote.$on('plugin-manager/changed', refresh)
    yield ctx.remote.$on('plugin-manager/bundle-update', (update) => { controller.bundleUpdateProgress(update) })
    yield ctx.remote.$on('plugin-manager/install-log', (chunk) => { controller.appendLog(chunk) })
    yield ctx.remote.$on('plugin-manager/install-state', (progress) => { controller.installProgress(progress) })
    yield ctx.remote.$on('plugin-manager/update-state', (progress) => { controller.updateProgress(progress) })
    yield ctx.on('connection/reset', refresh)
    yield ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: 'plugin-manager.refresh-toast', locale: NS,
      inject: (): PluginRefreshToastFace => ({
        hooks: { pluginManager: face.hooks.pluginManager },
        dismissNotice: face.dismissNotice,
      }),
    }, PluginRefreshToast))
    yield ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: 'plugin-manager.update-restart', locale: NS,
      inject: (): PluginUpdateRestartFace => ({
        hooks: { pluginManager: face.hooks.pluginManager }, ensure: face.ensure,
        dismissUpdateRestart: face.dismissUpdateRestart,
        resolveText: face.resolveText,
        restart: async (signal, waiting) => {
          const desktop = (globalThis as { dshDesktop?: { lifecycle?: { restartAfterPluginUpdate(): Promise<boolean> } } }).dshDesktop
          if (desktop?.lifecycle !== undefined) return waitForAutomaticPluginRestart(() => desktop.lifecycle!.restartAfterPluginUpdate(), signal, waiting)
          const status = await ctx.remote.pluginManager.restartStatus()
          if (!status.ok) throw new Error(status.error.message)
          await waitForUpdatedWebHost(status.value, () => waitForAutomaticPluginRestart(async () => {
            const result = await ctx.remote.pluginManager.restartAfterUpdate(status.value.generation)
            if (!result.ok) throw new Error(result.error.message)
            return result.value
          }, signal, waiting), signal)
          signal.throwIfAborted()
          window.location.reload()
          return true
        },
      }),
    }, PluginUpdateRestartModal))
    yield ctx.slots.inject('main', function* () {
      const handle = createNavigationStore(), instance = handle.create()
      const store: typeof handle = { ...handle, create: () => instance }
      yield ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        store,
        inject: () => ({ ...face, createHeaderRef: createPluginHeaderRef }),
        children: {
          'plugins.add.actions': { kind: 'list', scope: 'root' },
          'plugins.tab': { kind: 'list', scope: 'root' },
          'plugins.item': { kind: 'list', scope: 'root' },
          'plugins.bundle.activation': { kind: 'keyed', scope: 'root' },
          'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
          'plugins.row.config': { kind: 'keyed', scope: 'root' },
          'plugins.detail.actions': { kind: 'list', scope: 'root' },
          'plugins.detail.badge': { kind: 'list', scope: 'root' },
          'plugins.detail.updates': { kind: 'list', scope: 'root' },
          'plugins.detail.section': { kind: 'list', scope: 'root' },
        },
      }, PluginManagerPage)
      yield ctx.layout.panelInfo.subscribe(() => {
        if (ctx.layout.panelInfo.getSnapshot().activePanelId !== PANEL_ID) instance.actions.setView({ kind: 'list' })
      })
      const disposeNavigation = ctx.reflect.provide('pluginNavigation', {
        openList: () => {
          ctx.layout.selectPanel(PANEL_ID)
          instance.actions.setTab('installed')
          instance.actions.setView({ kind: 'list' })
        },
        showUpdateRestart: face.showUpdateRestart,
        openBundle: (packageName: string) => {
          ctx.layout.selectPanel(PANEL_ID)
          instance.actions.setTab('installed')
          instance.actions.setView({ kind: 'package', name: packageName })
        },
      })
      yield () => { void disposeNavigation() }
    })
    yield ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 0,
      label: () => t('panel'),
      locale: NS,
    }, PluginsPanelIcon))
  })
}
