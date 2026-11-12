/** Direct-original quality policies never refer to a learned style release. */
import { z } from 'zod'

/** Frozen original-fidelity policy and exact prompt identity used by a final assessment. */
export const directCropPolicySchema = z.strictObject({ version: z.enum(['source-faithful-v1', 'source-faithful-v2', 'subject-repair-v1']), promptDigest: z.string() })
