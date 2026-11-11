/** Versioned wallpaper settings, inferred scene evidence and resumable per-image progress. */
import { z } from 'zod'
import { serverTransferViewSchema } from './server-queue.ts'
import { claritySettingsSchema, clarityStateSchema } from './clarity.ts'
import { backgroundResolutionSettingsSchema, backgroundResolutionStateSchema } from './background-resolution.ts'
import { wallpaperDecisionSettingsSchema, wallpaperDecisionRecordSchema } from './wallpaper-decision.ts'
import { styleMatchSchema } from './style-matching.ts'
import { blobRefSchema, runSchema, type Json, type RunRecord } from './model.ts'

const text = z.string().trim().min(1).max(4096)
const id = z.string().min(1).max(256)
/** Prompt content and identifiers are frozen with each task, independently of future plugin edits. */
export const wallpaperPromptBundleSchema = z.strictObject({
  plan: z.strictObject({ version: z.enum(['wallpaper-plan-v1', 'wallpaper-plan-v2', 'wallpaper-plan-v3', 'wallpaper-plan-v4', 'wallpaper-plan-v5', 'wallpaper-plan-v6']), text: z.string().min(1) }),
  detail: z.strictObject({ version: z.enum(['wallpaper-plan-detail-v1', 'wallpaper-plan-detail-v2', 'wallpaper-plan-detail-v3']), text: z.string().min(1) }).optional(),
  decision: z.strictObject({ version: z.literal('wallpaper-decision-v1'), text: z.string().min(1) }).optional(),
  review: z.strictObject({ version: z.enum(['wallpaper-review-v1', 'wallpaper-review-v2', 'wallpaper-review-v3', 'wallpaper-review-v4', 'wallpaper-review-source-v1']), text: z.string().min(1) }),
  outpaint: z.strictObject({ version: z.enum(['wallpaper-outpaint-v1', 'wallpaper-outpaint-v2', 'wallpaper-outpaint-v3', 'wallpaper-outpaint-v4']), text: z.string().min(1) }),
  distill: z.strictObject({ version: z.literal('wallpaper-distill-v1'), text: z.string().min(1) }),
})
const rect = z.strictObject({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1), width: z.number().finite().positive().max(1), height: z.number().finite().positive().max(1) }).refine(r => r.x + r.width <= 1 && r.y + r.height <= 1)
/** Deployment defaults are frozen when a wallpaper task is accepted. */
export const wallpaperSettingsSchema = z.strictObject({
  version: z.literal(1).default(1), width: z.literal(1845).default(1845), height: z.literal(3280).default(3280),
  safe: z.strictObject({ left: z.literal(258).default(258), top: z.literal(1032).default(1032), width: z.literal(1329).default(1329), height: z.literal(1686).default(1686) }).default({ left: 258, top: 1032, width: 1329, height: 1686 }),
  topBuffer: z.number().int().min(0).max(256).default(32), sideOverflow: z.number().int().min(0).max(258).default(66), bottomOverflow: z.number().int().min(0).max(562).default(84),
  backgroundTransitionPixels: z.number().int().min(0).max(256).default(192),
  backgroundContextPixels: z.number().int().min(0).max(512).default(128),
  concurrency: z.number().int().min(1).max(8).default(2), maxReworks: z.number().int().min(0).max(5).default(5), maxEditsPerImage: z.number().int().min(0).max(5).default(5),
  recoveryLimitVersion: z.literal('five-attempts-v1').optional(),
  imageProvider: z.string().min(1).default('autoflow-codex'), imageModel: z.string().default(''), imageSize: z.string().min(1).default('1872x3328'), imageQuality: z.enum(['auto', 'low', 'medium', 'high']).default('high'),
  clarity: claritySettingsSchema.optional(),
  backgroundResolution: backgroundResolutionSettingsSchema.optional(),
  decision: wallpaperDecisionSettingsSchema.optional(),
  learningEnabled: z.boolean().default(true), autoPromote: z.boolean().default(true), learningInterval: z.number().int().positive().default(20), minBenchmarks: z.number().int().min(12).default(12), maxEvalVisionCalls: z.number().int().positive().max(48).default(48), maxSkillChars: z.number().int().min(1000).max(16000).default(4000),
})
/** Frozen wallpaper processing policy. */
export type WallpaperSettings = z.infer<typeof wallpaperSettingsSchema>
/** Upgrade unversioned edit and rework defaults on a newly resolved configuration or a newly authorized continuation.
 * @param settings Parsed settings owned by the new operation; historical run settings stay frozen.
 */
