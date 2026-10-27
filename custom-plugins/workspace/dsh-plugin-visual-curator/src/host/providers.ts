/** Resolve credential references at dispatch; saved configuration contains no secret values. */
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { CompatibleVisionProvider, StructuredVisionProvider, SafeHttpClient, SourceHttpProvider, type ImageSourceProvider, type RequestBounds, type HttpClient } from '../media/index.ts'
import type { VisionBounds } from '../media/vision.ts'
import type { Json } from '../shared/model.ts'
import { NativeVisionProvider, type NativeVisionDependencies } from './native-vision.ts'
import { GalleryMediaClient } from '../media/media-routing.ts'
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

/** @param config Frozen limits. @param context Durable owner. @param signal Attempt cancellation. @param onMetadata Durable native request recorder. @returns Native and legacy bounds sharing one download budget. */
export function visionBounds(config: CuratorConfig, context: WorkContext, signal: AbortSignal, onMetadata: (metadata: Json) => Promise<void>): VisionBounds {
  return { ...requestBounds(config, context), signal, onMetadata, reserveDownload: async requested => {
    const maxBytes = Math.min(requested, context.ledger.remainingBytes())
    if (maxBytes <= 0) throw new CuratorError('budget-exhausted', 'vision-images', 'The saved image download budget is exhausted.')
    await context.ledger.reserve('download', maxBytes)
    await context.save(context.current().stage ?? 'planning', {})
    return { maxBytes, settle: async actual => { context.ledger.settleDownload(maxBytes, actual); await context.save(context.current().stage ?? 'planning', {}) } }
  } }
}

/** Provider creation validates supported capabilities before a paid task can start. */
export class ProviderFactory {
  private readonly galleryClients = new Map<string, { signature: string; api: UnsplashApi }>()
  private readonly mediaClients = new Map<string, GalleryMediaClient>()
  constructor(private readonly credentials: Pick<CredentialProvider, 'resolve'>, private readonly native?: Pick<NativeVisionDependencies, 'llm' | 'attachments'>) {}
  private async headers(ref: string): Promise<Record<string, string>> {
    if (!ref) return {}
    const secret = await this.credentials.resolve(credentialRef(ref))
    if (!secret) throw new CuratorError('capability-unavailable', 'credentials', 'A configured credential reference is unavailable.')
    return { authorization: `Bearer ${secret.value}` }
  }
  async vision(config: CuratorConfig): Promise<StructuredVisionProvider> {
    if (config.vision.backend === 'native' || config.vision.provider && config.vision.backend !== 'compatible') {
      if (!this.native) throw new CuratorError('capability-unavailable', 'vision-preflight', 'The native LLM and attachment services are unavailable.')
      const provider = new NativeVisionProvider(config, { ...this.native, media: this.unsplashMedia(config) })
      await provider.preflight()
      return provider
    }
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
    if (config.source.provider === 'unsplash') return this.unsplashMedia(config)
    return new SafeHttpClient({ allowedOrigins: [...new Set([new URL(config.source.endpoint).origin, ...config.source.allowedMediaOrigins])] })
  }
  /** @param config Current network policy. @returns A profile-owned public image client with bounded DNS caches. */
  unsplashMedia(config: CuratorConfig): GalleryMediaClient {
    const { connectTimeoutMs, mediaConnectTimeoutMs, mediaConnectAttempts, mediaDnsCacheEntries, mediaDnsCacheTtlMs, mediaDnsFailureTtlMs, mediaDnsResolvers } = config.source.unsplash
    const options = { connectTimeoutMs, mediaConnectTimeoutMs, mediaConnectAttempts, mediaDnsCacheEntries, mediaDnsCacheTtlMs, mediaDnsFailureTtlMs, mediaDnsResolvers }, key = JSON.stringify(options)
    const old = this.mediaClients.get(key)
    if (old) return old
    const client = new GalleryMediaClient(options)
    // 已接受的任务可继续使用旧网络设置，所有配置代的连接在插件卸载时统一释放。
    this.mediaClients.set(key, client)
    return client
  }
  /** Drain profile-owned DNS requests without disposing native LLM or credential services. */
  async dispose(): Promise<void> { await Promise.all([...this.mediaClients.values()].map(client => client.dispose())); this.mediaClients.clear() }
  /** @param config Frozen deployment settings. @param accountId Saved account, or absent for public search. @param provisionalRef Human-only connection check. @param provisionalCookie Unsaved session used only during that check. @returns An isolated Web API client. */
  async gallery(config: CuratorConfig, accountId?: string, provisionalRef?: string, provisionalCookie?: string): Promise<UnsplashApi> {
    const account = accountId ? config.source.unsplash.accounts.find(item => item.id === accountId) : undefined
    if (accountId && !account) throw new CuratorError('invalid-input', 'gallery', 'The selected gallery account is unavailable.')
    const ref = provisionalRef ?? account?.credentialRef
    const credential = provisionalCookie === undefined && ref ? await this.credentials.resolve(credentialRef(ref)) : undefined
    if (ref && !credential && provisionalCookie === undefined) throw new CuratorError('configuration-required', 'gallery', 'Save this gallery account session in credentials first.')
    const secret = provisionalCookie ?? credential?.value
    const key = accountId ?? provisionalRef ?? 'public', signature = createHash('sha256').update(JSON.stringify({ secret, curlBinary: config.source.unsplash.curlBinary, userAgent: config.source.unsplash.userAgent, connectTimeoutMs: config.source.unsplash.connectTimeoutMs, readRetryAttempts: config.source.unsplash.readRetryAttempts })).digest('hex')
    const cached = this.galleryClients.get(key)
    if (cached?.signature === signature) return cached.api
    const api = new UnsplashApi(new CurlUnsplashTransport(secret, { ...config.source.unsplash, maxRetryAttempts: config.source.unsplash.readRetryAttempts }))
    this.galleryClients.set(key, { signature, api })
    return api
  }
}

/** @param config Frozen source configuration. @returns Stable source and selected account identities for records and replay. */
export function sourceIdentity(config: CuratorConfig): { providerId: string; accountIdentity: string } {
  return config.source.provider === 'unsplash' ? { providerId: 'unsplash', accountIdentity: config.source.unsplash.defaultAccountId ?? 'public' } : { providerId: config.source.id, accountIdentity: config.source.credentialRef }
}
