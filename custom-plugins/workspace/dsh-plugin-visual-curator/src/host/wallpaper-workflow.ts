/** Profile-owned wallpaper batches freeze qualified sources and persist every layout, edit receipt and review. */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ImageGenerationHandle, ImageGenerationId, ImageGenerationTask, ImageGenerationTaskId, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { isAttachmentError, type AttachmentStore, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { CuratorDomain } from '../domain/curator.ts'
import { contentDigest } from '../domain/repository.ts'
import type { AssetFiles, StructuredVisionProvider, VisionImage, VisionInput, HttpClient, ImageSourceProvider } from '../media/index.ts'
import { MediaError } from '../media/index.ts'
import { recoverWallpaperSources } from './wallpaper-source-recovery.ts'
import { bindWallpaperDecisionEvidence, executeWallpaperDecision, wallpaperDecisionApproved, wallpaperDecisionReplan } from './wallpaper-decision.ts'
import { wallpaperDecisionSettingsSchema } from '../shared/wallpaper-decision.ts'
import { wallpaperCanvasReviewPromptV4 } from '../shared/wallpaper-edit-prompts.ts'
import { resolveWallpaperProcessing, wallpaperProcessingSchema, wallpaperGenerativeRepair, wallpaperRepairInstructions } from '../shared/wallpaper-policy.ts'
import { wallpaperPromptPreparationPolicySchema, wallpaperGenerationBriefOutputSchema, wallpaperGenerationBriefPrompt } from '../shared/wallpaper-generation-brief.ts'
import { wallpaperPlanDetailPrompt } from '../shared/wallpaper-prompts.ts'
import { retainWallpaperRegions, wallpaperPlanConcerns, wallpaperPlanDetailRect, wallpaperPlanDetailOutputSchema, resolveWallpaperPlanDetail } from '../shared/wallpaper-detail.ts'
import { wallpaperVisionInput } from './wallpaper-vision.ts'
import { findWallpaperResponse } from './wallpaper-requests.ts'
import { enhanceWallpaper } from '../media/clarity.ts'
import { type ResolutionProgress } from '../shared/clarity.ts'
import { claritySettingsSchema } from '../shared/clarity.ts'
import { backgroundResolutionSettingsSchema, legacyRealEsrganWeightsDigest } from '../shared/background-resolution.ts'
import { superResolveWallpaperBackground } from '../media/background-resolution.ts'
import { espcnWeightsDigest } from '../shared/clarity.ts'
import { applyWallpaperEspcn } from '../shared/wallpaper.ts'
import { renderWallpaper, wallpaperGeometry, wallpaperOverlays, wallpaperSourceSeams } from '../media/wallpaper-render.ts'
import { wallpaperGenerationReferences, wallpaperGenerationPrompt } from '../media/wallpaper-generation.ts'
import { wallpaperClockContrast } from '../media/wallpaper-clock.ts'
import { wallpaperRepairMask, wallpaperSourceRepairNeeded } from '../media/wallpaper-repair.ts'
import { wallpaperGenerationAlignment } from '../media/wallpaper-alignment.ts'
import { wallpaperNativeDetails } from '../media/vision.ts'
import { applyWallpaperConcurrency, wallpaperHasBackgroundAnchors, wallpaperSubjectRepairAuthorized } from '../shared/wallpaper.ts'
import { legacyManualInspection, wallpaperBatch, wallpaperAcceptsWork, wallpaperRunState } from './wallpaper-state.ts'
import { WallpaperDownloads } from './wallpaper-downloads.ts'
import { wallpaperPromptBundle, sourceFaithfulWallpaperPrompts } from '../shared/wallpaper-prompts.ts'
import { applyWallpaperRecoveryLimits, wallpaperEditingRetry, wallpaperPendingDecision, wallpaperWorkImage, wallpaperPromptBundleSchema, wallpaperSettingsSchema, wallpaperPlanSchema, wallpaperObservationPlanSchema, wallpaperRepairObservationPlanSchema, wallpaperReviewOutputSchema, wallpaperStoredReviewSchema, wallpaperStoredSourceReviewV4Schema, wallpaperCompositionModeSchema, wallpaperGenerationInputSchema, wallpaperStateSchema, wallpaperProgress, wallpaperDownloadProgress, wallpaperReviewReworkAvailable, wallpaperReworkCount, wallpaperStartSchema, wallpaperVerdict, wallpaperBackgroundReview, wallpaperSourceRestricted, wallpaperFailedStep, type WallpaperSettings, type WallpaperPlan, type WallpaperItem, type WallpaperExperience, type WallpaperState, type WallpaperView } from '../shared/wallpaper.ts'
import { blobRefSchema, imageVersionSchema, styleStandardSchema, assessmentSchema, selectionSchema, type CuratorRecord, type DomainActor, type ImageVersion, type Json, type RunRecord } from '../shared/model.ts'
import { CuratorError } from '../shared/errors.ts'
import { resolveCurrentConfig, type CuratorConfig } from './config.ts'
import { RunEngine, dataOf, executionSchema, specOf, toJson, safeFailure, type Worker, type WorkContext } from './runtime.ts'
import { originalRequestBounds, requestBounds, sourceIdentity, visionBounds } from './providers.ts'
import { executionStandard } from './style-execution.ts'
import { styleReviewBrief } from './review.ts'
import { applyWallpaperClockContrast, applyWallpaperNoClockRequirement, applyWallpaperSourceSeams, wallpaperSubjectRejection, wallpaperReviewVersion, wallpaperStylePolicy, applyWallpaperStyleReview, applyWallpaperSourceReview, wallpaperCriticalReviewTargets, wallpaperCriticalReviewFocus, wallpaperCriticalReviewHistory, applyWallpaperCriticalDetail } from './wallpaper-review.ts'
import { wallpaperProtectedBounds, fitWallpaperPlacement, wallpaperObjectProtectionRegions } from '../shared/wallpaper-geometry.ts'

/** Existing native capabilities and domain storage are the only dispatch and persistence owners. */
export interface WallpaperDependencies {
  domain: CuratorDomain; files: AssetFiles; engine: RunEngine; config(): CuratorConfig
  vision(config: CuratorConfig): Promise<StructuredVisionProvider>
  source(config: CuratorConfig): Promise<ImageSourceProvider>; media(config: CuratorConfig): HttpClient
  llm?: LlmRuntime; attachments?: AttachmentStore
  approved?(run: RunRecord, imageVersionId: string): Promise<void>
  skill(): { id: string; content: string }
}

const pending = (item: WallpaperItem) => ['queued', 'downloading', 'planning', 'rendering', 'reviewing'].includes(item.status)
const handleSchema = z.object({ id: z.string(), provider: z.string(), model: z.string(), taskId: z.string() })
/**
 * @param run Saved task.
 * @returns Whether its discriminator selects the wallpaper worker.
 */
export function isWallpaperRun(run: RunRecord): boolean { return ['wallpaper-v1', 'wallpaper-direct-v1'].includes(String(specOf(run).input.workflow)) }

/** Fixed-step batch execution, independent of whether its canvas is open. */
export class WallpaperWorkflows {
  private admissions: Promise<void> = Promise.resolve()
  private readonly downloads = new WallpaperDownloads()
  private readonly enhancements = new Map<string, { revision: number; step: 'background' | 'subject'; progress: ResolutionProgress }>()
  constructor(private readonly deps: WallpaperDependencies) {}

  private async trackEnhancement<T>(runId: string, imageId: string, revision: number, step: 'background' | 'subject', work: (progress: (value: ResolutionProgress) => void) => Promise<T>): Promise<T> {
    const key = `${runId}:${imageId}`, entry = { revision, step, progress: { completed: 0, total: 0, unit: 'percent' as ResolutionProgress['unit'] } }
    this.enhancements.set(key, entry)
    try { return await work(progress => { entry.progress = progress }) }
    finally { if (this.enhancements.get(key) === entry) this.enhancements.delete(key) }
  }

  /** Accept every qualified source in one completed batch exactly once.
   * @param raw Human or already-authorized automatic admission.
   * @param actor Authenticated profile owner.
   * @returns Accepted task receipt.
   */
  start(raw: unknown, actor: DomainActor): Promise<{ runId: string }> {
    const work = this.admissions.then(() => this.startNow(raw, actor)); this.admissions = work.then(() => {}, () => {}); return work
  }
  private async startNow(raw: unknown, actor: DomainActor): Promise<{ runId: string }> {
    const input = wallpaperStartSchema.parse(raw), source = this.deps.domain.require('run', input.sourceRunId), original = specOf(source)
    if (actor.kind !== 'human' || actor.profileId !== source.profileId || original.kind !== 'search' || source.status !== 'completed') throw new CuratorError('owner-denied', 'wallpaper-start', 'Choose a completed authorized image-search batch.')
    const reader: DomainActor = { ...actor, ...(source.owner.kind === 'session' ? { sessionId: source.owner.sessionId } : {}) }
    this.deps.engine.get(source.id, reader)
    const images = [...new Set(this.deps.domain.repository.list('selection').filter(row => row.runId === source.id && row.qualification === 'auto-qualified').sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id)).map(row => row.imageVersionId))]
    if (!images.length) throw new CuratorError('invalid-input', 'wallpaper-start', 'This batch has no qualified source images.')
    for (const id of images) this.deps.domain.authorizedImage(id, reader)
    const existing = this.deps.domain.repository.list('run').find(run => isWallpaperRun(run) && specOf(run).input.operationId === input.operationId)
    if (existing) {
      const fixed = specOf(existing)
      if (fixed.input.sourceRunId !== input.sourceRunId || input.settings && contentDigest(input.settings) !== contentDigest(fixed.fixed.wallpaperRequested ?? fixed.fixed.wallpaper)) throw new CuratorError('operation-conflict', 'wallpaper-start', 'This operation was accepted with different wallpaper inputs.')
      return { runId: existing.id }
    }
    const defaults = original.fixed.wallpaperAuto === true && !input.settings ? original.config : this.deps.config()
    const requestedSettings = input.settings ?? defaults.wallpaper
    const settings = { ...requestedSettings, decision: requestedSettings.decision ?? wallpaperDecisionSettingsSchema.parse({}), clarity: requestedSettings.clarity ?? claritySettingsSchema.parse({}), backgroundResolution: requestedSettings.backgroundResolution ?? backgroundResolutionSettingsSchema.parse({}), processing: resolveWallpaperProcessing(requestedSettings.processing) }, skill = this.deps.skill(), config = { ...defaults, source: original.config.source }
    applyWallpaperConcurrency(settings); applyWallpaperEspcn(settings)
    let imageModel = settings.imageModel
    if (!imageModel && this.deps.llm && typeof this.deps.llm.listImageModels === 'function') {
      try { imageModel = (await this.deps.llm.listImageModels(settings.imageProvider))[0]?.id ?? '' }
      catch (error) { /* Pure crops remain available when the optional image route is absent. */ }
    }
    const prompts = wallpaperPromptBundle()
    const fixed = { reviewOrder: 'generation-before-resolution-v1', generationPrompt: toJson(wallpaperGenerationBriefPrompt), generationPromptPolicy: toJson(wallpaperPromptPreparationPolicySchema.parse(config.vision.wallpaperPromptPreparation ?? {})), prompts: toJson(prompts), promptDigest: contentDigest(prompts), release: original.fixed.release, ...(original.fixed.executionRecipe ? { executionRecipe: original.fixed.executionRecipe } : {}), wallpaperRequested: toJson(requestedSettings), wallpaper: toJson({ ...settings, imageModel }), skill: toJson(skill), sourceSessionId: source.owner.kind === 'session' ? source.owner.sessionId : null }
    const unfinished = this.deps.domain.repository.list('run').find(run => isWallpaperRun(run) && ['created', 'running', 'pausing', 'paused', 'interrupted', 'cancelling'].includes(run.status) && specOf(run).input.sourceRunId === source.id && contentDigest(specOf(run).fixed.wallpaper) === contentDigest(fixed.wallpaper) && contentDigest(specOf(run).config) === contentDigest(config))
    if (unfinished) return { runId: unfinished.id }
    const normalized = { workflow: 'wallpaper-v1', operationId: input.operationId, sourceRunId: source.id, imageVersionIds: images, taskBrief: original.input.taskBrief ?? '', targetCount: images.length }
    const spec = executionSchema.parse({ kind: 'crop', config, input: normalized, fixed, specDigest: contentDigest({ kind: 'crop', config, input: normalized, fixed }) })
    const run = await this.deps.engine.create(spec, { kind: 'human', id: actor.id, profileId: actor.profileId }, this.worker(), input.operationId)
    return { runId: run.id }
  }

  /** Read one authorized page without granting another Session or dispatching work.
   * @param sourceRunId Qualified source batch.
   * @param actor Authenticated profile owner.
   * @param offset First image index.
   * @param size Page bound.
   * @param token Existing source-Session resource grant.
   * @param requestedRunId Optional exact wallpaper task; it must belong to the requested source.
   * @returns Current or explicitly selected task page, or no accepted wallpaper task.
   */
  read(sourceRunId: string, actor: DomainActor, offset: number, size: number, token?: string, requestedRunId?: string): WallpaperView | null {
    return this.deps.domain.repository.readSnapshot(() => this.readPage(sourceRunId, actor, offset, size, token, requestedRunId))
  }

  private readPage(sourceRunId: string, actor: DomainActor, offset: number, size: number, token?: string, requestedRunId?: string): WallpaperView | null {
    const source = this.deps.domain.require('run', sourceRunId)
    this.deps.engine.get(sourceRunId, { ...actor, ...(source.owner.kind === 'session' ? { sessionId: source.owner.sessionId } : {}) })
    const selected = requestedRunId ? this.deps.engine.get(requestedRunId, actor) : this.deps.domain.repository.list('run').find(run => isWallpaperRun(run) && specOf(run).input.sourceRunId === sourceRunId)
    const run = selected && (requestedRunId ? selected : wallpaperBatch(this.deps.domain, selected).current)
    if (!run) return null
    if (!isWallpaperRun(run) || specOf(run).input.sourceRunId !== sourceRunId) throw new CuratorError('owner-denied', 'wallpaper-read', 'This wallpaper task does not belong to the requested source batch.')
    this.deps.engine.get(run.id, actor)
    const spec = specOf(run), saved = this.state(run), items = saved.items.slice(offset, offset + size), resources: Record<string, string> = {}, previewResources: Record<string, string> = {}, artifactTimes: Record<string, string> = {}
    const sourceImages: WallpaperView['sourceImages'] = {}
    let previews: Map<string, ImageVersion> | undefined
    for (const item of items) {
      if (!item.detailInspection && spec.input.continuationKind === 'detail' && spec.input.inspectedImageId === item.imageVersionId) {
        const inspection = legacyManualInspection(this.deps.domain, run, item)
        if (inspection) item.detailInspection = inspection
      }
      const ids = [item.originalId, ...item.attempts.flatMap(attempt => [attempt.canvasId, attempt.opaqueCanvasId, attempt.layoutAnalysisId, attempt.analysisId, attempt.simulationId, attempt.outputId, attempt.generatedImageId, attempt.preResolutionReview?.nativeId, attempt.preResolutionReview?.previewId, attempt.preResolutionReview?.simulationId, attempt.clarity?.originalOutputId, attempt.clarity?.enhancedOutputId, attempt.backgroundResolution?.originalId, attempt.backgroundResolution?.enhancedId])]
      for (const id of ids) if (id) {
        resources[id] = `/api/visual-curator/resource?${new URLSearchParams({ imageVersionId: id, ...(token ? { sessionToken: token } : {}) })}`
        const image = this.deps.domain.require('imageVersion', id), preview = this.deps.domain.repository.get('imageVersion', `${id}:preview`)
        artifactTimes[id] = image.createdAt
        if (preview?.assetId === image.assetId) previewResources[id] = `/api/visual-curator/resource?${new URLSearchParams({ imageVersionId: preview.id, ...(token ? { sessionToken: token } : {}) })}`
        else previewResources[id] = `/api/visual-curator/resource?${new URLSearchParams({ imageVersionId: id, preview: 'thumbnail', ...(token ? { sessionToken: token } : {}) })}`
      }
      if (item.originalId) {
        const original = this.deps.domain.require('imageVersion', item.originalId)
        previews ??= new Map(this.deps.domain.repository.list('imageVersion').flatMap(image => image.versionKind === 'preview' && image.parentImageVersionId && !image.processing?.requestedRect ? [[image.parentImageVersionId, image] as const] : []))
        const preview = previews.get(original.id)
        const previewId = preview?.assetId === original.assetId ? preview.id : original.id
        sourceImages[original.id] = { width: original.geometry.width, height: original.geometry.height, previewPath: `/api/visual-curator/resource?${new URLSearchParams({ imageVersionId: previewId, ...(previewId === original.id ? { preview: 'thumbnail' } : {}), ...(token ? { sessionToken: token } : {}) })}` }
      }
    }
    previews ??= new Map(this.deps.domain.repository.list('imageVersion').flatMap(image => image.versionKind === 'preview' && image.parentImageVersionId && !image.processing?.requestedRect ? [[image.parentImageVersionId, image] as const] : []))
    const enhancements = items.flatMap(item => { const progress = this.enhancements.get(`${run.id}:${item.imageVersionId}`); return progress ? [[item.imageVersionId, progress] as const] : [] })
    return { runId: run.id, sourceRunId: source.id, status: run.status, ...(wallpaperWorkImage(spec.input) ? { workImageVersionId: wallpaperWorkImage(spec.input) } : {}), settings: wallpaperSettingsSchema.parse(spec.fixed.wallpaper), ...(enhancements.length ? { enhancements: Object.fromEntries(enhancements) } : {}), state: { ...saved, items }, resources, previewResources, artifactTimes, sourceImages,
      itemIndex: saved.items.map(item => {
        const image = this.deps.domain.repository.get('imageVersion', item.originalId ?? item.imageVersionId), preview = previews.get(item.originalId ?? item.imageVersionId)
        const sourceImage = this.deps.domain.repository.get('imageVersion', item.imageVersionId)
        const thumbnail = preview && preview.assetId === image?.assetId ? preview : sourceImage?.blob.remoteSource ? sourceImage : image
        return { imageVersionId: item.imageVersionId, status: item.status, ...(item.failedStep ? { failedStep: item.failedStep } : {}), planned: !!item.attempts.at(-1) && !item.attempts.at(-1)!.checks.length && item.attempts.at(-1)!.plan.mode !== 'uncertain', ...(thumbnail ? { previewPath: `/api/visual-curator/resource?${new URLSearchParams({ imageVersionId: thumbnail.id, ...(thumbnail.blob.remoteSource || thumbnail.versionKind !== 'preview' ? { preview: 'thumbnail' } : {}), ...(token ? { sessionToken: token } : {}) })}` } : {}) }
      }),
      downloads: Object.fromEntries(saved.items.map(item => [item.imageVersionId, wallpaperDownloadProgress(item, run.status, this.downloads.read(run.id, item.imageVersionId))])),
      total: saved.items.length, offset, warnings: dataOf(run).warnings, ...(dataOf(run).error ? { errorCode: dataOf(run).error!.code } : {}), counts: wallpaperProgress(saved, wallpaperWorkImage(spec.input), run.status) }
  }

  /** Build a new plan revision while preserving the source batch and previous artifacts.
   * @param raw Paused task, image and replacement plan.
   * @param actor Authenticated owner.
   * @returns Newly accepted task receipt.
   */
  replan(raw: unknown, actor: DomainActor): Promise<{ runId: string }> {
    const work = this.admissions.then(() => this.replanNow(raw, actor)); this.admissions = work.then(() => {}, () => {}); return work
  }
  private async replanNow(raw: unknown, actor: DomainActor) {
    const input = z.strictObject({ runId: z.string(), imageVersionId: z.string(), plan: wallpaperPlanSchema, operationId: z.string(), backgroundPolicy: z.literal('current').optional() }).parse(raw)
    const old = this.deps.engine.get(input.runId, actor)
    if (!isWallpaperRun(old)) throw new CuratorError('invalid-input', 'wallpaper-replan', 'Choose a wallpaper task.')
    const request = { continuationKind: 'replan', continuationOf: old.id, replacementImageId: input.imageVersionId, replacementPlanDigest: contentDigest(input.plan), ...(input.backgroundPolicy ? { backgroundPolicy: input.backgroundPolicy } : {}) }
    const accepted = this.continuationReceipt(input.operationId, request, actor)
    if (accepted) return accepted
    if (['created', 'running', 'pausing', 'cancelling'].includes(old.status)) throw new CuratorError('constraint-conflict', 'wallpaper-replan', 'Pause the wallpaper task before changing a plan.')
    if (!wallpaperAcceptsWork(this.deps.domain, old)) throw new CuratorError('constraint-conflict', 'wallpaper-replan', 'Use the current unfinished batch; cancelled or removed batches retain read-only results.')
    const state = this.state(old), item = state.items.find(row => row.imageVersionId === input.imageVersionId)
    if (!item?.originalId || input.plan.imageVersionId !== item.originalId) throw new CuratorError('invalid-input', 'wallpaper-replan', 'The plan does not describe this source image.')
    const spec = specOf(old), settings = wallpaperSettingsSchema.parse(spec.fixed.wallpaper)
    applyWallpaperEspcn(settings)
    // Explicit owner corrections add one validated revision; automatic replans and cumulative image edits keep their frozen limits.
    const image = this.deps.domain.require('imageVersion', item.originalId)
    const geometry = wallpaperGeometry(image.geometry, input.plan, settings)
    if (geometry.checks.length) throw new CuratorError('constraint-conflict', 'wallpaper-replan', 'Correct the protected annotations and keep them below the clock area and inside the safety template before applying this plan.')
    const next = structuredClone(state), edited = next.items.find(row => row.imageVersionId === input.imageVersionId)!
    const prompts = wallpaperPromptBundleSchema.parse(spec.fixed.prompts)
    const currentOutpaint = spec.input.workflow === 'wallpaper-direct-v1' ? sourceFaithfulWallpaperPrompts(settings).outpaint : input.backgroundPolicy ? wallpaperPromptBundle().outpaint : undefined
    const currentMode = edited.attempts.at(-1)?.compositionMode
    const compositionMode = currentOutpaint ? currentMode === 'generated-canvas-v1' || currentMode === 'generated-canvas-protected-v2' ? currentMode : 'protected-context-v2' : currentMode
    edited.attempts.push({ revision: (edited.attempts.at(-1)?.revision ?? 0) + 1, createdAt: new Date().toISOString(), plan: input.plan, checks: geometry.checks, needsOutpaint: geometry.needsOutpaint, ...(compositionMode ? { compositionMode } : {}), retryFrom: 'planning', retryTarget: 'planning' }); edited.status = 'rendering'; delete edited.reason; delete edited.errorCode; delete edited.failedStep
    const normalized = { ...spec.input, operationId: input.operationId, ...request }, fixed = { ...spec.fixed, wallpaper: toJson(settings), initialWallpaperState: toJson(next), ...(currentOutpaint ? { prompts: toJson({ ...prompts, outpaint: currentOutpaint }), promptDigest: contentDigest({ ...prompts, outpaint: currentOutpaint }) } : {}) }
    const nextSpec = executionSchema.parse({ ...spec, input: normalized, fixed, specDigest: contentDigest({ kind: spec.kind, config: spec.config, input: normalized, fixed }) })
    return { runId: (await this.deps.engine.create(nextSpec, actor, this.worker(), input.operationId)).id }
  }

  private state(run: RunRecord): WallpaperState { return wallpaperRunState(this.deps.domain, run) }

  /** Continue unfinished work, recompose a saved generation, or independently review a saved output.
   * @param raw Explicit continuation identity and settled task.
   * @param actor Authenticated owner.
   * @returns New receipt referencing the previous immutable task.
   */
  continue(raw: unknown, actor: DomainActor): Promise<{ runId: string }> {
    const work = this.admissions.then(() => this.continueNow(raw, actor)); this.admissions = work.then(() => {}, () => {}); return work
  }
  private async continueNow(raw: unknown, actor: DomainActor) {
    const input = z.strictObject({ runId: z.string(), operationId: z.string(), imageAction: z.strictObject({ action: z.enum(['cancel', 'replace']), imageVersionId: z.string(), replacementId: z.string().optional() }).refine(value => (value.action === 'replace') === !!value.replacementId, 'Replacement requires one saved original.').optional(), rework: z.strictObject({ imageVersionId: z.string(), revision: z.number().int().positive(), outputId: z.string() }).optional(), review: z.strictObject({ outputId: z.string() }).optional(), retryOriginal: z.strictObject({ imageVersionId: z.string() }).optional(), retryImage: z.strictObject({ imageVersionId: z.string(), revision: z.number().int().positive().optional(), step: z.enum(['planning', 'rendering', 'reviewing']) }).optional(), reinspect: z.strictObject({ imageVersionId: z.string() }).optional(), decision: z.strictObject({ imageVersionId: z.string() }).optional(), recompose: z.strictObject({ imageVersionId: z.string(), revision: z.number().int().positive(), mode: wallpaperCompositionModeSchema.optional(), reviewPolicy: z.literal('current').optional(), backgroundResolution: z.literal('current').optional() }).optional() }).refine(value => [value.imageAction, value.rework, value.review, value.recompose, value.reinspect, value.retryOriginal, value.retryImage, value.decision].filter(Boolean).length <= 1, 'Choose one continuation action.').parse(raw), old = this.deps.engine.get(input.runId, actor)
    const request = { continuationKind: input.imageAction ? 'image-action' : input.rework ? 'rework' : input.decision ? 'decision' : input.review ? 'review' : input.reinspect ? 'detail' : input.recompose ? 'recompose' : 'continue', continuationOf: old.id, ...(input.imageAction ? { imageAction: input.imageAction.action, actionImageVersionId: input.imageAction.replacementId ?? input.imageAction.imageVersionId, previousImageVersionId: input.imageAction.imageVersionId } : {}), ...(input.rework ? { reworkedImageId: input.rework.imageVersionId, reworkedRevision: String(input.rework.revision), reworkedOutputId: input.rework.outputId } : {}), ...(input.decision ? { decidedImageId: input.decision.imageVersionId } : {}), ...(input.retryImage ? { retryImageId: input.retryImage.imageVersionId, retryImageStep: input.retryImage.step, retryImageRevision: String(input.retryImage.revision ?? 0) } : {}), ...(input.retryOriginal ? { retryOriginalImageId: input.retryOriginal.imageVersionId } : {}), ...(input.reinspect ? { inspectedImageId: input.reinspect.imageVersionId } : {}), ...(input.review ? { reviewedOutputId: input.review.outputId, reviewPolicy: 'current' } : input.recompose ? { recomposedImageId: input.recompose.imageVersionId, recomposedRevision: String(input.recompose.revision), recomposedMode: input.recompose.mode ?? 'source-edge-v1', reviewPolicy: input.recompose.reviewPolicy ?? 'saved', ...(input.recompose.backgroundResolution ? { backgroundResolutionPolicy: input.recompose.backgroundResolution } : {}) } : {}) }
    const accepted = this.continuationReceipt(input.operationId, request, actor)
    if (accepted) return accepted
    if (!isWallpaperRun(old) || ['created', 'running', 'pausing', 'cancelling'].includes(old.status)) throw new CuratorError('constraint-conflict', 'wallpaper-continue', 'Pause or finish the current wallpaper task first.')
    if (!wallpaperAcceptsWork(this.deps.domain, old)) throw new CuratorError('constraint-conflict', 'wallpaper-continue', 'Use the current unfinished batch; cancelled or removed batches retain read-only results.')
    const spec = specOf(old), settings = wallpaperSettingsSchema.parse(spec.fixed.wallpaper), state = this.state(old), recoveredPlanRequests: Record<string, string> = {}
    if (input.imageAction) {
      const target = state.items.findIndex(item => item.imageVersionId === input.imageAction!.imageVersionId)
      const item = state.items[target]
      if (!item) throw new CuratorError('constraint-conflict', 'wallpaper-image-action', 'Refresh before changing the selected image.')
      const newer = this.deps.domain.repository.list('run').some(run => isWallpaperRun(run) && run.createdAt > old.createdAt && specOf(run).input.sourceRunId === state.sourceRunId && run.profileId === old.profileId && contentDigest(run.owner) === contentDigest(old.owner))
      if (newer) throw new CuratorError('constraint-conflict', 'wallpaper-image-action', 'This batch has a newer continuation. Refresh before changing the selected image.')
      if (input.imageAction.action === 'cancel') {
        if (item.status === 'passed') throw new CuratorError('constraint-conflict', 'wallpaper-image-action', 'A qualified image has no unfinished processing to cancel.')
        item.status = 'cancelled'; item.reason = 'cancelled-by-owner'; delete item.errorCode; delete item.failedStep
      } else {
        const replacement = this.deps.domain.authorizedImage(input.imageAction.replacementId!, actor)
        const priorDigests = new Set<string>(), visited = new Set<string>()
        let ancestor = old
        while (!visited.has(ancestor.id)) {
          visited.add(ancestor.id)
          for (const previous of this.state(ancestor).items) priorDigests.add(this.deps.domain.authorizedImage(previous.originalId ?? previous.imageVersionId, actor).image.blob.digest)
          const parentId = specOf(ancestor).input.continuationOf
          if (typeof parentId !== 'string') break
          ancestor = this.deps.engine.get(parentId, actor)
        }
        if (replacement.image.versionKind !== 'normalized' || !replacement.asset.originalBlob || replacement.asset.source.kind !== 'local-import') throw new CuratorError('constraint-conflict', 'wallpaper-image-action', 'Choose a saved local original for replacement.')
        if (priorDigests.has(replacement.image.blob.digest) || state.items.some(row => row.imageVersionId !== item.imageVersionId && row.imageVersionId === replacement.image.id)) throw new CuratorError('constraint-conflict', 'wallpaper-image-action', 'Choose a different original not previously used in this batch; saved pixels cannot reset the existing image budget.')
        state.items[target] = { imageVersionId: replacement.image.id, originalId: replacement.image.id, familyId: replacement.asset.familyId, status: 'queued', edits: 0, attempts: [], replacementOf: { imageVersionId: item.imageVersionId, errorCode: 'owner-replaced', reason: 'The profile owner selected a different original; previous versions and spent edits remain in the predecessor run.' } }
      }
    }
    const previousBackgroundPolicy = settings.backgroundResolution
    applyWallpaperConcurrency(settings); applyWallpaperEspcn(settings)
    if (spec.input.workflow === 'wallpaper-direct-v1' && (input.review || input.recompose?.reviewPolicy === 'current')) settings.processing = resolveWallpaperProcessing(this.deps.config().wallpaper.processing)
    const genericContinue = !input.imageAction && !input.rework && !input.decision && !input.review && !input.recompose && !input.reinspect && !input.retryOriginal && !input.retryImage
    if (input.rework || genericContinue) {
      // Upgrade the previous default for an owner-requested continuation; keep explicit zero budgets and all spent attempts.
      applyWallpaperRecoveryLimits(settings)
      if (input.rework) {
        const target = input.rework, item = state.items.find(row => row.imageVersionId === target.imageVersionId), attempt = item?.attempts.at(-1)
        if (!item || !attempt || attempt.revision !== target.revision || attempt.outputId !== target.outputId || !['needs-review', 'rejected', 'cancelled'].includes(item.status) || !wallpaperReviewReworkAvailable(item, settings)) {
          throw new CuratorError('constraint-conflict', 'wallpaper-rework', 'Choose the current rejected output with complete source evidence and remaining rework capacity.')
        }
        item.status = 'planning'; delete item.reason; delete item.failedStep; delete item.errorCode
      } else for (const item of state.items) {
        const attempt = item.attempts.at(-1)
        if (wallpaperGenerativeRepair(settings) && item.status === 'needs-review' && item.originalId && attempt && !attempt.generationOperation && !attempt.outputId && !attempt.plan.uncertainties.length && attempt.checks.length === 1 && attempt.checks[0] === 'missing-protected-regions') {
          const regions = wallpaperObjectProtectionRegions(attempt.plan)
          if (regions.length > attempt.plan.regions.length) {
            const source = this.deps.domain.require('imageVersion', item.originalId), observed = { ...attempt.plan, regions }
            const plan = { ...observed, placement: fitWallpaperPlacement(source.geometry, observed, settings, 'subject-first-v2') }, geometry = wallpaperGeometry(source.geometry, plan, settings)
            if (!geometry.checks.length) { attempt.plan = plan; attempt.checks = []; attempt.needsOutpaint = geometry.needsOutpaint; item.status = 'planning'; delete item.reason; delete item.failedStep; delete item.errorCode }
          }
        }
        const ratioRecovery = wallpaperGenerativeRepair(settings) && item.status === 'needs-review' && item.errorCode === 'background-resolution-ratio-mismatch' && !!attempt?.generation && !!attempt.generatedImageId && item.edits < settings.maxEditsPerImage && wallpaperReworkCount(item) < settings.maxReworks
        if (ratioRecovery || (item.status === 'needs-review' || item.status === 'rejected') && wallpaperReviewReworkAvailable(item, settings)) {
          item.status = 'planning'; delete item.reason; delete item.failedStep; delete item.errorCode
        }
      }
    }
    const planAncestors = [old]
    if (!input.imageAction && !input.rework && !input.recompose && !input.review && !input.retryOriginal && state.items.some(item => item.status === 'technical-failed' && !item.attempts.length && item.originalId && item.failedStep === 'planning')) {
      const seen = new Set([old.id])
      for (let current = old; ;) {
        const parentId = specOf(current).input.continuationOf
        if (typeof parentId !== 'string') break
        const parent = this.deps.domain.repository.get('run', parentId)
        if (!parent || seen.has(parent.id) || !isWallpaperRun(parent) || parent.profileId !== old.profileId || contentDigest(parent.owner) !== contentDigest(old.owner) || specOf(parent).input.sourceRunId !== state.sourceRunId) throw new CuratorError('reference-unavailable', 'wallpaper-continue', 'The saved continuation ancestry does not match this wallpaper source and owner.')
        seen.add(parent.id); planAncestors.push(parent); current = parent
      }
    }
    if (input.decision) {
      const item = state.items.find(row => row.imageVersionId === input.decision!.imageVersionId)
      if (!item?.originalId || !item.attempts.length || !(['needs-review', 'technical-failed'].includes(item.status) || wallpaperPendingDecision(item))) throw new CuratorError('constraint-conflict', 'wallpaper-decision', 'Choose a saved image with an unresolved processing hold.')
      const newer = this.deps.domain.repository.list('run').some(run => isWallpaperRun(run) && run.createdAt > old.createdAt && specOf(run).input.sourceRunId === state.sourceRunId && run.profileId === old.profileId && contentDigest(run.owner) === contentDigest(old.owner))
      if (newer) throw new CuratorError('constraint-conflict', 'wallpaper-decision', 'This task has a newer continuation. Refresh before requesting a decision.')
      settings.decision = { ...(settings.decision ?? this.deps.config().wallpaper.decision ?? wallpaperDecisionSettingsSchema.parse({})), enabled: true }
      item.status = 'queued'
    }
    if (genericContinue) for (const item of state.items) {
      const prior = item.attempts.at(-1)
      if (!prior?.generation || prior.outputId || !['needs-review', 'technical-failed'].includes(item.status)) continue
      if (!this.deps.llm) throw new CuratorError('capability-unavailable', 'wallpaper-image-retry', 'The saved image receipt cannot be checked with the current image service.')
      const saved = prior.generation
      const task = await this.deps.llm.getImageGeneration({ ...saved, id: brandString<ImageGenerationId>(saved.id), taskId: brandString<ImageGenerationTaskId>(saved.taskId) }, { waitMs: 0 })
      if (task.state === 'succeeded' && item.errorCode === 'vision-image-digest-mismatch' && item.failedStep === 'reviewing') {
        item.status = 'rendering'; delete item.reason; delete item.errorCode; delete item.failedStep
      } else if ((task.state === 'failed' || task.state === 'cancelled') && item.edits < settings.maxEditsPerImage && wallpaperReworkCount(item) < settings.maxReworks) {
        const attempt = { ...structuredClone(prior), revision: prior.revision + 1, createdAt: new Date().toISOString(), retryTarget: 'rendering' as const }
        delete attempt.generation; delete attempt.generationOperation; delete attempt.generationInput; delete attempt.generationBrief; delete attempt.editReserved; delete attempt.reviewReserved
        delete attempt.reviewedAt
        item.attempts.push(attempt)
        item.status = 'rendering'; delete item.reason; delete item.errorCode; delete item.failedStep
      }
    }
    if (input.retryImage) {
      const item = state.items.find(row => row.imageVersionId === input.retryImage!.imageVersionId), prior = item?.attempts.at(-1)
      const step = item && (wallpaperFailedStep(item) ?? (!prior ? 'planning' : !prior.outputId ? 'rendering' : 'reviewing'))
      if (!item?.originalId || prior?.revision !== input.retryImage.revision || step !== input.retryImage.step || !(['queued', 'planning', 'rendering', 'reviewing', 'technical-failed', 'cancelled'].includes(item.status) || item.status === 'needs-review' && step === 'rendering' && prior?.generation && !prior.outputId)) throw new CuratorError('constraint-conflict', 'wallpaper-image-retry', 'Choose the latest failed step of this image; refresh before retrying.')
      const newer = this.deps.domain.repository.list('run').some(run => isWallpaperRun(run) && run.createdAt > old.createdAt && specOf(run).input.sourceRunId === state.sourceRunId && run.profileId === old.profileId && contentDigest(run.owner) === contentDigest(old.owner))
      if (newer) throw new CuratorError('constraint-conflict', 'wallpaper-image-retry', 'This task has a newer continuation. Refresh before retrying this image.')
      if (step === 'rendering' && prior?.generation) {
        if (!this.deps.llm) throw new CuratorError('capability-unavailable', 'wallpaper-image-retry', 'The saved image receipt cannot be checked with the current image service.')
        const saved = prior.generation
        const task = await this.deps.llm.getImageGeneration({ ...saved, id: brandString<ImageGenerationId>(saved.id), taskId: brandString<ImageGenerationTaskId>(saved.taskId) }, { waitMs: 0 })
        if (task.state === 'failed' || task.state === 'cancelled') {
          if (item.edits >= settings.maxEditsPerImage || wallpaperReworkCount(item) >= settings.maxReworks) throw new CuratorError('constraint-conflict', 'wallpaper-image-retry', 'This image has reached its frozen edit or rework limit. Keep the saved evidence for manual review.')
          const attempt = { ...structuredClone(prior), revision: prior.revision + 1, createdAt: new Date().toISOString(), retryTarget: 'rendering' as const }
          delete attempt.generation; delete attempt.generationOperation; delete attempt.generationInput; delete attempt.generationBrief; delete attempt.editReserved; delete attempt.reviewReserved
          delete attempt.outputId; delete attempt.review; delete attempt.reviewedAt; delete attempt.simulationId; delete attempt.preResolutionReview; delete attempt.clarity; delete attempt.clarityBaseReview
          item.attempts.push(attempt)
        }
        // Queued, sent, unknown and successful receipts retain their operation identity; the worker queries or consumes that receipt.
      }
      if (step === 'reviewing' && prior?.preResolutionReview) {
        delete prior.outputId; delete prior.analysisId; delete prior.simulationId; delete prior.preResolutionReview; delete prior.review; delete prior.reviewReserved
      }
      item.status = step; delete item.reason; delete item.errorCode; delete item.failedStep
    }
    if (input.retryOriginal) {
      const item = state.items.find(row => row.imageVersionId === input.retryOriginal!.imageVersionId)
      if (!item || item.originalId || !(['queued', 'cancelled'].includes(item.status) || item.status === 'technical-failed' && wallpaperFailedStep(item) === 'downloading')) throw new CuratorError('constraint-conflict', 'wallpaper-original-retry', 'Choose an original acquisition failure with no saved original.')
      item.status = 'queued'; delete item.reason; delete item.errorCode; delete item.failedStep
      if (item.download) item.download.retrying = false
    }
    if (input.reinspect) {
      const item = state.items.find(row => row.imageVersionId === input.reinspect!.imageVersionId), attempt = item?.attempts.at(-1)
      if (!item?.originalId || !(item.status === 'needs-review' || item.status === 'rejected' && attempt?.detailAnalysis?.protectedSubjectExtent === 'cut-off' || item.status === 'technical-failed' && wallpaperFailedStep(item) === 'planning') || !attempt || attempt.outputId || attempt.generation || attempt.generationOperation || !wallpaperPlanConcerns(attempt.plan).length) throw new CuratorError('constraint-conflict', 'wallpaper-detail', 'Choose a saved planning hold with unresolved subject evidence before image generation.')
      item.status = 'queued'; delete item.reason; delete item.errorCode; delete item.failedStep
      // A new owner-requested continuation may inspect again; its predecessor remains immutable.
      delete attempt.detailAnalysis; delete item.detailInspection
    }
    let reviewedImageId: string | undefined
    if (input.review) {
      const item = state.items.find(row => row.attempts.some(attempt => attempt.outputId === input.review!.outputId))
      const prior = item?.attempts.findLast(attempt => attempt.outputId === input.review!.outputId)
      if (!item?.originalId || !prior?.outputId || !prior.analysisId || !prior.simulationId || prior.checks.length || new Set([item.originalId, prior.outputId, prior.simulationId]).size !== 3) throw new CuratorError('constraint-conflict', 'wallpaper-review', 'Choose an existing wallpaper output with distinct original and review previews.')
      const reader = { ...actor, ...(typeof spec.fixed.sourceSessionId === 'string' ? { sessionId: spec.fixed.sourceSessionId } : {}) }
      this.deps.domain.authorizedImage(prior.outputId, reader)
      this.deps.domain.authorizedImage(item.originalId, reader)
      const attempt = { ...structuredClone(prior), revision: (item.attempts.at(-1)?.revision ?? 0) + 1, createdAt: new Date().toISOString(), retryFrom: 'reviewing' as const, retryTarget: 'reviewing' as const }
      delete attempt.review; delete attempt.reviewedAt
      if (attempt.preResolutionReview) {
        delete attempt.outputId; delete attempt.analysisId; delete attempt.simulationId; delete attempt.preResolutionReview
      }
      item.attempts.push(attempt); item.status = 'reviewing'; delete item.errorCode; delete item.reason; delete item.failedStep
      reviewedImageId = item.imageVersionId
    } else if (!input.recompose) state.budgetStopped = false
    if (input.recompose) {
      const item = state.items.find(row => row.imageVersionId === input.recompose!.imageVersionId), prior = item?.attempts.find(row => row.revision === input.recompose!.revision)
      if (!item?.originalId || !prior?.generation || !prior.needsOutpaint || prior.checks.length) throw new CuratorError('constraint-conflict', 'wallpaper-recompose', 'Choose a saved background-generation receipt in a settled batch.')
      if (input.recompose.mode === 'protected-context-v2' && prior.compositionMode !== 'protected-context-v2') throw new CuratorError('constraint-conflict', 'wallpaper-recompose', 'The saved generation used a different edit mask. Explicitly apply the current background policy before requesting a new generation.')
      if ((input.recompose.mode === 'generated-canvas-v1' || input.recompose.mode === 'generated-canvas-protected-v2') && (spec.input.workflow !== 'wallpaper-direct-v1' || !prior.generationInput)) throw new CuratorError('constraint-conflict', 'wallpaper-recompose', 'Standalone canvas review requires a saved direct-original image-generation receipt.')
      if (input.recompose.backgroundResolution) {
        if (!['protected-context-v2', 'generated-canvas-v1', 'generated-canvas-protected-v2'].includes(input.recompose.mode ?? '') || !prior.generationInput || !['wallpaper-outpaint-v4', 'wallpaper-outpaint-v5', 'wallpaper-outpaint-v6'].includes(wallpaperPromptBundleSchema.parse(spec.fixed.prompts).outpaint.version)) throw new CuratorError('constraint-conflict', 'wallpaper-recompose', 'Resolution reconstruction requires a saved current edit request and an explicit composition mode.')
        settings.backgroundResolution = this.deps.config().wallpaper.backgroundResolution ?? backgroundResolutionSettingsSchema.parse({})
        settings.clarity = this.deps.config().wallpaper.clarity ?? claritySettingsSchema.parse({})
        if (!settings.backgroundResolution.enabled) throw new CuratorError('constraint-conflict', 'wallpaper-recompose', 'Background reconstruction is disabled in the current wallpaper settings.')
      }
      const attempt = { ...structuredClone(prior), revision: (item.attempts.at(-1)?.revision ?? 0) + 1, createdAt: new Date().toISOString(), retryFrom: 'reviewing' as const, retryTarget: 'rendering' as const, compositionMode: input.recompose.mode ?? 'source-edge-v1' }
      const reusable = !!prior.backgroundResolution?.enhancedId && prior.backgroundResolution.model === 'espcn-x3-luma' && prior.backgroundResolution.modelSha256 === espcnWeightsDigest && prior.backgroundResolution.output?.width === settings.width && prior.backgroundResolution.output.height === settings.height && previousBackgroundPolicy !== undefined && contentDigest(previousBackgroundPolicy) === contentDigest(settings.backgroundResolution)
      if (reusable && attempt.backgroundResolution) attempt.backgroundResolution.reusedFromRevision = prior.revision
      delete attempt.outputId; delete attempt.review; delete attempt.reviewedAt; delete attempt.analysisId; delete attempt.simulationId; delete attempt.preResolutionReview; if (!reusable) delete attempt.backgroundResolution; delete attempt.clarity; delete attempt.clarityBaseReview
      item.attempts.push(attempt); item.status = 'rendering'; delete item.errorCode; delete item.reason; delete item.failedStep
    } else if (genericContinue) for (const item of state.items) if (item.status === 'technical-failed' && !wallpaperSourceRestricted(item)) {
      if (!item.attempts.length && item.originalId && item.failedStep === 'planning') {
        const requests = this.deps.domain.repository.list('request')
        for (const record of planAncestors.flatMap(ancestor => requests.filter(record => record.runId === ancestor.id && record.state === 'committed'))) {
          const saved = z.object({ bundle: z.object({ operation: z.literal('wallpaper-plan'), requestId: z.literal(`${record.runId}:${item.imageVersionId}:plan:1`) }), output: wallpaperPlanSchema }).safeParse(record.data)
          if (!saved.success || saved.data.output.imageVersionId !== item.originalId) continue
          try { wallpaperGeometry(this.deps.domain.require('imageVersion', item.originalId).geometry, saved.data.output, settings) }
          catch (error) {
            if (!(error instanceof CuratorError && error.code === 'invalid-input' && error.stage === 'wallpaper-layout')) throw error
            item.attempts.push({ revision: 1, plan: saved.data.output, checks: ['source-outside-canvas'], needsOutpaint: false, compositionMode: 'source-edge-v1' })
            recoveredPlanRequests[item.imageVersionId] = record.id
          }
          break
        }
      }
      item.status = 'queued'; delete item.errorCode; delete item.reason; delete item.failedStep
    }
    if (genericContinue) for (const item of state.items) if (pending(item)) item.status = 'queued'
    const normalized = { ...spec.input }
    for (const key of ['imageAction', 'actionImageVersionId', 'previousImageVersionId', 'reworkedImageId', 'reworkedRevision', 'reworkedOutputId', 'decidedImageId', 'retryOriginalImageId', 'retryImageId', 'retryImageStep', 'retryImageRevision', 'inspectedImageId', 'reviewedImageId', 'reviewedOutputId', 'recomposedImageId', 'recomposedRevision', 'recomposedMode', 'reviewPolicy', 'backgroundResolutionPolicy']) delete normalized[key]
    Object.assign(normalized, { operationId: input.operationId, ...request, ...(reviewedImageId ? { reviewedImageId } : {}) })
    const fixed: Record<string, Json> = { ...spec.fixed, ...(state.items.some(item => item.attempts.some(attempt => attempt.generationBrief)) ? { reviewOrder: 'generation-before-resolution-v1' } : {}), wallpaper: toJson(settings), initialWallpaperState: toJson(state), ...(dataOf(old).checkpoint.wallpaperReplacementSearch ? { initialReplacementSearch: dataOf(old).checkpoint.wallpaperReplacementSearch } : {}), ...(Object.keys(recoveredPlanRequests).length ? { recoveredPlanRequests } : {}) }
    if (input.recompose?.reviewPolicy === 'current' && spec.input.workflow !== 'wallpaper-direct-v1') {
      const standard = executionStandard(styleStandardSchema.parse(spec.fixed.release), spec.fixed.executionRecipe)
      if (wallpaperReviewVersion(standard) !== 'wallpaper-review-v2') throw new CuratorError('constraint-conflict', 'wallpaper-review-policy', 'This saved task has no fixed weighted policy for the current review. Keep the saved review policy.')
      fixed.prompts = toJson({ ...wallpaperPromptBundleSchema.parse(spec.fixed.prompts), review: wallpaperPromptBundle('wallpaper-review-v2').review })
    }
    if (input.decision) fixed.prompts = toJson({ ...wallpaperPromptBundleSchema.parse(spec.fixed.prompts), decision: wallpaperPromptBundleSchema.parse(spec.fixed.prompts).decision ?? wallpaperPromptBundle().decision, detail: wallpaperPlanDetailPrompt })
    if (input.reinspect) {
      if (spec.input.workflow === 'wallpaper-direct-v1') {
        settings.sourceFrameRepair ??= wallpaperSettingsSchema.shape.sourceFrameRepair.unwrap().parse({})
        settings.backgroundAlignment ??= wallpaperSettingsSchema.shape.backgroundAlignment.unwrap().parse({})
        fixed.wallpaper = toJson(settings)
        fixed.prompts = toJson(sourceFaithfulWallpaperPrompts(settings))
        fixed.sourceFrameRepairMigration = toJson({ version: 'source-frame-outpaint-v1', imageVersionId: input.reinspect.imageVersionId })
      } else fixed.prompts = toJson({ ...wallpaperPromptBundleSchema.parse(spec.fixed.prompts), detail: wallpaperPlanDetailPrompt })
    }
    if (genericContinue && wallpaperGenerativeRepair(settings)) { settings.processing = resolveWallpaperProcessing(this.deps.config().wallpaper.processing); fixed.wallpaper = toJson(settings); fixed.prompts = toJson(sourceFaithfulWallpaperPrompts(settings)); fixed.promptDigest = contentDigest(fixed.prompts) }
    if (input.review) fixed.prompts = toJson({ ...wallpaperPromptBundleSchema.parse(spec.fixed.prompts), review: spec.input.workflow === 'wallpaper-direct-v1' ? sourceFaithfulWallpaperPrompts(wallpaperSettingsSchema.parse(fixed.wallpaper)).review : wallpaperPromptBundle().review })
    const canvasReview = state.items.some(item => (item.imageVersionId === reviewedImageId || item.imageVersionId === input.recompose?.imageVersionId) && ['generated-canvas-v1', 'generated-canvas-protected-v2'].includes(item.attempts.at(-1)?.compositionMode ?? ''))
    if (canvasReview && (input.review || input.recompose?.reviewPolicy === 'current')) fixed.prompts = toJson({ ...wallpaperPromptBundleSchema.parse(fixed.prompts), review: { version: 'wallpaper-review-source-v4', text: wallpaperGenerativeRepair(wallpaperSettingsSchema.parse(fixed.wallpaper)) ? sourceFaithfulWallpaperPrompts(wallpaperSettingsSchema.parse(fixed.wallpaper)).review.text : wallpaperCanvasReviewPromptV4 } })
    if (input.decision || input.reinspect || input.review || input.recompose?.reviewPolicy === 'current') fixed.promptDigest = contentDigest(fixed.prompts)
    const current = resolveCurrentConfig(this.deps.config())
    let config = input.review ? { ...spec.config, vision: current.vision } : input.retryOriginal ? { ...spec.config, limits: { ...spec.config.limits, originalDownloadTimeoutMs: current.limits.originalDownloadTimeoutMs, originalDownloadIdleTimeoutMs: current.limits.originalDownloadIdleTimeoutMs } } : spec.config
    if (genericContinue) config = { ...config, limits: { ...config.limits, maxStorageBytes: current.limits.maxStorageBytes } }
    if (!input.review && !input.imageAction || input.imageAction?.action === 'replace') { fixed.generationPromptPolicy = toJson(wallpaperPromptPreparationPolicySchema.parse(this.deps.config().vision.wallpaperPromptPreparation ?? {})); fixed.generationPrompt = toJson(wallpaperGenerationBriefPrompt) }
    const next = executionSchema.parse({ ...spec, config, input: normalized, fixed, specDigest: contentDigest({ kind: spec.kind, config, input: normalized, fixed }) })
    return { runId: (await this.deps.engine.create(next, actor, this.worker(), input.operationId, input.decision || input.rework ? old.id : undefined)).id }
  }

  private continuationReceipt(operationId: string, request: Record<string, string>, actor: DomainActor): { runId: string } | undefined {
    const accepted = this.deps.domain.repository.list('run').find(run => isWallpaperRun(run) && (specOf(run).input.operationId === operationId || specOf(run).input.continuationOf === request.continuationOf && ['created', 'running', 'pausing', 'paused', 'interrupted', 'cancelling'].includes(run.status)))
    if (!accepted) return undefined
    this.deps.engine.get(accepted.id, actor)
    const input = specOf(accepted).input
    if (Object.entries(request).some(([key, value]) => (input[key] ?? (key === 'recomposedMode' ? 'source-edge-v1' : key === 'reviewPolicy' ? 'saved' : undefined)) !== value)) throw new CuratorError('operation-conflict', 'wallpaper-continue', 'This task already has a different accepted continuation.')
    return { runId: accepted.id }
  }

  /** Resume saved per-image steps; reads and page replay never call this worker.
   * @returns Worker sharing the owning Run's budgets and cancellation.
   */
  worker(): Worker {
    return async ctx => {
      const direct = ctx.spec.input.workflow === 'wallpaper-direct-v1'
      const state = this.state(ctx.current()), settings = wallpaperSettingsSchema.parse(ctx.spec.fixed.wallpaper), release = direct ? undefined : executionStandard(styleStandardSchema.parse(ctx.spec.fixed.release), ctx.spec.fixed.executionRecipe)
      applyWallpaperEspcn(settings)
      const reviewIdentity = release ? { releaseId: release.id, recipeId: release.recipe.id } : { directPolicy: ctx.spec.fixed.directPolicy, recipeId: 'wallpaper-review-source-v1' }
      const taskBrief = release ? styleReviewBrief(release, String(ctx.spec.input.taskBrief)) : String(ctx.spec.input.taskBrief)
      const visualRules = release?.rules.filter(rule => rule.check.kind === 'visual') ?? []
      const recomposeOnly = ctx.spec.input.continuationKind === 'recompose'
      const decisionOnly = ctx.spec.input.continuationKind === 'decision'
      const reviewOnly = ctx.spec.input.continuationKind === 'review', detailOnly = ctx.spec.input.continuationKind === 'detail', originalOnly = ctx.spec.input.continuationKind === 'continue' && (typeof ctx.spec.input.retryOriginalImageId === 'string' || typeof ctx.spec.input.retryImageId === 'string')
      const reworkOnly = ctx.spec.input.continuationKind === 'rework'
      const { backgroundContextPixels: _context, ...legacySettings } = settings
      const requestSettings = { ...(z.object({ backgroundContextPixels: z.number().optional() }).parse(ctx.spec.fixed.wallpaper).backgroundContextPixels === undefined ? legacySettings : settings), ...(!settings.processing?.clockContrast ? { topBuffer: 0 } : {}) }
      const skill = z.object({ id: z.string(), content: z.string() }).parse(ctx.spec.fixed.skill), prompts = wallpaperPromptBundleSchema.parse(ctx.spec.fixed.prompts)
      const promptPreparation = ctx.spec.fixed.generationPromptPolicy === undefined ? undefined : wallpaperPromptPreparationPolicySchema.parse(ctx.spec.fixed.generationPromptPolicy)
      const reviewBeforeResolution = ctx.spec.fixed.reviewOrder === 'generation-before-resolution-v1'
      const generationPrompt = promptPreparation?.enabled ? z.strictObject({ version: z.literal('wallpaper-generation-brief-v1'), text: z.string().min(1) }).parse(ctx.spec.fixed.generationPrompt) : undefined
      const singleCanvas = ['wallpaper-outpaint-v5', 'wallpaper-outpaint-v6'].includes(prompts.outpaint.version), opaqueCanvas = prompts.outpaint.version === 'wallpaper-outpaint-v6'
      const protectedContext = ['wallpaper-outpaint-v4', 'wallpaper-outpaint-v5', 'wallpaper-outpaint-v6'].includes(prompts.outpaint.version)
      const wholeGeneratedCanvas = direct && reviewBeforeResolution && promptPreparation?.version === 'style-brief-v3'
      const compositionMode = direct && (prompts.review.version === 'wallpaper-review-source-v3' || prompts.review.version === 'wallpaper-review-source-v4') ? reviewBeforeResolution && !wholeGeneratedCanvas ? 'generated-canvas-protected-v2' : 'generated-canvas-v1' : protectedContext ? 'protected-context-v2' : 'source-edge-v1'
      const placementPolicy = wholeGeneratedCanvas || compositionMode === 'generated-canvas-protected-v2' ? 'source-preserving-v3' : ['wallpaper-plan-v6', 'wallpaper-plan-v7'].includes(prompts.plan.version) ? 'subject-first-v2' : 'crop-first-v1'
      const actor: DomainActor = { kind: 'human', id: 'wallpaper-worker', profileId: this.deps.domain.profileId, ...(typeof ctx.spec.fixed.sourceSessionId === 'string' ? { sessionId: ctx.spec.fixed.sourceSessionId } : {}) }
      let providerPromise: Promise<StructuredVisionProvider> | undefined, stopped: unknown
      const queued = state.items.filter(item => pending(item) && (!(reworkOnly || decisionOnly || recomposeOnly || reviewOnly || detailOnly || originalOnly) || item.imageVersionId === wallpaperWorkImage(ctx.spec.input))), ready = new Map<string, { promise: Promise<ImageVersion | undefined>; resolve(image: ImageVersion | undefined): void }>()
      for (const item of queued) {
        let resolve!: (image: ImageVersion | undefined) => void
        const promise = new Promise<ImageVersion | undefined>(done => { resolve = done })
        ready.set(item.imageVersionId, { promise, resolve })
      }
      const save = async (records: CuratorRecord[] = []) => {
        const counts = { ...dataOf(ctx.current()).counts, retrievedUnique: state.items.length, finalPassed: state.items.filter(item => item.status === 'passed').length, pending: state.items.filter(pending).length, needsReview: state.items.filter(item => item.status === 'needs-review').length, technicalFailed: state.items.filter(item => item.status === 'technical-failed').length, rejected: state.items.filter(item => item.status === 'rejected').length, cropGenerated: state.items.reduce((n, item) => n + item.attempts.filter(attempt => attempt.outputId).length, 0) }
        await ctx.save(state.items.some(item => item.status === 'reviewing') ? 'reviewing' : state.items.some(item => item.status === 'rendering') ? 'cropping' : state.items.some(item => item.status === 'planning') ? 'planning' : 'retrieving', { checkpoint: { ...dataOf(ctx.current()).checkpoint, wallpaper: toJson(state) }, counts }, records)
      }
      const deliverApproved = async (item: WallpaperItem) => {
        if (!direct || !this.deps.approved) return
        try { await this.deps.approved(ctx.current(), item.imageVersionId) }
        catch (error) { await this.deps.engine.addWarning(ctx.runId, actor, `Server delivery requires attention: ${safeFailure(error).code}.`) }
      }
      const committed = async <T>(input: VisionInput, operation: 'wallpaper-plan' | 'wallpaper-review' | 'wallpaper-decision', schema: z.ZodType<T> | ((prepared: VisionInput) => z.ZodType<T>), reservedVision = false): Promise<T> => {
        if (settings.processing && !input.reasoningEffort) input = { ...input, reasoningEffort: operation === 'wallpaper-plan' && input.detailRegions?.length ? settings.processing.criticalReasoningEffort : settings.processing.reasoningEffort }
        // Resuming a persisted inspection keeps its source-crop identities and can reuse its committed model response.
        const inspectionRequest = operation === 'wallpaper-plan' && state.items.some(item => item.detailInspection?.requestId === input.requestId && item.detailInspection.status === 'running')
        const replayable = operation === 'wallpaper-decision' || inspectionRequest || input.wallpaperPrompt?.version === 'wallpaper-generation-brief-v1'
        const provider = await (providerPromise ??= this.deps.vision(ctx.spec.config))
        input = await wallpaperVisionInput(input, this.deps.files, provider, ctx.spec.config.limits.previewMaxDimension, ctx.signal, async (sourceId, blob, geometry, rect) => {
          const parent = this.deps.domain.authorizedImage(sourceId, actor).image
          const id = `wallpaper-detail-${contentDigest({ runId: replayable ? input.requestId : ctx.runId, sourceId, digest: blob.digest, rect }).slice(10)}`
          if (!this.deps.domain.repository.get('imageVersion', id)) {
            const view = imageVersionSchema.parse({ schemaVersion: 1, profileId: parent.profileId, createdAt: new Date().toISOString(), id, kind: 'imageVersion', assetId: parent.assetId, versionKind: 'preview', parentImageVersionId: parent.id, blob,
              geometry: { ...geometry, colorSpace: 'srgb', processorVersion: `${this.deps.files.processorVersion}/wallpaper-detail-view-v1` }, processing: { recipeDigest: contentDigest({ kind: 'wallpaper-detail-view-v1', sourceId, sourceDigest: parent.blob.digest, rect }), processorVersion: `${this.deps.files.processorVersion}/wallpaper-detail-view-v1`, sourceDigest: parent.blob.digest, requestedRect: rect, encoding: blob.mime, outputWidth: geometry.width, outputHeight: geometry.height } })
            await save([view])
          }
          return id
        })
        if (operation === 'wallpaper-decision') input = bindWallpaperDecisionEvidence(input)
        const outputSchema = typeof schema === 'function' ? schema(input) : schema
        const descriptor = toJson(provider.describeRequest(input, operation)), digest = contentDigest(descriptor)
        const old = findWallpaperResponse(this.deps.domain.repository, ctx.current(), input.requestId, digest, replayable)
        if (old) return outputSchema.parse(z.object({ output: z.unknown() }).parse(old.data).output)
        return await ctx.request('vision', descriptor, async (signal, recordMetadata, previous) => {
          const retryInput = previous?.code === 'vision-invalid-output' && previous.issues.length ? { ...input, outputRepair: { requestId: previous.requestId, issues: previous.issues } } : input
          return outputSchema.parse(await provider.wallpaper(retryInput, operation, visionBounds(ctx.spec.config, ctx, signal, recordMetadata)))
        }, undefined, { reservedVision })
      }
      const decide = async (item: WallpaperItem, source: ImageVersion, original: VisionImage) => {
        if (!settings.decision?.enabled || !prompts.decision) return false
        const provider = await (providerPromise ??= this.deps.vision(ctx.spec.config))
        return await executeWallpaperDecision({ item, source, original, settings, prompt: prompts.decision, taskBrief, rules: visualRules, supportsDetail: provider.config.supportsMultiImage && provider.config.maxImages > 1, maxImages: provider.config.maxImages, ctx, domain: this.deps.domain, files: this.deps.files, ...(this.deps.llm ? { llm: this.deps.llm } : {}), commit: (input, schema) => committed(input, 'wallpaper-decision', schema), save })
      }
      const failed = async (item: WallpaperItem, error: unknown) => {
        if (ctx.signal.aborted) throw error
        const latest = item.attempts.at(-1)
        const rejected = reviewOnly && (prompts.review.version === 'wallpaper-review-v3' || prompts.review.version === 'wallpaper-review-v4') && item.originalId && latest?.outputId && error instanceof MediaError && error.code === 'vision-invalid-output'
          ? wallpaperSubjectRejection(error.diagnostics?.modelOutput, item.originalId, latest.outputId) : undefined
        if (rejected && latest?.outputId) {
          latest.review = rejected; item.status = 'rejected'; item.reason = rejected.checks.subject.reason; delete item.errorCode; delete item.failedStep
          const assessment = assessmentSchema.parse({ schemaVersion: 1, profileId: ctx.current().profileId, createdAt: new Date().toISOString(), id: `wallpaper-review-${contentDigest({ runId: ctx.runId, output: latest.outputId }).slice(10)}`, kind: 'assessment', imageVersionId: latest.outputId, runId: ctx.runId, stage: 'final', ...reviewIdentity, reviewBundleId: `${ctx.runId}:${item.imageVersionId}:${latest.revision}`, technicalStatus: 'completed', verdict: 'reject', ruleResults: [], cropPotential: 'direct', preferenceScores: {}, data: toJson({ wallpaperReview: rejected, settings, inferredRegions: true }) })
          await save([assessment]); return
        }
        const failure = safeFailure(error)
        if (item.detailInspection?.status === 'running' || item.detailInspection?.status === 'queued') {
          item.detailInspection.status = 'failed'; item.detailInspection.errorCode = failure.code; item.detailInspection.reason = failure.safeMessage
        }
        const deciding = item.decisions?.findLast(record => record.status === 'running')
        if (deciding && !ctx.signal.aborted) { deciding.status = 'failed'; deciding.errorCode = failure.code; deciding.reason = failure.safeMessage }
        if (item.download) item.download.retrying = false
        if (item.attempts.at(-1)?.clarity?.status === 'enhancing') { item.attempts.at(-1)!.clarity!.status = 'failed'; item.attempts.at(-1)!.clarity!.reason = failure.safeMessage }
        if (latest?.backgroundResolution && ['enhancing', 'reviewing'].includes(latest.backgroundResolution.status)) { latest.backgroundResolution.status = 'failed'; latest.backgroundResolution.reason = failure.safeMessage }
        item.failedStep = failure.code === 'image-resolution-insufficient' ? 'rendering' : item.status === 'downloading' ? 'downloading' : item.status === 'rendering' ? 'rendering' : item.status === 'reviewing' ? 'reviewing' : 'planning'
        item.status = 'technical-failed'; item.reason = failure.safeMessage; item.errorCode = failure.code
        if (failure.code === 'budget-exhausted') {
          state.budgetStopped = true; await save()
          await ctx.save(ctx.current().stage ?? 'finalizing', { error: failure, warnings: [...new Set([...dataOf(ctx.current()).warnings, failure.safeMessage])] })
          throw error
        }
        await save()
      }
      const downloadAll = async () => {
        try {
          for (const item of queued) {
            if (stopped) break
            try {
              ctx.signal.throwIfAborted(); item.status = 'downloading'; await save()
              const source = await this.original(item, actor, ctx, save)
              item.status = 'queued'; await save(); ready.get(item.imageVersionId)!.resolve(source)
            } catch (error) {
              try { await failed(item, error) } catch (stop) { stopped = stop; break }
              ready.get(item.imageVersionId)!.resolve(undefined)
            }
          }
        } finally { for (const slot of ready.values()) slot.resolve(undefined) }
      }
      const process = async (item: WallpaperItem): Promise<void> => {
        if (!pending(item)) return
        let decisionSource: ImageVersion | undefined, decisionOriginal: VisionImage | undefined
        try {
          if (stopped) return
          let source: ImageVersion | undefined
          if (direct) {
            ctx.signal.throwIfAborted(); item.status = 'downloading'; await save()
            source = await this.original(item, actor, ctx, save)
          } else source = await ready.get(item.imageVersionId)!.promise
          if (!source || stopped) return
          const latest = item.attempts.at(-1), needsPlan = !latest || latest.checks.length || latest.review && wallpaperVerdict(latest.review) === 'reject'
          item.status = reviewOnly ? 'reviewing' : needsPlan ? 'planning' : 'rendering'; await save()
          const bytes = await this.deps.files.read(source.blob, ctx.signal)
          const original: VisionImage = { imageVersionId: source.id, digest: source.blob.digest, mime: source.blob.mime, bytes, role: 'wallpaper-original' }
          decisionSource = source; decisionOriginal = original
          const inspectionQueued = () => item.detailInspection?.status === 'queued' || item.detailInspection?.status === 'running'
          if (!detailOnly && !inspectionQueued() && (item.decisions?.some(record => record.status === 'running') || item.decisions?.at(-1)?.status === 'applied' && item.decisions.at(-1)?.detailRect && item.decisions.at(-1)?.targetStage === 'decision' || decisionOnly && !item.decisions?.some(record => record.id.startsWith(ctx.runId + ':')))) {
            if (!await decide(item, source, original)) return
          }
          for (;;) {
            ctx.signal.throwIfAborted()
            let attempt = item.attempts.at(-1)
            const decisionReplan = wallpaperDecisionReplan(item, attempt?.revision ?? 0)
            if (!decisionReplan && wallpaperReviewReworkAvailable(item, settings)) {
              const retry = wallpaperEditingRetry(item, settings)
              if (retry) { retry.createdAt = new Date().toISOString(); delete retry.reviewedAt; item.attempts.push(retry); attempt = retry; item.status = 'rendering'; delete item.reason; await save() }
            }
            const objectPolicyReplan = wallpaperGenerativeRepair(settings) && attempt && !attempt.layoutCorrection && wallpaperHasBackgroundAnchors(attempt.plan)
            if (!decisionReplan && !objectPolicyReplan && attempt?.review && wallpaperVerdict(attempt.review) === 'needs-review') { item.status = 'needs-review'; item.reason = attempt.review.issues.map(issue => issue.reason).join('；'); await save(); if (await decide(item, source, original)) continue; return }
            if (!inspectionQueued() && (decisionReplan || objectPolicyReplan || !attempt || attempt.review && wallpaperVerdict(attempt.review) === 'reject' || attempt.checks.length) && (decisionReplan || attempt?.review || wallpaperGenerativeRepair(settings) || !(attempt && prompts.detail && !attempt.detailAnalysis && wallpaperPlanConcerns(attempt.plan).length))) {
              if (attempt && wallpaperReworkCount(item) >= settings.maxReworks) { item.status = 'needs-review'; item.reason = 'rework-limit'; await save(); return }
              item.status = 'planning'; await save()
              const input: VisionInput = { wallpaperPrompt: prompts.plan, requestId: `${ctx.runId}:${item.imageVersionId}:plan:${item.attempts.length + 1}`, taskBrief, rules: visualRules, images: [original], usage: toJson({ settings: requestSettings, sourceGeometry: source.geometry, ...(prompts.plan.version !== 'wallpaper-plan-v1' ? { protectedBounds: wallpaperProtectedBounds(settings) } : {}), skill, ...(decisionReplan?.response?.action.kind === 'replan' ? { decisionGuidance: decisionReplan.response.action.guidance } : {}), previous: item.attempts.map(row => ({ plan: row.plan, checks: row.checks, review: row.review })) }) }
              if (attempt?.outputId && attempt.review && wallpaperVerdict(attempt.review) === 'reject') {
                const previous = this.deps.domain.authorizedImage(attempt.outputId, actor).image
                if (previous.parentImageVersionId !== source.id || previous.assetId !== source.assetId) throw new CuratorError('reference-unavailable', 'wallpaper-rework', 'The rejected output no longer belongs to this source image.')
                const provider = await (providerPromise ??= this.deps.vision(ctx.spec.config))
                if (provider.config.supportsMultiImage && provider.config.maxImages >= 2) input.images = [original, { imageVersionId: previous.id, digest: previous.blob.digest, mime: previous.blob.mime, bytes: await this.deps.files.read(previous.blob, ctx.signal), role: 'rejected-wallpaper' }]
                input.usage = { ...z.record(z.string(), z.unknown()).parse(input.usage), revisionTask: 'Correct the failed checks and issues from the last independent review in your new placement, protection regions and scene-specific editPrompt. Use the original as the fidelity reference. The rejected wallpaper illustrates the defects.' }
              }
              const observed = await committed(input, 'wallpaper-plan', wallpaperGenerativeRepair(settings) ? wallpaperRepairObservationPlanSchema : ['wallpaper-plan-v6', 'wallpaper-plan-v7'].includes(prompts.plan.version) ? wallpaperObservationPlanSchema.required({ editPrompt: true }) : prompts.plan.version === 'wallpaper-plan-v4' || prompts.plan.version === 'wallpaper-plan-v5' ? wallpaperObservationPlanSchema : wallpaperPlanSchema)
              if (wallpaperGenerativeRepair(settings)) observed.regions = wallpaperObjectProtectionRegions(observed)
              const retained = (prompts.detail || decisionReplan) && attempt ? { ...observed, regions: retainWallpaperRegions(wallpaperGenerativeRepair(settings) ? attempt.plan.regions.filter(region => region.role !== 'anchor') : attempt.plan.regions, observed.regions) } : observed
              const plan = wallpaperPlanSchema.parse({ ...retained, placement: 'placement' in retained ? retained.placement : fitWallpaperPlacement(source.geometry, retained, settings, placementPolicy) })
              let geometry: ReturnType<typeof wallpaperGeometry> | undefined
              try { geometry = wallpaperGeometry(source.geometry, plan, settings) }
              catch (error) { if (!(error instanceof CuratorError && error.code === 'invalid-input' && error.stage === 'wallpaper-layout')) throw error }
              attempt = { revision: (attempt?.revision ?? 0) + 1, createdAt: new Date().toISOString(), plan, checks: geometry?.checks ?? ['source-outside-canvas'], needsOutpaint: geometry?.needsOutpaint ?? false, compositionMode, ...(prompts.review.version === 'wallpaper-review-v4' ? { clarity: { status: 'pending' as const, reason: '' } } : {}), ...(attempt ? { retryFrom: attempt.review ? 'reviewing' as const : 'planning' as const, retryTarget: 'planning' as const } : {}) }; item.attempts.push(attempt); delete item.reason; delete item.errorCode; delete item.failedStep; await save()
            }
            if (!attempt) throw new CuratorError('reference-unavailable', 'wallpaper-detail', 'The saved inspection has no matching source plan.')
            if (!inspectionQueued() && attempt.checks.includes('source-outside-canvas')) { if (settings.decision?.enabled && prompts.decision) { item.status = 'needs-review'; item.reason = 'source-outside-canvas'; await save(); if (!await decide(item, source, original)) return }; continue }
            if (inspectionQueued() || !wallpaperGenerativeRepair(settings) && prompts.detail && !wallpaperDecisionApproved(item, attempt) && !attempt.detailAnalysis && wallpaperPlanConcerns(attempt.plan).length) {
              const inspection: NonNullable<WallpaperItem['detailInspection']> = inspectionQueued() ? item.detailInspection! : {
                origin: detailOnly ? 'manual' : 'planning', status: 'queued', planRevision: attempt.revision, requestId: `${ctx.runId}:${item.imageVersionId}:detail:${attempt.revision}`, decisionRoundAtStart: item.decisions?.length ?? 0,
              }
              const detailPrompt = prompts.detail?.version === 'wallpaper-plan-detail-v4' || prompts.detail?.version === 'wallpaper-plan-detail-v5' ? prompts.detail : inspection.origin === 'decision' ? wallpaperPlanDetailPrompt : prompts.detail!
              if (inspection.planRevision !== attempt.revision || attempt.outputId || attempt.generation || attempt.generationOperation) throw new CuratorError('constraint-conflict', 'wallpaper-detail', 'The inspection cannot run after image production or against another plan revision.')
              item.detailInspection = inspection; item.status = 'planning'
              if (inspection.status === 'queued') await save()
              const concerns = wallpaperPlanConcerns(attempt.plan), nativeRect = wallpaperPlanDetailRect(attempt.plan), rect = inspection.rect ?? nativeRect, requestId = inspection.requestId
              inspection.status = 'running'; await save()
              const provider = await (providerPromise ??= this.deps.vision(ctx.spec.config))
              if (!rect || !provider.config.supportsMultiImage || provider.config.maxImages < 2) {
                inspection.status = 'unavailable'; inspection.reason = 'vision-detail-unavailable'
                attempt.detailAnalysis = { version: detailPrompt.version, requestId, outcome: 'unavailable' }; item.reason = inspection.reason; await save()
              } else {
                const rects = [rect]
                if (inspection.origin === 'decision' && nativeRect && provider.config.maxImages >= 3 && contentDigest(nativeRect) !== contentDigest(rect)) rects.push(nativeRect)
                const decision = inspection.decisionId ? item.decisions?.find(record => record.id === inspection.decisionId) : undefined
                const detailInput: VisionInput = { wallpaperPrompt: detailPrompt, requestId, taskBrief, rules: visualRules, images: [original], detailRegions: rects.map(rect => ({ imageVersionId: source.id, rect })), usage: toJson({ settings: requestSettings, protectedBounds: wallpaperProtectedBounds(settings), sourceGeometry: source.geometry, concerns, priorPlan: attempt.plan, frozenPlanInstructions: prompts.plan.text, ...(decision ? { inspection: { rect, reason: decision.reason, concernIds: decision.response?.action.kind === 'inspect_region' ? decision.response.action.concernIds : undefined } } : {}) }) }
                const detail = await committed(detailInput, 'wallpaper-plan', prepared => wallpaperPlanDetailOutputSchema(source.id, concerns, prepared.images.filter(image => image.role === 'wallpaper-original-detail-only').map(image => image.imageVersionId), detailPrompt.version, wallpaperNativeDetails(prepared)))
                const resolved = resolveWallpaperPlanDetail(attempt.plan, detail, settings.sourceFrameRepair?.enabled)
                attempt.detailAnalysis = { version: detailPrompt.version, requestId, outcome: resolved.outcome, ...('protectedSubjectExtent' in detail ? { protectedSubjectExtent: detail.protectedSubjectExtent.extent } : {}), ...('edgeRepair' in detail ? { edgeRepair: detail.edgeRepair } : {}), ...(detail.version === 'wallpaper-plan-detail-v5' ? { concerns: [...concerns, ...detail.findings.filter(finding => !concerns.some(concern => concern.id === finding.concernId)).map(finding => ({ id: finding.concernId, text: detail.observation.uncertainties[Number(finding.concernId.slice('observation:'.length))]! }))], findings: detail.findings, retainedUncertainties: resolved.retainedUncertainties } : {}) }
                inspection.status = resolved.outcome; inspection.reason = resolved.reason; item.reason = resolved.reason
                if (resolved.outcome === 'resolved' || resolved.outcome === 'ready-for-edit') {
                  const observation = { ...resolved.observation, ...(resolved.observation.editPrompt ? {} : attempt.plan.editPrompt ? { editPrompt: attempt.plan.editPrompt } : {}) }
                  const repair = attempt.detailAnalysis.edgeRepair
                  const plan = wallpaperPlanSchema.parse({ ...observation, placement: fitWallpaperPlacement(source.geometry, observation, settings, placementPolicy, repair?.classification === 'edge-continuation' ? repair.edges : []) }), geometry = wallpaperGeometry(source.geometry, plan, settings)
                  attempt = { revision: attempt.revision + 1, createdAt: new Date().toISOString(), plan, checks: geometry.checks, needsOutpaint: geometry.needsOutpaint, compositionMode, detailAnalysis: attempt.detailAnalysis, retryFrom: 'planning', retryTarget: 'planning', ...(attempt.clarity ? { clarity: { status: 'pending' as const, reason: '' } } : {}) }
                  item.attempts.push(attempt); delete item.reason
                }
                await save()
              }
            }
            if (!attempt.analysisId) {
              const seed = await renderWallpaper(bytes, attempt.plan, settings, undefined, attempt.compositionMode), overlays = await wallpaperOverlays(seed.image, seed.geometry, settings), analysis = await this.artifact(source, overlays.analysis, ctx, 'analysis', item, attempt.revision)
              attempt.analysisId = analysis.image.id; attempt.layoutAnalysisId ??= analysis.image.id; await save(analysis.records)
            }
            if (!wallpaperDecisionApproved(item, attempt) && (attempt.detailAnalysis?.outcome === 'unresolved' || attempt.detailAnalysis?.outcome === 'unavailable')) { item.status = 'needs-review'; item.reason ||= attempt.plan.uncertainties.join('；') || 'uncertain-subject'; await save(); if (await decide(item, source, original)) continue; return }
            if (attempt.detailAnalysis?.outcome === 'violated') {
              item.status = 'rejected'; await save()
              if (settings.decision?.enabled && attempt.detailAnalysis.protectedSubjectExtent === 'cut-off') return
              if (await decide(item, source, original)) continue
              return
            }
            if (attempt.plan.mode === 'uncertain' || attempt.checks.includes('uncertain-subject') || attempt.checks.includes('missing-protected-regions')) { item.status = 'needs-review'; item.reason = attempt.detailAnalysis && item.reason ? item.reason : attempt.plan.uncertainties.join('；') || 'uncertain-subject'; await save(); if (await decide(item, source, original)) continue; return }
            if (attempt.checks.length) continue
            item.status = reviewOnly ? 'reviewing' : 'rendering'; delete item.reason; delete item.errorCode; delete item.failedStep; await save()
            if (attempt.compositionMode === 'generated-canvas-protected-v2' && !attempt.generationInput) {
              const priorReview = item.attempts.slice(0, -1).findLast(row => row.review)?.review
              const subjectRepair = wallpaperSourceRepairNeeded(attempt.plan, settings) || !!priorReview && ['subject', 'clarity', 'composition', 'style'].some(key => priorReview.checks[key as keyof typeof priorReview.checks]?.result !== 'satisfied')
              if (subjectRepair) { attempt.compositionMode = 'generated-canvas-v1'; await save() }
            }
            const sourceRestoredCanvas = attempt.compositionMode === 'generated-canvas-protected-v2'
            const generatedCanvas = attempt.compositionMode === 'generated-canvas-v1' || sourceRestoredCanvas
            let rendered = await renderWallpaper(bytes, attempt.plan, settings, undefined, attempt.compositionMode)
            const editingPlan = attempt.layoutCorrection?.plan ?? attempt.plan, editingGeometry = attempt.layoutCorrection ? settings : source.geometry
            if (attempt.layoutCorrection && !attempt.generation) {
              const candidate = this.deps.domain.authorizedImage(editingPlan.imageVersionId, actor).image
              if (candidate.parentImageVersionId !== source.id || candidate.assetId !== source.assetId || candidate.geometry.width !== settings.width || candidate.geometry.height !== settings.height) throw new CuratorError('reference-unavailable', 'wallpaper-edit', 'The saved complete candidate does not belong to this original and frozen canvas.')
              rendered = await renderWallpaper(await this.deps.files.read(candidate.blob, ctx.signal), editingPlan, settings, undefined, 'generated-canvas-v1')
            }
            if (!attempt.layoutCorrection && prompts.outpaint.version === 'wallpaper-outpaint-v5' && attempt.retryFrom === 'reviewing' && attempt.retryTarget === 'rendering' && !attempt.generation && !attempt.canvasId) {
              const rejected = item.attempts.slice(0, -1).findLast(row => row.outputId && row.review)
              if (rejected?.outputId && contentDigest({ placement: rejected.plan.placement, regions: rejected.plan.regions }) === contentDigest({ placement: attempt.plan.placement, regions: attempt.plan.regions })) {
                const previous = this.deps.domain.authorizedImage(rejected.outputId, actor).image
                if (previous.parentImageVersionId !== source.id || previous.assetId !== source.assetId) throw new CuratorError('reference-unavailable', 'wallpaper-edit', 'The rejected editing canvas does not belong to this original.')
                rendered = await renderWallpaper(bytes, attempt.plan, settings, await this.deps.files.read(previous.blob, ctx.signal), attempt.compositionMode)
              }
            }
            const needsRepair = wallpaperSourceRepairNeeded(attempt.plan, settings) || wallpaperGenerativeRepair(settings) && attempt.retryTarget === 'rendering'
            const needsGeneration = rendered.geometry.needsOutpaint || needsRepair
            if (attempt.needsOutpaint !== needsGeneration) { attempt.needsOutpaint = needsGeneration; await save() }
            if (wallpaperGenerativeRepair(settings) && !attempt.outputId) {
              const clockPolicy = settings.processing?.clockContrast
              const priorReview = item.attempts.findLast(row => row.review)?.review
              const clockBackgroundNeedsEdit = !!clockPolicy && !priorReview && (await wallpaperClockContrast(
                await sharp(rendered.image).flatten({ background: { r: 128, g: 128, b: 128 } }).png().toBuffer(),
                editingPlan.imageVersionId, settings, clockPolicy,
              )).readableFraction < clockPolicy.minimumReadableFraction
              rendered.mask = await wallpaperRepairMask(rendered.mask, editingPlan, settings, item.attempts, editingGeometry, clockBackgroundNeedsEdit)
            }
            if (!attempt.canvasId || !attempt.maskId || !attempt.analysisId) {
              const canvas = await this.artifact(source, rendered.image, ctx, 'seed', item, attempt.revision), mask = await this.artifact(source, rendered.mask, ctx, 'mask', item, attempt.revision)
              const marked = await wallpaperOverlays(rendered.image, generatedCanvas ? { ...rendered.geometry, regions: [] } : rendered.geometry, settings), analysis = await this.artifact(source, marked.analysis, ctx, 'analysis', item, attempt.revision)
              attempt.canvasId = canvas.image.id; attempt.maskId = mask.image.id; attempt.layoutAnalysisId ??= analysis.image.id; attempt.analysisId = analysis.image.id; await save([...canvas.records, ...mask.records, ...analysis.records])
            }
            if (attempt.needsOutpaint && !attempt.outputId) {
              if (!this.deps.llm || !this.deps.attachments || typeof this.deps.llm.startImageGeneration !== 'function' || !settings.imageModel) { item.status = 'needs-review'; item.reason = 'image-capability-unavailable'; await save(); return }
              if (!attempt.generation) {
                if (recomposeOnly) throw new CuratorError('reference-unavailable', 'wallpaper-recompose', 'The saved image-generation receipt is unavailable; recomposition cannot request a new image.')
                if (!attempt.editReserved) {
                  if (item.edits >= settings.maxEditsPerImage) { item.status = 'needs-review'; item.reason = 'edit-limit'; await save(); return }
                  item.edits++; attempt.editReserved = true; attempt.generationOperation = contentDigest({ runId: ctx.runId, imageId: item.imageVersionId, revision: attempt.revision }).slice(10); await save()
                }
                ctx.signal.throwIfAborted()
                const canvasOnlyReferences = promptPreparation?.version === 'style-brief-v3' || sourceRestoredCanvas && promptPreparation?.version === 'style-brief-v2'
                const includeOriginalReference = attempt.generationInput ? attempt.generationInput.references.some(reference => reference.role === 'original') : promptPreparation?.enabled === true && promptPreparation.includeOriginalReference && !canvasOnlyReferences
                const preparedInputs = protectedContext ? await wallpaperGenerationReferences(bytes, rendered.image, (await wallpaperOverlays(rendered.image, rendered.geometry, settings)).analysis, editingPlan, opaqueCanvas ? 'opaque' : singleCanvas, includeOriginalReference) : [{ data: rendered.image, mediaType: 'image/png' as const, name: 'wallpaper-canvas.png', role: 'canvas' as const }, ...(includeOriginalReference ? [{ data: bytes, mediaType: 'image/png' as const, name: 'wallpaper-original-style-only.png', role: 'original' as const }] : [])]
                if (promptPreparation?.enabled && !attempt.opaqueCanvasId) {
                  const referenceCanvas = await this.artifact(source, preparedInputs[0]!.data, ctx, 'seed', item, attempt.revision)
                  attempt.opaqueCanvasId = referenceCanvas.image.id; await save(referenceCanvas.records)
                }
                if (promptPreparation?.enabled && !attempt.generationInput && !attempt.generationBrief?.status) {
                  const provider = await (providerPromise ??= this.deps.vision(ctx.spec.config))
                  const reasoningEffort = promptPreparation.reasoningEffort === 'highest' ? await provider.maximumReasoningEffort(ctx.signal) : promptPreparation.reasoningEffort
                  attempt.generationBrief = { status: 'running', requestId: `${ctx.runId}:${item.imageVersionId}:generation-brief:${attempt.revision}`, reasoningEffort }; await save()
                }
                if (promptPreparation?.enabled && !attempt.generationInput && attempt.generationBrief?.status === 'running') {
                  const brief = attempt.generationBrief
                  const editCanvas = this.deps.domain.require('imageVersion', attempt.opaqueCanvasId!), editCanvasBytes = await this.deps.files.read(editCanvas.blob, ctx.signal)
                  const result = await committed({ requestId: brief.requestId, wallpaperPrompt: generationPrompt!, reasoningEffort: brief.reasoningEffort, taskBrief, rules: visualRules,
                    images: [original, { imageVersionId: editCanvas.id, digest: editCanvas.blob.digest, mime: editCanvas.blob.mime, bytes: editCanvasBytes, role: 'positioned-edit-canvas' }],
                     usage: toJson({ settings: requestSettings, plan: editingPlan, previousReview: item.attempts.slice(0, -1).findLast(row => row.review)?.review, generationReferenceRoles: preparedInputs.map(input => input.role === 'canvas' ? 'positioned-canvas-master' : 'original-style-and-detail-only') }) }, 'wallpaper-plan', wallpaperGenerationBriefOutputSchema.safeExtend({ sourceImageVersionId: z.literal(source.id), canvasImageVersionId: z.literal(editCanvas.id) }))
                  attempt.generationBrief = { ...brief, status: 'saved', result }; await save()
                }
                const inputs = preparedInputs
                let references: readonly ImageAttachmentRef[]
                try { references = await this.deps.attachments.saveImages(inputs) }
                catch (error) {
                  if (!isAttachmentError(error)) throw error
                  throw new MediaError(error.code, 'wallpaper-edit', error.code === 'ATTACHMENT_WRITE_FAILED', 'The image references could not be admitted. The original and saved progress are retained.', 'Inspect the reference encoding and attachment limits; do not reduce source quality or dispatch another image automatically.')
                }
                const reference = references[0]
                if (!reference) throw new CuratorError('reference-unavailable', 'wallpaper-edit', 'The edit canvas attachment is unavailable.')
                const maskBytes = await sharp(rendered.mask).resize(reference.width, reference.height, { fit: 'fill', kernel: 'nearest' }).png().toBuffer()
                const mask = await this.deps.attachments.saveFile({ data: maskBytes, name: 'wallpaper-mask.png' })
                let task: ImageGenerationTask
                try { task = await this.deps.llm.getImageGeneration({ id: brandString<ImageGenerationId>(attempt.generationOperation!), provider: settings.imageProvider, model: settings.imageModel }, { signal: ctx.signal }) }
                catch (error) {
                  if (!(error instanceof Error) || !('code' in error) || error.code !== 'IMAGE_GENERATION_NOT_FOUND') throw error
                  const identities = inputs.map((input, index) => ({ role: input.role, attachmentId: references[index]!.attachmentId, width: references[index]!.width, height: references[index]!.height, ...('sourceRect' in input && input.sourceRect ? { sourceRect: input.sourceRect } : {}) }))
                  const prompt = protectedContext || attempt.generationBrief?.status === 'saved' ? wallpaperGenerationPrompt(prompts.outpaint.text, editingPlan, settings, identities, item.attempts, singleCanvas ? editingGeometry : undefined, opaqueCanvas, attempt.generationBrief?.status === 'saved' ? attempt.generationBrief.result : undefined) : prompts.outpaint.text
                  const generationInput = wallpaperGenerationInputSchema.parse({ version: opaqueCanvas ? 'wallpaper-edit-input-v3' : singleCanvas ? 'wallpaper-edit-input-v2' : 'wallpaper-edit-input-v1', prompt, references: identities })
                  if (wallpaperGenerativeRepair(settings)) {
                    const failures = item.attempts.filter(row => row !== attempt && row.generationInput?.prompt === prompt && row.review && wallpaperVerdict(row.review) !== 'pass')
                    if (failures.length >= settings.repairPolicy!.maxRepeatedDefects) { item.status = 'needs-review'; item.reason = 'repeated-repair-without-progress'; await save(); return }
                  }
                  if (attempt.generationInput && contentDigest(attempt.generationInput) !== contentDigest(generationInput)) throw new CuratorError('operation-conflict', 'wallpaper-edit', 'The saved image request differs from the current references. Keep the receipt for reconciliation before requesting another image.')
                  attempt.generationInput = generationInput; await save()
                  if (reviewBeforeResolution && generatedCanvas && !attempt.reviewReserved) {
                    await ctx.ledger.reserve('vision')
                    attempt.reviewReserved = true; await save()
                  }
                  task = await this.deps.llm.startImageGeneration({ id: brandString<ImageGenerationId>(attempt.generationOperation!), provider: settings.imageProvider, model: settings.imageModel, prompt, references, mask, size: settings.imageSize, quality: settings.imageQuality, signal: ctx.signal })
                }
                attempt.generation = handleSchema.parse(task); await save()
              }
              const saved = attempt.generation, handle: ImageGenerationHandle = { ...saved, id: brandString<ImageGenerationId>(saved.id), taskId: brandString<ImageGenerationTaskId>(saved.taskId) }
              let task: ImageGenerationTask = await this.deps.llm.getImageGeneration(handle, { waitMs: 0, signal: ctx.signal })
              while (task.state === 'queued' || task.state === 'sent') { ctx.signal.throwIfAborted(); task = await this.deps.llm.getImageGeneration(handle, { waitMs: Math.min(20_000, ctx.spec.config.limits.requestTimeoutMs), signal: ctx.signal }) }
              if (task.state !== 'succeeded' || !task.images.length || task.error) {
                if (attempt.reviewReserved) { ctx.ledger.releaseUnusedVision(); delete attempt.reviewReserved }
                item.status = 'technical-failed'; item.failedStep = 'rendering'; item.errorCode = task.error?.code ?? task.state; item.reason = task.error?.message ?? task.state; await save(); return
              }
              const generated = task.images[0]!, chunks: Uint8Array[] = []; let size = 0
              for await (const chunk of this.deps.attachments.readFileStream(generated.original, ctx.signal)) { size += chunk.byteLength; if (size > this.deps.files.limits.maxFileBytes) throw new CuratorError('invalid-input', 'wallpaper-edit', 'The generated original exceeds the configured media bound.'); chunks.push(chunk) }
              let generatedBytes = Buffer.concat(chunks)
              if (singleCanvas) {
                if (!attempt.generatedImageId) {
                  const artifact = await this.artifact(source, generatedBytes, ctx, 'seed', item, attempt.revision)
                  attempt.generatedImageId = artifact.image.id; await save(artifact.records)
                }
                attempt.generationAlignment ??= await wallpaperGenerationAlignment(bytes, generatedBytes, attempt.plan, settings, opaqueCanvas)
                await save()
                if (attempt.generationAlignment && !recomposeOnly && (!generatedCanvas || !wallpaperSourceRepairNeeded(attempt.plan, settings)) && ['reframed-source', 'misaligned-source'].includes(attempt.generationAlignment.result)) {
                  if (attempt.reviewReserved) { ctx.ledger.releaseUnusedVision(); delete attempt.reviewReserved }
                  item.reason = '生成结果未保持目标画布中受保护主体的位置或内容；已保留原始结果与回执，须重新编辑，不能回贴制造重复主体。'
                  if (item.edits >= settings.maxEditsPerImage || wallpaperReworkCount(item) >= settings.maxReworks) { item.status = 'needs-review'; item.reason = item.edits >= settings.maxEditsPerImage ? 'edit-limit' : 'rework-limit'; await save(); return }
                  item.attempts.push({ revision: attempt.revision + 1, createdAt: new Date().toISOString(), plan: structuredClone(attempt.plan), checks: [], needsOutpaint: true, compositionMode: attempt.compositionMode, ...(attempt.detailAnalysis ? { detailAnalysis: structuredClone(attempt.detailAnalysis) } : {}), retryFrom: 'rendering', retryTarget: 'rendering' })
                  item.status = 'rendering'; await save(); continue
                }
              }
              let backgroundBytes = generatedBytes
              if (attempt.generationInput && protectedContext) {
                let actual = await sharp(generatedBytes).metadata()
                if (!actual.width || !actual.height) throw new CuratorError('image-resolution-insufficient', 'wallpaper-background', 'The generated background dimensions are unavailable. Keep the original and generation receipt.')
                if (generatedCanvas && wallpaperGenerativeRepair(settings) && Math.abs(actual.width - actual.height * settings.width / settings.height) > 1) {
                  attempt.generationFramingFailure = { code: 'canvas-aspect-mismatch', width: actual.width, height: actual.height }
                  const cropWidth = Math.min(actual.width, Math.floor(actual.height * settings.width / settings.height)), cropHeight = Math.min(actual.height, Math.floor(actual.width * settings.height / settings.width))
                  const crop = { left: Math.floor((actual.width - cropWidth) / 2), top: Math.floor((actual.height - cropHeight) / 2), width: cropWidth, height: cropHeight }
                  const removedRatio = 1 - cropWidth * cropHeight / (actual.width * actual.height)
                  if (removedRatio <= wallpaperProcessingSchema.parse(settings.processing ?? {}).maxCanvasAspectCropRatio) {
                    const sourceDigest = createHash('sha256').update(generatedBytes).digest('hex'), savedCrop = attempt.generationCanvasCrop
                    if (savedCrop && savedCrop.sourceDigest === sourceDigest && savedCrop.width === crop.width && savedCrop.height === crop.height && savedCrop.left === crop.left && savedCrop.top === crop.top) generatedBytes = Buffer.from(await this.deps.files.read(this.deps.domain.require('imageVersion', savedCrop.croppedId).blob, ctx.signal))
                    else {
                      const sourceWidth = actual.width, sourceHeight = actual.height
                      generatedBytes = await sharp(generatedBytes).extract(crop).png().toBuffer()
                      const cropped = await this.artifact(source, generatedBytes, ctx, 'seed', item, attempt.revision)
                      attempt.generationCanvasCrop = { originalId: attempt.generatedImageId!, croppedId: cropped.image.id, sourceDigest, sourceWidth, sourceHeight, ...crop }
                      await save(cropped.records)
                    }
                    if (attempt.backgroundResolution?.status === 'failed' && !attempt.backgroundResolution.enhancedId) delete attempt.backgroundResolution
                    backgroundBytes = generatedBytes; actual = await sharp(generatedBytes).metadata()
                  } else {
                    if (attempt.reviewReserved) { ctx.ledger.releaseUnusedVision(); delete attempt.reviewReserved }
                    await save()
                    if (recomposeOnly || reviewOnly) throw new CuratorError('constraint-conflict', 'wallpaper-background', 'The saved generated canvas has the wrong aspect ratio. Continue image processing to correct it within the edit budget; review or reconstruction alone cannot generate another image.')
                    if (item.edits >= settings.maxEditsPerImage || wallpaperReworkCount(item) >= settings.maxReworks) { item.status = 'needs-review'; item.reason = item.edits >= settings.maxEditsPerImage ? 'edit-limit' : 'rework-limit'; await save(); return }
                    item.attempts.push({ revision: attempt.revision + 1, createdAt: new Date().toISOString(), plan: structuredClone(attempt.plan), checks: [], needsOutpaint: true, compositionMode: attempt.compositionMode, ...(attempt.detailAnalysis ? { detailAnalysis: structuredClone(attempt.detailAnalysis) } : {}), retryFrom: 'rendering', retryTarget: 'rendering' })
                    item.status = 'rendering'; await save(); continue
                  }
                }
                let nativeReviewArtifact: Awaited<ReturnType<typeof this.artifact>> | undefined
                if (reviewBeforeResolution && generatedCanvas) {
                  const reviewedBytes = sourceRestoredCanvas
                    ? await sharp((await renderWallpaper(bytes, attempt.plan, settings, generatedBytes, attempt.compositionMode)).image).resize(actual.width!, actual.height!, { fit: 'fill' }).png().toBuffer()
                    : generatedBytes
                  nativeReviewArtifact = await this.artifact(source, reviewedBytes, ctx, 'seed', item, attempt.revision)
                  if (attempt.preResolutionReview && (nativeReviewArtifact.image.id !== attempt.preResolutionReview.nativeId || nativeReviewArtifact.image.blob.digest !== attempt.preResolutionReview.nativeDigest)) throw new CuratorError('operation-conflict', 'wallpaper-review', 'The saved native review does not match the generated pixels.')
                  if (!sourceRestoredCanvas) generatedBytes = Buffer.from(await this.deps.files.read(nativeReviewArtifact.image.blob, ctx.signal))
                  backgroundBytes = generatedBytes
                }
                if (reviewBeforeResolution && generatedCanvas && !attempt.preResolutionReview) {
                  const native = nativeReviewArtifact!
                  const layout = await renderWallpaper(bytes, attempt.plan, settings, generatedBytes, attempt.compositionMode)
                  const sourceSeams = sourceRestoredCanvas ? await wallpaperSourceSeams(layout.image, layout.geometry.target, settings) : []
                  const preview = await this.artifact(source, layout.image, ctx, 'analysis', item, attempt.revision)
                  const overlays = await wallpaperOverlays(layout.image, { ...layout.geometry, regions: [] }, settings)
                  const analysis = await this.artifact(source, overlays.analysis, ctx, 'analysis', item, attempt.revision)
                  const simulation = await this.artifact(source, overlays.simulation, ctx, 'simulation', item, attempt.revision)
                  attempt.analysisId = analysis.image.id; attempt.simulationId = simulation.image.id
                  item.status = 'reviewing'; delete item.reason; delete item.errorCode; delete item.failedStep
                  await save([...native.records, ...preview.records, ...analysis.records, ...simulation.records])
                  const nativeBytes = sourceRestoredCanvas ? await this.deps.files.read(native.image.blob, ctx.signal) : generatedBytes
                  const input: VisionInput = { wallpaperPrompt: prompts.review, requestId: `${ctx.runId}:${item.imageVersionId}:review:${attempt.revision}`, taskBrief, rules: visualRules,
                    images: [{ imageVersionId: native.image.id, digest: native.image.blob.digest, mime: native.image.blob.mime, bytes: nativeBytes, role: 'actual-wallpaper' }, original, ...(settings.processing?.clockContrast ? [{ imageVersionId: simulation.image.id, digest: simulation.image.blob.digest, mime: simulation.image.blob.mime, bytes: await this.deps.files.read(simulation.image.blob, ctx.signal), role: 'lock-screen-simulation-only' }] : [])],
                     usage: toJson({ settings: requestSettings, ...(attempt.generationBrief?.status === 'saved' ? { originalStyleAndDetailRequirements: attempt.generationBrief.result } : {}), composition: { mode: attempt.compositionMode, nativeSourceRestored: sourceRestoredCanvas, sourcePlacement: attempt.plan.placement, reviewStage: 'native-generation-before-super-resolution', reviewedPixels: native.image.id, layoutPreview: preview.image.id, simulationIsResampledPreview: true, instruction: sourceRestoredCanvas ? 'Review the native-size generated background with deterministically restored healthy source pixels. Judge background transitions, actual subject placement, source correspondence, style, detail and clarity before super-resolution. Only an explicitly configured clock rule uses simulation.' : 'Review the complete native generated image. Compare its visible subjects, structure, style and details against the original after the planned uniform placement; model redrawing outside the blank area alone is not a defect. Independently check actual subject bounds and visible defects. The layout preview and optional lock-screen simulation are stored separately; only an explicitly configured clock rule uses simulation. Insufficient native dimensions alone call for super-resolution after this review, not automatic acceptance.' }, measured: { width: actual.width, height: actual.height, targetWidth: settings.width, targetHeight: settings.height } }) }
                  const schema = (prepared: VisionInput) => wallpaperReviewOutputSchema(prompts.review.version, prepared.rules.map(rule => rule.ruleId), prepared.images.map(image => image.imageVersionId), native.image.id, source.id, wallpaperGenerativeRepair(settings))
                  const reviewed = await committed(input, 'wallpaper-review', schema, attempt.reviewReserved === true)
                  attempt.review = release ? applyWallpaperStyleReview(reviewed, release, prompts.review.version) : applyWallpaperSourceReview(reviewed, wallpaperSubjectRepairAuthorized(attempt, settings), settings)
                  if (!settings.processing?.clockContrast) {
                    const currentReview = wallpaperStoredSourceReviewV4Schema.safeParse(attempt.review)
                    if (currentReview.success) attempt.review = applyWallpaperNoClockRequirement(currentReview.data)
                  }
                  if (sourceSeams.length) {
                    const currentReview = wallpaperStoredSourceReviewV4Schema.safeParse(attempt.review)
                    if (currentReview.success) attempt.review = applyWallpaperSourceSeams(currentReview.data, sourceSeams)
                  }
                  let sourceReview = wallpaperStoredSourceReviewV4Schema.safeParse(attempt.review)
                  if (sourceReview.success && settings.processing?.clockContrast) {
                    const contrast = await wallpaperClockContrast(layout.image, preview.image.id, settings, settings.processing.clockContrast)
                    attempt.review = applyWallpaperClockContrast(sourceReview.data, contrast)
                    sourceReview = wallpaperStoredSourceReviewV4Schema.safeParse(attempt.review)
                  }
                  if (sourceReview.success && settings.processing) {
                    const targets = wallpaperCriticalReviewTargets(sourceReview.data), focus = wallpaperCriticalReviewFocus(sourceReview.data)
                    const provider = await (providerPromise ??= this.deps.vision(ctx.spec.config))
                    if (targets.length && focus && provider.config.supportsMultiImage && provider.config.maxImages >= 5) {
                      const requestId = `${input.requestId}:critical-detail`
                      const detailInput: VisionInput = { ...input, requestId, wallpaperPrompt: { ...input.wallpaperPrompt!, text: `${input.wallpaperPrompt!.text}\n本次是唯一一次high局部复核，仅针对${targets.join('、')}的unknown；局部边缘不是画布边缘，其余确定结论保持原状。` }, reasoningEffort: settings.processing.criticalReasoningEffort,
                        detailRegions: [{ imageVersionId: source.id, rect: focus.sourceRect }, { imageVersionId: native.image.id, rect: focus.outputRect }],
                        usage: toJson({ ...typeof input.usage === 'object' && input.usage !== null ? input.usage : {}, criticalReview: { targets, question: focus.question, initialChecks: sourceReview.data.checks } }) }
                      const detail = await committed(detailInput, 'wallpaper-review', schema)
                      const checked = wallpaperStoredSourceReviewV4Schema.parse(applyWallpaperSourceReview(detail, wallpaperSubjectRepairAuthorized(attempt, settings), settings))
                      attempt.review = applyWallpaperCriticalDetail(sourceReview.data, checked, settings, requestId)
                    }
                  }
                  attempt.preResolutionReview = { nativeId: native.image.id, nativeDigest: native.image.blob.digest, previewId: preview.image.id, simulationId: simulation.image.id }
                  if (!settings.processing?.clockContrast) {
                    const currentReview = wallpaperStoredSourceReviewV4Schema.safeParse(attempt.review)
                    if (currentReview.success) attempt.review = applyWallpaperNoClockRequirement(currentReview.data)
                  }
                  attempt.reviewedAt = new Date().toISOString()
                  await save()
                  const earlyVerdict = wallpaperVerdict(attempt.review)
                  if (earlyVerdict !== 'pass') {
                    attempt.outputId = preview.image.id
                    item.reason = attempt.review.issues.map(issue => issue.reason).join('；')
                    if (!reviewOnly && wallpaperReviewReworkAvailable(item, settings)) { item.status = wallpaperEditingRetry(item, settings) ? 'rendering' : 'planning'; await save(); continue }
                    if (!reviewOnly && (wallpaperGenerativeRepair(settings) || attempt.needsOutpaint) && item.edits >= settings.maxEditsPerImage) item.reason = 'edit-limit'
                    else if (!reviewOnly && wallpaperReworkCount(item) >= settings.maxReworks) item.reason = 'rework-limit'
                    item.status = earlyVerdict === 'reject' && reviewOnly ? 'rejected' : 'needs-review'; await save(); return
                  }
                }
                if (actual.width < settings.width || actual.height < settings.height) {
                  if (!settings.backgroundResolution?.enabled || !generatedCanvas && attempt.compositionMode !== 'protected-context-v2') throw new CuratorError('image-resolution-insufficient', 'wallpaper-background', `Generated background is ${actual.width}×${actual.height}; at least ${settings.width}×${settings.height} is required. The original result and receipt are retained. Explicit reconstruction and independent review are required; do not interpolate or request another image automatically.`)
                  const digest = `sha256-v1:${createHash('sha256').update(generatedBytes).digest('hex')}`
                  if (attempt.backgroundResolution && attempt.backgroundResolution.input.digest !== digest) throw new CuratorError('operation-conflict', 'wallpaper-background', 'The saved provider image differs from the background reconstruction evidence.')
                  if (!attempt.backgroundResolution?.enhancedId) {
                    const cached = item.attempts.findLast(row => row !== attempt && row.backgroundResolution?.input.digest === digest && row.backgroundResolution.policyDigest === contentDigest(settings.backgroundResolution) && row.backgroundResolution.model === 'espcn-x3-luma' && row.backgroundResolution.modelSha256 === espcnWeightsDigest && row.backgroundResolution.enhancedId && row.backgroundResolution.output?.width === settings.width && row.backgroundResolution.output.height === settings.height)
                    if (cached?.backgroundResolution) attempt.backgroundResolution = { ...structuredClone(cached.backgroundResolution), status: 'reviewing', reusedFromRevision: cached.revision }
                  }
                  if (!attempt.backgroundResolution?.originalId) {
                    const originalBackground = await this.artifact(source, generatedBytes, ctx, 'seed', item, attempt.revision)
                    attempt.backgroundResolution = { status: 'enhancing', reason: '', input: { width: actual.width, height: actual.height, digest }, originalId: originalBackground.image.id, policyDigest: contentDigest(settings.backgroundResolution) }
                    await save(originalBackground.records)
                  }
                  if (attempt.backgroundResolution.enhancedId) backgroundBytes = Buffer.from(await this.deps.files.read(this.deps.domain.require('imageVersion', attempt.backgroundResolution.enhancedId).blob, ctx.signal))
                  else {
                    attempt.backgroundResolution.status = 'enhancing'; attempt.backgroundResolution.reason = ''; await save()
                    const resolved = await this.trackEnhancement(ctx.runId, item.imageVersionId, attempt.revision, 'background', progress => superResolveWallpaperBackground({ bytes: generatedBytes, width: settings.width, height: settings.height, policy: settings.backgroundResolution!, maxPixels: this.deps.files.limits.maxPixels }, ctx.signal, progress))
                    const enhanced = await this.artifact(source, resolved.bytes, ctx, 'seed', item, attempt.revision)
                    attempt.backgroundResolution = { ...attempt.backgroundResolution, status: 'reviewing', enhancedId: enhanced.image.id, output: { width: resolved.outputWidth, height: resolved.outputHeight }, ...('nativeOutputWidth' in resolved ? { nativeOutput: { width: resolved.nativeOutputWidth, height: resolved.nativeOutputHeight } } : {}), model: resolved.model, modelSha256: resolved.modelSha256, durationMs: resolved.durationMs, pixels: resolved.pixels, tiles: resolved.tiles }
                    await save(enhanced.records)
                    backgroundBytes = Buffer.from(resolved.bytes)
                  }
                }
              }
              rendered = await renderWallpaper(bytes, attempt.plan, settings, backgroundBytes, attempt.compositionMode)
            }
            if (!attempt.outputId) {
              const output = await this.artifact(source, rendered.image, ctx, 'final', item, attempt.revision, attempt.needsOutpaint ? 'composition' : 'crop')
              attempt.outputId = output.image.id; await save(output.records)
            }
            if (reviewBeforeResolution && generatedCanvas && attempt.preResolutionReview && attempt.review && wallpaperVerdict(attempt.review) === 'pass') {
              const proof = attempt.preResolutionReview, native = this.deps.domain.require('imageVersion', proof.nativeId)
              if (native.blob.digest !== proof.nativeDigest || proof.simulationId !== attempt.simulationId) throw new CuratorError('operation-conflict', 'wallpaper-review', 'The saved native review evidence changed before delivery.')
              const output = this.deps.domain.require('imageVersion', attempt.outputId!), finalBytes = await this.deps.files.read(output.blob, ctx.signal)
              const metadata = await sharp(finalBytes).metadata()
              if (metadata.format !== 'png' || metadata.width !== settings.width || metadata.height !== settings.height || !(await sharp(finalBytes).stats()).isOpaque) throw new CuratorError('constraint-conflict', 'wallpaper-output', 'The processed image failed format, dimensions or opacity validation.')
              if (sourceRestoredCanvas && attempt.backgroundResolution) {
                const seams = await wallpaperSourceSeams(finalBytes, rendered.geometry.target, settings)
                if (seams.length) {
                  attempt.review = applyWallpaperSourceSeams(wallpaperStoredSourceReviewV4Schema.parse(attempt.review), seams)
                  item.reason = attempt.review.issues.map(issue => issue.reason).join('；')
                  if (!reviewOnly && wallpaperReviewReworkAvailable(item, settings)) { item.status = wallpaperEditingRetry(item, settings) ? 'rendering' : 'planning'; await save(); continue }
                  item.status = 'needs-review'; await save(); return
                }
              }
              if (attempt.backgroundResolution) {
                const resolution = attempt.backgroundResolution
                const backgroundInput = resolution.originalId ? this.deps.domain.require('imageVersion', resolution.originalId) : undefined
                if (resolution.input.digest !== `sha256-v1:${sourceRestoredCanvas ? backgroundInput?.blob.digest : native.blob.digest}` || !resolution.enhancedId || resolution.model !== 'espcn-x3-luma' || resolution.modelSha256 !== espcnWeightsDigest || resolution.output?.width !== settings.width || resolution.output.height !== settings.height) throw new CuratorError('operation-conflict', 'wallpaper-background', 'The final image lacks matching reconstruction evidence.')
                resolution.status = 'passed'; resolution.reason = 'Native generated image reviewed before super-resolution; output passed technical validation.'
              }
              proof.finalId = output.id
              const stamp = new Date().toISOString(), base = { schemaVersion: 1, profileId: source.profileId, createdAt: stamp }
              const assessment = assessmentSchema.parse({ ...base, id: `wallpaper-review-${contentDigest({ runId: ctx.runId, output: output.id }).slice(10)}`, kind: 'assessment', imageVersionId: output.id, runId: ctx.runId, stage: 'final', ...reviewIdentity, reviewBundleId: `${ctx.runId}:${item.imageVersionId}:${attempt.revision}`, technicalStatus: 'completed', verdict: 'pass', ruleResults: [], cropPotential: 'direct', preferenceScores: {}, data: toJson({ wallpaperReview: attempt.review, settings, reviewedImageVersionId: native.id, reviewedDigest: proof.nativeDigest, deliveredImageVersionId: output.id, postProcessing: attempt.backgroundResolution ? { kind: 'super-resolution', model: attempt.backgroundResolution.model, modelSha256: attempt.backgroundResolution.modelSha256 } : { kind: 'none' }, postResolutionModelReview: false }) })
              const selection = selectionSchema.parse({ ...base, id: `wallpaper-selection-${contentDigest({ runId: ctx.runId, imageId: item.imageVersionId }).slice(10)}`, kind: 'selection', runId: ctx.runId, imageVersionId: output.id, assessmentId: assessment.id, qualification: 'auto-qualified', rank: state.items.indexOf(item), warnings: 'layoutWarnings' in attempt.review ? attempt.review.layoutWarnings : [] })
              item.status = 'passed'; delete item.reason; await save([assessment, selection]); await deliverApproved(item); return
            }
            if (attempt.clarity?.originalOutputId && !attempt.clarity.enhancedOutputId && ['enhancing', 'failed'].includes(attempt.clarity.status) && settings.clarity && !reviewOnly && (!recomposeOnly || generatedCanvas)) {
              item.status = 'rendering'; attempt.clarity.status = 'enhancing'; await save()
              const baseline = this.deps.domain.require('imageVersion', attempt.clarity.originalOutputId)
              const pixelRect = (region: typeof rendered.geometry.regions[number]) => {
                const left = Math.max(0, Math.floor(region.left)), top = Math.max(0, Math.floor(region.top))
                return { left, top, width: Math.min(settings.width, Math.ceil(region.left + region.width)) - left, height: Math.min(settings.height, Math.ceil(region.top + region.height)) - top }
              }
              const savedReview = attempt.clarityBaseReview
              const clarityGeometry = generatedCanvas && savedReview && 'reviewVersion' in savedReview && (savedReview.reviewVersion === 'wallpaper-review-source-v3' || savedReview.reviewVersion === 'wallpaper-review-source-v4') ? wallpaperGeometry(baseline.geometry, { ...attempt.plan, regions: savedReview.actualLayout.regions, placement: { scale: 1, left: 0, top: 0 } }, settings) : rendered.geometry
              const enhanced = await this.trackEnhancement(ctx.runId, item.imageVersionId, attempt.revision, 'subject', async progress => enhanceWallpaper({ bytes: await this.deps.files.read(baseline.blob, ctx.signal), regions: clarityGeometry.regions.filter(region => generatedCanvas || region.role === 'subject').map(pixelRect), protectedRegions: generatedCanvas ? [] : clarityGeometry.regions.filter(region => region.role !== 'subject').map(pixelRect), policy: settings.clarity!, maxPixels: this.deps.files.limits.maxPixels }, ctx.signal, progress))
              if (!enhanced.changedPixels) {
                attempt.clarity = { ...attempt.clarity, status: 'needs-review', reason: 'clarity-no-visible-change', durationMs: enhanced.durationMs, pixels: enhanced.pixels, tiles: enhanced.tiles, changedPixels: 0 }
                if (attempt.clarityBaseReview) attempt.review = attempt.clarityBaseReview
                item.status = 'needs-review'; item.reason = 'clarity-no-visible-change'; await save(); return
              }
              const artifact = await this.artifact(baseline, enhanced.bytes, ctx, 'clarity', item, attempt.revision)
              attempt.outputId = artifact.image.id
              attempt.clarity = { ...attempt.clarity, status: 'reviewing', enhancedOutputId: artifact.image.id, model: enhanced.model, modelSha256: enhanced.modelSha256, durationMs: enhanced.durationMs, pixels: enhanced.pixels, tiles: enhanced.tiles, changedPixels: enhanced.changedPixels }
              delete attempt.analysisId; delete attempt.simulationId; delete attempt.review
              await save(artifact.records)
            }
            const output = this.deps.domain.require('imageVersion', attempt.outputId), finalBytes = await this.deps.files.read(output.blob, ctx.signal)
            if (!attempt.analysisId || !attempt.simulationId) {
              const overlays = await wallpaperOverlays(finalBytes, generatedCanvas ? { ...rendered.geometry, regions: [] } : rendered.geometry, settings), analysis = await this.artifact(source, overlays.analysis, ctx, 'analysis', item, attempt.revision), simulation = await this.artifact(source, overlays.simulation, ctx, 'simulation', item, attempt.revision)
              attempt.analysisId = analysis.image.id; attempt.simulationId = simulation.image.id; await save([...analysis.records, ...simulation.records])
            }
            if (output.geometry.width !== settings.width || output.geometry.height !== settings.height) throw new CuratorError('constraint-conflict', 'wallpaper-output', 'Actual output dimensions differ from the frozen template.')
            if (!(await sharp(finalBytes).stats()).isOpaque) throw new CuratorError('constraint-conflict', 'wallpaper-output', 'The actual wallpaper contains unfilled transparent pixels.')
            item.status = 'reviewing'; delete item.reason; delete item.errorCode; delete item.failedStep
            if (attempt.backgroundResolution) { attempt.backgroundResolution.status = 'reviewing'; attempt.backgroundResolution.reason = '' }
            await save()
            const measuredClock = generatedCanvas && wallpaperGenerativeRepair(settings) && settings.processing?.clockContrast ? await wallpaperClockContrast(finalBytes, output.id, settings, settings.processing.clockContrast) : undefined
            const simulation = this.deps.domain.require('imageVersion', attempt.simulationId!)
            if (!attempt.review) {
              const imageDigest = (id: string | undefined) => id ? this.deps.domain.require('imageVersion', id).blob.digest : undefined
              const subjectRects = (plan: WallpaperPlan) => plan.regions.filter(region => region.role === 'subject').map(region => region.rect)
              const unchangedFailure = !reviewOnly && !recomposeOnly && prompts.detail && item.attempts.slice(0, -1).some(prior => prior.review && wallpaperVerdict(prior.review) === 'reject' && prior.outputId && prior.simulationId
                && imageDigest(prior.outputId) === output.blob.digest && imageDigest(prior.simulationId) === simulation.blob.digest
                && (contentDigest(subjectRects(prior.plan)) === contentDigest(subjectRects(attempt.plan)) || [prior.review.checks.clock, prior.review.checks.readability, prior.review.checks.composition, prior.review.checks.background, prior.review.checks.style].some(check => check.result === 'violated'))
                && imageDigest(prior.clarity?.originalOutputId) === imageDigest(attempt.clarity?.originalOutputId))
              if (unchangedFailure) { item.status = 'needs-review'; item.failedStep = 'reviewing'; item.reason = 'unchanged-review-evidence'; await save(); return }
              const input: VisionInput = { wallpaperPrompt: prompts.review, requestId: `${ctx.runId}:${item.imageVersionId}:review:${attempt.revision}`, taskBrief, rules: visualRules, images: [{ imageVersionId: output.id, digest: output.blob.digest, mime: output.blob.mime, bytes: finalBytes, role: 'actual-wallpaper' }, original, ...(settings.processing?.clockContrast || prompts.review.version !== 'wallpaper-review-source-v4' ? [{ imageVersionId: simulation.id, digest: simulation.blob.digest, mime: simulation.blob.mime, bytes: await this.deps.files.read(simulation.blob, ctx.signal), role: 'lock-screen-simulation-only' }] : [])], usage: toJson({ settings: requestSettings, ...(attempt.generationBrief?.status === 'saved' ? { originalStyleAndDetailRequirements: attempt.generationBrief.result } : {}), ...(wallpaperSubjectRepairAuthorized(attempt, settings) ? { edgeRepair: attempt.detailAnalysis?.edgeRepair } : {}), ...(attempt.detailAnalysis?.retainedUncertainties?.length ? { retainedUnknowns: attempt.detailAnalysis.retainedUncertainties } : {}), ...(release && (prompts.review.version === 'wallpaper-review-v2' || (prompts.review.version === 'wallpaper-review-v3' || prompts.review.version === 'wallpaper-review-v4') && wallpaperReviewVersion(release) === 'wallpaper-review-v2') ? { stylePolicy: wallpaperStylePolicy(release) } : {}), ...(generatedCanvas ? { composition: { mode: attempt.compositionMode, nativeSourceRestored: sourceRestoredCanvas, instruction: sourceRestoredCanvas ? 'Healthy source pixels were deterministically restored onto the generated background. Review actual visible transitions and remaining quality defects.' : wallpaperGenerativeRepair(settings) ? wallpaperRepairInstructions : 'The actual wallpaper is one complete generated canvas. Original placement is planning evidence only. No native source pixels were pasted over it. Compare visible object identity, count, structure, relative arrangement, colors, materials, markings and text against the original after accounting for one whole-group translation and uniform scale. Independently observe actual final subject and critical regions, then check frozen bounds, completeness and clarity. Apply clock readability only when explicitly configured. Local deformation, independent object movement, new or missing objects, defects and uncertainty prevent acceptance.' } } : {}), measured: { width: output.geometry.width, height: output.geometry.height, protectedSourceRegions: sourceRestoredCanvas || !generatedCanvas && !attempt.clarity?.enhancedOutputId, backgroundTransitionPixels: settings.backgroundTransitionPixels, ...(rendered.generatedSize ? { generatedSize: rendered.generatedSize } : {}) } }) }
              if ((!settings.processing || !wallpaperGenerativeRepair(settings)) && (prompts.review.version === 'wallpaper-review-v4' || prompts.review.version === 'wallpaper-review-source-v1' || prompts.review.version === 'wallpaper-review-source-v2' || prompts.review.version === 'wallpaper-review-source-v3' || prompts.review.version === 'wallpaper-review-source-v4')) {
                const subjects = attempt.plan.regions.filter(region => region.role === 'subject')
                if (subjects.length) {
                  const bounds = (rects: { x: number; y: number; width: number; height: number }[]) => {
                    const left = Math.min(...rects.map(rect => rect.x)), top = Math.min(...rects.map(rect => rect.y)), right = Math.max(...rects.map(rect => rect.x + rect.width)), bottom = Math.max(...rects.map(rect => rect.y + rect.height))
                    const x = Math.max(0, left - (right - left) * 0.05), y = Math.max(0, top - (bottom - top) * 0.05)
                    return { x, y, width: Math.min(1, right + (right - left) * 0.05) - x, height: Math.min(1, bottom + (bottom - top) * 0.05) - y }
                  }
                  const observed = item.attempts.slice(0, -1).findLast(prior => prior.outputId === output.id && prior.review && 'reviewVersion' in prior.review && (prior.review.reviewVersion === 'wallpaper-review-source-v3' || prior.review.reviewVersion === 'wallpaper-review-source-v4'))?.review
                  const baseReview = attempt.clarityBaseReview
                  const actualRegions = baseReview && 'reviewVersion' in baseReview && (baseReview.reviewVersion === 'wallpaper-review-source-v3' || baseReview.reviewVersion === 'wallpaper-review-source-v4') ? baseReview.actualLayout.regions : observed && 'reviewVersion' in observed && (observed.reviewVersion === 'wallpaper-review-source-v3' || observed.reviewVersion === 'wallpaper-review-source-v4') ? observed.actualLayout.regions : undefined
                  input.detailRegions = [{ imageVersionId: source.id, rect: bounds((generatedCanvas ? attempt.plan.regions : subjects).map(region => region.rect)) }, { imageVersionId: output.id, rect: generatedCanvas ? actualRegions ? bounds(actualRegions.map(region => region.rect)) : { x: 0, y: 0, width: 1, height: 1 } : bounds(rendered.geometry.regions.filter(region => region.role === 'subject').map(region => ({ x: region.left / settings.width, y: region.top / settings.height, width: region.width / settings.width, height: region.height / settings.height }))) }]
                }
              }
              if (attempt.clarity?.enhancedOutputId && attempt.clarity.originalOutputId) {
                const before = this.deps.domain.require('imageVersion', attempt.clarity.originalOutputId)
                input.images = [...input.images, { imageVersionId: before.id, digest: before.blob.digest, mime: before.blob.mime, bytes: await this.deps.files.read(before.blob, ctx.signal), role: 'wallpaper-before-enhancement' }]
                input.usage = { ...typeof input.usage === 'object' && input.usage !== null ? input.usage : {}, clarity: { enhanced: true, ...attempt.clarity, policy: settings.clarity, unchangedCriticalRegions: !generatedCanvas } }
              }
              if (attempt.backgroundResolution?.originalId) {
                const background = this.deps.domain.require('imageVersion', attempt.backgroundResolution.originalId)
                input.images = [...input.images, { imageVersionId: background.id, digest: background.blob.digest, mime: background.blob.mime, bytes: await this.deps.files.read(background.blob, ctx.signal), role: 'background-before-super-resolution-only' }]
                input.usage = { ...typeof input.usage === 'object' && input.usage !== null ? input.usage : {}, backgroundResolution: { ...attempt.backgroundResolution, policy: settings.backgroundResolution, nativeGeneration: false, protectedSourceRegions: !generatedCanvas, acceptance: wallpaperGenerativeRepair(settings) ? wallpaperRepairInstructions : generatedCanvas ? `This standalone canvas is the complete saved model image, reconstructed by ${attempt.backgroundResolution.model}. No original pixels were pasted over it. Compare every subject, identity, structure, relative arrangement, color, material, text and marking against the supplied original after accounting for whole-group translation and uniform scale. Verify actual full-frame subject safety bounds, completeness and clarity; apply clock readability only when explicitly configured. Reject changes, missing structures, duplicated objects, invented textures, blur or uncertainty. Saved native placement is a planning reference, not evidence that generated subjects stayed inside it.` : `The saved low-resolution background was reconstructed by ${attempt.backgroundResolution.model}, not generated at the target resolution. Compare editable background against its original and the actual final wallpaper. Reject visible tile seams, ringing, halos, changed color, invented structures or unnatural ground, sky and horizon transitions. Source subject and critical regions were pasted last from the original; judge their actual clarity and every existing check without relaxing any criterion.` } }
              }
              const reviewSchema = (prepared: VisionInput) => wallpaperReviewOutputSchema(prompts.review.version, prepared.rules.map(rule => rule.ruleId), prepared.images.map(image => image.imageVersionId), output.id, source.id, wallpaperGenerativeRepair(settings))
              const review = await committed(input, 'wallpaper-review', reviewSchema)
              attempt.review = release ? applyWallpaperStyleReview(review, release, prompts.review.version) : applyWallpaperSourceReview(review, wallpaperSubjectRepairAuthorized(attempt, settings), settings)
              if (!settings.processing?.clockContrast) {
                const currentReview = wallpaperStoredSourceReviewV4Schema.safeParse(attempt.review)
                if (currentReview.success) attempt.review = applyWallpaperNoClockRequirement(currentReview.data)
              }
              await save()
              let canvasReview = wallpaperStoredSourceReviewV4Schema.safeParse(attempt.review)
              if (measuredClock && canvasReview.success) {
                attempt.review = applyWallpaperClockContrast(canvasReview.data, measuredClock)
                canvasReview = wallpaperStoredSourceReviewV4Schema.safeParse(attempt.review)
                await save()
              }
              if (settings.processing && generatedCanvas && canvasReview.success) {
                const targets = wallpaperCriticalReviewTargets(canvasReview.data)
                const focus = wallpaperCriticalReviewFocus(canvasReview.data)
                const provider = await (providerPromise ??= this.deps.vision(ctx.spec.config))
                if (targets.length && focus && provider.config.supportsMultiImage && provider.config.maxImages >= 5) {
                  const previous = item.attempts.flatMap(row => {
                    const review = wallpaperStoredSourceReviewV4Schema.safeParse(row.review)
                    return row.plan.imageVersionId === source.id && row.outputId && imageDigest(row.outputId) === output.blob.digest && review.success ? [review.data] : []
                  })
                  const { evidenceDigest, cached, mayInspect } = wallpaperCriticalReviewHistory({ source: source.blob.digest, output: output.blob.digest, focus, targets }, previous)
                  if (cached) {
                    attempt.review = applyWallpaperCriticalDetail(canvasReview.data, cached, settings, cached.criticalDetail!.requestId)
                  } else if (mayInspect) {
                  const requestId = `${input.requestId}:critical-detail`
                  const detailInput: VisionInput = { ...input, requestId, wallpaperPrompt: { ...input.wallpaperPrompt!, text: `${input.wallpaperPrompt!.text}\n本次是唯一一次high局部复核，仅针对${targets.join('、')}的unknown；使用本次原图与成品局部真实像素。局部图的边缘不是画布边缘。其余已确定结论保持原状，不能因重新叙述而改判。` }, reasoningEffort: settings.processing.criticalReasoningEffort,
                    images: input.images.filter(image => ['actual-wallpaper', 'wallpaper-original', 'lock-screen-simulation-only'].includes(image.role)),
                    detailRegions: [{ imageVersionId: source.id, rect: focus.sourceRect }, { imageVersionId: output.id, rect: focus.outputRect }],
                    usage: toJson({ ...typeof input.usage === 'object' && input.usage !== null ? input.usage : {}, criticalReview: { targets, question: focus.question, initialChecks: canvasReview.data.checks, initialSourceCorrespondence: canvasReview.data.sourceCorrespondence, initialSourceRepair: canvasReview.data.sourceRepair } }) }
                  const detail = await committed(detailInput, 'wallpaper-review', reviewSchema)
                  const checked = wallpaperStoredSourceReviewV4Schema.parse(applyWallpaperSourceReview(detail, wallpaperSubjectRepairAuthorized(attempt, settings), settings))
                  const merged = applyWallpaperCriticalDetail(canvasReview.data, checked, settings, requestId)
                  attempt.review = wallpaperStoredSourceReviewV4Schema.parse({ ...merged, criticalDetail: { ...merged.criticalDetail, evidenceDigest } })
                  }
                }
              }
            }
            if (measuredClock) {
              const currentReview = wallpaperStoredSourceReviewV4Schema.safeParse(attempt.review)
              if (currentReview.success) attempt.review = applyWallpaperClockContrast(currentReview.data, measuredClock)
            }
            if (!settings.processing?.clockContrast) {
              const currentReview = wallpaperStoredSourceReviewV4Schema.safeParse(attempt.review)
              if (currentReview.success) attempt.review = applyWallpaperNoClockRequirement(currentReview.data)
            }
            attempt.reviewedAt = new Date().toISOString()
            if (attempt.review && 'reviewVersion' in attempt.review && (attempt.review.reviewVersion === 'wallpaper-review-source-v3' || attempt.review.reviewVersion === 'wallpaper-review-source-v4')) {
              const actual = wallpaperGeometry(output.geometry, { ...attempt.plan, regions: attempt.review.actualLayout.regions, placement: { scale: 1, left: 0, top: 0 } }, settings)
              const overlays = await wallpaperOverlays(finalBytes, actual, settings)
              const analysis = await this.artifact(source, overlays.analysis, ctx, 'analysis', item, attempt.revision)
              attempt.analysisId = analysis.image.id; await save(analysis.records)
            }
            await save()
            if ('clarity' in attempt.review.checks) {
              const check = attempt.review.checks.clarity
              attempt.clarity = { ...attempt.clarity, status: check.result === 'satisfied' ? attempt.clarity?.enhancedOutputId ? 'passed' : 'not-needed' : 'needs-review', reason: check.reason }
              const otherChecksPassed = Object.entries(attempt.review.checks).every(([key, row]) => key === 'clarity' || row.result === 'satisfied') && (!('sourceRepair' in attempt.review) || attempt.review.sourceRepair.result === 'satisfied') && (!('sourceCorrespondence' in attempt.review) || attempt.review.sourceCorrespondence.result === 'satisfied')
              if (check.result === 'violated' && otherChecksPassed) {
                if (settings.clarity?.enabled && !reviewOnly && (!recomposeOnly || generatedCanvas) && !item.attempts.some(row => row.clarity?.enhancedOutputId) && attempt.plan.regions.some(region => region.role === 'subject')) {
                  attempt.clarity = { ...attempt.clarity, status: 'enhancing', originalOutputId: output.id }
                  attempt.clarityBaseReview = attempt.review; delete attempt.review
                  await save(); continue
                }
                if (!wallpaperGenerativeRepair(settings)) { item.status = 'needs-review'; item.reason = check.reason; await save(); return }
              }
              await save()
            }
            const verdict = wallpaperVerdict(attempt.review)
            if (attempt.backgroundResolution) {
              Object.assign(attempt.backgroundResolution, wallpaperBackgroundReview(attempt.review))
              await save()
            }
            if (verdict === 'pass') {
              const stamp = new Date().toISOString(), base = { schemaVersion: 1, profileId: source.profileId, createdAt: stamp }
              const assessment = assessmentSchema.parse({ ...base, id: `wallpaper-review-${contentDigest({ runId: ctx.runId, output: output.id }).slice(10)}`, kind: 'assessment', imageVersionId: output.id, runId: ctx.runId, stage: 'final', ...reviewIdentity, reviewBundleId: `${ctx.runId}:${item.imageVersionId}:${attempt.revision}`, technicalStatus: 'completed', verdict: 'pass', ruleResults: [], cropPotential: 'direct', preferenceScores: {}, data: toJson({ wallpaperReview: attempt.review, settings, inferredRegions: true }) })
              const selection = selectionSchema.parse({ ...base, id: `wallpaper-selection-${contentDigest({ runId: ctx.runId, imageId: item.imageVersionId }).slice(10)}`, kind: 'selection', runId: ctx.runId, imageVersionId: output.id, assessmentId: assessment.id, qualification: 'auto-qualified', rank: state.items.indexOf(item), warnings: 'layoutWarnings' in attempt.review ? attempt.review.layoutWarnings : [] })
              item.status = 'passed'; delete item.reason
              await save([assessment, selection])
              await deliverApproved(item)
              return
            }
            item.reason = attempt.review.issues.map(issue => issue.reason).join('；')
            if (reviewOnly || 'subjectIntegrity' in attempt.review && attempt.review.subjectIntegrity.source.extent === 'cut-off' && !('sourceRepairAuthorized' in attempt.review && attempt.review.sourceRepairAuthorized === true)) {
              const assessment = assessmentSchema.parse({ schemaVersion: 1, profileId: source.profileId, createdAt: new Date().toISOString(), id: `wallpaper-review-${contentDigest({ runId: ctx.runId, output: output.id }).slice(10)}`, kind: 'assessment', imageVersionId: output.id, runId: ctx.runId, stage: 'final', ...reviewIdentity, reviewBundleId: `${ctx.runId}:${item.imageVersionId}:${attempt.revision}`, technicalStatus: 'completed', verdict, ruleResults: [], cropPotential: 'direct', preferenceScores: {}, data: toJson({ wallpaperReview: attempt.review, settings, inferredRegions: true }) })
              item.status = verdict === 'reject' ? 'rejected' : 'needs-review'; await save([assessment]); return
            }
            if (recomposeOnly || 'styleMatch' in attempt.review && attempt.review.checks.style.result !== 'satisfied' && Object.entries(attempt.review.checks).every(([key, check]) => key === 'style' || check.result === 'satisfied')) { item.status = 'needs-review'; await save(); return }
            if (wallpaperReviewReworkAvailable(item, settings)) { item.status = wallpaperEditingRetry(item, settings) ? 'rendering' : 'planning'; await save(); continue }
            if (verdict === 'needs-review') { item.status = 'needs-review'; await save(); if (await decide(item, source, original)) continue; return }
            if (attempt.needsOutpaint && item.edits >= settings.maxEditsPerImage || wallpaperReworkCount(item) >= settings.maxReworks) {
              item.status = 'needs-review'; item.reason = attempt.needsOutpaint && item.edits >= settings.maxEditsPerImage ? 'edit-limit' : 'rework-limit'; await save(); return
            }
            if (settings.decision?.enabled && prompts.decision) { item.status = 'needs-review'; await save(); if (await decide(item, source, original)) continue; return }
            if (wallpaperReworkCount(item) >= settings.maxReworks) { item.status = 'needs-review'; item.reason ||= 'rework-limit'; await save(); return }
            if (attempt.needsOutpaint && attempt.review.issues.length > 0 && attempt.review.issues.every(issue => issue.kind === 'background')) { item.attempts.push({ revision: attempt.revision + 1, createdAt: new Date().toISOString(), plan: attempt.plan, checks: [], needsOutpaint: true, ...(attempt.compositionMode ? { compositionMode: attempt.compositionMode } : {}), retryFrom: 'reviewing', retryTarget: 'rendering' }); delete item.reason; await save() }
          }
        } catch (error) {
          await failed(item, error)
          if (item.detailInspection?.status === 'failed') return
          if (decisionSource && decisionOriginal && await decide(item, decisionSource, decisionOriginal)) await process(item)
        }
      }
      // Continued batches retain the original review identity and record child-owned qualification.
      const parentId = typeof ctx.spec.input.continuationOf === 'string' ? ctx.spec.input.continuationOf : undefined
      const qualifications = new Map(this.deps.domain.repository.list('selection').filter(row => row.qualification === 'auto-qualified' && (row.runId === ctx.runId || row.runId === parentId)).map(row => [`${row.runId}:${row.imageVersionId}`, row]))
      const inherited: CuratorRecord[] = []
      for (const item of state.items.filter(item => item.status === 'passed')) {
        try {
          const attempt = item.attempts.at(-1)
          const selection = attempt?.outputId ? qualifications.get(`${ctx.runId}:${attempt.outputId}`) ?? qualifications.get(`${parentId}:${attempt.outputId}`) : undefined
          const assessment = selection ? this.deps.domain.repository.get('assessment', selection.assessmentId) : undefined
          if (!attempt?.review || wallpaperVerdict(attempt.review) !== 'pass' || attempt.checks.length || !item.originalId || !attempt.outputId || !selection || !assessment
            || assessment.runId !== selection.runId || assessment.imageVersionId !== attempt.outputId || assessment.stage !== 'final' || assessment.technicalStatus !== 'completed' || assessment.verdict !== 'pass'
            || (release ? assessment.releaseId !== release.id || assessment.recipeId !== release.recipe.id : contentDigest(assessment.directPolicy) !== contentDigest(ctx.spec.fixed.directPolicy) || assessment.recipeId !== 'wallpaper-review-source-v1')) throw new CuratorError('reference-unavailable', 'wallpaper-qualification', 'The saved passing result has no matching review and selection evidence. Review this image before continuing.')
          const evidence = z.object({ wallpaperReview: wallpaperStoredReviewSchema, settings: z.json() }).passthrough().parse(assessment.data)
          const reviewedSettings = wallpaperSettingsSchema.parse(evidence.settings)
          const comparable = (value: WallpaperSettings) => ({ ...value, decision: undefined, clarity: undefined, backgroundResolution: undefined, maxEditsPerImage: undefined, maxReworks: undefined, recoveryLimitVersion: undefined, processing: value.processing ? { ...value.processing, clockContrast: undefined } : undefined })
          if (contentDigest(evidence.wallpaperReview) !== contentDigest(attempt.review) || contentDigest(comparable(reviewedSettings)) !== contentDigest(comparable(settings))) throw new CuratorError('reference-unavailable', 'wallpaper-qualification', 'The saved review does not match this output and frozen template.')
          const source = this.deps.domain.authorizedImage(item.originalId, actor).image, output = this.deps.domain.authorizedImage(attempt.outputId, actor).image
          if (attempt.preResolutionReview) {
            const proof = attempt.preResolutionReview, native = this.deps.domain.authorizedImage(proof.nativeId, actor).image
            const reviewedEvidence = z.object({ reviewedImageVersionId: z.string(), reviewedDigest: z.string(), deliveredImageVersionId: z.string(), postResolutionModelReview: z.literal(false) }).parse(assessment.data)
            if (proof.finalId !== output.id || reviewedEvidence.reviewedImageVersionId !== native.id || reviewedEvidence.reviewedDigest !== native.blob.digest || reviewedEvidence.deliveredImageVersionId !== output.id || proof.nativeDigest !== native.blob.digest || native.parentImageVersionId !== source.id || native.assetId !== source.assetId || proof.simulationId !== attempt.simulationId) throw new CuratorError('reference-unavailable', 'wallpaper-qualification', 'The final file is not linked to its saved native-image review.')
            if (attempt.backgroundResolution) {
              const resolution = attempt.backgroundResolution
              const backgroundInput = resolution.originalId ? this.deps.domain.authorizedImage(resolution.originalId, actor).image : undefined
              const expectedInput = attempt.compositionMode === 'generated-canvas-protected-v2' ? backgroundInput : native
              const expectedModel = reviewedSettings.backgroundResolution?.version === 'realesrgan-background-v1' ? 'realesrgan-x4plus' : 'espcn-x3-luma'
              const expectedDigest = expectedModel === 'realesrgan-x4plus' ? legacyRealEsrganWeightsDigest : espcnWeightsDigest
              if (!backgroundInput || backgroundInput.parentImageVersionId !== source.id || backgroundInput.assetId !== source.assetId || attempt.compositionMode !== 'generated-canvas-protected-v2' && backgroundInput.id !== native.id || !resolution.enhancedId || resolution.model !== expectedModel || resolution.modelSha256 !== expectedDigest || resolution.input.digest !== `sha256-v1:${expectedInput?.blob.digest}`) throw new CuratorError('reference-unavailable', 'wallpaper-qualification', 'The reconstruction no longer matches the reviewed native image and its saved generated background.')
            }
          }
          if (attempt.plan.imageVersionId !== source.id || output.assetId !== source.assetId || output.parentImageVersionId !== source.id || output.geometry.width !== settings.width || output.geometry.height !== settings.height
            || wallpaperGeometry(source.geometry, attempt.plan, settings).checks.length) throw new CuratorError('constraint-conflict', 'wallpaper-qualification', 'The saved passing output does not match its protected source and frozen template.')
          const bytes = await this.deps.files.read(output.blob, ctx.signal), metadata = await sharp(bytes).metadata()
          if (metadata.width !== settings.width || metadata.height !== settings.height || metadata.orientation !== undefined && metadata.orientation !== 1) throw new CuratorError('constraint-conflict', 'wallpaper-qualification', 'The saved wallpaper pixels do not match the frozen output dimensions.')
          const clockPolicy = settings.processing?.clockContrast
          if (clockPolicy && wallpaperGenerativeRepair(settings) && ['generated-canvas-v1', 'generated-canvas-protected-v2'].includes(attempt.compositionMode ?? '') && !attempt.preResolutionReview) {
            const priorReview = wallpaperStoredSourceReviewV4Schema.parse(attempt.review), savedClock = priorReview.clockContrast
            const measured = savedClock?.imageVersionId === output.id && savedClock.minimumRatio === clockPolicy.minimumRatio && savedClock.minimumReadableFraction === clockPolicy.minimumReadableFraction ? savedClock : await wallpaperClockContrast(bytes, output.id, settings, clockPolicy)
            attempt.review = applyWallpaperClockContrast(priorReview, measured)
            if (wallpaperVerdict(attempt.review) !== 'pass') {
              item.status = 'rejected'; item.reason = attempt.review.checks.readability.reason
              if (!reviewOnly && !recomposeOnly && !reworkOnly && !decisionOnly && !detailOnly && !originalOnly) {
                ready.set(item.imageVersionId, { promise: Promise.resolve(source), resolve() {} }); queued.push(item)
              }
              continue
            }
          }
          if (selection.runId === ctx.runId) continue
          const stamp = new Date().toISOString()
          const reused = assessmentSchema.parse({ ...assessment, id: `wallpaper-review-${contentDigest({ runId: ctx.runId, output: output.id }).slice(10)}`, runId: ctx.runId, createdAt: stamp,
            data: toJson({ ...evidence, wallpaperReview: attempt.review, settings: evidence.settings, reusedQualification: { runId: selection.runId, assessmentId: assessment.id, selectionId: selection.id } }) })
          inherited.push(reused, selectionSchema.parse({ ...selection, id: `wallpaper-selection-${contentDigest({ runId: ctx.runId, imageId: item.imageVersionId }).slice(10)}`, runId: ctx.runId, createdAt: stamp, assessmentId: reused.id, rank: state.items.indexOf(item) }))
        } catch (error) {
          item.status = 'reviewing'
          await failed(item, error)
        }
      }
      await save(inherited)
      for (const item of state.items) if (item.status === 'passed') await deliverApproved(item)
      // Original availability and replacements settle before any new layout or image edit.
      if (!direct) await downloadAll()
      if (stopped) { ctx.signal.throwIfAborted(); if (state.budgetStopped) return 'budget-exhausted'; throw stopped }
      if (!direct && !recomposeOnly && !reviewOnly && state.items.some(wallpaperSourceRestricted)) {
        try {
          const replacements = await recoverWallpaperSources({ domain: this.deps.domain, files: this.deps.files, source: await this.deps.source(ctx.spec.config), media: this.deps.media(ctx.spec.config), vision: () => providerPromise ??= this.deps.vision(ctx.spec.config) }, ctx, state, actor, save)
          for (const item of replacements) {
            ready.set(item.imageVersionId, { promise: Promise.resolve(this.deps.domain.require('imageVersion', item.originalId!)), resolve() {} })
            queued.push(item)
          }
        } catch (error) {
          if (ctx.signal.aborted) throw error
          if (safeFailure(error).code !== 'budget-exhausted') throw error
          state.budgetStopped = true; await save(); return 'budget-exhausted'
        }
      }
      let cursor = 0
      await Promise.all(Array.from({ length: Math.min(settings.concurrency, queued.length) }, async () => {
        while (!stopped && cursor < queued.length) { const item = queued[cursor++]!; try { await process(item) } catch (error) { stopped = error } }
      }))
      if (stopped) { ctx.signal.throwIfAborted(); if (state.budgetStopped) return 'budget-exhausted'; throw stopped }
      return state.items.every(item => item.status === 'passed') ? 'target-met' : state.budgetStopped ? 'budget-exhausted' : 'source-exhausted'
    }
  }

  /** Replay one benchmark variant using actual source pixels and exactly reusable generated outputs.
   * @param ctx Evaluation Run.
   * @param sample Frozen human-confirmed source case.
   * @param content Candidate or baseline Skill.
   * @param variant Stable comparison identity.
   * @returns Observed verdict without new image generation.
   */
  async evaluate(ctx: WorkContext, sample: WallpaperExperience['cases'][number], content: string, variant: number) {
    const previousRun = this.deps.domain.require('run', sample.runId), previousSpec = specOf(previousRun), prior = this.state(previousRun).items.find(item => item.imageVersionId === sample.imageVersionId)
    if (!prior?.originalId) return { verdict: 'needs-review' as const, rounds: 0, needsGeneration: false }
    const prompts = wallpaperPromptBundleSchema.parse(previousSpec.fixed.prompts)
    const settings = wallpaperSettingsSchema.parse(previousSpec.fixed.wallpaper), release = executionStandard(styleStandardSchema.parse(previousSpec.fixed.release), previousSpec.fixed.executionRecipe)
    const actor: DomainActor = { kind: 'human', id: 'wallpaper-evaluation', profileId: previousRun.profileId, ...(typeof previousSpec.fixed.sourceSessionId === 'string' ? { sessionId: previousSpec.fixed.sourceSessionId } : {}) }
    const source = this.deps.domain.authorizedImage(prior.originalId, actor).image, bytes = await this.deps.files.read(source.blob, ctx.signal), provider = await this.deps.vision(ctx.spec.config)
    const original: VisionImage = { imageVersionId: source.id, digest: source.blob.digest, mime: source.blob.mime, bytes, role: 'wallpaper-original' }
    let rounds = 0, failures: unknown[] = []
    for (;;) {
      rounds++
      const { backgroundContextPixels: _context, ...legacySettings } = settings
      const requestSettings = z.object({ backgroundContextPixels: z.number().optional() }).parse(previousSpec.fixed.wallpaper).backgroundContextPixels === undefined ? legacySettings : settings
      const input: VisionInput = { wallpaperPrompt: prompts.plan, requestId: `${ctx.runId}:${sample.id}:${variant}:${rounds}:plan`, taskBrief: styleReviewBrief(release, String(previousSpec.input.taskBrief)), rules: release.rules.filter(rule => rule.check.kind === 'visual'), images: [original], usage: toJson({ settings: requestSettings, sourceGeometry: source.geometry, ...(prompts.plan.version === 'wallpaper-plan-v2' ? { protectedBounds: wallpaperProtectedBounds(settings) } : {}), skill: { content }, previousFailures: failures }) }
      const observed = await this.evaluationRequest(ctx, provider, input, 'wallpaper-plan', wallpaperGenerativeRepair(settings) ? wallpaperRepairObservationPlanSchema : ['wallpaper-plan-v6', 'wallpaper-plan-v7'].includes(prompts.plan.version) ? wallpaperObservationPlanSchema.required({ editPrompt: true }) : prompts.plan.version === 'wallpaper-plan-v4' || prompts.plan.version === 'wallpaper-plan-v5' ? wallpaperObservationPlanSchema : wallpaperPlanSchema)
      const plan = wallpaperPlanSchema.parse({ ...observed, placement: 'placement' in observed ? observed.placement : fitWallpaperPlacement(source.geometry, observed, settings, ['wallpaper-plan-v6', 'wallpaper-plan-v7'].includes(prompts.plan.version) ? 'subject-first-v2' : 'crop-first-v1') }), geometry = wallpaperGeometry(source.geometry, plan, settings)
      if (geometry.checks.includes('uncertain-subject') || geometry.checks.includes('missing-protected-regions')) return { verdict: 'needs-review' as const, rounds, needsGeneration: false }
      if (geometry.checks.length) {
        if (rounds > settings.maxReworks) return { verdict: 'reject' as const, rounds, needsGeneration: false }
        failures = geometry.checks; continue
      }
      let finalBytes: Buffer
      if (geometry.needsOutpaint) {
        const reused = prior.attempts.find(attempt => attempt.outputId && attempt.needsOutpaint && contentDigest(attempt.plan.placement) === contentDigest(plan.placement))
        if (!reused?.outputId) return { verdict: 'needs-review' as const, rounds, needsGeneration: true }
        finalBytes = await this.deps.files.read(this.deps.domain.authorizedImage(reused.outputId, actor).image.blob, ctx.signal)
      } else finalBytes = (await renderWallpaper(bytes, plan, settings)).image
      const actual = await this.artifact(source, finalBytes, ctx, 'analysis', prior, variant * 100 + rounds)
      const overlays = await wallpaperOverlays(finalBytes, geometry, settings), simulation = await this.artifact(source, overlays.simulation, ctx, 'simulation', prior, variant * 100 + rounds)
      await ctx.save('reviewing', {}, [...actual.records, ...simulation.records])
      const reviewInput: VisionInput = { wallpaperPrompt: prompts.review, requestId: `${ctx.runId}:${sample.id}:${variant}:${rounds}:review`, taskBrief: styleReviewBrief(release, String(previousSpec.input.taskBrief)), rules: release.rules.filter(rule => rule.check.kind === 'visual'), images: [{ imageVersionId: actual.image.id, digest: actual.image.blob.digest, mime: actual.image.blob.mime, bytes: finalBytes, role: 'actual-wallpaper' }, original, { imageVersionId: simulation.image.id, digest: simulation.image.blob.digest, mime: simulation.image.blob.mime, bytes: overlays.simulation, role: 'lock-screen-simulation-only' }], usage: toJson({ settings: z.object({ backgroundContextPixels: z.number().optional() }).parse(previousSpec.fixed.wallpaper).backgroundContextPixels === undefined ? Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'backgroundContextPixels')) : settings, ...(prompts.review.version === 'wallpaper-review-v2' || prompts.review.version === 'wallpaper-review-v3' && wallpaperReviewVersion(release) === 'wallpaper-review-v2' ? { stylePolicy: wallpaperStylePolicy(release) } : {}), measured: { width: actual.image.geometry.width, height: actual.image.geometry.height } }) }
      const rawReview = await this.evaluationRequest(ctx, provider, reviewInput, 'wallpaper-review', wallpaperReviewOutputSchema(prompts.review.version, reviewInput.rules.map(rule => rule.ruleId), reviewInput.images.map(image => image.imageVersionId), actual.image.id, source.id, wallpaperGenerativeRepair(settings)))
      const review = applyWallpaperStyleReview(rawReview, release, prompts.review.version)
      const verdict = wallpaperVerdict(review)
      if (verdict !== 'reject' || rounds > settings.maxReworks) return { verdict, rounds, needsGeneration: false }
      failures = review.issues
    }
  }

  private async evaluationRequest<T>(ctx: WorkContext, provider: StructuredVisionProvider, input: VisionInput, operation: 'wallpaper-plan' | 'wallpaper-review', schema: z.ZodType<T>): Promise<T> {
    input = await wallpaperVisionInput(input, this.deps.files, provider, ctx.spec.config.limits.previewMaxDimension, ctx.signal)
    const bundle = toJson(provider.describeRequest(input, operation)), saved = this.deps.domain.repository.list('request').find(row => row.runId === ctx.runId && row.state === 'committed' && row.requestDigest === contentDigest(bundle))
    return saved ? schema.parse(z.object({ output: z.unknown() }).parse(saved.data).output) : await ctx.request('vision', bundle, async (signal, metadata) => schema.parse(await provider.wallpaper(input, operation, visionBounds(ctx.spec.config, ctx, signal, metadata))))
  }

  private async original(item: WallpaperItem, actor: DomainActor, ctx: WorkContext, save: (records?: CuratorRecord[]) => Promise<void>): Promise<ImageVersion> {
    const id = item.imageVersionId
    const { image, asset } = this.deps.domain.authorizedImage(id, actor)
    item.download ??= { attempts: 0, retrying: false }
    let cached: ImageVersion | undefined
    if (item.originalId) cached = this.deps.domain.authorizedImage(item.originalId, actor).image
    else if (image.versionKind !== 'preview' && image.versionKind !== 'remote-reference') cached = image
    else cached = this.deps.domain.repository.list('imageVersion').find(row => row.assetId === asset.id && row.parentImageVersionId === id && row.versionKind === 'normalized' && row.id.startsWith('wallpaper-original-'))
    if (cached) {
      await this.deps.files.read(cached.blob, ctx.signal)
      item.originalId = cached.id; item.download.retrying = false; item.download.reused = true; item.download.savedAt ??= new Date().toISOString(); item.download.byteLength ??= cached.blob.byteLength
      delete item.download.lastErrorCode; await save(); return cached
    }
    const progress = this.downloads.begin(ctx.runId, id, ctx.signal, { phase: asset.originalBlob ? 'saving' : 'locating', attempt: item.download.attempts, receivedBytes: 0 })
    try {
      const failedAttempt = async (error: unknown) => {
        if (ctx.signal.aborted) return
        const failure = safeFailure(error)
        progress.update({ phase: 'retrying', attempt: item.download!.attempts, receivedBytes: 0 })
        item.download!.retrying = failure.retryable; item.download!.lastErrorCode = failure.code; await save()
      }
      let bytes: Buffer
      if (asset.originalBlob) bytes = await this.deps.files.read(asset.originalBlob, ctx.signal)
      else {
        const providerAssetId = asset.source.kind === 'provider' ? asset.source.providerAssetId : undefined
        if (!providerAssetId) throw new MediaError('original-source-unavailable', 'wallpaper-original', false, 'This preview has no verifiable original source.', 'Choose another source image.')
        const identity = sourceIdentity(ctx.spec.config)
        if (asset.source.kind !== 'provider' || asset.source.providerId !== identity.providerId || asset.source.accountIdentity !== identity.accountIdentity) throw new MediaError('original-account-mismatch', 'wallpaper-original', false, 'The frozen source account does not match this image.', 'Restore the source account used by the search batch.')
        const provider = await this.deps.source(ctx.spec.config)
        const location = await ctx.request('search', toJson({ operation: 'wallpaper-original-lookup', providerAssetId }), async signal => {
          progress.update({ phase: 'locating', attempt: item.download!.attempts, receivedBytes: 0 })
          try { return await provider.lookup(providerAssetId, { ...requestBounds(ctx.spec.config, ctx), signal }) }
          catch (error) { await failedAttempt(error); throw error }
        }, result => ({ originalAvailable: !!result.originalUrl, ...(result.originalUnavailable ? { originalUnavailable: result.originalUnavailable } : {}) }))
        if (location.originalUnavailable) throw new MediaError('original-source-restricted', 'wallpaper-original', false, 'The source provider marks this original as restricted.', 'Choose an accessible original; a preview cannot replace it.')
        if (!location.originalUrl) throw new MediaError('original-source-unavailable', 'wallpaper-original', false, 'The source did not provide a downloadable original.', 'Choose another source image or check its availability.')
        const response = await ctx.request('download', toJson({ operation: 'wallpaper-original-download', providerAssetId }), async signal => {
          const bound = Math.min(ctx.ledger.remainingBytes(), this.deps.files.limits.maxFileBytes)
          if (bound <= 0) throw new CuratorError('budget-exhausted', 'wallpaper-original', 'The original download budget is exhausted.')
          await ctx.ledger.reserve('download', bound)
          item.download!.attempts++; item.download!.retrying = false
          progress.update({ phase: 'downloading', attempt: item.download!.attempts, receivedBytes: 0 }); await save()
          try {
            const result = await this.deps.media(ctx.spec.config).request(location.originalUrl!, { ...originalRequestBounds(ctx.spec.config, ctx), method: 'GET', maxBytes: bound, signal, onProgress: bytes => progress.update({ phase: 'downloading', attempt: item.download!.attempts, ...bytes }) })
            ctx.ledger.settleDownload(bound, result.bytes.length)
            if (result.status !== 200) throw new MediaError(`original-download-http-${result.status}`, 'wallpaper-original', [408, 425, 429].includes(result.status) || result.status >= 500, `The original download returned HTTP ${result.status}.`, 'Continue after checking the source or network; saved originals are retained.')
            return result
          } catch (error) { await failedAttempt(error); throw error }
        }, result => ({ status: result.status, bytes: result.bytes.length }))
        bytes = response.bytes
      }
      progress.update({ phase: 'saving', attempt: item.download.attempts, receivedBytes: bytes.length, totalBytes: bytes.length })
      const imported = await this.deps.files.importBytes(bytes, undefined, ctx.signal), file = imported.normalized
      const imageId = `wallpaper-original-${contentDigest({ imageId: id, digest: file.blob.digest }).slice(10)}`, existing = this.deps.domain.repository.get('imageVersion', imageId)
      const normalized = existing ?? imageVersionSchema.parse({ schemaVersion: 1, profileId: image.profileId, id: imageId, createdAt: new Date().toISOString(), kind: 'imageVersion', assetId: asset.id, versionKind: 'normalized', parentImageVersionId: image.id, blob: file.blob, geometry: { width: file.width, height: file.height, colorSpace: file.colorSpace, sourceOrientation: 1, processorVersion: file.processorVersion } })
      item.originalId = normalized.id; item.download.originalBlob = blobRefSchema.parse(imported.originalBlob); item.download.byteLength = imported.originalBlob.byteLength; item.download.savedAt = new Date().toISOString(); item.download.retrying = false
      delete item.download.lastErrorCode
      const preview = imageVersionSchema.parse({ ...normalized, id: imageId + ':preview', versionKind: 'preview', parentImageVersionId: normalized.id, blob: imported.preview.blob, geometry: { width: imported.preview.width, height: imported.preview.height, colorSpace: imported.preview.colorSpace, processorVersion: imported.preview.processorVersion } })
      await save([...(existing ? [] : [normalized]), ...(this.deps.domain.repository.get('imageVersion', preview.id) ? [] : [preview])]); return normalized
    } finally { progress.close() }
  }

  private async artifact(parent: ImageVersion, bytes: Uint8Array, ctx: WorkContext, purpose: 'seed' | 'mask' | 'analysis' | 'simulation' | 'final' | 'clarity', item: WallpaperItem, revision: number, kind: 'crop' | 'composition' = 'composition'): Promise<{ image: ImageVersion; records: ImageVersion[] }> {
    const { normalized: file, preview } = await this.deps.files.importBytes(bytes, 'image/png', ctx.signal)
    const id = `wallpaper-${purpose}-${contentDigest({ runId: ctx.runId, imageId: item.imageVersionId, revision, digest: file.blob.digest }).slice(10)}`, existing = this.deps.domain.repository.get('imageVersion', id)
    const image = existing ?? imageVersionSchema.parse({ schemaVersion: 1, profileId: parent.profileId, id, createdAt: new Date().toISOString(), kind: 'imageVersion', assetId: parent.assetId, versionKind: kind, parentImageVersionId: parent.id, blob: file.blob, geometry: { width: file.width, height: file.height, colorSpace: file.colorSpace, sourceOrientation: 1, processorVersion: file.processorVersion }, processing: { recipeDigest: contentDigest({ runId: ctx.runId, imageId: item.imageVersionId, revision, purpose }), processorVersion: file.processorVersion, sourceDigest: parent.blob.digest, encoding: file.blob.mime, outputWidth: file.width, outputHeight: file.height, wallpaperArtifact: purpose === 'clarity' ? 'final' : purpose, ...(item.attempts.at(-1)?.generation ? { generationId: item.attempts.at(-1)!.generation!.taskId } : {}) } })
    if (purpose === 'seed' || purpose === 'mask') return { image, records: [image] }
    const small = imageVersionSchema.parse({ schemaVersion: 1, profileId: image.profileId, id: `${id}:preview`, createdAt: image.createdAt, kind: 'imageVersion', assetId: image.assetId, parentImageVersionId: image.id, versionKind: 'preview', blob: preview.blob, geometry: { width: preview.width, height: preview.height, colorSpace: preview.colorSpace, processorVersion: preview.processorVersion } })
    return { image, records: [image, small] }
  }
}
