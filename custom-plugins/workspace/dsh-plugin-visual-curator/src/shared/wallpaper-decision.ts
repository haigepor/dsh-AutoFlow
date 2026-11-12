/** Evidence-bound routing decisions retain source protection and never qualify an output image. */
import { z } from 'zod'
import type { WallpaperPlan } from './wallpaper.ts'
import { wallpaperEdgeRepairEvidenceSchema, wallpaperFindingSchema, wallpaperFindingBlocksEditing } from './wallpaper-evidence.ts'

const text = z.string().trim().min(1).max(4096)
const id = z.string().min(1).max(256)
const revision = z.number().int().positive()
const rect = z.strictObject({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1), width: z.number().finite().positive().max(1), height: z.number().finite().positive().max(1) }).refine(value => value.x + value.width <= 1 && value.y + value.height <= 1)

/** New tasks freeze these decision-only limits; an absent legacy policy remains absent. */
export const wallpaperDecisionSettingsSchema = z.strictObject({
  version: z.literal('wallpaper-decision-v1').default('wallpaper-decision-v1'), enabled: z.boolean().default(true),
  maxRoundsPerImage: z.number().int().min(1).max(4).default(2), maxDetailRequests: z.number().int().min(0).max(2).default(1),
  reasoningEffort: z.string().trim().min(1).max(128).optional(),
})
/** Decision limits do not reset image-edit counts, request budgets or model defaults. */
export type WallpaperDecisionSettings = z.infer<typeof wallpaperDecisionSettingsSchema>
/** The Host offers only actions executable with its current evidence, receipts and remaining limits. */
export const wallpaperDecisionActionKinds = ['continue_current_plan', 'inspect_region', 'replan', 'retry_reference_preparation', 'query_saved_generation', 'recompose_saved_background', 'reconstruct_saved_background', 'retry_saved_review', 'skip_image', 'manual_review'] as const
/** Each action accepts only the parameters owned by that action. */
export const wallpaperDecisionActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('continue_current_plan') }),
  z.strictObject({ kind: z.literal('inspect_region'), rect, concernIds: z.array(id).min(1).max(64) }),
  z.strictObject({ kind: z.literal('replan'), guidance: text }),
  z.strictObject({ kind: z.literal('retry_reference_preparation') }), z.strictObject({ kind: z.literal('query_saved_generation') }),
  z.strictObject({ kind: z.literal('recompose_saved_background') }), z.strictObject({ kind: z.literal('reconstruct_saved_background') }),
  z.strictObject({ kind: z.literal('retry_saved_review') }), z.strictObject({ kind: z.literal('skip_image') }), z.strictObject({ kind: z.literal('manual_review') }),
])
/** A routing action is not a final review verdict. */
export type WallpaperDecisionAction = z.infer<typeof wallpaperDecisionActionSchema>
/** Closed action identifiers used by the Host allowlist. */
export type WallpaperDecisionActionKind = WallpaperDecisionAction['kind']
/** Findings distinguish actual source damage, normal occlusion, background framing and technical failures. */
export const wallpaperDecisionResponseSchema = z.strictObject({
  version: z.literal('wallpaper-decision-v1'), imageVersionId: id, planRevision: revision,
  findings: z.array(z.strictObject({ concernId: id, scope: z.enum(['subject', 'critical', 'background', 'technical']), classification: z.enum(['frame-truncation', 'normal-occlusion', 'background-crop', 'observation-limit', 'technical-failure', 'resolved', 'unknown']), blocking: z.boolean(), reason: text, evidenceImageVersionIds: z.array(id).min(1).max(32), sourceRegion: rect.optional().describe('Canonical original-frame normalized region of the critical content. Required for critical resolved findings and every critical finding when continuing; cite a supplied native source crop that fully contains this region.') })).max(64),
  sourceExtent: z.strictObject({ extent: z.enum(['complete', 'cut-off', 'occluded', 'not-applicable', 'unknown']), reason: text }),
  action: wallpaperDecisionActionSchema, reason: text,
})
/** V2 can route a saved, evidence-bound edge repair while retaining the source's actual cut-off extent. */
export const wallpaperDecisionResponseV2Schema = wallpaperDecisionResponseSchema.extend({ version: z.literal('wallpaper-decision-v2'), findings: z.array(wallpaperFindingSchema).max(64) })
const storedDecisionResponseSchema = wallpaperDecisionResponseV2Schema.extend({ version: z.enum(['wallpaper-decision-v1', 'wallpaper-decision-v2']) }).refine(value => value.version !== 'wallpaper-decision-v1' || wallpaperDecisionResponseSchema.safeParse(value).success, { message: 'decision-version-findings-mismatch' })
/** Strict model output; exact source, revision, concern coverage and image membership are bound per request. */
export type WallpaperDecisionResponse = z.infer<typeof storedDecisionResponseSchema>
/** A concern keeps its first-pass identity and may require actual covering native detail evidence. */
export interface WallpaperDecisionConcern {
  id: string
  text: string
  scope?: WallpaperDecisionResponse['findings'][number]['scope'] | undefined
  /** When present, resolving this concern requires one of these supplied covering crops; an empty list cannot resolve it. */
  detailImageVersionIds?: readonly string[] | undefined
}
/** The Host supplies scene organization and any saved permission to edit a localized source edge. */
export interface WallpaperDecisionContext {
  mode: WallpaperPlan['mode']
  /** True when subject or critical object structures require whole-source integrity. */
  hasProtectedSubject: boolean
  /** Present only for current native inspection; absent evidence never authorizes source repair. */
  editEvidence?: z.infer<typeof wallpaperDecisionEditEvidenceSchema> | undefined
}
/** Only the Host copies saved detail readiness into routing; a model cannot grant its own repair authorization. */
export const wallpaperDecisionEditEvidenceSchema = z.strictObject({
  outcome: z.enum(['resolved', 'ready-for-edit', 'unresolved', 'violated', 'unavailable']),
  sourceExtent: z.enum(['complete', 'cut-off', 'occluded', 'not-applicable', 'unknown']),
  findings: z.array(wallpaperFindingSchema).max(35), edgeRepair: wallpaperEdgeRepairEvidenceSchema.optional(),
})

