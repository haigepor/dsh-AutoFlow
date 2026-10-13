import type { SidebarPrefs, SidebarSettingsClient } from '../../../src/client/prefs.ts'
import type { SidebarStore } from '../../../src/client/state.ts'

/** View of queued writes and acknowledged sidebar settings. */
export interface PreferenceView {
  prefs: SidebarPrefs
  ready: boolean
  loading: boolean
  pending: number
  error: string | null
}
/** Serialize intent patches; a rejected write resolves false and retains later independent edits. */
export function createPreferences(api: SidebarSettingsClient, store: SidebarStore, parse: (value: unknown) => SidebarPrefs, notify: (view: PreferenceView) => void): {
  snapshot(): PreferenceView
  load(): Promise<void>
  write(patch: (prefs: SidebarPrefs) => Partial<SidebarPrefs>): Promise<boolean>
  dispose(): void
}
