/** Versioned wallpaper settings, inferred scene evidence and resumable per-image progress. */
import { z } from 'zod'
import { wallpaperPracticalReviewOutputSchema, wallpaperSafetyClassSchema, wallpaperSourcePreservationSchema, wallpaperSourcePreservationCheckSchema, type WallpaperPracticalReview } from './wallpaper-practical.ts'
import { wallpaperSourceFramingMaxDetails, wallpaperSourceIntentSchema, wallpaperObservedSourceIntentSchema, wallpaperPrimarySourceIntentSchema, wallpaperSourceMediumSchema } from './wallpaper-source-intent.ts'
import { wallpaperReviewEvidenceIssues } from './wallpaper-review-evidence.ts'
import { wallpaperGenerationBriefSchema } from './wallpaper-generation-brief.ts'
import { serverTransferViewSchema } from './server-queue.ts'
import { resolutionProgressSchema } from './clarity.ts'
import { claritySettingsSchema, clarityStateSchema, resolveEspcnClarity } from './clarity.ts'
import { backgroundResolutionSettingsSchema, backgroundResolutionStateSchema, resolveEspcnBackground } from './background-resolution.ts'
import { wallpaperDecisionSettingsSchema, wallpaperDecisionRecordSchema } from './wallpaper-decision.ts'
import { wallpaperBoundaryReviewNeeded, wallpaperClockContrastSchema, wallpaperProcessingSchema, wallpaperRepairPolicySchema, wallpaperGenerativeRepair, wallpaperPracticalAcceptance } from './wallpaper-policy.ts'
import { wallpaperEdgeRepairEvidenceSchema, wallpaperFindingSchema, wallpaperFindingBlocksEditing, wallpaperRetainedUncertaintySchema } from './wallpaper-evidence.ts'
import { styleMatchSchema } from './style-matching.ts'
import { blobRefSchema, runSchema, type Json, type RunRecord } from './model.ts'
import { wallpaperCandidatePlacement, wallpaperObjectProtectionRegions, wallpaperProtectedBounds } from './wallpaper-geometry.ts'

const text = z.string().trim().min(1).max(4096)
const id = z.string().min(1).max(256)
/** Prompt content and identifiers are frozen with each task, independently of future plugin edits. */
export const wallpaperPromptBundleSchema = z.strictObject({
  plan: z.strictObject({ version: z.enum(['wallpaper-plan-v1', 'wallpaper-plan-v2', 'wallpaper-plan-v3', 'wallpaper-plan-v4', 'wallpaper-plan-v5', 'wallpaper-plan-v6', 'wallpaper-plan-v7', 'wallpaper-plan-v8', 'wallpaper-plan-v9', 'wallpaper-plan-v10']), text: z.string().min(1) }),
  replan: z.strictObject({ version: z.literal('wallpaper-source-replan-v1'), text: z.string().min(1) }).optional(),
  framing: z.strictObject({ version: z.literal('wallpaper-source-framing-v1'), text: z.string().min(1) }).optional(),
  detail: z.strictObject({ version: z.enum(['wallpaper-plan-detail-v1', 'wallpaper-plan-detail-v2', 'wallpaper-plan-detail-v3', 'wallpaper-plan-detail-v4', 'wallpaper-plan-detail-v5']), text: z.string().min(1) }).optional(),
  decision: z.strictObject({ version: z.enum(['wallpaper-decision-v1', 'wallpaper-decision-v2']), text: z.string().min(1) }).optional(),
  review: z.strictObject({ version: z.enum(['wallpaper-review-v1', 'wallpaper-review-v2', 'wallpaper-review-v3', 'wallpaper-review-v4', 'wallpaper-review-source-v1', 'wallpaper-review-source-v2', 'wallpaper-review-source-v3', 'wallpaper-review-source-v4']), text: z.string().min(1) }),
  outpaint: z.strictObject({ version: z.enum(['wallpaper-outpaint-v1', 'wallpaper-outpaint-v2', 'wallpaper-outpaint-v3', 'wallpaper-outpaint-v4', 'wallpaper-outpaint-v5', 'wallpaper-outpaint-v6']), text: z.string().min(1) }),
  distill: z.strictObject({ version: z.literal('wallpaper-distill-v1'), text: z.string().min(1) }),
})
const rect = z.strictObject({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1), width: z.number().finite().positive().max(1), height: z.number().finite().positive().max(1) }).refine(r => r.x + r.width <= 1 && r.y + r.height <= 1)
const minimumSubjectScaleRatio = z.number().gt(0).max(1).default(0.9)
const sourceIntentPolicySchema = z.union([
  z.strictObject({ version: z.enum(['source-intent-v1', 'source-intent-v2']), minimumSubjectScaleRatio, alignment: z.literal('subject-center-v1').optional() }),
  z.strictObject({ version: z.literal('source-intent-v2'), minimumSubjectScaleRatio, alignment: z.literal('subject-fill-v1'),
    fill: z.strictObject({
      safeOccupancy: z.number().min(0.5).max(1).default(0.86),
      minimumRetainedAxis: z.number().min(0.4).max(1).default(0.4),
      maximumCenterDrift: z.number().gt(0).max(0.2).default(0.08),
      relativeLayout: z.strictObject({
        minimumRelativeScaleRatio: z.number().min(0.5).max(1).default(0.8),
        minimumWholeAspectRatio: z.number().min(0.5).max(1).default(0.65),
      }).optional(),
    }).prefault({}),
  }),
])
/** Deployment defaults are frozen when a wallpaper task is accepted. */
export const wallpaperSettingsSchema = z.strictObject({
  version: z.literal(1).default(1), width: z.literal(1845).default(1845), height: z.literal(3280).default(3280),
  safe: z.strictObject({ left: z.literal(258).default(258), top: z.literal(1032).default(1032), width: z.literal(1329).default(1329), height: z.literal(1686).default(1686) }).default({ left: 258, top: 1032, width: 1329, height: 1686 }),
  topBuffer: z.number().int().min(0).max(256).default(32), sideOverflow: z.number().int().min(0).max(258).default(66), bottomOverflow: z.number().int().min(0).max(562).default(84),
  backgroundTransitionPixels: z.number().int().min(0).max(256).default(192),
  backgroundContextPixels: z.number().int().min(0).max(512).default(128),
  backgroundAlignment: z.strictObject({ sampleWidth: z.number().int().min(16).max(256).default(56), sampleHeight: z.number().int().min(16).max(512).default(100), minimumCopyCorrelation: z.number().min(0).max(1).default(0.95), minimumPlacementGap: z.number().min(0).max(1).default(0.2), minimumProtectedCorrelation: z.number().min(0).max(1).default(0.8) }).optional(),
  sourceFrameRepair: z.strictObject({ enabled: z.boolean().default(true), marginPixels: z.number().int().min(0).max(512).default(128) }).optional(),
  concurrency: z.number().int().min(1).max(8).default(5), concurrencyVersion: z.literal('five-workers-v1').optional(), maxReworks: z.number().int().min(0).max(5).default(5), maxEditsPerImage: z.number().int().min(0).max(5).default(5),
  recoveryLimitVersion: z.literal('five-attempts-v1').optional(),
  imageProvider: z.string().min(1).default('autoflow-codex'), imageSourceId: z.string().default(''), imageModel: z.string().default(''), imageSize: z.string().min(1).default('1872x3328'), imageQuality: z.enum(['auto', 'low', 'medium', 'high']).default('high'),
  clarity: claritySettingsSchema.optional(),
  backgroundResolution: backgroundResolutionSettingsSchema.optional(),
  processing: wallpaperProcessingSchema.optional(),
  repairPolicy: wallpaperRepairPolicySchema.optional(),
  sourceIntentPolicy: sourceIntentPolicySchema.optional(),
  decision: wallpaperDecisionSettingsSchema.optional(),
  learningEnabled: z.boolean().default(true), autoPromote: z.boolean().default(true), learningInterval: z.number().int().positive().default(20), minBenchmarks: z.number().int().min(12).default(12), maxEvalVisionCalls: z.number().int().positive().max(48).default(48), maxSkillChars: z.number().int().min(1000).max(16000).default(4000),
})
/** Frozen wallpaper processing policy. */
export type WallpaperSettings = z.infer<typeof wallpaperSettingsSchema>
/** Resolve reconstruction and optional subject enhancement to the bundled ESPCN model.
 * @param settings Parsed settings owned by the next operation; saved predecessors remain readable.
 */
export function applyWallpaperEspcn(settings: WallpaperSettings): void {
  if (settings.clarity) settings.clarity = resolveEspcnClarity(settings.clarity)
  if (settings.backgroundResolution) settings.backgroundResolution = resolveEspcnBackground(settings.backgroundResolution)
}
/** Official native-size edits must pass review and dimensions without ESPCN fallback. */
export function applyOfficialImageResolution(settings: WallpaperSettings): void {
  if (settings.imageProvider !== 'visual-curator-openai') return
  settings.clarity = claritySettingsSchema.parse({ ...settings.clarity, enabled: false })
  settings.backgroundResolution = backgroundResolutionSettingsSchema.parse({ ...settings.backgroundResolution, enabled: false })
}
/** Apply the five-worker default when accepting new work or an explicit continuation.
 * @param settings Settings for the accepted operation; saved predecessors remain unchanged.
 */
export function applyWallpaperConcurrency(settings: WallpaperSettings): void {
  if (settings.concurrencyVersion) return
  if (settings.concurrency === 2) settings.concurrency = wallpaperSettingsSchema.shape.concurrency.parse(undefined)
  settings.concurrencyVersion = 'five-workers-v1'
}
/** Upgrade unversioned edit and rework defaults on a newly resolved configuration or a newly authorized continuation.
 * @param settings Parsed settings owned by the new operation; historical run settings stay frozen.
 */
export function applyWallpaperRecoveryLimits(settings: WallpaperSettings): void {
  if (wallpaperPracticalAcceptance(settings)) return
  if (settings.recoveryLimitVersion) return
  if (settings.maxReworks === 2) settings.maxReworks = 5
  if (settings.maxEditsPerImage === 2) settings.maxEditsPerImage = 5
  settings.recoveryLimitVersion = 'five-attempts-v1'
}
/** Modes describe visual organization rather than a closed list of object classes. */
export const wallpaperModeSchema = z.enum(['single', 'group', 'scene', 'abstract', 'uncertain'])
/** Source entities keep one identity and one task role across planning, editing and review. */
export const wallpaperObjectRoleSchema = z.strictObject({ entityId: id, name: text, role: z.enum(['primary', 'critical-part', 'supporting']).describe('Primary includes every visual co-lead that jointly forms the source theme, not only the largest, tallest or most central object. Give independent co-primary subjects their own identities. Critical-part is an indispensable part of a primary. Mere containment, support or contact does not promote a separate prop: an ordinary serving bowl remains supporting unless the vessel itself is a requested subject.'), evidence: text, rect, sourceEdges: z.array(z.enum(['left', 'top', 'right', 'bottom'])).max(4), safetyClass: wallpaperSafetyClassSchema.optional(), sourceIntent: wallpaperSourceIntentSchema.optional() })
export type WallpaperObjectRole = z.infer<typeof wallpaperObjectRoleSchema>
const actionPartIdsSchema = z.array(id).max(32).describe('Identify separately boxed objects whose complete visible shape is indispensable to a primary action or structure. Include held ribbons, connected leashes and tools in use through their remote visible ends. Ordinary containers, supports, shadows, reflections and unrelated decorations do not qualify. Use [] when no such part exists.')

