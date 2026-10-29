/** Safe candidate diagnostics contain stable identities, never temporary locations. */
import { z } from 'zod'

export const searchIssueSchema = z.strictObject({
  candidateId: z.string(), stage: z.enum(['lookup', 'download', 'import', 'source', 'final']),
  category: z.enum(['unavailable', 'technical']), code: z.string(),
  imageVersionId: z.string().optional(), httpStatus: z.number().int().min(100).max(599).optional(),
})
export type SearchIssue = z.infer<typeof searchIssueSchema>

export const runResultFilterSchema = z.enum(['all', 'selected', 'review', 'rejected', 'failed', 'processing', 'pending', 'source'])
export type RunResultFilter = z.infer<typeof runResultFilterSchema>

/** @param input Latest assessment and committed selection state. @returns One mutually exclusive result category; a pass alone never implies selection. */
export function resultCategory(input: { selected: boolean; technicalFailed: boolean; verdict?: 'pass' | 'reject' | 'needs-review' | undefined; settled?: boolean; source?: boolean }): Exclude<RunResultFilter, 'all'> {
  return input.selected ? 'selected' : input.technicalFailed ? 'failed' : input.verdict === 'reject' ? 'rejected' : input.verdict === 'needs-review' ? 'review' : input.source ? 'source' : input.settled ? 'pending' : 'processing'
}
