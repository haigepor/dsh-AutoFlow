/** Bounded HTTP and SSE parsing shared by the relay adapters. */
import { timingSafeEqual, createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createParser } from 'eventsource-parser'
import type { GatewayKey } from './types.ts'
import type { AccountFailureDetails } from '../accounts/record.ts'
import { constants, createGunzip, createZstdDecompress } from 'node:zlib'

/** A public gateway failure with a safe, fixed message. */
export class RelayError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: AccountFailureDetails = {}) { super(message) }
}

/** Parse an untrusted JSON object.
 * @param value - JSON input.
 * @returns the object or a validation failure.
 */
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new RelayError(400, 'invalid_request', 'Expected a JSON object.')
  return value as Record<string, unknown>
}

/** Parse a required nonempty string.
 * @param value - Wire value.
 * @param field - Public parameter name.
 * @returns the parsed string.
 */
export function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new RelayError(400, 'invalid_request', `${field} must be a nonempty string.`)
  return value
}

/** Authenticate a Bearer credential without comparing secret strings directly.
 * @param authorization - The request Authorization header.
 * @param keys - Host-owned gateway credentials.
 * @returns the matching public key id.
 */
export function authenticate(authorization: string | undefined, keys: readonly GatewayKey[]): string {
  const supplied = /^Bearer (.+)$/i.exec(authorization ?? '')?.[1]
  if (supplied === undefined) throw new RelayError(401, 'invalid_api_key', 'A gateway Bearer key is required.')
  const digest = createHash('sha256').update(supplied).digest()
  let found: string | undefined
  for (const key of keys) {
    const expected = createHash('sha256').update(key.secret).digest()
    if (timingSafeEqual(digest, expected)) found = key.id
  }
  if (found === undefined) throw new RelayError(401, 'invalid_api_key', 'The gateway key is invalid.')
  return found
}

/** Read a bounded request before parsing multipart or JSON.
 * @param request - Incoming HTTP body.
 * @param limit - Maximum accepted bytes.
 * @returns the complete bounded buffer.
 */
export async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  if (Number(request.headers['content-length']) > limit) throw new RelayError(413, 'request_too_large', 'The request exceeds the configured size limit.')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > limit) throw new RelayError(413, 'request_too_large', 'The request exceeds the configured size limit.')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, size)
}

/** Decode a bounded wire body with a second bound on expanded bytes and decoder memory.
 * @param body Already bounded compressed bytes.
 * @param encoding Content-Encoding; absent or identity leaves bytes unchanged.
 * @param limit Maximum decoded bytes; also bounds the zstd window.
 * @param signal Existing request deadline and client cancellation.
 * @returns Decoded bytes, or a sanitized encoding/size failure.
 */
export async function decodeBody(body: Buffer, encoding: string | undefined, limit: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted()
  if (encoding === undefined || encoding.trim().toLowerCase() === 'identity') return body
  const name = encoding.trim().toLowerCase()
  if (name !== 'gzip' && name !== 'zstd') throw new RelayError(415, 'unsupported_content_encoding', 'Use identity, gzip or zstd Content-Encoding.')
  const decoder = name === 'gzip' ? createGunzip() : createZstdDecompress({ params: { [constants.ZSTD_d_windowLogMax]: Math.max(10, Math.ceil(Math.log2(limit))) } })
  const abort = (): void => { decoder.destroy(signal.reason instanceof Error ? signal.reason : new Error('Request aborted')) }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const chunks: Buffer[] = []
  let size = 0
  try {
    decoder.end(body)
    for await (const raw of decoder) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      signal.throwIfAborted(); size += chunk.byteLength
      if (size > limit) throw new RelayError(413, 'request_too_large', 'The decoded request exceeds the configured size limit.')
      chunks.push(chunk)
    }
    signal.throwIfAborted()
    return Buffer.concat(chunks, size)
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof RelayError) throw error
    if (error instanceof Error && 'code' in error && error.code === 'ZSTD_error_frameParameter_windowTooLarge') throw new RelayError(413, 'request_too_large', 'The zstd window exceeds the configured size limit.')
    throw new RelayError(400, 'invalid_compressed_body', 'The compressed request is invalid.')
  } finally { signal.removeEventListener('abort', abort); decoder.destroy() }
}

