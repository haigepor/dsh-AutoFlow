/** Deployment configuration has explicit, validated limits; credentials remain references. */
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { galleryAccountSchema, galleryAccountIdSchema } from '../shared/gallery.ts'
import { galleryCacheDefaults } from '../shared/gallery-cache.ts'

const positive = z.number().int().positive()
export const limitsSchema = z.object({
  maxVisionCalls: positive.default(100), maxSearchPages: positive.default(10), maxCandidates: positive.default(200),
  maxDownloadBytes: positive.default(200 * 1024 * 1024), maxCropCandidatesPerImage: positive.default(3),
  maxConcurrentRequests: positive.max(16).default(3), maxRetryAttempts: z.number().int().min(0).max(5).default(1),
  maxConcurrentAnalyses: positive.max(16).default(2),
  retryDelayMs: z.number().int().min(0).max(60_000).default(1000),
  maxProcessEvents: positive.max(2000).default(200), maxProcessTextChars: positive.max(200_000).default(12_000),
  processPollIntervalMs: positive.min(100).max(5000).default(500),
  deadlineMs: positive.default(600_000), pollIntervalMs: positive.min(500).default(2000), pageSize: positive.max(100).default(20),
  maxImportFiles: positive.default(30), maxImportBytes: positive.default(20 * 1024 * 1024),
  maxLocalReferenceFiles: positive.default(10_000),
  maxGalleryReferenceFiles: positive.default(10_000),
  maxPixels: positive.default(80_000_000), maxDimension: positive.default(20_000), previewMaxDimension: positive.default(1280),
  maxStorageBytes: positive.default(4 * 1024 * 1024 * 1024), requestTimeoutMs: positive.default(60_000),
  maxRedirects: z.number().int().min(0).max(8).default(3), maxResponseBytes: positive.default(4 * 1024 * 1024),
  maxReferenceImages: positive.default(8), maxReferenceBytes: positive.default(20 * 1024 * 1024),
  maxVisionRequestBytes: positive.default(64 * 1024 * 1024), maxVisionOutputTokens: positive.default(4096),
  visionTemperature: z.number().min(0).max(2).default(0),
  sessionGrantTtlMs: positive.default(30 * 60_000),
  maxClientRequestBytes: positive.default(64 * 1024), maxExportPreviewChars: positive.default(2000),
  minStyleMatchRatio: z.number().gt(0).max(1).default(0.75),
  reviewSampleRate: z.number().min(0).max(1).default(0.1),
}).strict()
export type Limits = z.infer<typeof limitsSchema>
const galleryLoginSchema = z.strictObject({
  browser: z.enum(['auto', 'msedge', 'chrome']).default('auto'), executablePath: z.string().default(''),
  timeoutMs: positive.default(10 * 60_000), launchTimeoutMs: positive.default(30_000), pollIntervalMs: positive.default(1500),
  validationTimeoutMs: positive.default(20_000), maxValidationAttempts: positive.max(5).default(3), retryDelayMs: positive.default(1000),
})
export const sourceSettingsSchema = z.strictObject({
  provider: z.enum(['generic', 'unsplash']).default('generic'),
  unsplash: z.strictObject({
    accounts: z.array(galleryAccountSchema).default([]), defaultAccountId: galleryAccountIdSchema.nullable().default(null),
    curlBinary: z.string().min(1).default('curl'), connectTimeoutMs: positive.default(5000), readRetryAttempts: z.number().int().min(0).max(5).default(1), readRetryDelayMs: positive.default(1000),
    mediaDnsResolvers: z.array(z.string().url()).max(8).default(['https://dns.google/resolve', 'https://cloudflare-dns.com/dns-query']),
    mediaConnectAttempts: positive.max(16).default(6), mediaConnectTimeoutMs: positive.default(2000), mediaDnsCacheEntries: positive.max(1000).default(64), mediaDnsCacheTtlMs: positive.default(60_000), mediaDnsFailureTtlMs: positive.default(60_000),
    previewTransport: z.enum(['host', 'redirect']).default('host'),
    identityCacheTtlMs: z.number().int().nonnegative().default(180_000),
    cache: z.strictObject({ ttlMs: positive.default(galleryCacheDefaults.ttlMs), maxPages: positive.default(galleryCacheDefaults.maxPages), maxBytes: positive.default(galleryCacheDefaults.maxBytes) }).default(() => ({ ...galleryCacheDefaults })),
    login: galleryLoginSchema.default(() => galleryLoginSchema.parse({})),
    userAgent: z.string().min(1).max(1024).regex(/^[^\r\n\0]+$/).default('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'),
  }).default(() => ({ accounts: [], defaultAccountId: null, curlBinary: 'curl', connectTimeoutMs: 5000, readRetryAttempts: 1, readRetryDelayMs: 1000, mediaDnsResolvers: ['https://dns.google/resolve', 'https://cloudflare-dns.com/dns-query'], mediaConnectAttempts: 6, mediaConnectTimeoutMs: 2000, mediaDnsCacheEntries: 64, mediaDnsCacheTtlMs: 60_000, mediaDnsFailureTtlMs: 60_000, previewTransport: 'host' as const, identityCacheTtlMs: 180_000, cache: { ...galleryCacheDefaults }, login: galleryLoginSchema.parse({}), userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' })),
  id: z.string().min(1).default('images'), endpoint: z.string().default(''), method: z.enum(['GET', 'POST']).default('GET'),
  credentialRef: z.string().regex(/^$|^[A-Za-z_][A-Za-z0-9_]*$/).default('VISUAL_CURATOR_SOURCE_KEY'),
  queryField: z.string().min(1).default('q'), cursorField: z.string().min(1).default('cursor'), pageSizeField: z.string().min(1).default('limit'),
  itemsPointer: z.string().default('/items'), idPointer: z.string().default('/id'), previewPointer: z.string().default('/previewUrl'),
  originalPointer: z.string().default('/originalUrl'), widthPointer: z.string().default('/width'), heightPointer: z.string().default('/height'),
  nextCursorPointer: z.string().default('/nextCursor'),
  allowedMediaOrigins: z.array(z.string().url()).default([]), lookupEndpoint: z.string().default(''),
})
export const visionSettingsSchema = z.strictObject({
  backend: z.enum(['native', 'compatible']).optional(),
  provider: z.string().trim().optional(),
  endpoint: z.string().default(''), model: z.string().default(''),
  credentialRef: z.string().regex(/^$|^[A-Za-z_][A-Za-z0-9_]*$/).default('VISUAL_CURATOR_VISION_KEY'),
  supportsMultipleImages: z.boolean().default(true), supportsJson: z.boolean().default(true),
  localOrigin: z.string().default(''), vendorVersion: z.string().nullable().default(null),
  reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'max']).nullable().optional(),
  supportsStreaming: z.boolean().optional(),
})
export const settingsSchema = z.strictObject({ source: sourceSettingsSchema.default(() => sourceSettingsSchema.parse({})), vision: visionSettingsSchema.default(() => visionSettingsSchema.parse({})), limits: limitsSchema.default(() => limitsSchema.parse({})) })
export type CuratorConfig = z.infer<typeof settingsSchema>

/** Cordis validates the envelope; the owning parser validates nested deployment settings. */
export const Config = Schema.object({ source: Schema.any(), vision: Schema.any().volatile(), limits: Schema.any() })
/** @param input Saved deployment fields. @returns Complete validated settings. */
export function resolveConfig(input: unknown): CuratorConfig {
  const config = settingsSchema.parse(input)
  if (!config.vision.provider) delete config.vision.provider
  const accounts = config.source.unsplash.accounts
  if (accounts.some(account => account.id === 'public') || new Set(accounts.map(account => account.id)).size !== accounts.length || new Set(accounts.map(account => account.userId)).size !== accounts.length || new Set(accounts.map(account => account.credentialRef)).size !== accounts.length) throw new TypeError('Gallery accounts require distinct IDs, users and credential references; public is reserved.')
  if (config.source.unsplash.defaultAccountId && !accounts.some(account => account.id === config.source.unsplash.defaultAccountId)) throw new TypeError('The selected gallery search account is unavailable.')
  // 配置保存采用字段合并，null 显式清除旧级别并恢复服务默认。
  if (config.vision.reasoningEffort === null) delete config.vision.reasoningEffort
  for (const value of [config.source.endpoint, config.source.lookupEndpoint, config.vision.endpoint, ...config.source.unsplash.mediaDnsResolvers]) {
    if (!value) continue
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash) throw new TypeError('Endpoints must not contain inline authentication, query parameters or fragments; use credential references.')
  }
  if (config.source.unsplash.mediaDnsResolvers.some(endpoint => new URL(endpoint).protocol !== 'https:')) throw new TypeError('Image DNS endpoints require HTTPS.')
  if (config.vision.endpoint) {
    const endpoint = new URL(config.vision.endpoint), path = endpoint.pathname.replace(/\/+$/, '')
    // 只补全已知的兼容服务基础地址；自定义完整请求路径保持原样。
    if (!path || path.endsWith('/v1')) { endpoint.pathname = path ? `${path}/chat/completions` : '/v1/chat/completions'; config.vision.endpoint = endpoint.href }
  }
  for (const value of [...config.source.allowedMediaOrigins, ...(config.vision.localOrigin ? [config.vision.localOrigin] : [])]) {
    const url = new URL(value)
    if (url.origin !== value || url.username || url.password || url.search || url.hash) throw new TypeError('Allowed destinations must be exact origins without credentials, paths or queries.')
  }
  return config
}
/** New deployments default to high; frozen legacy specs retain their original omitted parameters.
 * @param input Current deployment settings, with null selecting the provider default.
 * @returns Validated settings for new tasks only.
 */
export function resolveCurrentConfig(input: unknown): CuratorConfig {
  const saved = settingsSchema.parse(input), config = resolveConfig(input)
  config.vision.backend ??= 'native'
  if (saved.vision.reasoningEffort === undefined) config.vision.reasoningEffort = 'high'
  if (saved.vision.supportsStreaming === undefined) config.vision.supportsStreaming = true
  // 新补全字段重新按解析器顺序排列，持久化后再次读取不能改变 reviewer 摘要。
  return resolveConfig(config)
}
/** @param value JSON configuration. @returns Stable non-secret configuration revision. */
export function configRevision(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
/** @param config Complete deployment settings. @returns Identity of model sampling and reference selection. */
export function reviewerRevision(config: CuratorConfig): string {
  return configRevision({ vision: config.vision, temperature: config.limits.visionTemperature, maxOutputTokens: config.limits.maxVisionOutputTokens, maxImages: config.limits.maxReferenceImages, maxBytes: config.limits.maxReferenceBytes })
}
