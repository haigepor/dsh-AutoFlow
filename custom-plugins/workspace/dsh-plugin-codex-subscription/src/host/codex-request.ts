/** Codex stateless request compatibility, derived from Magpie codex_request.go at e056779a. */
import { createHash } from 'node:crypto'
import { release } from 'node:os'
import { z } from 'zod'

const record = z.record(z.string(), z.unknown())
const callTypes = new Set(['function_call', 'function_call_output', 'local_shell_call', 'local_shell_call_output', 'custom_tool_call', 'custom_tool_call_output', 'tool_search_call', 'tool_search_output'])
const outputTypes = new Map([['function_call', 'function_call_output'], ['custom_tool_call', 'custom_tool_call_output'], ['local_shell_call', 'local_shell_call_output']])

function inputItems(input: unknown[]): unknown[] {
  const calls = new Map<string, string>()
  const normalized = input.map(raw => {
    const parsed = record.safeParse(raw)
    if (!parsed.success) return raw
    const item = parsed.data
    if (typeof item.type !== 'string') return item
    if (callTypes.has(item.type) && typeof item.call_id === 'string' && Buffer.byteLength(item.call_id) > 64) {
      item.call_id = createHash('sha256').update(item.call_id.trim()).digest('hex')
    }
    const output = outputTypes.get(item.type)
    if (output !== undefined && typeof item.call_id === 'string') calls.set(item.call_id.trim(), output)
    return item
  })
  return normalized.flatMap(raw => {
    const parsed = record.safeParse(raw)
    if (!parsed.success) return [raw]
    const item = parsed.data, type = item.type
    if (type === 'item_reference') return []
    // 原生独立通知没有 call_id，其 id/name 不能当成失配的历史工具结果删掉。
    if ((type === 'function_call_output' || type === 'custom_tool_call_output') && (item.call_id === undefined || item.call_id === '')) return [item]
    delete item.id
    if (type === undefined || type === 'message' || type === 'reasoning') delete item.status
    if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'local_shell_call_output') {
      const id = typeof item.call_id === 'string' ? item.call_id.trim() : ''
      const paired = calls.get(id)
      if (paired !== type && !(type === 'function_call_output' && paired === 'local_shell_call_output')) {
        const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output) ?? ''
        return [{ type: 'message', role: 'assistant', content: `[Previous ${typeof item.name === 'string' ? item.name : 'tool'} result; call_id=${id || 'unknown'}]: ${output.slice(0, 16000)}${output.length > 16000 ? '\n...[truncated]' : ''}` }]
      }
    }
    if (item.role === 'system' && (type === undefined || type === 'message')) item.role = 'developer'
    return [item]
  })
}

