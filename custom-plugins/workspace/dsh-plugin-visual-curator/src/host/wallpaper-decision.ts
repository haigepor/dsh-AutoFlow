/** Bounded per-image routing uses saved evidence and existing processing stages without granting final approval. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ImageGenerationId, ImageGenerationTaskId, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { CuratorDomain } from '../domain/curator.ts'
import { contentDigest } from '../domain/repository.ts'
import type { VisionImage, VisionInput, VisionRule } from '../media/vision.ts'
import type { AssetFiles } from '../media/assets.ts'
import { wallpaperDecisionVisionSchema } from '../media/vision.ts'
import { wallpaperGeometry } from '../media/wallpaper-render.ts'
import { wallpaperPlanConcerns, wallpaperPlanDetailRect } from '../shared/wallpaper-detail.ts'
import { wallpaperPlanSchema, wallpaperSourceRestricted, wallpaperVerdict, wallpaperReworkCount, wallpaperEdgeRepairAuthorized, type WallpaperItem, type WallpaperSettings } from '../shared/wallpaper.ts'
import { wallpaperFindingBlocksEditing } from '../shared/wallpaper-evidence.ts'
import type { WallpaperDecisionActionKind, WallpaperDecisionConcern, WallpaperDecisionRecord, WallpaperDecisionResponse } from '../shared/wallpaper-decision.ts'
import type { CuratorRecord, ImageVersion } from '../shared/model.ts'
import { CuratorError } from '../shared/errors.ts'
import { safeFailure, toJson, type WorkContext } from './runtime.ts'

type Attempt = WallpaperItem['attempts'][number]
const rectSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
const snapshotSchema = z.object({ usage: z.json(), detailRects: z.array(rectSchema) })
const handleSchema = z.object({ id: z.string(), provider: z.string(), model: z.string(), taskId: z.string() })
const referenceErrors = new Set(['IMAGE_TOO_LARGE', 'ATTACHMENT_WRITE_FAILED'])
const reviewErrors = new Set(['vision-invalid-output', 'remote-timeout'])

/** The processing owner supplies persistence, model logging and the frozen source and task policy. */
export interface WallpaperDecisionDependencies {
  item: WallpaperItem
  source: ImageVersion
  original: VisionImage
  settings: WallpaperSettings
  prompt?: { version: 'wallpaper-decision-v1' | 'wallpaper-decision-v2'; text: string }
  taskBrief: string
  rules: readonly VisionRule[]
  supportsDetail: boolean
  maxImages: number
  ctx: WorkContext
  domain: CuratorDomain
  files: AssetFiles
  llm?: LlmRuntime
  /** Commit through the existing Run request owner and its unchanged budget. */
  commit(input: VisionInput, schema: (prepared: VisionInput) => z.ZodType<WallpaperDecisionResponse>): Promise<WallpaperDecisionResponse>
  /** Persist decisions before execution and retain all previous artifacts. */
  save(records?: CuratorRecord[]): Promise<void>
}

/** @param item Current saved image. @param attempt Current immutable plan revision. @returns Whether evidence-bound routing explicitly approved this revision for processing. */
export function wallpaperDecisionApproved(item: WallpaperItem, attempt: Attempt): boolean {
  return attempt.plan.imageVersionId === item.originalId && !!item.decisions?.some(record => {
    if (record.status !== 'applied' || record.response?.action.kind !== 'continue_current_plan') return false
    const approved = item.attempts.find(prior => prior.revision === record.targetRevision)
    // Receipt recomposition and review-only revisions retain the same source planning evidence.
    return !!approved && contentDigest(approved.plan) === contentDigest(attempt.plan) && contentDigest(approved.detailAnalysis ?? null) === contentDigest(attempt.detailAnalysis ?? null)
  })
}

/** @param item Current image. @param revision Latest saved plan revision. @returns A committed replan action not yet materialized as a new plan. */
export function wallpaperDecisionReplan(item: WallpaperItem, revision: number): WallpaperDecisionRecord | undefined {
  return item.decisions?.findLast(record => record.status === 'applied' && record.response?.action.kind === 'replan' && (record.targetRevision ?? 0) > revision)
}