/** @param object Frozen source entity. @returns Whether a confirmed partial primary needs a distinct layout focus before generation. */
export function wallpaperSourceFocusRequired(object: WallpaperObjectRole): boolean {
  return object.role === 'primary' && object.safetyClass !== 'automobile' && (object.sourceIntent?.framing === 'partial' || object.sourceIntent?.framing === 'close-up')
}
/** Background generation receives environment facts without foreground preservation or object recreation instructions. */
export const wallpaperBackgroundBriefSchema = z.strictObject({ version: z.literal('background-only-v1'), setting: text, light: text, palette: text, texture: text, perspective: text })
/** Explicit source-entity instances distinguish preserved content from extra copies elsewhere in the output. */
export const wallpaperObjectInventorySchema = z.array(z.strictObject({ entityId: id, status: z.enum(['retained', 'missing', 'changed', 'uncertain']), sourceInstances: z.array(rect).min(1).max(16).optional(), instances: z.array(rect).max(16), reason: text })).max(32)
/** Independent foreground additions never qualify merely because source objects still exist. */
export const wallpaperNewForegroundSchema = z.array(z.strictObject({ name: text, reason: text, rect })).max(16)
/** Inferred regions on the EXIF-oriented source; they are not measured segmentation masks. */
export const wallpaperPlanSchema = z.strictObject({
  version: z.literal(1), imageVersionId: id, mode: wallpaperModeSchema, subject: text, evidence: text,
  priorities: z.array(text).max(16), anchors: z.array(text).max(16), truncations: z.array(text).max(16), uncertainties: z.array(text).max(16),
  regions: z.array(z.strictObject({ name: text, entityId: id.optional(), role: z.enum(['subject', 'critical', 'anchor']), rect, safetyClass: wallpaperSafetyClassSchema.optional() })).max(32),
  objectRoles: z.array(wallpaperObjectRoleSchema).max(32).optional(),
  actionPartIds: actionPartIdsSchema.optional(),
  sourceAssessment: z.strictObject({ classification: z.enum(['ready', 'repair-required', 'uncertain']), reason: text }).optional(),
  backgroundBrief: wallpaperBackgroundBriefSchema.optional(),
  sourceMedium: wallpaperSourceMediumSchema.optional(),
  placement: z.strictObject({ scale: z.number().finite().positive(), left: z.number().int(), top: z.number().int() }),
  reason: text,
  editPrompt: text.describe('Scene-specific editing instructions grounded in source pixels and frozen task repairPolicy: preserve healthy content, identify concrete defects and authorized generated repairs, lighting, horizon, perspective and transitions. Never claim generated details are recovered facts.').optional(),
})
/** V4 delegates pixel placement to the Host while retaining every inferred protection region and uncertainty. */
export const wallpaperObservationPlanSchema = wallpaperPlanSchema.omit({ placement: true })
/** A source-intent framing hold always carries explicit entities and preservation facts. */
export const wallpaperFramingObservationSchema = wallpaperObservationPlanSchema.extend({ objectRoles: z.array(wallpaperObjectRoleSchema.extend({ sourceIntent: wallpaperSourceIntentSchema })).min(1).max(32), sourceMedium: wallpaperSourceMediumSchema })
/** Source geometry may be reread without losing the original preservation requirements. */
export type WallpaperFramingObservation = z.infer<typeof wallpaperFramingObservationSchema>
const framingBound = z.strictObject({ kind: z.enum(['canvas', 'safe', 'frame']), edge: z.enum(['left', 'top', 'right', 'bottom']), name: text.optional() })
/** Recomputable placement limits; unavailable upper limits remain absent rather than infinite. */
export const wallpaperFramingDiagnosticsSchema = z.strictObject({
  version: z.literal('source-framing-conflict-v1'), edges: z.array(z.enum(['left', 'top', 'right', 'bottom'])).max(4),
  minimumScale: z.number().finite().nonnegative(), maximumScale: z.number().finite().optional(),
  limits: z.array(z.strictObject({ axis: z.enum(['horizontal', 'vertical']), kind: z.enum(['minimum', 'maximum', 'offset', 'rounding']), scale: z.number().finite().optional(), lower: framingBound, upper: framingBound })).max(3),
})
/** Source observations and limiting constraints remain independent of an executable placement. */
export type WallpaperFramingDiagnostics = z.infer<typeof wallpaperFramingDiagnosticsSchema>
/** Authorized work records background continuity as text; hard rectangles contain only subjects and critical structures. */
export const wallpaperRepairObservationPlanSchema = wallpaperObservationPlanSchema.extend({
  anchors: wallpaperObservationPlanSchema.shape.anchors.describe('Background continuity facts only: lights, fences, walls, terrain, sky, horizon and perspective. These are not hard protected rectangles.'),
  truncations: wallpaperObservationPlanSchema.shape.truncations.describe('Only genuine truncation of a main subject or its critical structures. Ordinary background framing is not subject damage.'),
  regions: z.array(wallpaperPlanSchema.shape.regions.element.extend({ role: z.enum(['subject', 'critical']).describe('Only main/coequal subjects and their indispensable structures. Ordinary lights, fences, walls, roads, rocks and sky stay in anchors text unless explicitly required as a main subject.') })).max(32),
}).required({ editPrompt: true })
const wallpaperRoleObservationBaseSchema = wallpaperRepairObservationPlanSchema.extend({
  objectRoles: z.array(wallpaperObjectRoleSchema).max(32),
  regions: z.array(wallpaperRepairObservationPlanSchema.shape.regions.element.extend({ entityId: id })).max(32),
})
const sourceFrameEdges = ['left', 'top', 'right', 'bottom'] as const
function wallpaperObjectFrameEdges(rect: WallpaperObjectRole['rect']): WallpaperObjectRole['sourceEdges'] {
  return sourceFrameEdges.filter(edge => edge === 'left' ? rect.x === 0 : edge === 'top' ? rect.y === 0 : edge === 'right' ? rect.x + rect.width >= 0.999 : rect.y + rect.height >= 0.999)
}
function validateWallpaperRoleObservation(plan: z.infer<typeof wallpaperRoleObservationBaseSchema>, ctx: z.RefinementCtx, sourceIntent = false) {
  if ((plan.mode === 'single' || plan.mode === 'group') && !plan.objectRoles.some(object => object.role === 'primary')) ctx.addIssue({ code: 'custom', path: ['objectRoles'], message: 'A single-subject or group plan must identify its actual primary subject.' })
  const roles = new Map<string, WallpaperObjectRole>()
  for (const [index, object] of plan.objectRoles.entries()) {
    if (roles.has(object.entityId)) ctx.addIssue({ code: 'custom', path: ['objectRoles', index, 'entityId'], message: 'Source entity IDs must be unique.' })
    roles.set(object.entityId, object)
    const touches = wallpaperObjectFrameEdges(object.rect)
    for (const edge of sourceFrameEdges) if (touches.includes(edge) !== object.sourceEdges.includes(edge) && !(sourceIntent && object.sourceIntent?.visibility === 'frame-cropped' && object.sourceEdges.includes(edge))) ctx.addIssue({ code: 'custom', path: ['objectRoles', index, 'sourceEdges'], message: 'Source-frame edges must match the observed entity rectangle or independently observed frame cut.' })
  }
  const protectedIds = new Set<string>()
  for (const [index, region] of plan.regions.entries()) {
    const object = roles.get(region.entityId)
    if (!object || object.role === 'supporting' || region.role !== (object.role === 'critical-part' ? 'critical' : 'subject')) ctx.addIssue({ code: 'custom', path: ['regions', index, 'entityId'], message: 'Only matching primary subjects and indispensable parts may receive protected rectangles.' })
    if (protectedIds.has(region.entityId)) ctx.addIssue({ code: 'custom', path: ['regions', index, 'entityId'], message: 'Each source entity has one protected rectangle.' })
    protectedIds.add(region.entityId)
  }
  for (const [index, object] of plan.objectRoles.entries()) if (object.role !== 'supporting' && !protectedIds.has(object.entityId)) ctx.addIssue({ code: 'custom', path: ['objectRoles', index, 'entityId'], message: 'Every protected source entity needs its own rectangle.' })
}
/** V8 requires explicit foreground roles while old saved plans remain readable. */
export const wallpaperRoleObservationPlanSchema = wallpaperRoleObservationBaseSchema.superRefine(validateWallpaperRoleObservation)
/** @param prior Frozen identities from a previous V8 attempt. @param practical Whether Host-owned rectangles and frame edges are derived from source entities. @param requireSafetyClass Whether each primary needs its source visual classification. @param requireSourceIntent Require observed medium and per-entity framing, appearance and relationship facts. @param priorSourceMedium Frozen medium required on replanning when source intent is enabled. @param requireActionParts Identify action-defining parts independently of their provisional role. @returns A source observation retaining its identities, roles, visual categories and source medium. */
export function wallpaperRoleObservationOutputSchema(prior?: readonly WallpaperObjectRole[], practical = false, requireSafetyClass = false, requireSourceIntent = false, priorSourceMedium?: z.infer<typeof wallpaperSourceMediumSchema>, requireActionParts = false) {
  const sourceRole = requireSourceIntent ? wallpaperObjectRoleSchema.extend({ sourceIntent: wallpaperObservedSourceIntentSchema }) : wallpaperObjectRoleSchema
  const generalRole = sourceRole.extend({ role: z.literal('primary'), safetyClass: z.literal('general') })
  const objectRole: z.ZodType<WallpaperObjectRole, z.input<typeof wallpaperObjectRoleSchema>> = requireSafetyClass ? z.union([
    requireSourceIntent ? generalRole.extend({ sourceIntent: wallpaperPrimarySourceIntentSchema }) : generalRole,
    sourceRole.extend({ role: z.literal('primary'), safetyClass: z.literal('automobile') }),
    sourceRole.extend({ role: z.literal('critical-part') }),
    sourceRole.extend({ role: z.literal('supporting') }),
  ]) : sourceRole
  const base = wallpaperRoleObservationBaseSchema.safeExtend({ sourceMedium: requireSourceIntent ? priorSourceMedium === undefined ? wallpaperSourceMediumSchema : z.literal(priorSourceMedium) : wallpaperSourceMediumSchema.optional(), objectRoles: z.array(objectRole).max(32),
    actionPartIds: requireActionParts ? actionPartIdsSchema : actionPartIdsSchema.optional() })
  const schema = practical ? base.superRefine((plan, ctx) => {
    const roles = new Map(plan.objectRoles.map(object => [object.entityId, object.role]))
    if (requireActionParts && plan.actionPartIds) {
      const seenParts = new Set<string>()
      for (const [index, entityId] of plan.actionPartIds.entries()) {
        if (!roles.has(entityId) || roles.get(entityId) === 'primary' || seenParts.has(entityId)) ctx.addIssue({ code: 'custom', path: ['actionPartIds', index], message: 'An action part must identify one distinct non-primary source entity.' })
        seenParts.add(entityId)
      }
    }
    const seen = new Set<string>()
    for (const [index, region] of plan.regions.entries()) {
      const role = roles.get(region.entityId)
      if (!role || role === 'supporting' || region.role !== (role === 'critical-part' ? 'critical' : 'subject')) ctx.addIssue({ code: 'custom', path: ['regions', index, 'entityId'], message: 'Explicit source regions must use their matching non-supporting entity identity and role.' })
      if (seen.has(region.entityId)) ctx.addIssue({ code: 'custom', path: ['regions', index, 'entityId'], message: 'Explicit source regions must not duplicate an entity identity.' })
      seen.add(region.entityId)
    }
  }).overwrite(plan => {
    const attached = new Set(requireActionParts ? plan.actionPartIds : [])
    const objectRoles = plan.objectRoles.map(object => {
      const derived = wallpaperObjectFrameEdges(object.rect)
      const cropped = requireSourceIntent && object.sourceIntent?.visibility === 'frame-cropped'
      return { ...object, role: attached.has(object.entityId) ? 'critical-part' as const : object.role, sourceEdges: sourceFrameEdges.filter(edge => derived.includes(edge) || cropped && object.sourceEdges.includes(edge)) }
    })
    return { ...plan, objectRoles, regions: objectRoles.filter(object => object.role !== 'supporting').map(object => ({ name: object.name, entityId: object.entityId, role: object.role === 'primary' ? 'subject' : 'critical', rect: object.rect, ...(object.safetyClass ? { safetyClass: object.safetyClass } : {}) })) }
  }).superRefine((plan, ctx) => validateWallpaperRoleObservation(plan, ctx, requireSourceIntent)) : base.superRefine((plan, ctx) => validateWallpaperRoleObservation(plan, ctx, requireSourceIntent))
  return schema.superRefine((plan, ctx) => {
    for (const [index, object] of plan.objectRoles.entries()) {
      const focus = object.sourceIntent?.layoutFocus
      if (requireSourceIntent && wallpaperSourceFocusRequired(object) && !focus) ctx.addIssue({ code: 'custom', path: ['objectRoles', index, 'sourceIntent', 'layoutFocus'], message: 'A confirmed partial or close-up primary requires a meaningful source layout focus.' })
      if (focus && (focus.x < object.rect.x || focus.y < object.rect.y || focus.x + focus.width > object.rect.x + object.rect.width || focus.y + focus.height > object.rect.y + object.rect.height)) ctx.addIssue({ code: 'custom', path: ['objectRoles', index, 'sourceIntent', 'layoutFocus'], message: 'The layout focus must remain inside the full visible source entity.' })
      if (object.safetyClass === 'automobile' && focus) ctx.addIssue({ code: 'custom', path: ['objectRoles', index, 'sourceIntent', 'layoutFocus'], message: 'Automobile safety requires the complete visible vehicle, not a smaller focus.' })
    }
    if (plan.objectRoles.some(object => object.role === 'primary' && object.safetyClass === 'automobile') && (plan.mode === 'scene' || plan.mode === 'abstract')) ctx.addIssue({ code: 'custom', path: ['mode'], message: 'A primary automobile cannot use scene or abstract mode to evade complete vehicle safety bounds.' })
    if (!prior) return
    const roles = new Map(prior.map(object => [object.entityId, object]))
    if (plan.objectRoles.length !== roles.size) ctx.addIssue({ code: 'custom', path: ['objectRoles'], message: 'A retry must retain every frozen source entity.' })
    for (const [index, object] of plan.objectRoles.entries()) {
      const frozen = roles.get(object.entityId)
      if (frozen?.role !== object.role) ctx.addIssue({ code: 'custom', path: ['objectRoles', index], message: 'A retry cannot change a frozen source entity ID or role.' })
      if (frozen?.role === 'primary' && frozen.safetyClass && frozen.safetyClass !== object.safetyClass) ctx.addIssue({ code: 'custom', path: ['objectRoles', index, 'safetyClass'], message: 'A retry cannot change or omit a frozen primary visual classification.' })
      if (requireSourceIntent && frozen?.sourceIntent && JSON.stringify(frozen.sourceIntent) !== JSON.stringify(object.sourceIntent)) ctx.addIssue({ code: 'custom', path: ['objectRoles', index, 'sourceIntent'], message: 'A retry must retain the source framing, visibility, requirements and layout focus.' })
    }
  })
}
/** Source-grounded layout, including an isotropic transform that never enlarges the original. */
export type WallpaperPlan = z.infer<typeof wallpaperPlanSchema>
/** Every visual acceptance dimension must be reported independently. */
export const wallpaperReviewKeys = ['subject', 'protection', 'clock', 'readability', 'composition', 'background', 'style'] as const
const check = z.strictObject({ result: z.enum(['satisfied', 'violated', 'unknown']), reason: text })
/** An independent reviewer sees actual final pixels, not the planner's expected verdict. */
export const wallpaperReviewSchema = z.strictObject({
  subject: text, checks: z.record(z.enum(wallpaperReviewKeys), check),
  issues: z.array(z.strictObject({ kind: z.enum(['layout', 'preservation', 'background', 'readability', 'style', 'unknown']), reason: text })).max(32),
})
/** V2 requests report each fixed visual rule independently; the Host computes aggregate style coverage. */
export const wallpaperReviewV2Schema = wallpaperReviewSchema.extend({
  checks: z.strictObject({ subject: check, protection: check, clock: check, readability: check, composition: check, background: check, style: check }),
  styleResults: z.array(z.strictObject({ ruleId: text, result: z.enum(['satisfied', 'violated', 'unknown', 'not-applicable']), reason: text, evidenceImageVersionIds: z.array(id) })),
})
/** V2 stored reviews retain the original model style opinion and the Host-derived fixed-policy result. */
export const wallpaperStoredReviewV2Schema = wallpaperReviewV2Schema.extend({ styleMatch: styleMatchSchema, modelStyleCheck: check })
const subjectExtent = z.strictObject({ extent: z.enum(['complete', 'cut-off', 'occluded', 'not-applicable', 'unknown']), reason: text, imageVersionId: id })
/** Independent whole-subject observations cannot be replaced by protected-region geometry or a favorable style score. */
export const wallpaperSubjectIntegritySchema = z.strictObject({ mode: wallpaperModeSchema, source: subjectExtent, output: subjectExtent, task: check })
/** V3 identifies both pixel frames and requires explicit task compliance before subject acceptance. */
export const wallpaperReviewV3Schema = wallpaperReviewV2Schema.extend({ reviewVersion: z.literal('wallpaper-review-v3'), subjectIntegrity: wallpaperSubjectIntegritySchema })
/** V4 adds an independent clarity check without changing the original seven acceptance dimensions. */
export const wallpaperReviewV4Schema = wallpaperReviewV3Schema.extend({ reviewVersion: z.literal('wallpaper-review-v4'), checks: wallpaperReviewV2Schema.shape.checks.extend({ clarity: check }) })
/** Direct reviews compare original appearance without requesting dataset rule results. */
export const wallpaperSourceReviewSchema = wallpaperReviewV4Schema.extend({ reviewVersion: z.literal('wallpaper-review-source-v1'), styleResults: z.array(z.never()).max(0) })
/** Source damage stays recorded; independently reviewed edge completion requires an explicit task policy. */
export const wallpaperSourceReviewV2Schema = wallpaperSourceReviewSchema.extend({ reviewVersion: z.literal('wallpaper-review-source-v2'), sourceRepair: check })
/** Complete generated canvases identify their actual foreground coordinates and compare source structure after a whole-group transform. */
export const wallpaperSourceReviewV3Schema = wallpaperSourceReviewV2Schema.extend({ reviewVersion: z.literal('wallpaper-review-source-v3'), actualLayout: z.strictObject({ imageVersionId: id, regions: wallpaperPlanSchema.shape.regions }), sourceCorrespondence: check })
/** Host-measured failures retain model observations and never qualify outside protected bounds. */
export const wallpaperStoredSourceReviewV3Schema = wallpaperSourceReviewV3Schema.extend({ sourceRepairAuthorized: z.literal(true).optional(), layoutChecks: z.array(text) })
// Historical stored reviews may omit evidence; live role-bound failures must substantiate their cause.
const wallpaperIssueEvidence = z.strictObject({
  kind: z.enum(['safe-area-overflow', 'frame-truncation', 'missing-structure', 'distorted-structure', 'relative-layout', 'identity-change', 'detail-loss', 'style-change', 'background-artifact']),
  entityIds: z.array(id).max(32), imageVersionId: id, outputRect: rect, sourceRect: rect.optional(),
}).describe('Visible defect in the complete actual output. entityIds identifies frozen objects; an empty list is only for scene-wide background, style or clarity defects. sourceRect is required for sourceRepair/sourceCorrespondence. Safe-area overflow is layout only, never missing pixels, damage or fidelity loss.')
/** V4 distinguishes small peripheral detail from protected subject structure in actual output pixels. */
export const wallpaperSourceReviewV4Schema = wallpaperSourceReviewV3Schema.extend({
  reviewVersion: z.literal('wallpaper-review-source-v4'),
  inventory: wallpaperObjectInventorySchema.optional(), newForeground: wallpaperNewForegroundSchema.optional(),
  actualLayout: wallpaperSourceReviewV3Schema.shape.actualLayout.extend({ regions: z.array(wallpaperPlanSchema.shape.regions.element.extend({ scope: z.enum(['core', 'peripheral']), layoutFocus: rect.optional() })).max(32) }),
  issues: z.array(wallpaperReviewSchema.shape.issues.element.extend({ check: z.enum([...wallpaperReviewKeys, 'clarity', 'sourceRepair', 'sourceCorrespondence']), code: z.enum(['minor-peripheral-overflow', 'other']), evidence: wallpaperIssueEvidence.optional(), detail: z.strictObject({ sourceRect: rect, outputRect: rect, question: text }).optional().describe('Only for an unresolved acceptance-critical pixel question that a genuinely local source/output crop can answer. Omit for known defects, background, normal occlusion and unrelated unreadable text.') })).max(32),
})
/** Host findings and the model's original protection opinion remain visible after bounded warnings. */
export const wallpaperStoredSourceReviewV4Schema = wallpaperSourceReviewV4Schema.extend({ practicalReview: z.strictObject({ version: z.enum(['practical-v1', 'practical-v2']), warnings: z.array(text).max(32), uncertainties: z.array(text).max(4), sourcePreservation: wallpaperSourcePreservationSchema.optional(), sourceStyle: wallpaperSourcePreservationCheckSchema.optional() }).optional(), preservationRepairTarget: z.enum(['background', 'source', 'evidence']).optional(), backgroundBrief: wallpaperBackgroundBriefSchema.optional(), preservationProof: z.strictObject({ version: z.enum(['source-pixels-v1', 'source-pixels-v2']), sourceImageVersionId: id, sourceDigest: text, outputImageVersionId: id, outputDigest: text, comparedPixels: z.number().int().positive(), changedPixels: z.literal(0), sourceRect: z.strictObject({ left: z.number().int(), top: z.number().int(), width: z.number().int().positive(), height: z.number().int().positive() }).optional() }).refine(proof => proof.version !== 'source-pixels-v2' || !!proof.sourceRect).optional(), sourceRepairAuthorized: z.literal(true).optional(), clockContrast: wallpaperClockContrastSchema.optional(), modelChecks: wallpaperSourceReviewV4Schema.shape.checks.optional(), modelReadabilityCheck: check.optional(), layoutChecks: z.array(text), layoutWarnings: z.array(text), modelProtectionCheck: check, modelIssues: wallpaperSourceReviewV4Schema.shape.issues,
  criticalDetail: z.strictObject({ requestId: id, evidenceDigest: z.string().optional(), examinedChecks: z.array(z.enum([...wallpaperReviewKeys, 'clarity', 'sourceRepair', 'sourceCorrespondence'])), resolvedChecks: z.array(z.enum([...wallpaperReviewKeys, 'clarity', 'sourceRepair', 'sourceCorrespondence'])) }).optional() })
