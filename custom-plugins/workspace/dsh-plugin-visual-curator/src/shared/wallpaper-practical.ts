/** Compact final-image observations keep practical quality decisions separate from stored review history. */
import { z } from 'zod'
import type { WallpaperSourceIntent } from './wallpaper-source-intent.ts'

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
/** Explicit source-grounded verdict; absence never means a successful preservation check. */
export const wallpaperSourcePreservationCheckSchema = z.strictObject({ result: z.enum(['satisfied', 'violated', 'unknown']), reason: text })
/** Each frozen primary and indispensable structure receives independent preservation checks. */
export const wallpaperSourcePreservationSchema = z.array(z.strictObject({ entityId: id, framing: wallpaperSourcePreservationCheckSchema, appearance: wallpaperSourcePreservationCheckSchema, relationships: wallpaperSourcePreservationCheckSchema })).max(32).superRefine((checks, ctx) => {
  const ids = new Set<string>()
  for (const [index, check] of checks.entries()) {
    if (ids.has(check.entityId)) ctx.addIssue({ code: 'custom', path: [index, 'entityId'], message: 'Source preservation checks identify each frozen primary exactly once.' })
    ids.add(check.entityId)
  }
})
const currentRegionFields = region.extend({ entityId: id, layoutFocus: rect.optional().describe('Actual output coordinates of the frozen source layout focus; retain the complete subject rect independently.') })
function validateLayoutFocus(value: z.infer<typeof currentRegionFields>, ctx: z.RefinementCtx, path: (string | number)[] = []) {
  const focus = value.layoutFocus
  if (focus && (focus.x < value.rect.x || focus.y < value.rect.y || focus.x + focus.width > value.rect.x + value.rect.width || focus.y + focus.height > value.rect.y + value.rect.height)) ctx.addIssue({ code: 'custom', path: [...path, 'layoutFocus'], message: 'The actual layout focus must remain inside the complete actual subject rectangle.' })
}
const currentRegion = currentRegionFields.superRefine(validateLayoutFocus)