function concernsFor(item: WallpaperItem, attempt: Attempt): WallpaperDecisionConcern[] {
  const detail = attempt.detailAnalysis
  const base = detail?.version === 'wallpaper-plan-detail-v5' && detail.concerns ? detail.concerns : wallpaperPlanConcerns(attempt.plan)
  const concerns: WallpaperDecisionConcern[] = base.map(concern => {
    const savedScope = detail?.findings?.find(finding => finding.concernId === concern.id)?.scope ?? item.decisions?.findLast(record => record.planRevision === attempt.revision && record.response?.findings.some(finding => finding.concernId === concern.id))?.response?.findings.find(finding => finding.concernId === concern.id)?.scope
    return savedScope ? { ...concern, scope: savedScope } : concern.id === 'protected-regions' ? { ...concern, scope: 'critical' as const } : concern
  })
  if (attempt.detailAnalysis?.outcome === 'violated') concerns.push({ id: 'source-violation', text: item.reason || 'Saved native source review established a source integrity violation.', scope: 'subject' })
  if (attempt.review) for (const [key, check] of Object.entries(attempt.review.checks)) if (check.result !== 'satisfied') concerns.push({ id: `review:${key}`, text: check.reason, scope: key === 'protection' ? 'critical' : ['background', 'clock', 'readability'].includes(key) ? 'background' : 'subject' })
  if (item.errorCode) concerns.push({ id: `technical:${item.failedStep ?? 'planning'}`, text: `${item.errorCode}: ${item.reason ?? 'Saved processing step failed.'}`, scope: 'technical' })
  if (!concerns.length) concerns.push({ id: 'processing-hold', text: item.reason || 'The saved image has an unresolved processing hold.' })
  return concerns
}

function editEvidenceFor(attempt: Attempt, settings: WallpaperSettings) {
  const detail = attempt.detailAnalysis
  if (detail?.version !== 'wallpaper-plan-detail-v5' || !detail.protectedSubjectExtent || !detail.findings) return {}
  return { editEvidence: { outcome: detail.outcome, sourceExtent: detail.protectedSubjectExtent, findings: detail.findings.map(({ result: _result, ...finding }) => finding), ...(wallpaperEdgeRepairAuthorized(attempt, settings) ? { edgeRepair: detail.edgeRepair } : {}) } }
}

/** Bind each critical concern to covering native views; an unlocalized concern requires all saved critical regions.
 * @param input Prepared decision input with Host-measured crop representations.
 * @returns The logged input retaining explicit crop restrictions and unresolved missing coverage.
 */
export function bindWallpaperDecisionEvidence(input: VisionInput): VisionInput {
  const usage = z.object({ decision: z.object({ concerns: z.array(z.object({ id: z.string(), text: z.string(), scope: z.string().optional(), detailImageVersionIds: z.array(z.string()).optional() }).passthrough()), plan: wallpaperPlanSchema, detailAnalysis: z.object({ findings: z.array(z.object({ concernId: z.string(), sourceRegion: rectSchema.optional() })).optional() }).nullable().optional() }).passthrough(), imageRepresentations: z.array(z.object({ imageVersionId: z.string(), sourceImageVersionId: z.string().optional(), sourceRect: rectSchema.optional() }).passthrough()) }).passthrough().parse(input.usage)
  const sourceId = input.images.find(image => image.role === 'wallpaper-original')!.imageVersionId
  const regions = usage.decision.plan.regions.filter(region => region.role === 'critical')
  return { ...input, usage: { ...usage, decision: { ...usage.decision, concerns: usage.decision.concerns.map(concern => {
    if (concern.scope !== 'critical' || concern.detailImageVersionIds !== undefined) return concern
    const observed = usage.decision.detailAnalysis?.findings?.find(finding => finding.concernId === concern.id)?.sourceRegion
    const required = observed ? [observed] : regions.map(region => region.rect)
    const covering = usage.imageRepresentations.filter(view => view.sourceImageVersionId === sourceId && view.sourceRect && input.images.some(image => image.imageVersionId === view.imageVersionId && image.role === 'wallpaper-original-detail-only') && required.length && required.every(region => region.x >= view.sourceRect!.x && region.y >= view.sourceRect!.y && region.x + region.width <= view.sourceRect!.x + view.sourceRect!.width && region.y + region.height <= view.sourceRect!.y + view.sourceRect!.height)).map(view => view.imageVersionId)
    return { ...concern, detailImageVersionIds: covering }
  }) } } }
}

