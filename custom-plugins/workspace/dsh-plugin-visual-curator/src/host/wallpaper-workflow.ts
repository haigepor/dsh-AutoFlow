/** Profile-owned wallpaper batches freeze qualified sources and persist every layout, edit receipt and review. */
import { z } from 'zod'
import sharp from 'sharp'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ImageGenerationHandle, ImageGenerationId, ImageGenerationTask, ImageGenerationTaskId, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { CuratorDomain } from '../domain/curator.ts'
import { contentDigest } from '../domain/repository.ts'
import type { AssetFiles, StructuredVisionProvider, VisionImage, VisionInput, HttpClient, ImageSourceProvider } from '../media/index.ts'
import { MediaError } from '../media/index.ts'
import { wallpaperVisionInput } from './wallpaper-vision.ts'
import { renderWallpaper, wallpaperGeometry, wallpaperOverlays } from '../media/wallpaper-render.ts'
import { wallpaperRunState } from './wallpaper-state.ts'
import { wallpaperPromptBundle } from '../shared/wallpaper-prompts.ts'
import { wallpaperPromptBundleSchema, wallpaperSettingsSchema, wallpaperPlanSchema, wallpaperReviewSchema, wallpaperStateSchema, wallpaperProgress, wallpaperStartSchema, wallpaperVerdict, type WallpaperItem, type WallpaperExperience, type WallpaperState, type WallpaperView } from '../shared/wallpaper.ts'
import { blobRefSchema, imageVersionSchema, styleStandardSchema, assessmentSchema, selectionSchema, type CuratorRecord, type DomainActor, type ImageVersion, type Json, type RunRecord } from '../shared/model.ts'
import { CuratorError } from '../shared/errors.ts'
import type { CuratorConfig } from './config.ts'
import { RunEngine, dataOf, executionSchema, specOf, toJson, safeFailure, type Worker, type WorkContext } from './runtime.ts'
import { requestBounds, sourceIdentity, visionBounds } from './providers.ts'
import { executionStandard } from './style-execution.ts'
import { styleReviewBrief } from './review.ts'

/** Existing native capabilities and domain storage are the only dispatch and persistence owners. */
export interface WallpaperDependencies {
  domain: CuratorDomain; files: AssetFiles; engine: RunEngine; config(): CuratorConfig
  vision(config: CuratorConfig): Promise<StructuredVisionProvider>
  source(config: CuratorConfig): Promise<ImageSourceProvider>; media(config: CuratorConfig): HttpClient
  llm?: LlmRuntime; attachments?: AttachmentStore
  skill(): { id: string; content: string }
}

const pending = (item: WallpaperItem) => ['queued', 'downloading', 'planning', 'rendering', 'reviewing'].includes(item.status)
const handleSchema = z.object({ id: z.string(), provider: z.string(), model: z.string(), taskId: z.string() })
/**
 * @param run Saved task.
 * @returns Whether its discriminator selects the wallpaper worker.
 */
export function isWallpaperRun(run: RunRecord): boolean { return specOf(run).input.workflow === 'wallpaper-v1' }

