/** Verified public artifact transfers shared by desktop installers and plugin archives. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { ArtifactDownloadRangeCache } from './artifact-download-cache.ts'
import type { ArtifactDownloadChoice, ArtifactDownloadProgress } from './artifact-download-types.ts'
export type { ArtifactDownloadChoice, ArtifactDownloadProgress } from './artifact-download-types.ts'

/** Public artifact proxies only; the original release URL is always retained. */
export const ARTIFACT_DOWNLOAD_SOURCES = [
  { id: 'github', name: 'GitHub', prefix: '', automatic: true },
  { id: 'gh-proxy', name: 'GH-Proxy', prefix: 'https://gh-proxy.com/', automatic: true },
  { id: 'gh-proxy-org', name: 'GH-Proxy.org', prefix: 'https://gh-proxy.org/', automatic: true },
  { id: 'ghfast', name: 'GHFast', prefix: 'https://ghfast.top/', automatic: true },
  { id: 'ghproxy', name: 'GHProxy.net', prefix: 'https://ghproxy.net/', automatic: false },
] as const

/** Deployment and test controls for bounded probing and source switching. */
export interface ArtifactDownloadConfig {
  /** Owner-private persistent cache directory; never a package-manager disposable directory. */
  readonly directory: string
  /** Maximum time without response headers or received body bytes. */
  readonly idleTimeoutMs: number
  /** Deadline for each bounded public-source probe. */
  readonly probeTimeoutMs: number
  /** Largest byte range used by a source probe. */
  readonly probeBytes: number
  /** Lifetime of the ranked source list for this artifact. */
  readonly probeCacheMs: number
  /** Measurement window before a slow automatic source fails over. */
  readonly slowWindowMs: number
  /** Lowest accepted average throughput in the slow-source window. */
  readonly minimumBytesPerSecond: number
  /** Maximum concurrent Range requests, from one through sixteen. */
  readonly connections: number
  /** Requested interval size; existing journals retain their original interval size. */
  readonly pieceBytes: number
}

/** Owner-local diagnostics; no installer URLs, credentials, or renderer IPC are included. */
export interface ArtifactDownloadMeasurement {
  readonly phase: 'probe' | 'first-byte' | 'checkpoint' | 'restore' | 'transfer' | 'verify' | 'copy'
  readonly durationMs: number
  readonly bytes: number
}

/** Trusted file identity taken from the checked update feed. */
export interface ArtifactDownloadArtifact { readonly url: URL; readonly version: string; readonly size: number; readonly checksum: { readonly algorithm: 'sha512'; readonly value: string } | { readonly algorithm: 'sha256'; readonly value: string } }

/**
 * Validate a public source preference at configuration, persisted-file and UI boundaries.
 * @param value - Source ID with an optional public HTTPS mirror prefix.
 * @returns Normalized source; credentials, query strings and insecure URLs reject.
 */
export function parseArtifactDownloadChoice(value: unknown): ArtifactDownloadChoice {
  if (typeof value !== 'object' || value === null || !('source' in value) || typeof value.source !== 'string') {
    throw new Error('artifact download: invalid download source')
  }
  if (value.source === 'auto' || ARTIFACT_DOWNLOAD_SOURCES.some(item => item.id === value.source)) return { source: value.source }
  if (value.source !== 'custom' || !('customPrefix' in value) || typeof value.customPrefix !== 'string' || value.customPrefix.length > 2048) {
    throw new Error('artifact download: unknown download source')
  }
  const url = new URL(value.customPrefix)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('artifact download: custom proxy must be an HTTPS prefix without credentials, query, or fragment')
  }
  return { source: 'custom', customPrefix: `${url.href.replace(/\/+$/u, '')}/` }
}

/** Pausing preserves the checkpoint and does not authorize installation. */
export class ArtifactDownloadPaused extends Error {
  constructor() { super('Artifact download paused'); this.name = 'ArtifactDownloadPaused' }
}

class SourceChanged extends Error {}
class InvalidArtifact extends Error {}
class RangeUnsupported extends Error {}

