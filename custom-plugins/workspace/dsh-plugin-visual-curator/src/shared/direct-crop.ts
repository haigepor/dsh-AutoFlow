/** Direct-original batches have no training collection or search receipt; server delivery has a separate owner. */
import { z } from 'zod'
import { galleryAccountIdSchema, galleryMediaUrlSchema } from './gallery.ts'
import { searchBatchSchema } from './search-batches.ts'

const localFile = z.strictObject({ path: z.string().min(1), name: z.string().min(1).max(512) })
const galleryPhoto = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), title: z.string().max(512), width: z.number().int().positive(), height: z.number().int().positive(), referenceUrl: galleryMediaUrlSchema, thumbnailUrl: galleryMediaUrlSchema })
/** Explicit local, gallery or Host-imported server selections may admit direct work. */
export const directCropStartSchema = z.strictObject({
  operationId: z.string().min(1), name: z.string().trim().min(1).max(160),
  source: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('local'), files: z.array(localFile).min(1) }), z.strictObject({ kind: z.literal('gallery'), accountId: galleryAccountIdSchema, photos: z.array(galleryPhoto).min(1) }), z.strictObject({ kind: z.literal('server'), photos: z.array(z.strictObject({ id: z.string().min(1), title: z.string().max(512) })).min(1) })]),
})
/** Human-selected inputs, before original acquisition and pixel observations. */
export type DirectCropStart = z.infer<typeof directCropStartSchema>
/** Frozen admission metadata is independent of learned styles and search receipts. */
export const directCropMetadataSchema = z.strictObject({ version: z.literal('direct-crop-v1'), name: z.string(), origin: z.enum(['local', 'gallery', 'server']), inputDigest: z.string() })
/** Actual crop batches reuse image-flow controls without presenting themselves as searches. */
export const directCropBatchSchema = searchBatchSchema.extend({ directCrop: z.literal(true), name: z.string(), origin: z.enum(['local', 'gallery', 'server']), removable: z.boolean() })
/** Authorized batch summary for the direct-crop page. */
export type DirectCropBatch = z.infer<typeof directCropBatchSchema>
export { directCropPolicySchema } from './direct-crop-policy.ts'
