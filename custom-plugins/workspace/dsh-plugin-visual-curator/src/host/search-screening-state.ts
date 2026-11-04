/** Durable candidate positions and conservative screening results, without temporary media URLs. */
import { z } from 'zod'
import type { RunRecord } from '../shared/model.ts'
import { searchIssueSchema } from '../shared/search-feedback.ts'

const decisionSchema = z.strictObject({ decision: z.enum(['obvious-reject', 'deep-review', 'uncertain']), reason: z.string() })
const candidateSchema = z.strictObject({ providerAssetId: z.string().min(1), queryIndex: z.number().int().nonnegative(), pageCursor: z.string().nullable() })
/** The pool and its source continuations are committed together before any model work. */
export const searchScreeningCheckpointSchema = z.strictObject({
  version: z.literal(1), nextQuery: z.number().int().nonnegative(), nextPool: z.number().int().nonnegative(),
  pages: z.array(z.strictObject({ cursor: z.string().nullable(), pageCursor: z.string().nullable(), seenCursors: z.array(z.string()), ids: z.array(z.string()), exhausted: z.boolean() })),
  queryCandidates: z.array(z.array(z.string())),
  seenIds: z.array(z.string()), candidateCount: z.number().int().nonnegative(), seenDigests: z.array(z.string()),
  excluded: z.record(z.string(), z.enum(['negative-reference', 'reference', 'previous-selection', 'previous-rejection'])),
  screened: z.record(z.string(), decisionSchema), fallbacks: z.record(z.string(), z.string()),
  importedImages: z.record(z.string(), z.string()), deepDone: z.array(z.string()), deepReviewed: z.number().int().nonnegative(),
  failedQueries: z.number().int().nonnegative(), sourceLimited: z.boolean(),
  issues: z.array(searchIssueSchema),
  pool: z.strictObject({ sequence: z.number().int().nonnegative(), candidates: z.array(candidateSchema), filled: z.boolean() }).optional(),
})
/** Frozen source positions and committed per-source decisions for one search. */
export type SearchScreeningCheckpoint = z.infer<typeof searchScreeningCheckpointSchema>

/** Read only the versioned screening checkpoint; legacy Runs have no screening state.
 * @param run Saved Run whose caller already checked ownership.
 * @returns Validated state, or absence before the first pool and for legacy tasks.
 */
export function searchScreeningState(run: RunRecord): SearchScreeningCheckpoint | undefined {
  const data = z.object({ checkpoint: z.record(z.string(), z.json()).optional() }).parse(run.data)
  return data.checkpoint?.searchScreening === undefined ? undefined : searchScreeningCheckpointSchema.parse(data.checkpoint.searchScreening)
}

/** Project screening evidence without promoting it to a final visual assessment.
 * @param run Saved Run whose caller already checked ownership.
 * @returns Separate coarse/deep counters and exact source identities, or absence for a legacy task.
 */
export function searchScreeningSummary(run: RunRecord) {
  const state = searchScreeningState(run)
  if (!state) return undefined
  return {
    screeningReviewed: Object.keys(state.screened).length,
    screeningRejected: Object.values(state.screened).filter(item => item.decision === 'obvious-reject').length,
    screeningFallback: Object.keys(state.fallbacks).length,
    deepReviewed: state.deepReviewed,
    screenedSources: Object.entries(state.screened).map(([providerAssetId, item]) => ({ providerAssetId, ...item })),
    pendingSourceIds: state.pool?.candidates.filter(item => !state.deepDone.includes(item.providerAssetId) && state.screened[item.providerAssetId]?.decision !== 'obvious-reject').map(item => item.providerAssetId) ?? [],
  }
}
