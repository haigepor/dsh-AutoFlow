/** Resolve credential references at dispatch; saved configuration contains no secret values. */
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { CompatibleVisionProvider, SafeHttpClient, SourceHttpProvider, type RequestBounds, type HttpClient } from '../media/index.ts'
import type { CuratorConfig } from './config.ts'
import type { WorkContext } from './runtime.ts'
import { CuratorError } from '../shared/errors.ts'

/** @param config Frozen task settings. @param context Current budget and abort signal. @returns Bounded one-attempt settings. */
export function requestBounds(config: CuratorConfig, context: WorkContext): RequestBounds {
  const remaining = context.ledger.snapshot().deadlineAt - Date.now()
  if (remaining <= 0) throw new CuratorError('budget-exhausted', 'request', 'The task deadline has passed.')
  return { signal: context.signal, maxBytes: config.limits.maxResponseBytes, timeoutMs: Math.min(config.limits.requestTimeoutMs, remaining), maxRedirects: config.limits.maxRedirects }
}

/** Provider creation validates supported capabilities before a paid task can start. */
export class ProviderFactory {
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
    return new CompatibleVisionProvider({ endpoint: config.vision.endpoint, model: config.vision.model, supportsMultiImage: config.vision.supportsMultipleImages, maxImages: config.limits.maxReferenceImages + 2, maxImageBytes: config.limits.maxReferenceBytes, maxRequestBytes: config.limits.maxVisionRequestBytes, maxOutputTokens: config.limits.maxVisionOutputTokens, temperature: config.limits.visionTemperature, ...(config.vision.vendorVersion ? { declaredModelVersion: config.vision.vendorVersion } : {}) }, http, await this.headers(config.vision.credentialRef))
  }
  async source(config: CuratorConfig): Promise<SourceHttpProvider> {
    if (!config.source.endpoint) throw new CuratorError('capability-unavailable', 'source-preflight', 'Configure the image source endpoint.')
    const s = config.source, response = { id: s.idPointer, previewUrl: s.previewPointer, originalUrl: s.originalPointer, width: s.widthPointer, height: s.heightPointer }
    return new SourceHttpProvider({ endpoint: s.endpoint, method: s.method, request: { query: s.queryField, cursor: s.cursorField, pageSize: s.pageSizeField }, response: { ...response, items: s.itemsPointer, nextCursor: s.nextCursorPointer }, maxPageSize: config.limits.pageSize, ...(s.lookupEndpoint ? { lookup: { endpoint: s.lookupEndpoint, method: 'GET' as const, idField: 'id', response } } : {}) }, new SafeHttpClient({ allowedOrigins: [new URL(s.endpoint).origin] }), await this.headers(s.credentialRef))
  }
  media(config: CuratorConfig): HttpClient {
    return new SafeHttpClient({ allowedOrigins: [...new Set([new URL(config.source.endpoint).origin, ...config.source.allowedMediaOrigins])] })
  }
}
