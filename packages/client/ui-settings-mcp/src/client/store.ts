/** Shared operation feedback survives navigation away from MCP settings. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { McpLocaleKey } from './locales.ts'

interface State {
  busy: string | null
  notice: { key: McpLocaleKey; success: boolean; seq: number } | null
  seq: number
  restartRequired: boolean
  restartConfirm: boolean
  restarting: boolean
  restartFailed: boolean
}

type Actions = {
  busy(state: State, id: string | null): void
  announce(state: State, key: McpLocaleKey, success: boolean): void
  dismiss(state: State): void
  requireRestart(state: State): void
  confirmRestart(state: State, open: boolean): void
  restarting(state: State, active: boolean, failed?: boolean): void
}

/**
 * Declare operation feedback shared by the settings section and application overlay.
 * @returns the root-scoped operation store.
 */
export function createMcpSettingsStore(): EngineStoreHandle<State, Actions> {
  return defineStore({
    init: (): State => ({
      busy: null, notice: null, seq: 0, restartRequired: false, restartConfirm: false, restarting: false, restartFailed: false,
    }),
    actions: {
      busy: (state, id: string | null) => { state.busy = id },
      announce: (state, key: McpLocaleKey, success: boolean) => { state.notice = { key, success, seq: ++state.seq } },
      dismiss: (state) => { state.notice = null },
      requireRestart: (state) => { state.restartRequired = true },
      confirmRestart: (state, open: boolean) => { if (!state.restarting) { state.restartConfirm = open; state.restartFailed = false } },
      restarting: (state, active: boolean, failed = false) => { state.restarting = active; state.restartFailed = failed },
    },
  })
}
