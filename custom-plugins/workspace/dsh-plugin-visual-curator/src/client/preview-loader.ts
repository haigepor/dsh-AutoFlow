/** One Client image lane keeps same-origin connections available for commands and metadata. */
import { defaultPreviewConcurrency } from '../shared/gallery-cache.ts'

/** @param value Host-validated image concurrency, absent on an older projection. @returns Explicit UI image lane size. */
export function resolvePreviewConcurrency(value: number | undefined): number { return value ?? defaultPreviewConcurrency }

/** A displayed Blob URL belongs to its consumer until release or cancellation. */
export interface PreviewLease { url: string; release(): void }
interface Job { src: string; signal: AbortSignal; controller: AbortController; resolve(value: PreviewLease): void; reject(error: unknown): void; detach(): void }

/** Queue image fetches independently of Run budgets; completed images stay in the browser cache.
 * @param dependencies Concurrency and native browser operations, replaceable in isolated tests.
 * @returns A cancellable shared image lane and owner disposal.
 */
export function createPreviewLoader(dependencies: { concurrency: number; fetch?: typeof fetch; createObjectURL?: (blob: Blob) => string; revokeObjectURL?: (url: string) => void }) {
  const queued = new Set<Job>(), active = new Set<Job>(), work = new Set<Promise<void>>(), leases = new Set<PreviewLease>()
  const request = dependencies.fetch ?? ((input, init) => fetch(input, init))
  const create = dependencies.createObjectURL ?? (blob => URL.createObjectURL(blob)), revoke = dependencies.revokeObjectURL ?? (url => URL.revokeObjectURL(url))
  let concurrency = dependencies.concurrency, disposed = false
  const aborted = () => new DOMException('Preview load aborted', 'AbortError')
  function lease(blob: Blob, signal: AbortSignal): PreviewLease {
    signal.throwIfAborted()
    const url = create(blob)
    let released = false
    const value: PreviewLease = { url, release() {
      if (released) return
      released = true; signal.removeEventListener('abort', value.release); leases.delete(value); revoke(url)
    } }
    leases.add(value); signal.addEventListener('abort', value.release, { once: true })
    return value
  }
  function drain() {
    while (!disposed && active.size < concurrency && queued.size) {
      const job = queued.values().next().value!
      queued.delete(job); active.add(job)
      const running = Promise.resolve().then(async () => {
        job.controller.signal.throwIfAborted()
        const response = await request(job.src, { credentials: 'same-origin', referrerPolicy: 'no-referrer', signal: job.controller.signal })
        if (!response.ok) throw new Error('Preview media unavailable')
        const blob = await response.blob()
        job.controller.signal.throwIfAborted(); job.resolve(lease(blob, job.signal))
      }).catch(error => job.reject(error)).finally(() => { job.detach(); active.delete(job); work.delete(running); drain() })
      work.add(running)
    }
  }
  return {
    configure(value: number): void { concurrency = value; disposed = false; drain() },
    load(src: string, signal: AbortSignal): Promise<PreviewLease> {
      if (disposed || signal.aborted) return Promise.reject(signal.reason ?? aborted())
      return new Promise((resolve, reject) => {
        const controller = new AbortController()
        const abort = () => { queued.delete(job); job.detach(); controller.abort(signal.reason); reject(signal.reason ?? aborted()); drain() }
        const job: Job = { src, signal, controller, resolve, reject, detach: () => signal.removeEventListener('abort', abort) }
        signal.addEventListener('abort', abort, { once: true }); queued.add(job)
        if (signal.aborted) abort(); else drain()
      })
    },
    async dispose(): Promise<void> {
      disposed = true
      for (const job of queued) { job.detach(); job.controller.abort(); job.reject(aborted()) }
      queued.clear()
      for (const job of active) job.controller.abort()
      for (const value of [...leases]) value.release()
      await Promise.allSettled([...work])
    },
  }
}

/** The entry owns configuration and disposal; every preview factory shares these same image slots. */
export const sharedPreviewLoader = createPreviewLoader({ concurrency: defaultPreviewConcurrency })
