/** Profile image storage accounting excludes task and credential metadata from the public view. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** A cleanup preview identifies the exact filesystem inventory and retained image references. */
export const imageStorageUsageSchema = z.strictObject({
  revision: z.string(), usedBytes: z.number().int().nonnegative(), limitBytes: z.number().int().positive(),
  retainedBytes: z.number().int().nonnegative(), reclaimableBytes: z.number().int().nonnegative(), reclaimableFiles: z.number().int().nonnegative(),
  cleanupAllowed: z.boolean(), freedBytes: z.number().int().nonnegative().optional(), freedFiles: z.number().int().nonnegative().optional(),
})
/** Profile-local identity of a human-authorized directory migration. */
export type ImageStorageMigrationId = Branded<'VisualCurator.StorageMigrationId'>
/** Parser for authenticated migration identities. */
export const imageStorageMigrationIdSchema = z.string().uuid().transform(value => brandString<ImageStorageMigrationId>(value))
/** Background progress contains no image records or credentials. */
export const imageStorageMigrationSchema = z.strictObject({
  id: imageStorageMigrationIdSchema,
  status: z.enum(['running', 'completed', 'interrupted', 'failed', 'blocked']),
  phase: z.enum(['preparing', 'copying', 'verifying', 'removing-source']),
  sourceDirectory: z.string(), targetDirectory: z.string(),
  totalBytes: z.number().int().nonnegative(), totalFiles: z.number().int().nonnegative(),
  missingFiles: z.number().int().nonnegative().optional(),
  copiedBytes: z.number().int().nonnegative(), copiedFiles: z.number().int().nonnegative(),
  verifiedBytes: z.number().int().nonnegative(), verifiedFiles: z.number().int().nonnegative(),
  removedBytes: z.number().int().nonnegative(), removedFiles: z.number().int().nonnegative(),
  errorCode: z.string().optional(),
})
/** Image location and migration state are independent of frozen task settings. */
export const imageStorageViewSchema = imageStorageUsageSchema.extend({ directory: z.string(), migration: imageStorageMigrationSchema.optional() })
/** Safe, aggregate-only storage accounting for the management dialog. */
export type ImageStorageView = z.infer<typeof imageStorageViewSchema>
/** A completed cleanup always acknowledges the exact removed file count and byte total. */
export const imageStorageCleanedSchema = imageStorageViewSchema.required({ freedBytes: true, freedFiles: true })