/** Fixed-step batch execution, independent of whether its canvas is open. */
export class WallpaperWorkflows {
  private admissions: Promise<void> = Promise.resolve()
  constructor(private readonly deps: WallpaperDependencies) {}

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
    const settings = input.settings ?? defaults.wallpaper, skill = this.deps.skill(), config = { ...defaults, source: original.config.source }
    let imageModel = settings.imageModel
    if (!imageModel && this.deps.llm && typeof this.deps.llm.listImageModels === 'function') {
      try { imageModel = (await this.deps.llm.listImageModels(settings.imageProvider))[0]?.id ?? '' }
      catch (error) { /* Pure crops remain available when the optional image route is absent. */ }
    }
    const prompts = wallpaperPromptBundle()
    const fixed = { prompts: toJson(prompts), promptDigest: contentDigest(prompts), release: original.fixed.release, ...(original.fixed.executionRecipe ? { executionRecipe: original.fixed.executionRecipe } : {}), wallpaperRequested: toJson(settings), wallpaper: toJson({ ...settings, imageModel }), skill: toJson(skill), sourceSessionId: source.owner.kind === 'session' ? source.owner.sessionId : null }
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
   * @returns Current task page or no accepted wallpaper task.
   */
  read(sourceRunId: string, actor: DomainActor, offset: number, size: number, token?: string): WallpaperView | null {
    const source = this.deps.domain.require('run', sourceRunId)
    this.deps.engine.get(sourceRunId, { ...actor, ...(source.owner.kind === 'session' ? { sessionId: source.owner.sessionId } : {}) })
    const run = this.deps.domain.repository.list('run').filter(run => isWallpaperRun(run) && specOf(run).input.sourceRunId === sourceRunId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0]
    if (!run) return null
    this.deps.engine.get(run.id, actor)
    const spec = specOf(run), saved = this.state(run), items = saved.items.slice(offset, offset + size), resources: Record<string, string> = {}
    for (const item of items) {
      const ids = [item.originalId, ...item.attempts.flatMap(attempt => [attempt.analysisId, attempt.simulationId, attempt.outputId])]
      for (const id of ids) if (id) resources[id] = `/api/visual-curator/resource?${new URLSearchParams({ imageVersionId: id, ...(token ? { sessionToken: token } : {}) })}`
    }
    return { runId: run.id, sourceRunId, status: run.status, settings: wallpaperSettingsSchema.parse(spec.fixed.wallpaper), state: { ...saved, items }, resources,
      total: saved.items.length, offset, warnings: dataOf(run).warnings, ...(dataOf(run).error ? { errorCode: dataOf(run).error!.code } : {}), counts: wallpaperProgress(saved) }
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
    const input = z.strictObject({ runId: z.string(), imageVersionId: z.string(), plan: wallpaperPlanSchema, operationId: z.string() }).parse(raw)
    const old = this.deps.engine.get(input.runId, actor)
    if (!isWallpaperRun(old)) throw new CuratorError('invalid-input', 'wallpaper-replan', 'Choose a wallpaper task.')
    const request = { continuationKind: 'replan', continuationOf: old.id, replacementImageId: input.imageVersionId, replacementPlanDigest: contentDigest(input.plan) }
    const accepted = this.continuationReceipt(input.operationId, request, actor)
    if (accepted) return accepted
    if (['created', 'running', 'pausing', 'cancelling'].includes(old.status)) throw new CuratorError('constraint-conflict', 'wallpaper-replan', 'Pause the wallpaper task before changing a plan.')
    const state = this.state(old), item = state.items.find(row => row.imageVersionId === input.imageVersionId)
    if (!item?.originalId || input.plan.imageVersionId !== item.originalId) throw new CuratorError('invalid-input', 'wallpaper-replan', 'The plan does not describe this source image.')
    const spec = specOf(old), settings = wallpaperSettingsSchema.parse(spec.fixed.wallpaper)
    if (item.attempts.length > settings.maxReworks) throw new CuratorError('budget-exhausted', 'wallpaper-replan', 'This image has reached its frozen rework limit.')
    const image = this.deps.domain.require('imageVersion', item.originalId)
    const geometry = wallpaperGeometry(image.geometry, input.plan, settings)
    const next = structuredClone(state), edited = next.items.find(row => row.imageVersionId === input.imageVersionId)!
    edited.attempts.push({ revision: (edited.attempts.at(-1)?.revision ?? 0) + 1, plan: input.plan, checks: geometry.checks, needsOutpaint: geometry.needsOutpaint, retryFrom: 'planning', retryTarget: 'planning' }); edited.status = 'rendering'; delete edited.reason; delete edited.errorCode; delete edited.failedStep
    const normalized = { ...spec.input, operationId: input.operationId, ...request }, fixed = { ...spec.fixed, initialWallpaperState: toJson(next) }
    const nextSpec = executionSchema.parse({ ...spec, input: normalized, fixed, specDigest: contentDigest({ kind: spec.kind, config: spec.config, input: normalized, fixed }) })
    return { runId: (await this.deps.engine.create(nextSpec, actor, this.worker(), input.operationId)).id }
  }