export function applyWallpaperRecoveryLimits(settings: WallpaperSettings): void {
  if (settings.recoveryLimitVersion) return
  if (settings.maxReworks === 2) settings.maxReworks = 5
  if (settings.maxEditsPerImage === 2) settings.maxEditsPerImage = 5
  settings.recoveryLimitVersion = 'five-attempts-v1'
}
/** Modes describe visual organization rather than a closed list of object classes. */
export const wallpaperModeSchema = z.enum(['single', 'group', 'scene', 'abstract', 'uncertain'])
/** Inferred regions on the EXIF-oriented source; they are not measured segmentation masks. */
export const wallpaperPlanSchema = z.strictObject({
  version: z.literal(1), imageVersionId: id, mode: wallpaperModeSchema, subject: text, evidence: text,
  priorities: z.array(text).max(16), anchors: z.array(text).max(16), truncations: z.array(text).max(16), uncertainties: z.array(text).max(16),
  regions: z.array(z.strictObject({ name: text, role: z.enum(['subject', 'critical', 'anchor']), rect })).max(32),
  placement: z.strictObject({ scale: z.number().finite().positive().max(1), left: z.number().int(), top: z.number().int() }),
  reason: text,
  editPrompt: text.describe('Scene-specific background editing instructions grounded in the original pixels: subject details to preserve, lighting, horizon, perspective and transitions. No new subject or imagined source detail.').optional(),
})
/** V4 delegates pixel placement to the Host while retaining every inferred protection region and uncertainty. */
export const wallpaperObservationPlanSchema = wallpaperPlanSchema.omit({ placement: true })
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
/** Stored V4 reviews retain both the independent detail judgment and fixed style policy. */
export const wallpaperStoredReviewV4Schema = z.union([wallpaperReviewV4Schema.extend({ styleMatch: styleMatchSchema, modelStyleCheck: check }), wallpaperReviewV4Schema, wallpaperReviewV4Schema.extend({ subjectRejectionOnly: z.literal(true) }).refine(review =>
  [review.subjectIntegrity.source, review.subjectIntegrity.output].some(frame => frame.extent === 'cut-off') && review.checks.subject.result === 'violated'
  && Object.entries(review.checks).every(([key, row]) => key === 'subject' || row.result === 'unknown') && review.styleResults.length === 0)])
const subjectRejectionReviewSchema = wallpaperReviewV3Schema.extend({ subjectRejectionOnly: z.literal(true) }).refine(review =>
  [review.subjectIntegrity.source, review.subjectIntegrity.output].some(frame => frame.extent === 'cut-off') && review.checks.subject.result === 'violated'
  && wallpaperReviewKeys.every(key => key === 'subject' || review.checks[key].result === 'unknown') && review.styleResults.length === 0)
