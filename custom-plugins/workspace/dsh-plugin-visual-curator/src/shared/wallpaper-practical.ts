/** Compact final-image observations keep practical quality decisions separate from stored review history. */
import { z } from 'zod'

/** Source-owned visual categories select the final subject safety requirement. */
export const wallpaperSafetyClassSchema = z.enum(['automobile', 'general'])
/** Frozen visual classification; final-image reviewers do not reclassify source subjects. */
export type WallpaperSafetyClass = z.infer<typeof wallpaperSafetyClassSchema>

const text = z.string().trim().min(1).max(240)
const id = z.string().min(1).max(1024)
const rect = z.strictObject({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1), width: z.number().finite().positive().max(1), height: z.number().finite().positive().max(1) }).refine(value => value.x + value.width <= 1 && value.y + value.height <= 1)
const region = z.strictObject({ name: text, entityId: id.optional(), role: z.enum(['subject', 'critical']), scope: z.enum(['core', 'peripheral']), rect, safetyClass: wallpaperSafetyClassSchema.optional().describe('Host-owned source classification; omit this field instead of reclassifying the source subject.') })
const defect = z.strictObject({ kind: z.enum(['layout', 'subject-damage', 'duplicate-subject', 'collage-seam', 'quality-loss', 'style-change']), severity: z.enum(['major', 'minor']), reason: text, outputRect: rect.optional(), entityId: id.optional().describe('The affected frozen primary identity, when the defect concerns a main subject.'), absent: z.literal(true).optional().describe('Only for an entirely missing frozen primary subject: major subject-damage with its entityId. Do not invent an output rectangle for an absent subject.') })
const inspectionRect = rect.refine(value => value.width * value.height <= 0.25 && value.width < 0.85 && value.height < 0.85, { message: 'A native-detail inspection must address a genuinely local region, at most one quarter of its full image.' })

/** A complete practical review reports visible defects rather than exhaustive object inventories or repeated passing reasons. */
export const wallpaperPracticalReviewSchema = z.strictObject({
  reviewVersion: z.literal('wallpaper-review-source-v4'), protocol: z.literal('practical-v1'),
  sourceImageVersionId: id, outputImageVersionId: id,
  mode: z.enum(['single', 'group', 'scene', 'abstract', 'uncertain']), subject: text,
  actualLayout: z.strictObject({ regions: z.array(region).max(32) }),
  defects: z.array(defect).max(12),
  uncertainties: z.array(z.string().trim().min(1).max(160)).max(4),
  inspection: z.strictObject({ sourceRect: inspectionRect, outputRect: inspectionRect, question: text }).optional().describe('Only for a reported acceptance-critical uncertainty that local original/output pixels can answer. Omit for known defects, ordinary background variation, normal occlusion, unreadable incidental text and unseen off-frame content.'),
}).superRefine((review, ctx) => {
  if (review.sourceImageVersionId === review.outputImageVersionId) ctx.addIssue({ code: 'custom', path: ['outputImageVersionId'], message: 'The original and final output must have distinct identities.' })
  if ((review.mode === 'single' || review.mode === 'group') && !review.actualLayout.regions.some(value => value.role === 'subject' && value.scope === 'core') && !review.defects.some(value => value.kind === 'subject-damage' && value.severity === 'major' && value.absent && value.entityId)) ctx.addIssue({ code: 'custom', path: ['actualLayout', 'regions'], message: 'Locate the actual main subject in the complete output, or explicitly identify an entirely absent main subject.' })
  for (const [index, value] of review.actualLayout.regions.entries()) if (value.role === 'critical' && value.scope !== 'core') ctx.addIssue({ code: 'custom', path: ['actualLayout', 'regions', index, 'scope'], message: 'Indispensable subject structures use core scope.' })
  for (const [index, value] of review.defects.entries()) {
    if (value.absent && (value.kind !== 'subject-damage' || value.severity !== 'major' || !value.entityId)) ctx.addIssue({ code: 'custom', path: ['defects', index, 'absent'], message: 'Only major subject damage may identify an entirely absent frozen main subject, using its entityId.' })
    if (value.severity === 'major' && value.kind !== 'layout' && !value.absent && !value.outputRect) ctx.addIssue({ code: 'custom', path: ['defects', index, 'outputRect'], message: 'A major content defect requires its visible location in the complete final image.' })
  }
  if (review.inspection && !review.uncertainties.length) ctx.addIssue({ code: 'custom', path: ['inspection'], message: 'A local inspection requires an explicitly reported unresolved quality question.' })
})

