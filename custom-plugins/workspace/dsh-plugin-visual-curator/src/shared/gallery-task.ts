/** Safe collection-owned progress; selected IDs and credentials stay on the Host. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** Stable owner-scoped reference operation identity. */
export type GalleryTaskId = Branded<'VisualCurator.GalleryTaskId'>
/** JSON parser for reference task identities. */
export const galleryTaskIdSchema = z.string().regex(/^[a-f0-9]{64}$/).transform(value => brandString<GalleryTaskId>(value))
/** Public progress excludes credentials, selected photo IDs and internal batch receipts. */
export const galleryTaskViewSchema = z.strictObject({
  id: galleryTaskIdSchema, styleId: z.string().min(1), accountId: z.string().optional(),
  status: z.enum(['queued', 'running', 'cancelling', 'completed', 'partial', 'failed', 'cancelled', 'interrupted', 'needs-review']),
  phase: z.enum(['verifying', 'referencing', 'saving']),
  total: z.number().int().nonnegative(), completed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
  registered: z.number().int().nonnegative(), createdAt: z.string(), updatedAt: z.string(), errorCode: z.string().optional(),
})
/** Committed counters and live batch registration are reported separately. */
export type GalleryTaskView = z.infer<typeof galleryTaskViewSchema>

/** @param status Saved task status. @returns Whether the Host still owns active work. */
export function galleryTaskActive(status: GalleryTaskView['status']): boolean { return status === 'queued' || status === 'running' || status === 'cancelling' }
