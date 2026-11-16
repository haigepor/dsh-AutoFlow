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

/**
 * Per-server runtime status, list views, and the MCP manager's Cordis event.
 * Types only — no runtime code.
 *
 * @module @deepseek-ai/dsh-mcp-manager/types
 */

import type { McpCloseResult, McpConnectionStatus } from '@deepseek-ai/dsh-mcp-client/types'

/**
 * Status of one managed server. Extends the mcp-client connection status with
 * manager-owned conditions: `disabled` when the configured entry requests no
 * live instance, `load` when plugin activation failed, and `cleanup` when an
 * instance or probe could not confirm closure or finish local cleanup.
 * Cleanup results retain any unconfirmed closure and the first diagnostic.
 */
export type McpManagedServerStatus =
  | McpConnectionStatus
  | { state: 'disabled' }
  | { state: 'failed'; reason: 'load'; lastError: string }
  | { state: 'failed'; reason: 'cleanup'; result: McpCloseResult }

/** One managed server as a management surface lists it. */
export interface McpManagedServerView {
  /** The configured `servers` key or registered name; also the instance's `serverName` tool namespace. */
  name: string
  /** Whether a configured or registered entry still exists; false for retained cleanup failures after removal. */
  configured: boolean
  /** Current runtime status. */
  status: McpManagedServerStatus
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One managed server's status transitioned. Emitted for every published
     * change while the manager is live and either the entry is configured or
     * registered, or a runtime record remains. Removed entries may emit cleanup
     * failures; `watch` and `list()` report removals.
     * Lifecycle operations do not wait for listeners. Synchronous throws and
     * returned promise rejections are logged without skipping other listeners.
     * @param name - the configured `servers` key or registered name.
     * @param status - the status now current for that server.
     * @mode parallel
     */
    'mcp-manager/status'(name: string, status: McpManagedServerStatus): void | Promise<void>
  }
}