/** Weighted policies retain their deterministic style result; incomplete responses can establish rejection only. */
export const wallpaperStoredReviewV3Schema = z.union([wallpaperReviewV3Schema.extend({ styleMatch: styleMatchSchema, modelStyleCheck: check }), wallpaperReviewV3Schema, subjectRejectionReviewSchema])
/** Frozen V1/V2 reviews remain readable without inserting new judgments into history. */
export const wallpaperStoredReviewSchema = z.union([wallpaperSourceReviewSchema, wallpaperStoredReviewV4Schema, wallpaperStoredReviewV3Schema, wallpaperStoredReviewV2Schema, wallpaperReviewSchema])
/** @param integrity Independent original/output pixel observations. @returns Required subject result; partial subjects and uncertain evidence cannot automatically pass. */
export function wallpaperSubjectCheck(integrity: z.infer<typeof wallpaperSubjectIntegritySchema>): z.infer<typeof check> {
  if (integrity.task.result === 'violated') return integrity.task
  const frames = [integrity.source, integrity.output]
  const cut = frames.find(frame => frame.extent === 'cut-off')
  if (cut) return { result: 'violated', reason: `主体完整性不通过：${cut.reason}` }
  if (integrity.task.result === 'unknown') return integrity.task
  if (integrity.mode === 'uncertain' || frames.some(frame => frame.extent === 'unknown' || frame.extent === 'occluded')) return { result: 'unknown', reason: '原图或成品的完整主体范围尚无法确认，需要人工复核' }
  const object = integrity.mode === 'single' || integrity.mode === 'group'
  if (object && frames.some(frame => frame.extent !== 'complete') || !object && frames.some(frame => frame.extent !== 'not-applicable')) return { result: 'unknown', reason: '主体模式与完整性证据不一致，需要人工复核' }
  return { result: 'satisfied', reason: object ? '原图与实际成品的完整主体范围均有独立像素证据，且符合任务要求' : '非对象构图及任务要求均已独立复核' }
}
/** Select the versioned wire output and validate requested rules and actual final-pixel evidence.
 * @param version Frozen review prompt version. @param ruleIds Requested visual rules. @param imageIds Authorized request images. @param finalImageId Actual final wallpaper image. @param sourceImageId Original pixels; required by V3 and unused by older protocols.
 * @returns The exact frozen protocol with request-specific evidence validation.
 */
