/** Resumable full update downloads; release metadata and installation remain owned by electron-updater. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { DesktopDownloadChoice, DesktopDownloadProgress } from './ipc.ts'

export type { DesktopDownloadChoice, DesktopDownloadProgress } from './ipc.ts'

/** Public artifact proxies only; the original release URL is always retained. */
export const DESKTOP_DOWNLOAD_SOURCES = [
  { id: 'github', name: 'GitHub', prefix: '', automatic: true },
  { id: 'gh-proxy', name: 'GH-Proxy', prefix: 'https://gh-proxy.com/', automatic: true },
  { id: 'gh-proxy-org', name: 'GH-Proxy.org', prefix: 'https://gh-proxy.org/', automatic: true },
  { id: 'ghfast', name: 'GHFast', prefix: 'https://ghfast.top/', automatic: true },
  { id: 'ghproxy', name: 'GHProxy.net', prefix: 'https://ghproxy.net/', automatic: false },
] as const

/** Deployment and test controls for bounded probing and source switching. */
export interface DesktopDownloadConfig {
  readonly directory: string
  readonly idleTimeoutMs: number
  readonly probeTimeoutMs: number
  readonly probeBytes: number
  readonly probeCacheMs: number
  readonly slowWindowMs: number
  readonly minimumBytesPerSecond: number
}

/** Trusted file identity taken from the checked update feed. */
export interface DesktopDownloadArtifact { readonly url: URL; readonly version: string; readonly size: number; readonly sha512: string }

/** Pausing preserves the checkpoint and does not authorize installation. */
export class DesktopDownloadPaused extends Error {
  constructor() { super('Desktop update download paused'); this.name = 'DesktopDownloadPaused' }
}

class SourceChanged extends Error {}
class InvalidArtifact extends Error {}

interface Source { readonly id: string; readonly url: string }

/**
 * @param directory - App-owned persistent download cache.
 * @param env - Process settings; omitted values use bounded desktop defaults.
 * @returns Validated download timing, probe, and throughput settings.
 */
export function desktopDownloadConfig(directory: string, env: NodeJS.ProcessEnv): DesktopDownloadConfig {
  const number = (name: string, fallback: number, minimum: number, maximum = 2_147_483_647): number => {
    const value = Number(env[name] ?? fallback)
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`desktop update: invalid ${name}`)
    return value
  }
  return { directory, idleTimeoutMs: number('DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS', 60_000, 1000),
    probeTimeoutMs: number('DSH_DESKTOP_UPDATE_PROBE_TIMEOUT_MS', 4000, 1000),
    probeBytes: number('DSH_DESKTOP_UPDATE_PROBE_BYTES', 131_072, 1024, 1_048_576),
    probeCacheMs: number('DSH_DESKTOP_UPDATE_PROBE_CACHE_MS', 300_000, 1000),
    slowWindowMs: number('DSH_DESKTOP_UPDATE_SLOW_WINDOW_MS', 30_000, 1000),
    minimumBytesPerSecond: number('DSH_DESKTOP_UPDATE_MINIMUM_BYTES_PER_SECOND', 32_768, 1) }
}

/** Owns one contiguous, flushed partial file outside electron-updater's disposable pending directory. */
export class DesktopUpdateDownload {
  private choice: DesktopDownloadChoice = { source: 'auto' }
  private progress: DesktopDownloadProgress | undefined
  private controller: AbortController | undefined
  private paused = false
  private running = false
  private preferences: Promise<void> = Promise.resolve()
  private readonly partial: string
  private readonly checkpoint: string
  private ranking: { identity: string; at: number; sources: string[] } | undefined

  /**
   * @param config - Private cache directory and bounded network timing.
   * @param fetch - Electron session fetch in production, standard fetch at the transport test boundary.
   * @param publish - Shell progress observer; never marks a release ready for installation.
   */
  constructor(private readonly config: DesktopDownloadConfig, private readonly fetch: typeof globalThis.fetch,
    private readonly publish: (progress: DesktopDownloadProgress) => void) {
    this.partial = join(config.directory, 'payload.part')
    this.checkpoint = join(config.directory, 'checkpoint.json')
  }

