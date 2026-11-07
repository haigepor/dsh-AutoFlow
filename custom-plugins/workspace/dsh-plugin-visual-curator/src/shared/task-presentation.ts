/** Bounded checkpoints derived from saved tasks, never an execution command. */
import { z } from 'zod'
const failure = z.object({ code: z.string(), safeMessage: z.string(), suggestedAction: z.string().optional(), retryable: z.boolean().optional() })
const common = {
  launchId: z.string(), brief: z.string(), target: z.number().int().positive(), outputKind: z.string(),
  pollMs: z.number().int().positive(), wallpaper: z.boolean(),
  modelProfileId: z.string(), styleId: z.string(), profileRevision: z.number().int().positive(), datasetId: z.string().optional(), model: z.object({ provider: z.string().optional(), model: z.string() }),
}
/** Requirements and admission state of the stable task group. */
export const launchPresentationSchema = z.object({
  type: z.literal('launch'), ...common, status: z.enum(['working', 'accepted', 'failed', 'stopped']), stage: z.string(),
  stopping: z.boolean().optional(), directory: z.string().optional(), error: failure.optional(),
})
/** Safe facts about one actual request; an unreturned response remains pending. */
export const requestPresentationSchema = z.object({
  id: z.string(), createdAt: z.string(), state: z.enum(['reserved', 'committed', 'outcome-unknown']),
  operation: z.string(), attempt: z.number().int().positive(), error: failure.optional(), output: z.string().optional(),
})
/** A Run and its configured recent request window. Full inputs stay in the authorized task record. */
export const runPresentationSchema = z.object({
  type: z.literal('run'), ...common, runId: z.string(), runKind: z.string(),
  status: z.enum(['created', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'interrupted', 'completed', 'failed']),
  stage: z.string().nullable(), outcome: z.string().optional(), counts: z.record(z.string(), z.number()),
  requestCount: z.number().int().nonnegative(), requests: z.array(requestPresentationSchema), failures: z.array(requestPresentationSchema),
  error: failure.optional(), warnings: z.array(z.string()), continuation: z.boolean(),
})
/** Wire validation shared by the native journal producer and Chat renderer. */
export const taskPresentationSchema = z.discriminatedUnion('type', [launchPresentationSchema, runPresentationSchema])
/** One producer-owned body of a native task checkpoint. */
export type TaskPresentation = z.infer<typeof taskPresentationSchema>