/** Bind one decision to the exact request and retain every unresolved hard constraint.
 * @param sourceId Canonical original actually supplied to the model. @param planRevision Current saved plan revision.
 * @param concerns Exact pending concerns; optional detail identities refer only to covering native crops.
 * @param allowedActions Host-computed executable actions. @param imageIds Actual supplied whole-frame and detail identities.
 * @param context Host-observed scene organization; absent context requires complete source extent for continuation.
 * @param version Frozen decision protocol; omission retains V1's complete-source requirement.
 * @returns A strict parser; continuation routes processing and never establishes final acceptance.
 */
export function wallpaperDecisionOutputSchema(sourceId: string, planRevision: number, concerns: readonly WallpaperDecisionConcern[], allowedActions: readonly WallpaperDecisionActionKind[], imageIds: readonly string[], context?: WallpaperDecisionContext, version: WallpaperDecisionResponse['version'] = 'wallpaper-decision-v1') {
  id.parse(sourceId); revision.parse(planRevision)
  if (!imageIds.includes(sourceId) || new Set(imageIds).size !== imageIds.length || imageIds.some(value => !id.safeParse(value).success)) throw new TypeError('Decision images require distinct supplied identities including the original.')
  if (new Set(concerns.map(concern => concern.id)).size !== concerns.length || concerns.some(concern => !id.safeParse(concern.id).success || !text.safeParse(concern.text).success || concern.detailImageVersionIds?.some(value => value === sourceId || !imageIds.includes(value)))) throw new TypeError('Decision concerns require unique identities and supplied covering detail evidence.')
  if (!allowedActions.length || new Set(allowedActions).size !== allowedActions.length || allowedActions.some(kind => !wallpaperDecisionActionKinds.includes(kind))) throw new TypeError('Decision actions require a nonempty, distinct Host allowlist.')
  const [firstAction, ...otherActions] = wallpaperDecisionActionSchema.options.filter(option => allowedActions.includes(option.shape.kind.value))
  if (!firstAction) throw new TypeError('Decision action schemas do not contain an allowed action.')
  const actions = z.discriminatedUnion('kind', [firstAction, ...otherActions])
  const responseSchema = version === 'wallpaper-decision-v2' ? wallpaperDecisionResponseV2Schema : wallpaperDecisionResponseSchema
  const findingSchema = responseSchema.shape.findings.element
  const byId = new Map(concerns.map(concern => [concern.id, concern]))
  const finding = findingSchema.extend({
    concernId: z.enum(concerns.map(concern => concern.id)),
    scope: findingSchema.shape.scope.optional().describe('Supply the scope for an unclassified concern. When the input concern already has a scope, omit this field; the Host retains its classification.'),
    evidenceImageVersionIds: z.array(z.enum(imageIds)).min(1).max(32),
  }).transform((value, ctx) => {
    const scope = byId.get(value.concernId)?.scope ?? value.scope
    if (!scope) {
      ctx.addIssue({ code: 'custom', path: ['scope'], message: 'decision-unclassified-concern-needs-scope' })
      return z.NEVER
    }
    return { ...value, scope }
  })
  return responseSchema.extend({ imageVersionId: z.literal(sourceId), planRevision: z.literal(planRevision), action: actions, findings: z.array(finding).length(concerns.length) }).superRefine((value, ctx) => {
    const seen = new Set<string>()
    for (const [index, finding] of value.findings.entries()) {
      const concern = byId.get(finding.concernId)
      if (seen.has(finding.concernId) || !concern) ctx.addIssue({ code: 'custom', path: ['findings', index, 'concernId'], message: 'decision-concerns-mismatch' })
      seen.add(finding.concernId)
      if (new Set(finding.evidenceImageVersionIds).size !== finding.evidenceImageVersionIds.length) ctx.addIssue({ code: 'custom', path: ['findings', index, 'evidenceImageVersionIds'], message: 'decision-duplicate-evidence' })
      const detailIds = concern?.detailImageVersionIds
      if (detailIds !== undefined && (finding.classification === 'resolved' || value.action.kind === 'continue_current_plan') && !finding.evidenceImageVersionIds.some(imageId => detailIds.includes(imageId))) ctx.addIssue({ code: 'custom', path: ['findings', index, 'evidenceImageVersionIds'], message: 'decision-covering-detail-required' })
      if (finding.scope === 'critical' && (finding.classification === 'resolved' || value.action.kind === 'continue_current_plan') && !finding.sourceRegion) ctx.addIssue({ code: 'custom', path: ['findings', index, 'sourceRegion'], message: 'decision-critical-source-region-required' })
    }
    if (concerns.some(concern => !seen.has(concern.id))) ctx.addIssue({ code: 'custom', path: ['findings'], message: 'decision-concerns-mismatch' })
    if (!allowedActions.includes(value.action.kind)) ctx.addIssue({ code: 'custom', path: ['action', 'kind'], message: 'decision-action-not-allowed' })
    if (value.action.kind === 'inspect_region' && (new Set(value.action.concernIds).size !== value.action.concernIds.length || value.action.concernIds.some(concernId => !concerns.some(concern => concern.id === concernId)))) ctx.addIssue({ code: 'custom', path: ['action', 'concernIds'], message: 'decision-inspection-concerns-mismatch' })
    if (value.action.kind !== 'continue_current_plan') return
    const objectFinding = (scope: string) => scope === 'subject' || scope === 'critical'
    const noObjectExtent = value.sourceExtent.extent === 'not-applicable' && (context?.mode === 'abstract' || context?.mode === 'scene') && !context.hasProtectedSubject && !value.findings.some(finding => objectFinding(finding.scope)) && !concerns.some(concern => concern.scope !== undefined && objectFinding(concern.scope))
    const evidence = version === 'wallpaper-decision-v2' ? context?.editEvidence : undefined
    const repair = evidence?.edgeRepair
    const repairAuthorized = evidence?.outcome === 'ready-for-edit' && evidence.sourceExtent === 'cut-off' && repair?.classification === 'edge-continuation' && !!repair.edges.length && !!repair.sourceRegion && !!repair.evidenceImageVersionIds?.length && !!repair.concernIds?.length
    if (value.sourceExtent.extent !== 'complete' && !noObjectExtent && !(value.sourceExtent.extent === 'cut-off' && repairAuthorized)) ctx.addIssue({ code: 'custom', path: ['sourceExtent'], message: 'decision-complete-source-required' })
    if (value.findings.some(wallpaperFindingBlocksEditing) || evidence?.findings.some(wallpaperFindingBlocksEditing) || evidence && !['resolved', 'ready-for-edit'].includes(evidence.outcome)) ctx.addIssue({ code: 'custom', path: ['action'], message: 'decision-blocking-findings' })
    if (evidence && value.sourceExtent.extent !== evidence.sourceExtent) ctx.addIssue({ code: 'custom', path: ['sourceExtent'], message: 'decision-source-evidence-mismatch' })
    if (evidence && value.findings.some(finding => evidence.findings.some(saved => saved.concernId === finding.concernId && (saved.scope !== finding.scope || saved.classification !== finding.classification || saved.blocking !== finding.blocking)))) ctx.addIssue({ code: 'custom', path: ['findings'], message: 'decision-saved-finding-conflict' })
    if (value.findings.some(finding => finding.classification === 'edge-continuation' && (!repairAuthorized || !repair.concernIds?.includes(finding.concernId)) || finding.classification === 'unseen-detail' && !evidence?.findings.some(saved => saved.concernId === finding.concernId && saved.scope === finding.scope && saved.classification === 'unseen-detail' && !wallpaperFindingBlocksEditing(saved)))) ctx.addIssue({ code: 'custom', path: ['findings'], message: 'decision-saved-edit-evidence-required' })
  })
}

