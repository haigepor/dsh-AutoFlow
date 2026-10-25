/** Resolve credential references at dispatch; saved configuration contains no secret values. */
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { CompatibleVisionProvider, SafeHttpClient, SourceHttpProvider, type ImageSourceProvider, type RequestBounds, type HttpClient } from '../media/index.ts'
import { UnsplashApi, UnsplashSourceProvider } from '../media/unsplash.ts'
import { CurlUnsplashTransport } from '../media/unsplash-transport.ts'
import type { CuratorConfig } from './config.ts'
import type { WorkContext } from './runtime.ts'
import { CuratorError } from '../shared/errors.ts'
import { createHash } from 'node:crypto'

/** @param config Frozen task settings. @param context Current budget and abort signal. @returns Bounded one-attempt settings. */
export function requestBounds(config: CuratorConfig, context: WorkContext): RequestBounds {
  const remaining = context.ledger.snapshot().deadlineAt - Date.now()
  if (remaining <= 0) throw new CuratorError('budget-exhausted', 'request', 'The task deadline has passed.')
  return { signal: context.signal, maxBytes: config.limits.maxResponseBytes, timeoutMs: Math.min(config.limits.requestTimeoutMs, remaining), maxRedirects: config.limits.maxRedirects }
}

/** Provider creation validates supported capabilities before a paid task can start. */
export class ProviderFactory {
  private readonly galleryClients = new Map<string, { signature: string; api: UnsplashApi }>()
  constructor(private readonly credentials: Pick<CredentialProvider, 'resolve'>) {}
  private async headers(ref: string): Promise<Record<string, string>> {
    if (!ref) return {}
    const secret = await this.credentials.resolve(credentialRef(ref))
    if (!secret) throw new CuratorError('capability-unavailable', 'credentials', 'A configured credential reference is unavailable.')
    return { authorization: `Bearer ${secret.value}` }
  }
  async vision(config: CuratorConfig): Promise<CompatibleVisionProvider> {
    if (!config.vision.endpoint || !config.vision.model || !config.vision.supportsJson) throw new CuratorError('capability-unavailable', 'vision-preflight', 'Configure a vision model with JSON output support.')
    const origin = new URL(config.vision.endpoint).origin
    const http = new SafeHttpClient({ allowedOrigins: [origin], ...(config.vision.localOrigin ? { localVisionOrigin: config.vision.localOrigin } : {}) })
    return new CompatibleVisionProvider({ endpoint: config.vision.endpoint, model: config.vision.model, supportsMultiImage: config.vision.supportsMultipleImages, maxImages: config.limits.maxReferenceImages + 2, maxImageBytes: config.limits.maxReferenceBytes, maxRequestBytes: config.limits.maxVisionRequestBytes, maxOutputTokens: config.limits.maxVisionOutputTokens, temperature: config.limits.visionTemperature, ...(config.vision.vendorVersion ? { declaredModelVersion: config.vision.vendorVersion } : {}), ...(config.vision.reasoningEffort ? { reasoningEffort: config.vision.reasoningEffort } : {}), ...(config.vision.supportsStreaming !== undefined ? { supportsStreaming: config.vision.supportsStreaming } : {}) }, http, await this.headers(config.vision.credentialRef))
  }
  async source(config: CuratorConfig): Promise<ImageSourceProvider> {
    if (config.source.provider === 'unsplash') return new UnsplashSourceProvider(await this.gallery(config, config.source.unsplash.defaultAccountId ?? undefined))
    if (!config.source.endpoint) throw new CuratorError('capability-unavailable', 'source-preflight', 'Configure the image source endpoint.')
    const s = config.source, response = { id: s.idPointer, previewUrl: s.previewPointer, originalUrl: s.originalPointer, width: s.widthPointer, height: s.heightPointer }
    return new SourceHttpProvider({ endpoint: s.endpoint, method: s.method, request: { query: s.queryField, cursor: s.cursorField, pageSize: s.pageSizeField }, response: { ...response, items: s.itemsPointer, nextCursor: s.nextCursorPointer }, maxPageSize: config.limits.pageSize, ...(s.lookupEndpoint ? { lookup: { endpoint: s.lookupEndpoint, method: 'GET' as const, idField: 'id', response } } : {}) }, new SafeHttpClient({ allowedOrigins: [new URL(s.endpoint).origin] }), await this.headers(s.credentialRef))
  }
  media(config: CuratorConfig): HttpClient {
    if (config.source.provider === 'unsplash') return new SafeHttpClient({ allowedOrigins: ['https://images.unsplash.com', 'https://plus.unsplash.com'] })
    return new SafeHttpClient({ allowedOrigins: [...new Set([new URL(config.source.endpoint).origin, ...config.source.allowedMediaOrigins])] })
  }
  /** @param config Frozen deployment settings. @param accountId Saved account, or absent for public search. @param provisionalRef Human-only connection check. @param provisionalCookie Unsaved session used only during that check. @returns An isolated Web API client. */
  async gallery(config: CuratorConfig, accountId?: string, provisionalRef?: string, provisionalCookie?: string): Promise<UnsplashApi> {
    const account = accountId ? config.source.unsplash.accounts.find(item => item.id === accountId) : undefined
    if (accountId && !account) throw new CuratorError('invalid-input', 'gallery', 'The selected gallery account is unavailable.')
    const ref = provisionalRef ?? account?.credentialRef
    const credential = provisionalCookie === undefined && ref ? await this.credentials.resolve(credentialRef(ref)) : undefined
    if (ref && !credential && provisionalCookie === undefined) throw new CuratorError('configuration-required', 'gallery', 'Save this gallery account session in credentials first.')
    const secret = provisionalCookie ?? credential?.value
    const key = accountId ?? provisionalRef ?? 'public', signature = createHash('sha256').update(JSON.stringify({ secret, curlBinary: config.source.unsplash.curlBinary, userAgent: config.source.unsplash.userAgent })).digest('hex')
    const cached = this.galleryClients.get(key)
    if (cached?.signature === signature) return cached.api
    const api = new UnsplashApi(new CurlUnsplashTransport(secret, config.source.unsplash))
    this.galleryClients.set(key, { signature, api })
    return api
  }
}

/** @param config Frozen source configuration. @returns Stable source and selected account identities for records and replay. */
export function sourceIdentity(config: CuratorConfig): { providerId: string; accountIdentity: string } {
  return config.source.provider === 'unsplash' ? { providerId: 'unsplash', accountIdentity: config.source.unsplash.defaultAccountId ?? 'public' } : { providerId: config.source.id, accountIdentity: config.source.credentialRef }
}
