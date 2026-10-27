import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingHttpHeaders } from 'node:http'
import ipaddr from 'ipaddr.js'
import { checkCancelled, invalidInput, MediaError } from './errors.ts'

/** Per-attempt bounds, already reserved by the Run owner; this layer never retries. */
export interface RequestBounds { maxBytes: number; timeoutMs: number; maxRedirects: number; signal?: AbortSignal | undefined; connectTimeoutMs?: number | undefined }
/** Request parameters; authentication is sent only to the initial exact origin. */
export interface HttpRequest extends RequestBounds { method: 'GET' | 'POST'; headers?: Readonly<Record<string, string>>; body?: Uint8Array | undefined; onChunk?: (chunk: Uint8Array, contentType: string) => void }
/** Bounded response bytes; upstream URLs and raw failures are not exposed. */
export interface HttpResponse { status: number; headers: Readonly<Record<string, string>>; bytes: Buffer; remoteAddress?: string }
/** An injected fixture implements this interface without changing production DNS policy. */
export interface HttpClient { request(url: string, request: HttpRequest): Promise<HttpResponse> }
/** Only deployment-approved origins may be contacted; the fixed local exception is vision-only. */
export interface NetworkPolicy { allowedOrigins: readonly string[]; localVisionOrigin?: string }
/** DNS records are resolved once and pinned for the ensuing connection. */
export type DnsResolver = (hostname: string) => Promise<readonly { address: string; family: number }[]>

/** Classify all IPv4/IPv6 special ranges, including mapped IPv4, as nonpublic.
 * @param address A DNS-resolved literal IP address.
 * @returns True only for ordinary global unicast addresses.
 */
export function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address)
    return parsed.range() === 'unicast'
  } catch (error) {
    // Invalid DNS records cannot be used as connection targets.
    if (error instanceof Error) return false
    return false
  }
}

function blocked(): MediaError { return new MediaError('invalid-input', 'network', false, 'The request destination is not permitted.', 'Use an approved public origin or the configured fixed local vision service.') }

/** Validate a configured endpoint without resolving DNS or starting a request.
 * @param raw Endpoint URL, never copied into error messages.
 * @param policy Deployment origins and optional exact local vision origin.
 * @returns A permitted URL with no credentials or fragment.
 */
export function validateEndpoint(raw: string, policy: NetworkPolicy): URL {
  let url: URL
  try { url = new URL(raw) } catch (error) {
    // Malformed URLs fail before I/O; do not include their potentially sensitive contents.
    if (error instanceof Error) throw blocked()
    throw blocked()
  }
  if (url.username || url.password || url.hash || !['http:', 'https:'].includes(url.protocol)) throw blocked()
  const local = policy.localVisionOrigin !== undefined && url.origin === policy.localVisionOrigin
  if (!local && (url.protocol !== 'https:' || !policy.allowedOrigins.includes(url.origin))) throw blocked()
  return url
}

function headerRecord(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) if (value !== undefined) result[key] = Array.isArray(value) ? value.join(', ') : value
  return result
}

