/** A strict protocol allowlist excludes local authorization and account-specific entitlement headers. */
import type { IncomingMessage } from 'node:http'
import { RelayError } from './http.ts'
import type { RelayRequestContext } from './types.ts'

const allowed = new Set(['x-codex-turn-metadata', 'x-codex-window-id', 'x-codex-installation-id', 'x-codex-parent-thread-id',
  'x-openai-subagent', 'x-openai-memgen-request', 'x-openai-internal-codex-responses-lite', 'x-client-request-id', 'x-codex-turn-state'])

/** Select bounded, single-value protocol metadata after local authentication.
 * @param source External headers, never a source of subscription credentials.
 * @returns Detached allowed headers; oversized metadata is rejected before dispatch.
 */
export function protocolHeaders(source: Headers): Headers {
  const headers = new Headers()
  let size = 0
  for (const [key, value] of source) if (allowed.has(key)) {
    size += key.length + value.length
    if (value.length > 4096 || size > 16_384 || /[\r\n\0]/.test(value)) throw new RelayError(431, 'metadata_too_large', 'Protocol metadata exceeds its size limit.')
    headers.set(key, value)
  }
  return headers
}

/** Build context only from an already authenticated gateway request.
 * @param request Incoming HTTP or WebSocket upgrade request.
 * @param keyId Public id of the verified local gateway key.
 * @returns A key-scoped context containing no local credential.
 */
export function relayContext(request: IncomingMessage, keyId: string): RelayRequestContext {
  const headers = new Headers()
  for (const [key, value] of Object.entries(request.headers)) if (allowed.has(key) && typeof value === 'string') headers.set(key, value)
  return { keyId, headers: protocolHeaders(headers) }
}
