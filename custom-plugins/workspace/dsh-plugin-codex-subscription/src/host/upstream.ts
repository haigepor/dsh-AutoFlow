/** Shared Codex WebSocket→SSE fetch, following Magpie codex_socket.go with owned bounded resources. */
import { zstdDecompressSync } from 'node:zlib'
import { HttpsProxyAgent } from 'https-proxy-agent'
import WebSocket, { type RawData } from 'ws'
import { proxyRouteFor } from '@deepseek-ai/dsh-http-proxy'
import { z } from 'zod'
import type { SubscriptionOptions } from './config.ts'

type Settings = SubscriptionOptions['upstream']
const record = z.record(z.string(), z.unknown())
const BETA = 'responses_websockets=2026-02-06'
const PRELUDE_FRAMES = 8
const terminal = new Set(['response.completed', 'response.failed', 'response.incomplete', 'response.done', 'error'])
const hop = new Set(['connection', 'upgrade', 'host', 'content-type', 'content-length', 'content-encoding', 'accept', 'accept-encoding',
  'keep-alive', 'transfer-encoding', 'te', 'trailer', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate',
  'idempotency-key', 'x-idempotency-key', 'x-codex-turn-state', 'x-openai-internal-codex-responses-lite', 'openai-beta'])

/** Transport failures carry stable types; upstream text and credential-bearing URLs are never error messages. */
export class CodexSocketError extends Error {
  constructor(readonly code: 'SOCKET_CLOSED' | 'SOCKET_PROTOCOL' | 'SOCKET_BUFFER_LIMIT' | 'SOCKET_HANDSHAKE', readonly closeCode?: number, readonly status?: number) {
    super(`Codex WebSocket ${code.toLowerCase().replaceAll('_', ' ')}.`)
  }
}

/** HTTP fetch remains injectable; proxy selection defaults to the launcher's canonical policy. */
export interface CodexUpstreamOptions {
  endpoint: string
  fetch: typeof globalThis.fetch
  settings: Settings
  now?: () => number
  resolveProxy?(url: URL): string | undefined
}

function bytesOf(data: RawData): Buffer {
  return data instanceof ArrayBuffer ? Buffer.from(data) : Array.isArray(data) ? Buffer.concat(data) : data
}

class SocketSession {
  readonly socket: WebSocket
  readonly closed: Promise<void>
  readonly headers = new Headers()
  private readonly ended = Promise.withResolvers<void>()
  private readonly opening = Promise.withResolvers<void>()
  private wake = Promise.withResolvers<void>()
  private readonly queue: Buffer[] = []
  private queuedBytes = 0
  private failure: Error | undefined
  private finished = false
  private opened = false
  private closeCode: number | undefined
  private closeTimer: ReturnType<typeof setTimeout> | undefined
  private readonly abort: () => void

  constructor(url: URL, headers: Headers, private readonly signal: AbortSignal, private readonly settings: Settings, proxy: string | undefined) {
    signal.throwIfAborted()
    const agent = proxy === undefined ? undefined : new HttpsProxyAgent(proxy)
    const wsUrl = new URL(url); wsUrl.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    this.closed = this.ended.promise
    try {
      this.socket = new WebSocket(wsUrl, { headers: Object.fromEntries(headers), handshakeTimeout: settings.connectTimeoutMs,
        maxPayload: settings.maxMessageBytes, followRedirects: false,
        perMessageDeflate: { clientNoContextTakeover: true, serverNoContextTakeover: true }, ...(agent === undefined ? {} : { agent }) })
    } catch (error) { agent?.destroy(); throw error }
    this.abort = () => { this.failure = signal.reason instanceof Error ? signal.reason : new Error('Codex request aborted.'); this.wake.resolve(); this.socket.terminate() }
    this.socket.once('upgrade', response => {
      for (const [key, value] of Object.entries(response.headers)) if (typeof value === 'string') this.headers.set(key, value)
    })
    this.socket.once('open', () => { this.opened = true; this.opening.resolve() })
    this.socket.once('unexpected-response', (_request, response) => {
      response.destroy()
      this.fail(new CodexSocketError('SOCKET_HANDSHAKE', undefined, response.statusCode))
    })
    this.socket.on('error', error => this.fail(this.failure ?? new CodexSocketError(
      'code' in error && error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ? 'SOCKET_BUFFER_LIMIT' : this.opened ? 'SOCKET_CLOSED' : 'SOCKET_HANDSHAKE', this.closeCode)))
    this.socket.on('message', (data, binary) => {
      if (binary || this.failure !== undefined) return
      const bytes = bytesOf(data)
      if (this.queue.length >= settings.maxBufferedFrames || this.queuedBytes + bytes.byteLength > settings.maxBufferedBytes) {
        this.fail(new CodexSocketError('SOCKET_BUFFER_LIMIT')); return
      }
      this.queue.push(bytes); this.queuedBytes += bytes.byteLength; this.socket.pause(); this.wake.resolve()
    })
    this.socket.once('close', code => {
      this.closeCode = code; this.finished = true
      const failure = this.failure ?? new CodexSocketError(this.opened ? 'SOCKET_CLOSED' : 'SOCKET_HANDSHAKE', code)
      this.opening.reject(failure); this.wake.resolve()
      if (this.closeTimer !== undefined) clearTimeout(this.closeTimer)
      signal.removeEventListener('abort', this.abort); agent?.destroy(); this.ended.resolve()
    })
    signal.addEventListener('abort', this.abort, { once: true })
    if (signal.aborted) this.abort()
    // close/error may arrive before send() awaits the handshake; keep its rejection observed.
    void this.opening.promise.catch(() => {})
  }

