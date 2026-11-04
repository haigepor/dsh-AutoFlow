/** New searches freeze their candidate-pool and thumbnail limits independently of final review. */
import { z } from 'zod'

/** Missing fields are invalid in a saved policy; older Runs omit the entire policy. */
export const searchScreeningPolicySchema = z.strictObject({
  version: z.literal(1),
  candidatePoolSize: z.union([z.literal(50), z.literal(100)]),
  batchSize: z.number().int().min(1).max(16),
  maxScreeningImageEdge: z.number().int().min(128).max(1024),
})
/** Immutable settings admitted with one search. */
export type SearchScreeningPolicy = z.infer<typeof searchScreeningPolicySchema>
