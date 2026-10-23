/** Deployment configuration has explicit, validated limits; credentials remain references. */
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { createHash } from 'node:crypto'

const positive = z.number().int().positive()
export const limitsSchema = z.object({
  maxVisionCalls: positive.default(100), maxSearchPages: positive.default(10), maxCandidates: positive.default(200),
  maxDownloadBytes: positive.default(200 * 1024 * 1024), maxCropCandidatesPerImage: positive.default(3),
  maxConcurrentRequests: positive.max(16).default(3), maxRetryAttempts: z.number().int().min(0).max(5).default(1),
  deadlineMs: positive.default(600_000), pollIntervalMs: positive.min(500).default(2000), pageSize: positive.max(100).default(20),
  maxImportFiles: positive.default(30), maxImportBytes: positive.default(20 * 1024 * 1024),
  maxPixels: positive.default(80_000_000), maxDimension: positive.default(20_000), previewMaxDimension: positive.default(1280),
  maxStorageBytes: positive.default(4 * 1024 * 1024 * 1024), requestTimeoutMs: positive.default(60_000),
  maxRedirects: z.number().int().min(0).max(8).default(3), maxResponseBytes: positive.default(4 * 1024 * 1024),
  maxReferenceImages: positive.default(8), maxReferenceBytes: positive.default(20 * 1024 * 1024),
  maxVisionRequestBytes: positive.default(64 * 1024 * 1024), maxVisionOutputTokens: positive.default(4096),
  visionTemperature: z.number().min(0).max(2).default(0),
  sessionGrantTtlMs: positive.default(30 * 60_000),
  maxClientRequestBytes: positive.default(64 * 1024), maxExportPreviewChars: positive.default(2000),
  reviewSampleRate: z.number().min(0).max(1).default(0.1),
}).strict()
export type Limits = z.infer<typeof limitsSchema>
export const sourceSettingsSchema = z.strictObject({
  id: z.string().min(1).default('images'), endpoint: z.string().default(''), method: z.enum(['GET', 'POST']).default('GET'),
  credentialRef: z.string().regex(/^$|^[A-Za-z_][A-Za-z0-9_]*$/).default('VISUAL_CURATOR_SOURCE_KEY'),
  queryField: z.string().min(1).default('q'), cursorField: z.string().min(1).default('cursor'), pageSizeField: z.string().min(1).default('limit'),
  itemsPointer: z.string().default('/items'), idPointer: z.string().default('/id'), previewPointer: z.string().default('/previewUrl'),
  originalPointer: z.string().default('/originalUrl'), widthPointer: z.string().default('/width'), heightPointer: z.string().default('/height'),
  nextCursorPointer: z.string().default('/nextCursor'),
  allowedMediaOrigins: z.array(z.string().url()).default([]), lookupEndpoint: z.string().default(''),
})
export const visionSettingsSchema = z.strictObject({
  endpoint: z.string().default(''), model: z.string().default(''),
  credentialRef: z.string().regex(/^$|^[A-Za-z_][A-Za-z0-9_]*$/).default('VISUAL_CURATOR_VISION_KEY'),
  supportsMultipleImages: z.boolean().default(true), supportsJson: z.boolean().default(true),
  localOrigin: z.string().default(''), vendorVersion: z.string().nullable().default(null),
})
export const settingsSchema = z.strictObject({ source: sourceSettingsSchema.default(() => sourceSettingsSchema.parse({})), vision: visionSettingsSchema.default(() => visionSettingsSchema.parse({})), limits: limitsSchema.default(() => limitsSchema.parse({})) })
export type CuratorConfig = z.infer<typeof settingsSchema>

/** Cordis validates the envelope; the owning parser validates nested deployment settings. */
export const Config = Schema.object({ source: Schema.any(), vision: Schema.any(), limits: Schema.any() })
/** @param input Saved deployment fields. @returns Complete validated settings. */
export function resolveConfig(input: unknown): CuratorConfig {
  const config = settingsSchema.parse(input)
  for (const value of [config.source.endpoint, config.source.lookupEndpoint, config.vision.endpoint]) {
    if (!value) continue
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash) throw new TypeError('Endpoints must not contain inline authentication, query parameters or fragments; use credential references.')
  }
  for (const value of [...config.source.allowedMediaOrigins, ...(config.vision.localOrigin ? [config.vision.localOrigin] : [])]) {
    const url = new URL(value)
    if (url.origin !== value || url.username || url.password || url.search || url.hash) throw new TypeError('Allowed destinations must be exact origins without credentials, paths or queries.')
  }
  return config
}
/** @param value JSON configuration. @returns Stable non-secret configuration revision. */
export function configRevision(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
/** @param config Complete deployment settings. @returns Identity of model sampling and reference selection. */
export function reviewerRevision(config: CuratorConfig): string {
  return configRevision({ vision: config.vision, temperature: config.limits.visionTemperature, maxOutputTokens: config.limits.maxVisionOutputTokens, maxImages: config.limits.maxReferenceImages, maxBytes: config.limits.maxReferenceBytes })
}
