/** Session image resources share one cancellable read stream across all mounted cards. */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import { imageSessionViewSchema, type ImageSessionView } from '../shared/image-view.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap { 'codex-images': ImageSessionView }
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap { 'codex-images/unavailable': Record<string, never> }
}

/** Address one Session without borrowing another active tab's identity.
 * @param sessionId Explicit Session identity.
 * @returns Shared resource address.
 */
export function imageSessionAddress(sessionId: string): string { return `dsh-resource://codex-images/session/${encodeURIComponent(sessionId)}` }

function sessionOf(address: string): string | undefined {
  try {
    const url = new URL(address), match = /^\/session\/([^/]+)$/.exec(url.pathname)
    if (url.protocol !== 'dsh-resource:' || url.hostname !== 'codex-images' || !match?.[1]) return undefined
    const id = decodeURIComponent(match[1]); return id.length > 0 && id.length <= 256 ? id : undefined
  } catch { return undefined }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return }
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}

/** Create a framework resource whose release stops reads, never the accepted image task.
 * @param read Owner-authorized Session view callback.
 * @returns Provider with stale-value retention delegated to the framework.
 */
export function createImageResource(read: (sessionId: string, signal: AbortSignal) => Promise<unknown>): ResourceProvider<'codex-images'> {
  return { protocol: 'codex-images', async *open(address, { signal }) {
    const sessionId = sessionOf(address)
    if (!sessionId) { yield { ok: false, error: new RemoteError('codex-images/unavailable', 'Invalid image Session address.', {}) }; return }
    let previous: string | undefined, failed = false, interval = 1000
    while (!signal.aborted) {
      try {
        const value = imageSessionViewSchema.parse(await read(sessionId, signal))
        if (signal.aborted) return
        if (value.sessionId !== sessionId) throw new Error('Image Session mismatch')
        interval = value.pollIntervalMs
        const signature = JSON.stringify(value)
        if (failed || signature !== previous) { yield { ok: true, value }; previous = signature; failed = false }
      } catch (error) {
        if (signal.aborted) return
        // Only the owning locale renders the failure; carrier and backend messages stay private.
        if (!failed) yield { ok: false, error: new RemoteError('codex-images/unavailable', 'Image Session read failed.', {}) }
        failed = true
      }
      await pause(interval, signal)
    }
  } }
}