interface Source { readonly id: string; readonly url: string }


/** Owns one full-file transfer and its verified caches outside the updater's disposable pending directory. */
export class ArtifactDownload {
  private choice: ArtifactDownloadChoice = { source: 'auto' }
  private progress: ArtifactDownloadProgress | undefined
  private controller: AbortController | undefined
  private paused = false
  private running = false
  private preferences: Promise<void> = Promise.resolve()
  private readonly partial: string
  private readonly checkpoint: string
  private ranking: { identity: string; at: number; sources: string[] } | undefined
  private rangeCache: ArtifactDownloadRangeCache | undefined

  /**
   * @param config - Private cache directory and bounded network timing.
   * @param fetch - Owner's public-byte transport, retaining its proxy and certificate policy.
   * @param publish - Shell progress observer; never marks a release ready for installation.
   * @param measured - Optional timing observer for owner-local performance qualification; omitted in ordinary launches.
   */
  constructor(private readonly config: ArtifactDownloadConfig, private readonly fetch: typeof globalThis.fetch,
    private readonly publish: (progress: ArtifactDownloadProgress) => void,
    private readonly measured?: (measurement: ArtifactDownloadMeasurement) => void) {
    this.partial = join(config.directory, 'payload.part')
    this.checkpoint = join(config.directory, 'checkpoint.json')
  }

