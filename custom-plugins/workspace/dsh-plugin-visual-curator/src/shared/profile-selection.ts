/** Small profile-selection responses exclude saved image observations and preview resources. */
import { z } from 'zod'
import { dimensionSchema, modelProfileSchema } from './model.ts'

/** Rule fields displayed by the workbench, with saved evidence identities. */
export const ruleViewSchema = z.object({
  ruleId: z.string(), dimension: dimensionSchema, statement: z.string(),
  strength: z.enum(['required', 'preferred', 'reference-only']), stage: z.enum(['source', 'final']),
  confirmed: z.boolean(), condition: z.string(), exceptions: z.array(z.string()),
  supportRefs: z.array(z.string()), counterRefs: z.array(z.string()),
})

/** A rule projection with evidence; pixel observations are carried separately. */
export type RuleView = z.infer<typeof ruleViewSchema>

const optionSchema = modelProfileSchema.shape.options.element

/** Current immutable selection metadata, safe to merge with observations from the same analysis. */
export const profileSelectionSchema = z.object({
  id: z.string().min(1), revision: z.number().int().positive(), styleId: z.string().min(1),
  analysisRunId: z.string().min(1), stale: z.boolean(),
  options: z.array(z.object({ rule: ruleViewSchema, enabled: z.boolean(), groupId: z.string().nullable(),
    selectionSource: optionSchema.shape.selectionSource, sourceStatement: z.string(), reason: optionSchema.shape.reason })),
})

/** A save acknowledgement identifies the selection it superseded. */
export const profileSaveReceiptSchema = profileSelectionSchema.extend({ previousProfileId: z.string().min(1) })

/** Profile metadata without per-image observations. */
export type ProfileSelection = z.infer<typeof profileSelectionSchema>

/** Validated selection save acknowledgement. */
export type ProfileSaveReceipt = z.infer<typeof profileSaveReceiptSchema>
