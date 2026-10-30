/** Human workbench reads group selected images by their original execution batch. */
import { z } from 'zod'
import { runSchema, styleSchema } from './model.ts'

const imageSchema = z.object({ imageVersionId: z.string(), name: z.string(), width: z.number(), height: z.number(), previewPath: z.string(), thumbnailPath: z.string().optional() })
/** One execution batch with authorized matched previews and its own image continuation. */
export const searchBatchSchema = z.object({ runId: runSchema.shape.id, sessionId: z.string().optional(), kind: z.enum(['search', 'crop']), status: runSchema.shape.status, createdAt: z.string(), taskBrief: z.string(), matched: z.number().int().nonnegative(), unavailable: z.boolean(), images: z.array(imageSchema), nextImagePageToken: z.string().optional() })
/** A collection-scoped batch page; totals cover the selected filter, not just this page. */
export const searchBatchPageSchema = z.object({ styleId: styleSchema.shape.id, totalBatches: z.number().int().nonnegative(), totalMatches: z.number().int().nonnegative(), batches: z.array(searchBatchSchema), nextPageToken: z.string().optional() })
/** Parsed batch fields exposed to the authenticated workbench. */
export type SearchBatch = z.infer<typeof searchBatchSchema>
/** Parsed paginated collection results. */
export type SearchBatchPage = z.infer<typeof searchBatchPageSchema>