/** Each image owns one cross-attempt decision history; attempts never clone these counters or responses. */
export const wallpaperDecisionRecordSchema = z.strictObject({
  id, version: z.enum(['wallpaper-decision-v1', 'wallpaper-decision-v2']), inputDigest: z.string().regex(/^[a-f0-9]{64}$/), evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  planRevision: revision, round: z.number().int().positive(), status: z.enum(['running', 'applied', 'manual', 'skipped', 'failed']), reason: text,
  /** Safe frozen usage and source crop coordinates only; model requests and image bytes remain in their existing owners. */
  input: z.json().optional(), sourceStage: z.enum(['planning', 'rendering', 'reviewing']).optional(),
  response: storedDecisionResponseSchema.optional(), targetRevision: revision.optional(), targetStage: z.enum(['planning', 'detail', 'rendering', 'reviewing', 'decision']).optional(), detailRect: rect.optional(), errorCode: id.optional(),
}).refine(value => value.response === undefined || value.response.planRevision === value.planRevision, { path: ['response', 'planRevision'], message: 'decision-record-revision-mismatch' }).refine(value => value.response === undefined || value.response.version === value.version, { path: ['response', 'version'], message: 'decision-record-version-mismatch' })
/** A committed response or a safe failure is retained without resetting the source image's round count. */
export type WallpaperDecisionRecord = z.infer<typeof wallpaperDecisionRecordSchema>
