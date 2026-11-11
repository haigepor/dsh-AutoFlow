/** Server imports keep remote identities and delivery receipts separate from image quality. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

export type ServerImageId = Branded<'VisualCurator.ServerImageId'>
export const serverImageIdSchema = z.string().regex(/^[1-9][0-9]{0,31}$/).transform(value => brandString<ServerImageId>(value))
function exactOrigin(value: string, httpsOnly = false): boolean {
  try { const url = new URL(value); return url.origin === value && ['http:', 'https:'].includes(url.protocol) && (!httpsOnly || url.protocol === 'https:') && !url.username && !url.password }
  catch (error) { return false }
}
const origin = z.string().url().refine(value => exactOrigin(value))
function apiBaseUrl(value: string): boolean {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash }
  catch (error) { return false }
}
const apiBase = z.string().trim().url().refine(apiBaseUrl).transform(value => new URL(value).href.replace(/\/+$/, ''))

/**
 * Append one protocol operation beneath a normalized server base address.
 * @param baseUrl Validated base URL without trailing slashes.
 * @param operation Server operation with a fixed protocol path.
 * @returns Absolute endpoint retaining the configured path prefix.
 */
export function serverQueueApiUrl(baseUrl: string, operation: 'pull' | 'receive'): URL {
  return new URL(`OperateImage/${operation}.html`, baseUrl + '/')
}
/** Authentication is resolved on the Host; the imported Postman file is read without changing credentials. */
export const serverQueueSettingsSchema = z.strictObject({
  baseUrl: apiBase.or(z.literal('')).default(''), allowPrivateApi: z.boolean().default(false),
  auth: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('credential'), ref: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }), z.strictObject({ kind: z.literal('postman'), path: z.string().min(1) })]).default({ kind: 'credential', ref: 'VISUAL_CURATOR_SERVER_TOKEN' }),
  allowedMediaOrigins: z.array(origin.refine(value => exactOrigin(value, true))).max(16).default([]),
  concurrency: z.number().int().min(1).max(8).default(2), maxUploadBytes: z.number().int().positive().default(32 * 1024 * 1024),
})
export type ServerQueueSettings = z.infer<typeof serverQueueSettingsSchema>
/** Only verified protocol fields are consumed; article metadata is never used as model instructions. */
export const serverImageSchema = z.object({
  id: serverImageIdSchema, title: z.string().max(2048).default(''), name: z.string().max(512), img_url: z.string().url(),
  md5: z.string().max(128).nullable().optional(), size: z.union([z.string().max(32), z.number().nonnegative()]).nullable().optional(), update_time: z.union([z.string().max(64), z.number()]).nullable().optional(),
})
export type ServerImage = z.infer<typeof serverImageSchema>
/** This is the actual pull response observed on the supplied test service. */
export const serverPullSchema = z.object({ success: z.literal(true), data: z.array(serverImageSchema), total: z.number().int().nonnegative(), page: z.number().int().positive(), pageSize: z.number().int().positive() })
export const serverTransferStatusSchema = z.enum(['waiting', 'uploading', 'uploaded', 'failed', 'unknown'])
/** Accepted bytes remain distinct from the latest image-processing result. */
export const serverTransferViewSchema = z.object({ status: serverTransferStatusSchema, outputDigest: z.string().optional(), current: z.boolean().optional(), message: z.string().optional() })
/** Image-scoped transmission data shared by the queue and workflow canvas. */
export type ServerTransferView = z.infer<typeof serverTransferViewSchema>
/** Profile-owned original acquisition precedes creation of the processing batch. */
export const serverImportViewSchema = z.object({ runId: z.string(), name: z.string(), status: z.enum(['importing', 'failed', 'interrupted']), saved: z.number().int().nonnegative(), total: z.number().int().positive(), receivedBytes: z.number().nonnegative(), errorCode: z.string().optional() })
/** Durable import progress contains no source URL or credential value. */
export type ServerImportView = z.infer<typeof serverImportViewSchema>
/** Safe progress rows contain no token or remote original URL. */
export const serverQueueViewSchema = z.object({
  settings: serverQueueSettingsSchema, snapshotId: z.string(), total: z.number().int().nonnegative(), imports: z.array(serverImportViewSchema).default([]), pendingKnown: z.boolean().default(false),
  items: z.array(z.object({ id: serverImageIdSchema, name: z.string(), imported: z.boolean(), serverPending: z.boolean().optional(), imageVersionId: z.string().optional(), runId: z.string().optional(), importRunId: z.string().optional(), previewPath: z.string().optional(), phase: z.enum(['waiting', 'downloading', 'saved', 'processing', 'attention', 'approved']), receivedBytes: z.number().nonnegative().optional(), totalBytes: z.number().nonnegative().optional(), errorCode: z.string().optional(), warning: z.string().optional(), transfer: serverTransferViewSchema.optional() })),
})
export type ServerQueueView = z.infer<typeof serverQueueViewSchema>