  private state(run: RunRecord): WallpaperState { return wallpaperRunState(this.deps.domain, run) }

  /** Continue saved unfinished work with a fresh task budget and unchanged image-edit counters.
   * @param raw Explicit continuation identity and settled task.
   * @param actor Authenticated owner.
   * @returns New receipt referencing the previous immutable task.
   */
  continue(raw: unknown, actor: DomainActor): Promise<{ runId: string }> {
    const work = this.admissions.then(() => this.continueNow(raw, actor)); this.admissions = work.then(() => {}, () => {}); return work
  }
  private async continueNow(raw: unknown, actor: DomainActor) {
    const input = z.strictObject({ runId: z.string(), operationId: z.string() }).parse(raw), old = this.deps.engine.get(input.runId, actor)
    const request = { continuationKind: 'continue', continuationOf: old.id }
    const accepted = this.continuationReceipt(input.operationId, request, actor)
    if (accepted) return accepted
    if (!isWallpaperRun(old) || ['created', 'running', 'pausing', 'cancelling'].includes(old.status)) throw new CuratorError('constraint-conflict', 'wallpaper-continue', 'Pause or finish the current wallpaper task first.')
    const state = this.state(old); state.budgetStopped = false
    for (const item of state.items) if (item.status === 'technical-failed') { item.status = 'queued'; delete item.errorCode; delete item.reason; delete item.failedStep }
    const spec = specOf(old), normalized = { ...spec.input, operationId: input.operationId, ...request }, fixed = { ...spec.fixed, initialWallpaperState: toJson(state) }
    const next = executionSchema.parse({ ...spec, input: normalized, fixed, specDigest: contentDigest({ kind: spec.kind, config: spec.config, input: normalized, fixed }) })
    return { runId: (await this.deps.engine.create(next, actor, this.worker(), input.operationId)).id }
  }

  private continuationReceipt(operationId: string, request: Record<string, string>, actor: DomainActor): { runId: string } | undefined {
    const accepted = this.deps.domain.repository.list('run').find(run => isWallpaperRun(run) && (specOf(run).input.operationId === operationId || specOf(run).input.continuationOf === request.continuationOf && ['created', 'running', 'pausing', 'paused', 'interrupted', 'cancelling'].includes(run.status)))
    if (!accepted) return undefined
    this.deps.engine.get(accepted.id, actor)
    const input = specOf(accepted).input
    if (Object.entries(request).some(([key, value]) => input[key] !== value)) throw new CuratorError('operation-conflict', 'wallpaper-continue', 'This task already has a different accepted continuation.')
    return { runId: accepted.id }
  }

