/** Explicit Chat Completions conversion; raw Responses requests never pass through this codec. */
import { object, RelayError, string } from './http.ts'

function content(value: unknown, role: string): unknown[] {
  if (value === null || value === undefined) return []
  if (typeof value === 'string') return [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: value }]
  if (!Array.isArray(value)) throw new RelayError(400, 'invalid_request', 'message.content must be text or an array.')
  return value.map((item: unknown) => {
    const part = object(item)
    if (part.type === 'text') return { type: role === 'assistant' ? 'output_text' : 'input_text', text: string(part.text, 'text') }
    if (part.type === 'image_url' && role === 'user') {
      const image = object(part.image_url)
      const url = string(image.url, 'image_url.url')
      if (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(url) && !url.startsWith('https://')) throw new RelayError(400, 'invalid_image', 'Image input must use HTTPS or an inline PNG, JPEG, or WebP.')
      return { type: 'input_image', image_url: url, ...(image.detail === undefined ? {} : { detail: image.detail }) }
    }
    throw new RelayError(400, 'unsupported_content', 'This message content type is not supported by the subscription gateway.')
  })
}

/** Convert the supported chat message and tool fields without adding a system prompt.
 * @param request - Untrusted Chat Completions JSON object.
 * @returns a raw Responses request.
 */
