import { effectiveReviewReferenceRole, isMatchingRule, referenceFeedbackRole } from '../shared/reference-semantics.ts'
import { runResultFilterSchema } from '../shared/search-feedback.ts'
import { planReferenceAnalysis } from './reference-state.ts'
import { selectAnalysisReferences } from '../shared/reference-state.ts'
import { analysisScopeSchema, datasetScopeSchema } from '../shared/datasets.ts'
import { importTaskReferences, readTaskReferences, referenceTask, validateTaskReferences } from './task-references.ts'
import { taskReferenceReadSchema, taskReferenceImportSchema, type TaskReferenceImport } from '../shared/task-references.ts'
/** Shared business provider for authenticated workbench actions and the Agent tools. */
import type { Context } from '@deepseek-ai/cordis'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { ConfigEditor } from '@deepseek-ai/dsh-config-editor'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-config-editor'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-credentials'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { openCuratorDomain, type CuratorDomain } from '../domain/curator.ts'
import { contentDigest } from '../domain/repository.ts'
import { ModelProfiles, profileSaveSchema } from '../domain/model-profile.ts'
import { styleAnalysisOf } from '../shared/style-analysis.ts'
import { AssetFiles, resolveCrop } from '../media/index.ts'
import { CuratorError } from '../shared/errors.ts'
import { readAnalysisInput } from './analysis-input.ts'
import { readAnalysisDetail } from './analysis-detail.ts'
import { assetSchema, imageVersionSchema, jsonSchema, recipeSchema, draftSchema, feedbackContextSchema, subjectSchema, styleStandardSchema, type DomainActor, type Json, type Rule, type EvaluationRecipe, type CuratorRecord, type ProfileExport, type ExportSnapshot, type StyleStandard, type RunRecord } from '../shared/model.ts'
import { agentOperations, type ClientActionInput } from '../client/contract.ts'
import { resolveConfig, resolveCurrentConfig, configRevision, reviewerRevision, searchScreeningPolicySchema, type CuratorConfig } from './config.ts'
import { RunEngine, executionSchema, dataOf, specOf, toJson, safeFailure, taskTiming, type ExecutionSpec, type Worker } from './runtime.ts'
import { ProviderFactory, sourceIdentity } from './providers.ts'
import { GalleryService } from './gallery.ts'
import { GalleryReferenceTasks } from './gallery-tasks.ts'
import { galleryTaskIdSchema } from '../shared/gallery-task.ts'
import { galleryMediaUrlSchema } from '../shared/gallery.ts'
import { referencePage } from './reference-pages.ts'
import { GalleryLogins, type GalleryLoginBrowser } from './gallery-login.ts'
import { launchGalleryLogin } from './gallery-login-browser.ts'
import type { UnsplashApi } from '../media/unsplash.ts'
import { decodeUpload, importedRecords } from './imports.ts'
import { listLocalReferences } from './local-references.ts'
import { pickNativeDirectory, pickNativeImages, pickNativeReferences } from '@deepseek-ai/dsh-host-directory-picker-native'
import { createCropWorker, createCropProcessor } from './crop-workflow.ts'
import { createSearchWorker } from './search-workflow.ts'
import { createDataWorker } from './data-workflows.ts'
import { compileStyleInstructions, executionStandard } from './style-execution.ts'
import { projectSnapshot, projectStyle, projectStyles, projectRun, projectConfiguration, projectAnalysisTasks, projectProfileSelection } from './projection.ts'
import { deleteTaskHistory, hiddenTaskIds } from './task-history.ts'
import { analysisFollowResponse } from './analysis-follow.ts'
import { listVisionModels, requireVisionModel } from './vision-models.ts'
import { compactStyleSummary } from './context-compaction.ts'
import { createDatasetReads, deleteDataset, listDatasets, readDataset } from './datasets.ts'
import { readSearchBatches, deleteSearchBatch } from './search-batches.ts'
import { searchOutputSchema } from '../shared/search-launch.ts'
import { ReferenceOrganization } from './reference-organization.ts'
import { WorkflowHistory } from './workflow-history.ts'
import { SearchLaunches } from './search-launch.ts'
import { freezeSearchExclusions, searchHistoryRuns } from './search-exclusions.ts'
import { createPreviewReads, remotePreviewLocation } from './preview-cache.ts'
import { createAnalysisTaskReads } from './analysis-task-reads.ts'
import { nativeSearchSessions, type NativeSearchSessions } from './native-search-session.ts'
import { originalSearchResult } from './search-results.ts'
import { ServerQueue } from './server-queue.ts'
import { DirectCropTasks, isDirectCropRun } from './direct-crop.ts'
import { WallpaperWorkflows, isWallpaperRun } from './wallpaper-workflow.ts'
import { WallpaperExperienceStore } from './wallpaper-experience.ts'
import { wallpaperCanCancel, wallpaperPendingDecision, wallpaperWorkImage, wallpaperSettingsSchema, wallpaperStateSchema, wallpaperProgress, wallpaperVerdict } from '../shared/wallpaper.ts'
import { wallpaperBatch, wallpaperAcceptsWork, canReadWallpaperChild, wallpaperRunState } from './wallpaper-state.ts'
import type {} from '@deepseek-ai/dsh-compaction'

const actionSchema = z.strictObject({ operation: z.string().min(1), args: z.record(z.string(), jsonSchema) })
const startSchema = z.object({ operationId: z.string().min(1), releaseId: z.string().min(1), datasetId: z.string().min(1).optional(), usageRevisionId: z.string().min(1).optional(), output: searchOutputSchema.optional(), taskBrief: z.string().min(1).max(4000), budgets: z.record(z.string(), z.number()).optional(), sourceId: z.string().optional(), imageVersionId: z.string().optional(), imageVersionIds: z.array(z.string()).optional(), queries: z.array(z.string().min(1).max(4096)).optional(), targetCount: z.number().int().positive().optional(), protectedContent: z.array(z.string().min(1)).optional(), rect: z.unknown().optional(), includeInLearning: z.boolean().optional(), allowWarning: z.boolean().optional(), runId: z.string().optional() })
const uploadSchema = z.strictObject({ operationId: z.string().min(1), styleId: z.string().min(1), expectedRevision: z.number().int().positive(), bytesAllowed: z.boolean().default(false), files: z.array(z.strictObject({ name: z.string().min(1).max(1024), mime: z.string(), base64: z.string(), role: z.enum(['positive', 'negative', 'undecided']), intent: z.enum(['overall', 'dimensions']), dimensions: z.array(z.enum(['color', 'lighting', 'texture', 'subject', 'composition', 'density', 'depth'])) })).min(1) })

/** Same-process fixture dependencies never come from Client, tool or configuration JSON. */
export interface CuratorServiceDependencies {
  nativeSessions?: NativeSearchSessions
  openDomain?: (files: AssetFiles) => Promise<CuratorDomain>
  providers?: Pick<ProviderFactory, 'vision' | 'source' | 'media'> & Partial<Pick<ProviderFactory, 'dispose'>>
  pickLocalPaths?: (kind: 'file' | 'folder' | 'references', title: string, signal: AbortSignal) => Promise<string[] | null>
  galleryApi?: (config: CuratorConfig, accountId?: string, provisionalRef?: string, provisionalCookie?: string) => Promise<UnsplashApi>
  galleryMedia?: import('../media/index.ts').HttpClient
  launchGalleryLogin?: (config: CuratorConfig, signal: AbortSignal) => Promise<GalleryLoginBrowser>
}
/** Minimal Host capabilities used by this provider; Cordis owns their actual implementations. */
export interface CuratorHost {
  get?: Context['get']
  llm?: import('@deepseek-ai/dsh-llm').LlmRuntime
  attachments?: import('@deepseek-ai/dsh-attachment').AttachmentStore
  fiber?: Pick<Context['fiber'], 'entry'>
  profileContext: Pick<ProfileContext, 'dir'>
  credentials: Pick<CredentialProvider, 'resolve' | 'set'>
  jobs: Pick<JobRegistry, 'start'>
  storageDomain: Pick<DomainFacility, 'open'>
  configEditor: Pick<ConfigEditor, 'entries' | 'edit'>
  sessions: Pick<SessionStore, 'get'>
}

interface ResolvedTask { kind: 'search' | 'crop'; normalized: Record<string, Json>; fixed: Record<string, Json>; config: CuratorConfig }

const sessionReadOperations = new Set(['task-reference-list', 'snapshot', 'style-list', 'style-get', 'run-get', 'conversation-runs', 'analysis-detail', 'analysis-input', 'reference-state', 'references-list', 'datasets-list', 'dataset-get', 'profile-current', 'gallery-reference-tasks', 'search-batches'])

