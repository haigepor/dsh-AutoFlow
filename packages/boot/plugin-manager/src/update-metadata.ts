/** Profile-owned public metadata requests, finite caches and persistent rate-limit recovery. */
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import z from 'zod'
import type { BundleUpdateInfo } from './types.ts'

/** Deployment settings for one profile's official update checks. */
export interface UpdateMetadataConfig {
  readonly indexes: Readonly<Record<string, string>>
  readonly cacheMs: number
  readonly failureBackoffMs: number
  readonly cacheEntries: number
  readonly timeoutMs: number
  readonly jsonBytes: number
}

type UpdateMetadataFailureKind = NonNullable<BundleUpdateInfo['checkFailure']>['kind']

/** An update check that must not be presented as a successful current-version result. */
export class UpdateMetadataError extends Error {
  /** @param kind - Stable presentation code. @param message - Technical diagnostic. @param retryAt - Earliest retry time, when known. */
  constructor(readonly kind: UpdateMetadataFailureKind, message: string, readonly retryAt?: number) { super(message) }
}

/** Last successful version discovery, independent of a subsequent unavailable check. */
export interface SuccessfulUpdateCheck {
  readonly checkedAt: number
  readonly version?: string
}

/** Borrowed immutable response bytes and the time they were actually obtained. */
export interface UpdateMetadataDocument {
  readonly bytes: Buffer
  readonly checkedAt: number
}

const MAX_DATE_MS = 8640000000000000
const timestamp = z.number().int().nonnegative().max(MAX_DATE_MS)
const storedState = z.object({
  schemaVersion: z.literal(1),
  cooldowns: z.record(z.string(), timestamp),
  checks: z.record(z.string(), z.object({ checkedAt: timestamp, version: z.string().optional() }).strict()),
}).strict()

/** Validate the configured project Pages URL against its declared GitHub repository.
 * @param repository - GitHub owner/repository.
 * @param value - Official project Pages index URL.
 * @returns Normalized HTTPS URL; other hosts, credentials and repository paths reject.
 */
export function officialUpdateIndexUrl(repository: string, value: string): string {
  const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)$/u.exec(repository)
  const owner = match?.[1], project = match?.[2]
  const url = new URL(value)
  if (owner === undefined || project === undefined || url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== ''
    || url.hostname !== `${owner.toLowerCase()}.github.io` || !url.pathname.startsWith(`/${project}/`)
    || url.search !== '' || url.hash !== '') throw new Error('Plugin update index must use its repository project Pages site')
  return url.href
}

/** Shared request and recovery ownership for the manager's complete lifetime. */
export class UpdateMetadata {
  private readonly indexes = new Map<string, string>()
  private readonly cache = new Map<string, UpdateMetadataDocument & { expiresAt: number }>()
  private readonly pending = new Map<string, Promise<UpdateMetadataDocument>>()
  private readonly failures = new Map<string, UpdateMetadataError>()
  private state: z.infer<typeof storedState> = { schemaVersion: 1, cooldowns: {}, checks: {} }
  private loadFailure: UpdateMetadataError | undefined
  private apiTail: Promise<unknown> = Promise.resolve()
  private writes: Promise<void> = Promise.resolve()

  /**
   * @param file - Profile-owned metadata state file, outside archive payloads.
   * @param config - Validated request bounds and repository index declarations.
   * @param signal - Manager lifetime; a single caller never cancels another caller's shared request.
   * @param request - Public HTTP transport; no account credentials are added.
   */
  constructor(private readonly file: string, private readonly config: UpdateMetadataConfig, private readonly signal: AbortSignal,
    private readonly request: typeof fetch = (input, init) => globalThis.fetch(input, init)) {
    for (const [repository, url] of Object.entries(config.indexes)) this.indexes.set(repository, officialUpdateIndexUrl(repository, url))
    try {
      if (existsSync(file)) {
        const details = lstatSync(file)
        if (!details.isFile() || details.isSymbolicLink() || details.size > 262144) throw new Error('Invalid plugin metadata state file')
        this.state = storedState.parse(JSON.parse(readFileSync(file, 'utf8')))
      }
    } catch (error) { this.loadFailure = new UpdateMetadataError('cache', error instanceof Error ? error.message : String(error)) }
  }

  /**
   * Read the configured index for one repository.
   * @param repository - Declared owner/repository.
   * @returns Configured official index, or undefined for REST discovery.
   */
  indexUrl(repository: string): string | undefined { return this.indexes.get(repository) }

