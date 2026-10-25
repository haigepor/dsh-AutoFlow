/** Versioned API observations remain separate from human-confirmed style rules. */
import { z } from 'zod'
import { dimensionSchema, referenceSchema, observationSchema, runSchema, draftSchema, recipeSchema, type RunRecord } from './model.ts'

const text = z.string().trim().min(1).max(4096)
const imageIds = z.array(z.string().min(1))
/** Model proposals carry explicit positive and negative evidence; publication is a separate human action. */
export const proposedRuleSchema = z.strictObject({ statement: text, dimension: dimensionSchema, strength: z.enum(['required', 'preferred', 'reference-only']), stage: z.enum(['source', 'final']), supportImageVersionIds: imageIds, counterImageVersionIds: imageIds, condition: z.string().max(4096), exceptions: z.array(text) })
/** Cross-image induction includes disagreements and insufficient evidence instead of a single average style. */
export const styleSummarySchema = z.strictObject({
  name: text, summary: text, matchingPrompt: text, searchHints: z.array(text).max(20), avoidTerms: z.array(text).max(20),
  dimensions: z.array(z.strictObject({ dimension: dimensionSchema, description: text, consistency: z.enum(['consistent', 'mixed', 'insufficient']), supportImageVersionIds: imageIds, counterImageVersionIds: imageIds })).min(1).max(7),
  conflicts: z.array(z.strictObject({ description: text, imageVersionIds: imageIds.min(1) })).max(30),
  suggestedRules: z.array(proposedRuleSchema).max(30),
  organization: z.strictObject({ groups: z.array(z.strictObject({ groupId: text, name: text, description: text, imageVersionIds: imageIds.min(1) })), selections: z.array(z.strictObject({ ruleIndex: z.number().int().nonnegative(), enabled: z.boolean(), groupId: z.string().nullable(), reason: text })) }).optional(),
})
/** Immutable checkpoint result, pinned to all input references and the exact API request versions. */
export const styleAnalysisSchema = z.strictObject({
  formatVersion: z.literal(1), runId: runSchema.shape.id, styleId: draftSchema.shape.styleId,
  draftId: draftSchema.shape.id, draftRevision: z.number().int().positive(), referenceDigest: z.string(),
  feedbackIds: z.array(z.string()), recipeId: recipeSchema.shape.id,
  model: z.string(), declaredModelVersion: z.string().nullable(),
  observationPromptVersion: z.literal('visual-curator-v1'), summaryPromptVersion: z.enum(['visual-curator-summary-v1', 'visual-curator-summary-v2']),
  summaryRequestId: z.string(),
  samples: z.array(z.strictObject({ reference: referenceSchema, imageDigest: z.string(), observationId: observationSchema.shape.id, feedbackIds: z.array(z.string()) })).min(1),
  summary: styleSummarySchema,
})
/** Durable analysis result; observations retain their original API authorship. */
export type StyleAnalysis = z.infer<typeof styleAnalysisSchema>
/** Model-generated style description awaiting human review. */
export type StyleSummary = z.infer<typeof styleSummarySchema>

/** Read only committed, validated analysis checkpoints; older runs have no style profile.
 * @param run Durable task record. @returns Versioned profile when its checkpoint exists.
 */
export function styleAnalysisOf(run: RunRecord): StyleAnalysis | undefined {
  const parsed = z.object({ checkpoint: z.object({ styleAnalysis: styleAnalysisSchema }) }).safeParse(run.data)
  return parsed.success ? parsed.data.checkpoint.styleAnalysis : undefined
}