/** Executes one bounded HTTP attempt with per-hop origin/IP checks and DNS pinning. */
export class SafeHttpClient implements HttpClient {
  constructor(readonly policy: NetworkPolicy, private readonly resolveDns: DnsResolver = hostname => lookup(hostname, { all: true, verbatim: true })) {
    for (const origin of policy.allowedOrigins) {
      let url: URL
      try { url = new URL(origin) } catch (error) {
        if (error instanceof Error) throw invalidInput('Allowed network origins must be valid URLs.')
        throw invalidInput('Allowed network origins must be valid URLs.')
      }
      if (url.origin !== origin || (url.protocol !== 'https:' && origin !== policy.localVisionOrigin) || url.username || url.password) throw invalidInput('Allowed network origins must be exact HTTPS origins or the fixed local vision origin.')
    }
    if (policy.localVisionOrigin !== undefined) {
      const url = new URL(policy.localVisionOrigin)
      if (url.origin !== policy.localVisionOrigin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalidInput('The local vision exception must be one exact HTTP or HTTPS origin.')
    }
  }

  /** Send a single logical attempt; redirects share its byte/time bound and cannot carry credentials to another origin.
   * @param raw Initial configured endpoint or approved media location.
   * @param input Caller-reserved request bounds and optional API authentication.
   * @returns Bounded response; non-success statuses become safe typed failures.
   */
  async request(raw: string, input: HttpRequest): Promise<HttpResponse> {
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0 || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0
      || !Number.isSafeInteger(input.maxRedirects) || input.maxRedirects < 0) throw invalidInput('HTTP request bounds must be finite positive integers.')
    checkCancelled(input.signal)
    const initialOrigin = validateEndpoint(raw, this.policy).origin
    const controller = new AbortController()
    const cancel = () => controller.abort()
    input.signal?.addEventListener('abort', cancel, { once: true })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, input.timeoutMs)
    let url = raw
    let method = input.method
    let body = input.body
    let headers: Readonly<Record<string, string>> = input.headers ?? {}
    try {
      for (let hop = 0; ; hop++) {
        const target = validateEndpoint(url, this.policy)
        const response = await this.once(target, { ...input, method, body, headers, signal: controller.signal })
        if (![301, 302, 303, 307, 308].includes(response.status)) {
          if (response.status < 200 || response.status >= 300) throw new MediaError(response.status === 401 || response.status === 403 ? 'configuration-required' : 'remote-request-failed', 'network', response.status === 429 || response.status >= 500, 'The remote service rejected the request.', 'Check service configuration or retry within the task budget.')
          return response
        }
        if (hop >= input.maxRedirects || response.headers.location === undefined) throw blocked()
        const next = validateEndpoint(new URL(response.headers.location, target).href, this.policy)
        if (next.origin !== initialOrigin) {
          // 不向 CDN 或跨域重定向发送任何 API 自定义头，避免非标准密钥头泄露。
          headers = { accept: input.headers?.accept ?? '*/*' }
          if (method !== 'GET') throw blocked()
        }
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) { method = 'GET'; body = undefined }
        url = next.href
      }
    } catch (error) {
      if (input.signal?.aborted) throw new MediaError('cancelled', 'network', false, 'Operation cancelled.', 'Resume the operation explicitly.')
      if (timedOut) throw new MediaError('remote-timeout', 'network', true, 'The remote request timed out.', 'Retry within the remaining request and time budgets.')
      if (error instanceof MediaError) throw error
      const issue = error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'network-failure'
      throw new MediaError('remote-request-failed', 'network', true, 'The remote request could not be completed.', 'Check connectivity and retry within the task budget.', { modelOutput: null, issues: [issue] })
    } finally { clearTimeout(timer); input.signal?.removeEventListener('abort', cancel) }
  }

  private async once(url: URL, input: HttpRequest): Promise<HttpResponse> {
    checkCancelled(input.signal)
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    let abortDns: (() => void) | undefined
    let records: readonly { address: string; family: number }[]
    try {
      records = await Promise.race([
        this.resolveDns(hostname),
        new Promise<never>((_resolve, reject) => {
          abortDns = () => reject(new MediaError('cancelled', 'network', false, 'Operation cancelled.', 'Resume the operation explicitly.'))
          if (input.signal?.aborted) abortDns()
          else input.signal?.addEventListener('abort', abortDns, { once: true })
        }),
      ])
    } finally { if (abortDns !== undefined) input.signal?.removeEventListener('abort', abortDns) }
    checkCancelled(input.signal)
    if (records.length === 0 || records.some(record => record.family !== 4 && record.family !== 6) || (url.origin !== this.policy.localVisionOrigin && records.some(record => !isPublicAddress(record.address)))) throw blocked()
    const address = records[0]
    if (address === undefined || (address.family !== 4 && address.family !== 6)) throw blocked()
    return await new Promise<HttpResponse>((resolveResponse, reject) => {
      let responseStarted = false
      let connectTimer: ReturnType<typeof setTimeout> | undefined
      const clearConnectTimer = () => { clearTimeout(connectTimer); connectTimer = undefined }
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: input.method, headers: { ...input.headers, host: url.host }, signal: input.signal,
        agent: false, ...(input.connectTimeoutMs === undefined ? { family: address.family } : { autoSelectFamily: true }),
        // DNS 只解析一次；连接使用已检查地址，TLS 仍校验证书中的原始主机名。
        lookup: (_host, options, callback) => {
          // 原生连接竞速只使用本次已检查的地址，HTTP 正文仍只发送到胜出的单个连接。
          if (options.all) callback(null, [...records])
          else callback(null, address.address, address.family)
        },
      }, response => {
        responseStarted = true; clearConnectTimer()
        const remoteAddress = response.socket.remoteAddress
        const headers = headerRecord(response.headers)
        if (headers['content-encoding'] !== undefined && headers['content-encoding'] !== 'identity') { response.destroy(); reject(new MediaError('remote-protocol-error', 'network', false, 'Compressed responses are not supported.', 'Configure the service to return an identity response.')); return }
        const declared = headers['content-length']
        if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > input.maxBytes)) { response.destroy(); reject(new MediaError('budget-exhausted', 'network', false, 'The remote response exceeds the configured byte limit.', 'Increase the allowed response size or request a smaller resource.')); return }
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > input.maxBytes) { response.destroy(); reject(new MediaError('budget-exhausted', 'network', false, 'The remote response exceeds the configured byte limit.', 'Request a smaller resource.')); return }
          chunks.push(chunk)
          try { if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) input.onChunk?.(chunk, headers['content-type'] ?? '') }
          catch (error) { response.destroy(); reject(error) }
        })
        response.on('error', reject)
        response.on('end', () => resolveResponse({ status: response.statusCode ?? 0, headers, bytes: Buffer.concat(chunks, size), ...(remoteAddress ? { remoteAddress } : {}) }))
      })
      if (input.connectTimeoutMs !== undefined) {
        connectTimer = setTimeout(() => {
          request.destroy(new MediaError('remote-connect-timeout', 'network', true, 'The remote connection could not be established in time.', 'Retry resolution within the request deadline.', { modelOutput: null, issues: ['before-response', 'connect-timeout'] }))
        }, input.connectTimeoutMs)
        request.on('socket', socket => socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', clearConnectTimer))
      }
      request.on('close', clearConnectTimer)
      request.on('error', error => {
        clearConnectTimer()
        if (error instanceof MediaError) { reject(error); return }
        const code = 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'network-failure'
        const certificate = /CERT|TLS_CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)
        reject(new MediaError(certificate ? 'remote-certificate-error' : 'remote-request-failed', 'network', !certificate, certificate ? 'The image server certificate could not be verified.' : 'The remote connection failed.', certificate ? 'Correct the local trust configuration.' : 'Retry within the request deadline.', { modelOutput: null, issues: [code, ...(responseStarted ? [] : ['before-response'])] }))
      })
      request.end(input.body)
    })
  }
}
