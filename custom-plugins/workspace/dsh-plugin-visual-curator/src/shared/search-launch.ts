/** Validated additive search output and recoverable native launch messages. */
import { z } from 'zod'
import { profileExportSchema, runSchema } from './model.ts'
import { searchNegativeSummarySchema } from './search-reference-datasets.ts'
import { runContinuationSchema } from './run-continuation.ts'

/** Preview links and original files omit usages; older calls without an output retain their usage requirement. */
export const searchOutputSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('preview') }), z.strictObject({ kind: z.literal('original') }), z.strictObject({ kind: z.literal('usage'), usageRevisionId: z.string().min(1) })])
/** Frozen native conversation route; choosing it never changes the profile-wide default. */
export const searchConversationModelSchema = z.strictObject({ provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().min(1).optional() })
/** One catalog-backed Session model selection. */
export type SearchConversationModel = z.infer<typeof searchConversationModelSchema>
/** Selectable native route with its provider-authored display name. */
export interface SearchConversationModelOption extends SearchConversationModel { label: string }
/** Human-only launch input; new admission requires a saved dataset or explicit automatic preparation. Existing launches retain their input. */
export const searchLaunchInputSchema = z.strictObject({
  operationId: z.string().uuid().brand<'visual-search-launch-id'>(), workspaceId: z.string().min(1).brand<'workspace-id'>(),
  modelProfileId: z.string().min(1), taskBrief: z.string().trim().min(1).max(4000), targetCount: z.number().int().positive(), output: searchOutputSchema,
  datasetId: profileExportSchema.shape.id.optional(),
  autoPrepareDataset: z.boolean().optional(), includeNegativeDatasets: z.boolean().optional(),
  wallpaper: z.boolean().optional(),
  executionMode: z.enum(['workflow', 'conversation']).optional(),
  conversationModel: searchConversationModelSchema.optional(),
  visionModel: searchConversationModelSchema.pick({ provider: true, model: true }).optional(),
})
/** Validated owner launch with an immutable output choice. */
export type SearchLaunchInput = z.infer<typeof searchLaunchInputSchema>
/** Public progress never includes the internal frozen specification or reference bytes. */
export const searchLaunchViewSchema = z.object({
  id: searchLaunchInputSchema.shape.operationId, input: searchLaunchInputSchema, sessionId: z.string().min(1),
  sessionReady: z.boolean().optional(),
  stage: z.enum(['preparing', 'creating-session', 'preparing-dataset', 'attaching', 'submitting', 'accepted', 'stopped']),
  status: z.enum(['working', 'failed', 'accepted', 'stopped']), createdAt: z.string(), updatedAt: z.string(),
  datasetId: z.string().optional(), runIds: z.array(z.string()), qualified: z.number().int().nonnegative(),
  negativeReferences: searchNegativeSummarySchema.optional(),
  runStatus: runSchema.shape.status.optional(), directory: z.string().optional(),
  continuation: runContinuationSchema.optional(),
  wallpaper: z.object({ runId: z.string(), status: runSchema.shape.status, total: z.number().int().nonnegative(), passed: z.number().int().nonnegative(), attention: z.number().int().nonnegative() }).optional(),
  stopping: z.boolean().optional(),
  error: z.object({ code: z.string(), stage: z.string().optional(), safeMessage: z.string(), suggestedAction: z.string() }).optional(),
})
/** Public durable admission and real Run progress. */
export type SearchLaunchView = z.infer<typeof searchLaunchViewSchema>
/** Existing native Workspace choice, with its owner-visible directory. */
export interface SearchWorkspace { id: string; title: string; path: string }
