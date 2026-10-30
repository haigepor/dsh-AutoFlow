/** Application-wide operation feedback survives leaving the settings page. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SkillsLocaleKey } from './locales.ts'
interface State {
  busy: boolean
  seq: number
  notice: { key: SkillsLocaleKey; success: boolean; seq: number } | null
}
type Actions = {
  busy(state: State, value: boolean): void
  announce(state: State, key: SkillsLocaleKey, success: boolean): void
  dismiss(state: State): void
}
/** Create registration-owned operation state.
 *
 * @returns root store declaration shared by the page and overlay.

 */
export function createSkillSettingsStore(): EngineStoreHandle<State, Actions> {
  return defineStore({
    init: () => ({
      busy: false,
      seq: 0,
      notice: null as { key: SkillsLocaleKey; success: boolean; seq: number } | null,
    }),
    actions: {
      busy(state, value: boolean) {
        state.busy = value
      },
      announce(state, key: SkillsLocaleKey, success: boolean) {
        state.notice = { key, success, seq: ++state.seq }
      },
      dismiss(state) {
        state.notice = null
      },
    },
  })
}
