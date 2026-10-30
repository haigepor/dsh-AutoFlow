/** Connection-local Responses continuation with bounded queues, per-turn authentication and owned cancellation. */
import { randomUUID } from 'node:crypto'
import { ServerResponse, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { jsonBody, object, RelayError, sendError, sseEvents } from './http.ts'
import { relayContext } from './context.ts'
import { codexResponseHeaders } from '../upstream.ts'
import type { RelayConfig, RelayDependencies } from './types.ts'

interface History { id: string; model: string; input: unknown[]; output: unknown[]; accountKey?: string }
interface Turn { controller: AbortController; responseId?: string }
interface Connection { socket: WebSocket; request: IncomingMessage; queue: Record<string, unknown>[]; queuedBytes: number; running?: Turn; history?: History }
const terminalTypes = new Set(['response.completed', 'response.done', 'response.failed', 'response.incomplete', 'response.cancelled', 'error'])

function failure(error: unknown): Record<string, unknown> {
  const safe = error instanceof RelayError ? error : new RelayError(502, 'upstream_error', 'The subscription request failed. Check the account and task status.')
  return { type: 'error', status: safe.status, error: { type: safe.code, code: safe.code, message: safe.message,
    ...(safe.details.retryAt === undefined ? {} : { retry_at: safe.details.retryAt }), ...(safe.details.requestId === undefined ? {} : { request_id: safe.details.requestId }) } }
}

function bytes(data: RawData): Buffer { return data instanceof ArrayBuffer ? Buffer.from(data) : Array.isArray(data) ? Buffer.concat(data) : data }

async function send(socket: WebSocket, event: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (socket.readyState !== WebSocket.OPEN) throw new RelayError(499, 'client_disconnected', 'The WebSocket client disconnected.')
  await new Promise<void>((resolve, reject) => {
    const aborted = (): void => { socket.terminate(); reject(signal?.reason) }
    signal?.addEventListener('abort', aborted, { once: true })
    socket.send(JSON.stringify(event), error => { signal?.removeEventListener('abort', aborted); if (error) reject(error); else resolve() })
    if (signal?.aborted) aborted()
  })
  signal?.throwIfAborted()
}

/** Own downstream sockets for one relay listener; activeTurns participates in its global concurrency cap. */
export class ResponsesSockets {
  private readonly wss: WebSocketServer
  private readonly connections = new Set<Connection>()
  private readonly active = new Set<Promise<void>>()
  private closing = false
  private readonly upgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void

  constructor(private readonly server: Server, private readonly config: RelayConfig, private readonly dependencies: RelayDependencies,
    private readonly authenticate: (request: IncomingMessage, response: ServerResponse) => string, private readonly busy: () => boolean) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: config.maxRequestBytes, perMessageDeflate: false, allowSynchronousEvents: false })
    this.upgrade = (request, socket, head) => {
      const response = new ServerResponse(request)
      try {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname
        if (request.method !== 'GET' || !['/v1/responses', '/responses'].includes(path)) throw new RelayError(404, 'not_found', 'This WebSocket route is not available.')
        const keyId = this.authenticate(request, response)
        if (this.closing) throw new RelayError(503, 'relay_closed', 'The relay is stopping.')
        if (this.connections.size >= config.maxSocketConnections) throw new RelayError(429, 'websocket_connection_limit_reached', 'The WebSocket connection limit has been reached.')
        relayContext(request, keyId)
        this.wss.handleUpgrade(request, socket, head, ws => {
          const connection: Connection = { socket: ws, request, queue: [], queuedBytes: 0 }
          this.connections.add(connection)
          ws.on('message', (data, binary) => this.message(connection, data, binary))
          ws.once('close', () => {
            connection.queue.length = 0; connection.queuedBytes = 0; delete connection.history
            connection.running?.controller.abort(new RelayError(499, 'client_disconnected', 'The WebSocket client disconnected.'))
            this.connections.delete(connection)
          })
          ws.on('error', () => { ws.terminate() })
        })
      } catch (error) {
        response.assignSocket(request.socket); response.setHeader('Connection', 'close'); response.once('finish', () => request.socket.destroy()); sendError(response, error)
      }
    }
    server.on('upgrade', this.upgrade)
  }

  /** Number of generating turns; idle connections and queued turns consume no account lease. */
  get activeTurns(): number { return this.active.size }

  private report(connection: Connection, error: unknown): void {
    // 协议校验错误不并发堆积发送队列；生成流由 send 回调提供背压。
    if (connection.socket.bufferedAmount > this.config.maxResponseBytes) { connection.socket.terminate(); return }
    void send(connection.socket, failure(error)).catch(() => { connection.socket.terminate() })
  }

  private message(connection: Connection, data: RawData, binary: boolean): void {
    try {
      if (this.closing) throw new RelayError(503, 'relay_closed', 'The relay is stopping.')
      const response = new ServerResponse(connection.request)
      const keyId = this.authenticate(connection.request, response)
      relayContext(connection.request, keyId)
      if (binary) throw new RelayError(400, 'invalid_request', 'Send a UTF-8 JSON text frame.')
      const input = jsonBody(bytes(data))
      if (input.type === 'response.cancel') {
        if (input.response_id !== undefined && input.response_id !== connection.running?.responseId) throw new RelayError(404, 'response_not_found', 'The active response was not found on this connection.')
        connection.queue.length = 0; connection.queuedBytes = 0
        connection.running?.controller.abort(new RelayError(499, 'response_cancelled', 'The response was cancelled.'))
        return
      }
      if (input.type !== 'response.create') throw new RelayError(400, 'unsupported_event', 'Use response.create or response.cancel.')
      if (input.generate !== undefined && typeof input.generate !== 'boolean') throw new RelayError(400, 'invalid_request', 'generate must be a boolean.')
      const size = Buffer.byteLength(JSON.stringify(input))
      if (connection.running !== undefined && connection.queue.length >= this.config.maxSocketQueuedTurns || connection.queuedBytes + size > this.config.maxRequestBytes) throw new RelayError(429, 'websocket_queue_full', 'The WebSocket turn queue is full.')
      connection.queue.push(input); connection.queuedBytes += size
      this.next(connection)
    } catch (error) { this.report(connection, error) }
  }

  private next(connection: Connection): void {
    if (this.closing || connection.running !== undefined || connection.socket.readyState !== WebSocket.OPEN) return
    const input = connection.queue.shift()
    if (input === undefined) return
    connection.queuedBytes -= Buffer.byteLength(JSON.stringify(input))
    if (this.busy()) { this.report(connection, new RelayError(429, 'gateway_busy', 'The gateway concurrency limit has been reached.')); this.next(connection); return }
    const turn: Turn = { controller: new AbortController() }
    connection.running = turn
    const timeout = setTimeout(() => turn.controller.abort(new RelayError(504, 'request_timeout', 'The WebSocket turn timed out.')), this.config.requestTimeoutMs)
    timeout.unref()
    const operation = this.run(connection, input, turn).catch((error: unknown) => {
      if (connection.socket.readyState === WebSocket.OPEN) this.report(connection, turn.controller.signal.aborted ? turn.controller.signal.reason : error)
    }).finally(() => { clearTimeout(timeout); delete connection.running; this.active.delete(operation); this.next(connection) })
    this.active.add(operation)
  }

  private async run(connection: Connection, input: Record<string, unknown>, turn: Turn): Promise<void> {
    const keyId = this.authenticate(connection.request, new ServerResponse(connection.request))
    const context = relayContext(connection.request, keyId)
    const hints = new Headers()
    for (const key of ['originator', 'user-agent', 'version']) { const value = connection.request.headers[key]; if (typeof value === 'string') hints.set(key, value) }
    this.dependencies.observeClient?.(hints)
    const model = input.model
    if (typeof model !== 'string' || model.trim() === '') throw new RelayError(400, 'invalid_request', 'model must be a nonempty string.')
    const current = typeof input.input === 'string' ? [{ role: 'user', content: [{ type: 'input_text', text: input.input }] }] : input.input
    if (!Array.isArray(current)) throw new RelayError(400, 'invalid_request', 'input must be a string or an array.')
    const previous = input.previous_response_id
    const history = connection.history
    if (previous !== undefined && previous !== null && (typeof previous !== 'string' || history?.id !== previous)) throw new RelayError(400, 'previous_response_not_found', 'The previous response is not retained on this connection. Send the complete input history.')
    if (previous !== undefined && previous !== null && history?.model !== model) throw new RelayError(400, 'previous_response_model_mismatch', 'Continue with the same model or send the complete input history.')
    const restored: unknown[] = previous === undefined || previous === null ? current : [...history!.input, ...history!.output, ...current]
    const body: Record<string, unknown> = { ...input, input: restored, stream: true }
    delete body.type; delete body.previous_response_id; delete body.generate
    if (Buffer.byteLength(JSON.stringify(body)) > this.config.maxRequestBytes) throw new RelayError(413, 'request_too_large', 'The restored request exceeds the configured size limit.')
    const signal = turn.controller.signal
    if (input.generate === false) {
      const response = { id: `resp_warmup_${randomUUID()}`, object: 'response', model, status: 'completed', output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }
      await send(connection.socket, { type: 'response.created', response: { ...response, status: 'in_progress' } }, signal)
      await send(connection.socket, { type: 'response.completed', response }, signal)
      this.remember(connection, { id: response.id, model, input: restored, output: [] }); return
    }
    let accountKey: string | undefined, complete: Record<string, unknown> | undefined, terminal = false
    delete connection.history
    const upstream = await this.dependencies.requestResponses(body, signal, { ...context,
      ...(previous !== undefined && previous !== null && history?.accountKey !== undefined ? { replayAccountKey: history.accountKey } : {}), onAccount: key => { accountKey = key } })
    if (!upstream.ok) { await upstream.body?.cancel(); throw new RelayError(upstream.status, 'subscription_upstream_error', `The subscription upstream returned HTTP ${upstream.status}.`) }
    const metadata = codexResponseHeaders(upstream.headers); metadata.delete('content-type')
    const forwarded = Object.fromEntries(metadata)
    if (Object.keys(forwarded).length > 0) await send(connection.socket, { type: 'codex.response.metadata', headers: forwarded }, signal)
    for await (const event of sseEvents(upstream, signal, this.config.maxResponseBytes)) {
      if (event.type === 'response.created' && event.response !== null && typeof event.response === 'object' && 'id' in event.response && typeof event.response.id === 'string') turn.responseId = event.response.id
      await send(connection.socket, event, signal)
      if (terminalTypes.has(String(event.type))) {
        terminal = true
        if (event.type === 'response.completed') complete = object(event.response)
        break
      }
    }
    if (!terminal) throw new RelayError(502, 'incomplete_response', 'The upstream stream ended without a terminal response.')
    if (complete !== undefined && typeof complete.id === 'string' && Array.isArray(complete.output)) this.remember(connection, { id: complete.id, model, input: restored, output: complete.output, ...(accountKey === undefined ? {} : { accountKey }) })
    else delete connection.history
  }

  private remember(connection: Connection, history: History): void {
    // 只保留最后一个完整响应；超限时明确丢弃，下一次增量请求得到 previous_response_not_found。
    if (Buffer.byteLength(JSON.stringify(history)) <= this.config.maxSocketHistoryBytes) connection.history = history
    else delete connection.history
  }

  /** Abort every owned turn and close upgraded connections before the HTTP listener is disposed. */
  async close(): Promise<void> {
    this.closing = true; this.server.off('upgrade', this.upgrade)
    for (const connection of this.connections) { connection.queue.length = 0; connection.running?.controller.abort(new RelayError(503, 'relay_closed', 'The relay is stopping.')); connection.socket.terminate() }
    await Promise.allSettled(this.active)
    await new Promise<void>(resolve => this.wss.close(() => resolve()))
  }
}
