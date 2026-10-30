/** Raw Codex transport preserves Responses events and holds account leases through body consumption. */
import { createHash, randomUUID } from 'node:crypto'
import type { AccountsFacade } from '../accounts/types.ts'
import { object, RelayError, string } from './http.ts'
import { adaptCodexBody, codexSessionHeaders } from '../codex-request.ts'
import { AccountError, AccountRejected, type AccountFailureDetails } from '../accounts/record.ts'
import { accountRefusal, failureDetails } from '../accounts/failures.ts'
import { codexResponseHeaders } from '../upstream.ts'
import { preflightResponse } from '../accounts/preflight.ts'
import { protocolHeaders } from './context.ts'
import type { RelayRequestContext } from './types.ts'

/** Host-resolved transport options; fetch uses the same proxy policy as account login and images. */
export interface CodexTransportOptions {
  readonly accounts: Pick<AccountsFacade, 'withAccount'>
  readonly fetch: typeof globalThis.fetch
  readonly endpoint: string
  readonly originator: string
  readonly userAgent: string
  readonly clientVersion: string
  readonly sessionStateLimit: number
}

/** Remove parameters explicitly rejected by the subscription endpoint; never inject instructions.
 * @param input - Raw external Responses request.
 * @returns a new upstream request object.
 */
export function codexRequest(input: Record<string, unknown>): Record<string, unknown> {
  string(input.model, 'model')
  if (typeof input.input !== 'string' && !Array.isArray(input.input)) throw new RelayError(400, 'invalid_request', 'input must be a string or an array.')
  if (input.instructions !== undefined && typeof input.instructions !== 'string') throw new RelayError(400, 'invalid_request', 'instructions must be a string.')
  for (const field of ['previous_response_id', 'context_management', 'conversation']) {
    const value = input[field]
    if (value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)) throw new RelayError(400, 'unsupported_parameter', `${field} is not supported by this stateless subscription gateway. Send the complete input history.`)
  }
  if (input.background !== undefined && input.background !== false) throw new RelayError(400, 'unsupported_parameter', 'Background Responses are not supported by this subscription gateway.')
  const body = adaptCodexBody(input)
  for (const key of ['previous_response_id', 'context_management', 'conversation', 'background']) delete body[key]
  return body
}

/** An upstream HTTP failure participates in account cooldowns without exposing response text. */
class CodexHttpError extends RelayError {
  constructor(status: number, details: AccountFailureDetails = {}) { super(status, 'subscription_upstream_error', `The subscription upstream returned HTTP ${status}.`, details) }
}

/** One transport pins an account until EOF/cancel; it never replays a failed partial stream. */
export class CodexResponsesTransport {
  readonly #active = new Set<Promise<void>>()
  readonly #controllers = new Set<AbortController>()
  #closed = false
  readonly #turns = new Map<string, { accountKey: string; credential: string; state: string }>()
  constructor(readonly options: CodexTransportOptions) {
    const endpoint = new URL(options.endpoint)
    if (endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '') throw new Error('Codex endpoint must use HTTPS without URL credentials')
  }

