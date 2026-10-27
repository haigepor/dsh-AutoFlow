/** Slot-derived MCP settings inputs and the feature's resource protocols. */
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { McpServerDetail, McpServerDraft, McpServerList, McpServerRow } from '../types.ts'
import type { createMcpSettingsStore } from './store.ts'
import type { McpLocaleKey } from './locales.ts'
import type { McpJsonSnapshot, McpJsonSaveResult } from './configuration-json.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.mcp': McpLocaleKey }
  interface ResourceProtocolMap {
    'mcp-servers': McpServerList
    'mcp-server': McpServerDetail
    'mcp-configuration': McpJsonSnapshot
  }
}

/** Registration-owned callbacks; components never receive Host or Remote services. */
export interface McpSettingsInjected {
  refresh: () => void
  create: (draft: McpServerDraft, enabled: boolean) => Promise<boolean>
  update: (id: McpServerRow['id'], draft: McpServerDraft, revision: string) => Promise<boolean>
  setEnabled: (id: McpServerRow['id'], enabled: boolean) => Promise<boolean>
  restartServer: (id: McpServerRow['id']) => Promise<boolean>
  restartApplication: () => Promise<void>
  saveJson: (source: string, snapshot: McpJsonSnapshot) => Promise<McpJsonSaveResult>
}

/** Settings section props supplied by its registered stores and locale. */
export type McpSettingsProps = PropsRuntime<'settings.section'> & PropsStore<ReturnType<typeof createMcpSettingsStore>>
  & PropsLocale<'settings.mcp'> & InjectFace<McpSettingsInjected>

/** Application-wide feedback uses the same store without a Settings owner share. */
export type McpFeedbackProps = PropsStore<ReturnType<typeof createMcpSettingsStore>> & PropsLocale<'settings.mcp'> & InjectFace<McpSettingsInjected>