function allowedFor(deps: WallpaperDecisionDependencies, attempt: Attempt): WallpaperDecisionActionKind[] {
  const { item, settings } = deps, actions: WallpaperDecisionActionKind[] = []
  const sourceBlocked = wallpaperSourceRestricted(item) || attempt.detailAnalysis?.outcome === 'violated' || attempt.review && 'subjectIntegrity' in attempt.review && attempt.review.subjectIntegrity.source.extent === 'cut-off' && !wallpaperEdgeRepairAuthorized(attempt, settings)
  if (!sourceBlocked) {
    const receipt = !!(attempt.generation || attempt.generationOperation)
    const planningHold = !attempt.outputId && !receipt && !item.errorCode
    if (planningHold) {
      if (attempt.plan.mode !== 'uncertain' && !attempt.checks.includes('source-outside-canvas') && !attempt.detailAnalysis?.findings?.some(wallpaperFindingBlocksEditing) && !(attempt.detailAnalysis?.protectedSubjectExtent === 'cut-off' && !wallpaperEdgeRepairAuthorized(attempt, settings)) && (attempt.detailAnalysis?.version !== 'wallpaper-plan-detail-v5' || ['resolved', 'ready-for-edit'].includes(attempt.detailAnalysis.outcome)) && !wallpaperGeometry(deps.source.geometry, { ...attempt.plan, uncertainties: [] }, settings).checks.length) actions.push('continue_current_plan')
      const extraDetails = item.decisions?.filter(record => record.detailRect).length ?? 0
      if (deps.supportsDetail && deps.maxImages >= 2 && wallpaperPlanConcerns(attempt.plan).length && extraDetails < (settings.decision?.maxDetailRequests ?? 0)) actions.push('inspect_region')
    }
    if (!attempt.outputId && !receipt && wallpaperReworkCount(item) < settings.maxReworks && (!attempt.needsOutpaint || item.edits < settings.maxEditsPerImage) && (!item.errorCode || item.failedStep === 'planning')) actions.push('replan')
    if (!attempt.outputId && item.failedStep === 'rendering' && item.errorCode && referenceErrors.has(item.errorCode) && !attempt.generation && !attempt.generationInput) actions.push('retry_reference_preparation')
    if (!attempt.outputId && receipt && deps.llm) actions.push('query_saved_generation')
    if (attempt.generation && attempt.needsOutpaint && !attempt.outputId && !attempt.checks.length && item.failedStep === 'rendering' && wallpaperReworkCount(item) < settings.maxReworks) {
      if (item.errorCode !== 'image-resolution-insufficient') actions.push('recompose_saved_background')
      if (settings.backgroundResolution?.enabled && attempt.compositionMode === 'protected-context-v2' && attempt.generationInput) actions.push('reconstruct_saved_background')
    }
    if (attempt.outputId && !attempt.review && item.failedStep === 'reviewing' && item.errorCode && reviewErrors.has(item.errorCode)) actions.push('retry_saved_review')
    if (attempt.review && wallpaperVerdict(attempt.review) === 'reject' && wallpaperReworkCount(item) < settings.maxReworks && (!attempt.needsOutpaint || item.edits < settings.maxEditsPerImage)) actions.push('replan')
  }
  return [...new Set([...actions, 'skip_image', 'manual_review'] as WallpaperDecisionActionKind[])]
}

