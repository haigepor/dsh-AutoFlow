/** A separate, bounded super-resolution version never changes the accepted source. */
import { z } from 'zod'

/** Deployment limits are frozen only for newly accepted wallpaper work. */
export const claritySettingsSchema = z.strictObject({
  version: z.literal('espcn-luma-v1').default('espcn-luma-v1'), enabled: z.boolean().default(true),
  maxSubjectPixels: z.number().int().min(4096).max(2_000_000).default(800_000),
  timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
  blend: z.number().positive().max(0.5).default(0.35), featherPixels: z.number().int().min(1).max(32).default(8),
})
/** Frozen enhancement policy, independent of image-generation edit budgets. */
export type ClaritySettings = z.infer<typeof claritySettingsSchema>
/** Saved evidence for one optional, separately reviewed enhancement. Absence means no historical check. */
export const clarityStateSchema = z.strictObject({
  status: z.enum(['pending', 'not-needed', 'enhancing', 'reviewing', 'passed', 'needs-review', 'failed']),
  reason: z.string(), originalOutputId: z.string().optional(), enhancedOutputId: z.string().optional(),
  model: z.literal('espcn-x3-luma').optional(), modelSha256: z.string().optional(),
  durationMs: z.number().nonnegative().optional(), pixels: z.number().int().nonnegative().optional(), tiles: z.number().int().nonnegative().optional(), changedPixels: z.number().int().nonnegative().optional(),
})
/** One saved enhancement-stage result, without inferred success for older tasks. */
export type ClarityState = z.infer<typeof clarityStateSchema>