/** Parsed practical observations before conversion to the existing stored review fields. */
export type WallpaperPracticalReview = z.infer<typeof wallpaperPracticalReviewSchema>

/** Bind a compact response to exact image identities and the original's frozen main subjects.
 * @param sourceImageVersionId Authorized original image identity.
 * @param outputImageVersionId Actual complete final-image identity.
 * @param primarySubjects Frozen primary identities and names; omission retains historical compact responses without source-role annotations.
 * @param sourceMode Frozen original composition; object-focused originals cannot become scene reviews to evade subject checks.
 * @returns The compact wire schema requiring each frozen main subject once, without an inventory of supporting objects.
 */
export function wallpaperPracticalReviewOutputSchema(sourceImageVersionId: string, outputImageVersionId: string, primarySubjects?: readonly { entityId: string; name: string; safetyClass?: WallpaperSafetyClass | undefined }[], sourceMode?: WallpaperPracticalReview['mode']) {
  const images = wallpaperPracticalReviewSchema.safeExtend({ sourceImageVersionId: z.literal(sourceImageVersionId), outputImageVersionId: z.literal(outputImageVersionId) })
  const identified = sourceMode && sourceMode !== 'uncertain' ? images.safeExtend({ mode: z.enum([sourceMode, 'uncertain']) }) : images
  if (!primarySubjects) return identified
  const primaryIds = primarySubjects.map(subject => subject.entityId)
  const classifications = new Map(primarySubjects.map(subject => [subject.entityId, subject.safetyClass]))
  const regions = primaryIds.length
    ? z.array(region.extend({ entityId: z.enum(primaryIds).describe(`Frozen primary identities and names: ${JSON.stringify(primarySubjects)}. Locate each subject's own visible body; exclude separate supporting props.`) })).max(32)
    : z.array(region.extend({ entityId: id })).max(0)
  return identified.safeExtend({ actualLayout: z.strictObject({ regions }) }).overwrite(review => ({ ...review, actualLayout: { ...review.actualLayout, regions: review.actualLayout.regions.map(({ safetyClass: _reported, ...observed }) => {
    const safetyClass = classifications.get(observed.entityId)
    return { ...observed, ...(safetyClass ? { safetyClass } : {}) }
  }) } })).superRefine((review, ctx) => {
    if (primarySubjects.some(subject => subject.safetyClass === 'automobile') && (review.mode === 'scene' || review.mode === 'abstract')) ctx.addIssue({ code: 'custom', path: ['mode'], message: 'A frozen primary automobile cannot become a scene or abstract review.' })
    for (const [index, value] of review.defects.entries()) if (value.entityId && !primaryIds.includes(value.entityId)) ctx.addIssue({ code: 'custom', path: ['defects', index, 'entityId'], message: 'Subject defect identities must reference a frozen primary subject.' })
    for (const subject of primarySubjects) {
      const observed = review.actualLayout.regions.filter(value => value.entityId === subject.entityId)
      const coreCount = observed.filter(value => value.role === 'subject' && value.scope === 'core').length
      const absentCount = review.defects.filter(value => value.entityId === subject.entityId && value.kind === 'subject-damage' && value.severity === 'major' && value.absent).length
      if (coreCount === 1 && absentCount === 0 || !observed.length && absentCount === 1) continue
      ctx.addIssue({ code: 'custom', path: ['actualLayout', 'regions'], message: `Locate ${subject.entityId} (${subject.name}) exactly once as subject/core, or explicitly report this primary as entirely absent. Additional peripheral or critical regions may share its identity; scene mode cannot omit a frozen primary.` })
    }
  })
}