  /** Restore the source preference; invalid local settings are reported without replacing the document. */
  async initialize(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(join(this.config.directory, 'source.json'), 'utf8'))
      this.choice = parseArtifactDownloadChoice(value)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('artifact download: could not restore download source', error)
    }
  }

  /** Latest source choice and observable transfer, including paused bytes. */
  get state(): ArtifactDownloadProgress {
    return this.progress ?? { stage: 'idle', choice: this.choice, transferred: 0, total: 0, bytesPerSecond: 0,
      sources: ARTIFACT_DOWNLOAD_SOURCES.map(({ id, name }) => ({ id, name })) }
  }

  /** Whether the full-file transport currently owns a request or final verification. */
  get isRunning(): boolean { return this.running }

  /** Release extra transfer bytes only after the consumer validates its prepared artifact. */
  async complete(): Promise<void> {
    await this.rangeCache?.reset()
    await this.reset()
    this.progress = undefined
  }

  /**
   * Persist a validated preference before changing a running request.
   * @param value - Shell-supplied source ID and optional HTTPS proxy prefix.
   * @returns Completion of the serialized preference write and request interruption.
   */
  select(value: unknown): Promise<void> {
    const choice = parseArtifactDownloadChoice(value)
    const operation = this.preferences.then(async () => {
      await this.writeJson('source.json', choice)
      this.choice = choice
      this.ranking = undefined
      this.controller?.abort(new SourceChanged())
      if (this.progress !== undefined) this.report(this.progress.stage, this.progress.transferred, this.progress.total, 0)
    })
    this.preferences = operation.catch(() => { /* The caller reports a failed preference write; later changes remain usable. */ })
    return operation
  }

  /** Preserve completed bytes and interrupt the current probe or transfer. */
  pause(): void { this.paused = true; this.controller?.abort(new ArtifactDownloadPaused()) }

  /** Abort network activity on shutdown; the caller awaits the updater operation before releasing its owner. */
  dispose(): void { this.pause() }

  /**
   * Download a checked artifact after full size and manifest checksum verification.
   * @param artifact - Immutable version, original URL, byte length, and official checksum.
   * @param destination - Consumer-owned destination, written after verification.
   * @param signal - Owner cancellation; absence leaves cancellation to pause/dispose.
   * @returns Verified destination; package validation and installation remain consumer-owned.
   */
  async download(artifact: ArtifactDownloadArtifact, destination: string, signal?: AbortSignal): Promise<string> {
    if (this.running) throw new Error('artifact download: another full download is active')
    this.running = true
    this.paused = false
    await this.preferences
    const identity = createHash('sha256').update(JSON.stringify([artifact.version, artifact.url.href, artifact.size, artifact.checksum.algorithm === 'sha512' ? artifact.checksum.value : `sha256:${artifact.checksum.value}`])).digest('hex')
    const rejected = new Set<string>()
    let source: string | undefined
    let bytes = 0
    try {
      await mkdir(this.config.directory, { recursive: true, mode: 0o700 })
      const restoring = performance.now()
      bytes = await this.restore(identity, artifact.size)
      const ranges = new ArtifactDownloadRangeCache(this.config.directory, identity, artifact.size, this.config.pieceBytes,
        (durationMs, saved) => { this.measured?.({ phase: 'checkpoint', durationMs, bytes: saved }) })
      let useRanges = (this.config.connections > 1 && artifact.size > this.config.pieceBytes) || await ranges.exists()
      if (useRanges) { await ranges.restore(this.partial, bytes); bytes = ranges.bytes }
      this.rangeCache = useRanges ? ranges : undefined
      this.measure('restore', restoring, bytes)
      for (;;) {
        while (bytes < artifact.size) {
          this.assertContinuing(signal)
          const controller = new AbortController()
          this.controller = controller
          const abort = (): void => { controller.abort(signal?.reason) }
          signal?.addEventListener('abort', abort, { once: true })
          try {
            const candidates = this.sources(artifact.url).filter(item => !rejected.has(item.id))
            const first = candidates[0]
            if (first === undefined) throw new Error('Artifact download sources are unavailable; retained bytes can be retried')
            let selected: Source
            if (this.choice.source === 'auto' && candidates.length > 1) {
              this.report('probing', bytes, artifact.size, 0)
              selected = await this.fastest(candidates, artifact.size, identity, controller.signal) ?? first
            } else selected = first
            source = selected.id
            this.report('downloading', bytes, artifact.size, 0, source)
            const transferring = performance.now()
            bytes = useRanges ? await this.transferRanges(selected, artifact, ranges, controller.signal)
              : await this.transfer(selected, artifact, identity, bytes, controller.signal)
            this.measure('transfer', transferring, bytes)
          } catch (error) {
            bytes = useRanges ? ranges.bytes : await this.restore(identity, artifact.size)
            this.assertContinuing(signal)
            if (controller.signal.reason instanceof SourceChanged) { rejected.clear(); continue }
            // A fresh non-Range source gets one ordinary full request after every interval writer has stopped.
            if (error instanceof RangeUnsupported && bytes === 0) {
              await ranges.reset()
              useRanges = false; this.rangeCache = undefined; continue
            }
            if (this.choice.source !== 'auto' || source === undefined
              || /^(?:ENOSPC|EACCES|EPERM|EIO|EROFS)$/u.test(String((error as NodeJS.ErrnoException).code))) throw error
            rejected.add(source)
            if (this.sources(artifact.url).every(item => rejected.has(item.id))) throw error
          } finally {
            signal?.removeEventListener('abort', abort)
            if (this.controller === controller) this.controller = undefined
          }
        }
        this.assertContinuing(signal)
        this.report('verifying', bytes, artifact.size, 0, source)
        const payload = useRanges ? ranges.payload : this.partial
        const verifying = performance.now()
        const actual = await this.hashFile(artifact.checksum.algorithm, payload)
        this.measure('verify', verifying, bytes)
        if ((await stat(payload)).size !== artifact.size || actual !== artifact.checksum.value) {
          await ranges.reset()
          await this.reset()
          bytes = await this.restore(identity, artifact.size)
          if (useRanges) await ranges.restore(this.partial, bytes)
          if (this.choice.source === 'auto' && source !== undefined) {
            rejected.add(source)
            if (this.sources(artifact.url).some(item => !rejected.has(item.id))) continue
          }
          throw new InvalidArtifact(`Artifact download ${artifact.checksum.algorithm.toUpperCase()} mismatch; the untrusted partial file was discarded`)
        }
        this.assertContinuing(signal)
        const copying = performance.now()
        await copyFile(payload, destination)
        this.measure('copy', copying, bytes)
        return destination
      }
    } catch (error) {
      this.report(error instanceof ArtifactDownloadPaused ? 'paused' : 'failed', bytes, artifact.size, 0, source)
      throw error
    } finally { this.running = false; this.controller = undefined }
  }

  private sources(original: URL): Source[] {
    const publicRelease = original.protocol === 'https:' && original.hostname === 'github.com'
      && original.username === '' && original.password === '' && original.search === ''
      && /^\/[^/]+\/[^/]+\/releases\/download\//u.test(original.pathname)
    const available: Source[] = [{ id: 'github', url: original.href }]
    if (publicRelease) {
      for (const entry of ARTIFACT_DOWNLOAD_SOURCES.slice(1)) {
        if (this.choice.source !== 'auto' || entry.automatic) available.push({ id: entry.id, url: `${entry.prefix}${original.href}` })
      }
      if (this.choice.customPrefix !== undefined) available.push({ id: 'custom', url: `${this.choice.customPrefix}${original.href}` })
    }
    if (this.choice.source === 'auto') return available
    const selected = available.find(item => item.id === this.choice.source)
    if (selected === undefined) throw new Error('Artifact download mirrors support only public GitHub Release assets')
    return [selected]
  }

  private assertContinuing(signal?: AbortSignal): void {
    if (this.paused) throw new ArtifactDownloadPaused()
    signal?.throwIfAborted()
  }

  private async fastest(sources: readonly Source[], total: number, identity: string, signal: AbortSignal): Promise<Source | undefined> {
    if (this.ranking?.identity === identity && Date.now() - this.ranking.at < this.config.probeCacheMs) {
      for (const id of this.ranking.sources) {
        const source = sources.find(item => item.id === id)
        if (source !== undefined) return source
      }
    }
    const probing = performance.now()
    let probeBytes = 0
    const scores: { source: Source; rate: number }[] = []
    for (let index = 0; index < sources.length; index += 2) {
      await Promise.all(sources.slice(index, index + 2).map(async (source) => {
        const controller = new AbortController()
        const abort = (): void => { controller.abort(signal.reason) }
        signal.addEventListener('abort', abort, { once: true })
        const timer = setTimeout(() => { controller.abort() }, this.config.probeTimeoutMs)
        const started = performance.now()
        try {
          const end = Math.min(this.config.probeBytes, total) - 1
          const response = await this.fetch(source.url, { headers: { Range: `bytes=0-${end}`, 'Accept-Encoding': 'identity' },
            credentials: 'omit', signal: controller.signal })
          if (response.status !== 206 || response.headers.get('content-range') !== `bytes 0-${end}/${total}`) {
            await response.body?.cancel(); return
          }
          if (response.body === null) throw new Error('Artifact download probe returned no body')
          const reader = response.body.getReader()
          let received = 0
          try {
            for (;;) {
              const item = await reader.read()
              if (item.done) break
              received += item.value.byteLength
              probeBytes += item.value.byteLength
              if (received > end + 1) throw new Error('oversized probe response')
            }
          } finally { await reader.cancel().catch(() => { /* Probe failure is contained to this source. */ }) }
          if (received === end + 1) scores.push({ source, rate: received / Math.max(1, performance.now() - started) })
        } catch (_error) {
          // Unreachable or non-range sources are excluded from this bounded selection, not from later retries.
        } finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
      }))
      signal.throwIfAborted()
    }
    scores.sort((left, right) => right.rate - left.rate)
    this.measure('probe', probing, probeBytes)
    this.ranking = { identity, at: Date.now(), sources: [...scores.map(item => item.source.id), ...sources.map(item => item.id)] }
    // A server can support full downloads without Range; it is still usable from byte zero.
    return scores[0]?.source ?? sources.find(item => item.id === 'github')
  }

  private async transfer(source: Source, artifact: ArtifactDownloadArtifact, identity: string,
    offset: number, signal: AbortSignal): Promise<number> {
    const controller = new AbortController()
    const abort = (): void => { controller.abort(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => { controller.abort(new Error('Artifact download connection timed out')) }, this.config.idleTimeoutMs)
    }
    let bytes = offset
    let committed = offset
    const digest = createHash('sha256')
    // No encoding is configured: Node file streams yield Buffer chunks.
    if (offset > 0) for await (const chunk of createReadStream(this.partial, { end: offset - 1 })) digest.update(chunk as Buffer)
    const file = await open(this.partial, 'r+')
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const started = performance.now()
    let lastReport = started - 250
    let receivedFirstByte = false
    let windowStarted = started
    let windowBytes = bytes
    const monitor = setInterval(() => {
      const now = performance.now()
      if (this.choice.source === 'auto' && (bytes - windowBytes) * 1000 / Math.max(1, now - windowStarted) < this.config.minimumBytesPerSecond) {
        controller.abort(new Error('Artifact download source remained slow; trying another source'))
      }
      windowStarted = now; windowBytes = bytes
    }, this.config.slowWindowMs)
    try {
      signal.throwIfAborted()
      refresh()
      const response = await this.fetch(source.url, { headers: { Range: `bytes=${offset}-`, 'Accept-Encoding': 'identity' },
        credentials: 'omit', signal: controller.signal })
      if (response.status !== 206 && !(response.status === 200 && offset === 0)) {
        await response.body?.cancel(); throw new Error(`Artifact download source rejected download (${response.status})`)
      }
      if (response.status === 206 && response.headers.get('content-range') !== `bytes ${offset}-${artifact.size - 1}/${artifact.size}`) {
        await response.body?.cancel(); throw new Error('Artifact download source returned an incorrect resume range')
      }
      if (response.headers.get('content-encoding') !== null && response.headers.get('content-encoding') !== 'identity') {
        await response.body?.cancel(); throw new Error('Artifact download source returned encoded artifact bytes')
      }
      if (response.body === null) throw new Error('Artifact download source returned no body')
      reader = response.body.getReader()
      for (;;) {
        const item = await reader.read()
        if (item.done) break
        refresh()
        if (!receivedFirstByte) { this.measure('first-byte', started, item.value.byteLength); receivedFirstByte = true }
        if (bytes + item.value.byteLength > artifact.size) throw new InvalidArtifact('Artifact download source exceeded the checked file size')
        let written = 0
        while (written < item.value.byteLength) {
          const result = await file.write(item.value, written, item.value.byteLength - written, bytes + written)
          if (result.bytesWritten === 0) throw new Error('Artifact download cache write made no progress')
          written += result.bytesWritten
        }
        digest.update(item.value)
        bytes += written
        if (bytes - committed >= 1024 * 1024) {
          const saving = performance.now()
          await file.sync()
          await this.writeJson('checkpoint.json', { identity, bytes, sha256: digest.copy().digest('hex') })
          this.measure('checkpoint', saving, bytes - committed)
          committed = bytes
        }
        const now = performance.now()
        const rate = (bytes - offset) * 1000 / Math.max(1, now - started)
        if (now - lastReport >= 250) { this.report('downloading', bytes, artifact.size, rate, source.id); lastReport = now }
      }
      if (bytes !== artifact.size) throw new Error('Artifact download response ended before the checked file size')
      return bytes
    } finally {
      clearTimeout(timer)
      clearInterval(monitor)
      signal.removeEventListener('abort', abort)
      controller.abort()
      await reader?.cancel().catch(() => { /* Preserve the completed prefix even when the response was interrupted. */ })
      try {
        const saving = performance.now()
        await file.sync()
        await this.writeJson('checkpoint.json', { identity, bytes, sha256: digest.digest('hex') })
        this.measure('checkpoint', saving, bytes - committed)
      } finally { await file.close() }
    }
  }

  private async transferRanges(source: Source, artifact: ArtifactDownloadArtifact, cache: ArtifactDownloadRangeCache,
    signal: AbortSignal): Promise<number> {
    const controller = new AbortController()
    const abort = (): void => { controller.abort(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    let file
    try { file = await open(cache.payload, 'r+') }
    catch (error) { signal.removeEventListener('abort', abort); throw error }
    const started = performance.now()
    const initial = cache.bytes
    const received = Array.from({ length: cache.count }, (_, index) => cache.saved(index))
    const totalReceived = (): number => received.reduce((sum, value) => sum + value, 0)
    const admitted = Promise.withResolvers<void>()
    let cursor = 0
    let failure: { error: unknown } | undefined
    let lastReport = started - 250
    let firstByte = false
    let windowStarted = started
    let windowBytes = initial
    const monitor = setInterval(() => {
      const now = performance.now(), bytes = totalReceived()
      if (this.choice.source === 'auto' && (bytes - windowBytes) * 1000 / Math.max(1, now - windowStarted) < this.config.minimumBytesPerSecond) {
        controller.abort(new Error('Artifact download source remained slow; trying another source'))
      }
      windowStarted = now; windowBytes = bytes
    }, this.config.slowWindowMs)
    const worker = async (first = false): Promise<void> => {
      try {
        for (;;) {
          controller.signal.throwIfAborted()
          const index = cursor++
          if (index >= cache.count) return
          const saved = cache.saved(index)
          const length = cache.length(index)
          if (saved === length) continue
          let bytes = saved
          let persisted = saved
          // Across all active connections, at most about one MiB can be outside a durable checkpoint.
          const checkpointBytes = Math.max(65536, Math.floor(1024 * 1024 / this.config.connections))
          const digest = createHash('sha256')
          if (saved > 0) for await (const chunk of createReadStream(cache.payload,
            { start: cache.start(index), end: cache.start(index) + saved - 1 })) digest.update(chunk as Buffer)
          const request = new AbortController()
          const interrupt = (): void => { request.abort(controller.signal.reason) }
          controller.signal.addEventListener('abort', interrupt, { once: true })
          let timer: ReturnType<typeof setTimeout> | undefined
          const refresh = (): void => {
            clearTimeout(timer)
            timer = setTimeout(() => { request.abort(new Error('Artifact download connection timed out')) }, this.config.idleTimeoutMs)
          }
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
          try {
            controller.signal.throwIfAborted()
            refresh()
            const start = cache.start(index) + saved, end = cache.start(index) + length - 1
            const response = await this.fetch(source.url, { headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' },
              credentials: 'omit', cache: 'no-store', signal: request.signal })
            if (response.status !== 206) {
              await response.body?.cancel()
              if (response.status === 200) throw new RangeUnsupported('Artifact download source does not support Range; saved intervals are retained')
              throw new Error(`Artifact download source rejected download (${response.status})`)
            }
            if (response.headers.get('content-range') !== `bytes ${start}-${end}/${artifact.size}`
              || ![null, 'identity'].includes(response.headers.get('content-encoding'))
              || (response.headers.has('content-length') && Number(response.headers.get('content-length')) !== end - start + 1)) {
              await response.body?.cancel(); throw new Error('Artifact download source returned an incorrect segment range or encoding')
            }
            if (response.body === null) throw new Error('Artifact download source returned no body')
            if (first) { admitted.resolve(); first = false }
            reader = response.body.getReader()
            for (;;) {
              const item = await reader.read()
              if (item.done) break
              refresh()
              if (!firstByte) { this.measure('first-byte', started, item.value.byteLength); firstByte = true }
              if (bytes + item.value.byteLength > length) throw new InvalidArtifact('Artifact download source exceeded the checked segment size')
              let consumed = 0
              while (consumed < item.value.byteLength) {
                const size = Math.min(item.value.byteLength - consumed, checkpointBytes - (bytes - persisted))
                let written = 0
                while (written < size) {
                  const result = await file.write(item.value, consumed + written, size - written, cache.start(index) + bytes + written)
                  if (result.bytesWritten === 0) throw new Error('Artifact download cache write made no progress')
                  written += result.bytesWritten
                }
                digest.update(item.value.subarray(consumed, consumed + written))
                bytes += written; consumed += written; received[index] = bytes
                if (bytes - persisted >= checkpointBytes) {
                  await cache.save(index, bytes, digest.copy().digest('hex'), file)
                  persisted = bytes
                }
              }
              const now = performance.now()
              if (now - lastReport >= 250) {
                const transferred = totalReceived()
                this.report('downloading', transferred, artifact.size, (transferred - initial) * 1000 / Math.max(1, now - started), source.id)
                lastReport = now
              }
            }
            if (bytes !== length) throw new Error('Artifact download segment ended before the checked length')
          } finally {
            clearTimeout(timer)
            controller.signal.removeEventListener('abort', interrupt)
            request.abort()
            await reader?.cancel().catch(() => { /* The interval journal retains only bytes already written. */ })
            if (bytes > persisted) await cache.save(index, bytes, digest.digest('hex'), file)
          }
        }
      } catch (error) {
        failure ??= { error }
        admitted.reject(error)
        controller.abort(error)
      }
    }
    try {
      signal.throwIfAborted()
      // Admit extra connections only after this source has accepted an exact interval request.
      const first = worker(true)
      await admitted.promise.catch(() => { /* The first worker owns and reports the failure after all writers settle. */ })
      await Promise.all([first, ...Array.from({ length: controller.signal.aborted ? 0 : this.config.connections - 1 }, () => worker())])
      if (failure !== undefined) throw failure.error
      controller.signal.throwIfAborted()
      return cache.bytes
    } finally {
      clearInterval(monitor)
      signal.removeEventListener('abort', abort)
      controller.abort()
      await file.close()
    }
  }

  private async restore(identity: string, total: number): Promise<number> {
    try {
      const value: unknown = JSON.parse(await readFile(this.checkpoint, 'utf8'))
      if (typeof value !== 'object' || value === null || !('identity' in value) || value.identity !== identity
        || !('bytes' in value) || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes)
        || value.bytes < 0 || value.bytes > total || !('sha256' in value) || typeof value.sha256 !== 'string'
        || (await stat(this.partial)).size < value.bytes) throw new Error('invalid download checkpoint')
      const file = await open(this.partial, 'r+')
      try { await file.truncate(value.bytes) } finally { await file.close() }
      if (await this.hashFile('sha256') !== value.sha256) throw new Error('download checkpoint bytes changed')
      return value.bytes
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('artifact download: discarded an invalid checkpoint', error)
      await this.reset()
      const file = await open(this.partial, 'w', 0o600)
      await file.close()
      return 0
    }
  }

  private async hashFile(algorithm: 'sha256' | 'sha512', path = this.partial): Promise<string> {
    const digest = createHash(algorithm)
    for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer)
    return digest.digest(algorithm === 'sha512' ? 'base64' : 'hex')
  }

  private async reset(): Promise<void> {
    for (const path of [this.checkpoint, this.partial]) {
      try { await unlink(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }

  private async writeJson(name: string, value: unknown): Promise<void> {
    await mkdir(this.config.directory, { recursive: true, mode: 0o700 })
    const path = join(this.config.directory, name)
    await writeFileAtomic(path, `${JSON.stringify(value)}\n`, { mode: 0o600, dirMode: 0o700 })
  }

  private measure(phase: ArtifactDownloadMeasurement['phase'], started: number, bytes: number): void {
    this.measured?.({ phase, durationMs: performance.now() - started, bytes })
  }

  private report(stage: ArtifactDownloadProgress['stage'], transferred: number, total: number, bytesPerSecond: number, source?: string): void {
    this.progress = { stage, choice: this.choice, transferred, total, bytesPerSecond,
      ...(source === undefined ? {} : { source }),
      ...(bytesPerSecond > 0 ? { remainingSeconds: Math.ceil((total - transferred) / bytesPerSecond) } : {}),
      sources: ARTIFACT_DOWNLOAD_SOURCES.map(({ id, name }) => ({ id, name })) }
    this.publish(this.progress)
  }
}