export function chatRequest(request: Record<string, unknown>): Record<string, unknown> {
  string(request.model, 'model')
  if (!Array.isArray(request.messages) || request.messages.length === 0) throw new RelayError(400, 'invalid_request', 'messages must be a nonempty array.')
  if (request.n !== undefined && request.n !== 1) throw new RelayError(400, 'unsupported_parameter', 'Only n=1 is supported for chat.')
  for (const key of ['audio', 'modalities', 'prediction', 'logprobs', 'top_logprobs', 'functions', 'function_call']) if (request[key] !== undefined) throw new RelayError(400, 'unsupported_parameter', `${key} is not supported by this gateway.`)
  const input: unknown[] = []
  const instructions: string[] = []
  let conversationStarted = false
  for (const raw of request.messages) {
    const message = object(raw)
    const role = string(message.role, 'message.role')
    if (role === 'system' || role === 'developer') {
      if (typeof message.content !== 'string') throw new RelayError(400, 'invalid_request', 'System and developer messages must contain text.')
      if (conversationStarted) input.push({ role: 'developer', content: [{ type: 'input_text', text: message.content }] })
      else instructions.push(message.content)
    } else if (role === 'tool') {
      conversationStarted = true
      if (typeof message.content !== 'string') throw new RelayError(400, 'invalid_request', 'Tool results must contain text.')
      input.push({ type: 'function_call_output', call_id: string(message.tool_call_id, 'tool_call_id'), output: message.content })
    } else if (role === 'user' || role === 'assistant') {
      conversationStarted = true
      const parts = content(message.content, role)
      if (parts.length > 0) input.push({ role, content: parts })
      if (message.tool_calls !== undefined) {
        if (role !== 'assistant' || !Array.isArray(message.tool_calls)) throw new RelayError(400, 'invalid_request', 'tool_calls must belong to an assistant message.')
        for (const rawCall of message.tool_calls) {
          const call = object(rawCall)
          if (call.type !== 'function') throw new RelayError(400, 'unsupported_tool', 'Only function tools are supported in chat.')
          const fn = object(call.function)
          input.push({ type: 'function_call', call_id: string(call.id, 'tool_call.id'), name: string(fn.name, 'function.name'), arguments: string(fn.arguments, 'function.arguments') })
        }
      }
    } else throw new RelayError(400, 'unsupported_role', 'This chat message role is not supported.')
  }
  const result: Record<string, unknown> = { model: request.model, input, instructions: instructions.join('\n\n'), stream: request.stream === true }
  for (const field of ['parallel_tool_calls', 'reasoning', 'service_tier', 'prompt_cache_key', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p']) if (request[field] !== undefined) result[field] = request[field]
  if (typeof request.reasoning_effort === 'string') result.reasoning = { effort: request.reasoning_effort }
  if (request.tools !== undefined) {
    if (!Array.isArray(request.tools)) throw new RelayError(400, 'invalid_request', 'tools must be an array.')
    result.tools = request.tools.map((raw: unknown) => {
      const tool = object(raw)
      if (tool.type !== 'function') throw new RelayError(400, 'unsupported_tool', 'Only function tools are supported in chat.')
      const fn = object(tool.function)
      return { type: 'function', name: string(fn.name, 'function.name'), ...(fn.description === undefined ? {} : { description: fn.description }), parameters: object(fn.parameters ?? {}), ...(fn.strict === undefined ? {} : { strict: fn.strict }) }
    })
  }
  if (request.tool_choice !== undefined) {
    result.tool_choice = typeof request.tool_choice === 'string' ? request.tool_choice : { type: 'function', name: string(object(object(request.tool_choice).function).name, 'tool_choice.function.name') }
  }
  if (request.response_format !== undefined) {
    const format = object(request.response_format)
    if (format.type === 'json_schema') result.text = { format: { type: 'json_schema', ...object(format.json_schema) } }
    else if (format.type === 'json_object' || format.type === 'text') result.text = { format }
    else throw new RelayError(400, 'unsupported_parameter', 'This response_format is not supported.')
  }
  return result
}

function usage(response: Record<string, unknown>): Record<string, unknown> | undefined {
  if (response.usage === undefined) return undefined
  const source = object(response.usage)
  return { prompt_tokens: source.input_tokens ?? 0, completion_tokens: source.output_tokens ?? 0, total_tokens: source.total_tokens ?? 0, ...(source.input_tokens_details === undefined ? {} : { prompt_tokens_details: source.input_tokens_details }), ...(source.output_tokens_details === undefined ? {} : { completion_tokens_details: source.output_tokens_details }) }
}

/** Project a terminal Responses value into one Chat Completions choice.
 * @param response - Completed upstream response.
 * @returns the chat result, including function calls and token usage.
 */
export function chatResponse(response: Record<string, unknown>): Record<string, unknown> {
  let text = ''
  const tools: unknown[] = []
  if (!Array.isArray(response.output)) throw new RelayError(502, 'invalid_upstream', 'The upstream response has no output array.')
  for (const raw of response.output) {
    const item = object(raw)
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const rawPart of item.content) {
        const part = object(rawPart)
        if (part.type === 'output_text' && typeof part.text === 'string') text += part.text
        else if (part.type === 'refusal' && typeof part.refusal === 'string') text += part.refusal
      }
    } else if (item.type === 'function_call') tools.push({ id: item.call_id ?? item.id, type: 'function', function: { name: item.name, arguments: item.arguments ?? '' } })
  }
  return { id: response.id, object: 'chat.completion', created: typeof response.created_at === 'number' ? response.created_at : Math.floor(Date.now() / 1000), model: response.model, choices: [{ index: 0, message: { role: 'assistant', content: text === '' && tools.length > 0 ? null : text, ...(tools.length === 0 ? {} : { tool_calls: tools }) }, finish_reason: tools.length > 0 ? 'tool_calls' : 'stop' }], ...(usage(response) === undefined ? {} : { usage: usage(response) }) }
}

/** Per-response streaming state; tool indices are compact and stable across interleaved events. */
export class ChatStream {
  #id = ''
  #model = ''
  #created = Math.floor(Date.now() / 1000)
  #started = false
  #text = ''
  readonly #tools = new Map<string, { index: number; callId: string; name: string; arguments: string }>()
  readonly #pendingArguments = new Map<string, string>()

