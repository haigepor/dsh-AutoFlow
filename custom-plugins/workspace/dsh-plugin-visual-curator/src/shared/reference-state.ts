/** Current-collection membership and per-image analysis eligibility, without private model inputs. */
import { z } from 'zod'
import { styleSchema, referenceSchema, imageVersionSchema, observationSchema, runSchema } from './model.ts'

/** Frozen observation links retain the Run that owns the original model request. */
export const reusedObservationSchema = z.strictObject({ runId: runSchema.shape.id, observationId: observationSchema.shape.id, imageVersionId: imageVersionSchema.shape.id })
/** Read-only plan; its digest is checked again before accepting a confirmed analysis. */
export const referenceStateSchema = z.strictObject({
  styleId: styleSchema.shape.id, revision: z.number().int().positive(), digest: z.string(),
  total: z.number().int().nonnegative(), pending: z.number().int().nonnegative(), reusable: z.number().int().nonnegative(), changed: z.number().int().nonnegative(),
  entries: z.array(z.strictObject({ referenceId: referenceSchema.shape.id, imageVersionId: imageVersionSchema.shape.id, role: referenceSchema.shape.role, state: z.enum(['pending', 'analyzed', 'needs-update']), providerId: z.string().optional(), photoId: z.string().optional() })),
})
/** Validated reference-state response shared by gallery and analysis controls. */
export type ReferenceState = z.infer<typeof referenceStateSchema>

/** @param plan Confirmed current references. @param scope All images, unfinished observations or reusable observations. @returns Unique-image role counts; conflicting roles stay visible without counting an image twice. */
export function analysisRoleCounts(plan: ReferenceState, scope: 'all' | 'pending' | 'reusable') {
  const images = new Map<string, Set<ReferenceState['entries'][number]['role']>>()
  for (const entry of plan.entries) {
    if (scope === 'pending' && entry.state === 'analyzed' || scope === 'reusable' && entry.state !== 'analyzed') continue
    const roles = images.get(entry.imageVersionId) ?? new Set(); roles.add(entry.role); images.set(entry.imageVersionId, roles)
  }
  const counts = { positive: 0, negative: 0, undecided: 0, mixed: 0 }
  for (const roles of images.values()) { if (roles.size > 1) counts.mixed++; else counts[roles.values().next().value!]++ }
  return counts
}
