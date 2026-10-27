/** Raw configuration edits retain expressions and credentials that the user did not replace. */
import { isDeepStrictEqual } from 'node:util'
import { Config, resolveReconnectPolicy, type Config as McpConfig } from '@deepseek-ai/dsh-mcp-client'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { McpServerDraft, McpSettingsErrorCode } from '../types.ts'

/** Expected, redacted management rejection. */
export class McpSettingsError extends Error {
  constructor(readonly code: McpSettingsErrorCode) { super(code) }
}

/**
 * Validate resolved MCP fields before a profile write.
 * @param value - complete resolved configuration.
 * @returns validated connection options.
 */
export function validateConfig(value: Record<string, unknown>): McpConfig {
  try {
    const config = Config(value as Parameters<typeof Config>[0])
    if (!Number.isFinite(config.toolCallTimeoutMs) || config.toolCallTimeoutMs <= 0 || config.toolCallTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error('timeout')
    resolveReconnectPolicy(config.reconnect, 'reconnect')
    if (config.transport === 'stdio') {
      if (!config.command.trim()) throw new Error('command')
      for (const [key, item] of Object.entries(config.env)) {
        if (!key || /[=\0]/.test(key) || item.includes('\0')) throw new Error('environment')
      }
    } else {
      const url = new URL(config.url)
      // Request 不接受 URL 内嵌凭据；认证值只通过受保护的请求头保存。
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') throw new Error('url')
      for (const [key, item] of Object.entries(config.headers)) {
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n\0]/.test(item)) throw new Error('headers')
      }
    }
    return config
  } catch (_invalidConfig) {
    throw new McpSettingsError('invalid-config')
  }
}

/**
 * Prepare editor fields without returning environment or header secrets.
 * @param config - resolved server options.
 * @returns redacted editor values.
 */
export function draftOf(config: McpConfig): McpServerDraft {
  const hidden = (values: Record<string, string>): Record<string, null> => Object.fromEntries(Object.keys(values).map(key => [key, null]))
  return {
    serverName: config.serverName, transport: config.transport,
    command: config.transport === 'stdio' ? config.command : '',
    args: config.transport === 'stdio' ? [...config.args] : [],
    cwd: config.transport === 'stdio' ? config.cwd : '',
    url: config.transport === 'streamable-http' ? config.url : '',
    env: config.transport === 'stdio' ? hidden(config.env) : {},
    headers: config.transport === 'streamable-http' ? hidden(config.headers) : {},
    toolCallTimeoutMs: config.toolCallTimeoutMs,
    reconnect: { ...resolveReconnectPolicy(config.reconnect, 'reconnect') },
  }
}

/**
 * Build raw YAML fields while retaining unchanged expressions and explicit secret keep markers.
 * @param draft - complete editor values.
 * @param previous - prior raw fields, including unevaluated YAML expressions.
 * @param resolved - prior resolved options for comparison.
 * @returns complete raw configuration for the configuration owner to validate and persist.
 */
export function rawConfig(draft: McpServerDraft, previous: Record<string, unknown> = {}, resolved?: McpConfig): Record<string, unknown> {
  const before = resolved === undefined ? undefined : draftOf(resolved)
  const result: Record<string, unknown> = { ...previous }
  const fields: Array<keyof McpServerDraft> = ['serverName', 'transport', 'toolCallTimeoutMs', 'reconnect']
  fields.push(...draft.transport === 'stdio' ? ['command', 'args', 'cwd'] as const : ['url'] as const)
  for (const field of fields) {
    // 未改动的字段保留原始表达式，避免上下文变化把它意外固化成旧的解析值。
    if (before !== undefined && draft.editedFields !== undefined
      && !draft.editedFields.includes(field) && Object.hasOwn(previous, field)) continue
    if (before !== undefined && Object.hasOwn(previous, field) && isDeepStrictEqual(draft[field], before[field])) continue
    result[field] = draft[field]
  }
  const secretField = draft.transport === 'stdio' ? 'env' : 'headers'
  const oldSecrets = previous[secretField]
  const saved = typeof oldSecrets === 'object' && oldSecrets !== null && !Array.isArray(oldSecrets) ? oldSecrets as Record<string, unknown> : {}
  result[secretField] = Object.fromEntries(Object.entries(draft[secretField]).map(([key, value]) => {
    if (value !== null) return [key, value]
    if (!Object.hasOwn(saved, key)) throw new McpSettingsError('invalid-config')
    return [key, saved[key]]
  }))
  for (const field of draft.transport === 'stdio' ? ['url', 'headers'] : ['command', 'args', 'env', 'cwd']) Reflect.deleteProperty(result, field)
  return result
}