function cacheKey(instructions: unknown, input: unknown[]): string | undefined {
  const hash = createHash('sha256').update(typeof instructions === 'string' ? instructions : '')
  for (const raw of input) {
    hash.update(JSON.stringify(raw))
    const parsed = record.safeParse(raw)
    if (parsed.success && parsed.data.role === 'user') {
      const digest = hash.digest('hex')
      return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`
    }
  }
  return undefined
}

function declaresSearch(tools: unknown[]): boolean {
  return tools.some(raw => {
    const parsed = record.safeParse(raw)
    if (!parsed.success) return false
    const tool = parsed.data
    return typeof tool.type === 'string' && tool.type.startsWith('web_search') || tool.type === 'function' && tool.name === 'web.run'
      || tool.type === 'namespace' && tool.name === 'web' && Array.isArray(tool.tools) && tool.tools.some(raw => {
        const fn = record.safeParse(raw)
        return fn.success && fn.data.type === 'function' && fn.data.name === 'run'
      })
  })
}

function declareSearch(body: Record<string, unknown>, input: unknown[]): void {
  const tools = Array.isArray(body.tools) ? body.tools : []
  const additional = input.flatMap(raw => {
    const parsed = record.safeParse(raw)
    return parsed.success && parsed.data.type === 'additional_tools' ? [parsed.data] : []
  })
  if (declaresSearch(tools) || additional.some(item => Array.isArray(item.tools) && declaresSearch(item.tools))) return
  if (!input.some(raw => { const parsed = record.safeParse(raw); return parsed.success && parsed.data.type === 'web_search_call' })) return
  const offered = tools.length > 0 || additional.some(item => Array.isArray(item.tools) && item.tools.length > 0)
  const search = { type: 'web_search', external_web_access: false }
  const reasoning = record.safeParse(body.reasoning)
  if (additional[0] !== undefined) {
    const item = additional[0]
    item.tools = [...(Array.isArray(item.tools) ? item.tools : []), search]
    let replaced = false
    body.input = input.map(raw => { const parsed = record.safeParse(raw); if (!replaced && parsed.success && parsed.data.type === 'additional_tools') { replaced = true; return item }; return raw })
  } else if (reasoning.success && reasoning.data.context === 'all_turns') body.input = [{ type: 'additional_tools', role: 'developer', tools: [search] }, ...input]
  else body.tools = [...tools, search]
  if (!offered && (body.tool_choice === undefined || body.tool_choice === '' || body.tool_choice === 'auto' || body.tool_choice === 'none')) body.tool_choice = 'none'
}

/** Normalize a detached Responses body while preserving caller-owned instructions and tool choice.
 * @param value JSON-compatible provider payload; non-object values are rejected.
 * @returns A stateless streaming Codex request with bounded call IDs and stable cache identity.
 */
export function adaptCodexBody(value: unknown): Record<string, unknown> {
  const body = structuredClone(record.parse(value))
  for (const key of ['max_output_tokens', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'logprobs', 'top_logprobs', 'stream_options', 'truncation', 'user', 'safety_identifier', 'prompt_cache_options']) delete body[key]
  if (body.service_tier !== 'priority' && body.service_tier !== 'ultrafast') delete body.service_tier
  const input = inputItems(typeof body.input === 'string' ? [{ role: 'user', content: [{ type: 'input_text', text: body.input }] }] : Array.isArray(body.input) ? body.input : [])
  body.input = input
  body.instructions ??= ''
  if (typeof body.prompt_cache_key !== 'string' || body.prompt_cache_key === '') {
    const key = cacheKey(body.instructions, input)
    if (key !== undefined) body.prompt_cache_key = key
  }
  body.store = false; body.stream = true
  body.tool_choice ??= 'auto'; body.parallel_tool_calls ??= true; body.text ??= { verbosity: 'medium' }
  const reasoning = record.safeParse(body.reasoning)
  if (reasoning.success) {
    if (reasoning.data.effort === 'ultra') reasoning.data.effort = 'max'
    if (reasoning.data.effort !== 'none') reasoning.data.summary ??= 'auto'
    body.reasoning = reasoning.data
  }
  if (reasoning.success && reasoning.data.effort === 'none') {
    const include = Array.isArray(body.include) ? body.include.filter(item => item !== 'reasoning.encrypted_content') : []
    if (include.length === 0) delete body.include
    else body.include = include
  }
  else {
    const include = Array.isArray(body.include) ? body.include : []
    body.include = include.includes('reasoning.encrypted_content') ? include : [...include, 'reasoning.encrypted_content']
  }
  declareSearch(body, input)
  return body
}

/** Format the Codex CLI identity using this process's real OS and architecture.
 * @param version Configured Codex compatibility version.
 * @returns A Codex User-Agent with platform information.
 */
export function codexUserAgent(version: string): string {
  const os = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'Mac OS' : 'Linux'
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch
  const terminal = process.platform === 'win32' ? 'WindowsTerminal' : process.platform === 'darwin' ? 'Apple_Terminal' : 'xterm-256color'
  return `codex_cli_rs/${version} (${os} ${release()}; ${arch}) ${terminal}`
}

/** Set the cache identity in both current Codex headers and remove obsolete underscore names.
 * @param headers Mutable outgoing headers.
 * @param sessionId Explicit or derived conversation cache key; omitted retains current hyphenated headers.
 */
export function codexSessionHeaders(headers: Headers, sessionId?: string): void {
  headers.delete('session_id'); headers.delete('conversation_id')
  if (sessionId !== undefined && sessionId !== '') { headers.set('session-id', sessionId); headers.set('thread-id', sessionId) }
}
