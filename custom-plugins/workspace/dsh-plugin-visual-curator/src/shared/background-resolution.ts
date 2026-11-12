/** Background reconstruction is separate from native generation and preserves the saved original. */
import { z } from 'zod'
import { realEsrganRuntimeSchema } from './clarity.ts'

/** Fixed weight identity retained only to validate already saved Real-ESRGAN results. */
export const legacyRealEsrganWeightsDigest = '713ee713b0353afaa27976f0563a64a5043bd70b9bd8936c2e26e25ebcdbcddf'

/** Frozen limits for reconstruction, including older tasks that review its output. */
const legacyBackgroundResolutionSettingsSchema = z.strictObject({
  version: z.literal('espcn-background-v1').default('espcn-background-v1'), enabled: z.boolean().default(true),
  maxInputPixels: z.number().int().min(4096).max(2_000_000).default(2_000_000),
  timeoutMs: z.number().int().min(1000).max(120_000).default(120_000),
})
/** Saved Real-ESRGAN settings remain readable; inference is resolved separately to ESPCN x3. */
export const backgroundResolutionSettingsSchema = z.union([legacyBackgroundResolutionSettingsSchema, legacyBackgroundResolutionSettingsSchema.extend({ version: z.literal('realesrgan-background-v1').default('realesrgan-background-v1'), timeoutMs: z.number().int().min(1000).max(600_000).default(300_000), runtime: realEsrganRuntimeSchema.default(() => realEsrganRuntimeSchema.parse({})) })])
/** The policy is absent from older tasks until an explicit recomposition opts in. */
export type BackgroundResolutionSettings = z.infer<typeof backgroundResolutionSettingsSchema>
/** Select ESPCN while preserving saved image limits within its worker deadline.
 * @param policy Parsed current or historical reconstruction policy.
 * @returns CPU-only settings for the next inference; the saved policy is unchanged.
 */
export function resolveEspcnBackground(policy: BackgroundResolutionSettings): z.infer<typeof legacyBackgroundResolutionSettingsSchema> {
  if (policy.version === 'espcn-background-v1') return policy
  const { runtime: _runtime, version: _version, ...limits } = policy
  return legacyBackgroundResolutionSettingsSchema.parse({ ...limits, timeoutMs: Math.min(policy.timeoutMs, 120_000) })
}
const dimensions = z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() })
/** Original provider dimensions and learned reconstruction evidence remain distinguishable from final dimensions. */
export const backgroundResolutionStateSchema = z.strictObject({
  status: z.enum(['enhancing', 'reviewing', 'passed', 'needs-review', 'failed']), reason: z.string(),
  input: dimensions.extend({ digest: z.string() }), originalId: z.string().optional(), enhancedId: z.string().optional(),
  output: dimensions.optional(), model: z.enum(['espcn-x3-luma', 'realesrgan-x4plus']).optional(), modelSha256: z.string().optional(),
  nativeOutput: dimensions.optional(),
  queueMs: z.number().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(), pixels: z.number().int().positive().optional(), tiles: z.number().int().positive().optional(),
  reusedFromRevision: z.number().int().positive().optional(),
  policyDigest: z.string().optional(),
})