function resetFailure(item: WallpaperItem) { delete item.errorCode; delete item.reason; delete item.failedStep }
type SourceRect = NonNullable<WallpaperDecisionRecord['detailRect']>
function sameSourcePixels(a: SourceRect, b: SourceRect, source: ImageVersion): boolean {
  const { width, height } = source.geometry
  return Math.floor(a.x * width) === Math.floor(b.x * width) && Math.floor(a.y * height) === Math.floor(b.y * height) && Math.ceil((a.x + a.width) * width) === Math.ceil((b.x + b.width) * width) && Math.ceil((a.y + a.height) * height) === Math.ceil((b.y + b.height) * height)
}
async function queueInspection(deps: WallpaperDecisionDependencies, attempt: Attempt, record: WallpaperDecisionRecord, rect: SourceRect): Promise<boolean> {
  record.detailRect = rect
  record.targetStage = 'detail'
  deps.item.detailInspection = { origin: 'decision', status: 'queued', planRevision: attempt.revision, requestId: record.id + ':detail', decisionId: record.id, decisionRoundAtStart: deps.item.decisions?.length ?? 0, rect, reason: record.reason }
  deps.item.status = 'planning'
  await deps.save()
  return true
}
async function inspectPlanningHold(deps: WallpaperDecisionDependencies, attempt: Attempt, record?: WallpaperDecisionRecord): Promise<boolean> {
  const { item, source, settings } = deps, detail = attempt.detailAnalysis
  if (!record || !['manual', 'failed'].includes(record.status) || record.planRevision !== attempt.revision || record.detailRect || record.sourceStage !== 'planning' || !detail ||
      !deps.supportsDetail || deps.maxImages < 2 || (item.decisions?.filter(row => row.detailRect).length ?? 0) >= (settings.decision?.maxDetailRequests ?? 0) ||
      attempt.outputId || attempt.review || attempt.generation || attempt.generationInput || attempt.generationOperation || item.errorCode || wallpaperSourceRestricted(item) || !wallpaperPlanConcerns(attempt.plan).length) return false
  const nativeRect = wallpaperPlanDetailRect(attempt.plan)
  if (!nativeRect || item.attempts.some(prior => prior.detailAnalysis?.protectedSubjectExtent === 'cut-off' || prior.review && 'subjectIntegrity' in prior.review && prior.review.subjectIntegrity.source.extent === 'cut-off') ||
      item.decisions?.some(prior => prior.planRevision === attempt.revision && prior.response?.sourceExtent.extent === 'cut-off')) return false
  const legacyViolation = (detail.version === 'wallpaper-plan-detail-v1' || detail.version === 'wallpaper-plan-detail-v2') && detail.outcome === 'violated'
  if (!legacyViolation && detail.outcome !== 'unresolved') return false
  // A legacy image-wide violation can be reclassified once by the subject-scoped protocol.
  // With current evidence, inspect only a newly localized blocking region.
  const rect = legacyViolation ? nativeRect : record.response?.findings.find(f => f.blocking && f.sourceRegion && !sameSourcePixels(f.sourceRegion, nativeRect, source))?.sourceRegion
  if (!rect || item.decisions?.some(row => row.detailRect && sameSourcePixels(row.detailRect, rect, source))) return false
  return await queueInspection(deps, attempt, record, rect)
}
function cloneFor(attempt: Attempt, item: WallpaperItem, stage: 'rendering' | 'reviewing'): Attempt {
  const next = { ...structuredClone(attempt), revision: (item.attempts.at(-1)?.revision ?? 0) + 1, createdAt: new Date().toISOString(), retryFrom: 'reviewing' as const, retryTarget: stage }
  delete next.review; delete next.reviewedAt
  if (stage === 'rendering') { delete next.outputId; delete next.analysisId; delete next.simulationId; delete next.clarity; delete next.clarityBaseReview }
  item.attempts.push(next)
  return next
}

/** Route one held image with bounded model decisions and Host-validated effects.
 * @param deps Frozen source, task and existing processing owners.
 * @returns True when the existing image worker must resume; false for a visible exception or an unchanged legacy policy.
 */