  /** Restore the source preference; invalid local settings are reported without replacing the document. */
  async initialize(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(join(this.config.directory, 'source.json'), 'utf8'))
      this.choice = this.validateChoice(value)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('desktop update: could not restore download source', error)
    }
  }

  /** Latest source choice and observable transfer, including paused bytes. */
  get state(): DesktopDownloadProgress {
    return this.progress ?? { stage: 'idle', choice: this.choice, transferred: 0, total: 0, bytesPerSecond: 0,
      sources: DESKTOP_DOWNLOAD_SOURCES.map(({ id, name }) => ({ id, name })) }
  }

  /** Whether the full-file transport currently owns a request or final verification. */
  get isRunning(): boolean { return this.running }

  /** Release the extra partial copy only after the native updater has completed platform preparation. */
  async complete(): Promise<void> {
    await this.reset()
    this.progress = undefined
  }

  /**
   * Persist a validated preference before changing a running request.
   * @param value - Shell-supplied source ID and optional HTTPS proxy prefix.
   * @returns Completion of the serialized preference write and request interruption.
   */
  select(value: unknown): Promise<void> {
    const choice = this.validateChoice(value)
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
  pause(): void { this.paused = true; this.controller?.abort(new DesktopDownloadPaused()) }

  /** Abort network activity on shutdown; the caller awaits the updater operation before releasing its owner. */
  dispose(): void { this.pause() }

  /**
   * Download one checked file into the native updater's temporary destination after full SHA512 verification.
   * @param artifact - Immutable feed version, original URL, byte length, and SHA512.
   * @param destination - Native updater-owned temporary path.
   * @param signal - Native cancellation, when present; absence leaves cancellation to pause/dispose.
   * @returns The prepared destination; native signature and platform preparation still run afterwards.
   */
  async download(artifact: DesktopDownloadArtifact, destination: string, signal?: AbortSignal): Promise<string> {
    if (this.running) throw new Error('desktop update: another full download is active')
    this.running = true
    this.paused = false
    await this.preferences
    const identity = createHash('sha256').update(JSON.stringify([artifact.version, artifact.url.href, artifact.size, artifact.sha512])).digest('hex')
    const rejected = new Set<string>()
    let source: string | undefined
    let bytes = 0
    try {
      await mkdir(this.config.directory, { recursive: true, mode: 0o700 })
      bytes = await this.restore(identity, artifact.size)
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
            if (first === undefined) throw new Error('Desktop update download sources are unavailable; retained bytes can be retried')
            let selected: Source
            if (this.choice.source === 'auto' && candidates.length > 1) {
              this.report('probing', bytes, artifact.size, 0)
              selected = await this.fastest(candidates, artifact.size, identity, controller.signal) ?? first
            } else selected = first
            source = selected.id
            this.report('downloading', bytes, artifact.size, 0, source)
            bytes = await this.transfer(selected, artifact, identity, bytes, controller.signal)
          } catch (error) {
            // The checkpoint, rather than a sparse/truncated temporary file's size, owns the reusable prefix.
            bytes = await this.restore(identity, artifact.size)
            this.assertContinuing(signal)
            if (controller.signal.reason instanceof SourceChanged) { rejected.clear(); continue }
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
        const actual = await this.hashFile('sha512')
        if (actual !== artifact.sha512) {
          await this.reset()
          bytes = await this.restore(identity, artifact.size)
          if (this.choice.source === 'auto' && source !== undefined) {
            rejected.add(source)
            if (this.sources(artifact.url).some(item => !rejected.has(item.id))) continue
          }
          throw new InvalidArtifact('Desktop update SHA512 mismatch; the untrusted partial file was discarded')
        }
        this.assertContinuing(signal)
        await copyFile(this.partial, destination)
        return destination
      }
    } catch (error) {
      this.report(error instanceof DesktopDownloadPaused ? 'paused' : 'failed', bytes, artifact.size, 0, source)
      throw error
    } finally { this.running = false; this.controller = undefined }
  }

  private validateChoice(value: unknown): DesktopDownloadChoice {
    if (typeof value !== 'object' || value === null || !('source' in value) || typeof value.source !== 'string') {
      throw new Error('desktop update: invalid download source')
    }
    if (value.source === 'auto' || DESKTOP_DOWNLOAD_SOURCES.some(item => item.id === value.source)) return { source: value.source }
    if (value.source !== 'custom' || !('customPrefix' in value) || typeof value.customPrefix !== 'string' || value.customPrefix.length > 2048) {
      throw new Error('desktop update: unknown download source')
    }
    const url = new URL(value.customPrefix)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
      throw new Error('desktop update: custom proxy must be an HTTPS prefix without credentials, query, or fragment')
    }
    return { source: 'custom', customPrefix: `${url.href.replace(/\/+$/u, '')}/` }
  }

  private sources(original: URL): Source[] {
    const publicRelease = original.protocol === 'https:' && original.hostname === 'github.com'
      && original.username === '' && original.password === '' && original.search === ''
      && /^\/[^/]+\/[^/]+\/releases\/download\//u.test(original.pathname)
    const available: Source[] = [{ id: 'github', url: original.href }]
    if (publicRelease) {
      for (const entry of DESKTOP_DOWNLOAD_SOURCES.slice(1)) {
        if (this.choice.source !== 'auto' || entry.automatic) available.push({ id: entry.id, url: `${entry.prefix}${original.href}` })
      }
      if (this.choice.customPrefix !== undefined) available.push({ id: 'custom', url: `${this.choice.customPrefix}${original.href}` })
    }
    if (this.choice.source === 'auto') return available
    const selected = available.find(item => item.id === this.choice.source)
    if (selected === undefined) throw new Error('Desktop update mirrors support only public GitHub Release assets')
    return [selected]
  }

  private assertContinuing(signal?: AbortSignal): void {
    if (this.paused) throw new DesktopDownloadPaused()
    signal?.throwIfAborted()
  }

  private async fastest(sources: readonly Source[], total: number, identity: string, signal: AbortSignal): Promise<Source | undefined> {
    if (this.ranking?.identity === identity && Date.now() - this.ranking.at < this.config.probeCacheMs) {
      for (const id of this.ranking.sources) {
        const source = sources.find(item => item.id === id)
        if (source !== undefined) return source
      }
    }
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
          if (response.body === null) throw new Error('Desktop update probe returned no body')
          const reader = response.body.getReader()
          let received = 0
          try {
            for (;;) {
              const item = await reader.read()
              if (item.done) break
              received += item.value.byteLength
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
    this.ranking = { identity, at: Date.now(), sources: [...scores.map(item => item.source.id), ...sources.map(item => item.id)] }
    // A server can support full downloads without Range; it is still usable from byte zero.
    return scores[0]?.source ?? sources.find(item => item.id === 'github')
  }

  private async transfer(source: Source, artifact: DesktopDownloadArtifact, identity: string,
    offset: number, signal: AbortSignal): Promise<number> {
    const controller = new AbortController()
    const abort = (): void => { controller.abort(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => { controller.abort(new Error('Desktop update connection timed out')) }, this.config.idleTimeoutMs)
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
    let windowStarted = started
    let windowBytes = bytes
    const monitor = setInterval(() => {
      const now = performance.now()
      if (this.choice.source === 'auto' && (bytes - windowBytes) * 1000 / Math.max(1, now - windowStarted) < this.config.minimumBytesPerSecond) {
        controller.abort(new Error('Desktop update source remained slow; trying another source'))
      }
      windowStarted = now; windowBytes = bytes
    }, this.config.slowWindowMs)
    try {
      signal.throwIfAborted()
      refresh()
      const response = await this.fetch(source.url, { headers: { Range: `bytes=${offset}-`, 'Accept-Encoding': 'identity' },
        credentials: 'omit', signal: controller.signal })
      if (response.status !== 206 && !(response.status === 200 && offset === 0)) {
        await response.body?.cancel(); throw new Error(`Desktop update source rejected download (${response.status})`)
      }
      if (response.status === 206 && response.headers.get('content-range') !== `bytes ${offset}-${artifact.size - 1}/${artifact.size}`) {
        await response.body?.cancel(); throw new Error('Desktop update source returned an incorrect resume range')
      }
      if (response.headers.get('content-encoding') !== null && response.headers.get('content-encoding') !== 'identity') {
        await response.body?.cancel(); throw new Error('Desktop update source returned encoded artifact bytes')
      }
      if (response.body === null) throw new Error('Desktop update source returned no body')
      reader = response.body.getReader()
      for (;;) {
        const item = await reader.read()
        if (item.done) break
        refresh()
        if (bytes + item.value.byteLength > artifact.size) throw new InvalidArtifact('Desktop update source exceeded the checked file size')
        let written = 0
        while (written < item.value.byteLength) {
          const result = await file.write(item.value, written, item.value.byteLength - written, bytes + written)
          if (result.bytesWritten === 0) throw new Error('Desktop update cache write made no progress')
          written += result.bytesWritten
        }
        digest.update(item.value)
        bytes += written
        if (bytes - committed >= 1024 * 1024) {
          await file.sync()
          await this.writeJson('checkpoint.json', { identity, bytes, sha256: digest.copy().digest('hex') })
          committed = bytes
        }
        const now = performance.now()
        const rate = (bytes - offset) * 1000 / Math.max(1, now - started)
        if (now - lastReport >= 250) { this.report('downloading', bytes, artifact.size, rate, source.id); lastReport = now }
      }
      if (bytes !== artifact.size) throw new Error('Desktop update response ended before the checked file size')
      return bytes
    } finally {
      clearTimeout(timer)
      clearInterval(monitor)
      signal.removeEventListener('abort', abort)
      controller.abort()
      await reader?.cancel().catch(() => { /* Preserve the completed prefix even when the response was interrupted. */ })
      try {
        await file.sync()
        await this.writeJson('checkpoint.json', { identity, bytes, sha256: digest.digest('hex') })
      } finally { await file.close() }
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
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('desktop update: discarded an invalid checkpoint', error)
      await this.reset()
      const file = await open(this.partial, 'w', 0o600)
      await file.close()
      return 0
    }
  }

  private async hashFile(algorithm: 'sha256' | 'sha512'): Promise<string> {
    const digest = createHash(algorithm)
    for await (const chunk of createReadStream(this.partial)) digest.update(chunk as Buffer)
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

  private report(stage: DesktopDownloadProgress['stage'], transferred: number, total: number, bytesPerSecond: number, source?: string): void {
    this.progress = { stage, choice: this.choice, transferred, total, bytesPerSecond,
      ...(source === undefined ? {} : { source }),
      ...(bytesPerSecond > 0 ? { remainingSeconds: Math.ceil((total - transferred) / bytesPerSecond) } : {}),
      sources: DESKTOP_DOWNLOAD_SOURCES.map(({ id, name }) => ({ id, name })) }
    this.publish(this.progress)
  }
}