  private fail(error: Error): void {
    this.failure ??= error; this.opening.reject(this.failure); this.wake.resolve(); this.socket.terminate()
  }

  async send(message: string): Promise<void> {
    await this.opening.promise
    this.signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => this.socket.send(message, error => error ? reject(new CodexSocketError('SOCKET_CLOSED', this.closeCode)) : resolve()))
  }

  async next(): Promise<Record<string, unknown> | undefined> {
    while (this.queue.length === 0) {
      this.signal.throwIfAborted()
      if (this.failure !== undefined) throw this.failure
      if (this.finished) throw new CodexSocketError('SOCKET_CLOSED', this.closeCode)
      const wake = this.wake.promise
      this.socket.resume(); await wake
    }
    const bytes = this.queue.shift()!
    this.queuedBytes -= bytes.byteLength
    if (this.queue.length === 0) this.wake = Promise.withResolvers<void>()
    let raw: unknown
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch (_error) { throw new CodexSocketError('SOCKET_PROTOCOL') }
    const parsed = record.safeParse(raw)
    if (!parsed.success || typeof parsed.data.type !== 'string' || parsed.data.type.length > 256 || /[\r\n]/.test(parsed.data.type)) throw new CodexSocketError('SOCKET_PROTOCOL')
    return parsed.data.type === 'responsesapi.websocket_timing' ? undefined : parsed.data
  }

  stop(force = false): void {
    if (this.socket.readyState === WebSocket.CLOSED) return
    if (force || this.socket.readyState === WebSocket.CONNECTING) { this.socket.terminate(); return }
    this.socket.resume()
    this.socket.close(1000)
    this.closeTimer ??= setTimeout(() => this.socket.terminate(), this.settings.closeTimeoutMs)
    this.closeTimer.unref()
  }
}

/** Only Codex protocol response headers cross back to native/relay consumers.
 * @param source Upstream headers, including metadata projected from WebSocket events.
 * @returns Detached headers without cookies or authorization values.
 */
export function codexResponseHeaders(source: Headers): Headers {
  const result = new Headers({ 'content-type': source.get('content-type') ?? 'text/event-stream' })
  for (const [key, value] of source) if (responseHeader(key)) result.set(key, value)
  return result
}

function responseHeader(key: string): boolean {
  return key.startsWith('x-codex-') || key === 'retry-after' || key === 'x-request-id'
    || /^x-[a-z0-9-]{1,128}-(primary|secondary)-(used-percent|window-minutes|reset-at|reset-after-seconds)$/.test(key)
}

function copyHeaders(headers: Headers, input: unknown, overwrite = false): void {
  const values = record.safeParse(input)
  if (!values.success) return
  for (const [key, value] of Object.entries(values.data)) {
    if (typeof value === 'string' && responseHeader(key.toLowerCase()) && (overwrite || !headers.has(key))) {
      try { headers.set(key, value) } catch (_error) { /* Invalid metadata cannot become HTTP headers. */ }
    }
  }
}