/** Only the Host attaches repair authorization after checking this attempt's saved source evidence. */
export const wallpaperStoredSourceReviewV2Schema = wallpaperSourceReviewV2Schema.extend({ sourceRepairAuthorized: z.literal(true).optional() })
/** Stored V4 reviews retain both the independent detail judgment and fixed style policy. */
export const wallpaperStoredReviewV4Schema = z.union([wallpaperReviewV4Schema.extend({ styleMatch: styleMatchSchema, modelStyleCheck: check }), wallpaperReviewV4Schema, wallpaperReviewV4Schema.extend({ subjectRejectionOnly: z.literal(true) }).refine(review =>
  [review.subjectIntegrity.source, review.subjectIntegrity.output].some(frame => frame.extent === 'cut-off') && review.checks.subject.result === 'violated'
  && Object.entries(review.checks).every(([key, row]) => key === 'subject' || row.result === 'unknown') && review.styleResults.length === 0)])
const subjectRejectionReviewSchema = wallpaperReviewV3Schema.extend({ subjectRejectionOnly: z.literal(true) }).refine(review =>
  [review.subjectIntegrity.source, review.subjectIntegrity.output].some(frame => frame.extent === 'cut-off') && review.checks.subject.result === 'violated'
  && wallpaperReviewKeys.every(key => key === 'subject' || review.checks[key].result === 'unknown') && review.styleResults.length === 0)
