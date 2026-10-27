/** Versioned final style coverage; values describe rule satisfaction, not probability. */
import { z } from 'zod'

export const styleMatchSchema = z.object({ policyVersion: z.literal('rule-coverage-v2'), verdict: z.enum(['matched', 'not-matched', 'unknown']), groupId: z.string().nullable(), satisfiedWeightRatio: z.number().min(0).max(1).nullable(), reasonCodes: z.array(z.string()) })
export type StyleMatch = z.infer<typeof styleMatchSchema>
