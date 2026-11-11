/** Human workbench reads group selected images by their original execution batch. */
import { z } from 'zod'
import { runSchema, styleSchema } from './model.ts'
import { runContinuationSchema } from './run-continuation.ts'

const imageSchema = z.object({ imageVersionId: z.string(), name: z.string(), width: z.number(), height: z.number(), previewPath: z.string(), thumbnailPath: z.string().optional() })
const workflowSource = z.object({ modelProfileId: z.string(), analysisRunId: z.string(), revision: z.number().int().nonnegative(), references: z.number().int().nonnegative(), positive: z.number().int().nonnegative(), negative: z.number().int().nonnegative(), undecided: z.number().int().nonnegative() })
const wallpaperSummary = z.object({ runId: runSchema.shape.id, status: runSchema.shape.status, total: z.number().int().nonnegative(), planned: z.number().int().nonnegative(), rendered: z.number().int().nonnegative(), reviewed: z.number().int().nonnegative(), passed: z.number().int().nonnegative(), attention: z.number().int().nonnegative(), errorCode: z.string().optional(), budgetStopped: z.boolean(), counts: z.record(z.string(), z.number().int().nonnegative()).optional() })
/** One execution batch with authorized matched previews and its own image continuation. */
export const searchBatchSchema = z.object({ runId: runSchema.shape.id, sessionId: z.string().optional(), kind: z.enum(['search', 'crop']), status: runSchema.shape.status, progress: z.object({ stage: runSchema.shape.stage, counts: z.record(z.string(), z.number()), requests: z.number().int().nonnegative() }).optional(), continuation: runContinuationSchema.optional(), createdAt: z.string(), taskBrief: z.string(), matched: z.number().int().nonnegative(), unavailable: z.boolean(), images: z.array(imageSchema), nextImagePageToken: z.string().optional(), workflowSource: workflowSource.optional(), datasetId: z.string().optional(), targetCount: z.number().int().positive().optional(), previewOnly: z.boolean().optional(), launchId: z.string().optional(), wallpaperRequested: z.boolean().optional(), wallpaper: wallpaperSummary.optional(), postProcessingError: z.string().optional(), errorCode: z.string().optional(), outcome: runSchema.shape.outcome.optional() })
/** A collection-scoped batch page; totals cover the selected filter, not just this page. */
export const searchBatchPageSchema = z.object({ styleId: styleSchema.shape.id, totalBatches: z.number().int().nonnegative(), totalMatches: z.number().int().nonnegative(), batches: z.array(searchBatchSchema), nextPageToken: z.string().optional() })
/** Parsed batch fields exposed to the authenticated workbench. */
export type SearchBatch = z.infer<typeof searchBatchSchema>
/** Parsed paginated collection results. */
export type SearchBatchPage = z.infer<typeof searchBatchPageSchema>
/** Read-only task facts for the canvas; this read never changes the selected Session. */
export const searchBatchDetailSchema = z.object({ runId: runSchema.shape.id, kind: z.enum(['search', 'crop']), status: runSchema.shape.status, stage: z.string().nullable(), taskBrief: z.string(), createdAt: z.string(), counts: z.record(z.string(), z.number()), requests: z.number().int().nonnegative(), warnings: z.array(z.string()), errorCode: z.string().optional(), postProcessingError: z.string().optional(), outcome: z.string().optional() })
/** Authorized task summary without Session mutation or raw model payloads. */
export type SearchBatchDetail = z.infer<typeof searchBatchDetailSchema>
