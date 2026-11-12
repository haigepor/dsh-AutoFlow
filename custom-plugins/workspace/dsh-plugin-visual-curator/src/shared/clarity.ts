/** A separate, bounded super-resolution version never changes the accepted source. */
import { z } from 'zod'

/** SHA-256 of the bundled ESPCN x3 weights used for every new inference. */
export const espcnWeightsDigest = '85f36ff88cc504a24af5e0602148bc56a8aa09a58eca8c0da2756f3e8186035e'

/** Deployment limits are frozen only for newly accepted wallpaper work. */
const legacyClaritySettingsSchema = z.strictObject({
  version: z.literal('espcn-luma-v1').default('espcn-luma-v1'), enabled: z.boolean().default(true),
  maxSubjectPixels: z.number().int().min(4096).max(2_000_000).default(800_000),
  timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
  blend: z.number().positive().max(0.5).default(0.35), featherPixels: z.number().int().min(1).max(32).default(8),
})
/** Read-only settings retained for historical Real-ESRGAN task records. */
export const realEsrganRuntimeSchema = z.strictObject({ executable: z.string().min(1).optional(), tileSize: z.number().int().min(32).max(512).default(128), gpuId: z.number().int().nonnegative().default(0) })
/** Saved Real-ESRGAN settings remain readable; inference is resolved separately to ESPCN x3. */
export const claritySettingsSchema = z.union([legacyClaritySettingsSchema, legacyClaritySettingsSchema.extend({ version: z.literal('realesrgan-general-v1').default('realesrgan-general-v1'), maxSubjectPixels: z.number().int().min(4096).max(2_000_000).default(2_000_000), timeoutMs: z.number().int().min(1000).max(600_000).default(300_000), runtime: realEsrganRuntimeSchema.default(() => realEsrganRuntimeSchema.parse({})) })])
/** Frozen enhancement policy, independent of image-generation edit budgets. */
export type ClaritySettings = z.infer<typeof claritySettingsSchema>
/** Select ESPCN while preserving saved enhancement limits within its worker deadline.
 * @param policy Parsed current or historical enhancement policy.
 * @returns CPU-only settings for the next inference; the saved policy is unchanged.
 */
export function resolveEspcnClarity(policy: ClaritySettings): z.infer<typeof legacyClaritySettingsSchema> {
  if (policy.version === 'espcn-luma-v1') return policy
  const { runtime: _runtime, version: _version, ...limits } = policy
  return legacyClaritySettingsSchema.parse({ ...limits, timeoutMs: Math.min(policy.timeoutMs, 120_000) })
}
/** Saved evidence for one optional, separately reviewed enhancement. Absence means no historical check. */
export const clarityStateSchema = z.strictObject({
  status: z.enum(['pending', 'not-needed', 'enhancing', 'reviewing', 'passed', 'needs-review', 'failed']),
  reason: z.string(), originalOutputId: z.string().optional(), enhancedOutputId: z.string().optional(),
  model: z.enum(['espcn-x3-luma', 'realesrgan-x4plus']).optional(), modelSha256: z.string().optional(),
  nativeOutput: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  durationMs: z.number().nonnegative().optional(), queueMs: z.number().nonnegative().optional(), pixels: z.number().int().nonnegative().optional(), tiles: z.number().int().nonnegative().optional(), changedPixels: z.number().int().nonnegative().optional(),
})
/** One saved enhancement-stage result, without inferred success for older tasks. */
export type ClarityState = z.infer<typeof clarityStateSchema>

/** Live inference counters describe model-reported work, not final image acceptance. */
export const resolutionProgressSchema = z.strictObject({ completed: z.number().int().nonnegative(), total: z.number().int().nonnegative(), unit: z.enum(['tiles', 'percent']).default('tiles') }).refine(value => value.completed <= value.total, 'Completed work cannot exceed total work.')
/** Ephemeral worker counters; zero total means waiting for the serial worker. */
export type ResolutionProgress = z.infer<typeof resolutionProgressSchema>
