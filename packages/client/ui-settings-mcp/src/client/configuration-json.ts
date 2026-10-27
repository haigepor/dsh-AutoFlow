/** MCP JSON import converts common server declarations to existing management operations. */
import type { McpServerDetail, McpServerDraft, McpSettingsErrorCode } from '../types.ts'

/** One redacted configuration revision read for the JSON editor. */
export interface McpJsonSnapshot {
  servers: McpServerDetail[]
  defaults: McpServerDraft
}

/** One validated merge operation; missing servers are retained. */
export interface McpJsonChange {
  previous?: McpServerDetail
  draft: McpServerDraft
  enabled: boolean
}

/** A parse failure safe to display without the source text or credentials. */
export class McpJsonError extends Error {
  constructor(readonly code: 'invalid-json' | McpSettingsErrorCode) { super(code) }
}

/** JSON save reports partial progress without claiming a transaction across servers. */
export type McpJsonSaveResult = { ok: true } | { ok: false; error: 'invalid-json' | McpSettingsErrorCode; partial: boolean }

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new McpJsonError('invalid-config')
  return value as Record<string, unknown>
}

function secretMap(value: unknown): Record<string, string | null> {
  if (value === undefined) return {}
  const entries = Object.entries(object(value)).sort(([a], [b]) => a.localeCompare(b))
  if (entries.some(([, item]) => item !== null && typeof item !== 'string')) throw new McpJsonError('invalid-config')
  return Object.fromEntries(entries) as Record<string, string | null>
}

function declaration(config: McpServerDraft, enabled: boolean): Record<string, unknown> {
  return {
    transport: config.transport,
    ...config.transport === 'stdio'
      ? { command: config.command, args: config.args, cwd: config.cwd, env: secretMap(config.env) }
      : { url: config.url, headers: secretMap(config.headers) },
    toolCallTimeoutMs: config.toolCallTimeoutMs, reconnect: config.reconnect, disabled: !enabled,
  }
}

/**
 * Serialize current declarations without revealing saved credentials.
 * @param snapshot - redacted current declarations.
 * @returns editable JSON with explicit secret keep markers.
 */
export function configurationJson(snapshot: McpJsonSnapshot): string {
  return JSON.stringify({ mcpServers: Object.fromEntries(snapshot.servers.map(server =>
    [server.config.serverName, declaration(server.config, server.enabled)])) }, null, 2)
}

/**
 * Validate all import entries before starting writes; omitted existing servers are retained.
 * @param source - an object containing the common mcpServers map.
 * @param snapshot - editor-open revisions and schema-derived defaults.
 * @returns changed/new declarations; protocol and runtime validation remain with the Host.
 */
