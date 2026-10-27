/** Redacted MCP settings records and editable connection fields. */
import type { PluginEntryId } from '@deepseek-ai/dsh-host-plugin-inventory/types'
import type { McpConnectionSnapshot } from '@deepseek-ai/dsh-mcp-client/types'

/** Editable MCP configuration; null secret values retain the saved value with that key. */
export interface McpServerDraft {
  serverName: string
  transport: 'stdio' | 'streamable-http'
  command: string
  args: string[]
  cwd: string
  url: string
  env: Record<string, string | null>
  headers: Record<string, string | null>
  toolCallTimeoutMs: number
  reconnect: { enabled: boolean; initialDelayMs: number; maxDelayMs: number; maxAttempts: number }
  /** Editor-changed fields; omitted by non-UI callers that compare against resolved values. */
  editedFields?: string[]
}

/** Redacted management row, including saved enablement and observed readiness. */
export interface McpServerRow {
  id: PluginEntryId
  revision: string
  serverName: string
  transport: 'stdio' | 'streamable-http'
  enabled: boolean
  phase: McpConnectionSnapshot['phase'] | 'disabled'
  tools: string[]
  readOnly: boolean
}

/** One server's redacted editor values and live status. */
export interface McpServerDetail extends McpServerRow {
  config: McpServerDraft
}

/** Server list and new-entry defaults derived from the MCP client's configuration schema. */
export interface McpServerList {
  servers: McpServerRow[]
  defaults: McpServerDraft
}

/** Expected management rejection; diagnostics never contain server secrets. */
export type McpSettingsErrorCode = 'invalid-config' | 'duplicate-name' | 'conflict' | 'read-only' | 'not-found' | 'apply-failed'

/** Persistence outcome independent of connection readiness. */
export type McpWriteResult =
  | { status: 'saved'; application: 'applied' | 'restart-required'; server: McpServerRow }
  | { status: 'rejected'; code: McpSettingsErrorCode }

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * MCP configuration or connection readiness changed; readers refetch redacted values.
     * @mode emit
     */
    'mcp-settings/changed'(): void
  }
}
