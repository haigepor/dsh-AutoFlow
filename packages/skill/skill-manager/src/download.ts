/** Bounded response reading shared by repository and marketplace downloads. */
import { ManagementError } from './files.ts'

/** Read response bytes and release the stream on completion or rejection.
 * @param response - Download response; unsuccessful or missing bodies are rejected.
 * @param maxBytes - Maximum bytes retained from the response body.
 * @returns Complete bytes within the configured limit.
 */
export async function readDownload(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.ok || response.body === null) throw new ManagementError('network')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.length
      if (total > maxBytes) throw new ManagementError('too-large')
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}
