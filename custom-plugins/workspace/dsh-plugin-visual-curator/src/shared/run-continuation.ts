/** One continuation decision shared by task controls and read-only progress. */
import { z } from 'zod'

/** Recovery never creates a fresh task or resets its frozen budgets. */
export const runContinuationSchema = z.strictObject({ allowed: z.boolean(), reason: z.enum(['ready', 'active', 'completed', 'cancelled', 'not-retryable', 'deadline', 'vision-limit', 'outcome-unknown', 'storage-restart', 'unavailable']) })
/** Saved task recovery eligibility, recomputed before admission. */
export type RunContinuation = z.infer<typeof runContinuationSchema>