  /**
   * Evict invalid bytes and bound repeated validation failures.
   * @param value - Invalid document URL.
   * @param error - Failed validation.
   * @returns Bounded refusal after evicting unusable cached bytes.
   */
  rejectDocument(value: string, error: unknown): UpdateMetadataError {
    this.cache.delete(value)
    const failure = new UpdateMetadataError('invalid-metadata', error instanceof Error ? error.message : String(error), Date.now() + this.config.failureBackoffMs)
    this.failures.set(value, failure)
    this.trim(this.failures)
    return failure
  }

  /**
   * Read the last successful discovery without changing its time.
   * @param repository - Declared repository.
   * @param name - Package identity.
   * @returns Last successful discovery, including after process restart.
   */
  previous(repository: string, name: string): SuccessfulUpdateCheck | undefined {
    const check = this.state.checks[JSON.stringify([repository, name])]
    return check === undefined ? undefined : { checkedAt: check.checkedAt,
      ...(check.version === undefined ? {} : { version: check.version }) }
  }

  /**
   * Record only completely validated discovery results; failure never overwrites the previous version or time.
   * @param repository - Declared repository.
   * @param name - Package identity.
   * @param check - Successful discovery result.
   * @returns Completion of the profile-owned atomic write.
   */
  async remember(repository: string, name: string, check: SuccessfulUpdateCheck): Promise<void> {
    this.state.checks[JSON.stringify([repository, name])] = check
    const entries = Object.entries(this.state.checks).sort((a, b) => b[1].checkedAt - a[1].checkedAt)
    this.state.checks = Object.fromEntries(entries.slice(0, this.config.cacheEntries))
    await this.save()
  }

  /**
   * Read one official document, joining pending work and obeying persisted host cooldowns.
   * @param value - Declared Pages index or official GitHub API/asset URL.
   * @returns Bounded public bytes with their original fetch time; failed or expired results are never reported as fresh.
   */
  read(value: string): Promise<UpdateMetadataDocument> {
    try { this.assertReadable() } catch (error) { return Promise.reject(error instanceof Error ? error : new Error(String(error))) }
    const url = this.allowed(value)
    const cached = this.cache.get(value)
    if (cached !== undefined && cached.expiresAt > Date.now()) return Promise.resolve(cached)
    const failure = this.failures.get(value)
    if (failure?.retryAt !== undefined && failure.retryAt > Date.now()) return Promise.reject(failure)
    const existing = this.pending.get(value)
    if (existing !== undefined) return existing
    const run = async (): Promise<UpdateMetadataDocument> => {
      this.assertReadable()
      this.checkCooldown(url.hostname)
      try {
        const result = await this.download(url)
        try { JSON.parse(result.bytes.toString('utf8')) } catch (error) { throw this.rejectDocument(value, error) }
        this.cache.delete(value)
        this.cache.set(value, { ...result, expiresAt: result.checkedAt + this.config.cacheMs })
        this.trim(this.cache)
        this.failures.delete(value)
        return result
      } catch (error) {
        const failure = error instanceof UpdateMetadataError ? error
          : new UpdateMetadataError('network', error instanceof Error ? error.message : String(error), Date.now() + this.config.failureBackoffMs)
        this.failures.delete(value)
        this.failures.set(value, failure)
        this.trim(this.failures)
        throw failure
      }
    }
    // Queued API requests recheck the shared host cooldown after the preceding request settles.
    const task = (url.hostname === 'api.github.com' ? this.apiTail.then(run, run) : run())
      .finally(() => { this.pending.delete(value) })
    if (url.hostname === 'api.github.com') this.apiTail = task.then(() => {}, () => {})
    this.pending.set(value, task)
    return task
  }

  /**
   * Wait for state persistence before manager teardown completes.
   * @returns Settlement of owned writes; save callers own persistence errors.
   */
  async drain(): Promise<void> { await Promise.allSettled([this.writes]) }

  private trim<T>(entries: Map<string, T>): void {
    for (const key of entries.keys()) {
      if (entries.size <= this.config.cacheEntries) break
      entries.delete(key)
    }
  }

  private assertReadable(): void {
    this.signal.throwIfAborted()
    if (this.loadFailure !== undefined) throw this.loadFailure
  }