  /** Fetch a raw Responses SSE body while keeping the scheduler lease alive.
   * @param input - External Responses fields, before Codex normalization.
   * @param signal - Cancellation from the consuming request.
   * @param context - Authenticated gateway identity and metadata; omitted for an internal caller.
   * @returns headers and a streaming body owned by the caller.
   */
  async request(input: Record<string, unknown>, signal: AbortSignal, context?: RelayRequestContext): Promise<Response> {
    if (this.#closed) throw new RelayError(503, 'relay_closed', 'The subscription transport is stopping.')
    const body = codexRequest(input)
    const clientHeaders = protocolHeaders(context?.headers ?? new Headers())
    if (context !== undefined) {
      body.prompt_cache_key = createHash('sha256').update(JSON.stringify([context.keyId, body.prompt_cache_key])).digest('hex')
      if (body.client_metadata !== null && typeof body.client_metadata === 'object' && !Array.isArray(body.client_metadata)) {
        const metadata = { ...object(body.client_metadata) }
        delete metadata['x-codex-turn-state']
        delete metadata.ws_request_header_x_openai_internal_codex_responses_lite
        body.client_metadata = metadata
      }
    }
    const model = string(body.model, 'model')
    const sessionId = typeof body.prompt_cache_key === 'string' ? body.prompt_cache_key : randomUUID()
    const turnKey = JSON.stringify([sessionId, body.model])
    const reasoning = body.reasoning !== null && typeof body.reasoning === 'object' && 'effort' in body.reasoning ? body.reasoning.effort : undefined
    const controller = new AbortController()
    this.#controllers.add(controller)
    const combined = AbortSignal.any([signal, controller.signal])
    const ready = Promise.withResolvers<Response>()
    let published = false
    const operation = this.options.accounts.withAccount({ kind: 'text', model, sessionId, signal: combined,
      ...(typeof reasoning === 'string' ? { reasoningEffort: reasoning } : {}), ...(typeof body.service_tier === 'string' ? { serviceTier: body.service_tier } : {}) }, async lease => {
      const operationSignal = AbortSignal.any([combined, lease.signal])
      const headers = new Headers(lease.headers)
      const credential = createHash('sha256').update(lease.accessToken).digest('hex')
      const previous = this.#turns.get(turnKey)
      for (const [key, value] of clientHeaders) if (key !== 'x-codex-turn-state') headers.set(key, value)
      // 上游 turn-state 属于凭据与账号；换号或首次见到的状态不能继承客户端缓存。
      const state = clientHeaders.get('x-codex-turn-state')
      if (state !== null && previous?.accountKey === lease.accountKey && previous.credential === credential && previous.state === state) headers.set('x-codex-turn-state', state)
      headers.set('authorization', `Bearer ${lease.accessToken}`)
      headers.set('chatgpt-account-id', lease.accountId)
      headers.set('OpenAI-Beta', 'responses=experimental')
      headers.set('originator', this.options.originator)
      headers.set('user-agent', this.options.userAgent)
      headers.set('version', this.options.clientVersion)
      codexSessionHeaders(headers, sessionId)
      if (!headers.has('x-client-request-id')) headers.set('x-client-request-id', randomUUID())
      headers.set('accept', 'text/event-stream')
      headers.set('content-type', 'application/json')
      operationSignal.throwIfAborted()
      const outgoingBody: Record<string, unknown> = { ...body, model: lease.model ?? body.model }
      // 恢复的加密推理只属于原账号；换号保留普通消息和工具往返，移除不可验证的推理签名。
      if (context !== undefined && context.replayAccountKey !== lease.accountKey && Array.isArray(outgoingBody.input)) outgoingBody.input = outgoingBody.input.filter(item => item === null || typeof item !== 'object' || !('type' in item) || item.type !== 'reasoning')
      const fetched = await this.options.fetch(this.options.endpoint, { method: 'POST', headers, body: JSON.stringify(outgoingBody), signal: operationSignal, redirect: 'error' })
      const checked = await preflightResponse(fetched, operationSignal)
      const upstream = lease.observeResponse?.(checked) ?? checked
      if (!upstream.ok) {
        if ([401, 402, 403, 429].includes(upstream.status)) throw await accountRefusal(upstream, Date.now(), operationSignal)
        if (upstream.status === 404) {
          const details = await failureDetails(upstream, Date.now(), operationSignal)
          if (details.scope === 'model') throw new AccountRejected(404, details)
          throw new CodexHttpError(404, details)
        }
        throw new CodexHttpError(upstream.status, await failureDetails(upstream, Date.now(), operationSignal))
      }
      if (upstream.body === null) throw new RelayError(502, 'invalid_upstream', 'The upstream response has no body.')
      context?.onAccount?.(lease.accountKey)
      const nextState = upstream.headers.get('x-codex-turn-state')
      this.#turns.delete(turnKey)
      if (nextState !== null && nextState.length <= 4096) this.#turns.set(turnKey, { accountKey: lease.accountKey, credential, state: nextState })
      while (this.#turns.size > this.options.sessionStateLimit) { const oldest = this.#turns.keys().next().value; if (oldest !== undefined) this.#turns.delete(oldest) }
      const reader = upstream.body.getReader()
      const consumed = Promise.withResolvers<void>()
      const cancel = (): void => { void reader.cancel(operationSignal.reason).then(consumed.resolve, consumed.reject) }
      operationSignal.addEventListener('abort', cancel, { once: true })
      if (operationSignal.aborted) cancel()
      const responseBody = new ReadableStream<Uint8Array>({
        pull: async output => {
          try {
            operationSignal.throwIfAborted()
            const next = await reader.read()
            if (next.done) { output.close(); consumed.resolve() }
            else output.enqueue(next.value)
          } catch (error) { output.error(error); consumed.reject(error) }
        },
        cancel: async reason => { await reader.cancel(reason); consumed.resolve() },
      })
      published = true
      ready.resolve(new Response(responseBody, { status: upstream.status, headers: codexResponseHeaders(upstream.headers) }))
      try { await consumed.promise }
      finally { operationSignal.removeEventListener('abort', cancel); reader.releaseLock() }
    }).then(() => undefined, (error: unknown) => {
      if (!published) ready.reject(error instanceof AccountError && error.status !== undefined ? new CodexHttpError(error.status, error.details) : error)
      // The published stream reports its own failure; another account cannot resume its bytes.
    }).finally(() => { this.#controllers.delete(controller); this.#active.delete(operation) })
    this.#active.add(operation)
    return await ready.promise
  }

  /** Abort every lease and wait until its upstream body releases resources. */
  async dispose(): Promise<void> {
    this.#closed = true
    this.#turns.clear()
    for (const controller of this.#controllers) controller.abort(new Error('Subscription transport disposed'))
    await Promise.allSettled(this.#active)
  }
}

/** Resolve an upstream terminal response from parsed SSE data.
 * @param event - One parsed upstream event.
 * @returns the completed response, or undefined for progress.
 */
export function completedResponse(event: Record<string, unknown>): Record<string, unknown> | undefined {
  if (event.type === 'response.failed' || event.type === 'error') throw new RelayError(502, 'upstream_error', 'The upstream reported a generation failure.')
  if (event.type === 'response.incomplete') throw new RelayError(502, 'incomplete_response', 'The upstream response ended before completion.')
  return event.type === 'response.completed' ? object(event.response) : undefined
}