  /** Resume saved per-image steps; reads and page replay never call this worker.
   * @returns Worker sharing the owning Run's budgets and cancellation.
   */
  worker(): Worker {
    return async ctx => {
      const state = this.state(ctx.current()), settings = wallpaperSettingsSchema.parse(ctx.spec.fixed.wallpaper), release = executionStandard(styleStandardSchema.parse(ctx.spec.fixed.release), ctx.spec.fixed.executionRecipe)
      const skill = z.object({ id: z.string(), content: z.string() }).parse(ctx.spec.fixed.skill), prompts = wallpaperPromptBundleSchema.parse(ctx.spec.fixed.prompts)
      const actor: DomainActor = { kind: 'human', id: 'wallpaper-worker', profileId: this.deps.domain.profileId, ...(typeof ctx.spec.fixed.sourceSessionId === 'string' ? { sessionId: ctx.spec.fixed.sourceSessionId } : {}) }
      let providerPromise: Promise<StructuredVisionProvider> | undefined, stopped: unknown
      const queued = state.items.filter(pending), ready = new Map<string, { promise: Promise<ImageVersion | undefined>; resolve(image: ImageVersion | undefined): void }>()
      for (const item of queued) {
        let resolve!: (image: ImageVersion | undefined) => void
        const promise = new Promise<ImageVersion | undefined>(done => { resolve = done })
        ready.set(item.imageVersionId, { promise, resolve })
      }
      const save = async (records: CuratorRecord[] = []) => {
        const counts = { ...dataOf(ctx.current()).counts, retrievedUnique: state.items.length, finalPassed: state.items.filter(item => item.status === 'passed').length, pending: state.items.filter(pending).length, needsReview: state.items.filter(item => item.status === 'needs-review').length, technicalFailed: state.items.filter(item => item.status === 'technical-failed').length, rejected: state.items.filter(item => item.status === 'rejected').length, cropGenerated: state.items.reduce((n, item) => n + item.attempts.filter(attempt => attempt.outputId).length, 0) }
        await ctx.save(state.items.some(item => item.status === 'reviewing') ? 'reviewing' : state.items.some(item => item.status === 'rendering') ? 'cropping' : state.items.some(item => item.status === 'planning') ? 'planning' : 'retrieving', { checkpoint: { ...dataOf(ctx.current()).checkpoint, wallpaper: toJson(state) }, counts }, records)
      }
      const committed = async <T>(input: VisionInput, operation: 'wallpaper-plan' | 'wallpaper-review', schema: z.ZodType<T>): Promise<T> => {
        const provider = await (providerPromise ??= this.deps.vision(ctx.spec.config))
        input = await wallpaperVisionInput(input, this.deps.files, provider, ctx.spec.config.limits.previewMaxDimension, ctx.signal)
        const descriptor = toJson(provider.describeRequest(input, operation)), digest = contentDigest(descriptor)
        const old = this.deps.domain.repository.list('request').find(request => request.runId === ctx.runId && request.state === 'committed' && request.requestDigest === digest)
        if (old) return schema.parse(z.object({ output: z.unknown() }).parse(old.data).output)
        return await ctx.request('vision', descriptor, async (signal, recordMetadata) => schema.parse(await provider.wallpaper(input, operation, visionBounds(ctx.spec.config, ctx, signal, recordMetadata))))
      }
      const failed = async (item: WallpaperItem, error: unknown) => {
        if (ctx.signal.aborted) throw error
        const failure = safeFailure(error)
        if (item.download) item.download.retrying = false
        if (failure.code === 'budget-exhausted') { state.budgetStopped = true; await save(); throw error }
        item.failedStep = item.status === 'downloading' ? 'downloading' : item.status === 'rendering' ? 'rendering' : item.status === 'reviewing' ? 'reviewing' : 'planning'
        item.status = 'technical-failed'; item.reason = failure.safeMessage; item.errorCode = failure.code; await save()
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
      const process = async (item: WallpaperItem) => {
        if (!pending(item)) return
        const source = await ready.get(item.imageVersionId)!.promise
        if (!source || stopped) return
        try {
          const latest = item.attempts.at(-1), needsPlan = !latest || latest.checks.length || latest.review && wallpaperVerdict(latest.review) === 'reject'
          item.status = needsPlan ? 'planning' : 'rendering'; await save()
          const bytes = await this.deps.files.read(source.blob, ctx.signal)
          const original: VisionImage = { imageVersionId: source.id, digest: source.blob.digest, mime: source.blob.mime, bytes, role: 'wallpaper-original' }
          for (;;) {
            ctx.signal.throwIfAborted()
            let attempt = item.attempts.at(-1)
            if (attempt?.review && wallpaperVerdict(attempt.review) === 'needs-review') { item.status = 'needs-review'; item.reason = attempt.review.issues.map(issue => issue.reason).join('；'); await save(); return }
            if (!attempt || attempt.review && wallpaperVerdict(attempt.review) === 'reject' || attempt.checks.length) {
              if (item.attempts.length > settings.maxReworks) { item.status = 'needs-review'; item.reason = 'rework-limit'; await save(); return }
              item.status = 'planning'; await save()
              const input: VisionInput = { wallpaperPrompt: prompts.plan, requestId: `${ctx.runId}:${item.imageVersionId}:plan:${item.attempts.length + 1}`, taskBrief: styleReviewBrief(release, String(ctx.spec.input.taskBrief)), rules: release.rules.filter(rule => rule.check.kind === 'visual'), images: [original], usage: toJson({ settings, sourceGeometry: source.geometry, skill, previous: item.attempts.map(row => ({ plan: row.plan, checks: row.checks, review: row.review })) }) }
              const plan = await committed(input, 'wallpaper-plan', wallpaperPlanSchema), geometry = wallpaperGeometry(source.geometry, plan, settings)
              attempt = { revision: (attempt?.revision ?? 0) + 1, plan, checks: geometry.checks, needsOutpaint: geometry.needsOutpaint, ...(attempt ? { retryFrom: attempt.review ? 'reviewing' as const : 'planning' as const, retryTarget: 'planning' as const } : {}) }; item.attempts.push(attempt); await save()
            }
            if (!attempt.analysisId) {
              const seed = await renderWallpaper(bytes, attempt.plan, settings), overlays = await wallpaperOverlays(seed.image, seed.geometry, settings), analysis = await this.artifact(source, overlays.analysis, ctx, 'analysis', item, attempt.revision)
              attempt.analysisId = analysis.id; await save([analysis])
            }
            if (attempt.plan.mode === 'uncertain' || attempt.checks.includes('uncertain-subject') || attempt.checks.includes('missing-protected-regions')) { item.status = 'needs-review'; item.reason = attempt.plan.uncertainties.join('；') || 'uncertain-subject'; await save(); return }
            if (attempt.checks.length) continue
            item.status = 'rendering'; await save()
            let rendered = await renderWallpaper(bytes, attempt.plan, settings)
            if (!attempt.canvasId || !attempt.maskId || !attempt.analysisId) {
              const canvas = await this.artifact(source, rendered.image, ctx, 'seed', item, attempt.revision), mask = await this.artifact(source, rendered.mask, ctx, 'mask', item, attempt.revision)
              const marked = await wallpaperOverlays(rendered.image, rendered.geometry, settings), analysis = await this.artifact(source, marked.analysis, ctx, 'analysis', item, attempt.revision)
              attempt.canvasId = canvas.id; attempt.maskId = mask.id; attempt.analysisId = analysis.id; await save([canvas, mask, analysis])
            }
            if (attempt.needsOutpaint && !attempt.outputId) {
              if (!this.deps.llm || !this.deps.attachments || typeof this.deps.llm.startImageGeneration !== 'function' || !settings.imageModel) { item.status = 'needs-review'; item.reason = 'image-capability-unavailable'; await save(); return }
              if (!attempt.generation) {
                if (!attempt.editReserved) {
                  if (item.edits >= settings.maxEditsPerImage) { item.status = 'needs-review'; item.reason = 'edit-limit'; await save(); return }
                  item.edits++; attempt.editReserved = true; attempt.generationOperation = contentDigest({ runId: ctx.runId, imageId: item.imageVersionId, revision: attempt.revision }).slice(10); await save()
                }
                ctx.signal.throwIfAborted()
                const references = await this.deps.attachments.saveImages([{ data: rendered.image, mediaType: 'image/png', name: 'wallpaper-canvas.png' }])
                const reference = references[0]
                if (!reference) throw new CuratorError('reference-unavailable', 'wallpaper-edit', 'The edit canvas attachment is unavailable.')
                const maskBytes = await sharp(rendered.mask).resize(reference.width, reference.height, { fit: 'fill', kernel: 'nearest' }).png().toBuffer()
                const mask = await this.deps.attachments.saveFile({ data: maskBytes, name: 'wallpaper-mask.png' })
                let task: ImageGenerationTask
                try { task = await this.deps.llm.getImageGeneration({ id: brandString<ImageGenerationId>(attempt.generationOperation!), provider: settings.imageProvider, model: settings.imageModel }, { signal: ctx.signal }) }
                catch (error) {
                  if (!(error instanceof Error) || !('code' in error) || error.code !== 'IMAGE_GENERATION_NOT_FOUND') throw error
                  task = await this.deps.llm.startImageGeneration({ id: brandString<ImageGenerationId>(attempt.generationOperation!), provider: settings.imageProvider, model: settings.imageModel, prompt: prompts.outpaint.text, references: [reference], mask, size: settings.imageSize, quality: settings.imageQuality, signal: ctx.signal })
                }
                attempt.generation = handleSchema.parse(task); await save()
              }
              const saved = attempt.generation, handle: ImageGenerationHandle = { ...saved, id: brandString<ImageGenerationId>(saved.id), taskId: brandString<ImageGenerationTaskId>(saved.taskId) }
              let task: ImageGenerationTask = await this.deps.llm.getImageGeneration(handle, { waitMs: 0, signal: ctx.signal })
              while (task.state === 'queued' || task.state === 'sent') { ctx.signal.throwIfAborted(); task = await this.deps.llm.getImageGeneration(handle, { waitMs: Math.min(20_000, ctx.spec.config.limits.requestTimeoutMs), signal: ctx.signal }) }
              if (task.state !== 'succeeded' || !task.images.length || task.error) { item.status = 'needs-review'; item.reason = task.error?.code ?? task.state; await save(); return }
              const generated = task.images[0]!, chunks: Uint8Array[] = []; let size = 0
              for await (const chunk of this.deps.attachments.readFileStream(generated.original, ctx.signal)) { size += chunk.byteLength; if (size > this.deps.files.limits.maxFileBytes) throw new CuratorError('invalid-input', 'wallpaper-edit', 'The generated original exceeds the configured media bound.'); chunks.push(chunk) }
              rendered = await renderWallpaper(bytes, attempt.plan, settings, Buffer.concat(chunks))
            }
            if (!attempt.outputId) {
              const output = await this.artifact(source, rendered.image, ctx, 'final', item, attempt.revision, attempt.needsOutpaint ? 'composition' : 'crop')
              attempt.outputId = output.id; await save([output])
            }
            const output = this.deps.domain.require('imageVersion', attempt.outputId), finalBytes = await this.deps.files.read(output.blob, ctx.signal)
            if (!attempt.analysisId || !attempt.simulationId) {
              const overlays = await wallpaperOverlays(finalBytes, rendered.geometry, settings), analysis = await this.artifact(source, overlays.analysis, ctx, 'analysis', item, attempt.revision), simulation = await this.artifact(source, overlays.simulation, ctx, 'simulation', item, attempt.revision)
              attempt.analysisId ??= analysis.id; attempt.simulationId = simulation.id; await save([analysis, simulation])
            }
            if (output.geometry.width !== settings.width || output.geometry.height !== settings.height) throw new CuratorError('constraint-conflict', 'wallpaper-output', 'Actual output dimensions differ from the frozen template.')
            if (!(await sharp(finalBytes).stats()).isOpaque) throw new CuratorError('constraint-conflict', 'wallpaper-output', 'The actual wallpaper contains unfilled transparent pixels.')
            item.status = 'reviewing'; await save()
            const simulation = this.deps.domain.require('imageVersion', attempt.simulationId!)
            if (!attempt.review) attempt.review = await committed({ wallpaperPrompt: prompts.review, requestId: `${ctx.runId}:${item.imageVersionId}:review:${attempt.revision}`, taskBrief: styleReviewBrief(release, String(ctx.spec.input.taskBrief)), rules: release.rules.filter(rule => rule.check.kind === 'visual'), images: [{ imageVersionId: output.id, digest: output.blob.digest, mime: output.blob.mime, bytes: finalBytes, role: 'actual-wallpaper' }, original, { imageVersionId: simulation.id, digest: simulation.blob.digest, mime: simulation.blob.mime, bytes: await this.deps.files.read(simulation.blob, ctx.signal), role: 'lock-screen-simulation-only' }], usage: toJson({ settings, measured: { width: output.geometry.width, height: output.geometry.height, preservedSource: true } }) }, 'wallpaper-review', wallpaperReviewSchema)
            await save()
            const verdict = wallpaperVerdict(attempt.review)
            if (verdict === 'pass') {
              const stamp = new Date().toISOString(), base = { schemaVersion: 1, profileId: source.profileId, createdAt: stamp }
              const assessment = assessmentSchema.parse({ ...base, id: `wallpaper-review-${contentDigest({ runId: ctx.runId, output: output.id }).slice(10)}`, kind: 'assessment', imageVersionId: output.id, runId: ctx.runId, stage: 'final', releaseId: release.id, recipeId: release.recipe.id, reviewBundleId: `${ctx.runId}:${item.imageVersionId}:${attempt.revision}`, technicalStatus: 'completed', verdict: 'pass', ruleResults: [], cropPotential: 'direct', preferenceScores: {}, data: toJson({ wallpaperReview: attempt.review, settings, inferredRegions: true }) })
              const selection = selectionSchema.parse({ ...base, id: `wallpaper-selection-${contentDigest({ runId: ctx.runId, imageId: item.imageVersionId }).slice(10)}`, kind: 'selection', runId: ctx.runId, imageVersionId: output.id, assessmentId: assessment.id, qualification: 'auto-qualified', rank: state.items.indexOf(item), warnings: [] })
              item.status = 'passed'; await save([assessment, selection]); return
            }
            item.reason = attempt.review.issues.map(issue => issue.reason).join('；')
            if (verdict === 'needs-review') { item.status = 'needs-review'; await save(); return }
            if (item.attempts.length > settings.maxReworks) { item.status = 'needs-review'; item.reason ||= 'rework-limit'; await save(); return }
            if (attempt.needsOutpaint && attempt.review.issues.length > 0 && attempt.review.issues.every(issue => issue.kind === 'background')) { item.attempts.push({ revision: attempt.revision + 1, plan: attempt.plan, checks: [], needsOutpaint: true, retryFrom: 'reviewing', retryTarget: 'rendering' }); await save() }
          }
        } catch (error) { await failed(item, error) }
      }
      await save()
      let cursor = 0
      await Promise.all([downloadAll(), ...Array.from({ length: Math.min(settings.concurrency, queued.length) }, async () => {
        while (!stopped && cursor < queued.length) { const item = queued[cursor++]!; try { await process(item) } catch (error) { stopped = error } }
      })])
      if (stopped) { ctx.signal.throwIfAborted(); if (state.budgetStopped) return 'budget-exhausted'; throw stopped }
      return state.items.every(item => item.status === 'passed') ? 'target-met' : 'source-exhausted'
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
      const input: VisionInput = { wallpaperPrompt: prompts.plan, requestId: `${ctx.runId}:${sample.id}:${variant}:${rounds}:plan`, taskBrief: styleReviewBrief(release, String(previousSpec.input.taskBrief)), rules: release.rules.filter(rule => rule.check.kind === 'visual'), images: [original], usage: toJson({ settings, sourceGeometry: source.geometry, skill: { content }, previousFailures: failures }) }
      const plan = await this.evaluationRequest(ctx, provider, input, 'wallpaper-plan', wallpaperPlanSchema), geometry = wallpaperGeometry(source.geometry, plan, settings)
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
      await ctx.save('reviewing', {}, [actual, simulation])
      const review = await this.evaluationRequest(ctx, provider, { wallpaperPrompt: prompts.review, requestId: `${ctx.runId}:${sample.id}:${variant}:${rounds}:review`, taskBrief: styleReviewBrief(release, String(previousSpec.input.taskBrief)), rules: release.rules.filter(rule => rule.check.kind === 'visual'), images: [{ imageVersionId: actual.id, digest: actual.blob.digest, mime: actual.blob.mime, bytes: finalBytes, role: 'actual-wallpaper' }, original, { imageVersionId: simulation.id, digest: simulation.blob.digest, mime: simulation.blob.mime, bytes: overlays.simulation, role: 'lock-screen-simulation-only' }], usage: toJson({ settings, measured: { width: actual.geometry.width, height: actual.geometry.height } }) }, 'wallpaper-review', wallpaperReviewSchema)
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
    const failedAttempt = async (error: unknown) => {
      if (ctx.signal.aborted) return
      const failure = safeFailure(error)
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
        try { return await provider.lookup(providerAssetId, { ...requestBounds(ctx.spec.config, ctx), signal }) }
        catch (error) { await failedAttempt(error); throw error }
      }, result => ({ originalAvailable: !!result.originalUrl, ...(result.originalUnavailable ? { originalUnavailable: result.originalUnavailable } : {}) }))
      if (location.originalUnavailable) throw new MediaError('original-source-restricted', 'wallpaper-original', false, 'The source provider marks this original as restricted.', 'Choose an accessible original; a preview cannot replace it.')
      if (!location.originalUrl) throw new MediaError('original-source-unavailable', 'wallpaper-original', false, 'The source did not provide a downloadable original.', 'Choose another source image or check its availability.')
      const response = await ctx.request('download', toJson({ operation: 'wallpaper-original-download', providerAssetId }), async signal => {
        const bound = Math.min(ctx.ledger.remainingBytes(), this.deps.files.limits.maxFileBytes)
        if (bound <= 0) throw new CuratorError('budget-exhausted', 'wallpaper-original', 'The original download budget is exhausted.')
        await ctx.ledger.reserve('download', bound)
        item.download!.attempts++; item.download!.retrying = false; await save()
        try {
          const result = await this.deps.media(ctx.spec.config).request(location.originalUrl!, { ...requestBounds(ctx.spec.config, ctx), method: 'GET', maxBytes: bound, signal })
          ctx.ledger.settleDownload(bound, result.bytes.length)
          if (result.status !== 200) throw new MediaError(`original-download-http-${result.status}`, 'wallpaper-original', [408, 425, 429].includes(result.status) || result.status >= 500, `The original download returned HTTP ${result.status}.`, 'Continue after checking the source or network; saved originals are retained.')
          return result
        } catch (error) { await failedAttempt(error); throw error }
      }, result => ({ status: result.status, bytes: result.bytes.length }))
      bytes = response.bytes
    }
    const imported = await this.deps.files.importBytes(bytes, undefined, ctx.signal), file = imported.normalized
    const imageId = `wallpaper-original-${contentDigest({ imageId: id, digest: file.blob.digest }).slice(10)}`, existing = this.deps.domain.repository.get('imageVersion', imageId)
    const normalized = existing ?? imageVersionSchema.parse({ schemaVersion: 1, profileId: image.profileId, id: imageId, createdAt: new Date().toISOString(), kind: 'imageVersion', assetId: asset.id, versionKind: 'normalized', parentImageVersionId: image.id, blob: file.blob, geometry: { width: file.width, height: file.height, colorSpace: file.colorSpace, sourceOrientation: 1, processorVersion: file.processorVersion } })
    item.originalId = normalized.id; item.download.originalBlob = blobRefSchema.parse(imported.originalBlob); item.download.byteLength = imported.originalBlob.byteLength; item.download.savedAt = new Date().toISOString(); item.download.retrying = false
    delete item.download.lastErrorCode
    await save(existing ? [] : [normalized]); return normalized
  }

