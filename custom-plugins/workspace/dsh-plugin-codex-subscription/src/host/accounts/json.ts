/** Bounded JSON decoding for OAuth, model discovery and quota wire responses. */
import { AccountError } from './record.ts'

/** Read JSON while enforcing the byte limit before allocating a complete response. */
export async function readBoundedJson(response: Response, maxBytes: number, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted()
  const declared = response.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel(); throw new AccountError('服务响应超过允许大小。', 'RESPONSE_TOO_LARGE')
  }
  if (!response.body) throw new AccountError('服务返回了空响应。', 'INVALID_RESPONSE')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    for (;;) {
      const result = await reader.read(); signal?.throwIfAborted()
      if (result.done) break
      size += result.value.byteLength
      if (size > maxBytes) { await reader.cancel(); throw new AccountError('服务响应超过允许大小。', 'RESPONSE_TOO_LARGE') }
      chunks.push(result.value)
    }
    const bytes = new Uint8Array(size); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch { throw new AccountError('服务返回了无效 JSON。', 'INVALID_RESPONSE') }
  } finally { signal?.removeEventListener('abort', cancel); reader.releaseLock() }
}
