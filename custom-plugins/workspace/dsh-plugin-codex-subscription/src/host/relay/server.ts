/** Loopback-only OpenAI-compatible relay and image MCP listener. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createImageMcpHandler } from '../mcp-http/index.ts'
import { chatRequest, chatResponse, ChatStream } from './chat.ts'
import { authenticate, jsonBody, object, readBody, RelayError, sendError, sendJson, sseEvents, write } from './http.ts'
import { parseImageRequest, waitImage } from './images.ts'
import { completedResponse } from './transport.ts'
import { codexResponseHeaders } from '../upstream.ts'
import type { RelayConfig, RelayDependencies, RelayServer } from './types.ts'
import type { ImageOwner } from '../images/types.ts'

function validateConfig(config: RelayConfig): void {
  if (config.host !== '127.0.0.1' && config.host !== '::1') throw new Error('Relay host must be a loopback IP')
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('Relay port must be an integer in 0..65535')
  for (const field of ['maxRequestBytes', 'maxResponseBytes', 'requestTimeoutMs', 'imageWaitMs', 'assetUrlTtlMs', 'maxConcurrentRequests'] as const) if (!Number.isSafeInteger(config[field]) || config[field] <= 0) throw new Error(`Relay ${field} must be a positive safe integer`)
  if (config.gatewayKeys.length === 0 || new Set(config.gatewayKeys.map(key => key.id)).size !== config.gatewayKeys.length) throw new Error('Relay needs uniquely identified gateway keys')
  for (const key of config.gatewayKeys) if (key.id.trim() === '' || key.secret.length < 16) throw new Error('Relay gateway keys need an id and at least 16 characters')
  for (const origin of config.allowedOrigins) if (new URL(origin).origin !== origin) throw new Error('Relay allowedOrigins must contain exact origins')
}

function admitOrigin(request: IncomingMessage, response: ServerResponse, config: RelayConfig, port: number): void {
  const rawHost = request.headers.host
  if (rawHost === undefined || rawHost.includes('@') || rawHost.includes('/') || rawHost.includes('\\')) throw new RelayError(403, 'invalid_host', 'The Host header is not allowed.')
  let url: URL
  try { url = new URL(`http://${rawHost}`) }
  catch { throw new RelayError(403, 'invalid_host', 'The Host header is not allowed.') }
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || Number(url.port || 80) !== port) throw new RelayError(403, 'invalid_host', 'The Host header is not allowed.')
  const origin = request.headers.origin
  if (origin !== undefined) {
    if (!config.allowedOrigins.includes(origin)) throw new RelayError(403, 'invalid_origin', 'This browser Origin is not allowed.')
    response.setHeader('Access-Control-Allow-Origin', origin)
    response.setHeader('Vary', 'Origin')
  }
}

async function pipeRaw(upstream: Response, response: ServerResponse, signal: AbortSignal, limit: number): Promise<void> {
  if (upstream.body === null) throw new RelayError(502, 'invalid_upstream', 'The upstream response has no body.')
  const reader = upstream.body.getReader()
  const cancel = (): void => { void reader.cancel(signal.reason).catch(() => { /* A failed upstream may already have closed. */ }) }
  signal.addEventListener('abort', cancel, { once: true })
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' })
  let total = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > limit) throw new RelayError(502, 'response_too_large', 'The upstream response exceeds the configured size limit.')
      await write(response, next.value, signal)
    }
    signal.throwIfAborted()
    response.end()
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => { /* A completed or failed stream needs no further cancellation. */ })
    reader.releaseLock()
  }
}

async function responses(body: Record<string, unknown>, response: ServerResponse, signal: AbortSignal, config: RelayConfig, dependencies: RelayDependencies, chat: boolean): Promise<void> {
  const upstream = await dependencies.requestResponses(chat ? chatRequest(body) : body, signal)
  for (const [key, value] of codexResponseHeaders(upstream.headers)) if (key !== 'content-type') response.setHeader(key, value)
  if (!upstream.ok) { await upstream.body?.cancel(); throw new RelayError(upstream.status, 'subscription_upstream_error', `The subscription upstream returned HTTP ${upstream.status}.`) }
  if (body.stream === true && !chat) { await pipeRaw(upstream, response, signal, config.maxResponseBytes); return }
  const streaming = body.stream === true
  if (streaming) response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' })
  const codec = new ChatStream()
  let terminal: Record<string, unknown> | undefined
  for await (const event of sseEvents(upstream, signal, config.maxResponseBytes)) {
    const completed = completedResponse(event)
    if (completed !== undefined) terminal = completed
    if (streaming) for (const frame of codec.convert(event)) await write(response, frame, signal)
  }
  if (terminal === undefined) throw new RelayError(502, 'incomplete_response', 'The upstream stream ended without a completed response.')
  if (streaming) response.end()
  else sendJson(response, 200, chat ? chatResponse(terminal) : terminal)
}