  private async artifact(parent: ImageVersion, bytes: Uint8Array, ctx: WorkContext, purpose: 'seed' | 'mask' | 'analysis' | 'simulation' | 'final', item: WallpaperItem, revision: number, kind: 'crop' | 'composition' = 'composition'): Promise<ImageVersion> {
    const { normalized: file } = await this.deps.files.importBytes(bytes, 'image/png', ctx.signal)
    const id = `wallpaper-${purpose}-${contentDigest({ runId: ctx.runId, imageId: item.imageVersionId, revision, digest: file.blob.digest }).slice(10)}`, existing = this.deps.domain.repository.get('imageVersion', id)
    return existing ?? imageVersionSchema.parse({ schemaVersion: 1, profileId: parent.profileId, id, createdAt: new Date().toISOString(), kind: 'imageVersion', assetId: parent.assetId, versionKind: kind, parentImageVersionId: parent.id, blob: file.blob, geometry: { width: file.width, height: file.height, colorSpace: file.colorSpace, sourceOrientation: 1, processorVersion: file.processorVersion }, processing: { recipeDigest: contentDigest({ runId: ctx.runId, imageId: item.imageVersionId, revision, purpose }), processorVersion: file.processorVersion, sourceDigest: parent.blob.digest, encoding: file.blob.mime, outputWidth: file.width, outputHeight: file.height, wallpaperArtifact: purpose, ...(item.attempts.at(-1)?.generation ? { generationId: item.attempts.at(-1)!.generation!.taskId } : {}) } })
  }
}