/** Decode one JSON request.
 * @param body - Bounded body bytes.
 * @returns a validated JSON object.
 */
export function jsonBody(body: Buffer): Record<string, unknown> {
  try { return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))) }
  catch (error) {
    if (error instanceof RelayError) throw error
    throw new RelayError(400, 'invalid_json', 'The body must contain valid UTF-8 JSON.')
  }
}

/** Send a structured JSON result.
 * @param response - Outgoing HTTP response.
 * @param status - HTTP status.
 * @param value - Public JSON value.
 */
export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end(JSON.stringify(value))
}

/** Serialize only typed public errors; upstream text may contain credentials.
 * @param response - Outgoing HTTP response.
 * @param error - Failure whose private cause must not be exposed.
 */
export function sendError(response: ServerResponse, error: unknown): void {
  if (response.destroyed) return
  const publicError = error instanceof RelayError ? error : new RelayError(502, 'upstream_error', 'The subscription request failed. Check the plugin account and task status.')
  if (response.headersSent) { response.destroy(); return }
  if (publicError.details.retryAt !== undefined && publicError.details.retryAt > Date.now()) response.setHeader('Retry-After', Math.ceil((publicError.details.retryAt - Date.now()) / 1000))
  if (publicError.details.requestId !== undefined) response.setHeader('x-request-id', publicError.details.requestId)
  sendJson(response, publicError.status, { error: { type: publicError.code, code: publicError.code, message: publicError.message,
    ...(publicError.details.upstreamCode === undefined ? {} : { upstream_code: publicError.details.upstreamCode }),
    ...(publicError.details.retryAt === undefined ? {} : { retry_at: publicError.details.retryAt }),
    ...(publicError.details.authCode === undefined ? {} : { auth_code: publicError.details.authCode }) } })
}

/** Parse bounded upstream SSE JSON without assuming HTTP chunk alignment.
 * @param response - Upstream streaming response.
 * @param signal - Request cancellation.
 * @param limit - Maximum bytes over this request.
 * @returns parsed protocol events.
 */
export async function* sseEvents(response: Response, signal: AbortSignal, limit: number): AsyncGenerator<Record<string, unknown>> {
  if (response.body === null) throw new RelayError(502, 'invalid_upstream', 'The upstream response has no body.')
  const queue: string[] = []
  const parser = createParser({ onEvent: event => { if (event.data !== '[DONE]') queue.push(event.data) }, maxBufferSize: limit })
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const cancel = (): void => { void reader.cancel().catch(() => { /* Cancellation can race upstream teardown. */ }) }
  signal.addEventListener('abort', cancel, { once: true })
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (value !== undefined) {
        size += value.byteLength
        if (size > limit) throw new RelayError(502, 'response_too_large', 'The upstream response exceeds the configured size limit.')
        parser.feed(decoder.decode(value, { stream: true }))
      }
      if (done) parser.feed(`${decoder.decode()}\n\n`)
      while (queue.length > 0) {
        const data = queue.shift()
        try { yield object(JSON.parse(data ?? '')) }
        catch (error) {
          if (error instanceof RelayError && error.status === 502) throw error
          throw new RelayError(502, 'invalid_upstream', 'The upstream returned malformed SSE data.')
        }
      }
      if (done) break
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => { /* The body may already be errored or closed. */ })
    reader.releaseLock()
  }
}

/** Wait for socket backpressure or cancellation without retaining listeners.
 * @param response - Writable HTTP response.
 * @param bytes - Next output bytes.
 * @param signal - Request cancellation.
 */
export async function write(response: ServerResponse, bytes: string | Uint8Array, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (response.write(bytes)) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => { response.off('drain', drained); response.off('close', closed); signal.removeEventListener('abort', aborted) }
    const drained = (): void => { cleanup(); resolve() }
    const closed = (): void => { cleanup(); reject(new Error('HTTP response closed')) }
    const aborted = (): void => { cleanup(); reject(signal.reason) }
    response.once('drain', drained); response.once('close', closed); signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}