function noteHeaders(headers: Headers, event: Record<string, unknown>): void {
  if (event.type === 'codex.response.metadata') copyHeaders(headers, event.headers)
  if (event.type !== 'codex.rate_limits') return
  const set = (key: string, value: unknown): void => {
    if (value === undefined || value === null || headers.has(key)) return
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return
    try { headers.set(key, String(value)) } catch (_error) { /* Invalid metadata cannot become HTTP headers. */ }
  }
  set('x-codex-plan-type', event.plan_type)
  const credits = record.safeParse(event.credits)
  if (credits.success) {
    for (const [field, suffix] of [['has_credits', 'has-credits'], ['unlimited', 'unlimited']]) {
      const value = credits.data[field!]
      if (typeof value === 'boolean') set(`x-codex-credits-${suffix}`, value ? 'True' : 'False')
    }
    set('x-codex-credits-balance', credits.data.balance)
  }
  const metered = typeof event.metered_limit_name === 'string' ? event.metered_limit_name : event.limit_name
  const name = typeof metered === 'string' && metered.trim() !== '' ? metered.trim().toLowerCase().replaceAll('_', '-') : 'codex'
  if (!/^[a-z0-9-]{1,128}$/.test(name)) return
  const limits = record.safeParse(event.rate_limits)
  if (!limits.success) return
  for (const which of ['primary', 'secondary']) {
    const window = record.safeParse(limits.data[which])
    if (!window.success) continue
    for (const [field, suffix] of [['used_percent', 'used-percent'], ['window_minutes', 'window-minutes'], ['reset_at', 'reset-at'], ['reset_after_seconds', 'reset-after-seconds']]) {
      const value = window.data[field!], key = `x-${name}-${which}-${suffix}`
      if (typeof value === 'number' && Number.isFinite(value) && !headers.has(key)) headers.set(key, String(value))
    }
  }
}

function sse(event: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
}

/** Per-profile WebSocket owner. Only complete pre-publication failures can fall back to the original HTTP body. */
export class CodexUpstream {
  private settings: Settings
  private readonly now: () => number
  private readonly sessions = new Set<SocketSession>()
  private readonly lifetime = new AbortController()
  private readonly origin: URL
  private shunnedUntil = 0
  private tooBig: { bytes: number; until: number } | undefined
  private closed = false
  private disposal: Promise<void> | undefined
  private websocketRequests = 0
  private httpFallbacks = 0

  constructor(private readonly options: CodexUpstreamOptions) {
    this.settings = { ...options.settings }; this.now = options.now ?? Date.now; this.origin = new URL(options.endpoint)
    if (this.origin.username || this.origin.password || this.origin.protocol !== 'https:' && !(this.origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(this.origin.hostname))) throw new Error('Codex upstream must use HTTPS or a loopback fixture URL.')
  }

  /** Update future transport attempts; existing sockets retain the limits they were admitted with.
   * @param settings Fully resolved deployment settings.
   */
  update(settings: Settings): void { this.settings = { ...settings } }