/** A complete practical review reports visible defects rather than exhaustive object inventories or repeated passing reasons. */
const practicalBaseSchema = z.strictObject({
  reviewVersion: z.literal('wallpaper-review-source-v4'), protocol: z.enum(['practical-v1', 'practical-v2']),
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
const legacyReviewSchema = practicalBaseSchema.safeExtend({ protocol: z.literal('practical-v1') })
const currentReviewSchema = practicalBaseSchema.safeExtend({ protocol: z.literal('practical-v2'), actualLayout: z.strictObject({ regions: z.array(currentRegion).max(32) }), sourcePreservation: wallpaperSourcePreservationSchema, sourceStyle: wallpaperSourcePreservationCheckSchema }).superRefine((review, ctx) => {
  const observed = new Set(review.actualLayout.regions.filter(value => value.scope === 'core').map(value => value.entityId))
  for (const defect of review.defects) if (defect.absent && defect.entityId) observed.add(defect.entityId)
  for (const entityId of observed) if (!review.sourcePreservation.some(check => check.entityId === entityId)) ctx.addIssue({ code: 'custom', path: ['sourcePreservation'], message: `The source-preservation result for ${entityId} is required independently of the defect list.` })
})
/** Historical compact responses remain readable; source-intent responses require explicit preservation evidence. */
export const wallpaperPracticalReviewSchema = z.discriminatedUnion('protocol', [legacyReviewSchema, currentReviewSchema])

/** Parsed practical observations before conversion to the existing stored review fields. */
export type WallpaperPracticalReview = z.infer<typeof wallpaperPracticalReviewSchema>

/** Bind a compact response to exact image identities and the original's frozen main subjects.
 * @param sourceImageVersionId Authorized original image identity.
 * @param outputImageVersionId Actual complete final-image identity.
 * @param primarySubjects Frozen identities and names; current preservation includes primary and critical-part roles, while historical compact responses include primaries only.
 * @param sourceMode Frozen original composition; object-focused originals cannot become scene reviews to evade subject checks.
 * @param sourceIntentPolicy Require the current protocol, source preservation and output focus measurements.
 * @param projectFrozenFocus Keep auxiliary output focus measurements only where the original defined them.
 * @returns The compact wire schema requiring each frozen main subject once, without an inventory of supporting objects.
 */
export function wallpaperPracticalReviewOutputSchema(sourceImageVersionId: string, outputImageVersionId: string, primarySubjects?: readonly { entityId: string; name: string; role?: 'primary' | 'critical-part' | 'supporting' | undefined; safetyClass?: WallpaperSafetyClass | undefined; sourceIntent?: WallpaperSourceIntent | undefined }[], sourceMode?: WallpaperPracticalReview['mode'], sourceIntentPolicy = false, projectFrozenFocus = false) {
  const protocol = sourceIntentPolicy ? currentReviewSchema : legacyReviewSchema
  const images = protocol.safeExtend({ sourceImageVersionId: z.literal(sourceImageVersionId), outputImageVersionId: z.literal(outputImageVersionId) })
  const identified = sourceMode && sourceMode !== 'uncertain' ? images.safeExtend({ mode: z.enum([sourceMode, 'uncertain']) }) : images
  if (!primarySubjects) return identified
  const primaryIds = primarySubjects.map(subject => subject.entityId)
  const classifications = new Map(primarySubjects.map(subject => [subject.entityId, subject.safetyClass]))
  const focused = new Set(primarySubjects.filter(subject => subject.sourceIntent?.layoutFocus).map(subject => subject.entityId))
  const outputRegion = sourceIntentPolicy ? projectFrozenFocus ? currentRegionFields.extend({
    layoutFocus: currentRegionFields.shape.layoutFocus.describe('Only for a primary with a frozen source layoutFocus. Measure that same focus in the output and independently report the complete visible subject in rect. Omit for other entities.'),
  }) : currentRegion : region
  const regions = primaryIds.length
    ? z.array(outputRegion.safeExtend({ entityId: z.enum(primaryIds).describe(`Frozen primary identities and names: ${JSON.stringify(primarySubjects)}. Locate each subject's own visible body; exclude separate supporting props.`) })).max(32)
    : z.array(outputRegion.safeExtend({ entityId: id })).max(0)
  const bound = practicalBaseSchema.safeExtend({ sourceImageVersionId: z.literal(sourceImageVersionId), outputImageVersionId: z.literal(outputImageVersionId), actualLayout: z.strictObject({ regions }) })
  const boundMode = sourceMode && sourceMode !== 'uncertain' ? bound.safeExtend({ mode: z.enum([sourceMode, 'uncertain']) }) : bound
  const normalized = boundMode.overwrite(review => ({ ...review, actualLayout: { ...review.actualLayout, regions: review.actualLayout.regions.map(({ safetyClass: _reported, ...observed }) => {
    const safetyClass = classifications.get(observed.entityId)
    if (projectFrozenFocus && 'layoutFocus' in observed && (observed.role !== 'subject' || observed.scope !== 'core' || !focused.has(observed.entityId))) {
      const { layoutFocus: _unrequested, ...subject } = observed
      return { ...subject, ...(safetyClass ? { safetyClass } : {}) }
    }
    return { ...observed, ...(safetyClass ? { safetyClass } : {}) }
  }) } }))
  const preservation = primaryIds.length
    ? z.array(wallpaperSourcePreservationSchema.element.extend({ entityId: z.enum(primaryIds).describe('One preservation result per frozen primary or critical-part identity; exclude supporting objects.') })).length(primaryIds.length)
    : wallpaperSourcePreservationSchema.max(0)
  const required = sourceIntentPolicy ? normalized.safeExtend({ protocol: z.literal('practical-v2'), sourcePreservation: preservation, sourceStyle: wallpaperSourcePreservationCheckSchema }) : normalized.safeExtend({ protocol: z.literal('practical-v1') })
  return required.superRefine((review, ctx) => {
    if (primarySubjects.some(subject => subject.safetyClass === 'automobile') && (review.mode === 'scene' || review.mode === 'abstract')) ctx.addIssue({ code: 'custom', path: ['mode'], message: 'A frozen primary automobile cannot become a scene or abstract review.' })
    for (const [index, value] of review.defects.entries()) if (value.entityId && !primaryIds.includes(value.entityId)) ctx.addIssue({ code: 'custom', path: ['defects', index, 'entityId'], message: 'Subject defect identities must reference a frozen primary subject.' })
    if (review.protocol === 'practical-v2') {
      for (const subject of primarySubjects) if (review.sourcePreservation.filter(check => check.entityId === subject.entityId).length !== 1) ctx.addIssue({ code: 'custom', path: ['sourcePreservation'], message: `Provide framing, appearance and relationship evidence for ${subject.entityId} (${subject.name}) exactly once.` })
    }
    if (projectFrozenFocus) for (const [index, region] of review.actualLayout.regions.entries()) {
      if ('layoutFocus' in region) validateLayoutFocus(region, ctx, ['actualLayout', 'regions', index])
    }
    for (const subject of primarySubjects) {
      const observed = review.actualLayout.regions.filter(value => value.entityId === subject.entityId)
      const requiredRole = sourceIntentPolicy && subject.role === 'critical-part' ? 'critical' : 'subject'
      const coreCount = observed.filter(value => value.role === requiredRole && value.scope === 'core').length
      const absentCount = review.defects.filter(value => value.entityId === subject.entityId && value.kind === 'subject-damage' && value.severity === 'major' && value.absent).length
      if (sourceIntentPolicy && !subject.sourceIntent?.layoutFocus) for (const [index, value] of review.actualLayout.regions.entries()) if (value.entityId === subject.entityId && value.role === 'subject' && value.scope === 'core' && 'layoutFocus' in value && value.layoutFocus) ctx.addIssue({ code: 'custom', path: ['actualLayout', 'regions', index, 'layoutFocus'], message: 'A review cannot introduce a focus that was not observed and frozen in the source.' })
      if (sourceIntentPolicy && subject.sourceIntent?.layoutFocus && !absentCount) for (const [index, value] of review.actualLayout.regions.entries()) if (value.entityId === subject.entityId && value.role === 'subject' && value.scope === 'core' && !('layoutFocus' in value && value.layoutFocus)) ctx.addIssue({ code: 'custom', path: ['actualLayout', 'regions', index, 'layoutFocus'], message: 'Locate the frozen source focus in the output while retaining the complete actual subject rectangle.' })
      if (coreCount === 1 && absentCount === 0 || !observed.length && absentCount === 1) continue
      ctx.addIssue({ code: 'custom', path: ['actualLayout', 'regions'], message: `Locate ${subject.entityId} (${subject.name}) exactly once as ${requiredRole}/core, or explicitly report this protected entity as entirely absent. Additional peripheral or critical regions may share its identity; scene mode cannot omit a frozen subject.` })
    }
  })
}
