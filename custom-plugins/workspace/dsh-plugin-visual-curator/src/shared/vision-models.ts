/** Public model choices contain registry identities and labels, never connection settings. */
import { z } from 'zod'

/** Validated catalog returned to the authenticated settings page. */
export const visionModelsSchema = z.strictObject({
  models: z.array(z.strictObject({ provider: z.string().min(1), providerName: z.string(), id: z.string().min(1), name: z.string(), contextWindow: z.number().int().positive().optional(), maxOutputTokens: z.number().int().positive().optional() })),
  unavailable: z.array(z.strictObject({ provider: z.string(), name: z.string() })),
})
export type VisionModels = z.infer<typeof visionModelsSchema>
export type VisionModel = VisionModels['models'][number]