  /** Fetch-compatible entry shared by native Codex and the raw Responses transport.
   * @param input Fetch URL or request. Only the configured POST Responses endpoint is eligible for WebSocket.
   * @param init Fetch options; replayable string/byte bodies are eligible, streamed bodies stay HTTP.
   * @returns HTTP response or a WebSocket reply projected as an owned SSE response.
   */
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    if (this.closed) throw new Error('Codex upstream is stopping.')
    const url = new URL(input instanceof Request ? input.url : String(input))
    const settings = { ...this.settings }
    if (url.origin !== this.origin.origin || url.pathname !== this.origin.pathname || (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase() !== 'POST'
      || settings.mode === 'sse' || this.shunnedUntil > this.now()) return this.options.fetch(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const raw = init?.body
    if (typeof raw !== 'string' && !(raw instanceof Uint8Array)) return this.options.fetch(input, init)
    let payload: Record<string, unknown>
    try {
      const bytes = typeof raw === 'string' ? Buffer.from(raw) : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
      if (bytes.byteLength > settings.maxRequestBytes) return this.options.fetch(input, init)
      const encoding = headers.get('content-encoding')
      if (encoding !== null && encoding !== 'zstd') return this.options.fetch(input, init)
      const plain = encoding === 'zstd' ? zstdDecompressSync(bytes, { maxOutputLength: settings.maxRequestBytes }) : bytes
      payload = record.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)))
    } catch (_error) { return this.options.fetch(input, init) /* Non-replayable/non-JSON input keeps its original HTTP semantics. */ }
    if (payload.stream !== true || payload.type !== undefined) return this.options.fetch(input, init)
    const meta = record.safeParse(payload.client_metadata)
    const extra: Record<string, string> = {}
    const turn = headers.get('x-codex-turn-state')
    if (turn !== null) extra['x-codex-turn-state'] = turn
    if (headers.get('x-openai-internal-codex-responses-lite')?.toLowerCase() === 'true') extra.ws_request_header_x_openai_internal_codex_responses_lite = 'true'
    if (Object.keys(extra).length) {
      if (payload.client_metadata !== undefined && payload.client_metadata !== null && !meta.success) return this.options.fetch(input, init)
      payload.client_metadata = { ...extra, ...(meta.success ? meta.data : {}) }
    }
    const message = JSON.stringify({ type: 'response.create', ...payload })
    const messageBytes = Buffer.byteLength(message)
    if (this.tooBig !== undefined && this.tooBig.until > this.now() && messageBytes >= this.tooBig.bytes) return this.options.fetch(input, init)
    const signal = AbortSignal.any([this.lifetime.signal, ...(init?.signal ? [init.signal] : input instanceof Request ? [input.signal] : [])])
    signal.throwIfAborted()
    const handshake = new Headers()
    for (const [key, value] of headers) if (!hop.has(key) && !key.startsWith('sec-websocket-')) handshake.set(key, value)
    handshake.set('OpenAI-Beta', BETA)
    const route = this.options.resolveProxy === undefined ? proxyRouteFor(url) : undefined
    const proxy = this.options.resolveProxy?.(url) ?? (route?.proxied ? route.proxy : undefined)
    const session = new SocketSession(url, handshake, signal, settings, proxy)
    this.sessions.add(session); this.websocketRequests++
    void session.closed.then(() => this.sessions.delete(session))
    const responseHeaders = new Headers({ 'content-type': 'text/event-stream' })
    const pending: Record<string, unknown>[] = []
    let done = false
    try {
      await session.send(message)
      for (const [key, value] of codexResponseHeaders(session.headers)) if (key !== 'content-type') responseHeaders.set(key, value)
      for (let index = 0; index < PRELUDE_FRAMES; index++) {
        const event = await session.next()
        if (event === undefined) continue
        noteHeaders(responseHeaders, event)
        if (event.type === 'error') {
          const error = record.safeParse(event.error)
          if ((error.success ? error.data.code : undefined) === 'websocket_connection_limit_reached') {
            session.stop(true); this.httpFallbacks++; return this.options.fetch(input, init)
          }
          const status = event.status ?? event.status_code
          if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) {
            session.stop(true)
            copyHeaders(responseHeaders, event.headers, true)
            if (error.success) copyHeaders(responseHeaders, error.data.headers, true)
            responseHeaders.set('content-type', 'application/json')
            return Response.json(error.success ? { error: error.data } : event, { status, headers: codexResponseHeaders(responseHeaders) })
          }
        }
        pending.push(event)
        if (terminal.has(String(event.type))) { done = true; session.stop() }
        if (event.type !== 'codex.rate_limits' && event.type !== 'codex.response.metadata') break
      }
    } catch (error) {
      session.stop(true)
      signal.throwIfAborted()
      if (!(error instanceof CodexSocketError) || !['SOCKET_HANDSHAKE', 'SOCKET_CLOSED'].includes(error.code)) throw error
      if (error.closeCode === 1009) this.tooBig = { bytes: this.tooBig === undefined || this.tooBig.until <= this.now() ? messageBytes : Math.min(messageBytes, this.tooBig.bytes), until: this.now() + settings.cooldownMs }
      if (error.code === 'SOCKET_HANDSHAKE' && error.status !== 401 && error.status !== 429 && (error.status ?? 0) < 500) this.shunnedUntil = this.now() + settings.cooldownMs
      this.httpFallbacks++; return this.options.fetch(input, init)
    }
    // 发布响应即提交传输选择；后续断线只向当前消费者报错，绝不从 HTTP 重新开始。
    const body = new ReadableStream<Uint8Array>({
      pull: async output => {
        try {
          signal.throwIfAborted()
          if (pending.length) { output.enqueue(sse(pending.shift()!)); return }
          if (done) { output.close(); return }
          for (;;) {
            const event = await session.next()
            if (event === undefined) continue
            output.enqueue(sse(event))
            if (terminal.has(String(event.type))) { done = true; session.stop() }
            return
          }
        } catch (error) { session.stop(true); output.error(error) }
      },
      cancel: async () => { session.stop(true); await session.closed },
    })
    return new Response(body, { headers: codexResponseHeaders(responseHeaders) })
  }

  /** Safe transport counters contain no bodies, credentials, proxy URLs or account identities.
   * @returns Current mode, active socket count and fallback memory.
   */
  status() { return { mode: this.settings.mode, activeSockets: this.sessions.size, websocketRequests: this.websocketRequests, httpFallbacks: this.httpFallbacks,
    shunnedUntil: this.shunnedUntil, ...(this.tooBig === undefined ? {} : { largeMessageThreshold: this.tooBig.bytes, largeMessageUntil: this.tooBig.until }) } }

  /** Abort all sockets and wait for their close handlers and agents to release resources.
   * @returns The same draining promise for concurrent disposal callers.
   */
  dispose(): Promise<void> {
    this.closed = true; this.lifetime.abort(new Error('Codex upstream disposed.'))
    for (const session of this.sessions) session.stop(true)
    return this.disposal ??= Promise.all([...this.sessions].map(session => session.closed)).then(() => {})
  }
}