export function wallpaperReviewOutputSchema(version: string, ruleIds: readonly string[], imageIds: readonly string[], finalImageId?: string, sourceImageId?: string) {
  if (version === 'wallpaper-review-v1') return wallpaperReviewSchema
  if (version === 'wallpaper-review-source-v1') {
    if (ruleIds.length || !sourceImageId || !finalImageId || sourceImageId === finalImageId || !imageIds.includes(sourceImageId) || !imageIds.includes(finalImageId)) throw new TypeError('Source-fidelity review requires distinct authorized original/output pixels and no dataset rules.')
    return wallpaperSourceReviewSchema.extend({ subjectIntegrity: wallpaperSubjectIntegritySchema.extend({ source: subjectExtent.extend({ imageVersionId: z.literal(sourceImageId).describe('Required source evidence identity: copy this exact const from wallpaper-original. Extent and reason do not replace this field; detail crops and simulations are not the original frame.') }), output: subjectExtent.extend({ imageVersionId: z.literal(finalImageId).describe('Required output evidence identity: copy this exact const from actual-wallpaper. Extent and reason do not replace this field; detail crops and simulations are not the final frame.') }) }) })
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
export const wallpaperCompositionModeSchema = z.enum(['source-edge-v1', 'protected-context-v1', 'protected-context-v2'])
/** Deterministic source-preserving blend selected for one saved attempt. */
export type WallpaperCompositionMode = z.infer<typeof wallpaperCompositionModeSchema>
const generation = z.strictObject({ id, provider: id, model: id, taskId: id })
/** Exact scene prompt and admitted reference identities saved before one image dispatch. */
export const wallpaperGenerationInputSchema = z.strictObject({ version: z.literal('wallpaper-edit-input-v1'), prompt: z.string().min(1).max(32768), references: z.array(z.strictObject({ role: z.enum(['canvas', 'original', 'subject-detail', 'critical-detail', 'layout-only']), attachmentId: id, width: z.number().int().positive(), height: z.number().int().positive(), sourceRect: rect.optional() })).min(1).max(5) })
/** Each round preserves its plan, artifacts and actual review; revising a plan does not erase history. */
export const wallpaperAttemptSchema = z.strictObject({
  revision: z.number().int().positive(), plan: wallpaperPlanSchema,
  checks: z.array(z.string()), needsOutpaint: z.boolean(),
  detailAnalysis: z.strictObject({ version: z.enum(['wallpaper-plan-detail-v1', 'wallpaper-plan-detail-v2', 'wallpaper-plan-detail-v3']), requestId: id, outcome: z.enum(['resolved', 'unresolved', 'violated', 'unavailable']), protectedSubjectExtent: subjectExtent.shape.extent.optional() }).optional(),
  canvasId: id.optional(), maskId: id.optional(), layoutAnalysisId: id.optional(), analysisId: id.optional(), simulationId: id.optional(), outputId: id.optional(),
  clarity: clarityStateSchema.optional(), clarityBaseReview: wallpaperStoredReviewSchema.optional(),
  generation: generation.optional(), generationOperation: id.optional(), editReserved: z.boolean().optional(), review: wallpaperStoredReviewSchema.optional(), compositionMode: wallpaperCompositionModeSchema.optional(),
  generationInput: wallpaperGenerationInputSchema.optional(),
  backgroundResolution: backgroundResolutionStateSchema.optional(),
  retryFrom: z.enum(['planning', 'reviewing']).optional(), retryTarget: z.enum(['planning', 'rendering', 'reviewing']).optional(),
})
/** Saved progress for one qualified source. */
export const wallpaperItemSchema = z.strictObject({
  imageVersionId: id, originalId: id.optional(), familyId: id, status: z.enum(['queued', 'downloading', 'planning', 'rendering', 'reviewing', 'passed', 'rejected', 'needs-review', 'technical-failed']),
  download: z.strictObject({ attempts: z.number().int().nonnegative(), retrying: z.boolean(), originalBlob: blobRefSchema.optional(), byteLength: z.number().int().nonnegative().optional(), savedAt: z.iso.datetime().optional(), reused: z.boolean().optional(), lastErrorCode: z.string().optional() }).optional(),
  edits: z.number().int().nonnegative().default(0), attempts: z.array(wallpaperAttemptSchema).default([]),
  decisions: z.array(wallpaperDecisionRecordSchema).optional(),
  detailInspection: z.strictObject({
    origin: z.enum(['planning', 'decision', 'manual']), status: z.enum(['queued', 'running', 'resolved', 'unresolved', 'violated', 'unavailable', 'failed']),
    planRevision: z.number().int().positive(), requestId: id, decisionRoundAtStart: z.number().int().nonnegative().optional(), decisionId: id.optional(), rect: rect.optional(), reason: z.string().optional(), errorCode: id.optional(),
  }).optional(),
  reason: z.string().optional(), errorCode: z.string().optional(),
  replacementOf: z.strictObject({ imageVersionId: id, errorCode: z.string(), reason: z.string() }).optional(),
  failedStep: z.enum(['downloading', 'planning', 'rendering', 'reviewing']).optional(),
})
/** Recoverable per-source state. */
export type WallpaperItem = z.infer<typeof wallpaperItemSchema>
/** Count corrective attempts. Local inspection, authorization to proceed, and rereading identical output do not remake pixels.
 * @param item Image with its retained revision history. @returns Reworks already reserved.
 */
export function wallpaperReworkCount(item: WallpaperItem): number {
  return item.attempts.filter((attempt, index) => {
    const prior = item.attempts[index - 1]
    if (!prior) return false
    if (attempt.retryTarget === 'reviewing' && attempt.outputId && attempt.outputId === prior.outputId) return false
    if (attempt.retryFrom === 'planning' && attempt.retryTarget === 'planning' && attempt.detailAnalysis?.outcome === 'resolved' && attempt.detailAnalysis.requestId === prior.detailAnalysis?.requestId) return false
    if (attempt.retryFrom === 'planning' && attempt.retryTarget === 'rendering' && item.decisions?.some(d => d.status === 'applied' && d.targetRevision === attempt.revision && d.response?.action.kind === 'continue_current_plan')) return false
    return true
  }).length
}
/** @param item Image checkpoint. @param settings Frozen task limits. @returns Whether a rejected output can enter corrective planning with its saved evidence. */
export function wallpaperReviewReworkAvailable(item: WallpaperItem, settings: WallpaperSettings): boolean {
  const attempt = item.attempts.at(-1), review = attempt?.review
  if (!item.originalId || item.status === 'passed' || !attempt?.outputId || attempt.checks.length || !review || wallpaperVerdict(review) !== 'reject' || !('subjectIntegrity' in review)) return false
  const { source, output, mode } = review.subjectIntegrity
  if (source.imageVersionId !== item.originalId || output.imageVersionId !== attempt.outputId || attempt.plan.imageVersionId !== item.originalId) return false
  if (source.extent !== 'complete' && !(source.extent === 'not-applicable' && (mode === 'abstract' || mode === 'scene') && !attempt.plan.regions.some(region => region.role === 'subject'))) return false
  if (attempt.generationOperation && !attempt.generation || attempt.detailAnalysis?.outcome === 'violated' || attempt.detailAnalysis?.protectedSubjectExtent === 'cut-off') return false
  if ('styleMatch' in review && review.checks.style.result !== 'satisfied' && Object.entries(review.checks).every(([key, check]) => key === 'style' || check.result === 'satisfied')) return false
  return wallpaperReworkCount(item) < settings.maxReworks && (!attempt.needsOutpaint || item.edits < settings.maxEditsPerImage)
}
/** One immutable input queue with mutable checkpoint progress owned by its Run. */
export const wallpaperStateSchema = z.strictObject({ version: z.union([z.literal(1), z.literal(2)]), sourceRunId: id, skillVersion: id, items: z.array(wallpaperItemSchema), budgetStopped: z.boolean().default(false) })
/** Parsed checkpoint used by Host execution and Client projections. */
export type WallpaperState = z.infer<typeof wallpaperStateSchema>
/** @param input Frozen continuation inputs. @returns The one image selected for continuation, review, recomposition, detail or decision; ordinary batches process their full queue. */
export function wallpaperWorkImage(input: Readonly<Record<string, Json>>): string | undefined {
  const value = input.continuationKind === 'rework' ? input.reworkedImageId : input.continuationKind === 'continue' && typeof input.retryImageId === 'string' ? input.retryImageId : input.continuationKind === 'continue' && typeof input.retryOriginalImageId === 'string' ? input.retryOriginalImageId : input.continuationKind === 'review' ? input.reviewedImageId : input.continuationKind === 'recompose' ? input.recomposedImageId : input.continuationKind === 'detail' ? input.inspectedImageId : input.continuationKind === 'decision' ? input.decidedImageId : undefined
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
  return value.workImageVersionId && value.workImageVersionId !== imageVersionId && ['created', 'running', 'pausing', 'cancelling'].includes(value.status) ? 'paused' : value.status
}
/** @param status Task lifecycle. @param total Frozen source count. @param passed Qualified source count. @returns Whether processing can be stopped, including a settled task retaining unfinished images. */
export function wallpaperCanCancel(status: RunRecord['status'], total: number, passed: number): boolean {
  return ['created', 'running', 'pausing', 'paused', 'interrupted'].includes(status) || ['completed', 'failed'].includes(status) && passed < total
}
/** Summarize committed per-image stages without projecting the whole Run as an active node.
 * @param state Saved queue and its latest attempts.
 * @param activeImageVersionId Optional explicit recovery target; other saved pending stages remain historical.
 * @param status Owning task lifecycle; unfinished inherited decisions are attention when no worker owns them.
 * @returns Stage activity, completed artifacts, failures and images blocked by upstream steps.
 */
export function wallpaperProgress(state: WallpaperState, activeImageVersionId?: string, status?: RunRecord['status']): Record<string, number> {
  const count = (matches: (item: WallpaperItem) => boolean) => state.items.filter(matches).length
  const ownsWork = (item: WallpaperItem) => (status === undefined || ['created', 'running', 'pausing', 'cancelling'].includes(status)) && (!activeImageVersionId || item.imageVersionId === activeImageVersionId)
  const parked = (item: WallpaperItem) => !ownsWork(item) && !!wallpaperPendingDecision(item)
  const stopped = (item: WallpaperItem) => ['rejected', 'needs-review', 'technical-failed'].includes(item.status) || parked(item)
  const planned = (item: WallpaperItem) => !!item.attempts.at(-1) && !item.attempts.at(-1)!.checks.length && item.attempts.at(-1)!.plan.mode !== 'uncertain'
  return {
    ...Object.fromEntries(['queued', 'downloading', 'planning', 'rendering', 'reviewing', 'passed', 'rejected', 'needs-review', 'technical-failed'].map(status => [status, count(item => item.status === status && (!['downloading', 'planning', 'rendering', 'reviewing'].includes(status) || ownsWork(item)))])),
    attention: status === 'cancelled' ? 0 : count(stopped),
    downloaded: count(item => !!item.originalId && wallpaperFailedStep(item) !== 'downloading'), downloadingFailed: count(item => wallpaperFailedStep(item) === 'downloading'), downloadingRestricted: count(wallpaperSourceRestricted), downloadingReplaced: count(item => !!item.replacementOf),
    downloadingRetrying: count(item => item.status === 'downloading' && item.download?.retrying === true),
    planned: count(planned), rendered: count(item => !!item.attempts.at(-1)?.outputId), reviewed: count(item => !!item.attempts.at(-1)?.review),
    planningFailed: count(item => wallpaperFailedStep(item) === 'planning' || !!item.attempts.at(-1)?.checks.length),
    renderingFailed: count(item => item.failedStep === 'rendering'),
    reviewingFailed: count(item => item.failedStep === 'reviewing' || !!item.attempts.at(-1)?.review && wallpaperVerdict(item.attempts.at(-1)!.review!) === 'reject'),
    planningAttention: count(item => item.status === 'needs-review' && (!planned(item) || item.attempts.at(-1)?.plan.mode === 'uncertain')),
    renderingAttention: count(item => item.status === 'needs-review' && planned(item) && item.attempts.at(-1)?.plan.mode !== 'uncertain' && !item.attempts.at(-1)?.outputId),
    reviewingAttention: count(item => item.status === 'needs-review' && !!item.attempts.at(-1)?.review && wallpaperVerdict(item.attempts.at(-1)!.review!) === 'needs-review'),
    planningBlocked: count(item => stopped(item) && (!item.originalId || wallpaperFailedStep(item) === 'downloading')),
    renderingBlocked: count(item => stopped(item) && (wallpaperFailedStep(item) === 'planning' || !planned(item) || item.attempts.at(-1)?.plan.mode === 'uncertain')),
    reviewingBlocked: count(item => stopped(item) && !item.attempts.at(-1)?.outputId),
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
  resources: z.record(z.string(), z.string()),
  sourceImages: z.record(z.string(), z.object({ width: z.number().int().positive(), height: z.number().int().positive(), previewPath: z.string() })),
  previewResources: z.record(z.string(), z.string()).default({}),
  workImageVersionId: id.optional(),
  downloads: z.record(z.string(), wallpaperDownloadProgressSchema).optional(),
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
  if ('subjectIntegrity' in review) checks.push(wallpaperSubjectCheck(review.subjectIntegrity).result)
  return checks.includes('violated') ? 'reject' : checks.includes('unknown') || 'styleMatch' in review && review.issues.some(issue => issue.kind !== 'style') ? 'needs-review' : 'pass'
}
