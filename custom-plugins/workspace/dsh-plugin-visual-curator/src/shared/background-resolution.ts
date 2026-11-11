/** Background reconstruction is separate from native generation and never changes protected source pixels. */
import { z } from 'zod'

/** Frozen limits for a new, independently reviewed background reconstruction. */
export const backgroundResolutionSettingsSchema = z.strictObject({
  version: z.literal('espcn-background-v1').default('espcn-background-v1'), enabled: z.boolean().default(true),
  maxInputPixels: z.number().int().min(4096).max(2_000_000).default(2_000_000),
  timeoutMs: z.number().int().min(1000).max(120_000).default(120_000),
})
/** The policy is absent from older tasks until an explicit recomposition opts in. */
export type BackgroundResolutionSettings = z.infer<typeof backgroundResolutionSettingsSchema>
const dimensions = z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() })
/** Original provider dimensions and learned reconstruction evidence remain distinguishable from final dimensions. */
export const backgroundResolutionStateSchema = z.strictObject({
  status: z.enum(['enhancing', 'reviewing', 'passed', 'needs-review', 'failed']), reason: z.string(),
  input: dimensions.extend({ digest: z.string() }), originalId: z.string().optional(), enhancedId: z.string().optional(),
  output: dimensions.optional(), model: z.literal('espcn-x3-luma').optional(), modelSha256: z.string().optional(),
  durationMs: z.number().nonnegative().optional(), pixels: z.number().int().positive().optional(), tiles: z.number().int().positive().optional(),
})