/** Weighted policies retain their deterministic style result; incomplete responses can establish rejection only. */
export const wallpaperStoredReviewV3Schema = z.union([wallpaperReviewV3Schema.extend({ styleMatch: styleMatchSchema, modelStyleCheck: check }), wallpaperReviewV3Schema, subjectRejectionReviewSchema])
/** Evaluate reconstructed background quality independently of unrelated subject or layout failures.
 * @param review Saved independent quality checks.
 * @returns Background/clarity status and its own reasons; no whole-image acceptance is implied.
 */
export function wallpaperBackgroundReview(review: WallpaperReview) {
  const checks = [review.checks.background, ...('clarity' in review.checks ? [review.checks.clarity] : [])]
  return { status: checks.every(check => check.result === 'satisfied') ? 'passed' as const : 'needs-review' as const, reason: checks.filter(check => check.result !== 'satisfied').map(check => check.reason).join('；') }
}

/** Frozen V1/V2 reviews remain readable without inserting new judgments into history. */
export const wallpaperStoredReviewSchema = z.union([wallpaperStoredSourceReviewV4Schema, wallpaperStoredSourceReviewV3Schema, wallpaperStoredSourceReviewV2Schema, wallpaperSourceReviewSchema, wallpaperStoredReviewV4Schema, wallpaperStoredReviewV3Schema, wallpaperStoredReviewV2Schema, wallpaperReviewSchema])
/** @param integrity Independent original/output pixel observations. @param sourceRepairAuthorized Explicit task or edge-repair authorization keeps source damage recorded; omission requires both frames to be complete. @returns Required subject result; partial outputs and uncertain final evidence cannot automatically pass. */
export function wallpaperSubjectCheck(integrity: z.infer<typeof wallpaperSubjectIntegritySchema>, sourceRepairAuthorized = false): z.infer<typeof check> {
  if (integrity.task.result === 'violated') return integrity.task
  const frames = sourceRepairAuthorized ? [integrity.output] : [integrity.source, integrity.output]
  const cut = frames.find(frame => frame.extent === 'cut-off')
  if (cut) return { result: 'violated', reason: `主体完整性不通过：${cut.reason}` }
  if (integrity.task.result === 'unknown') return integrity.task
  if (integrity.mode === 'uncertain' || frames.some(frame => frame.extent === 'unknown' || frame.extent === 'occluded')) return { result: 'unknown', reason: '原图或成品的完整主体范围尚无法确认，需要人工复核' }
  const object = integrity.mode === 'single' || integrity.mode === 'group'
  if (object && frames.some(frame => frame.extent !== 'complete') || (integrity.mode === 'scene' || integrity.mode === 'abstract') && frames.some(frame => frame.extent !== 'complete' && frame.extent !== 'not-applicable')) return { result: 'unknown', reason: '主体模式与完整性证据不一致，需要人工复核' }
  return { result: 'satisfied', reason: object ? sourceRepairAuthorized && integrity.source.extent === 'cut-off' ? '原图截断事实已保留；授权的边缘扩图及实际成品完整主体已独立复核，且符合任务要求' : '原图与实际成品的完整主体范围均有独立像素证据，且符合任务要求' : '场景或抽象构图的完整性及任务要求均已独立复核' }
}
/** Select the versioned wire output and validate requested rules and actual final-pixel evidence.
 * @param version Frozen review prompt version. @param ruleIds Requested visual rules. @param imageIds Authorized request images. @param finalImageId Actual final wallpaper image. @param sourceImageId Original pixels; required by V3 and unused by older protocols.
 * @param protectedObjectsOnly Authorized tasks exclude ordinary background anchors from hard protection rectangles; omission retains historical schemas.
 * @param objectRoles Frozen source identities for V8 tasks; omission retains historical review responses.
 * @param inventoryRequired Whether this new task requires an explicit complete-output object inventory.
 * @param practical Whether the task uses compact practical acceptance.
 * @param sourceMode Original composition retained by practical reviews; omission preserves historical unbound responses.
 * @param sourceIntentPolicy Require explicit original-to-output preservation in the practical protocol.
 * @param projectFrozenFocus Measure only the original's authorized focus rectangles in practical review.
 * @returns The frozen protocol with task-specific evidence and protection validation.
 */