  /** Convert one Responses event to zero or more complete SSE data frames.
   * @param event - Parsed Responses event.
   * @returns complete Chat Completions SSE frames.
   */
  convert(event: Record<string, unknown>): string[] {
    const chunks: string[] = []
    const response = event.response === undefined ? undefined : object(event.response)
    if (response !== undefined) {
      if (typeof response.id === 'string') this.#id = response.id
      if (typeof response.model === 'string') this.#model = response.model
      if (typeof response.created_at === 'number') this.#created = response.created_at
    }
    const chunk = (delta: unknown, finish: string | null = null, usageValue?: unknown): string => `data: ${JSON.stringify({ id: this.#id, object: 'chat.completion.chunk', created: this.#created, model: this.#model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usageValue === undefined ? {} : { usage: usageValue }) })}\n\n`
    const appendArguments = (id: string, complete: string): void => {
      const state = this.#tools.get(id)
      if (state === undefined) { this.#pendingArguments.set(id, complete); return }
      if (!complete.startsWith(state.arguments)) throw new RelayError(502, 'inconsistent_upstream', 'The upstream changed tool arguments after streaming them.')
      const suffix = complete.slice(state.arguments.length)
      if (suffix !== '') chunks.push(chunk({ tool_calls: [{ index: state.index, function: { arguments: suffix } }] }))
      state.arguments = complete
    }
    const tool = (item: Record<string, unknown>): void => {
      const id = string(item.id, 'item.id')
      const callId = string(item.call_id ?? item.id, 'item.call_id')
      const name = string(item.name, 'item.name')
      const existing = this.#tools.get(id)
      if (existing === undefined) {
        const index = this.#tools.size
        this.#tools.set(id, { index, callId, name, arguments: '' })
        chunks.push(chunk({ tool_calls: [{ index, id: callId, type: 'function', function: { name, arguments: '' } }] }))
      } else if (existing.callId !== callId || existing.name !== name) throw new RelayError(502, 'inconsistent_upstream', 'The upstream changed a streamed tool identity.')
      if (typeof item.arguments === 'string') appendArguments(id, item.arguments)
      const pending = this.#pendingArguments.get(id)
      if (pending !== undefined) { appendArguments(id, pending); this.#pendingArguments.delete(id) }
    }
    if (!this.#started) { this.#started = true; chunks.push(chunk({ role: 'assistant', content: '' })) }
    if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
      if (typeof event.delta !== 'string') throw new RelayError(502, 'invalid_upstream', 'The upstream returned an invalid text delta.')
      this.#text += event.delta
      if (event.delta !== '') chunks.push(chunk({ content: event.delta }))
    }
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      const item = object(event.item)
      if (item.type === 'function_call') tool(item)
    }
    if (event.type === 'response.function_call_arguments.delta') {
      const state = this.#tools.get(string(event.item_id, 'item_id'))
      if (state === undefined) throw new RelayError(502, 'invalid_upstream', 'A tool argument arrived before its tool call.')
      if (typeof event.delta !== 'string') throw new RelayError(502, 'invalid_upstream', 'The upstream returned an invalid tool argument delta.')
      state.arguments += event.delta
      if (event.delta !== '') chunks.push(chunk({ tool_calls: [{ index: state.index, function: { arguments: event.delta } }] }))
    }
    if (event.type === 'response.function_call_arguments.done') {
      if (typeof event.arguments !== 'string') throw new RelayError(502, 'invalid_upstream', 'The upstream returned invalid final tool arguments.')
      appendArguments(string(event.item_id, 'item_id'), event.arguments)
    }
    if (event.type === 'response.completed') {
      if (response === undefined || !Array.isArray(response.output)) throw new RelayError(502, 'invalid_upstream', 'The upstream completed response has no output array.')
      let completeText = ''
      const finalTools = new Set<string>()
      for (const raw of response.output) {
        const item = object(raw)
        if (item.type === 'function_call') { tool(item); finalTools.add(string(item.id, 'item.id')) }
        else if (item.type === 'message' && Array.isArray(item.content)) for (const rawPart of item.content) {
          const part = object(rawPart)
          if (part.type === 'output_text' && typeof part.text === 'string') completeText += part.text
          else if (part.type === 'refusal' && typeof part.refusal === 'string') completeText += part.refusal
        }
      }
      if (this.#tools.size !== finalTools.size || this.#pendingArguments.size > 0) throw new RelayError(502, 'inconsistent_upstream', 'The upstream final response omitted a streamed tool call.')
      if (!completeText.startsWith(this.#text)) throw new RelayError(502, 'inconsistent_upstream', 'The upstream changed text after streaming it.')
      const suffix = completeText.slice(this.#text.length)
      if (suffix !== '') chunks.push(chunk({ content: suffix }))
      this.#text = completeText
      chunks.push(chunk({}, this.#tools.size > 0 ? 'tool_calls' : 'stop', usage(response)), 'data: [DONE]\n\n')
    }
    return chunks
  }
}