export function parseConfigurationJson(source: string, snapshot: McpJsonSnapshot): McpJsonChange[] {
  let parsed: unknown
  try { parsed = JSON.parse(source) } catch (_invalidJson) { throw new McpJsonError('invalid-json') }
  const root = object(parsed)
  if (Object.keys(root).some(key => key !== 'mcpServers')) throw new McpJsonError('invalid-config')
  const changes: McpJsonChange[] = []
  for (const [serverName, raw] of Object.entries(object(root.mcpServers))) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) throw new McpJsonError('invalid-config')
    const row = object(raw)
    const allowed = ['transport', 'type', 'command', 'args', 'cwd', 'env', 'url', 'headers', 'toolCallTimeoutMs', 'reconnect', 'disabled']
    if (Object.keys(row).some(key => !allowed.includes(key))) throw new McpJsonError('invalid-config')
    const previous = snapshot.servers.find(server => server.config.serverName === serverName)
    const transport = row.transport ?? row.type ?? (row.url === undefined ? 'stdio' : 'streamable-http')
    if (typeof transport !== 'string' || !['stdio', 'http', 'streamable-http'].includes(transport)) throw new McpJsonError('invalid-config')
    const draft: McpServerDraft = { ...structuredClone(snapshot.defaults), serverName,
      transport: transport === 'stdio' ? 'stdio' : 'streamable-http', env: secretMap(row.env), headers: secretMap(row.headers) }
    for (const key of ['command', 'cwd', 'url'] as const) {
      if (row[key] !== undefined && typeof row[key] !== 'string') throw new McpJsonError('invalid-config')
      if (typeof row[key] === 'string') draft[key] = row[key]
    }
    if (row.args !== undefined) {
      if (!Array.isArray(row.args) || row.args.some(item => typeof item !== 'string')) throw new McpJsonError('invalid-config')
      draft.args = row.args as string[]
    }
    if (row.toolCallTimeoutMs !== undefined) {
      if (typeof row.toolCallTimeoutMs !== 'number') throw new McpJsonError('invalid-config')
      draft.toolCallTimeoutMs = row.toolCallTimeoutMs
    }
    if (!Number.isFinite(draft.toolCallTimeoutMs) || draft.toolCallTimeoutMs <= 0 || draft.toolCallTimeoutMs > 2147483647) {
      throw new McpJsonError('invalid-config')
    }
    if (row.reconnect !== undefined) {
      const reconnect = object(row.reconnect)
      if (Object.keys(reconnect).some(key => !['enabled', 'initialDelayMs', 'maxDelayMs', 'maxAttempts'].includes(key))) {
        throw new McpJsonError('invalid-config')
      }
      if (reconnect.enabled !== undefined && typeof reconnect.enabled !== 'boolean') throw new McpJsonError('invalid-config')
      if (typeof reconnect.enabled === 'boolean') draft.reconnect.enabled = reconnect.enabled
      for (const key of ['initialDelayMs', 'maxDelayMs', 'maxAttempts'] as const) {
        const value = reconnect[key]
        if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) throw new McpJsonError('invalid-config')
        if (typeof value === 'number') draft.reconnect[key] = value
      }
    }
    if (!Number.isInteger(draft.reconnect.maxAttempts) || draft.reconnect.initialDelayMs > draft.reconnect.maxDelayMs
      || draft.reconnect.maxDelayMs > 2147483647) throw new McpJsonError('invalid-config')
    if (draft.transport === 'stdio') {
      if (draft.command.trim() === '') throw new McpJsonError('invalid-config')
      if (Object.entries(draft.env).some(([key, value]) => !key || /[=\0]/.test(key) || value?.includes('\0'))) {
        throw new McpJsonError('invalid-config')
      }
    } else {
      try {
        const url = new URL(draft.url)
        if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') throw new McpJsonError('invalid-config')
      } catch (_invalidUrl) { throw new McpJsonError('invalid-config') }
      if (Object.entries(draft.headers).some(([key, value]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n\0]/.test(value ?? ''))) {
        throw new McpJsonError('invalid-config')
      }
    }
    if (row.disabled !== undefined && typeof row.disabled !== 'boolean') throw new McpJsonError('invalid-config')
    const enabled = row.disabled !== true
    if (previous !== undefined
      && JSON.stringify(declaration(draft, enabled)) === JSON.stringify(declaration(previous.config, previous.enabled))) continue
    if (previous?.readOnly === true) throw new McpJsonError('read-only')
    const secrets = draft.transport === 'stdio' ? draft.env : draft.headers
    const oldSecrets = draft.transport === 'stdio' ? previous?.config.env : previous?.config.headers
    if (Object.entries(secrets).some(([key, value]) => value === null && !Object.hasOwn(oldSecrets ?? {}, key))) {
      throw new McpJsonError('invalid-config')
    }
    if (previous !== undefined) {
      draft.editedFields = (['serverName', 'transport', 'command', 'args', 'cwd', 'url', 'toolCallTimeoutMs', 'reconnect'] as const)
        .filter(key => JSON.stringify(draft[key]) !== JSON.stringify(previous.config[key]))
    }
    changes.push({ ...previous === undefined ? {} : { previous }, draft, enabled })
  }
  return changes
}