export function wallpaperReviewOutputSchema(version: string, ruleIds: readonly string[], imageIds: readonly string[], finalImageId?: string, sourceImageId?: string, protectedObjectsOnly = false, objectRoles?: readonly WallpaperObjectRole[], inventoryRequired = false, practical = false, sourceMode?: WallpaperPlan['mode'], sourceIntentPolicy = false, projectFrozenFocus = false): z.ZodType<WallpaperPracticalReview | z.infer<typeof wallpaperReviewSchema> | z.infer<typeof wallpaperReviewV2Schema> | z.infer<typeof wallpaperReviewV3Schema> | z.infer<typeof wallpaperReviewV4Schema> | z.infer<typeof wallpaperSourceReviewSchema> | z.infer<typeof wallpaperSourceReviewV2Schema> | z.infer<typeof wallpaperSourceReviewV3Schema> | z.infer<typeof wallpaperSourceReviewV4Schema>> {
  if (practical && sourceImageId && finalImageId) return wallpaperPracticalReviewOutputSchema(sourceImageId, finalImageId, objectRoles?.filter(object => sourceIntentPolicy ? object.role !== 'supporting' : object.role === 'primary'), sourceMode, sourceIntentPolicy, projectFrozenFocus)
  if (version === 'wallpaper-review-v1') return wallpaperReviewSchema
  if (version === 'wallpaper-review-source-v1' || version === 'wallpaper-review-source-v2' || version === 'wallpaper-review-source-v3' || version === 'wallpaper-review-source-v4') {
    if (ruleIds.length || !sourceImageId || !finalImageId || sourceImageId === finalImageId || !imageIds.includes(sourceImageId) || !imageIds.includes(finalImageId)) throw new TypeError('Source-fidelity review requires distinct authorized original/output pixels and no dataset rules.')
    const region = wallpaperSourceReviewV4Schema.shape.actualLayout.shape.regions.element
    const protectedRegion = z.discriminatedUnion('role', [region.extend({ role: z.literal('subject') }), region.extend({ role: z.literal('critical'), scope: z.literal('core').describe('Indispensable structure always uses core safety bounds. Ordinary leaf tips use role subject and scope peripheral.') })])
    const layout = wallpaperSourceReviewV4Schema.shape.actualLayout.extend({ imageVersionId: z.literal(finalImageId), ...(protectedObjectsOnly ? { regions: z.array(protectedRegion).max(32).describe('Actual subjects and indispensable structures only; ordinary background continuity belongs to background, composition and readability checks.') } : {}) })
    const schema = version === 'wallpaper-review-source-v4' ? wallpaperSourceReviewV4Schema.extend({ actualLayout: layout }) : version === 'wallpaper-review-source-v3' ? wallpaperSourceReviewV3Schema.extend({ actualLayout: wallpaperSourceReviewV3Schema.shape.actualLayout.extend({ imageVersionId: z.literal(finalImageId) }) }) : version === 'wallpaper-review-source-v2' ? wallpaperSourceReviewV2Schema : wallpaperSourceReviewSchema
     const evidence = schema.extend({ subjectIntegrity: wallpaperSubjectIntegritySchema.extend({ source: subjectExtent.extend({ imageVersionId: z.literal(sourceImageId).describe('Required source evidence identity: copy this exact const from wallpaper-original. Extent and reason do not replace this field; detail crops and simulations are not the original frame.') }), output: subjectExtent.extend({ imageVersionId: z.literal(finalImageId).describe('Required output evidence identity: copy this exact const from actual-wallpaper. Extent and reason do not replace this field; detail crops and simulations are not the final frame.') }) }) })
     if (version !== 'wallpaper-review-source-v4' || !objectRoles) return evidence
     const protectedIds = objectRoles.filter(object => object.role !== 'supporting').map(object => object.entityId)
     const subjectRegion = protectedRegion.options[0].extend({ entityId: protectedIds.length ? z.enum(protectedIds) : id })
     const criticalRegion = protectedRegion.options[1].extend({ entityId: protectedIds.length ? z.enum(protectedIds) : id })
     const inventoryIds = objectRoles.filter(object => object.role !== 'critical-part').map(object => object.entityId)
     const identified = wallpaperSourceReviewV4Schema.extend({ subjectIntegrity: evidence.shape.subjectIntegrity, actualLayout: layout.extend({ regions: z.array(z.discriminatedUnion('role', [subjectRegion, criticalRegion])).max(protectedIds.length) }), inventory: inventoryRequired ? z.array(wallpaperObjectInventorySchema.element.required({ sourceInstances: true }).extend({ entityId: inventoryIds.length ? z.enum(inventoryIds) : id })).length(inventoryIds.length) : wallpaperObjectInventorySchema.optional(), newForeground: inventoryRequired ? wallpaperNewForegroundSchema : wallpaperNewForegroundSchema.optional() })
     return identified.superRefine((review, ctx) => {
       if (inventoryRequired && new Set(review.inventory?.map(row => row.entityId)).size !== inventoryIds.length) ctx.addIssue({ code: 'custom', path: ['inventory'], message: 'Observe every independent source entity exactly once, including supporting objects.' })
       const actualLayout = review.actualLayout
       const expected = new Map(objectRoles.map(object => [object.entityId, object]))
       const seen = new Set<string>()
       for (const [index, region] of actualLayout.regions.entries()) {
         const object = region.entityId ? expected.get(region.entityId) : undefined
         if (!object || object.role === 'supporting' || region.role !== (object.role === 'critical-part' ? 'critical' : 'subject')) ctx.addIssue({ code: 'custom', path: ['actualLayout', 'regions', index, 'entityId'], message: 'Actual protected regions must use the frozen primary or critical source identity.' })
         if (region.entityId && seen.has(region.entityId)) ctx.addIssue({ code: 'custom', path: ['actualLayout', 'regions', index, 'entityId'], message: 'Each frozen source entity has one actual protected rectangle.' })
         if (region.entityId) seen.add(region.entityId)
       }
       for (const object of objectRoles) if (object.role !== 'supporting' && !seen.has(object.entityId)) ctx.addIssue({ code: 'custom', path: ['actualLayout', 'regions'], message: `Missing actual protected region for ${object.entityId}.` })
       for (const issue of wallpaperReviewEvidenceIssues(review, objectRoles, finalImageId)) ctx.addIssue({ code: 'custom', ...issue })
     })
  }
  if (version !== 'wallpaper-review-v2' && version !== 'wallpaper-review-v3' && version !== 'wallpaper-review-v4') throw new TypeError('Unknown wallpaper review protocol.')
  if ((version === 'wallpaper-review-v3' || version === 'wallpaper-review-v4') && (!sourceImageId || !finalImageId || sourceImageId === finalImageId || !imageIds.includes(sourceImageId) || !imageIds.includes(finalImageId))) throw new TypeError('Whole-subject review requires distinct authorized original and output images.')
  const schema = version === 'wallpaper-review-v3' || version === 'wallpaper-review-v4' ? (version === 'wallpaper-review-v4' ? wallpaperReviewV4Schema : wallpaperReviewV3Schema).extend({ subjectIntegrity: wallpaperSubjectIntegritySchema.extend({ source: subjectExtent.extend({ imageVersionId: z.literal(sourceImageId!).describe('Required source evidence identity: copy this exact const from wallpaper-original. Extent and reason do not replace this field; detail crops and simulations are not the original frame.') }), output: subjectExtent.extend({ imageVersionId: z.literal(finalImageId!).describe('Required output evidence identity: copy this exact const from actual-wallpaper. Extent and reason do not replace this field; detail crops and simulations are not the final frame.') }) }) }) : wallpaperReviewV2Schema
  return schema.extend({ styleResults: wallpaperReviewV2Schema.shape.styleResults.length(ruleIds.length) }).superRefine((review, ctx) => {
    const seen = new Set<string>()
    for (const [index, row] of review.styleResults.entries()) {
      if (!ruleIds.includes(row.ruleId) || seen.has(row.ruleId)) ctx.addIssue({ code: 'custom', path: ['styleResults', index, 'ruleId'], message: 'Unknown or duplicate requested visual rule.' })
      seen.add(row.ruleId)
      if (row.evidenceImageVersionIds.some(id => !imageIds.includes(id)) || (row.result === 'satisfied' || row.result === 'violated') && (!finalImageId || !row.evidenceImageVersionIds.includes(finalImageId))) ctx.addIssue({ code: 'custom', path: ['styleResults', index, 'evidenceImageVersionIds'], message: 'Applicable style results require the authorized final wallpaper pixels.' })
    }
    if (ruleIds.some(id => !seen.has(id))) ctx.addIssue({ code: 'custom', path: ['styleResults'], message: 'A requested visual rule is missing.' })
  })
}
/** Structured visual review; the Host computes the final verdict. */
export type WallpaperReview = z.infer<typeof wallpaperStoredReviewSchema>
/** Composition changes are explicit; absent saved values retain the original source-edge behavior. */
export const wallpaperCompositionModeSchema = z.enum(['source-edge-v1', 'protected-context-v1', 'protected-context-v2', 'generated-canvas-v1', 'generated-canvas-protected-v2', 'background-plate-v1', 'background-plate-v2', 'source-intent-background-v1'])
/** Deterministic source-preserving blend selected for one saved attempt. */
export type WallpaperCompositionMode = z.infer<typeof wallpaperCompositionModeSchema>
const generation = z.strictObject({ id, provider: id, model: id, taskId: id })
const generationReference = z.strictObject({ role: z.enum(['canvas', 'original', 'subject-detail', 'critical-detail', 'layout-only']), attachmentId: id, width: z.number().int().positive(), height: z.number().int().positive(), sourceRect: rect.optional() })
const generationInput = z.strictObject({ prompt: z.string().min(1).max(32768) })
const positionedReferences = z.tuple([generationReference.extend({ role: z.literal('canvas') }), generationReference.extend({ role: z.literal('original') }), generationReference.extend({ role: z.literal('layout-only') })]).refine(([canvas, , guide]) => canvas.width === guide.width && canvas.height === guide.height, 'The positioned master and safety guide must use the same canvas dimensions.')
/** Exact edit request; V5 binds three references and V6 additionally binds the master-sized background edit mask. */
export const wallpaperGenerationInputSchema = z.discriminatedUnion('version', [
  generationInput.extend({ version: z.enum(['wallpaper-edit-input-v1', 'wallpaper-edit-input-v2', 'wallpaper-edit-input-v3', 'wallpaper-edit-input-v4']), references: z.array(generationReference).min(1).max(5) }),
  generationInput.extend({ version: z.literal('wallpaper-edit-input-v5'), references: positionedReferences }),
  generationInput.extend({ version: z.literal('wallpaper-edit-input-v6'), references: positionedReferences, mask: z.strictObject({ attachmentId: id, width: z.number().int().positive(), height: z.number().int().positive() }) }).refine(input => input.mask.width === input.references[0].width && input.mask.height === input.references[0].height, 'The edit mask must match the positioned master dimensions.'),
])
export { wallpaperEdgeRepairSchema } from './wallpaper-evidence.ts'
/** Each round preserves its plan, artifacts and actual review; revising a plan does not erase history. */
export const wallpaperAttemptSchema = z.strictObject({
  revision: z.number().int().positive(), createdAt: z.iso.datetime().optional(), reviewedAt: z.iso.datetime().optional(), plan: wallpaperPlanSchema,
  layoutCorrection: z.strictObject({ version: z.enum(['candidate-placement-v1', 'candidate-placement-locked-v2', 'candidate-subject-locked-v3']), plan: wallpaperPlanSchema }).optional(),
  checks: z.array(z.string()), needsOutpaint: z.boolean(),
  generationFramingFailure: z.strictObject({ code: z.literal('canvas-aspect-mismatch'), width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  sourceIntentProof: z.strictObject({ version: z.literal('source-intent-pixels-v1'), sourceDigest: text, outputDigest: text, comparedPixels: z.number().int().positive(), changedPixels: z.literal(0), sourceRect: z.strictObject({ left: z.number().int(), top: z.number().int(), width: z.number().int().positive(), height: z.number().int().positive() }) }).optional(),
  generationCanvasCrop: z.strictObject({ originalId: id, croppedId: id, sourceDigest: z.string(), sourceWidth: z.number().int().positive(), sourceHeight: z.number().int().positive(), left: z.number().int().nonnegative(), top: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  detailAnalysis: z.strictObject({ version: z.enum(['wallpaper-plan-detail-v1', 'wallpaper-plan-detail-v2', 'wallpaper-plan-detail-v3', 'wallpaper-plan-detail-v4', 'wallpaper-plan-detail-v5']), requestId: id, outcome: z.enum(['resolved', 'ready-for-edit', 'unresolved', 'violated', 'unavailable']), protectedSubjectExtent: subjectExtent.shape.extent.optional(), edgeRepair: wallpaperEdgeRepairEvidenceSchema.optional(),
    concerns: z.array(z.strictObject({ id, text })).max(35).optional(), findings: z.array(wallpaperFindingSchema.extend({ result: z.enum(['resolved', 'unresolved', 'violated']) })).max(35).optional(), retainedUncertainties: z.array(wallpaperRetainedUncertaintySchema).max(16).optional(),
  }).optional(),
  canvasId: id.optional(), opaqueCanvasId: id.optional(), maskId: id.optional(), layoutAnalysisId: id.optional(), analysisId: id.optional(), simulationId: id.optional(), outputId: id.optional(),
  nativeReviewCandidate: z.strictObject({ nativeId: id, nativeDigest: z.string(), previewId: id, simulationId: id }).optional(),
  boundaryReview: z.strictObject({ requestId: id, status: z.enum(['pending', 'completed', 'failed']), errorCode: z.string().optional() }).optional(),
  preResolutionReview: z.strictObject({ nativeId: id, nativeDigest: z.string(), previewId: id, simulationId: id, finalId: id.optional() }).optional(),
  finalReviewRequired: z.literal(true).optional(),
  postResolutionReview: z.strictObject({ requestId: id, imageVersionId: id, digest: z.string(), nativeId: id, nativeDigest: z.string(), analysisId: id, simulationId: id, review: wallpaperStoredReviewSchema.optional(), reviewedAt: z.iso.datetime().optional() }).optional(),
  clarity: clarityStateSchema.optional(), clarityBaseReview: wallpaperStoredReviewSchema.optional(),
  generation: generation.optional(), generationOperation: id.optional(), editReserved: z.boolean().optional(), reviewReserved: z.boolean().optional(), review: wallpaperStoredReviewSchema.optional(), compositionMode: wallpaperCompositionModeSchema.optional(),
  generationFailure: z.strictObject({ outcome: z.enum(['failed', 'cancelled', 'unknown']), code: text, transientRejection: z.boolean() }).optional(),
  generationInput: wallpaperGenerationInputSchema.optional(), generationBrief: wallpaperGenerationBriefSchema.optional(),
  generatedImageId: id.optional(),
  generationAlignment: z.strictObject({ result: z.enum(['reframed-source', 'misaligned-source', 'not-detected']), wholeSourceCorrelation: z.number().finite(), placedSourceCorrelation: z.number().finite(), protectedSourceCorrelation: z.number().finite().optional() }).optional(),
  backgroundResolution: backgroundResolutionStateSchema.optional(),
  retryFrom: z.enum(['planning', 'rendering', 'reviewing']).optional(), retryTarget: z.enum(['planning', 'rendering', 'reviewing']).optional(),
})
/** Saved progress for one qualified source. */
export const wallpaperItemSchema = z.strictObject({
  imageVersionId: id, originalId: id.optional(), familyId: id, status: z.enum(['queued', 'downloading', 'planning', 'rendering', 'reviewing', 'passed', 'rejected', 'needs-review', 'technical-failed', 'cancelled']),
  download: z.strictObject({ attempts: z.number().int().nonnegative(), retrying: z.boolean(), originalBlob: blobRefSchema.optional(), byteLength: z.number().int().nonnegative().optional(), savedAt: z.iso.datetime().optional(), reused: z.boolean().optional(), lastErrorCode: z.string().optional() }).optional(),
  edits: z.number().int().nonnegative().default(0), attempts: z.array(wallpaperAttemptSchema).default([]),
  decisions: z.array(wallpaperDecisionRecordSchema).optional(),
  framingConflict: z.strictObject({
    version: z.literal('source-framing-review-v1'), observation: wallpaperFramingObservationSchema, diagnostics: wallpaperFramingDiagnosticsSchema,
    analysisId: id.optional(),
    inspection: z.strictObject({ requestId: id, status: z.enum(['queued', 'running', 'resolved', 'uncertain', 'failed']), detailIds: z.array(id).max(wallpaperSourceFramingMaxDetails), analysisId: id.optional(), reason: text.optional(), observation: wallpaperFramingObservationSchema.optional(), findings: z.array(z.strictObject({ entityId: id, reason: text, evidenceImageVersionIds: z.array(id).min(1).max(wallpaperSourceFramingMaxDetails) })).max(32).optional(), errorCode: id.optional() }).optional(),
    resolution: z.enum(['blocked', 'cleared', 'uncertain']),
  }).optional(),
  detailInspection: z.strictObject({
    origin: z.enum(['planning', 'decision', 'manual']), status: z.enum(['queued', 'running', 'resolved', 'ready-for-edit', 'unresolved', 'violated', 'unavailable', 'failed']),
    planRevision: z.number().int().positive(), requestId: id, decisionRoundAtStart: z.number().int().nonnegative().optional(), decisionId: id.optional(), rect: rect.optional(), reason: z.string().optional(), errorCode: id.optional(),
  }).optional(),
  reason: z.string().optional(), errorCode: z.string().optional(),
  replacementOf: z.strictObject({ imageVersionId: id, errorCode: z.string(), reason: z.string() }).optional(),
  failedStep: z.enum(['downloading', 'planning', 'rendering', 'reviewing']).optional(),
})
/** Recoverable per-source state. */
export type WallpaperItem = z.infer<typeof wallpaperItemSchema>
/** @param attempt Saved processing revision. @returns Whether actual produced pixels exist before final qualification. */
export function wallpaperHasRendered(attempt: WallpaperItem['attempts'][number] | undefined): boolean {
  return !!(attempt?.nativeReviewCandidate || attempt?.preResolutionReview || attempt?.outputId)
}
/** @param attempt Saved native and final checks. @returns The latest quality result without replacing native evidence. */
export function wallpaperAttemptReview(attempt: WallpaperItem['attempts'][number] | undefined): WallpaperReview | undefined {
  return attempt?.postResolutionReview ? attempt.postResolutionReview.review : attempt?.review
}
/** @param plan Prior source observations. @returns Whether an ambiguous historical anchor extends outside all protected objects and needs a current object-only plan. */
export function wallpaperHasBackgroundAnchors(plan: WallpaperPlan): boolean {
  return plan.regions.some(region => region.role === 'anchor' && !plan.regions.some(object => object.role !== 'anchor' && region.rect.x >= object.rect.x && region.rect.y >= object.rect.y && region.rect.x + region.rect.width <= object.rect.x + object.rect.width && region.rect.y + region.rect.height <= object.rect.y + object.rect.height))
}
/** @param attempt Saved source evidence for this edit. @param settings Frozen repair policy. @returns Whether native inspection authorizes a bounded repair; legacy or unresolved evidence cannot grant new permission. */
export function wallpaperEdgeRepairAuthorized(attempt: WallpaperItem['attempts'][number], settings: WallpaperSettings): boolean {
  const detail = attempt.detailAnalysis, repair = detail?.edgeRepair
  if (!settings.sourceFrameRepair?.enabled || repair?.classification !== 'edge-continuation' || detail?.protectedSubjectExtent !== 'cut-off' || !['resolved', 'ready-for-edit'].includes(detail.outcome)) return false
  if (detail.version === 'wallpaper-plan-detail-v4') return detail.outcome === 'resolved'
  return detail.version === 'wallpaper-plan-detail-v5' && !!repair.sourceRegion && !!repair.edges.length && !!repair.evidenceImageVersionIds?.length && !!repair.concernIds?.length && !!detail.findings?.length && detail.findings.every(finding => finding.result !== 'violated' && !wallpaperFindingBlocksEditing(finding))
}
/** @param attempt Saved source evidence. @param settings Frozen task authorization. @returns Permission to produce generated completion; final pixel checks remain independent. */
export function wallpaperSubjectRepairAuthorized(attempt: WallpaperItem['attempts'][number], settings: WallpaperSettings): boolean {
  return wallpaperGenerativeRepair(settings) || wallpaperEdgeRepairAuthorized(attempt, settings)
}
/** Count corrective attempts. Local inspection, authorization to proceed, and rereading identical output do not remake pixels.
 * @param item Image with its retained revision history. @returns Reworks already reserved.
 */
export function wallpaperReworkCount(item: WallpaperItem): number {
  return item.attempts.filter((attempt, index) => {
    const prior = item.attempts[index - 1]
    if (!prior) return false
    if (attempt.retryTarget === 'reviewing' && (attempt.outputId && attempt.outputId === prior.outputId || attempt.nativeReviewCandidate && attempt.nativeReviewCandidate.nativeDigest === prior.nativeReviewCandidate?.nativeDigest)) return false
    if (attempt.retryFrom === 'planning' && attempt.retryTarget === 'planning' && (attempt.detailAnalysis?.outcome === 'resolved' || attempt.detailAnalysis?.outcome === 'ready-for-edit') && attempt.detailAnalysis.requestId === prior.detailAnalysis?.requestId) return false
    if (attempt.retryFrom === 'planning' && attempt.retryTarget === 'rendering' && item.decisions?.some(d => d.status === 'applied' && d.targetRevision === attempt.revision && d.response?.action.kind === 'continue_current_plan')) return false
    return true
  }).length
}
/** Hold legacy role-bound findings that cannot substantiate another image edit.
 * @param attempt Saved plan and effective review; current receiver validation does not retroactively validate old responses.
 * @returns Whether the same pixels need an evidence-complete review before automatic rework.
 */
export function wallpaperReviewNeedsEvidence(attempt: WallpaperItem['attempts'][number]): boolean {
  const review = wallpaperAttemptReview(attempt)
  if (!attempt.plan.objectRoles || !review || !('modelIssues' in review)) return false
  if (review.preservationProof || review.practicalReview) return false
  const model = { ...review, issues: review.modelIssues, checks: review.modelChecks ?? { ...review.checks, protection: review.layoutChecks.length ? { result: 'satisfied' as const, reason: 'Host protected geometry supplies the layout evidence.' } : review.modelProtectionCheck } }
  return wallpaperReviewEvidenceIssues(model, attempt.plan.objectRoles, review.actualLayout.imageVersionId).length > 0
}
/** @param item Image checkpoint. @param settings Frozen task limits. @returns Whether a rejected output can enter corrective editing with its saved evidence. */
export function wallpaperReviewReworkAvailable(item: WallpaperItem, settings: WallpaperSettings): boolean {
  const attempt = item.attempts.at(-1), review = wallpaperAttemptReview(attempt)
  const repair = wallpaperGenerativeRepair(settings)
  const practical = wallpaperPracticalAcceptance(settings)
  if (attempt && wallpaperReviewNeedsEvidence(attempt)) return false
  if (review && 'practicalReview' in review && review.practicalReview?.uncertainties.length) return false
  if (practical) {
    const reviewedGenerations = new Set(item.attempts.filter(attempt => attempt.review && 'practicalReview' in attempt.review && attempt.review.practicalReview).map(attempt => attempt.generation?.id ?? attempt.outputId))
    if (reviewedGenerations.size > practical.maximumAutomaticCorrections) return false
  }
  if (!item.originalId || item.status === 'passed' || !attempt?.outputId || attempt.checks.length || !review || wallpaperVerdict(review) !== 'reject' || !('subjectIntegrity' in review)) return false
  if (attempt.postResolutionReview && (!('reviewVersion' in review) || review.reviewVersion !== 'wallpaper-review-source-v4')) return false
  if (attempt.boundaryReview && attempt.boundaryReview.status !== 'completed' || attempt.postResolutionReview && wallpaperBoundaryReviewNeeded(review)) return false
  if (!repair && !attempt.needsOutpaint && !review.issues.some(issue => issue.kind === 'layout' || issue.kind === 'readability')) return false
  const { source, output, mode } = review.subjectIntegrity
  if (source.imageVersionId !== item.originalId || output.imageVersionId !== (attempt.postResolutionReview?.imageVersionId ?? attempt.preResolutionReview?.nativeId ?? attempt.outputId) || attempt.plan.imageVersionId !== item.originalId) return false
  const edgeRepair = wallpaperEdgeRepairAuthorized(attempt, settings) && 'sourceRepair' in review
  if (!repair && source.extent !== 'complete' && !(edgeRepair && source.extent === 'cut-off') && !(source.extent === 'not-applicable' && (mode === 'abstract' || mode === 'scene') && !attempt.plan.regions.some(region => region.role === 'subject'))) return false
  if (attempt.generationOperation && !attempt.generation || !repair && (attempt.detailAnalysis?.outcome === 'violated' || !edgeRepair && attempt.detailAnalysis?.protectedSubjectExtent === 'cut-off')) return false
  if ('styleMatch' in review && review.checks.style.result !== 'satisfied' && Object.entries(review.checks).every(([key, check]) => key === 'style' || check.result === 'satisfied')) return false
  return (practical !== undefined || wallpaperReworkCount(item) < settings.maxReworks) && (!(repair || attempt.needsOutpaint) || item.edits < settings.maxEditsPerImage)
}
/** Stop repeated semantic failures only when their measured layout excess has not improved.
 * @param item Saved independent reviews; prompt wording and generated image ids do not identify a defect. @param settings Frozen repeat limit and output geometry.
 * @returns Whether the latest consecutive rejected reviews repeat the same defect without reducing its pixel excess.
 */
export function wallpaperRepairWithoutProgress(item: WallpaperItem, settings: WallpaperSettings): boolean {
  const limit = settings.repairPolicy?.maxRepeatedDefects
  if (!limit) return false
  const candidates = new Map<string | undefined, WallpaperReview>()
  for (const attempt of item.attempts) {
    const review = wallpaperAttemptReview(attempt)
    if (review && wallpaperVerdict(review) === 'reject') candidates.set(attempt.generation?.id ?? attempt.generationOperation ?? attempt.nativeReviewCandidate?.nativeDigest ?? attempt.generatedImageId ?? attempt.outputId, review)
  }
  const reviews = [...candidates.values()].slice(-limit)
  if (reviews.length < limit) return false
  const failures = reviews.map(review => {
    const edges = new Map<string, number>()
    const current = 'reviewVersion' in review && review.reviewVersion === 'wallpaper-review-source-v4' ? review : undefined
    const allowed = wallpaperProtectedBounds(settings)
    const core = current?.actualLayout.regions.filter(region => region.scope === 'core') ?? []
    const protectedCore = wallpaperGenerativeRepair(settings) ? wallpaperObjectProtectionRegions({ mode: core.some(region => region.role === 'subject') ? 'group' : current?.subjectIntegrity.mode ?? 'uncertain', regions: core }, settings) : core
    if (current?.checks.protection.result === 'violated' && current.layoutChecks.length) for (const region of protectedCore) {
      const bounds = { ...(region.role === 'subject' ? allowed.subject : allowed.critical), top: allowed.top }
      const excess = { left: bounds.left - region.rect.x * settings.width, top: bounds.top - region.rect.y * settings.height,
        right: (region.rect.x + region.rect.width) * settings.width - bounds.right, bottom: (region.rect.y + region.rect.height) * settings.height - bounds.bottom }
      for (const [edge, pixels] of Object.entries(excess)) if (pixels > 0) {
        const key = `${region.entityId ?? region.name}:${edge}`
        edges.set(key, Math.max(edges.get(key) ?? 0, Math.ceil(pixels)))
      }
    }
    const signature = current ? (current.modelIssues.length ? current.modelIssues : current.issues).map(issue => `${issue.kind}:${issue.check}:${issue.evidence?.entityIds.join(',') ?? ''}`) : review.issues.map(issue => issue.kind)
    return { signature: [...new Set([...signature, ...edges.keys()])].sort().join('|'), excess: [...edges.values()].reduce((a, b) => a + b, 0) }
  })
  const first = failures[0]!
  return !!first.signature && failures.every(failure => failure.signature === first.signature) && failures.at(-1)!.excess >= first.excess
}

/** Reuse source observations for pixel edits and uniformly place independently complete saved candidates for layout defects.
 * @param item Image retaining its rejected output and independent review.
 * @param settings Frozen repair authorization; omission retains conservative editing.
 * @returns Fresh editing attempt without another generation identity, or undefined when replanning is required.
 */
export function wallpaperEditingRetry(item: WallpaperItem, settings?: WallpaperSettings): WallpaperItem['attempts'][number] | undefined {
  const prior = item.attempts.at(-1), review = wallpaperAttemptReview(prior)
  if (!prior || !review || !prior.needsOutpaint && !(settings && wallpaperGenerativeRepair(settings)) || prior.checks.length) return undefined
  if (prior.compositionMode === 'background-plate-v1' || prior.compositionMode === 'background-plate-v2') return 'preservationProof' in review && review.preservationProof && (review.preservationRepairTarget === 'background' || review.checks.subject.result === 'satisfied' && review.checks.style.result === 'satisfied' && review.checks.clarity.result === 'satisfied' && review.issues.length && review.issues.every(issue => issue.kind === 'background' || issue.kind === 'readability')) ? { ...wallpaperGenerationRetry(prior, new Date().toISOString()), retryFrom: 'reviewing' } : undefined
  if (settings?.sourceIntentPolicy) {
    if (review.issues.some(issue => issue.kind !== 'background' && issue.kind !== 'readability' && !(settings.sourceIntentPolicy?.version === 'source-intent-v2' && issue.kind === 'layout')) || review.checks.subject.result !== 'satisfied' || !('sourceCorrespondence' in review) || review.sourceCorrespondence.result !== 'satisfied') return undefined
    return { ...wallpaperGenerationRetry(prior, new Date().toISOString()), retryFrom: 'reviewing' }
  }
  const placement = settings && wallpaperCandidatePlacement({ ...prior, review }, settings)
  if ((prior.layoutCorrection || review.issues.some(issue => issue.kind === 'layout') || settings && wallpaperGenerativeRepair(settings) && review.checks.background.result === 'violated') && !placement) return undefined
  return { revision: prior.revision + 1, plan: structuredClone(prior.plan), checks: [], needsOutpaint: true, compositionMode: prior.compositionMode,
    ...(placement ? { layoutCorrection: { version: 'candidate-placement-v1', plan: placement } } : {}),
    ...(prior.detailAnalysis ? { detailAnalysis: structuredClone(prior.detailAnalysis) } : {}), retryFrom: 'reviewing', retryTarget: 'rendering' }
}
/** Keep the effective reference and its transform when a technical generation retry needs a fresh receipt.
 * @param prior Saved attempt with its original observation and optional complete-candidate placement.
 * @param createdAt New attempt creation time.
 * @returns Rendering retry without the previous generation identity or review.
 */
export function wallpaperGenerationRetry(prior: WallpaperItem['attempts'][number], createdAt: string): WallpaperItem['attempts'][number] {
  return { revision: prior.revision + 1, createdAt, plan: structuredClone(prior.plan), checks: [], needsOutpaint: true, compositionMode: prior.compositionMode,
    ...(prior.layoutCorrection ? { layoutCorrection: { version: 'candidate-placement-v1', plan: structuredClone(prior.layoutCorrection.plan) } } : {}),
    ...(prior.detailAnalysis ? { detailAnalysis: structuredClone(prior.detailAnalysis) } : {}), retryFrom: 'rendering', retryTarget: 'rendering' }
}
/** One immutable input queue with mutable checkpoint progress owned by its Run. */
export const wallpaperStateSchema = z.strictObject({ version: z.union([z.literal(1), z.literal(2)]), sourceRunId: id, skillVersion: id, items: z.array(wallpaperItemSchema), budgetStopped: z.boolean().default(false) })
/** Parsed checkpoint used by Host execution and Client projections. */
export type WallpaperState = z.infer<typeof wallpaperStateSchema>
/** @param input Frozen continuation inputs. @returns The one image selected for continuation, review, recomposition, detail or decision; ordinary batches process their full queue. */
export function wallpaperWorkImage(input: Readonly<Record<string, Json>>): string | undefined {
  const value = input.continuationKind === 'replan' ? input.replacementImageId : input.continuationKind === 'image-action' ? input.actionImageVersionId : input.continuationKind === 'rework' ? input.reworkedImageId : input.continuationKind === 'continue' ? input.retryImageId ?? input.retryOriginalImageId : input.continuationKind === 'review' ? input.reviewedImageId : input.continuationKind === 'recompose' ? input.recomposedImageId : input.continuationKind === 'detail' ? input.inspectedImageId : input.continuationKind === 'decision' ? input.decidedImageId : undefined
  return typeof value === 'string' ? value : undefined
}
/** Locate legacy original failures without modifying the saved checkpoint.
 * @param item Saved source and its execution evidence.
 * @returns Owning failed step, including pre-download-node records.
 */
export function wallpaperFailedStep(item: WallpaperItem): WallpaperItem['failedStep'] {
  return !item.originalId && !item.attempts.length && item.failedStep === 'planning' ? 'downloading' : item.failedStep
}
/** @param item Saved image slot. @returns Whether its source is permanently unavailable rather than a retryable transport failure. */
export function wallpaperSourceRestricted(item: WallpaperItem): boolean { return wallpaperFailedStep(item) === 'downloading' && ['original-source-restricted', 'original-source-unavailable', 'original-source-missing'].includes(item.errorCode ?? '') }
/** @param item Saved image. @param attempt Displayed plan. @returns An unfinished decision bound to the current plan; its saved round and input must be reused. */
export function wallpaperPendingDecision(item: WallpaperItem | undefined, attempt = item?.attempts.at(-1)) {
  if (!item || !attempt || attempt !== item.attempts.at(-1)) return undefined
  const record = item.decisions?.at(-1)
  return record?.status === 'running' && record.planRevision === attempt.revision ? record : undefined
}
/** @param value Read-only task and explicit work target. @param imageVersionId Selected image. @returns A parked lifecycle for images outside a targeted continuation. */
export function wallpaperImageWorkStatus(value: Pick<WallpaperView, 'status' | 'workImageVersionId'>, imageVersionId: string): RunRecord['status'] {
  return value.workImageVersionId && value.workImageVersionId !== imageVersionId && value.status !== 'cancelled' && value.status !== 'cancelling' ? 'paused' : value.status
}
/** @param status Task lifecycle. @param total Frozen source count. @param passed Qualified source count. @returns Whether processing can be stopped, including a settled task retaining unfinished images. */
export function wallpaperCanCancel(status: RunRecord['status'], total: number, passed: number): boolean {
  return ['created', 'running', 'pausing', 'paused', 'interrupted'].includes(status) || ['completed', 'failed'].includes(status) && passed < total
}
/** @param attempt Saved crop or generation attempt. @returns Whether its output uses an allowed composition; model approval cannot waive source restoration. */
export function wallpaperCompositionEligible(attempt: WallpaperItem['attempts'][number] | undefined): boolean {
  if (!attempt || attempt.sourceIntentProof || ['protected-context-v1', 'protected-context-v2', 'generated-canvas-protected-v2', 'background-plate-v1', 'background-plate-v2', 'source-intent-background-v1'].some(mode => mode === attempt.compositionMode)) return false
  return !(attempt.needsOutpaint || attempt.generation || attempt.generatedImageId) || attempt.compositionMode === 'generated-canvas-v1'
}

/** Project retired pasted results as requiring replacement without changing historical reviews or task records.
 * @param state Immutable saved state. @returns Presentation state excluding pasted outputs from current qualification.
 */
export function wallpaperDisplayState(state: WallpaperState): WallpaperState {
  return { ...state, items: state.items.map(item => item.status === 'passed' && !wallpaperCompositionEligible(item.attempts.at(-1)) ? { ...item, status: 'needs-review', failedStep: 'reviewing', reason: 'complete-canvas-required' } : item) }
}

/** Summarize committed per-image stages without projecting the whole Run as an active node.
 * @param state Saved queue and its latest attempts.
 * @param activeImageVersionId Optional explicit recovery target; other saved pending stages remain historical.
 * @param status Owning task lifecycle; unfinished inherited decisions are attention when no worker owns them.
 * @returns Stage activity, completed artifacts, failures and images blocked by upstream steps.
 */
export function wallpaperProgress(state: WallpaperState, activeImageVersionId?: string, status?: RunRecord['status']): Record<string, number> {
  const items = wallpaperDisplayState(state).items
  const count = (matches: (item: WallpaperItem) => boolean) => items.filter(matches).length
  const ownsWork = (item: WallpaperItem) => (status === undefined || ['created', 'running', 'pausing', 'cancelling'].includes(status)) && (!activeImageVersionId || item.imageVersionId === activeImageVersionId)
  const parked = (item: WallpaperItem) => !ownsWork(item) && !!wallpaperPendingDecision(item)
  const stopped = (item: WallpaperItem) => ['rejected', 'needs-review', 'technical-failed'].includes(item.status) || parked(item)
  const planned = (item: WallpaperItem) => !!item.attempts.at(-1) && !item.attempts.at(-1)!.checks.length && item.attempts.at(-1)!.plan.mode !== 'uncertain'
  return {
    ...Object.fromEntries(['queued', 'downloading', 'planning', 'rendering', 'reviewing', 'passed', 'rejected', 'needs-review', 'technical-failed', 'cancelled'].map(status => [status, count(item => item.status === status && (!['downloading', 'planning', 'rendering', 'reviewing'].includes(status) || ownsWork(item)))])),
    attention: status === 'cancelled' ? 0 : count(stopped),
    downloaded: count(item => !!item.originalId && wallpaperFailedStep(item) !== 'downloading'), downloadingFailed: count(item => wallpaperFailedStep(item) === 'downloading'), downloadingRestricted: count(wallpaperSourceRestricted), downloadingReplaced: count(item => !!item.replacementOf),
    downloadingRetrying: count(item => item.status === 'downloading' && item.download?.retrying === true),
    planned: count(planned), rendered: count(item => wallpaperHasRendered(item.attempts.at(-1))), reviewed: count(item => !!wallpaperAttemptReview(item.attempts.at(-1))),
    planningFailed: count(item => wallpaperFailedStep(item) === 'planning' || !!item.attempts.at(-1)?.checks.length),
    renderingFailed: count(item => item.failedStep === 'rendering'),
    reviewingFailed: count(item => item.failedStep === 'reviewing' || !!wallpaperAttemptReview(item.attempts.at(-1)) && wallpaperVerdict(wallpaperAttemptReview(item.attempts.at(-1))!) === 'reject'),
    planningAttention: count(item => item.status === 'needs-review' && (!planned(item) || item.attempts.at(-1)?.plan.mode === 'uncertain')),
    renderingAttention: count(item => item.status === 'needs-review' && planned(item) && item.attempts.at(-1)?.plan.mode !== 'uncertain' && !wallpaperHasRendered(item.attempts.at(-1))),
    reviewingAttention: count(item => item.status === 'needs-review' && !!wallpaperAttemptReview(item.attempts.at(-1)) && wallpaperVerdict(wallpaperAttemptReview(item.attempts.at(-1))!) === 'needs-review'),
    planningBlocked: count(item => stopped(item) && (!item.originalId || wallpaperFailedStep(item) === 'downloading')),
    renderingBlocked: count(item => stopped(item) && (wallpaperFailedStep(item) === 'planning' || !planned(item) || item.attempts.at(-1)?.plan.mode === 'uncertain')),
    reviewingBlocked: count(item => stopped(item) && !wallpaperHasRendered(item.attempts.at(-1))),
  }
}
/** View-only original acquisition state; byte counters never enter saved task checkpoints. */
export const wallpaperDownloadProgressSchema = z.strictObject({
  phase: z.enum(['waiting', 'locating', 'downloading', 'retrying', 'saving', 'saved', 'reused', 'restricted', 'failed', 'paused', 'cancelled']),
  attempt: z.number().int().nonnegative(), receivedBytes: z.number().int().nonnegative(), totalBytes: z.number().int().nonnegative().optional(),
})
/** Read-only original download counters for one task image and attempt. */
export type WallpaperDownloadProgress = z.infer<typeof wallpaperDownloadProgressSchema>
/** @param item Saved source state. @param status Current owning task status. @param live Optional active transfer; absence never invents received bytes. @returns Original acquisition status, with committed results taking priority over transient counters. */
export function wallpaperDownloadProgress(item: WallpaperItem, status: RunRecord['status'], live?: WallpaperDownloadProgress): WallpaperDownloadProgress {
  const base = { attempt: item.download?.attempts ?? 0, receivedBytes: 0 }
  if (item.originalId && wallpaperFailedStep(item) !== 'downloading') return { ...base, phase: item.download?.reused ? 'reused' : 'saved', receivedBytes: item.download?.byteLength ?? 0, ...(item.download?.byteLength === undefined ? {} : { totalBytes: item.download.byteLength }) }
  if (wallpaperSourceRestricted(item)) return { ...base, phase: 'restricted' }
  if (wallpaperFailedStep(item) === 'downloading') return { ...base, phase: 'failed' }
  if (status === 'paused' || status === 'interrupted') return { ...base, phase: 'paused' }
  if (status === 'cancelled' || status === 'cancelling') return { ...base, phase: 'cancelled' }
  if (status === 'failed') return { ...base, phase: 'failed' }
  if (item.status === 'downloading' && ['created', 'running', 'pausing'].includes(status)) return live ?? { ...base, phase: item.download?.retrying ? 'retrying' : 'locating' }
  return { ...base, phase: 'waiting' }
}
/** Read-only authorized canvas state, with image resources resolved by the existing resource endpoint. */
export const wallpaperViewSchema = z.object({
  runId: runSchema.shape.id, sourceRunId: runSchema.shape.id, status: runSchema.shape.status, settings: wallpaperSettingsSchema, state: wallpaperStateSchema,
  artifactDimensions: z.record(z.string(), z.object({ width: z.number().int().positive(), height: z.number().int().positive() })).optional(),
  resources: z.record(z.string(), z.string()), artifactTimes: z.record(z.string(), z.iso.datetime()).optional(),
  sourceImages: z.record(z.string(), z.object({ width: z.number().int().positive(), height: z.number().int().positive(), previewPath: z.string() })),
  previewResources: z.record(z.string(), z.string()).default({}),
  workImageVersionId: id.optional(),
  imageRetries: z.record(id, z.discriminatedUnion('status', [z.strictObject({ status: z.literal('queued') }), z.strictObject({ status: z.literal('failed'), code: z.string() })])).optional(),
  downloads: z.record(z.string(), wallpaperDownloadProgressSchema).optional(),
  generationReceipts: z.record(id, z.enum(['queued', 'sent', 'succeeded', 'failed', 'cancelled', 'outcome-unknown', 'unavailable'])).optional(),
  enhancements: z.record(z.string(), z.strictObject({ revision: z.number().int().positive(), step: z.enum(['background', 'subject']), progress: resolutionProgressSchema })).optional(),
  serverTransfers: z.record(z.string(), serverTransferViewSchema).optional(),
  itemIndex: z.array(wallpaperItemSchema.pick({ imageVersionId: true, status: true, failedStep: true }).extend({ planned: z.boolean(), previewPath: z.string().optional() })).optional(),
  resourceExpiresAt: z.number().int().positive().optional(),
  total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), counts: z.record(z.string(), z.number().int().nonnegative()),
  warnings: z.array(z.string()), errorCode: z.string().optional(),
})
/** Canvas task state. */
export type WallpaperView = z.infer<typeof wallpaperViewSchema>
/** Start identity pins the complete source batch; no Client-supplied image list can add unqualified inputs. */
export const wallpaperStartSchema = z.strictObject({ operationId: id, sourceRunId: id, settings: wallpaperSettingsSchema.optional() })
/** Scoped experience evidence remains distinct from human feedback and model weights. */
export const wallpaperExperienceSchema = z.strictObject({
  version: z.literal(1), cases: z.array(z.strictObject({ id, familyId: id, runId: id, imageVersionId: id, mode: wallpaperModeSchema, passed: z.boolean(), rounds: z.number().int().nonnegative(), needsGeneration: z.boolean(), reason: z.string(), learningEligible: z.boolean().default(false), benchmark: z.boolean().default(false), expectedPass: z.boolean().optional(), confirmedBy: z.string().min(1).optional(), confirmedAt: z.string().optional() }).refine(row => !row.benchmark || row.expectedPass !== undefined && row.confirmedBy !== undefined, 'Benchmark labels require an explicit human author and expected result')),
  active: id, autoPromote: z.boolean(), lastDistilledCount: z.number().int().nonnegative(), distilledFamilyIds: z.array(id).default([]),
  versions: z.array(z.strictObject({ id, content: z.string(), createdAt: z.string(), status: z.enum(['candidate', 'pending-evidence', 'verified', 'active', 'retired']), reason: z.string(), caseIds: z.array(id), parentId: id.optional(), changes: z.strictObject({ added: z.array(z.string()), removed: z.array(z.string()) }).optional(), evaluation: z.strictObject({ compared: z.number().int().nonnegative(), baselinePass: z.number().int().nonnegative(), candidatePass: z.number().int().nonnegative(), baselineRounds: z.number(), candidateRounds: z.number(), falseAccepts: z.number().int().nonnegative() }).optional() })),
}).refine(state => state.versions.filter(row => row.id === state.active && row.status === 'active').length === 1 && state.versions.filter(row => row.status === 'active').length === 1, 'The active Skill must identify exactly one saved active revision')
/** Profile-private experience catalog. */
export type WallpaperExperience = z.infer<typeof wallpaperExperienceSchema>
/** Distillation may cite only supplied cases and cannot redefine task constraints. */
export const wallpaperDistillationSchema = z.strictObject({ guidance: text, evidenceCaseIds: z.array(id).min(1), requiresNewGeneration: z.boolean() })

/** Compute a Host verdict without interpreting model confidence as probability.
 * @param review Actual-pixel review.
 * @returns Required-first acceptance result.
 */
export function wallpaperVerdict(review: WallpaperReview): 'pass' | 'reject' | 'needs-review' {
  const checks = wallpaperReviewKeys.map(key => review.checks[key].result)
  if ('clarity' in review.checks) checks.push(review.checks.clarity.result)
  if ('subjectIntegrity' in review) checks.push(wallpaperSubjectCheck(review.subjectIntegrity, 'sourceRepairAuthorized' in review && review.sourceRepairAuthorized === true).result)
  if ('sourceRepair' in review) checks.push(review.sourceRepair.result)
  if ('sourceCorrespondence' in review) checks.push(review.sourceCorrespondence.result)
  return checks.includes('violated') ? 'reject' : checks.includes('unknown') || 'styleMatch' in review && review.issues.some(issue => issue.kind !== 'style') || 'reviewVersion' in review && ['wallpaper-review-source-v1', 'wallpaper-review-source-v2', 'wallpaper-review-source-v3', 'wallpaper-review-source-v4'].includes(review.reviewVersion) && review.issues.length > 0 ? 'needs-review' : 'pass'
}
