/** MCP settings registration, live resources, and registration-owned management operations. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { McpWriteResult } from '../types.ts'
import type { McpSettingsInjected } from './contract.ts'
import { createMcpSettingsStore } from './store.ts'
import { McpSettings } from './McpSettings.tsx'
import { McpFeedback } from './McpFeedback.tsx'
import { waitForConfigurationRestart } from './restart.ts'
import { en, zh, type McpLocaleKey } from './locales.ts'
import { McpJsonError, parseConfigurationJson, type McpJsonSnapshot } from './configuration-json.ts'

/** Services supplying the settings extension, live data and generated management namespaces. */
export const inject = ['slots', 'locale', 'resources', 'remote', 'remote.mcpSettings', 'remote.pluginManager']

/** @param ctx - browser plugin context. @returns after registration; all owned listeners and requests are disposed with the plugin. */
export function apply(ctx: Context): void {
  const NS = 'settings.mcp'
  const store = createMcpSettingsStore()
  const refreshers = new Set<() => void>()
  const refresh = (): void => { for (const listener of refreshers) listener() }
  let writing = false
  let restarting: AbortController | undefined
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mcp-settings: dictionaries')
  ctx.effect(() => () => { restarting?.abort() }, 'mcp-settings: restart lifetime')

  async function* frames<T>(read: () => Promise<RemoteResult<T>>, signal: AbortSignal): AsyncGenerator<RemoteResult<T>> {
    let version = 0
    let wake: (() => void) | undefined
    const changed = (): void => { version++; wake?.() }
    const off = ctx.remote.$on('mcp-settings/changed', changed)
    refreshers.add(changed)
    signal.addEventListener('abort', changed, { once: true })
    try {
      while (!signal.aborted) {
        const observed = version
        yield await read()
        if (observed === version) await new Promise<void>((resolve) => {
          wake = resolve
          if (signal.aborted || observed !== version) resolve()
        })
        wake = undefined
      }
    } finally {
      off(); refreshers.delete(changed); signal.removeEventListener('abort', changed)
    }
  }
  ctx.effect(() => ctx.resources.register<'mcp-servers'>({
    protocol: 'mcp-servers', open: (_address, { signal }) => frames(() => ctx.remote.mcpSettings.list(), signal),
  }), 'mcp-settings: server list resource')
  ctx.effect(() => ctx.resources.register<'mcp-server'>({
    protocol: 'mcp-server', open: (address, { signal }) => {
      const id = decodeURIComponent(new URL(address).pathname.slice(1)) as Parameters<typeof ctx.remote.mcpSettings.detail>[0]
      return frames(() => ctx.remote.mcpSettings.detail(id), signal)
    },
  }), 'mcp-settings: server detail resource')
  ctx.effect(() => ctx.resources.register<'mcp-configuration'>({
    protocol: 'mcp-configuration', open: (_address, { signal }) => frames(async (): Promise<RemoteResult<McpJsonSnapshot>> => {
      const list = await ctx.remote.mcpSettings.list()
      if (!list.ok) return list
      const details = await Promise.all(list.value.servers.map(server => ctx.remote.mcpSettings.detail(server.id)))
      for (const detail of details) if (!detail.ok) return detail
      return { ok: true, value: { servers: details.flatMap(detail => detail.ok ? [detail.value] : []), defaults: list.value.defaults } }
    }, signal),
  }), 'mcp-settings: redacted JSON configuration resource')

  const injected = (actions: BoundActions<typeof store>): McpSettingsInjected => {
    const run = async (id: string, operation: () => Promise<RemoteResult<McpWriteResult>>): Promise<boolean> => {
      if (writing) return false
      writing = true; actions.busy(id)
      try {
        const response = await operation()
        if (!response.ok) { actions.announce('error.apply-failed', false); return false }
        const result = response.value
        if (result.status === 'rejected') { actions.announce(`error.${result.code}`, false); return false }
        if (result.application === 'restart-required') {
          actions.requireRestart(); actions.announce('pending', false)
        } else {
          const disconnected = result.server.enabled && result.server.phase !== 'connected'
          actions.announce(disconnected ? 'savedDisconnected' : result.server.enabled ? 'connected' : 'applied', !disconnected)
        }
        return true
      } catch (_operationFailed) {
        actions.announce('error.apply-failed', false)
        return false
      } finally {
        writing = false; actions.busy(null); refresh()
      }
    }
    return {
      refresh,
      create: (draft, enabled) => run('create', () => ctx.remote.mcpSettings.create(draft, enabled)),
      update: (id, draft, revision) => run(id, () => ctx.remote.mcpSettings.update(id, draft, revision)),
      setEnabled: (id, enabled) => run(id, () => ctx.remote.mcpSettings.setEnabled(id, enabled)),
      restartServer: id => run(id, () => ctx.remote.mcpSettings.restart(id)),
      saveJson: async (source, snapshot) => {
        if (writing || restarting !== undefined) return { ok: false, error: 'apply-failed', partial: false }
        let partial = false
        try {
          const changes = parseConfigurationJson(source, snapshot)
          writing = true; actions.busy('json')
          const restartEntries = new Set<string>()
          const connectionStates = new Map<string, boolean>()
          const execute = async (request: Promise<RemoteResult<McpWriteResult>>): Promise<void> => {
            const response = await request
            if (!response.ok) throw new McpJsonError('apply-failed')
            if (response.value.status === 'rejected') throw new McpJsonError(response.value.code)
            partial = true
            connectionStates.set(response.value.server.id, response.value.server.enabled && response.value.server.phase !== 'connected')
            if (response.value.application === 'restart-required') { restartEntries.add(response.value.server.id); actions.requireRestart() }
          }
          for (const change of changes) {
            if (change.previous === undefined) await execute(ctx.remote.mcpSettings.create(change.draft, change.enabled))
            else {
              await execute(ctx.remote.mcpSettings.update(change.previous.id, change.draft, change.previous.revision))
              if (change.previous.enabled !== change.enabled) {
                await execute(ctx.remote.mcpSettings.setEnabled(change.previous.id, change.enabled))
              }
            }
          }
          const disconnected = [...connectionStates.values()].some(Boolean)
          const requiresRestart = restartEntries.size > 0
          actions.announce(requiresRestart ? 'pending' : disconnected ? 'savedDisconnected' : 'applied', !requiresRestart && !disconnected)
          return { ok: true }
        } catch (error) {
          return { ok: false, error: error instanceof McpJsonError ? error.code : 'apply-failed', partial }
        } finally {
          writing = false; actions.busy(null); refresh()
        }
      },
      restartApplication: async () => {
        if (restarting !== undefined || writing) return
        const controller = new AbortController()
        restarting = controller
        actions.restarting(true)
        try {
          const desktop = (globalThis as { dshDesktop?: { lifecycle?: { restartAfterPluginUpdate(): Promise<boolean> } } }).dshDesktop
          if (desktop?.lifecycle !== undefined) {
            if (!await desktop.lifecycle.restartAfterPluginUpdate()) { actions.restarting(false); actions.confirmRestart(false) }
            return
          }
          const status = await ctx.remote.pluginManager.restartStatus()
          if (!status.ok) throw new Error('Restart unavailable')
          await waitForConfigurationRestart(status.value, async () => {
            const result = await ctx.remote.pluginManager.restartForConfiguration(status.value.generation)
            return result.ok ? result.value : undefined
          }, controller.signal)
          controller.signal.throwIfAborted()
          window.location.reload()
        } catch (_restartFailed) {
          if (!controller.signal.aborted) actions.restarting(false, true)
        } finally {
          restarting = undefined
        }
      },
    }
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'mcp', order: 30, locale: NS, label: () => ctx.locale.bind(NS)('nav'), store, inject: injected,
  }, McpSettings))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'mcp-settings.feedback', locale: NS, store, inject: injected,
  }, McpFeedback))
  ctx.inject(['settingsSearch'], (scope) => {
    scope.effect(() => scope.settingsSearch.register(
      { id: 'mcp.servers', sectionId: 'mcp', label: () => ctx.locale.bind(NS)('nav'), target: '[data-mcp-settings]' },
    ), 'mcp-settings: settings search')
  })
}

export type { McpLocaleKey }