/** One provider owns one profile writer; it never changes the default bundle composition. */
export class CuratorService {
  readonly profileId: string
  private configValue: CuratorConfig
  /** Defaults for new tasks; accepted tasks read detached saved specifications. */
  get config(): CuratorConfig { return this.configValue }
  private domainValue: CuratorDomain | undefined
  private engineValue: RunEngine | undefined
  private organizationValue: ReferenceOrganization | undefined
  private launchesValue: SearchLaunches | undefined
  private workflowHistoryValue: WorkflowHistory | undefined
  private wallpaperValue: WallpaperWorkflows | undefined
  private experienceValue: WallpaperExperienceStore | undefined
  private logins: GalleryLogins | undefined
  private directCropValue: DirectCropTasks | undefined
  private serverQueueValue: ServerQueue | undefined
  private galleryValue: GalleryService | undefined
  private galleryTasks: GalleryReferenceTasks | undefined
  private readonly files: AssetFiles
  private readonly providers: Pick<ProviderFactory, 'vision' | 'source' | 'media'> & Partial<Pick<ProviderFactory, 'dispose'>>
  private galleryProviders: ProviderFactory | undefined
  private stopping = false
  private selectingLocalFiles = false
  private readonly lifetime = new AbortController()
  private readonly previewReads = createPreviewReads((location, signal) => this.loadPreview(location, signal), () => this.config.source.unsplash.previewConcurrency)
  private readonly datasetReads = createDatasetReads(() => ({ ttlMs: this.config.limits.datasetCacheTtlMs, maxViews: this.config.limits.datasetCacheMaxViews, maxBytes: this.config.limits.datasetCacheMaxBytes }))
  private readonly analysisTaskReads = createAnalysisTaskReads(() => ({ maxEntries: this.config.limits.analysisTaskCacheMaxEntries, maxBytes: this.config.limits.analysisTaskCacheMaxBytes }))
  private readonly foreground = new Set<Promise<unknown>>()
  private readonly sessionAdmissions = new Map<SessionId, Set<Promise<RunRecord>>>()
  private readonly sessionGrants = new Map<string, { sessionId: string; expiresAt: number }>()
  constructor(private readonly ctx: CuratorHost, input: unknown, private readonly dependencies: CuratorServiceDependencies = {}) {
    this.configValue = resolveCurrentConfig(input)
    this.profileId = createHash('sha256').update(resolve(ctx.profileContext.dir)).digest('hex')
    const l = this.config.limits
    this.files = new AssetFiles(join(ctx.profileContext.dir, 'visual-curator'), { maxFileBytes: l.maxImportBytes, maxPixels: l.maxPixels, maxDimension: l.maxDimension, previewMaxDimension: l.previewMaxDimension, maxStorageBytes: l.maxStorageBytes })
    this.providers = dependencies.providers ?? new ProviderFactory(ctx.credentials, ctx.llm && ctx.attachments ? { llm: ctx.llm, attachments: ctx.attachments } : undefined)
  }
  /** Acquire exclusive persistence before accepting Client or Agent operations. */
  async initialize(): Promise<void> {
    if (this.domainValue || this.stopping) throw new CuratorError('capability-unavailable', 'initialize', 'The provider is already initialized or stopping.')
    this.domainValue = this.dependencies.openDomain ? await this.dependencies.openDomain(this.files) : await openCuratorDomain({ profileId: this.profileId, facility: this.ctx.storageDomain, lockPath: join(this.files.root, 'writer.lock'), commitRetry: () => ({ attempts: this.config.limits.maxRetryAttempts, delayMs: this.config.limits.retryDelayMs }), verifyImage: async image => { await this.files.verifyReference(image.blob) } })
    const galleryFactory = new ProviderFactory(this.ctx.credentials)
    this.galleryProviders = galleryFactory
    this.logins = new GalleryLogins(this.config, this.lifetime.signal, signal => (this.dependencies.launchGalleryLogin ?? launchGalleryLogin)(this.config, signal), async (cookie, signal) => {
      const api = await (this.dependencies.galleryApi ?? ((config, accountId, ref, value) => galleryFactory.gallery(config, accountId, ref, value)))(this.config, undefined, 'VISUAL_CURATOR_LOGIN_PENDING', cookie)
      return api.me({ signal, maxBytes: this.config.limits.maxResponseBytes, timeoutMs: this.config.source.unsplash.login.validationTimeoutMs, maxRedirects: this.config.limits.maxRedirects })
    }, (ref, value) => this.ctx.credentials.set(credentialRef(ref), value))
    this.galleryValue = new GalleryService(this.config, this.domainValue, this.files, this.dependencies.galleryApi ?? ((config, accountId, ref, cookie) => galleryFactory.gallery(config, accountId, ref, cookie)), this.dependencies.galleryMedia ?? galleryFactory.unsplashMedia(this.config))
    this.galleryTasks = new GalleryReferenceTasks(this.config, this.domainValue, this.ctx.jobs, (operation, args, actor, signal) => this.galleryValue!.action(operation, args, actor, signal), (args, actor) => this.galleryValue!.referenceProgress(args, actor), async (styleId, actor) => { await this.organizationValue!.request(styleId, actor) }, {
      validate: async (input, actor) => { const readers = await this.taskReferenceReaders(input, actor, AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.config.limits.requestTimeoutMs)])); validateTaskReferences(this.domain, actor, input, this.config.limits.maxImportFiles, readers) },
      import: async (input, actor, signal) => importTaskReferences(this.domain, this.files, actor, input, this.config.limits.maxImportFiles, signal, await this.taskReferenceReaders(input, actor, signal)),
    })
    this.engineValue = new RunEngine(this.domainValue.repository, this.ctx.jobs, (run) => {
      if (run.owner.kind !== 'session') return
      const session = this.ctx.sessions.get(brandString<SessionId>(run.owner.sessionId))
      if (!session) throw new CuratorError('owner-denied', 'auxiliary-request-log', 'The owning Session is unavailable; no auxiliary model request can be dispatched.')
      // 完整请求已提交到 run 的持久化日志；Session 通过工具结果中的 runId 关联，独立插件不写实验事件。
    }, this.config.limits, run => this.workflowCompleted(run), async run => {
      if (this.stopping || specOf(run).kind !== 'analyze') return
      try { await this.organizationValue?.settled(run) }
      catch (error) { await this.engine.addWarning(run.id, { kind: 'human', id: 'profile-owner', profileId: this.profileId, ...(run.owner.kind === 'session' ? { sessionId: run.owner.sessionId } : {}) }, `Automatic organization requires attention: ${safeFailure(error).code}.`) }
    }, run => this.launchesValue?.presentationChanged(run))
    await this.engineValue.recover()
    this.experienceValue = new WallpaperExperienceStore({ domain: this.domain, engine: this.engine, config: () => this.config, vision: config => this.providers.vision(config), evaluate: (ctx, sample, content, variant) => this.wallpaperValue!.evaluate(ctx, sample, content, variant) })
    this.wallpaperValue = new WallpaperWorkflows({ domain: this.domain, files: this.files, engine: this.engine, config: () => this.config, vision: config => this.providers.vision(config), source: config => this.providers.source(config), media: config => this.providers.media(config), ...(this.ctx.llm ? { llm: this.ctx.llm } : {}), ...(this.ctx.attachments ? { attachments: this.ctx.attachments } : {}), skill: () => this.experienceValue!.skill(), approved: (run, imageVersionId) => this.serverQueueValue!.deliver(run, imageVersionId) })
    this.launchesValue = new SearchLaunches({ domain: this.domain, files: this.files, engine: this.engine, signal: this.lifetime.signal, datasetReads: this.datasetReads,
      searchWorker: () => this.worker('search'),
      native: () => this.dependencies.nativeSessions ?? (this.ctx.get ? nativeSearchSessions({ get: this.ctx.get.bind(this.ctx) }) : undefined),
      freeze: async (input, actor) => {
        const config = input.visionModel ? resolveCurrentConfig({ ...this.config, vision: { ...this.config.vision, backend: 'native', provider: input.visionModel.provider, model: input.visionModel.model, endpoint: '', credentialRef: '', localOrigin: '', vendorVersion: null, reasoningEffort: null, useModelDefaults: true, supportsMultipleImages: true, supportsJson: true, supportsStreaming: true } }) : this.config
        const task = await this.resolveTask('search-start', toJson({ operationId: input.operationId, releaseId: input.modelProfileId, ...(input.datasetId ? { datasetId: input.datasetId } : {}), output: input.output, ...(input.output.kind === 'usage' ? { usageRevisionId: input.output.usageRevisionId } : {}), taskBrief: input.taskBrief, targetCount: input.targetCount, sourceId: sourceIdentity(config).providerId }) as Record<string, Json>, actor, true, config)
        return this.spec(task.kind, task.normalized, { ...task.fixed, ...(input.wallpaper ? { wallpaperAuto: true } : {}), ...(input.executionMode === 'workflow' ? { workflowExecution: true } : {}) }, task.config)
      } })
    this.workflowHistoryValue = new WorkflowHistory(this.domain, this.engine, this.launchesValue)
    // 旧的完整分析只补充模型档案，不重放模型请求，也不改写人工规则。
    const newest = new Set<string>()
    for (const run of this.domain.repository.list('run').sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      const analysis = styleAnalysisOf(run)
      if (!analysis || run.owner.kind !== 'profile' || newest.has(analysis.styleId)) continue
      newest.add(analysis.styleId)
      await new ModelProfiles(this.domain).adopt(run, { kind: 'human', id: 'profile-owner', profileId: this.profileId })
    }
    this.directCropValue = new DirectCropTasks({ domain: this.domain, files: this.files, engine: this.engine, wallpaper: this.wallpaperValue!, config: () => this.config, ...(this.ctx.llm && typeof this.ctx.llm.listImageModels === 'function' ? { imageModels: (provider: string) => this.ctx.llm!.listImageModels(provider) } : {}) })
    this.serverQueueValue = new ServerQueue({ domain: this.domain, files: this.files, engine: this.engine, direct: this.directCropValue, config: () => this.config, credentials: this.ctx.credentials, signal: this.lifetime.signal })
    await this.serverQueueValue.initialize()
    this.organizationValue = new ReferenceOrganization(this.domain, async intent => {
      const draft = this.domain.require('draft', intent.draftId)
      if (draft.revision !== intent.revision || this.domain.require('style', intent.styleId).draftId !== intent.draftId) throw new CuratorError('revision-conflict', 'reference-organization', 'The collection changed before automatic analysis; organize its current revision again.')
      const plan = planReferenceAnalysis(this.domain, intent.styleId, intent.actor, this.recipe(undefined))
      return this.action({ operation: 'reference-analyze', args: { styleId: intent.styleId, operationId: `automatic-reference:${intent.styleId}:${intent.draftId}:${intent.revision}`, automaticOrganizationRevision: intent.revision, buildDataset: true, analysisMode: 'pending', analysisScope: 'all', planDigest: plan.view.digest } }, intent.actor, this.lifetime.signal)
    })
    await this.galleryTasks.initialize()
    await this.engine.resumeAnalyses(this.worker('analyze'))
    for (const run of this.domain.repository.list('run')) if (run.status === 'interrupted' && dataOf(run).autoResume === true && (isWallpaperRun(run) ? wallpaperAcceptsWork(this.domain, run) : specOf(run).fixed.wallpaperLearning === true)) await this.engine.control(run.id, 'resume', { kind: 'human', id: 'profile-owner', profileId: this.profileId }, this.worker(specOf(run).kind), false)
    await this.organizationValue.recover()
    this.launchesValue.recover()
    await this.serverQueueValue.recover()
  }
  /** Update volatile vision defaults. Every accepted task continues reading its detached saved spec.
   * @param input Validated current deployment fields supplied by the owning Cordis reference.
   */
  updateConfiguration(input: unknown): void { this.configValue = resolveCurrentConfig(input) }
  /** Restore accepted native admission when optional GUI services become available after provider startup. */
  restoreSearchLaunches(): void { if (!this.stopping) this.launchesValue?.recover() }
  private get domain(): CuratorDomain { if (!this.domainValue) throw new CuratorError('capability-unavailable', 'service', 'The provider is unavailable.'); return this.domainValue }
  private get engine(): RunEngine { if (!this.engineValue) throw new CuratorError('capability-unavailable', 'service', 'The task controller is unavailable.'); return this.engineValue }
  private async wallpaperResourceToken(sessionId: string | undefined, signal: AbortSignal): Promise<string | undefined> {
    if (!sessionId) return undefined
    if (!await this.readableSession(sessionId, signal)) throw new CuratorError('owner-denied', 'wallpaper-source', 'The source Session is unavailable.')
    const now = Date.now()
    for (const [key, grant] of this.sessionGrants) if (grant.expiresAt <= now) this.sessionGrants.delete(key)
    const existing = [...this.sessionGrants].find(([, grant]) => grant.sessionId === sessionId)
    if (existing) return existing[0]
    const token = randomUUID(); this.sessionGrants.set(token, { sessionId, expiresAt: now + this.config.limits.sessionGrantTtlMs }); return token
  }
  private human(actor: DomainActor): void { if (actor.kind !== 'human') throw new CuratorError('owner-denied', 'confirmation', 'This operation requires the authenticated workbench owner.') }
  private async readableSession(sessionId: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    const id = brandString<SessionId>(sessionId)
    if (this.ctx.sessions.get(id)) return true
    const persistence = this.ctx.get?.('sessionPersistence')
    return persistence ? await persistence.stat(id, { signal }) !== undefined : false
  }
  private async taskReferenceReaders(input: TaskReferenceImport, actor: DomainActor, signal: AbortSignal): Promise<ReadonlyMap<string, DomainActor>> {
    const readers = new Map<string, DomainActor>()
    for (const runId of new Set(input.images.map(image => image.runId))) {
      signal.throwIfAborted()
      const run = referenceTask(this.domain, input.styleId, runId, actor)
      let reader = actor
      if (run.owner.kind === 'session') {
        if (!await this.readableSession(run.owner.sessionId, signal)) throw new CuratorError('owner-denied', 'task-reference', 'The source Session is unavailable.')
        reader = { ...actor, sessionId: run.owner.sessionId }
      }
      this.engine.get(runId, reader); readers.set(runId, reader)
    }
    return readers
  }
  private async scopedHuman(actor: DomainActor, args: Record<string, Json>, signal: AbortSignal, readOnly = false): Promise<DomainActor> {
    if (actor.kind !== 'human') return actor
    if (!args.sessionToken) return { kind: actor.kind, id: actor.id, profileId: actor.profileId }
    const grant = typeof args.sessionToken === 'string' ? this.sessionGrants.get(args.sessionToken) : undefined
    if (!grant || grant.expiresAt <= Date.now()) throw new CuratorError('owner-denied', 'session-channel', 'The Session channel expired or is unavailable. Open it again from the workbench.')
    // 历史图片只核对持久会话是否存在；写入及控制仍需原会话处于运行态。
    if (!this.ctx.sessions.get(brandString<SessionId>(grant.sessionId)) && (!readOnly || !await this.readableSession(grant.sessionId, signal))) throw new CuratorError('owner-denied', 'session-channel', 'Open the owning Session before changing this task.')
    if (grant.expiresAt <= Date.now()) throw new CuratorError('owner-denied', 'session-channel', 'The Session channel expired. Open it again from the workbench.')
    return { ...actor, sessionId: grant.sessionId }
  }
  private worker(kind: ExecutionSpec['kind']): Worker {
    const dependencies = { domain: this.domain, files: this.files, vision: (config: CuratorConfig) => this.providers.vision(config) }
    if (kind === 'crop') { const crop = createCropWorker(dependencies); return ctx => (ctx.spec.input.workflow === 'wallpaper-v1' || ctx.spec.input.workflow === 'wallpaper-direct-v1') ? this.wallpaperValue!.worker()(ctx) : crop(ctx) }
    if (kind === 'search') {
      const crop = createCropProcessor(dependencies)
      const search = createSearchWorker({ ...dependencies, source: config => this.providers.source(config), media: config => this.providers.media(config), crop: async (ctx, ids) => {
        const { styleStandardSchema, usageSchema } = await import('../shared/model.ts')
        const release = styleStandardSchema.parse(ctx.spec.fixed.release), usage = usageSchema.parse(ctx.spec.fixed.usage)
        for (const id of ids) if (await crop(ctx, id, release, usage) === 'budget-exhausted') throw new CuratorError('budget-exhausted', 'cropping', 'The shared crop budget is exhausted.')
      } })
      return async ctx => { const outcome = await search(ctx); await this.launchesValue?.deliver(ctx.runId); return outcome }
    }
    const data = createDataWorker({ ...dependencies, compactSummary: (input, provider, ctx) => compactStyleSummary({ ...(this.ctx.llm ? { llm: this.ctx.llm } : {}), ...(this.ctx.get?.('compaction') ? { compaction: this.ctx.get('compaction')! } : {}) }, this.domain.repository, provider, input, ctx) })
    return ctx => ctx.spec.fixed.wallpaperLearning === true ? this.experienceValue!.worker()(ctx) : data(ctx)
  }

  private async workflowCompleted(run: RunRecord): Promise<void> {
    if (hiddenTaskIds(this.domain.repository).has(run.id)) return
    const spec = specOf(run)
    if (isDirectCropRun(run)) await this.serverQueueValue?.deliver(run)
    if (spec.kind === 'search' && spec.fixed.wallpaperAuto === true && ['target-met', 'source-exhausted', 'partial-failure', 'budget-exhausted'].includes(run.outcome ?? '') && this.domain.repository.list('selection').some(item => item.runId === run.id && item.qualification === 'auto-qualified')) {
      if (typeof spec.fixed.searchLaunchId === 'string' && !this.launchesValue?.allowsDownstream(spec.fixed.searchLaunchId)) return
      await this.wallpaperValue!.start({ operationId: `automatic-wallpaper:${run.id}`, sourceRunId: run.id }, { kind: 'human', id: 'profile-owner', profileId: this.profileId })
    } else if (isWallpaperRun(run) && !isDirectCropRun(run)) await this.experienceValue!.record(run, wallpaperStateSchema.parse(dataOf(run).checkpoint.wallpaper))
    else if (spec.fixed.wallpaperLearning === true) await this.experienceValue!.processPending()
  }

  /** @returns The profile-private, evaluated Skill revision for native catalog discovery. */
  wallpaperSkill(): { id: string; content: string } { return this.experienceValue!.skill() }
  /** @param listener Catalog refresh after an active revision changes. @returns Subscription disposer. */
  subscribeWallpaperSkill(listener: () => void): () => void { return this.experienceValue!.subscribe(listener) }
  private spec(kind: ExecutionSpec['kind'], input: Record<string, Json>, fixed: Record<string, Json>, config = this.config): ExecutionSpec {
    return executionSchema.parse({ kind, config, input, fixed, specDigest: contentDigest({ kind, config, input, fixed }) })
  }
  private async launch(kind: ExecutionSpec['kind'], input: Record<string, Json>, fixed: Record<string, Json>, actor: DomainActor, operationId: string, signal: AbortSignal, config = this.config): Promise<Json> {
    signal.throwIfAborted()
    const pending = this.engine.create(this.spec(kind, input, fixed, config), actor, this.worker(kind), operationId)
    const sessionId = actor.sessionId === undefined ? undefined : brandString<SessionId>(actor.sessionId)
    const admissions = sessionId === undefined ? undefined : this.sessionAdmissions.get(sessionId) ?? new Set<Promise<RunRecord>>()
    if (sessionId !== undefined && admissions) { admissions.add(pending); this.sessionAdmissions.set(sessionId, admissions) }
    try {
      const run = await pending
      return toJson({ runId: run.id, ...(dataOf(run).jobId ? { jobId: dataOf(run).jobId } : {}), status: run.status })
    } finally {
      if (sessionId !== undefined && admissions) { admissions.delete(pending); if (!admissions.size) this.sessionAdmissions.delete(sessionId) }
    }
  }
  /** Cancel this Session's admitted visual work and admissions already in progress; later explicit work is independent.
   * @param sessionId Session whose user requested cancellation.
   * @returns After captured jobs settle and its native search launch is stopped; saved results remain available.
   */
  async stopSessionTasks(sessionId: SessionId): Promise<void> {
    const actor: DomainActor = { kind: 'agent', id: sessionId, sessionId, profileId: this.profileId }
    const pending = [...this.sessionAdmissions.get(sessionId) ?? []]
    const ids = new Set(this.domain.repository.list('run').filter(run => run.owner.kind === 'session' && run.owner.sessionId === sessionId).map(run => run.id))
    const cancel = async (id: string) => {
      const run = this.engine.get(id, actor)
      if (['created', 'running', 'paused', 'pausing', 'interrupted', 'cancelling'].includes(run.status)) await this.engine.control(id, 'cancel', actor)
    }
    const launch = this.launchesValue?.forSession(sessionId)
    const stopping = Promise.allSettled([...ids].map(cancel).concat(launch ? [this.launchesValue!.stop(launch.id, false).then(() => {})] : []))
    const admitted = await Promise.allSettled(pending)
    const late = await Promise.allSettled(admitted.flatMap(item => item.status === 'fulfilled' && !ids.has(item.value.id) ? [cancel(item.value.id)] : []))
    const failed = [...await stopping, ...late].find((item): item is PromiseRejectedResult => item.status === 'rejected')
    if (failed) throw failed.reason
  }
  /** Validate external JSON once, then delegate to the same domain/workflows for both callers.
   * @param input Client or tool JSON envelope. @param actor Identity created by the Host adapter. @param signal Request lifetime; disconnecting does not cancel accepted jobs. Explicit Session cancellation is handled by stopSessionTasks. @returns Safe JSON result or typed rejection.
   */
  action(input: ClientActionInput, actor: DomainActor, signal: AbortSignal): Promise<Json> {
    const work = this.actionNow(input, actor, AbortSignal.any([signal, this.lifetime.signal]))
    // ConfigEditor may reload this fiber while its own edit is pending; it owns that operation's drain.
    return input.operation === 'config-save' ? work : this.track(work)
  }
  private track<T>(work: Promise<T>): Promise<T> {
    this.foreground.add(work)
    void work.then(() => this.foreground.delete(work), () => this.foreground.delete(work))
    return work
  }
  private async actionNow(input: ClientActionInput, actor: DomainActor, signal: AbortSignal): Promise<Json> {
    signal.throwIfAborted()
    if (this.stopping) throw new CuratorError('capability-unavailable', 'action', 'The plugin is stopping.')
    this.domain.repository.assertProfile(actor.profileId)
    try {
      const parsed = actionSchema.parse(input), operation = parsed.operation
      const effectiveActor = await this.scopedHuman(actor, parsed.args, signal, sessionReadOperations.has(operation))
      const { sessionToken, ...args } = parsed.args
      if (operation.startsWith('server-queue-')) {
        this.human(actor)
        const server = this.serverQueueValue!
        if (operation === 'server-queue-read') return toJson(server.read(actor))
        if (operation === 'server-queue-configure') return toJson(await server.configure(args, actor))
        if (operation === 'server-queue-pull') return toJson(await server.pull(actor, signal))
        if (operation === 'server-queue-start') return toJson(await server.start(args, actor, signal))
        if (operation === 'server-queue-import-delete') return toJson(await server.removeImport(args, actor))
        if (operation === 'server-queue-import-retry') return toJson(await server.retryImport(args, actor, signal))
        if (operation === 'server-queue-retry' || operation === 'server-queue-recheck') return toJson(await server.transmission(args, actor, operation === 'server-queue-retry'))
        throw new CuratorError('invalid-input', 'server-queue', 'Unknown server queue operation.')
      }
      if (operation.startsWith('direct-crop-')) {
        this.human(actor)
        if (operation === 'direct-crop-delete') return toJson(await this.directCropValue!.remove(args, actor))
        if (operation === 'direct-crop-replace') return toJson(await this.directCropValue!.replace(args, actor, signal))
        if (operation === 'direct-crop-start') return toJson(await this.directCropValue!.start(args, actor, signal))
        if (operation === 'direct-crop-list') { const input = z.strictObject({ offset: z.number().int().nonnegative().default(0), runId: z.string().optional() }).parse(args); return toJson({ ...this.directCropValue!.list(actor, input.offset, input.runId), imports: this.serverQueueValue!.imports(actor) }) }
        if (operation === 'direct-crop-export') {
          const input = z.strictObject({ runId: z.string(), title: z.string().max(160) }).parse(args)
          const directory = this.dependencies.pickLocalPaths ? (await this.dependencies.pickLocalPaths('folder', input.title, signal))?.[0] : await pickNativeDirectory(signal, {}, input.title)
          return directory ? toJson(await this.directCropValue!.export(input.runId, directory, actor, signal)) : { cancelled: true }
        }
        throw new CuratorError('invalid-input', 'direct-crop', 'Unknown direct-crop operation.')
      }
      if (operation.startsWith('wallpaper-')) {
        this.human(actor)
        const workflows = this.wallpaperValue!
        if (operation === 'wallpaper-options') {
          let models: readonly import('@deepseek-ai/dsh-llm').ImageGenerationModel[] = []
          if (this.ctx.llm && typeof this.ctx.llm.listImageModels === 'function') { try { models = await this.ctx.llm.listImageModels(this.config.wallpaper.imageProvider) } catch (error) { /* Optional image-provider absence does not disable pure cropping. */ } }
          return toJson({ settings: this.config.wallpaper, models })
        }
        if (operation === 'wallpaper-experience') return toJson(this.experienceValue!.read())
        if (operation === 'wallpaper-case') {
          const { caseId } = z.strictObject({ caseId: z.string() }).parse(args), sample = this.experienceValue!.read().cases.find(row => row.id === caseId)
          if (!sample) throw new CuratorError('reference-unavailable', 'wallpaper-case', 'This case is unavailable.')
          const run = this.engine.get(sample.runId, actor), spec = specOf(run), item = wallpaperStateSchema.parse(dataOf(run).checkpoint.wallpaper).items.find(row => row.imageVersionId === sample.imageVersionId)
          if (!item?.originalId) throw new CuratorError('reference-unavailable', 'wallpaper-case', 'The verified source is unavailable.')
          const sessionId = typeof spec.fixed.sourceSessionId === 'string' ? spec.fixed.sourceSessionId : undefined, token = await this.wallpaperResourceToken(sessionId, signal), reader = { ...actor, ...(sessionId ? { sessionId } : {}) }
          const path = (id: string) => { this.domain.authorizedImage(id, reader); return `/api/visual-curator/resource?${new URLSearchParams({ imageVersionId: id, ...(token ? { sessionToken: token } : {}) })}` }
          const outputId = item.attempts.at(-1)?.outputId
          return toJson({ caseId, sourcePath: path(item.originalId), ...(outputId ? { outputPath: path(outputId) } : {}) })
        }
        if (operation === 'wallpaper-experience-action') return toJson(await this.experienceValue!.action(args, actor))
        if (operation === 'wallpaper-plan-update') return toJson(await workflows.replan(args, actor))
        if (operation === 'wallpaper-continue') return toJson(await workflows.continue(args, actor))
        if (operation === 'wallpaper-control') {
          const input = z.strictObject({ runId: z.string(), command: z.enum(['pause', 'resume', 'cancel']) }).parse(args)
          const run = this.engine.get(input.runId, actor)
          if (!isWallpaperRun(run)) throw new CuratorError('invalid-input', 'wallpaper-control', 'Choose a wallpaper task.')
          if (input.command === 'resume' && !wallpaperAcceptsWork(this.domain, run)) throw new CuratorError('constraint-conflict', 'wallpaper-control', 'This snapshot was superseded, cancelled or removed. Open the current batch instead.')
          const cancelSettled = (current: RunRecord): boolean => {
            const saved = wallpaperRunState(this.domain, current)
            if (!wallpaperCanCancel(current.status, saved.items.length, saved.items.filter(item => item.status === 'passed').length)) throw new CuratorError('constraint-conflict', 'wallpaper-control', 'This batch has no unfinished images to cancel. Saved results remain available.')
            const newer = wallpaperBatch(this.domain, current).current.id !== current.id
            if (newer) throw new CuratorError('constraint-conflict', 'wallpaper-control', 'This batch has a newer continuation. Refresh before cancelling processing.')
            return true
          }
          const controlled = await this.engine.control(run.id, input.command, actor, this.worker('crop'), input.command === 'cancel', input.command === 'cancel' ? cancelSettled : undefined)
          if (input.command === 'cancel') {
            const saved = dataOf(controlled).checkpoint.wallpaper, settings = wallpaperSettingsSchema.parse(specOf(controlled).fixed.wallpaper)
            if (saved) for (const item of wallpaperStateSchema.parse(saved).items) for (const attempt of item.attempts) {
              if (!attempt.generationOperation || attempt.outputId) continue
              try {
                if (!this.ctx.llm || typeof this.ctx.llm.cancelImageGeneration !== 'function' || typeof this.ctx.llm.getImageGeneration !== 'function') throw new Error('Image task cancellation is unavailable.')
                const handle = attempt.generation ?? { id: attempt.generationOperation, provider: settings.imageProvider, model: settings.imageModel }
                await this.ctx.llm.cancelImageGeneration({ provider: handle.provider, model: handle.model, id: brandString<import('@deepseek-ai/dsh-llm').ImageGenerationId>(handle.id), ...(attempt.generation ? { taskId: brandString<import('@deepseek-ai/dsh-llm').ImageGenerationTaskId>(attempt.generation.taskId) } : {}) })
              } catch (error) {
                // Stop downstream work even when the provider cannot confirm cancellation or locate its receipt.
                if (!(error instanceof Error && 'code' in error && error.code === 'IMAGE_GENERATION_NOT_FOUND')) await this.engine.addWarning(run.id, actor, 'image-cancel-unconfirmed')
              }
            }
          }
          return toJson({ runId: controlled.id })
        }
        if (operation === 'wallpaper-start' || operation === 'wallpaper-read') {
          const input = z.object({ sourceRunId: z.string(), runId: z.string().optional(), offset: z.number().int().nonnegative().default(0) }).parse(args), source = this.domain.require('run', input.sourceRunId)
          const limit = operation === 'wallpaper-read' ? z.number().int().min(1).max(this.config.limits.pageSize).default(this.config.limits.pageSize).parse(args.limit) : this.config.limits.pageSize
          let token: string | undefined
          if (source.owner.kind === 'session') {
            const reader = { ...actor, sessionId: source.owner.sessionId }; this.engine.get(source.id, reader)
            token = await this.wallpaperResourceToken(source.owner.sessionId, signal)
          } else this.engine.get(source.id, actor)
          if (operation === 'wallpaper-start') return toJson(await workflows.start(args, actor))
          const view = workflows.read(input.sourceRunId, actor, input.offset, limit, token, input.runId)
          return toJson(view ? { ...view, ...(token ? { resourceExpiresAt: this.sessionGrants.get(token)!.expiresAt } : {}), ...(isDirectCropRun(source) ? { serverTransfers: this.serverQueueValue?.transfers(view.runId, actor) } : {}) } : null)
        }
        throw new CuratorError('invalid-input', 'wallpaper', 'Unknown wallpaper operation.')
      }
      if (operation.startsWith('search-launch-')) {
        this.human(effectiveActor)
        const launches = this.launchesValue!
        if (operation === 'search-launch-options') {
          const input = z.object({ usagePageToken: z.string().optional(), executionMode: z.enum(['workflow', 'conversation']).optional() }).parse(args), page = this.usagePage(input.usagePageToken ? { pageToken: input.usagePageToken } : {})
          const visionModels = this.ctx.llm ? (await listVisionModels(this.ctx.llm, signal)).models : []
          return toJson({ ...launches.options(), ...(input.executionMode === 'workflow' ? {} : await launches.models()), visionModelSelection: true, visionModels, workflowExecution: true, datasetSelection: 'required', automaticDatasetPreparation: true, negativeReferenceDatasets: true, wallpaperWorkflow: true, previewSearch: this.config.source.provider === 'unsplash', usages: page.items.map(usage => ({ usageRevisionId: usage.id, name: usage.name, targetWidth: usage.output.targetWidth, targetHeight: usage.output.targetHeight })), ...(page.pageToken ? { usagePageToken: page.pageToken } : {}), defaultTargetCount: Math.min(10, this.config.limits.maxCandidates), maxTargetCount: this.config.limits.maxCandidates })
        }
        if (operation === 'search-launch-datasets') return toJson(launches.datasets(args, effectiveActor, this.config.limits.pageSize))
        if (operation === 'search-launch-list') return toJson(launches.list(z.object({ styleId: z.string().optional() }).parse(args).styleId, this.config.limits.pageSize))
        if (operation === 'search-launch-start') return toJson(await launches.start(args))
        if (operation === 'search-launch-resume') return toJson(await launches.resume(z.object({ id: z.string().uuid() }).parse(args).id))
        if (operation === 'search-launch-presentation') return toJson(await launches.retryPresentation(z.object({ id: z.string().uuid() }).parse(args).id))
        if (operation === 'search-launch-stop') return toJson(await launches.stop(z.object({ id: z.string().uuid() }).parse(args).id))
        throw new CuratorError('invalid-input', 'search-launch', 'Unknown search launch operation.')
      }
      if (['style-archive', 'style-rename', 'reference-edit', 'reference-analyze', 'reference-import', 'reference-local-import', 'task-reference-import', 'gallery-import', 'draft-save'].includes(operation) && typeof args.styleId === 'string' && this.galleryTasks?.busy(args.styleId)) throw new CuratorError('constraint-conflict', 'gallery-task', 'Wait for this collection reference task to finish or stop it first.')
      if (actor.kind === 'agent' && !Object.values(agentOperations).includes(operation as (typeof agentOperations)[keyof typeof agentOperations])) throw new CuratorError('owner-denied', 'tool', 'This operation is unavailable to Agent tools.')
      if (['search-start', 'crop-start', 'manual-crop-confirm', 'reference-analyze', 'evaluate-start', 'export-start'].includes(operation) && typeof args.operationId === 'string') {
        const id = contentDigest({ profileId: effectiveActor.profileId, sessionId: effectiveActor.sessionId ?? null, operationId: args.operationId }).slice(10)
        const existing = this.domain.repository.get('run', id)
        if (existing) {
          this.engine.authorize(existing, effectiveActor)
          if (specOf(existing).fixed.invocationDigest !== contentDigest({ operation, args })) throw new CuratorError('operation-conflict', 'run-start', 'The operation ID was used for a different task.')
          return toJson({ runId: id, ...(dataOf(existing).jobId ? { jobId: dataOf(existing).jobId } : {}), status: existing.status })
        }
      }
      switch (operation) {
        case 'reference-state': {
          this.human(actor)
          const { styleId } = z.object({ styleId: z.string() }).parse(args)
          return this.domain.repository.readSnapshot(() => toJson(planReferenceAnalysis(this.domain, styleId, effectiveActor, this.recipe(undefined)).view))
        }
        case 'usage-list': return toJson(this.usagePage(args))
        case 'task-prepare': return await this.prepareTask(args, effectiveActor)
        case 'gallery-reference-start': this.human(effectiveActor); return toJson(await this.galleryTasks!.start(args, effectiveActor))
        case 'task-reference-start': {
          this.human(effectiveActor)
          const { analyzeAfter, ...input } = taskReferenceImportSchema.parse(args)
          return toJson(await this.galleryTasks!.start({ ...input, source: 'completed-search', ...(analyzeAfter === undefined ? {} : { analyzeAfter }) }, effectiveActor))
        }
        case 'gallery-reference-resume': this.human(effectiveActor); return toJson(await this.galleryTasks!.resume(galleryTaskIdSchema.parse(args.taskId), effectiveActor))
        case 'gallery-reference-tasks': {
          this.human(effectiveActor)
          return this.domain.repository.readSnapshot(() => {
            const hidden = hiddenTaskIds(this.domain.repository)
            return toJson({ tasks: this.galleryTasks!.list(effectiveActor), analyses: projectAnalysisTasks(this.domain, this.engine, effectiveActor, this.analysisTaskReads).filter(task => !hidden.has(task.runId)), workspaceRevision: this.workspaceRevision() })
          })
        }
        case 'analysis-input': {
          this.human(effectiveActor)
          const { runId, requestId } = z.object({ runId: z.string(), requestId: z.string() }).parse(args)
          return this.domain.repository.readSnapshot(() => {
            const run = this.engine.get(runId, effectiveActor)
            if (specOf(run).kind !== 'analyze') throw new CuratorError('invalid-input', 'analysis-input', 'Choose an analysis task.')
            return this.withSessionResources(toJson(readAnalysisInput(this.domain, run, requestId, effectiveActor)), effectiveActor, typeof sessionToken === 'string' ? sessionToken : undefined)
          })
        }
        case 'analysis-detail': {
          this.human(effectiveActor)
          return toJson(readAnalysisDetail(this.domain, this.engine, effectiveActor, args))
        }
        case 'analysis-pause': case 'analysis-resume': case 'analysis-stop': {
          this.human(effectiveActor)
          const run = this.engine.get(z.string().parse(args.runId), effectiveActor)
          if (specOf(run).kind !== 'analyze') throw new CuratorError('invalid-input', operation, 'Choose an analysis task.')
          const command = operation === 'analysis-pause' ? 'pause' : operation === 'analysis-resume' ? 'resume' : 'cancel'
          if (command === 'resume') await this.providers.vision(specOf(run).config)
          await this.engine.control(run.id, command, effectiveActor, command === 'resume' ? this.worker('analyze') : undefined, false)
          return command === 'cancel' ? { accepted: true } : toJson(this.analysisTaskReads.get(this.domain, this.engine, effectiveActor, run.id)!)
        }
        case 'gallery-reference-stop': this.human(effectiveActor); return toJson(await this.galleryTasks!.cancel(galleryTaskIdSchema.parse(args.taskId), effectiveActor))
        case 'datasets-list': this.human(effectiveActor); return this.withSessionResources(toJson(listDatasets(this.domain, this.engine, effectiveActor, args, this.config.limits.pageSize, this.datasetReads)), effectiveActor, typeof sessionToken === 'string' ? sessionToken : undefined)
        case 'dataset-get': this.human(effectiveActor); return this.withSessionResources(toJson(readDataset(this.domain, this.engine, effectiveActor, args, this.config.limits, this.datasetReads)), effectiveActor, typeof sessionToken === 'string' ? sessionToken : undefined)
        case 'dataset-delete': this.human(effectiveActor); return toJson(await deleteDataset(this.domain, this.engine, effectiveActor, args))
        case 'references-list': return this.withSessionResources(referencePage(this.domain, args, effectiveActor, this.config.limits.pageSize), effectiveActor, typeof sessionToken === 'string' ? sessionToken : undefined)
        case 'gallery-login-start': case 'gallery-login-status': case 'gallery-login-retry': case 'gallery-login-finish': case 'gallery-login-cancel': {
          this.human(effectiveActor)
          const owner = JSON.stringify([effectiveActor.profileId, effectiveActor.sessionId ?? null, effectiveActor.id])
          if (operation === 'gallery-login-start') {
            const { revision, ...start } = z.object({ revision: z.string(), operationId: z.string().min(1).max(128), accountId: z.string().optional() }).parse(args)
            if (revision !== configRevision(this.config)) throw new CuratorError('revision-conflict', 'gallery-login', 'Configuration changed; refresh before signing in.')
            return toJson(this.logins!.start({ operationId: start.operationId, ...(start.accountId ? { accountId: start.accountId } : {}) }, owner))
          }
          if (operation === 'gallery-login-cancel' && typeof args.operationId === 'string') {
            const { operationId } = z.object({ operationId: z.string().min(1).max(128) }).parse(args)
            await this.logins!.cancelStart(operationId, owner)
            return { cancelled: true }
          }
          const { loginId } = z.object({ loginId: z.string().uuid() }).parse(args)
          if (operation === 'gallery-login-retry') return toJson(this.logins!.retry(loginId, owner))
          if (operation === 'gallery-login-cancel') return toJson(await this.logins!.cancel(loginId, owner))
          if (operation === 'gallery-login-finish') return toJson(await this.logins!.finish(loginId, owner))
          return toJson(this.logins!.status(loginId, owner))
        }
        case 'gallery-validate': case 'gallery-collections': case 'gallery-photos': case 'gallery-import': case 'gallery-import-progress': case 'gallery-import-cancel':
          return await this.galleryValue!.action(operation, args, effectiveActor, signal)
        case 'session-open': {
          this.human(actor)
          const { sessionId } = z.strictObject({ sessionId: z.string().min(1), operationId: z.string().optional() }).parse(args)
          if (!await this.readableSession(sessionId, signal)) throw new CuratorError('owner-denied', 'session-channel', 'The Session is unavailable in this profile.')
          const token = randomUUID()
          const expiresAt = Date.now() + this.config.limits.sessionGrantTtlMs
          this.sessionGrants.set(token, { sessionId, expiresAt })
          return { sessionToken: token, sessionId, expiresAt, pollIntervalMs: this.config.limits.pollIntervalMs }
        }
        case 'conversation-runs': {
          this.human(actor)
          const { sessionId } = z.object({ sessionId: z.string().min(1) }).parse(args)
          if (effectiveActor.sessionId !== sessionId) throw new CuratorError('owner-denied', 'session-channel', 'Open the task list through its Session channel.')
          const hidden = hiddenTaskIds(this.domain.repository)
          const tasks = this.domain.repository.list('run').filter(run => run.owner.kind === 'session' && run.owner.sessionId === sessionId && !hidden.has(run.id))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).flatMap(run => {
              this.engine.authorize(run, effectiveActor)
              const spec = specOf(run)
              return spec.kind === 'search' || spec.kind === 'crop' ? [{ runId: run.id, revision: run.revision, kind: spec.kind, status: run.status, taskBrief: typeof spec.input.taskBrief === 'string' ? spec.input.taskBrief : '' }] : []
            })
          const launch = this.launchesValue!.forSession(sessionId)
          return toJson({ sessionId, tasks, ...(launch ? { launch } : {}) })
        }
        case 'snapshot': {
          const page = z.object({ pageSize: z.number().int().min(1).max(100).default(this.config.limits.pageSize), pageToken: z.string().optional(), includeStyleSamples: z.boolean().default(true) }).parse(args)
          let ids: string[] = [], offset = 0
          const snapshot = projectSnapshot(this.domain, this.engine, this.config, effectiveActor, await this.credentialStatus(), { includeRunResults: false, includeStyleSamples: page.includeStyleSamples, imageWindow: imageIds => {
            ids = imageIds; offset = this.pageOffset(page.pageToken, 'images', ids)
            return { offset, size: page.pageSize }
          } })
          const hidden = hiddenTaskIds(this.domain.repository)
          snapshot.runs = snapshot.runs.filter(run => !hidden.has(run.runId))
          snapshot.collectionPaging = true
          snapshot.workspaceRevision = this.workspaceRevision()
          snapshot.exports = snapshot.exports.map(exp => ({ ...exp, ...(exp.preview ? { preview: exp.preview.slice(0, this.config.limits.maxExportPreviewChars) } : {}) }))
          snapshot.evaluations = snapshot.evaluations.map(evaluation => ({ ...evaluation, ...(evaluation.items ? { items: evaluation.items.slice(0, page.pageSize) } : {}) }))
          if (offset + page.pageSize < ids.length) snapshot.nextPageToken = this.pageToken('images', offset + page.pageSize, ids)
          return this.withSessionResources(toJson(snapshot), effectiveActor, typeof sessionToken === 'string' ? sessionToken : undefined)
        }
        case 'search-batch-detail': {
          this.human(actor)
          const { styleId, runId } = z.strictObject({ styleId: z.string(), runId: z.string() }).parse(args)
          const source = this.domain.require('run', runId), spec = specOf(source), standard = z.object({ styleId: z.string() }).safeParse(spec.fixed.release)
          if (source.profileId !== actor.profileId || !['search', 'crop'].includes(spec.kind) || spec.input.workflow === 'wallpaper-v1' || !standard.success || standard.data.styleId !== styleId || hiddenTaskIds(this.domain.repository).has(runId)) throw new CuratorError('owner-denied', 'search-batch-detail', 'This batch is unavailable in the selected collection.')
          if (source.owner.kind === 'session' && !await this.readableSession(source.owner.sessionId, signal)) throw new CuratorError('owner-denied', 'search-batch-detail', 'The source Session is unavailable.')
          const run = this.engine.get(runId, { ...actor, ...(source.owner.kind === 'session' ? { sessionId: source.owner.sessionId } : {}) }), data = dataOf(run)
          const postProcessing = z.object({ code: z.string() }).safeParse(data.checkpoint.postProcessingFailure)
          return toJson({ runId: run.id, kind: spec.kind, status: run.status, stage: run.stage, createdAt: run.createdAt, taskBrief: typeof spec.input.taskBrief === 'string' ? spec.input.taskBrief : '', counts: data.counts, requests: data.requestIds.length, warnings: data.warnings, ...(data.error ? { errorCode: data.error.code } : {}), ...(postProcessing.success ? { postProcessingError: postProcessing.data.code } : {}), ...(run.outcome ? { outcome: run.outcome } : {}) })
        }
        case 'search-batches': {
          this.human(actor)
          const cold = new Set<string>(), readable = new Set<string>()
          const readerFor: Parameters<typeof readSearchBatches>[4] = run => {
            let token: string | undefined
            let reader = actor
            if (run.owner.kind === 'session') {
              const sessionId = run.owner.sessionId
              if (!this.ctx.sessions.get(brandString<SessionId>(sessionId)) && !readable.has(sessionId)) { cold.add(sessionId); return undefined }
              const now = Date.now()
              for (const [key, grant] of this.sessionGrants) if (grant.expiresAt <= now) this.sessionGrants.delete(key)
              token = [...this.sessionGrants].find(([, grant]) => grant.sessionId === sessionId)?.[0]
              if (!token) { token = randomUUID(); this.sessionGrants.set(token, { sessionId, expiresAt: now + this.config.limits.sessionGrantTtlMs }) }
              reader = { ...actor, sessionId }
            }
            // 跨会话只用于已认证所有者的只读批次视图；控制和 Agent 工具仍要求原 Session 授权。
            this.engine.get(run.id, reader)
            return { actor: reader, ...(token ? { sessionToken: token } : {}) }
          }
          const page = readSearchBatches(this.domain, actor, args, this.config.limits.pageSize, readerFor)
          if (!cold.size) return toJson(page)
          const present = await Promise.all([...cold].map(async sessionId => await this.readableSession(sessionId, signal) ? sessionId : undefined))
          for (const sessionId of present) if (sessionId) readable.add(sessionId)
          return toJson(readable.size ? readSearchBatches(this.domain, actor, args, this.config.limits.pageSize, readerFor) : page)
        }
        case 'style-list': {
          const query = z.object({ pageSize: z.number().int().min(1).max(100).default(20), pageToken: z.string().optional() }).parse(args)
          let ids: string[] = [], offset = 0
          const styles = projectStyles(this.domain, effectiveActor, styleIds => { ids = styleIds; offset = this.pageOffset(query.pageToken, 'styles', ids); return { offset, size: query.pageSize } })
          return toJson({ items: styles, ...(offset + query.pageSize < ids.length ? { pageToken: this.pageToken('styles', offset + query.pageSize, ids) } : {}) })
        }
        case 'style-get': {
          const { styleId } = z.object({ styleId: z.string() }).parse(args)
          return this.withSessionResources(toJson(projectStyle(this.domain, styleId, effectiveActor)), effectiveActor, typeof sessionToken === 'string' ? sessionToken : undefined)
        }
        case 'run-get': {
          const { runId: requestedRunId, pageSize, pageToken, resultFilter, followLatestWallpaper } = z.object({ runId: z.string(), pageSize: z.number().int().min(1).max(100).default(20), pageToken: z.string().optional(), resultFilter: runResultFilterSchema.default('all'), followLatestWallpaper: z.boolean().default(false) }).parse(args)
          let runId = requestedRunId
          let requested = this.domain.require('run', runId)
          if (followLatestWallpaper && specOf(requested).kind === 'search') {
            this.engine.get(requested.id, effectiveActor)
            const latest = this.domain.repository.readSnapshot(() => this.domain.repository.list('run').filter(candidate => isWallpaperRun(candidate) && specOf(candidate).input.sourceRunId === requested.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0])
            if (latest) { requested = latest; runId = latest.id }
          }
          const requestedSpec = specOf(requested), wallpaperRequired = isWallpaperRun(requested) || requestedSpec.fixed.wallpaperAuto === true
          let reader = effectiveActor
          if (wallpaperRequired && reader.kind === 'human' && !reader.sessionId) {
            const source = isWallpaperRun(requested) ? this.domain.require('run', wallpaperRunState(this.domain, requested).sourceRunId) : requested
            if (source.owner.kind === 'session') { reader = { ...reader, sessionId: source.owner.sessionId }; this.engine.get(source.id, reader) }
          }
          if (!canReadWallpaperChild(this.domain, requested, reader)) this.engine.get(runId, reader)
          const resourceToken = wallpaperRequired ? await this.wallpaperResourceToken(reader.sessionId, signal) : typeof sessionToken === 'string' ? sessionToken : undefined
          return this.domain.repository.readSnapshot(() => {
            let ids: string[] = [], offset = 0
            const scope = resultFilter === 'all' ? runId : `${runId}:${resultFilter}`
            const current = this.domain.require('run', runId)
            if (!canReadWallpaperChild(this.domain, current, reader)) this.engine.get(runId, reader)
            const currentSpec = specOf(current), timingPolicy = taskTiming(currentSpec)
            const run = projectRun(this.domain, current, reader, undefined, true, { resultFilter, imageWindow: imageIds => {
              ids = imageIds; offset = this.pageOffset(pageToken, scope, ids)
              return { offset, size: pageSize }
            } })
            run.resultFilter = resultFilter
            const child = isWallpaperRun(current) ? current : wallpaperRequired ? this.domain.repository.list('run').filter(candidate => isWallpaperRun(candidate) && specOf(candidate).input.sourceRunId === current.id)
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0] : undefined
            const wallpaper = child ? this.wallpaperRunReport(child, reader, pageSize) : null
            const source = isWallpaperRun(current) ? this.domain.require('run', wallpaperRunState(this.domain, current).sourceRunId) : current, target = specOf(source).input.targetCount
            return this.withSessionResources(toJson({ ...run, ...(runId !== requestedRunId ? { resolvedFromRunId: requestedRunId } : {}), timing: { policy: timingPolicy, deadlineEnforced: timingPolicy === 'bounded', configuredDeadlineMs: currentSpec.config.limits.deadlineMs, ...(timingPolicy === 'bounded' ? { deadlineAt: dataOf(current).budget.deadlineAt } : {}) }, ...(wallpaperRequired ? { wallpaperRequired: true, wallpaper, workflowComplete: current.status === 'completed' && source.status === 'completed' && !!wallpaper && wallpaper.complete === true && typeof target === 'number' && Number(wallpaper.passed) >= target } : {}), ...(offset + pageSize < ids.length ? { pageToken: this.pageToken(scope, offset + pageSize, ids) } : {}), ...(resourceToken ? { resourceExpiresAt: this.sessionGrants.get(resourceToken)!.expiresAt } : {}) }), reader, resourceToken)
          })
        }
        case 'run-delete': {
          this.human(effectiveActor)
          const { runId, operationId, styleId } = z.strictObject({ runId: z.string().min(1), operationId: z.string().min(1), styleId: z.string().min(1).optional() }).parse(args)
          if (styleId) return await deleteSearchBatch(this.domain, effectiveActor, { runId, operationId, styleId })
          return await deleteTaskHistory(this.domain.repository, this.engine.get(runId, effectiveActor), operationId)
        }
        case 'workflow-delete': return toJson(await this.workflowHistoryValue!.remove(args, effectiveActor))
        case 'run-control': {
          this.human(actor)
          const { runId, command, waitForCompletion } = z.object({ runId: z.string(), command: z.enum(['pause', 'resume', 'cancel']), waitForCompletion: z.boolean().default(true) }).parse(args)
          const run = this.engine.get(runId, effectiveActor)
          if (command === 'resume') {
            if (isWallpaperRun(run) && !wallpaperAcceptsWork(this.domain, run)) throw new CuratorError('constraint-conflict', 'run-resume', 'This wallpaper snapshot was superseded, cancelled or removed.')
            const fixed = specOf(run)
            const source = typeof fixed.input.sourceRunId === 'string' ? this.domain.repository.get('run', fixed.input.sourceRunId) : undefined
            const launchId = fixed.fixed.searchLaunchId ?? (source ? specOf(source).fixed.searchLaunchId : undefined)
            if (typeof launchId === 'string' && !this.launchesValue!.allowsDownstream(launchId)) throw new CuratorError('cancelled', 'run-resume', 'This workflow was stopped or removed. Start a new explicit task instead.')
            // 继续任务使用已接受的供应商与模型；当前设置只影响新任务。
            if (fixed.kind !== 'export') await this.providers.vision(fixed.config)
            if (fixed.kind === 'search') await this.providers.source(fixed.config)
            for (const reference of this.domain.repository.list('imageVersion').filter(image => image.id === fixed.input.imageVersionId || Array.isArray(fixed.input.imageVersionIds) && fixed.input.imageVersionIds.includes(image.id))) await this.files.read(this.domain.authorizedImage(reference.id, effectiveActor).image.blob)
          }
          // 页面先显示已持久化的控制状态；默认调用仍可等待模型清理及终态。
          return toJson(projectRun(this.domain, await this.engine.control(runId, command, effectiveActor, this.worker(specOf(run).kind), waitForCompletion), effectiveActor))
        }
        case 'reference-import': this.human(actor); return await this.importReferences(args, actor, signal)
        case 'task-reference-list': {
          this.human(effectiveActor)
          const input = taskReferenceReadSchema.parse(args)
          let reader = effectiveActor, token: string | undefined
          if (input.runId) {
            const run = referenceTask(this.domain, input.styleId, input.runId, effectiveActor)
            if (run.owner.kind === 'session') {
              const sessionId = run.owner.sessionId
              if (!await this.readableSession(sessionId, signal)) throw new CuratorError('owner-denied', operation, 'The source Session is unavailable.')
              reader = { ...effectiveActor, sessionId }
              const now = Date.now()
              token = [...this.sessionGrants].find(([, grant]) => grant.sessionId === sessionId && grant.expiresAt > now)?.[0]
              if (!token) { token = randomUUID(); this.sessionGrants.set(token, { sessionId, expiresAt: now + this.config.limits.sessionGrantTtlMs }) }
            }
            this.engine.get(run.id, reader)
          }
          const page = readTaskReferences(this.domain, reader, input, this.config.limits.pageSize)
          return this.withSessionResources(toJson({ ...page, ...(token ? { resourceExpiresAt: this.sessionGrants.get(token)!.expiresAt } : {}) }), reader, token)
        }
        case 'task-reference-import': {
          this.human(effectiveActor)
          const input = taskReferenceImportSchema.parse(args)
          if (input.images.length > this.config.limits.maxImportFiles) throw new CuratorError('invalid-input', operation, 'Choose a bounded set of task images.')
          const readers = await this.taskReferenceReaders(input, effectiveActor, signal)
          return toJson(await importTaskReferences(this.domain, this.files, effectiveActor, input, this.config.limits.maxImportFiles, signal, readers))
        }
        case 'local-files-list': {
          this.human(actor)
          const input = z.strictObject({ path: z.string().min(1), kind: z.enum(['file', 'folder']) }).parse(args)
          return toJson({ files: await listLocalReferences(input.path, input.kind, this.config.limits.maxLocalReferenceFiles, signal) })
        }
        case 'reference-local-import': this.human(actor); return await this.referenceLocalFiles(args, actor, signal)
        case 'local-reference-pick': this.human(actor); return await this.pickLocalReferences(args, signal)
        case 'profile-save': {
          this.human(actor)
          const input = profileSaveSchema.parse(args), profile = await new ModelProfiles(this.domain).save(input, effectiveActor)
          return toJson({ ...projectProfileSelection(this.domain, profile, effectiveActor), previousProfileId: input.expectedProfileId })
        }
        case 'profile-current': {
          return this.domain.repository.readSnapshot(() => {
            this.human(effectiveActor)
            const { styleId } = z.object({ styleId: z.string().min(1) }).parse(args)
            this.domain.require('style', styleId)
            const profiles = new ModelProfiles(this.domain), profile = profiles.current(styleId, effectiveActor)
            if (profile) profiles.authorize(profile, effectiveActor)
            return toJson({ styleId, profile: profile ? projectProfileSelection(this.domain, profile, effectiveActor) : null })
          })
        }
        case 'draft-save': {
          this.human(actor)
          const style = this.domain.require('style', z.string().parse(args.styleId)), draft = this.domain.require('draft', style.draftId)
          const rules = z.array(z.unknown()).parse(args.rules).map(rule => this.ruleFromView(rule, actor, draft.rules))
          const remaining = z.array(z.string()).parse(args.conflicts)
          if (remaining.some(reason => !draft.conflicts.some(conflict => conflict.reason === reason))) throw new CuratorError('invalid-input', 'draft-save', 'Unknown conflict resolution.')
          const conflicts = draft.conflicts.map(conflict => ({ ...conflict, resolved: !remaining.includes(conflict.reason) }))
          return await this.domain.action(operation, { ...args, rules, conflicts }, actor)
        }
        case 'candidate-create': {
          this.human(actor)
          return await this.domain.action(operation, { ...args, recipe: this.recipe(args.operationId) }, actor)
        }
        case 'feedback-confirm': return await this.confirmFeedback(args, effectiveActor)
        case 'reference-organize': {
          this.human(effectiveActor)
          return await this.organizationValue!.request(z.object({ styleId: z.string().min(1) }).parse(args).styleId, effectiveActor)
        }
        case 'reference-analyze': {
          this.human(actor)
          const { styleId, operationId, analysisMode, analysisScope, planDigest, automaticOrganizationRevision } = z.object({ styleId: z.string(), operationId: z.string(), buildDataset: z.boolean().optional(), analysisMode: z.enum(['pending', 'all']).default('pending'), analysisScope: analysisScopeSchema.default('all'), planDigest: z.string().optional(), automaticOrganizationRevision: z.number().int().positive().optional() }).parse(args)
          const { style, draft, plan } = this.domain.repository.readSnapshot(() => {
            const style = this.domain.require('style', styleId), draft = this.domain.require('draft', style.draftId)
            for (const id of draft.referenceIds) this.domain.assertLearningFamily(this.domain.authorizedImage(this.domain.require('reference', id).imageVersionId, effectiveActor).asset.familyId)
            const plan = planReferenceAnalysis(this.domain, styleId, effectiveActor, this.recipe(operationId))
            if (planDigest !== undefined && planDigest !== plan.view.digest) throw new CuratorError('revision-conflict', 'analyze', 'The analysis selection changed; review the current image counts again.')
            const selection = selectAnalysisReferences(plan.view, analysisScope)
            if (selection.total === 0) throw new CuratorError('invalid-input', 'analyze', 'There are no references in the selected analysis scope.')
            if ((analysisMode === 'all' || selection.changed > 0) && !planDigest) throw new CuratorError('constraint-conflict', 'analyze', 'Confirm reanalysis of previously analyzed images before starting.')
            return { style, draft, plan }
          })
          const provider = await this.providers.vision(this.config)
          provider.assertCapabilities(Math.min(draft.referenceIds.length, this.config.limits.maxReferenceImages))
          // Provider 准备跨越异步调用，冻结输入前使用新快照复核修订号。
          const fixed = this.domain.repository.readSnapshot(() => {
            if (this.domain.require('style', styleId).revision !== style.revision) throw new CuratorError('revision-conflict', 'analyze', 'The image collection changed while preparing analysis; review the current selection.')
            const current = this.domain.repository.manifest('split-index')?.state
            const splitId = current && typeof current === 'object' && !Array.isArray(current) && typeof current.currentSplitId === 'string' ? current.currentSplitId : undefined
            const references = draft.referenceIds.map(id => this.domain.require('reference', id))
            const referenceThreads = new Set(references.flatMap(reference => reference.feedbackThreadIds))
            const feedback = this.domain.currentFeedback(effectiveActor).filter(item => item.scope === 'style-candidate' && item.context.styleId === style.id && (referenceThreads.has(item.threadId) || draft.feedbackIds.includes(item.id)))
            const selected = new Set(references.filter(ref => analysisScope === 'all' || referenceFeedbackRole(draft.rules, ref, feedback) === analysisScope).map(ref => ref.imageVersionId))
            return { ...(automaticOrganizationRevision === undefined ? {} : { automaticOrganizationRevision }), invocationDigest: contentDigest({ operation, args }), analysisOutput: 'observations-only', referencePrompts: 'role-aware-v1', referenceDetailPrompts: 'subject-context-v2', datasetPrompts: 'evidence-scoped-v1', autoExportDataset: true, reuseObservations: toJson(plan.reused.filter(link => analysisMode === 'pending' || !selected.has(link.imageVersionId))), analysisMode, ...(planDigest ? { planDigest } : {}), draft: toJson(draft), references: toJson(references), feedback: toJson(feedback), recipe: toJson(this.recipe(operationId)), ...(splitId ? { split: toJson(this.domain.require('split', splitId)) } : {}) }
          })
          return await this.launch('analyze', { styleId, buildDataset: true, analysisScope }, fixed, effectiveActor, operationId, signal)
        }
        case 'search-start': case 'crop-start': case 'manual-crop-confirm': return await this.startTask(operation, args, effectiveActor, signal)
        case 'library-save': this.human(actor); return await this.saveLibrary(args, effectiveActor)
        case 'split-create': return await this.createSplit(args, actor)
        case 'evaluate-start': return await this.startEvaluation(args, effectiveActor, signal)
        case 'export-start': return await this.startExport(args, effectiveActor, signal)
        case 'export-get': {
          const { exportId } = z.object({ exportId: z.string() }).parse(args)
          return this.withSessionResources(this.exportView(exportId, effectiveActor), effectiveActor, typeof sessionToken === 'string' ? sessionToken : undefined)
        }
        case 'vision-models': {
          this.human(actor)
          if (!this.ctx.llm) throw new CuratorError('configuration-required', 'vision-model', 'The project model registry is unavailable.')
          return toJson(await listVisionModels(this.ctx.llm, signal))
        }
        case 'config-read': this.human(actor); return toJson(projectConfiguration(this.config, await this.credentialStatus()))
        case 'config-save': this.human(actor); return await this.saveConfig(args)
        default: return await this.domain.action(operation, args, effectiveActor)
      }
    } catch (error) {
      if (error instanceof z.ZodError) throw new CuratorError('invalid-input', input.operation, 'The operation input is invalid.', { cause: error })
      throw error
    }
  }
  private withSessionResources(value: Json, actor: DomainActor, token: string | undefined): Json {
    if (!token || !actor.sessionId || this.sessionGrants.get(token)?.sessionId !== actor.sessionId || this.sessionGrants.get(token)!.expiresAt <= Date.now()) return value
    if (typeof value === 'string') return value.startsWith('/api/visual-curator/resource?') ? `${value}&sessionToken=${encodeURIComponent(token)}` : value
    if (Array.isArray(value)) return value.map(item => this.withSessionResources(item, actor, token))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.withSessionResources(item, actor, token)]))
    return value
  }
  private wallpaperRunReport(run: RunRecord, actor: DomainActor, pageSize: number): Record<string, Json> {
    if (!canReadWallpaperChild(this.domain, run, actor)) this.engine.get(run.id, actor)
    const spec = specOf(run), state = wallpaperRunState(this.domain, run), settings = wallpaperSettingsSchema.parse(spec.fixed.wallpaper), data = dataOf(run)
    const selected = new Map(this.domain.repository.list('selection').filter(row => row.runId === run.id && row.qualification === 'auto-qualified').map(row => [row.imageVersionId, row]))
    const attentionItems = run.status === 'cancelled' ? [] : state.items.filter(item => item.status === 'needs-review' || item.status === 'technical-failed' || item.status === 'rejected' || !!wallpaperPendingDecision(item) && (!['created', 'running', 'pausing', 'cancelling'].includes(run.status) || !!wallpaperWorkImage(spec.input) && wallpaperWorkImage(spec.input) !== item.imageVersionId))
    const attention = attentionItems.slice(0, pageSize).map(item => {
      const source = this.domain.authorizedImage(item.imageVersionId, actor).asset, attempt = item.attempts.at(-1)
      return { sourceImageVersionId: item.imageVersionId, sourceName: source.source.description || source.id, status: item.status, ...(item.reason ? { reason: item.reason } : {}), ...(item.errorCode ? { errorCode: item.errorCode } : {}), ...(item.failedStep ? { failedStep: item.failedStep } : {}), ...(attempt ? { revision: attempt.revision, checks: attempt.checks } : {}) }
    })
    const outputs = state.items.flatMap(item => {
      const attempt = item.attempts.at(-1)
      if (!attempt?.outputId) return []
      const image = this.domain.authorizedImage(attempt.outputId, actor).image
      const source = this.domain.authorizedImage(item.imageVersionId, actor).asset
      const review = attempt.review ? wallpaperVerdict(attempt.review) : null
      const selection = selected.get(image.id), saved = selection ? this.domain.repository.get('assessment', selection.assessmentId) : undefined
      const assessment = saved?.runId === run.id && saved.imageVersionId === image.id ? saved : undefined
      const inherited = z.object({ reusedQualification: z.object({ runId: z.string(), assessmentId: z.string(), selectionId: z.string() }) }).safeParse(assessment?.data)
      return [{ imageVersionId: image.id, sourceImageVersionId: item.imageVersionId, sourceName: source.source.description || source.id, outputKind: image.versionKind, cumulativeImageEdits: item.edits, ...(assessment ? { assessmentId: assessment.id, inherited: inherited.success ? inherited.data.reusedQualification : null } : {}), status: item.status, width: image.geometry.width, height: image.geometry.height, review, passed: item.status === 'passed' && review === 'pass' && selected.has(image.id) && image.geometry.width === settings.width && image.geometry.height === settings.height, previewPath: `/api/visual-curator/resource?${new URLSearchParams({ imageVersionId: image.id })}` }]
    })
    const requestedCount = specOf(this.domain.require('run', state.sourceRunId)).input.targetCount
    const parentRunId = spec.input.continuationOf, kind = spec.input.continuationKind
    const changedImageVersionId = kind === 'rework' ? spec.input.reworkedImageId : kind === 'replan' ? spec.input.replacementImageId : kind === 'recompose' ? spec.input.recomposedImageId : kind === 'review' ? spec.input.reviewedImageId : undefined
    const continuation = typeof parentRunId === 'string' && (kind === 'rework' || kind === 'replan' || kind === 'recompose' || kind === 'continue' || kind === 'review') ? { parentRunId, kind, ...(typeof changedImageVersionId === 'string' ? { changedImageVersionId } : {}) } : undefined
    return { runId: run.id, sourceRunId: state.sourceRunId, artifactStorage: 'profile', ...(continuation ? { continuation } : {}), status: run.status, ...(run.stage ? { stage: run.stage } : {}), ...(run.outcome ? { outcome: run.outcome } : {}), ...(data.jobId ? { jobId: data.jobId } : {}), targetWidth: settings.width, targetHeight: settings.height, requestedCount: typeof requestedCount === 'number' ? requestedCount : null, total: state.items.length, passed: outputs.filter(output => output.passed).length, complete: run.status === 'completed' && state.items.length > 0 && outputs.filter(output => output.passed).length === state.items.length, counts: wallpaperProgress(state, wallpaperWorkImage(spec.input), run.status), budgetStopped: state.budgetStopped, attentionTotal: attentionItems.length, attention, outputs: outputs.slice(0, pageSize), ...(data.error ? { errorCode: data.error.code } : {}) }
  }
  private async credentialStatus(): Promise<{ source: boolean; vision: boolean }> {
    const { credentialRef } = await import('@deepseek-ai/dsh-credentials')
    const sourceRef = this.config.source.provider === 'unsplash' ? this.config.source.unsplash.accounts.find(item => item.id === this.config.source.unsplash.defaultAccountId)?.credentialRef : this.config.source.credentialRef
    return { source: !sourceRef || !!await this.ctx.credentials.resolve(credentialRef(sourceRef)), vision: !this.config.vision.credentialRef || !!await this.ctx.credentials.resolve(credentialRef(this.config.vision.credentialRef)) }
  }
  private recipe(operationId: Json | undefined): EvaluationRecipe {
    const id = `recipe-${contentDigest({ config: this.config, operationId }).slice(10, 42)}`, existing = this.domain.repository.get('recipe', id)
    return existing ?? recipeSchema.parse({ schemaVersion: 1, profileId: this.profileId, id, createdAt: new Date().toISOString(), kind: 'recipe', visionRevision: reviewerRevision(this.config), model: this.config.vision.model || 'unconfigured', vendorVersion: this.config.vision.vendorVersion, promptVersion: 'visual-curator-v1', outputSchemaVersion: '1', preprocessingVersion: this.files.processorVersion, referenceStrategy: { maxImages: this.config.limits.maxReferenceImages, maxBytes: this.config.limits.maxReferenceBytes }, preferenceScale: { min: 0, max: 1, weights: Object.fromEntries(['color', 'lighting', 'texture', 'subject', 'composition', 'density', 'depth'].map(dimension => [dimension, 1 / 7])) }, unknownPolicy: 'needs-review', tieBreak: 'stable-id' })
  }
  private ruleFromView(value: unknown, actor: DomainActor, previous: Rule[]): Rule {
    const input = z.object({ ruleId: z.string(), dimension: z.enum(['color', 'lighting', 'texture', 'subject', 'composition', 'density', 'depth']), statement: z.string().min(1), strength: z.enum(['required', 'preferred', 'reference-only']), stage: z.enum(['source', 'final']), confirmed: z.boolean(), condition: z.string(), exceptions: z.array(z.string()), supportRefs: z.array(z.string()), counterRefs: z.array(z.string()), notApplicableRefs: z.array(z.string()).optional() }).parse(value)
    const old = previous.find(rule => rule.ruleId === input.ruleId)
    const same = old && old.statement === input.statement && old.strength === input.strength && old.stage === input.stage && old.dimension === input.dimension
    return { ruleId: input.ruleId, dimension: input.dimension, statement: input.statement, strength: input.strength, stage: input.stage, condition: { ...(old?.condition.usageRevisionIds ? { usageRevisionIds: old.condition.usageRevisionIds } : {}), ...(input.condition.trim() ? { subjects: input.condition.split(',').map(item => item.trim()).filter(Boolean) } : {}) }, exceptions: old && JSON.stringify(input.exceptions) === JSON.stringify(old.exceptions.map(condition => condition.subjects?.join(', ') ?? condition.usageRevisionIds?.join(', ') ?? '')) ? old.exceptions : input.exceptions.map(exception => ({ subjects: [exception] })), supportRefs: input.supportRefs, counterRefs: input.counterRefs, ...(input.notApplicableRefs ? { notApplicableRefs: input.notApplicableRefs } : {}), check: old?.check.kind === 'measured' ? old.check : { kind: 'visual', criterion: input.statement }, confirmation: input.confirmed ? same && old.confirmation.status === 'confirmed' ? old.confirmation : { status: 'confirmed', actor: { kind: 'authenticated-human', id: actor.id, confirmationMethod: 'client-action', confirmedAt: new Date().toISOString() } } : { status: 'suggested' } }
  }
  private async importReferences(args: Record<string, Json>, actor: DomainActor, signal: AbortSignal): Promise<Json> {
    const input = uploadSchema.parse(args)
    if (input.files.length > this.config.limits.maxImportFiles) throw new CuratorError('invalid-input', 'import', 'The file count exceeds the configured batch limit.')
    const style = this.domain.require('style', input.styleId)
    const aggregateId = `import-batch:${input.operationId}`, prior = this.domain.repository.manifest(aggregateId)
    if (prior) {
      const completed = prior.receipts[input.operationId]
      const prepared = prior.receipts[`${input.operationId}:prepared`]
      if ((completed ?? prepared)?.requestDigest !== contentDigest(input)) throw new CuratorError('operation-conflict', 'import', 'The operation ID was used for a different import.')
      if (completed) return completed.state
      const pending = z.object({ results: z.array(jsonSchema), draftInput: jsonSchema.nullable() }).parse(prior.state)
      if (pending.draftInput) await this.domain.action('draft-save', pending.draftInput, actor)
      const response = { results: pending.results }
      await this.domain.repository.commit({ aggregateId, expectedRevision: prior.revision, operationId: input.operationId, request: input, records: [], state: response })
      return response
    }
    if (style.revision !== input.expectedRevision) throw new CuratorError('revision-conflict', 'import', 'The style changed before this import.')
    const results: Json[] = [], references: string[] = []
    for (const [index, file] of input.files.entries()) {
      signal.throwIfAborted()
      try {
        const fileOp = `${input.operationId}:file:${index}`, imageAggregate = `import:${fileOp}`
        let imageId: string
        const saved = this.domain.repository.manifest(imageAggregate)?.state
        if (saved && typeof saved === 'object' && !Array.isArray(saved) && typeof saved.imageId === 'string') imageId = saved.imageId
        else {
          const media = await this.files.importBytes(decodeUpload(file.base64, this.config.limits.maxImportBytes), file.mime || undefined, signal)
          const created = importedRecords(this.profileId, actor, media, { kind: 'local-import', description: file.name }, input.bytesAllowed ? 'bytes-allowed' : 'references-only')
          imageId = created.image.id
          await this.domain.repository.commit({ aggregateId: imageAggregate, expectedRevision: 0, operationId: fileOp, request: file, records: created.records, state: { imageId } })
        }
        const image = this.domain.authorizedImage(imageId, actor).image
        const reference = await this.domain.action('reference-confirm', { operationId: `${fileOp}:reference`, styleId: style.id, imageVersionId: image.id, role: file.role, intent: file.intent === 'overall' ? { kind: 'overall' } : { kind: 'dimensions', dimensions: file.dimensions }, context: {}, viewEvidence: [{ imageVersionId: image.id, versionKind: image.versionKind }] }, actor)
        const referenceId = z.object({ id: z.string() }).parse(reference).id
        references.push(referenceId); results.push({ name: file.name, ok: true, imageVersionId: imageId, referenceId })
      } catch (error) { signal.throwIfAborted(); results.push({ name: file.name, ok: false, error: toJson(safeFailure(error)) }) }
    }
    const draft = this.domain.require('draft', style.draftId)
    const draftInput = references.length ? toJson({ operationId: `${input.operationId}:draft`, styleId: style.id, expectedRevision: input.expectedRevision, rules: draft.rules, referenceIds: [...new Set([...draft.referenceIds, ...references])], feedbackIds: draft.feedbackIds, conflicts: draft.conflicts }) : null
    await this.domain.repository.commit({ aggregateId, expectedRevision: 0, operationId: `${input.operationId}:prepared`, request: input, records: [], state: { results, draftInput } })
    if (draftInput) await this.domain.action('draft-save', draftInput, actor)
    const response = { results }
    await this.domain.repository.commit({ aggregateId, expectedRevision: 1, operationId: input.operationId, request: input, records: [], state: response })
    return response
  }
  private async pickLocalReferences(args: Record<string, Json>, signal: AbortSignal): Promise<Json> {
    const label = z.string().min(1).max(120).regex(/^[^\r\n\0]+$/)
    const input = z.discriminatedUnion('kind', [z.strictObject({ kind: z.enum(['file', 'folder']), title: label }), z.strictObject({ kind: z.literal('references'), title: label, folderLabel: label, imagesLabel: label })]).parse(args)
    if (this.selectingLocalFiles) throw new CuratorError('capability-unavailable', 'local-picker', 'A local selection window is already open.')
    this.selectingLocalFiles = true
    try {
      const selected = this.dependencies.pickLocalPaths ? await this.dependencies.pickLocalPaths(input.kind, input.title, signal)
        : input.kind === 'references' ? await pickNativeReferences(signal, input)
          : input.kind === 'file' ? await pickNativeImages(signal, input.title)
          : await pickNativeDirectory(signal, {}, input.title).then(path => path ? [path] : null)
      signal.throwIfAborted()
      if (selected === null) return { files: [], cancelled: true }
      if (selected.length > this.config.limits.maxLocalReferenceFiles) throw new CuratorError('invalid-input', 'local-picker', 'The selection exceeds the configured local reference count.')
      const files = []
      for (const path of new Set(selected)) files.push(...await listLocalReferences(path, input.kind, this.config.limits.maxLocalReferenceFiles - files.length, signal))
      return toJson({ files, cancelled: false })
    } finally { this.selectingLocalFiles = false }
  }
  private async referenceLocalFiles(args: Record<string, Json>, actor: DomainActor, signal: AbortSignal): Promise<Json> {
    const input = z.strictObject({ operationId: z.string().min(1), styleId: z.string(), expectedRevision: z.number().int().positive(), role: z.enum(['positive', 'negative', 'undecided']), files: z.array(z.strictObject({ path: z.string().min(1), name: z.string().min(1) })).min(1) }).parse(args)
    if (input.files.length > this.config.limits.maxImportFiles) throw new CuratorError('invalid-input', 'local-reference', 'The reference batch exceeds the configured file count.')
    const style = this.domain.require('style', input.styleId), aggregateId = `local-reference:${input.operationId}`
    const prior = this.domain.repository.manifest(aggregateId)
    if (prior) {
      const completed = prior.receipts[input.operationId], prepared = prior.receipts[`${input.operationId}:prepared`]
      if ((completed ?? prepared)?.requestDigest !== contentDigest(input)) throw new CuratorError('operation-conflict', 'local-reference', 'The operation identity was used for another local reference selection.')
      if (completed) return completed.state
      const pending = z.object({ results: z.array(jsonSchema), draftInput: jsonSchema.nullable() }).parse(prior.state)
      if (pending.draftInput) await this.domain.action('draft-save', pending.draftInput, actor)
      const response = { results: pending.results }
      await this.domain.repository.commit({ aggregateId, expectedRevision: prior.revision, operationId: input.operationId, request: input, records: [], state: response })
      return response
    }
    if (style.revision !== input.expectedRevision) throw new CuratorError('revision-conflict', 'local-reference', 'The collection changed before local reference registration.')
    const results: Json[] = [], references: string[] = []
    for (const [index, file] of input.files.entries()) {
      signal.throwIfAborted()
      try {
        const fileOp = `${input.operationId}:file:${index}`
        const saved = this.domain.repository.manifest(`local-file:${fileOp}`)?.state
        let imageId: string
        if (saved && typeof saved === 'object' && !Array.isArray(saved) && typeof saved.imageId === 'string') imageId = saved.imageId
        else {
          const media = await this.files.referenceFile(file.path, signal)
          const created = importedRecords(this.profileId, actor, media, { kind: 'local-import', description: file.name })
          const existing = this.domain.repository.list('asset').find(asset => asset.originalBlob?.digest === media.originalBlob.digest)
          const asset = assetSchema.parse({ ...created.asset, familyId: existing?.familyId ?? media.originalBlob.digest })
          const committed = await this.domain.repository.commit({ aggregateId: `local-file:${fileOp}`, expectedRevision: 0, operationId: fileOp, request: file, records: [asset, created.image, created.preview], state: { imageId: created.image.id } })
          imageId = z.object({ imageId: z.string() }).parse(committed.state).imageId
        }
        const reference = await this.domain.action('reference-confirm', { operationId: `${fileOp}:reference`, styleId: style.id, imageVersionId: imageId, role: input.role, intent: { kind: 'overall' }, context: {}, viewEvidence: [{ imageVersionId: imageId, versionKind: 'normalized' }] }, actor)
        const referenceId = z.object({ id: z.string() }).parse(reference).id
        references.push(referenceId); results.push({ name: file.path, ok: true, imageVersionId: imageId, referenceId })
      } catch (error) { signal.throwIfAborted(); results.push({ name: file.path, ok: false, error: toJson(safeFailure(error)) }) }
    }
    const draft = this.domain.require('draft', style.draftId)
    const draftInput = references.length ? toJson({ operationId: `${input.operationId}:draft`, styleId: style.id, expectedRevision: input.expectedRevision, rules: draft.rules, referenceIds: [...new Set([...draft.referenceIds, ...references])], feedbackIds: draft.feedbackIds, conflicts: draft.conflicts }) : null
    await this.domain.repository.commit({ aggregateId, expectedRevision: 0, operationId: `${input.operationId}:prepared`, request: input, records: [], state: { results, draftInput } })
    if (draftInput) await this.domain.action('draft-save', draftInput, actor)
    const response = { results }
    await this.domain.repository.commit({ aggregateId, expectedRevision: 1, operationId: input.operationId, request: input, records: [], state: response })
    return response
  }
  private async confirmFeedback(args: Record<string, Json>, actor: DomainActor): Promise<Json> {
    this.human(actor)
    const context = feedbackContextSchema.parse(args.context), subject = subjectSchema.parse(args.subject)
    const run = context.runId ? this.engine.get(context.runId, actor) : undefined
    const expectedDigest = contentDigest(run ? specOf(run).input.taskBrief ?? '' : '')
    if (context.taskBriefDigest && context.taskBriefDigest !== expectedDigest) throw new CuratorError('constraint-conflict', 'feedback-confirm', 'The feedback task context is different.')
    const ids = subject.kind === 'pair' ? [subject.leftImageVersionId, subject.rightImageVersionId] : [subject.imageVersionId]
    if (run && ids.some(id => !this.domain.repository.list('assessment').some(a => a.runId === run.id && a.imageVersionId === id))) throw new CuratorError('constraint-conflict', 'feedback-confirm', 'Feedback pixels were not reviewed by this task.')
    return await this.domain.action('feedback-confirm', { ...args, context: { ...context, taskBriefDigest: expectedDigest } }, actor)
  }
  private async startTask(operation: string, args: Record<string, Json>, actor: DomainActor, signal: AbortSignal): Promise<Json> {
    const task = await this.resolveTask(operation, args, actor)
    if (args.preparationDigest !== undefined && args.preparationDigest !== this.taskDigest(task, actor)) throw new CuratorError('revision-conflict', 'task-prepare', 'The checked task changed; prepare it again before starting.')
    const launch = () => this.launch(task.kind, task.normalized, task.fixed, actor, z.string().parse(args.operationId), signal, task.config)
    return typeof task.fixed.searchLaunchId === 'string' ? await this.launchesValue!.admit(task.fixed.searchLaunchId, launch) : await launch()
  }
  private taskDigest(task: ResolvedTask, actor: DomainActor): string {
    const release = z.object({ id: z.string(), styleId: z.string() }).parse(task.fixed.release)
    const usage = task.fixed.usage ? z.object({ presetId: z.string() }).parse(task.fixed.usage) : undefined
    const currentUsage = usage && !task.fixed.searchLaunchId ? this.domain.repository.manifest(`usage:${usage.presetId}`)?.state ?? null : null
    // Search history is sampled at Run admission; new results do not change the checked task or rules.
    return contentDigest({ kind: task.kind, input: task.normalized, currentUsage, release: task.fixed.release, usage: task.fixed.usage ?? null, config: task.config, executionRecipe: task.fixed.executionRecipe ?? null, ...(task.fixed.searchScreening ? { searchScreening: task.fixed.searchScreening } : {}), currentProfileId: task.fixed.searchLaunchId ? null : new ModelProfiles(this.domain).current(release.styleId, actor)?.id ?? null })
  }
  private usagePage(args: Record<string, Json>): { items: import('../shared/model.ts').UsageRevision[]; pageToken?: string } {
    const input = z.object({ pageSize: z.number().int().min(1).max(100).default(this.config.limits.pageSize), pageToken: z.string().optional() }).parse(args)
    const latest = new Map<string, import('../shared/model.ts').UsageRevision>()
    for (const usage of this.domain.repository.list('usage')) if (!latest.has(usage.presetId) || latest.get(usage.presetId)!.revision < usage.revision) latest.set(usage.presetId, usage)
    const values = [...latest.values()].sort((a, b) => a.id.localeCompare(b.id, 'en')), ids = values.map(item => item.id)
    const offset = this.pageOffset(input.pageToken, 'usages', ids)
    return { items: values.slice(offset, offset + input.pageSize), ...(offset + input.pageSize < ids.length ? { pageToken: this.pageToken('usages', offset + input.pageSize, ids) } : {}) }
  }
  private async prepareTask(args: Record<string, Json>, actor: DomainActor): Promise<Json> {
    const { kind } = z.object({ kind: z.enum(['search', 'crop']) }).parse(args)
    const launchConfig = kind === 'search' ? this.launchesValue?.task(actor)?.config : undefined, config = launchConfig ?? this.config
    const options = { usages: this.usagePage({ ...(args.usagePageToken ? { pageToken: args.usagePageToken } : {}), ...(args.usagePageSize ? { pageSize: args.usagePageSize } : {}) }), sourceId: sourceIdentity(config).providerId, budgets: config.limits }
    const requestedOutput = searchOutputSchema.safeParse(args.output)
    const directOutput = kind === 'search' && requestedOutput.success && requestedOutput.data.kind !== 'usage'
    const fields = ['releaseId', ...(directOutput ? [] : ['usageRevisionId']), 'taskBrief', ...(kind === 'crop' && !Array.isArray(args.imageVersionIds) ? ['imageVersionId'] : [])]
    const missingFields = fields.filter(key => typeof args[key] !== 'string' || !String(args[key]).trim())
    if (missingFields.length) return toJson({ status: 'needs-input', missingFields, options })
    try {
      const sourceId = sourceIdentity(config).providerId
      const task = await this.resolveTask(`${kind}-start`, { ...args, operationId: 'prepare', sourceId: args.sourceId ?? sourceId }, actor)
      const normalizedInput: Record<string, Json> = { ...task.normalized, protectedContent: args.protectedContent ?? [], releaseId: args.releaseId!, ...(args.usageRevisionId ? { usageRevisionId: args.usageRevisionId } : {}), budgets: { targetCount: kind === 'search' ? task.normalized.targetCount ?? 1 : 1, ...Object.fromEntries(['maxVisionCalls', 'maxSearchPages', 'maxCandidates', 'maxDownloadBytes', 'maxCropCandidatesPerImage', 'maxConcurrentRequests', 'maxRetryAttempts', 'deadlineMs'].map(key => [key, Reflect.get(task.config.limits, key)])) }, ...(kind === 'search' ? { sourceId } : {}) }
      if (kind === 'crop' && Array.isArray(normalizedInput.imageVersionIds) && normalizedInput.imageVersionIds.length === 1) { normalizedInput.imageVersionId = normalizedInput.imageVersionIds[0]!; delete normalizedInput.imageVersionIds }
      const timingPolicy = taskTiming(task)
      return toJson({ status: 'ready', options, normalizedInput, timing: { policy: timingPolicy, deadlineEnforced: timingPolicy === 'bounded', configuredDeadlineMs: task.config.limits.deadlineMs }, preparationDigest: this.taskDigest(task, actor), warnings: [], summary: { executionInstructions: task.fixed.executionInstructions ?? null, executionRecipe: task.fixed.executionRecipe ?? null, ...(task.fixed.searchScreening ? { searchScreening: task.fixed.searchScreening } : {}), release: task.fixed.release, usage: task.fixed.usage ?? null, budgets: task.config.limits } })
    } catch (error) {
      // 私有资源错误保留拒绝语义，准备结果不能代替所有者检查。
      if (error instanceof CuratorError && error.code === 'owner-denied') throw error
      return toJson({ status: 'blocked', options, error: safeFailure(error) })
    }
  }
  private async resolveTask(operation: string, args: Record<string, Json>, actor: DomainActor, allowCollectionHistory = false, settings = this.config): Promise<ResolvedTask> {
    if (operation === 'manual-crop-confirm') this.human(actor)
    const input = startSchema.parse(operation === 'manual-crop-confirm' ? { ...args, taskBrief: typeof args.taskBrief === 'string' && args.taskBrief ? args.taskBrief : 'Review this manually selected crop against the frozen style and usage.' } : args)
    const launched = operation === 'search-start' ? this.launchesValue?.task(actor) : undefined
    if (launched) {
      const profile = z.object({ id: z.string() }).parse(launched.fixed.release)
      if (input.releaseId !== profile.id || input.taskBrief !== launched.input.taskBrief || (input.targetCount !== undefined && input.targetCount !== launched.input.targetCount) || (input.output !== undefined && contentDigest(input.output) !== contentDigest(launched.fixed.output))) throw new CuratorError('constraint-conflict', 'search-launch', 'Use this conversation launch’s frozen profile, task, quantity and output.')
      const preview = searchOutputSchema.parse(launched.fixed.output).kind === 'preview'
      if (preview && !input.queries?.length || input.queries && input.queries.length > launched.config.limits.maxSearchPages) throw new CuratorError('invalid-input', 'search-query-plan', 'Use explicit queries within the frozen search-page budget. Include the intended subject and visual style in each query.')
      launched.fixed.searchExclusions = await this.searchHistoryPolicy(executionStandard(styleStandardSchema.parse(launched.fixed.release), launched.fixed.executionRecipe), actor, input.taskBrief, true, launched.config.limits.requestTimeoutMs)
      launched.fixed.invocationDigest = contentDigest({ operation, args })
      return { kind: 'search', normalized: { ...launched.input, ...(input.queries ? { queries: input.queries } : {}) }, fixed: launched.fixed, config: launched.config }
    }
    const release = this.domain.repository.get('modelProfile', input.releaseId) ?? this.domain.require('release', input.releaseId), style = this.domain.require('style', release.styleId)
    if (release.kind === 'modelProfile' && !release.rules.some(isMatchingRule)) throw new CuratorError('constraint-conflict', 'resolve', 'Enable at least one style rule before starting a model-profile task.')
    this.domain.resolveRelease(style.id, release.id)
    await this.domain.verifyRelease(release, actor, input.datasetId ? { datasetId: input.datasetId } : {})
    const output = input.output ?? (input.usageRevisionId ? { kind: 'usage' as const, usageRevisionId: input.usageRevisionId } : undefined)
    if (!output || operation !== 'search-start' && output.kind !== 'usage') throw new CuratorError('invalid-input', 'resolve', 'A fixed usage is required for legacy searches and crops; original output must be explicit.')
    const usage = output.kind === 'usage' ? this.domain.require('usage', output.usageRevisionId) : undefined
    if (output.kind === 'preview' && settings.source.provider !== 'unsplash') throw new CuratorError('capability-unavailable', 'preview-search', 'Preview link search requires the Unsplash source. Choose original output for this source.')
    const limits = { ...settings.limits }
    const hardBudgets = ['maxVisionCalls', 'maxSearchPages', 'maxCandidates', 'maxDownloadBytes', 'maxCropCandidatesPerImage', 'maxConcurrentRequests', 'maxRetryAttempts', 'deadlineMs']
    for (const [key, value] of Object.entries(input.budgets ?? {})) {
      if (key === 'targetCount') continue
      if (!hardBudgets.includes(key)) throw new CuratorError('invalid-input', 'resolve', 'Only the declared hard task budgets may be overridden.')
      const configured = Reflect.get(limits, key)
      if (typeof configured !== 'number' || value > configured) throw new CuratorError('invalid-input', 'resolve', 'A task budget exceeds the deployment limit.')
      Reflect.set(limits, key, value)
    }
    const config = resolveConfig({ ...settings, limits })
    if (release.kind === 'release' && (release.recipe.visionRevision !== reviewerRevision(config) || release.recipe.preprocessingVersion !== this.files.processorVersion)) throw new CuratorError('constraint-conflict', 'resolve', 'The saved review recipe differs from this deployment. Publish a new reviewed version.')
    const vision = await this.providers.vision(config)
    vision.assertCapabilities(Math.min(release.references.length, release.kind === 'modelProfile' ? config.limits.maxReferenceImages : release.recipe.referenceStrategy.maxImages) + (output.kind === 'usage' ? 2 : 1))
    for (const rule of release.rules.filter(rule => rule.strength === 'required' && rule.stage === 'final' && rule.check.kind === 'measured')) {
      if (!usage || rule.check.kind !== 'measured' || rule.check.field === 'byteLength') continue
      const value = rule.check.field === 'width' ? usage.output.targetWidth : rule.check.field === 'height' ? usage.output.targetHeight : usage.output.aspectP / usage.output.aspectQ
      if (rule.check.min !== undefined && value < rule.check.min - rule.check.tolerance || rule.check.max !== undefined && value > rule.check.max + rule.check.tolerance) throw new CuratorError('constraint-conflict', 'resolve', 'The usage output conflicts with a required final rule.')
    }
    const fixed: Record<string, Json> = { invocationDigest: contentDigest({ operation, args }), release: toJson(release), output: toJson(output), ...(usage ? { usage: toJson({ ...usage, protectedContent: [...new Set([...usage.protectedContent, ...(input.protectedContent ?? [])])] }) } : {}) }
    if (release.kind === 'modelProfile') {
      const policy = { version: 2, minSatisfiedRatio: config.limits.minStyleMatchRatio }
      const dimensions = new Set(release.rules.filter(rule => rule.check.kind === 'visual' && rule.strength !== 'reference-only').map(rule => rule.dimension))
      const weights = Object.fromEntries(Object.entries(release.recipe.preferenceScale.weights).filter(([dimension]) => dimensions.has(dimension as Rule['dimension'])))
      const promptVersion = 'visual-curator-rules-v3'
      const reviewer = { visionRevision: reviewerRevision(config), model: config.vision.model, vendorVersion: config.vision.vendorVersion, preprocessingVersion: this.files.processorVersion, referenceStrategy: { maxImages: config.limits.maxReferenceImages, maxBytes: config.limits.maxReferenceBytes } }
      fixed.executionRecipe = toJson(recipeSchema.parse({ ...release.recipe, ...reviewer, id: `recipe-${contentDigest({ recipe: release.recipe, reviewer, standardDigest: release.contentDigest, policy, weights, promptVersion }).slice(10, 50)}`, preferenceScale: { ...release.recipe.preferenceScale, weights }, promptVersion, styleMatching: policy }))
      fixed.executionInstructions = compileStyleInstructions(release)
    }
    if (executionStandard(release, fixed.executionRecipe).recipe.promptVersion === 'visual-curator-rules-v3') {
      fixed.cropReviewPolicy = 'candidate-focus-v1'
      fixed.cropModelViews = 'bounded-v1'
    }
    const kind = operation === 'search-start' ? 'search' : 'crop'
    const normalized: Record<string, Json> = { taskBrief: input.taskBrief, ...(input.datasetId ? { datasetId: input.datasetId } : {}), ...(input.output ? { output: toJson(output) } : {}) }
    if (kind === 'search') {
      if (input.sourceId !== sourceIdentity(config).providerId) throw new CuratorError('invalid-input', 'resolve', 'The requested source is not configured.')
      await this.providers.source(config)
      const targetCount = input.budgets?.targetCount ?? input.targetCount ?? 10
      if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > config.limits.maxCandidates) throw new CuratorError('invalid-input', 'resolve', 'Target count exceeds the candidate budget.')
      const hints = config.source.provider === 'unsplash' && release.kind === 'modelProfile' && !release.options.some(option => option.selectionSource === 'user') ? styleAnalysisOf(this.domain.require('run', release.analysisRunId))?.summary.searchHints : undefined
      const queries = z.array(z.string().trim().min(1).max(4096)).min(1).parse(input.queries ?? (hints?.length ? hints : [input.taskBrief]))
      Object.assign(normalized, { queries, targetCount })
      if (config.searchScreening && config.searchScreening.enabled !== false) {
        const { enabled: _enabled, ...screening } = config.searchScreening
        fixed.searchScreening = toJson(searchScreeningPolicySchema.parse({ version: 1, ...screening }))
      }
      fixed.searchExclusions = await this.searchHistoryPolicy(executionStandard(release, fixed.executionRecipe), actor, input.taskBrief, allowCollectionHistory, config.limits.requestTimeoutMs)
    } else {
      const ids = input.imageVersionIds ?? (input.imageVersionId ? [input.imageVersionId] : [])
      if (!ids.length || ids.length > config.limits.maxCandidates) throw new CuratorError('invalid-input', 'resolve', 'Choose authorized saved image versions.')
      for (const id of ids) await this.files.read(this.domain.authorizedImage(id, actor).image.blob)
      normalized.imageVersionIds = ids
      if (operation === 'manual-crop-confirm') {
        const { normalizedRectSchema } = await import('../shared/model.ts')
        normalized.manualRect = toJson(normalizedRectSchema.parse(input.rect)); normalized.allowWarning = input.allowWarning ?? false; normalized.includeInLearning = input.includeInLearning ?? false
        for (const id of ids) resolveCrop(normalizedRectSchema.parse(input.rect), this.domain.authorizedImage(id, actor).image.geometry, usage!.output)
        fixed.humanConfirmation = { kind: 'authenticated-human', id: actor.id, confirmationMethod: 'client-action', confirmedAt: new Date().toISOString() }
      }
    }
    return { kind, normalized, fixed, config }
  }
  private async searchHistoryPolicy(standard: StyleStandard, actor: DomainActor, taskBrief: string, allowCollectionHistory: boolean, timeoutMs: number): Promise<Json> {
    const history: { run: import('../shared/model.ts').RunRecord; actor: DomainActor }[] = [], readable = new Map<string, boolean>()
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(timeoutMs)])
    for (const run of searchHistoryRuns(this.domain, standard.styleId)) {
      let reader = actor
      if (run.owner.kind === 'profile') { if (actor.kind !== 'human' && !allowCollectionHistory) continue; reader = { ...actor, kind: 'human' } }
      else if (run.owner.sessionId !== actor.sessionId) {
        if (actor.kind !== 'human' && !allowCollectionHistory) continue
        const sessionId = run.owner.sessionId
        if (!readable.has(sessionId)) readable.set(sessionId, await this.readableSession(sessionId, signal))
        if (!readable.get(sessionId)) continue
        reader = { ...actor, sessionId }
      }
      this.engine.get(run.id, reader); history.push({ run, actor: reader })
    }
    return toJson(this.domain.repository.readSnapshot(() => freezeSearchExclusions(this.domain, standard, actor, history, taskBrief)))
  }
  private async saveLibrary(args: Record<string, Json>, actor: DomainActor): Promise<Json> {
    const { imageVersionId, operationId } = z.object({ imageVersionId: z.string(), operationId: z.string() }).parse(args)
    const aggregateId = `library:${operationId}`, prior = this.domain.repository.manifest(aggregateId)
    if (prior) {
      if (prior.receipts[operationId]?.requestDigest !== contentDigest({ imageVersionId })) throw new CuratorError('operation-conflict', 'library-save', 'The operation ID was used for different pixels.')
      return prior.state
    }
    const { asset, image } = this.domain.authorizedImage(imageVersionId, actor)
    await this.files.read(image.blob)
    const copy = assetSchema.parse({ ...asset, id: randomUUID(), access: { kind: 'profile-library' }, createdAt: new Date().toISOString() })
    const pixels = imageVersionSchema.parse({ ...image, id: randomUUID(), assetId: copy.id, parentImageVersionId: undefined })
    const state = { assetId: copy.id, imageVersionId: pixels.id }
    await this.domain.repository.commit({ aggregateId, expectedRevision: 0, operationId, request: { imageVersionId }, records: [copy, pixels], state })
    return state
  }
  private async createSplit(args: Record<string, Json>, actor: DomainActor): Promise<Json> {
    this.human(actor)
    const input = z.object({ operationId: z.string(), assignments: z.array(z.object({ familyId: z.string(), split: z.enum(['learning', 'development', 'holdout']), groupingConfirmed: z.literal(true) })), supersedesSplitId: z.string().optional(), revealHoldout: z.boolean().optional() }).parse(args)
    await this.domain.action('family-confirm', { operationId: `${input.operationId}:grouping`, familyIds: input.assignments.map(item => item.familyId) }, actor)
    const old = input.supersedesSplitId ? this.domain.require('split', input.supersedesSplitId) : undefined
    const uses = [...(old?.uses ?? []), ...(input.revealHoldout && old ? old.assignments.filter(item => item.split === 'holdout').map(item => ({ familyId: item.familyId, purpose: 'revealed' as const, at: new Date().toISOString() })) : [])]
    return await this.domain.action('split-create', { operationId: input.operationId, assignments: input.assignments, ...(input.supersedesSplitId ? { supersedesSplitId: input.supersedesSplitId } : {}), uses }, actor)
  }
  private async startEvaluation(args: Record<string, Json>, actor: DomainActor, signal: AbortSignal): Promise<Json> {
    this.human(actor)
    const { operationId, leftId, rightId, splitId, usageRevisionId } = z.object({ operationId: z.string(), leftId: z.string(), rightId: z.string(), splitId: z.string(), usageRevisionId: z.string() }).parse(args)
    const standard = (id: string) => this.domain.repository.get('release', id) ?? this.domain.require('candidate', id)
    const left = standard(leftId), right = standard(rightId), split = this.domain.require('split', splitId), usage = this.domain.require('usage', usageRevisionId)
    this.domain.assertSplitUsable(split)
    if (left.styleId !== right.styleId || left.recipe.visionRevision !== reviewerRevision(this.config) || right.recipe.visionRevision !== reviewerRevision(this.config)) throw new CuratorError('constraint-conflict', 'evaluation', 'Compare versions of one style using the same configured reviewer. Calibrate a candidate with that reviewer first.')
    for (const standardSnapshot of [left, right]) for (const reference of standardSnapshot.references) {
      const image = this.domain.authorizedImage(reference.reference.imageVersionId, actor).image
      if (image.blob.digest !== reference.imageDigest) throw new CuratorError('reference-unavailable', 'evaluation', 'A fixed reference digest is unavailable.')
      await this.files.read(image.blob)
    }
    await this.providers.vision(this.config)
    const selected = this.domain.repository.list('imageVersion').filter(image => image.versionKind === 'normalized' && split.assignments.some(assignment => assignment.split !== 'learning' && this.domain.familyOf(assignment.familyId) === this.domain.familyOf(this.domain.require('asset', image.assetId).familyId))).map(image => this.domain.authorizedImage(image.id, actor).image)
    const images = [...new Map(selected.map(image => [image.blob.digest, image])).values()]
    return await this.launch('evaluate', { leftId, rightId, splitId, usageRevisionId }, { invocationDigest: contentDigest({ operation: 'evaluate-start', args }), left: toJson(left), right: toJson(right), split: toJson(split), usage: toJson(usage), feedback: toJson(this.domain.snapshot(actor).feedback), humanActor: toJson(actor), images: toJson(images) }, actor, operationId, signal)
  }
  private async startExport(args: Record<string, Json>, actor: DomainActor, signal: AbortSignal): Promise<Json> {
    const { kind, operationId, sampleScope, ...rest } = z.object({ kind: z.enum(['style', 'classification', 'preference', 'crop', 'skill']), operationId: z.string(), purpose: z.enum(['training', 'development', 'holdout', 'reference']), releaseId: z.string(), splitId: z.string().optional(), mode: z.enum(['references-only', 'with-bytes']).default('references-only'), usageRevisionId: z.string().optional(), analysisRunId: z.string().optional(), sampleScope: datasetScopeSchema.default('all') }).parse(args)
    const profile = this.domain.repository.get('modelProfile', rest.releaseId)
    if (profile) {
      if (!['style', 'skill'].includes(kind) || rest.purpose !== 'reference' || rest.mode !== 'references-only') throw new CuratorError('constraint-conflict', 'profile-export', 'Model profiles export reference packages only; human supervision and image-byte permissions remain separate.')
      new ModelProfiles(this.domain).assertFresh(profile, actor)
      if (sampleScope === 'all' && !profile.rules.some(isMatchingRule)) throw new CuratorError('constraint-conflict', 'profile-export', 'Enable at least one style rule before exporting.')
      if (!profile.references.some(ref => sampleScope === 'all' || sampleScope === 'observations' || effectiveReviewReferenceRole(profile, ref) === sampleScope)) throw new CuratorError('constraint-conflict', 'profile-export', 'There are no analyzed references in the selected export scope.')
      return await this.launch('export', { operationId: `${operationId}:export`, modelProfileId: profile.id, sampleScope }, { invocationDigest: contentDigest({ operation: 'export-start', args }), actor: toJson(actor) }, actor, operationId, signal)
    }
    if (sampleScope !== 'all') throw new CuratorError('constraint-conflict', 'export', 'Role-filtered observation exports require an analyzed model profile.')
    if (!rest.splitId) throw new CuratorError('invalid-input', 'export', 'A supervised or human-release export requires its saved split.')
    this.domain.require('release', rest.releaseId); this.domain.require('split', rest.splitId)
    const exportInput = z.record(z.string(), jsonSchema).parse(toJson({ operationId: `${operationId}:export`, exportKind: kind, ...rest }))
    return await this.launch('export', exportInput, { invocationDigest: contentDigest({ operation: 'export-start', args }), actor: toJson(actor), feedbackHeads: toJson(this.domain.snapshot(actor).feedback.map(feedback => feedback.id)) }, actor, operationId, signal)
  }
  private authorizedExport(id: string, actor: DomainActor): ProfileExport | ExportSnapshot {
    return this.domain.repository.readSnapshot(() => {
      const profileExport = this.domain.repository.get('profileExport', id)
      if (profileExport) {
        new ModelProfiles(this.domain).authorize(this.domain.require('modelProfile', profileExport.modelProfileId), actor)
        return profileExport
      }
      const snapshot = this.domain.repository.get('export', id)
      if (!snapshot) throw new CuratorError('owner-denied', 'export-read', 'This export is unavailable to the current owner.')
      try { this.domain.authorizeExport(snapshot, actor); for (const resource of snapshot.resources) this.domain.authorizedImage(resource.imageVersionId, actor) }
      catch (error) { if (!(error instanceof CuratorError)) throw error; throw new CuratorError('owner-denied', 'export-read', 'This export is unavailable to the current owner.', { cause: error }) }
      return snapshot
    })
  }
  private exportView(id: string, actor: DomainActor): Json {
    const saved = this.authorizedExport(id, actor)
    if (saved.kind === 'profileExport') {
      const profileExport = saved
      return toJson({ exportId: profileExport.id, kind: 'style', status: 'ready', downloadPath: `/api/visual-curator/resource?exportId=${encodeURIComponent(id)}${actor.sessionId ? `&sessionId=${encodeURIComponent(actor.sessionId)}` : ''}`, checksum: contentDigest(profileExport.files), preview: profileExport.files.map(file => `${file.name}\n${file.content}`).join('\n\n'), exclusions: [] })
    }
    const snapshot = saved
    return toJson({ exportId: snapshot.id, kind: snapshot.exportKind, status: 'ready', downloadPath: `/api/visual-curator/resource?exportId=${encodeURIComponent(id)}${actor.sessionId ? `&sessionId=${encodeURIComponent(actor.sessionId)}` : ''}`, checksum: contentDigest(snapshot.files), preview: snapshot.files.map(file => `${file.name}\n${file.content}`).join('\n\n'), exclusions: Object.entries(snapshot.exclusions).map(([reason, count]) => ({ reason, count })) })
  }
  private async saveConfig(args: Record<string, Json>): Promise<Json> {
    const input = z.object({ revision: z.string(), source: z.record(z.string(), jsonSchema), vision: z.record(z.string(), jsonSchema), limits: z.record(z.string(), jsonSchema), searchScreening: z.record(z.string(), jsonSchema).optional() }).parse(args)
    if (input.revision !== configRevision(this.config)) throw new CuratorError('revision-conflict', 'configuration', 'Configuration changed; refresh before saving.')
    const next = resolveCurrentConfig({ ...(this.config.serverQueue ? { serverQueue: this.config.serverQueue } : {}), wallpaper: this.config.wallpaper, source: { ...this.config.source, ...input.source }, vision: { ...this.config.vision, reasoningEffort: this.config.vision.reasoningEffort ?? null, ...input.vision }, limits: { ...this.config.limits, ...input.limits }, searchScreening: { ...this.config.searchScreening, ...input.searchScreening } })
    if (next.vision.backend === 'native' && (next.vision.backend !== this.config.vision.backend || next.vision.provider !== this.config.vision.provider || next.vision.model !== this.config.vision.model)) {
      await requireVisionModel(this.ctx.llm, next.vision.provider, next.vision.model, this.lifetime.signal)
    }
    if (configRevision(next) === input.revision) return toJson({ saved: true, changed: false, configuration: projectConfiguration(this.config, await this.credentialStatus()) })
    if (next.vision.backend === 'native' || next.vision.provider) await this.providers.vision(next)
    const ownedEntry = this.ctx.fiber?.entry
    const entry = this.ctx.configEditor.entries().find(row => ownedEntry ? row === ownedEntry : row.options.id === 'visual-curator')
    if (!entry) throw new CuratorError('capability-unavailable', 'configuration', 'The profile configuration entry is unavailable.')
    await this.ctx.configEditor.edit(entry, current => {
      const raw = z.record(z.string(), z.unknown()).parse(current)
      const { compaction: _compaction, ...settings } = raw
      const previous = resolveCurrentConfig(settings)
      if (configRevision(previous) !== input.revision) throw new CuratorError('revision-conflict', 'configuration', 'Configuration changed while saving.')
      // 保留未修改字段的原始默认写法，避免补全 limits 默认值触发不必要的整插件重载。
      return { ...raw,
        ...(configRevision(previous.source) !== configRevision(next.source) ? { source: next.source } : {}),
        ...(configRevision(previous.limits) !== configRevision(next.limits) ? { limits: next.limits } : {}),
        ...(configRevision(previous.searchScreening) !== configRevision(next.searchScreening) ? { searchScreening: next.searchScreening } : {}),
        ...(configRevision(previous.vision) !== configRevision(next.vision) ? { vision: { ...next.vision, reasoningEffort: next.vision.reasoningEffort ?? null } } : {}),
      }
    })
    this.configValue = next
    return toJson({ saved: true, changed: true, revision: configRevision(next), configuration: projectConfiguration(next, await this.credentialStatus()) })
  }
  private workspaceRevision(): string { return this.domain.repository.revisionDigest() }
  private pageToken(scope: string, offset: number, ids: string[]): string { return Buffer.from(JSON.stringify({ scope, offset, digest: contentDigest(ids) })).toString('base64url') }
  private pageOffset(token: string | undefined, scope: string, ids: string[]): number {
    if (!token) return 0
    const value = z.strictObject({ scope: z.literal(scope), offset: z.number().int().nonnegative(), digest: z.literal(contentDigest(ids)) }).parse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')))
    if (value.offset > ids.length) throw new CuratorError('invalid-input', 'pagination', 'The saved page is unavailable; restart the listing.')
    return value.offset
  }
  /** Deliver saved images, queued server previews, unsigned gallery previews and exports after profile authentication.
   * @param request Authenticated same-origin request; server previews use the profile queue's image allowlist and gallery URLs use the public Unsplash policy. @returns Bounded raster bytes, or a deployment-selected CDN redirect.
   */
  resource(request: Request): Promise<Response> { return this.track(this.resourceNow(request)) }
  private async resourceNow(request: Request): Promise<Response> {
    try {
      if (this.stopping) throw new CuratorError('capability-unavailable', 'resource', 'The plugin is stopping.')
      const resourceSignal = AbortSignal.any([request.signal, this.lifetime.signal])
      const url = new URL(request.url)
      const actor = await this.scopedHuman({ kind: 'human', id: 'profile-owner', profileId: this.profileId }, { ...(url.searchParams.get('sessionToken') ? { sessionToken: url.searchParams.get('sessionToken')! } : {}) }, resourceSignal, true)
      if (url.searchParams.get('sessionId') && actor.sessionId !== url.searchParams.get('sessionId')) throw new CuratorError('owner-denied', 'resource', 'Open the owning Session channel before requesting this resource.')
      const imageId = url.searchParams.get('imageVersionId'), exportId = url.searchParams.get('exportId'), galleryUrl = url.searchParams.get('galleryUrl'), selectionId = url.searchParams.get('selectionId')
      const headers = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" }
      const serverImageId = url.searchParams.get('serverImageId'), serverSnapshotId = url.searchParams.get('serverSnapshotId')
      if (serverImageId || serverSnapshotId) {
        if (!serverImageId || !serverSnapshotId || imageId || exportId || galleryUrl || selectionId) return new Response(null, { status: 400 })
        const preview = await this.serverQueueValue!.preview(serverImageId, serverSnapshotId, actor, resourceSignal)
        return new Response(request.method === 'HEAD' ? null : new Uint8Array(preview.bytes), { headers: { ...headers, 'content-type': preview.mime, 'content-length': String(preview.bytes.length), 'referrer-policy': 'no-referrer' } })
      }
      if (selectionId) {
        if (imageId || exportId || galleryUrl) return new Response(null, { status: 400 })
        const resource = await originalSearchResult(this.domain, this.files, selectionId, actor)
        return new Response(request.method === 'HEAD' ? null : new Uint8Array(resource.bytes), { headers: { ...headers, 'content-type': resource.mime, 'content-length': String(resource.bytes.length), 'content-disposition': `attachment; filename="visual-curator-${encodeURIComponent(selectionId)}.${resource.mime === 'image/jpeg' ? 'jpg' : resource.mime === 'image/webp' ? 'webp' : 'png'}"` } })
      }
      if (galleryUrl && !imageId && !exportId) return await this.readPreview(galleryMediaUrlSchema.parse(galleryUrl), headers, resourceSignal, request.method === 'HEAD')
      if (imageId && !exportId && !galleryUrl) {
        const { image } = this.domain.authorizedImage(imageId, actor)
        if (image.blob.remoteSource) {
          await this.files.verifyReference(image.blob, resourceSignal)
          const location = remotePreviewLocation(image.blob.remoteSource, url.searchParams.get('preview') === 'thumbnail')
          return await this.readPreview(location, headers, resourceSignal, request.method === 'HEAD')
        }
        const thumbnail = url.searchParams.get('preview') === 'thumbnail'
        const bytes = thumbnail ? await this.files.thumbnail(image.blob, resourceSignal) : await this.files.read(image.blob, resourceSignal)
        return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), { headers: { ...headers, 'content-type': thumbnail ? 'image/webp' : image.blob.mime, 'content-length': String(bytes.length) } })
      }
      if (exportId && !imageId && !galleryUrl) {
        const saved = this.authorizedExport(exportId, actor), head = request.method === 'HEAD'
        if (saved.kind === 'profileExport') {
          const body = head ? null : JSON.stringify({ formatVersion: 2, export: saved.id, files: saved.files, resources: [] })
          return new Response(body, { headers: { ...headers, 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="visual-curator-${saved.id}.json"` } })
        }
        const snapshot = saved
        const resources: Json[] = []
        if (snapshot.mode === 'with-bytes') for (const resource of snapshot.resources) {
          const image = this.domain.authorizedImage(resource.imageVersionId, actor).image
          const bytes = await this.files.read(image.blob, resourceSignal)
          if (!head) resources.push({ imageVersionId: image.id, mime: image.blob.mime, digest: image.blob.digest, base64: bytes.toString('base64') })
        }
        const body = head ? null : JSON.stringify({ formatVersion: 1, export: snapshot.id, files: snapshot.files, resources })
        return new Response(body, { headers: { ...headers, 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="visual-curator-${snapshot.id}.json"` } })
      }
      return new Response(null, { status: 400 })
    } catch (error) { return new Response(JSON.stringify(safeFailure(error)), { status: error instanceof CuratorError && error.code === 'owner-denied' ? 403 : 404, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }) }
  }
  private async readPreview(location: string, headers: Record<string, string>, signal: AbortSignal, head: boolean): Promise<Response> {
    if (this.config.source.unsplash.previewTransport === 'redirect') return new Response(null, { status: 302, headers: { ...headers, location, 'referrer-policy': 'no-referrer' } })
    const response = await this.previewReads.read(location, signal)
    return new Response(head ? null : new Uint8Array(response.bytes), { headers: { ...headers, 'cache-control': `private, max-age=${Math.floor(this.config.source.unsplash.cache.ttlMs / 1000)}`, 'content-type': response.mime, 'content-length': String(response.bytes.length), 'referrer-policy': 'no-referrer' } })
  }
  private async loadPreview(location: string, signal: AbortSignal) {
    const media = this.dependencies.galleryMedia ?? this.providers.media({ ...this.config, source: { ...this.config.source, provider: 'unsplash' } })
    const response = await media.request(location, { signal, method: 'GET', maxBytes: this.config.limits.maxReferenceBytes, timeoutMs: this.config.limits.requestTimeoutMs, maxRedirects: this.config.limits.maxRedirects, headers: { accept: 'image/jpeg,image/png,image/webp' } })
    const mime = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
    if (!mime || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime)) throw new CuratorError('reference-unavailable', 'resource', 'The image source did not return supported raster bytes.')
    return { bytes: response.bytes, mime }
  }
  /** Workspace reads, task controls and configuration saves bypass bounded action-text responses.
   * @param request Authenticated same-origin JSON request. @returns Validated workspace data or a safe command result.
   */
  async data(request: Request): Promise<Response> {
    return await this.workspaceData(request, ['server-queue-read', 'server-queue-configure', 'server-queue-pull', 'server-queue-start', 'server-queue-import-retry', 'server-queue-import-delete', 'server-queue-retry', 'server-queue-recheck', 'direct-crop-start', 'direct-crop-replace', 'direct-crop-list', 'direct-crop-delete', 'direct-crop-export', 'wallpaper-read', 'wallpaper-start', 'wallpaper-options', 'wallpaper-control', 'wallpaper-continue', 'wallpaper-plan-update', 'wallpaper-experience', 'wallpaper-experience-action', 'wallpaper-case', 'task-reference-list', 'task-reference-import', 'task-reference-start', 'search-launch-options', 'search-launch-datasets', 'search-launch-list', 'search-launch-start', 'search-launch-resume', 'search-launch-presentation', 'search-launch-stop', 'task-prepare', 'usage-list', 'snapshot', 'search-batches', 'search-batch-detail', 'conversation-runs', 'run-get', 'run-control', 'run-delete', 'workflow-delete', 'export-get', 'export-start', 'datasets-list', 'dataset-get', 'dataset-delete', 'local-files-list', 'references-list', 'reference-state', 'analysis-detail', 'analysis-input', 'analysis-pause', 'analysis-resume', 'analysis-stop', 'reference-organize', 'reference-analyze', 'vision-models', 'config-read', 'config-save', 'profile-save', 'profile-current', 'style-get'])
  }
  /** @param request Authenticated account check, listing or selected-photo import. @returns Bounded JSON without action-text truncation. */
  async gallery(request: Request): Promise<Response> {
    return this.workspaceData(request, ['gallery-validate', 'gallery-collections', 'gallery-photos', 'gallery-import', 'gallery-import-progress', 'gallery-import-cancel', 'gallery-login-start', 'gallery-login-status', 'gallery-login-retry', 'gallery-login-finish', 'gallery-login-cancel', 'gallery-reference-start', 'gallery-reference-resume', 'gallery-reference-tasks', 'gallery-reference-stop'])
  }
  /** Register only authenticated Client-selected local paths through the bounded JSON route.
   * @param request Local-reference mutation envelope. @returns Per-file registration outcomes without copied bytes.
   */
  async localReferenceData(request: Request): Promise<Response> { return await this.workspaceData(request, ['reference-local-import', 'local-reference-pick']) }
  /** @param request Authenticated, bounded analysis subscription. @returns Native SSE output; closing the response does not stop the task. */
  async followAnalysis(request: Request): Promise<Response> {
    try {
      if (this.stopping) throw new CuratorError('capability-unavailable', 'analysis-follow', 'The plugin is stopping.')
      const input = await this.requestInput(request)
      if (input.operation !== 'analysis-follow') throw new CuratorError('owner-denied', 'analysis-follow', 'This route accepts analysis subscriptions only.')
      const args = z.strictObject({ runId: z.string().min(1), sessionToken: z.string().optional() }).parse(input.args)
      const actor = await this.scopedHuman({ kind: 'human', id: 'profile-owner', profileId: this.profileId }, input.args, AbortSignal.any([request.signal, this.lifetime.signal]), true)
      const grant = args.sessionToken ? this.sessionGrants.get(args.sessionToken) : undefined
      const signal = AbortSignal.any([request.signal, this.lifetime.signal, ...(grant ? [AbortSignal.timeout(Math.max(0, grant.expiresAt - Date.now()))] : [])])
      // 订阅注册与首帧准备是同步读取；快照不跨越后续 SSE 观察生命周期。
      return this.domain.repository.readSnapshot(() => analysisFollowResponse(this.engine, this.engine.get(args.runId, actor), actor, signal))
    } catch (error) { return Response.json({ ok: false, error: safeFailure(error) }, { status: 400, headers: { 'cache-control': 'no-store' } }) }
  }
  private async requestInput(request: Request): Promise<z.infer<typeof actionSchema>> {
    const chunks: Uint8Array[] = []; let size = 0
    const reader = request.body?.getReader()
    if (!reader) throw new CuratorError('invalid-input', 'data-read', 'A JSON read request is required.')
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > this.config.limits.maxClientRequestBytes) { await reader.cancel(); throw new CuratorError('invalid-input', 'data-read', 'The read request exceeds the configured byte limit.') }
        chunks.push(chunk.value)
      }
    } finally { reader.releaseLock() }
    return actionSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))))
  }
  private async workspaceData(request: Request, operations: readonly string[]): Promise<Response> {
    try {
      const input = await this.requestInput(request)
      if (!operations.includes(input.operation)) throw new CuratorError('owner-denied', 'data-read', 'This route does not accept the requested operation.')
      const value = await this.action(input, { kind: 'human', id: 'profile-owner', profileId: this.profileId }, request.signal)
      return Response.json({ ok: true, value }, { headers: { 'cache-control': 'private, no-store' } })
    } catch (error) { return Response.json({ ok: false, error: safeFailure(error) }, { status: 400, headers: { 'cache-control': 'no-store' } }) }
  }
  /** Stop admitting work, drain jobs, then release the sole profile writer. */
  async dispose(): Promise<void> {
    this.stopping = true
    this.datasetReads.dispose()
    this.analysisTaskReads.dispose()
    const references = this.galleryTasks?.dispose() ?? Promise.resolve()
    const removals = this.workflowHistoryValue?.dispose() ?? Promise.resolve()
    const jobs = removals.then(() => Promise.allSettled([references, this.previewReads.dispose(), this.engineValue?.dispose(), this.serverQueueValue?.drain(), this.launchesValue?.drain(), this.organizationValue?.drain(), this.logins?.dispose(), this.providers.dispose?.(), this.galleryProviders?.dispose(), references.catch(() => {}).then(() => this.galleryValue?.dispose())]))
    this.lifetime.abort()
    try {
      await Promise.allSettled([...this.foreground])
      const settled = await jobs
      const rejected = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected')
      if (rejected) throw rejected.reason
    } finally {
      this.sessionGrants.clear()
      await this.domainValue?.close()
    }
  }
}
