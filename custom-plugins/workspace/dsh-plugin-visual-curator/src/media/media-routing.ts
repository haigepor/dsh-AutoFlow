/** Bounded public-image routing preserves hostnames and certificate validation across DNS failover. */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { z } from 'zod'
import { isPublicAddress, SafeHttpClient, validateEndpoint } from './network.ts'
import type { DnsResolver, HttpClient, HttpRequest, HttpResponse } from './network.ts'
import { MediaError, invalidInput } from './errors.ts'

type Address = Awaited<ReturnType<DnsResolver>>[number]
interface Resolution { addresses: readonly Address[]; ttlMs: number; expiresAt?: number }
/** Deployment-owned limits; empty resolver lists explicitly disable HTTPS DNS fallback. */
export interface MediaRoutingOptions {
  connectTimeoutMs: number
  mediaConnectTimeoutMs: number
  mediaConnectAttempts: number
  mediaDnsResolvers: readonly string[]
  mediaDnsCacheEntries: number
  mediaDnsCacheTtlMs: number
  mediaDnsFailureTtlMs: number
}
/** Same-process test seams; no Client or model input can provide these functions. */
export interface MediaRoutingDependencies {
  lookup?: DnsResolver
  query?: (endpoint: string, hostname: string, signal: AbortSignal) => Promise<Resolution>
  createClient?: (resolve: DnsResolver) => HttpClient
}
const policy = { allowedOrigins: ['https://images.unsplash.com', 'https://plus.unsplash.com'] }
const answerSchema = z.object({ Status: z.number().int(), Answer: z.array(z.object({ type: z.number().int(), data: z.string(), TTL: z.number().nonnegative() })).optional() })
function connectionFailure(error: unknown): boolean {
  return error instanceof MediaError && error.retryable && (error.code === 'remote-connect-timeout' || error.code === 'source-dns-failed'
    || error.code === 'remote-request-failed' && error.diagnostics?.issues.includes('before-response') === true)
}
function verified(addresses: readonly Address[]): readonly Address[] {
  if (!addresses.length || addresses.some(item => ![4, 6].includes(item.family) || isIP(item.address) !== item.family || !isPublicAddress(item.address))) throw invalidInput('Image DNS must return public IP addresses only.')
  return [...new Map(addresses.map(item => [item.address, item])).values()].sort((a, b) => a.family - b.family)
}
async function waitForDns<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort: (() => void) | undefined
  try { return await Promise.race([pending, new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }) })]) }
  finally { if (abort) signal.removeEventListener('abort', abort) }
}

/** Read-only media requests retry resolution only before a response; paid model requests never use this client. */
export class GalleryMediaClient implements HttpClient {
  private readonly lifetime = new AbortController()
  private readonly cache = new Map<string, Resolution & { expiresAt: number }>()
  private readonly failures = new Map<string, number>()
  private readonly inflight = new Map<string, Promise<Resolution>>()
  private readonly lookup: DnsResolver
  private readonly createClient: (resolve: DnsResolver) => HttpClient
  constructor(private readonly options: MediaRoutingOptions, private readonly dependencies: MediaRoutingDependencies = {}) {
    this.lookup = dependencies.lookup ?? (hostname => lookup(hostname, { all: true, verbatim: true }))
    this.createClient = dependencies.createClient ?? (resolve => new SafeHttpClient(policy, resolve))
    for (const endpoint of options.mediaDnsResolvers) {
      const url = new URL(endpoint)
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw invalidInput('HTTPS DNS endpoints must be public HTTPS URLs without credentials, queries or fragments.')
    }
  }

