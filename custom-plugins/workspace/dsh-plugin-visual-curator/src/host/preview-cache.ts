/** Concurrent public previews share bytes only while loading; browser caching owns completed responses. */
import { galleryMediaUrlSchema, type RemoteImageSource } from '../shared/gallery.ts'

/** Resolve the requested representation without rewriting saved reference identities.
 * @param source Authorized, verified public reference descriptor.
 * @param thumbnail Whether the caller requested the grid representation.
 * @returns Independent small URL, or a bounded representation of a legacy Unsplash preview.
 */
export function remotePreviewLocation(source: RemoteImageSource, thumbnail: boolean): string {
  if (!thumbnail) return source.url
  if (source.thumbnailUrl !== source.url) return source.thumbnailUrl
  const url = new URL(galleryMediaUrlSchema.parse(source.thumbnailUrl))
  if (url.hostname !== 'images.unsplash.com') return url.href
  const width = Number(url.searchParams.get('w'))
  url.searchParams.set('w', String(Number.isFinite(width) && width > 0 ? Math.min(width, 400) : 400))
  url.searchParams.set('fit', 'max'); url.searchParams.set('dpr', '1'); url.searchParams.delete('h')
  return url.href
}

/** A validated, bounded raster response without upstream credentials or headers. */
export interface PreviewBytes { bytes: Uint8Array; mime: string }
interface Reader { resolve(value: PreviewBytes): void; reject(error: unknown): void; signal: AbortSignal; abort(): void }
interface Pending { location: string; controller: AbortController; readers: Set<Reader>; done: Promise<void>; finish(): void; started: boolean }

/** Share a public preview request after each caller independently checks image and Session access.
 * @param load Existing allowlisted raster transport and byte/MIME validation.
 * @param capacity Current validated positive limit for unique upstream previews; shared readers occupy one slot.
 * @returns FIFO reads with independent cancellation; no response bytes are retained after completion.
 */
export function createPreviewReads(load: (location: string, signal: AbortSignal) => Promise<PreviewBytes>, capacity: () => number) {
  const pending = new Map<string, Pending>(), jobs = new Set<Promise<void>>(), queued = new Set<Pending>()
  let disposed = false, active = 0
  const aborted = () => new DOMException('Preview read aborted', 'AbortError')
  const detach = (job: Pending, reader: Reader) => { job.readers.delete(reader); reader.signal.removeEventListener('abort', reader.abort) }
  function pump() {
    while (!disposed && active < capacity() && queued.size) {
      const job = queued.values().next().value!; queued.delete(job)
      if (!job.readers.size || job.controller.signal.aborted) { job.finish(); continue }
      job.started = true; active++
      void Promise.resolve().then(() => { job.controller.signal.throwIfAborted(); return load(job.location, job.controller.signal) }).then(value => {
        if (pending.get(job.location) !== job) return
        pending.delete(job.location)
        for (const reader of [...job.readers]) { detach(job, reader); reader.resolve({ bytes: value.bytes.slice(), mime: value.mime }) }
      }, error => {
        if (pending.get(job.location) === job) pending.delete(job.location)
        for (const reader of [...job.readers]) { detach(job, reader); reader.reject(error) }
      }).finally(() => { active--; job.finish(); pump() })
    }
  }
  function enqueue(location: string) {
    const completion = Promise.withResolvers<void>()
    const job: Pending = { location, controller: new AbortController(), readers: new Set(), done: completion.promise, started: false, finish() { jobs.delete(job.done); completion.resolve() } }
    pending.set(location, job); queued.add(job); jobs.add(job.done)
    return job
  }
  return {
    read(location: string, signal: AbortSignal): Promise<PreviewBytes> {
      if (disposed || signal.aborted) return Promise.reject(signal.reason ?? aborted())
      const job = pending.get(location) ?? enqueue(location)
      return new Promise((resolve, reject) => {
        const reader: Reader = { resolve, reject, signal, abort() {
          detach(job, reader); reject(signal.reason ?? aborted())
          if (!job.readers.size) {
            if (pending.get(location) === job) pending.delete(location)
            job.controller.abort()
            if (!job.started) { queued.delete(job); job.finish() }
          }
        } }
        job.readers.add(reader); signal.addEventListener('abort', reader.abort, { once: true })
        if (signal.aborted) reader.abort()
        pump()
      })
    },
    async dispose(): Promise<void> {
      disposed = true
      for (const job of pending.values()) {
        job.controller.abort()
        for (const reader of [...job.readers]) { detach(job, reader); reader.reject(aborted()) }
        if (!job.started) { queued.delete(job); job.finish() }
      }
      pending.clear()
      await Promise.allSettled([...jobs])
    },
  }
}
