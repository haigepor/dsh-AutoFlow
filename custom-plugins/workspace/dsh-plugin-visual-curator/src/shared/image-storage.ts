/** Profile image storage accounting excludes task and credential metadata from the public view. */
import { z } from 'zod'

/** A cleanup preview identifies the exact filesystem inventory and retained image references. */
export const imageStorageViewSchema = z.strictObject({
  revision: z.string(), usedBytes: z.number().int().nonnegative(), limitBytes: z.number().int().positive(),
  retainedBytes: z.number().int().nonnegative(), reclaimableBytes: z.number().int().nonnegative(), reclaimableFiles: z.number().int().nonnegative(),
  cleanupAllowed: z.boolean(), freedBytes: z.number().int().nonnegative().optional(), freedFiles: z.number().int().nonnegative().optional(),
})
/** Safe, aggregate-only storage accounting for the management dialog. */
export type ImageStorageView = z.infer<typeof imageStorageViewSchema>
/** A completed cleanup always acknowledges the exact removed file count and byte total. */
export const imageStorageCleanedSchema = imageStorageViewSchema.required({ freedBytes: true, freedFiles: true })
