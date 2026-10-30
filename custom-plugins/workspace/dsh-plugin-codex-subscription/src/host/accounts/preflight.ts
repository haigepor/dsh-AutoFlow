/** Inspect a bounded metadata prelude and first SSE progress/refusal; published content never authorizes replay. */
import { createParser } from 'eventsource-parser'
import { codexResponseHeaders } from '../upstream.ts'

const statuses: Readonly<Record<string, number>> = { model_not_found: 404, model_not_supported: 403, model_access_denied: 403,
  permission_denied: 403, rate_limit_exceeded: 429, usage_limit_reached: 429, insufficient_quota: 402,
  invalid_grant: 401, token_revoked: 401, token_invalidated: 401, token_expired: 401 }

function refusal(value: unknown): { status: number; error: Record<string, unknown> } | undefined {
  if (value === null || typeof value !== 'object' || !('type' in value)) return
  if (value.type !== 'error' && value.type !== 'response.failed') return
  const raw = 'error' in value ? value.error : 'response' in value && value.response !== null && typeof value.response === 'object' && 'error' in value.response ? value.response.error : undefined
  if (raw === null || typeof raw !== 'object' || !('code' in raw) || typeof raw.code !== 'string') return
  const inferred = statuses[raw.code]
  if (inferred === undefined) return
  const explicit = 'status' in value ? value.status : 'status_code' in value ? value.status_code : undefined
  if (explicit !== undefined && (typeof explicit !== 'number' || ![401, 402, 403, 404, 429].includes(explicit))) return
  const status = typeof explicit === 'number' ? explicit : inferred
  return { status, error: { code: raw.code, ...('param' in raw && typeof raw.param === 'string' && ['model', 'reasoning.effort', 'service_tier'].includes(raw.param) ? { param: raw.param } : {}) } }
}

/** Classify an explicit first-event refusal before any response bytes are returned.
 * @param response Upstream HTTP or WebSocket-projected SSE response.
 * @param signal Existing request deadline; cancellation closes the retained reader.
 * @returns A safe HTTP refusal, or byte-identical streaming content with owned cancellation.
 */
export async function preflightResponse(response: Response, signal: AbortSignal): Promise<Response> {
  if (!response.ok || response.body === null || !(response.headers.get('content-type') ?? '').includes('text/event-stream')) return response
  const reader = response.body.getReader(), prefix: Uint8Array[] = []
  const decoder = new TextDecoder()
  let first: unknown, observed = false, size = 0, ended = false, metadataFrames = 0
  const parser = createParser({ maxBufferSize: 65_536, onEvent: event => {
    if (observed) return
    try {
      const value: unknown = JSON.parse(event.data)
      // 额度和路由通知不是模型输出；最多跨过八帧，再交由正常消费者处理。
      if (value !== null && typeof value === 'object' && 'type' in value
        && ['codex.rate_limits', 'codex.response.metadata', 'responsesapi.websocket_timing'].includes(String(value.type)) && ++metadataFrames < 8) return
      first = value
    } catch (_error) { /* 非 JSON 首帧不授权重放，由协议消费者报告。 */ }
    observed = true
  } })
  const cancel = (): void => { void reader.cancel(signal.reason).catch(() => { /* Cancellation can race an upstream error. */ }) }
  signal.addEventListener('abort', cancel, { once: true })
  const release = (): void => { signal.removeEventListener('abort', cancel); reader.releaseLock() }
  try {
    while (!observed && size < 65_536 && !ended) {
      signal.throwIfAborted()
      const next = await reader.read(); signal.throwIfAborted(); ended = next.done
      if (next.value !== undefined) {
        prefix.push(next.value); size += next.value.byteLength
        if (size <= 65_536) parser.feed(decoder.decode(next.value, { stream: true }))
      }
      if (ended && size <= 65_536) parser.feed(`${decoder.decode()}\n\n`)
    }
    const denied = refusal(first)
    if (denied !== undefined) {
      await reader.cancel(); release()
      const headers = codexResponseHeaders(response.headers); headers.set('content-type', 'application/json')
      return Response.json({ error: denied.error }, { status: denied.status, headers })
    }
  } catch (error) {
    await reader.cancel().catch(() => { /* A failed reader is already closed. */ }); release(); throw error
  }
  let released = false
  const finish = (): void => { if (!released) { released = true; release() } }
  return new Response(new ReadableStream<Uint8Array>({
    async pull(output) {
      try {
        signal.throwIfAborted()
        const saved = prefix.shift()
        if (saved !== undefined) { output.enqueue(saved); return }
        if (ended) { output.close(); finish(); return }
        const next = await reader.read(); signal.throwIfAborted()
        if (next.done) { ended = true; output.close(); finish() } else output.enqueue(next.value)
      } catch (error) { output.error(error); await reader.cancel().catch(() => { /* Preserve the original failure. */ }); finish() }
    },
    async cancel(reason) { try { await reader.cancel(reason) } finally { finish() } },
  }), { status: response.status, statusText: response.statusText, headers: response.headers })
}