  private remember(key: string, value: Resolution): void {
    this.cache.delete(key)
    this.cache.set(key, { ...value, expiresAt: Math.min(value.expiresAt ?? Date.now() + value.ttlMs, Date.now() + this.options.mediaDnsCacheTtlMs) })
    while (this.cache.size > this.options.mediaDnsCacheEntries) this.cache.delete(this.cache.keys().next().value!)
  }
  private cached(key: string): Resolution | undefined {
    const value = this.cache.get(key)
    if (!value) return undefined
    if (value.expiresAt <= Date.now()) { this.cache.delete(key); return undefined }
    return { addresses: value.addresses, ttlMs: value.expiresAt - Date.now(), expiresAt: value.expiresAt }
  }
  private async queryHttps(endpoint: string, hostname: string): Promise<Resolution> {
    const http = new SafeHttpClient({ allowedOrigins: [new URL(endpoint).origin] }), signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.options.connectTimeoutMs)]), started = Date.now()
    const results = await Promise.allSettled(['A', 'AAAA'].map(async type => {
      const url = new URL(endpoint); url.searchParams.set('name', hostname); url.searchParams.set('type', type)
      // DNS 响应有独立的安全字节上限，不接收任意大小的 JSON。
      const response = await http.request(url.href, { method: 'GET', signal, timeoutMs: this.options.connectTimeoutMs, connectTimeoutMs: this.options.connectTimeoutMs, maxBytes: 65536, maxRedirects: 0, headers: { accept: 'application/dns-json' } })
      if (!/^(application\/dns-json|application\/json)(?:;|$)/i.test(response.headers['content-type'] ?? '')) throw invalidInput('The HTTPS DNS service returned a non-JSON response.')
      const data = answerSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes)))
      if (data.Status !== 0) throw new MediaError('source-dns-failed', 'network', true, 'Image DNS resolution failed.', 'Retry with another configured resolver.')
      return (data.Answer ?? []).filter(item => item.type === 1 || item.type === 28)
    }))
    const rows = results.flatMap(result => result.status === 'fulfilled' ? result.value : [])
    if (!rows.length) throw new MediaError('source-dns-failed', 'network', true, 'No public image address was returned.', 'Check the configured DNS services and network.')
    const addresses = verified(rows.map(item => ({ address: item.data, family: item.type === 1 ? 4 : 6 })))
    return { addresses, ttlMs: Math.max(0, Math.min(...rows.map(item => item.TTL * 1000)) - (Date.now() - started)) }
  }
  private resolveHttps(endpoint: string, hostname: string): Promise<Resolution> {
    const key = `${endpoint}:${hostname}`, cached = this.cached(key)
    if (cached) return Promise.resolve(cached)
    const active = this.inflight.get(key)
    if (active) return active
    const pending = (this.dependencies.query ? this.dependencies.query(endpoint, hostname, this.lifetime.signal) : this.queryHttps(endpoint, hostname)).then(value => {
      const result = { ...value, addresses: verified(value.addresses), expiresAt: Date.now() + Math.min(value.ttlMs, this.options.mediaDnsCacheTtlMs) }
      this.remember(key, result)
      return result
    }).finally(() => { this.inflight.delete(key) })
    this.inflight.set(key, pending)
    return pending
  }

  /** @param raw Authorized public image URL. @param input One shared byte/deadline budget. @returns Image bytes from a verified address without changing the URL. */
  async request(raw: string, input: HttpRequest): Promise<HttpResponse> {
    const target = validateEndpoint(raw, policy)
    if (input.method !== 'GET') throw invalidInput('The image routing client accepts read-only requests.')
    const deadlineAt = Date.now() + input.timeoutMs, deadline = AbortSignal.timeout(input.timeoutMs)
    const signal = AbortSignal.any([this.lifetime.signal, deadline, ...(input.signal ? [input.signal] : [])])
    let attempts = 0, lastError: unknown
    const attempted = new Set<string>()
    const tryAddresses = async (resolution: Resolution, freshRetry = false): Promise<HttpResponse | undefined> => {
      for (const address of verified(resolution.addresses)) {
        signal.throwIfAborted()
        const key = `${target.hostname}:${address.address}`
        if (!freshRetry && (attempted.has(key) || (this.failures.get(key) ?? 0) > Date.now())) continue
        if (attempts >= this.options.mediaConnectAttempts) break
        attempted.add(key); attempts++
        const remaining = Math.max(1, deadlineAt - Date.now())
        try {
          const candidates = resolution.addresses.filter(item => freshRetry || item.address === address.address || !attempted.has(`${target.hostname}:${item.address}`) && (this.failures.get(`${target.hostname}:${item.address}`) ?? 0) <= Date.now())
          const client = this.createClient(async hostname => {
            if (hostname !== target.hostname) throw invalidInput('Cross-host image redirects require a new authorized request.')
            return [address, ...candidates.filter(item => item.address !== address.address)]
          })
          const response = await client.request(raw, { ...input, signal, timeoutMs: remaining, connectTimeoutMs: Math.min(remaining, this.options.mediaConnectTimeoutMs) })
          const winner = resolution.addresses.find(item => item.address === response.remoteAddress) ?? address
          this.remember(`best:${target.hostname}`, { ...resolution, addresses: [winner, ...resolution.addresses.filter(item => item.address !== winner.address)] })
          this.failures.delete(`${target.hostname}:${winner.address}`)
          return response
        } catch (error) {
          if (!connectionFailure(error)) throw error
          lastError = error
          this.failures.delete(key); this.failures.set(key, Date.now() + this.options.mediaDnsFailureTtlMs)
          while (this.failures.size > this.options.mediaDnsCacheEntries) this.failures.delete(this.failures.keys().next().value!)
        }
      }
      return undefined
    }
    try {
      const cached = this.cached(`best:${target.hostname}`)
      if (cached) { const response = await tryAddresses(cached); if (response) return response; this.cache.delete(`best:${target.hostname}`) }
      try {
        const system = await waitForDns(this.lookup(target.hostname), AbortSignal.any([signal, AbortSignal.timeout(this.options.connectTimeoutMs)]))
        const response = await tryAddresses({ addresses: system, ttlMs: this.options.mediaDnsCacheTtlMs })
        if (response) return response
      } catch (error) {
        if (error instanceof MediaError && !connectionFailure(error)) throw error
        if (signal.aborted) throw error
        lastError = error
      }
      for (const endpoint of this.options.mediaDnsResolvers) {
        if (attempts >= this.options.mediaConnectAttempts) break
        signal.throwIfAborted()
        try {
          const resolved = await waitForDns(this.resolveHttps(endpoint, target.hostname), signal)
          const response = await tryAddresses(resolved)
          if (response) return response
          this.cache.delete(`${endpoint}:${target.hostname}`)
        } catch (error) {
          if (error instanceof MediaError && !connectionFailure(error)) throw error
          if (signal.aborted) throw error
          lastError = error
        }
      }
      // 所有地址都曾失败时重新查询一次，避免瞬时丢包把同一 IP 在整个退避期永久排除。
      if (attempts < this.options.mediaConnectAttempts) {
        const endpoint = this.options.mediaDnsResolvers[0]
        try {
          if (endpoint) this.cache.delete(`${endpoint}:${target.hostname}`)
          const fresh = endpoint ? await waitForDns(this.resolveHttps(endpoint, target.hostname), signal)
            : { addresses: await waitForDns(this.lookup(target.hostname), AbortSignal.any([signal, AbortSignal.timeout(this.options.connectTimeoutMs)])), ttlMs: this.options.mediaDnsCacheTtlMs }
          const response = await tryAddresses(fresh, true)
          if (response) return response
        } catch (error) {
          if (error instanceof MediaError && !connectionFailure(error)) throw error
          if (signal.aborted) throw error
          lastError = error
        }
      }
      if (lastError instanceof MediaError) throw lastError
      throw new MediaError('source-dns-failed', 'network', true, 'No reachable image address is available.', 'Check the network and configured DNS services.')
    } catch (error) {
      if (input.signal?.aborted || this.lifetime.signal.aborted) throw new MediaError('cancelled', 'network', false, 'Image request cancelled.', 'Reload explicitly when needed.')
      if (deadline.aborted) throw new MediaError('remote-timeout', 'network', true, 'The image request deadline was reached.', 'Retry within the saved task budget.')
      throw error
    }
  }

  /** Abort active images and shared DNS reads, then drain them before releasing profile caches. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled([...this.inflight.values()])
    this.cache.clear(); this.failures.clear()
  }
}
