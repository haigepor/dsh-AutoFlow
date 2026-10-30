/** Credential-free image task records read by the session card resource. */
import { z } from 'zod'

const id = z.string().min(1).max(256)
export const imageViewAssetSchema = z.strictObject({
  assetId: id, name: z.string().max(4096), mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  width: z.number().int().positive(), height: z.number().int().positive(),
})
export const imageViewTaskSchema = z.strictObject({
  taskId: id, callId: id.optional(), state: z.enum(['queued', 'sent', 'succeeded', 'failed', 'cancelled', 'outcome-unknown']),
  createdAt: z.number().finite(), updatedAt: z.number().finite(), deadlineAt: z.number().finite(),
  assets: z.array(imageViewAssetSchema).max(4), errorCode: z.string().max(256).optional(),
})
export const imageSessionViewSchema = z.strictObject({
  version: z.literal(1), sessionId: id, pollIntervalMs: z.number().int().min(250).max(30_000),
  tasks: z.array(imageViewTaskSchema).max(10_000),
})
export type ImageViewAsset = z.infer<typeof imageViewAssetSchema>
export type ImageViewTask = z.infer<typeof imageViewTaskSchema>
export type ImageSessionView = z.infer<typeof imageSessionViewSchema>
