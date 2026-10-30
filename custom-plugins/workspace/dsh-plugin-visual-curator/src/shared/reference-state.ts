/** Current-collection membership and per-image analysis eligibility, without private model inputs. */
import { z } from 'zod'
import { styleSchema, referenceSchema, imageVersionSchema, observationSchema, runSchema } from './model.ts'

/** Frozen observation links retain the Run that owns the original model request. */
export const reusedObservationSchema = z.strictObject({ runId: runSchema.shape.id, observationId: observationSchema.shape.id, imageVersionId: imageVersionSchema.shape.id })
/** Read-only plan; its digest is checked again before accepting a confirmed analysis. */
export const referenceStateSchema = z.strictObject({
  styleId: styleSchema.shape.id, revision: z.number().int().positive(), digest: z.string(),
  total: z.number().int().nonnegative(), pending: z.number().int().nonnegative(), reusable: z.number().int().nonnegative(), changed: z.number().int().nonnegative(),
  entries: z.array(z.strictObject({ referenceId: referenceSchema.shape.id, imageVersionId: imageVersionSchema.shape.id, state: z.enum(['pending', 'analyzed', 'needs-update']), providerId: z.string().optional(), photoId: z.string().optional() })),
})
/** Validated reference-state response shared by gallery and analysis controls. */
export type ReferenceState = z.infer<typeof referenceStateSchema>
