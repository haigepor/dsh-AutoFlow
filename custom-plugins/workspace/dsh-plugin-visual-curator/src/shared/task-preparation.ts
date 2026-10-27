/** Read-only preparation responses share validated saved usage and standard records. */
import { z } from 'zod'
import { recipeSchema, jsonSchema, usageSchema, styleStandardSchema } from './model.ts'

const options = z.object({ usages: z.object({ items: z.array(usageSchema), pageToken: z.string().optional() }), sourceId: z.string(), budgets: z.record(z.string(), z.number()) })
/** Prepared inputs carry no authorization or secret values; the Host checks the digest again. */
export const taskPreparationSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('needs-input'), missingFields: z.array(z.string()), options }),
  z.object({ status: z.literal('blocked'), options, error: z.object({ code: z.string(), safeMessage: z.string(), suggestedAction: z.string() }) }),
  z.object({ status: z.literal('ready'), options, normalizedInput: z.record(z.string(), jsonSchema), preparationDigest: z.string(), warnings: z.array(z.string()), summary: z.object({ executionInstructions: z.string().nullable().optional(), executionRecipe: recipeSchema.nullable().optional(), release: styleStandardSchema, usage: usageSchema, budgets: z.record(z.string(), z.number()) }) }),
])
export type TaskPreparation = z.infer<typeof taskPreparationSchema>