export async function executeWallpaperDecision(deps: WallpaperDecisionDependencies): Promise<boolean> {
  const { item, settings, prompt, ctx, source } = deps, policy = settings.decision
  if (!policy?.enabled || !prompt || !item.originalId || item.status === 'passed') return false
  const attempt = item.attempts.at(-1)
  if (!attempt) return false
  const history = item.decisions ??= []
  for (;;) {
    ctx.signal.throwIfAborted()
    const pending = history.findLast(record => record.status === 'running')
    if (!pending && history.length >= policy.maxRoundsPerImage) {
      if (await inspectPlanningHold(deps, attempt, history.at(-1))) return true
      item.status = 'needs-review'; item.reason = 'decision-round-limit'; await deps.save(); return false
    }
    const sourceStage = pending?.sourceStage ?? (item.failedStep === 'rendering' || item.failedStep === 'reviewing' ? item.failedStep : attempt.outputId ? 'reviewing' : item.status === 'rendering' ? 'rendering' : 'planning')
    const concerns = concernsFor(item, attempt), allowedActions = allowedFor(deps, attempt)
    const nativeRect = wallpaperPlanDetailRect(attempt.plan)
    const detailRects = deps.supportsDetail ? [...history.flatMap(record => record.detailRect ? [record.detailRect] : []).reverse(), ...(nativeRect ? [nativeRect] : [])] : []
    const uniqueRects = detailRects.filter((rect, index) => detailRects.findIndex(other => contentDigest(other) === contentDigest(rect)) === index)
    const output = attempt.outputId ? deps.domain.require('imageVersion', attempt.outputId) : undefined
    const admittedRects = uniqueRects.slice(0, Math.max(0, deps.maxImages - (output ? 2 : 1)))
    const evidence = { source: source.blob.digest, placement: attempt.plan.placement, regions: attempt.plan.regions, checks: attempt.checks, concernIds: concerns.map(concern => concern.id), output: output?.blob.digest, generation: attempt.generation?.id ?? attempt.generationOperation, errorCode: item.errorCode, detailRects: admittedRects }
    const evidenceDigest = contentDigest(evidence).slice(10)
    const snapshot = pending?.input ? snapshotSchema.parse(pending.input) : { detailRects: admittedRects, usage: toJson({ decision: { planRevision: attempt.revision, concerns, allowedActions, context: { mode: attempt.plan.mode, hasProtectedSubject: attempt.plan.regions.some(region => region.role === 'subject') || ['single', 'group', 'uncertain'].includes(attempt.plan.mode), ...editEvidenceFor(attempt, settings) }, remaining: { rounds: policy.maxRoundsPerImage - history.length, details: policy.maxDetailRequests - history.filter(record => record.detailRect).length, edits: settings.maxEditsPerImage - item.edits, reworks: Math.max(0, settings.maxReworks - wallpaperReworkCount(item)) }, priorDecisions: history.map(record => ({ round: record.round, status: record.status, action: record.response?.action, evidenceDigest: record.evidenceDigest, reason: record.reason })), stage: sourceStage, errorCode: item.errorCode, reason: item.reason, detailAnalysis: attempt.detailAnalysis, plan: attempt.plan, review: attempt.review, receipts: { generation: attempt.generation, operation: attempt.generationOperation, generationInput: attempt.generationInput, backgroundResolution: attempt.backgroundResolution }, sourceGeometry: source.geometry, settings } }) }
    const record: WallpaperDecisionRecord = pending ?? { id: `${ctx.runId}:${item.imageVersionId}:decision:${history.length + 1}`, version: prompt.version, planRevision: attempt.revision, round: history.length + 1, status: 'running', reason: item.reason || 'processing-decision', sourceStage, evidenceDigest, inputDigest: contentDigest(snapshot).slice(10), input: toJson(snapshot), targetStage: 'decision' }
    if (!pending) history.push(record)
    item.status = 'planning'; await deps.save()
    try {
      if (record.planRevision !== attempt.revision || contentDigest(snapshot).slice(10) !== record.inputDigest) throw new CuratorError('reference-unavailable', 'wallpaper-decision', 'The saved decision input no longer matches this plan revision. Keep its history for reconciliation.')
      const images: VisionImage[] = [deps.original]
      if (output) images.push({ imageVersionId: output.id, digest: output.blob.digest, mime: output.blob.mime, bytes: await deps.files.read(output.blob, ctx.signal), role: 'actual-wallpaper' })
      const input: VisionInput = { wallpaperPrompt: prompt, requestId: record.id, taskBrief: deps.taskBrief, rules: deps.rules, images, detailRegions: snapshot.detailRects.map(rect => ({ imageVersionId: source.id, rect })), usage: snapshot.usage, ...(policy.reasoningEffort ? { reasoningEffort: policy.reasoningEffort } : {}) }
      const response = await deps.commit(input, wallpaperDecisionVisionSchema)
      record.response = response
      if (response.imageVersionId !== source.id || response.planRevision !== attempt.revision || !allowedActions.includes(response.action.kind)) throw new CuratorError('constraint-conflict', 'wallpaper-decision', 'The selected decision is unavailable for this image and its remaining limits. Saved evidence is retained.')
      if (history.slice(0, -1).some(prior => prior.evidenceDigest === record.evidenceDigest && prior.response && contentDigest(prior.response.action) === contentDigest(response.action))) {
        record.status = 'manual'; record.errorCode = 'decision-no-progress'; record.reason = 'decision-no-progress'; item.status = 'needs-review'; item.reason = record.reason; await deps.save(); return false
      }
      record.reason = response.reason
      const action = response.action
      // Durable selection precedes every execution, including local composition and receipt queries.
      await deps.save()
      record.status = 'applied'
      switch (action.kind) {
        case 'continue_current_plan': {
          const plan = wallpaperPlanSchema.parse({ ...attempt.plan, uncertainties: [] }), geometry = wallpaperGeometry(source.geometry, plan, settings)
          if (geometry.checks.length) throw new CuratorError('constraint-conflict', 'wallpaper-decision', 'The protected source regions do not fit the frozen wallpaper template.')
          const next: Attempt = { revision: attempt.revision + 1, createdAt: new Date().toISOString(), plan, checks: geometry.checks, needsOutpaint: geometry.needsOutpaint, compositionMode: attempt.compositionMode, detailAnalysis: attempt.detailAnalysis, retryFrom: 'planning', retryTarget: 'rendering', ...(attempt.clarity ? { clarity: { status: 'pending', reason: '' } } : {}) }
          item.attempts.push(next); record.targetRevision = next.revision; record.targetStage = 'rendering'; item.status = 'rendering'; resetFailure(item); await deps.save(); return true
        }
        case 'inspect_region': {
          if (uniqueRects.some(rect => sameSourcePixels(rect, action.rect, source))) { record.status = 'manual'; record.errorCode = 'decision-detail-repeat'; record.reason = 'decision-detail-repeat'; item.status = 'needs-review'; item.reason = record.reason; await deps.save(); return false }
          return await queueInspection(deps, attempt, record, action.rect)
        }
        case 'replan':
          record.targetRevision = attempt.revision + 1; record.targetStage = 'planning'; item.status = 'planning'; resetFailure(item); await deps.save(); return true
        case 'retry_reference_preparation':
          record.targetRevision = attempt.revision; record.targetStage = 'rendering'; item.status = 'rendering'; resetFailure(item); await deps.save(); return true
        case 'query_saved_generation': {
          const llm = deps.llm!, saved = attempt.generation
          const identity = saved ? { ...saved, id: brandString<ImageGenerationId>(saved.id), taskId: brandString<ImageGenerationTaskId>(saved.taskId) } : { id: brandString<ImageGenerationId>(attempt.generationOperation!), provider: settings.imageProvider, model: settings.imageModel }
          const task = await llm.getImageGeneration(identity, { waitMs: 0, signal: ctx.signal })
          if (task.state === 'failed' || task.state === 'cancelled' || task.state === 'outcome-unknown') { record.status = 'manual'; record.reason = `decision-generation-${task.state}`; item.status = 'needs-review'; item.reason = record.reason; await deps.save(); return false }
          attempt.generation = handleSchema.parse(task); record.targetRevision = attempt.revision; record.targetStage = 'rendering'; item.status = 'rendering'; resetFailure(item); await deps.save(); return true
        }
        case 'recompose_saved_background':
        case 'reconstruct_saved_background': {
          const next = cloneFor(attempt, item, 'rendering')
          record.targetRevision = next.revision; record.targetStage = 'rendering'; item.status = 'rendering'; resetFailure(item); await deps.save(); return true
        }
        case 'retry_saved_review': {
          const next = cloneFor(attempt, item, 'reviewing')
          record.targetRevision = next.revision; record.targetStage = 'reviewing'; item.status = 'reviewing'; resetFailure(item); await deps.save(); return true
        }
        case 'skip_image':
        case 'manual_review':
          record.status = action.kind === 'skip_image' ? 'skipped' : 'manual'; record.targetStage = 'decision'; item.status = 'needs-review'; item.reason = response.reason
          if (action.kind === 'manual_review' && await inspectPlanningHold(deps, attempt, record)) return true
          await deps.save(); return false
      }
    } catch (error) {
      // Pause resumes the last atomic checkpoint, including an uncommitted decision round.
      if (ctx.signal.aborted) throw error
      const failure = safeFailure(error)
      record.status = 'failed'; record.errorCode = failure.code; record.reason = failure.safeMessage
      if (failure.code === 'budget-exhausted') { await deps.save(); throw error }
      if (await inspectPlanningHold(deps, attempt, record)) return true
      item.status = 'needs-review'; item.reason ||= failure.safeMessage; await deps.save(); return false
    }
  }
}
