/** One owner-scoped image lane shares pending reads and a bounded Blob cache. */
import { defaultPreviewConcurrency, previewCacheDefaults } from '../shared/gallery-cache.ts'

/** @param value Host-validated image concurrency. @returns Explicit UI image lane size. */
export function resolvePreviewConcurrency(value: number | undefined): number { return value ?? defaultPreviewConcurrency }
/** A consumer owns its object URL until release or cancellation. */
export interface PreviewLease { url: string; release(): void }
interface Consumer { signal: AbortSignal; resolve(value: PreviewLease): void; reject(error: unknown): void; detach(): void }
interface Job { src: string; controller: AbortController; consumers: Set<Consumer> }

/**
 * @param dependencies Concurrency and native browser operations.
 * @returns Shared image reads with independent consumer cancellation and owner disposal.
 */
export function createPreviewLoader(dependencies: { concurrency: number; fetch?: typeof fetch; createObjectURL?: (blob: Blob) => string; revokeObjectURL?: (url: string) => void }) {
  const queued = new Set<Job>(), active = new Set<Job>(), work = new Set<Promise<void>>(), leases = new Set<PreviewLease>()
  const pending = new Map<string, Job>(), cache = new Map<string, { blob: Blob; expires: number }>()
  const request = dependencies.fetch ?? ((input, init) => fetch(input, init))
  const create = dependencies.createObjectURL ?? (blob => URL.createObjectURL(blob)), revoke = dependencies.revokeObjectURL ?? (url => URL.revokeObjectURL(url))
  let concurrency = dependencies.concurrency, policy = previewCacheDefaults, bytes = 0, disposed = false, owner: string | number | undefined
  const aborted = () => new DOMException('Preview load aborted', 'AbortError')
  function forget(src: string) { const value = cache.get(src); if (value) { bytes -= value.blob.size; cache.delete(src) } }
  function trim() {
    const now = Date.now()
    for (const [src, value] of cache) if (value.expires <= now) forget(src)
    while (cache.size > policy.maxEntries || bytes > policy.maxBytes) forget(cache.keys().next().value!)
  }
  function lease(blob: Blob, signal: AbortSignal): PreviewLease {
    signal.throwIfAborted()
    const url = create(blob)
    let released = false
    const value: PreviewLease = { url, release() {
      if (released) return
      released = true; signal.removeEventListener('abort', value.release); leases.delete(value); revoke(url)
    } }
    leases.add(value); signal.addEventListener('abort', value.release, { once: true }); return value
  }
  function reject(job: Job, error: unknown) {
    for (const consumer of job.consumers) { consumer.detach(); consumer.reject(error) }
    job.consumers.clear()
  }
  function clear() {
    cache.clear(); bytes = 0
    for (const job of pending.values()) { job.controller.abort(); reject(job, aborted()) }
    pending.clear(); queued.clear()
    for (const value of [...leases]) value.release()
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
        job.controller.signal.throwIfAborted()
        if (policy.ttlMs > 0 && blob.size <= policy.maxBytes) { forget(job.src); cache.set(job.src, { blob, expires: Date.now() + policy.ttlMs }); bytes += blob.size; trim() }
        for (const consumer of job.consumers) {
          consumer.detach()
          try { consumer.resolve(lease(blob, consumer.signal)) } catch (error) { consumer.reject(error) }
        }
        job.consumers.clear()
      }).catch(error => reject(job, error)).finally(() => {
        if (pending.get(job.src) === job) pending.delete(job.src)
        active.delete(job); work.delete(running); drain()
      })
      work.add(running)
    }
  }
  return {
    configure(value: number, cachePolicy = previewCacheDefaults, ownerScope?: string | number): void {
      if (owner !== ownerScope) { clear(); owner = ownerScope }
      concurrency = value; policy = cachePolicy; disposed = false; trim(); drain()
    },
    load(src: string, signal: AbortSignal): Promise<PreviewLease> {
      if (disposed || signal.aborted) return Promise.reject(signal.reason ?? aborted())
      trim()
      const cached = cache.get(src)
      if (cached) { cache.delete(src); cache.set(src, cached); return Promise.resolve(lease(cached.blob, signal)) }
      return new Promise((resolve, reject) => {
        let job = pending.get(src)
        if (!job) { job = { src, controller: new AbortController(), consumers: new Set() }; pending.set(src, job); queued.add(job) }
        const shared = job
        const abort = () => {
          consumer.detach(); shared.consumers.delete(consumer); reject(signal.reason ?? aborted())
          if (!shared.consumers.size) { queued.delete(shared); shared.controller.abort(); if (pending.get(src) === shared) pending.delete(src) }
          drain()
        }
        const consumer: Consumer = { signal, resolve, reject, detach: () => signal.removeEventListener('abort', abort) }
        shared.consumers.add(consumer); signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort(); else drain()
      })
    },
    async dispose(): Promise<void> { disposed = true; clear(); await Promise.allSettled([...work]) },
  }
}

/** The entry configures the image lane and clears private bytes when its owner changes. */
export const sharedPreviewLoader = createPreviewLoader({ concurrency: defaultPreviewConcurrency })
