/** Validated additive search output and recoverable native launch messages. */
import { z } from 'zod'
import { profileExportSchema, runSchema } from './model.ts'

/** Preview links and original files omit usages; older calls without an output retain their usage requirement. */
export const searchOutputSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('preview') }), z.strictObject({ kind: z.literal('original') }), z.strictObject({ kind: z.literal('usage'), usageRevisionId: z.string().min(1) })])
/** Human-only launch input; datasetId stays optional on read for previously accepted launches. New admission requires it. */
export const searchLaunchInputSchema = z.strictObject({
  operationId: z.string().uuid().brand<'visual-search-launch-id'>(), workspaceId: z.string().min(1).brand<'workspace-id'>(),
  modelProfileId: z.string().min(1), taskBrief: z.string().trim().min(1).max(4000), targetCount: z.number().int().positive(), output: searchOutputSchema,
  datasetId: profileExportSchema.shape.id.optional(),
})
/** Validated owner launch with an immutable output choice. */
export type SearchLaunchInput = z.infer<typeof searchLaunchInputSchema>
/** Public progress never includes the internal frozen specification or reference bytes. */
export const searchLaunchViewSchema = z.object({
  id: searchLaunchInputSchema.shape.operationId, input: searchLaunchInputSchema, sessionId: z.string().min(1),
  stage: z.enum(['preparing', 'creating-session', 'attaching', 'submitting', 'accepted', 'stopped']),
  status: z.enum(['working', 'failed', 'accepted', 'stopped']), createdAt: z.string(), updatedAt: z.string(),
  datasetId: z.string().optional(), runIds: z.array(z.string()), qualified: z.number().int().nonnegative(),
  runStatus: runSchema.shape.status.optional(), directory: z.string().optional(),
  stopping: z.boolean().optional(),
  error: z.object({ code: z.string(), stage: z.string().optional(), safeMessage: z.string(), suggestedAction: z.string() }).optional(),
})
/** Public durable admission and real Run progress. */
export type SearchLaunchView = z.infer<typeof searchLaunchViewSchema>
/** Existing native Workspace choice, with its owner-visible directory. */
export interface SearchWorkspace { id: string; title: string; path: string }