  private allowed(value: string, origin?: URL): URL {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') throw new Error('Update metadata requires public HTTPS')
    if (origin?.hostname.endsWith('.github.io') === true) {
      if (url.origin !== origin.origin) throw new Error('Update index redirect left its official Pages origin')
    } else if (![...this.indexes.values()].includes(url.href)
      && !['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) {
      throw new Error('Update metadata must use a declared official source')
    }
    return url
  }

  private checkCooldown(host: string): void {
    const retryAt = this.state.cooldowns[host]
    if (retryAt !== undefined && retryAt > Date.now()) throw new UpdateMetadataError('rate-limited', `Update metadata for ${host} is rate limited`, retryAt)
  }

  private async body(response: Response): Promise<Buffer> {
    if (Number(response.headers.get('content-length') ?? 0) > this.config.jsonBytes) {
      await response.body?.cancel()
      throw new UpdateMetadataError('invalid-metadata', 'Update metadata exceeds its byte bound')
    }
    if (response.body === null) throw new UpdateMetadataError('invalid-metadata', 'Empty update metadata response')
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let size = 0
    try {
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        size += next.value.length
        if (size > this.config.jsonBytes) throw new UpdateMetadataError('invalid-metadata', 'Update metadata exceeds its byte bound')
        chunks.push(Buffer.from(next.value))
      }
    } finally { await reader.cancel(); reader.releaseLock() }
    return Buffer.concat(chunks, size)
  }

  private async download(initial: URL): Promise<UpdateMetadataDocument> {
    let url = initial
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(this.config.timeoutMs)])
    for (let redirects = 0; redirects <= 5; redirects++) {
      this.checkCooldown(url.hostname)
      const response = await this.request(url, { signal, credentials: 'omit', redirect: 'manual',
        headers: { 'User-Agent': 'dsh-plugin-updates', Accept: 'application/json' } })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const target = response.headers.get('location')
        if (target === null) throw new UpdateMetadataError('invalid-metadata', 'Update redirect has no destination')
        url = this.allowed(new URL(target, url).href, initial)
        continue
      }
      if (response.status === 403 || response.status === 429) {
        const bytes = await this.body(response)
        const retry = response.headers.get('retry-after')
        const reset = response.headers.get('x-ratelimit-reset')
        const limited = response.status === 429 || retry !== null || response.headers.get('x-ratelimit-remaining') === '0'
          || /rate limit|secondary rate/iu.test(bytes.toString('utf8'))
        if (limited) {
          const now = Date.now()
          const after = retry === null ? 0 : /^\d+$/u.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry)
          const epoch = reset !== null && /^\d+$/u.test(reset) ? Number(reset) * 1000 : 0
          const retryAt = Math.max(Number.isSafeInteger(after) && after <= MAX_DATE_MS ? after : 0,
            Number.isSafeInteger(epoch) && epoch <= MAX_DATE_MS ? epoch : 0,
            now + this.config.failureBackoffMs)
          this.state.cooldowns[url.hostname] = retryAt
          await this.save()
          throw new UpdateMetadataError('rate-limited', `Update metadata request failed: HTTP ${response.status} (rate limited)`, retryAt)
        }
        throw new UpdateMetadataError('forbidden', 'Update metadata request failed: HTTP 403', Date.now() + this.config.failureBackoffMs)
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new UpdateMetadataError('network', `Update metadata request failed: HTTP ${response.status}`, Date.now() + this.config.failureBackoffMs)
      }
      return { bytes: await this.body(response), checkedAt: Date.now() }
    }
    throw new UpdateMetadataError('invalid-metadata', 'Too many update metadata redirects')
  }

  private async save(): Promise<void> {
    const write = async (): Promise<void> => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      await withFileLock(this.file, async () => {
        if (existsSync(this.file)) {
          const details = lstatSync(this.file)
          if (!details.isFile() || details.isSymbolicLink() || details.size > 262144) throw new Error('Invalid update metadata state file')
          const previous = storedState.parse(JSON.parse(readFileSync(this.file, 'utf8')))
          for (const [host, retryAt] of Object.entries(previous.cooldowns)) {
            this.state.cooldowns[host] = Math.max(this.state.cooldowns[host] ?? 0, retryAt)
          }
          for (const [key, check] of Object.entries(previous.checks)) {
            if ((this.state.checks[key]?.checkedAt ?? -1) < check.checkedAt) this.state.checks[key] = check
          }
        }
        this.state.cooldowns = Object.fromEntries(Object.entries(this.state.cooldowns).filter(([, retryAt]) => retryAt > Date.now()))
        this.state.checks = Object.fromEntries(Object.entries(this.state.checks)
          .sort((a, b) => b[1].checkedAt - a[1].checkedAt).slice(0, this.config.cacheEntries))
        const snapshot = JSON.stringify(this.state) + '\n'
        if (Buffer.byteLength(snapshot) > 262144) throw new Error('Update metadata state exceeds its byte bound')
        await writeFileAtomic(this.file, snapshot, { mode: 0o600 })
      })
    }
    this.writes = this.writes.then(write, write)
    try { await this.writes }
    catch (error) { throw new UpdateMetadataError('cache', error instanceof Error ? error.message : String(error)) }
  }
}
