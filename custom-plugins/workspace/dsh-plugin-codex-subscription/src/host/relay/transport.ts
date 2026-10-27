/** Raw Codex transport preserves Responses events and holds account leases through body consumption. */
import { randomUUID } from 'node:crypto'
import type { AccountsFacade } from '../accounts/types.ts'
import { object, RelayError, string } from './http.ts'
import { adaptCodexBody, codexSessionHeaders } from '../codex-request.ts'
import { AccountError, type AccountFailureDetails } from '../accounts/record.ts'
import { accountRefusal, failureDetails } from '../accounts/failures.ts'
import { codexResponseHeaders } from '../upstream.ts'

/** Host-resolved transport options; fetch uses the same proxy policy as account login and images. */
export interface CodexTransportOptions {
  readonly accounts: Pick<AccountsFacade, 'withAccount'>
  readonly fetch: typeof globalThis.fetch
  readonly endpoint: string
  readonly originator: string
  readonly userAgent: string
  readonly clientVersion: string
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
  constructor(readonly options: CodexTransportOptions) {
    const endpoint = new URL(options.endpoint)
    if (endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '') throw new Error('Codex endpoint must use HTTPS without URL credentials')
  }

  /** Fetch a raw Responses SSE body while keeping the scheduler lease alive.
   * @param input - External Responses fields, before Codex normalization.
   * @param signal - Cancellation from the consuming request.
   * @returns headers and a streaming body owned by the caller.
   */
  async request(input: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    if (this.#closed) throw new RelayError(503, 'relay_closed', 'The subscription transport is stopping.')
    const body = codexRequest(input)
    const model = string(body.model, 'model')
    const sessionId = typeof body.prompt_cache_key === 'string' ? body.prompt_cache_key : randomUUID()
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
      headers.set('authorization', `Bearer ${lease.accessToken}`)
      headers.set('chatgpt-account-id', lease.accountId)
      headers.set('OpenAI-Beta', 'responses=experimental')
      headers.set('originator', this.options.originator)
      headers.set('user-agent', this.options.userAgent)
      headers.set('version', this.options.clientVersion)
      codexSessionHeaders(headers, sessionId)
      headers.set('x-client-request-id', randomUUID())
      headers.set('accept', 'text/event-stream')
      headers.set('content-type', 'application/json')
      operationSignal.throwIfAborted()
      const fetched = await this.options.fetch(this.options.endpoint, { method: 'POST', headers, body: JSON.stringify({ ...body, model: lease.model ?? body.model }), signal: operationSignal, redirect: 'error' })
      const upstream = lease.observeResponse?.(fetched) ?? fetched
      if (!upstream.ok) {
        if ([401, 402, 403, 429].includes(upstream.status)) throw await accountRefusal(upstream, Date.now(), operationSignal)
        throw new CodexHttpError(upstream.status, await failureDetails(upstream, Date.now(), operationSignal))
      }
      if (upstream.body === null) throw new RelayError(502, 'invalid_upstream', 'The upstream response has no body.')
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