/** Start one configured listener; shutdown aborts and awaits every owned request.
 * @param config - Explicit settings resolved by the Host composition root.
 * @param dependencies - Injected account transport, model directory and image service.
 * @returns its actual origin, assigned port, and idempotent asynchronous disposer.
 */
export async function startRelay(config: RelayConfig, dependencies: RelayDependencies): Promise<RelayServer> {
  validateConfig(config)
  const signatureKey = randomBytes(32)
  const controllers = new Set<AbortController>()
  const active = new Set<Promise<void>>()
  let origin = ''
  let port = config.port
  let closing: Promise<void> | undefined
  const sign = (keyId: string, path: string, expires: string): Buffer => createHmac('sha256', signatureKey).update(JSON.stringify([keyId, path, expires])).digest()
  const assetUrl = (keyId: string, task: string, asset: string): string => {
    const path = `/v1/images/tasks/${encodeURIComponent(task)}/assets/${encodeURIComponent(asset)}`
    const expires = String(Date.now() + config.assetUrlTtlMs)
    return `${origin}${path}?key_id=${encodeURIComponent(keyId)}&expires=${expires}&signature=${sign(keyId, path, expires).toString('base64url')}`
  }
  const mcp = createImageMcpHandler(config, dependencies, assetUrl)
  const signedKey = (url: URL): string | undefined => {
    const keyId = url.searchParams.get('key_id')
    const expires = url.searchParams.get('expires')
    const supplied = url.searchParams.get('signature')
    if (keyId === null || expires === null || supplied === null) return undefined
    if (!/^\d+$/.test(expires) || Number(expires) < Date.now() || !config.gatewayKeys.some(key => key.id === keyId)) throw new RelayError(401, 'invalid_asset_url', 'The image download URL has expired or is invalid.')
    const expected = sign(keyId, url.pathname, expires)
    const digest = Buffer.from(supplied, 'base64url')
    if (digest.length !== expected.length || !timingSafeEqual(expected, digest)) throw new RelayError(401, 'invalid_asset_url', 'The image download URL has expired or is invalid.')
    return keyId
  }
  const handle = async (request: IncomingMessage, response: ServerResponse, controller: AbortController): Promise<void> => {
    admitOrigin(request, response, config, port)
    if (closing !== undefined) throw new RelayError(503, 'relay_closed', 'The relay is stopping.')
    if (request.method === 'OPTIONS') {
      if (request.headers.origin === undefined) throw new RelayError(403, 'invalid_origin', 'A preflight Origin is required.')
      response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id', 'Access-Control-Max-Age': '0' }).end()
      return
    }
    const url = new URL(request.url ?? '/', origin)
    const assetMatch = /^\/v1\/images\/tasks\/([^/]+)\/assets\/([^/]+)$/.exec(url.pathname)
    const keyId = assetMatch !== null && request.method === 'GET' ? signedKey(url) ?? authenticate(request.headers.authorization, config.gatewayKeys) : authenticate(request.headers.authorization, config.gatewayKeys)
    if (assetMatch === null) {
      const hints = new Headers()
      for (const key of ['originator', 'user-agent', 'version']) {
        const value = request.headers[key]
        if (typeof value === 'string') hints.set(key, value)
      }
      dependencies.observeClient?.(hints)
    }
    const owner: ImageOwner = { kind: 'gateway', keyId }
    if (assetMatch !== null && request.method === 'GET') {
      const taskId = decodeURIComponent(assetMatch[1] ?? '')
      const assetId = decodeURIComponent(assetMatch[2] ?? '')
      const image = await dependencies.readAsset(taskId, assetId, owner)
      if (image.data.byteLength > config.maxResponseBytes) throw new RelayError(413, 'image_too_large', 'The saved image exceeds the response size limit.')
      response.writeHead(200, { 'content-type': image.mimeType, 'content-length': image.data.byteLength, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }).end(image.data)
      return
    }
    if (url.pathname === '/mcp/image' || url.pathname === '/mcp/magpie/image') { await mcp.handle(request, response, keyId, controller.signal); return }
    if (url.pathname === '/v1/models' && request.method === 'GET') {
      const models = await dependencies.listModels(controller.signal)
      sendJson(response, 200, { object: 'list', data: models.map(model => ({ id: model.id, object: 'model', owned_by: 'codex-subscription' })) })
      return
    }
    if (request.method !== 'POST') throw new RelayError(404, 'not_found', 'This gateway route is not available.')
    const paths = ['/v1/responses', '/v1/chat/completions', '/v1/images/generations', '/v1/images/edits']
    if (!paths.includes(url.pathname)) throw new RelayError(404, 'not_found', 'This gateway route is not available.')
    const bytes = await readBody(request, config.maxRequestBytes)
    controller.signal.throwIfAborted()
    const contentType = request.headers['content-type'] ?? ''
    if (url.pathname.startsWith('/v1/images/')) {
      const parsed = await parseImageRequest(bytes, contentType, url.pathname.endsWith('/edits'))
      const initial = await dependencies.images.submit(parsed.input, owner)
      const task = await waitImage(dependencies, initial, owner, config.imageWaitMs, controller.signal)
      let total = 0
      const data: Array<Record<string, string>> = []
      for (const asset of task.assets) {
        if (parsed.format === 'url') data.push({ url: assetUrl(keyId, task.id, asset.id) })
        else {
          const image = await dependencies.readAsset(task.id, asset.id, owner)
          total += Math.ceil(image.data.byteLength / 3) * 4
          if (total > config.maxResponseBytes) throw new RelayError(502, 'response_too_large', 'The image response exceeds the configured size limit.')
          data.push({ b64_json: Buffer.from(image.data).toString('base64') })
        }
      }
      sendJson(response, 200, { created: Math.floor(task.createdAt / 1000), data })
      return
    }
    if (!contentType.startsWith('application/json')) throw new RelayError(415, 'unsupported_media_type', 'Use application/json.')
    const body = jsonBody(bytes)
    if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new RelayError(400, 'invalid_request', 'stream must be a boolean.')
    await responses(object(body), response, controller.signal, config, dependencies, url.pathname === '/v1/chat/completions')
  }
  const server = createServer((request, response) => {
    if (active.size >= config.maxConcurrentRequests) { sendError(response, new RelayError(429, 'gateway_busy', 'The gateway concurrency limit has been reached.')); request.resume(); return }
    const controller = new AbortController()
    controllers.add(controller)
    const disconnected = (): void => { if (!response.writableFinished) controller.abort(new Error('Gateway client disconnected')) }
    const timer = setTimeout(() => { controller.abort(new RelayError(504, 'request_timeout', 'The gateway request timed out. Check any accepted image task before retrying.')); sendError(response, controller.signal.reason) }, config.requestTimeoutMs)
    timer.unref()
    request.once('aborted', disconnected)
    response.once('close', disconnected)
    const operation = handle(request, response, controller).catch((error: unknown) => { request.resume(); sendError(response, controller.signal.aborted ? controller.signal.reason : error) }).finally(() => {
      clearTimeout(timer); request.off('aborted', disconnected); response.off('close', disconnected); controllers.delete(controller); active.delete(operation)
    })
    active.add(operation)
  })
  server.requestTimeout = config.requestTimeoutMs
  server.headersTimeout = config.requestTimeoutMs
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, () => { server.off('error', reject); resolve() }) })
  } catch (error) { await mcp.close(); throw error }
  const address = server.address()
  if (address === null || typeof address === 'string') { await mcp.close(); server.close(); throw new Error('Relay listener has no TCP address') }
  port = address.port
  origin = `http://${config.host === '::1' ? '[::1]' : config.host}:${port}`
  return {
    origin, port,
    close: async () => {
      closing ??= (async () => {
        for (const controller of controllers) controller.abort(new Error('Gateway stopping'))
        await mcp.close()
        const closed = new Promise<void>((resolve, reject) => { server.close(error => { if (error === undefined) resolve(); else reject(error) }) })
        server.closeAllConnections()
        await closed
        await Promise.allSettled(active)
      })()
      await closing
    },
  }
}
