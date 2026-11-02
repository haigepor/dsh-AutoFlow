/** Human-selected completed-search candidates may become positive or negative references. */
import { z } from 'zod'
import { imageVersionSchema, referenceSchema, runSchema, styleSchema } from './model.ts'
import { runResultFilterSchema } from './search-feedback.ts'

/** Read one collection's completed searches or one bounded page of a selected search. */
export const taskReferenceReadSchema = z.strictObject({ styleId: styleSchema.shape.id, runId: runSchema.shape.id.optional(), pageToken: z.string().optional(), resultFilter: runResultFilterSchema.default('all') })
/** Image selection and role are fixed before the first mutation is admitted. */
export const taskReferenceImportSchema = z.strictObject({ operationId: z.string().min(1).max(128), styleId: styleSchema.shape.id, expectedRevision: z.number().int().positive(), images: z.array(z.strictObject({ runId: runSchema.shape.id, imageVersionId: imageVersionSchema.shape.id })).min(1), role: z.enum(['positive', 'negative']) })
/** Only authorized image locations from the selected completed task enter the picker. */
export const taskReferencePageSchema = z.object({ styleId: styleSchema.shape.id, runId: runSchema.shape.id.nullable(), tasks: z.array(z.object({ runId: runSchema.shape.id, taskBrief: z.string(), createdAt: z.string(), candidates: z.number().int().nonnegative() })), nextPageToken: z.string().optional(), images: z.array(z.object({ imageVersionId: imageVersionSchema.shape.id, name: z.string(), width: z.number(), height: z.number(), kind: imageVersionSchema.shape.versionKind, previewPath: z.string(), thumbnailPath: z.string().optional(), resultCategory: runResultFilterSchema.exclude(['all']).optional() })), totalImages: z.number().int().nonnegative(), nextImagePageToken: z.string().optional(), resourceExpiresAt: z.number().int().positive().optional() })
/** Each row has a committed receipt, including a safely reported failure. */
export const taskReferenceReceiptSchema = z.object({ results: z.array(z.object({ sourceImageVersionId: imageVersionSchema.shape.id, status: z.enum(['added', 'skipped', 'failed']), referenceId: referenceSchema.shape.id.optional(), code: z.string().optional() })) })
/** Parsed picker data. */
export type TaskReferencePage = z.infer<typeof taskReferencePageSchema>
/** Parsed addition outcomes. */
export type TaskReferenceReceipt = z.infer<typeof taskReferenceReceiptSchema>
/** Frozen cross-task selection submitted as one replay-safe addition. */
export type TaskReferenceImport = z.infer<typeof taskReferenceImportSchema>
