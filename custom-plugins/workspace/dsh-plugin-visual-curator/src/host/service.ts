/** Shared business provider for authenticated workbench actions and the eight Agent tools. */
import type { Context } from '@deepseek-ai/cordis'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { ConfigEditor } from '@deepseek-ai/dsh-config-editor'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
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
import { AssetFiles, resolveCrop } from '../media/index.ts'
import { CuratorError } from '../shared/errors.ts'
import { assetSchema, imageVersionSchema, jsonSchema, recipeSchema, feedbackContextSchema, subjectSchema, type DomainActor, type Json, type Rule, type EvaluationRecipe, type CuratorRecord } from '../shared/model.ts'
import { agentOperations, type ClientActionInput } from '../client/contract.ts'
import { resolveConfig, configRevision, reviewerRevision, type CuratorConfig } from './config.ts'
import { RunEngine, executionSchema, dataOf, specOf, toJson, safeFailure, type ExecutionSpec, type Worker } from './runtime.ts'
import { ProviderFactory } from './providers.ts'
import { importedRecords } from './imports.ts'
import { createCropWorker, createCropProcessor } from './crop-workflow.ts'
import { createSearchWorker } from './search-workflow.ts'
import { createDataWorker } from './data-workflows.ts'
import { projectSnapshot, projectRun } from './projection.ts'

const actionSchema = z.strictObject({ operation: z.string().min(1), args: z.record(z.string(), jsonSchema) })
declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    'plugin:visual-curator/request': { version: 1; runId: string; requestId: string; state: string; requestDigest: string; data: Json }
  }
}
const startSchema = z.object({ operationId: z.string().min(1), releaseId: z.string().min(1), usageRevisionId: z.string().min(1), taskBrief: z.string().min(1).max(4000), budgets: z.record(z.string(), z.number()).optional(), sourceId: z.string().optional(), imageVersionId: z.string().optional(), imageVersionIds: z.array(z.string()).optional(), queries: z.array(z.string().min(1).max(4096)).optional(), targetCount: z.number().int().positive().optional(), protectedContent: z.array(z.string().min(1)).optional(), rect: z.unknown().optional(), includeInLearning: z.boolean().optional(), allowWarning: z.boolean().optional(), runId: z.string().optional() })
const uploadSchema = z.strictObject({ operationId: z.string().min(1), styleId: z.string().min(1), expectedRevision: z.number().int().positive(), bytesAllowed: z.boolean().default(false), files: z.array(z.strictObject({ name: z.string().min(1).max(1024), mime: z.string(), base64: z.string(), role: z.enum(['positive', 'negative', 'undecided']), intent: z.enum(['overall', 'dimensions']), dimensions: z.array(z.enum(['color', 'lighting', 'texture', 'subject', 'composition', 'density', 'depth'])) })).min(1) })

/** Same-process fixture dependencies never come from Client, tool or configuration JSON. */
export interface CuratorServiceDependencies {
  openDomain?: (files: AssetFiles) => Promise<CuratorDomain>
  providers?: Pick<ProviderFactory, 'vision' | 'source' | 'media'>
}
/** Minimal Host capabilities used by this provider; Cordis owns their actual implementations. */
export interface CuratorHost {
  profileContext: Pick<ProfileContext, 'dir'>
  credentials: Pick<CredentialProvider, 'resolve'>
  jobs: Pick<JobRegistry, 'start'>
  storageDomain: Pick<DomainFacility, 'open'>
  configEditor: Pick<ConfigEditor, 'entries' | 'edit'>
  sessions: Pick<SessionStore, 'get'>
}

/** One provider owns one profile writer; it never changes the default bundle composition. */
export class CuratorService {
  readonly profileId: string
  readonly config: CuratorConfig
  private domainValue: CuratorDomain | undefined
  private engineValue: RunEngine | undefined
  private readonly files: AssetFiles
  private readonly providers: Pick<ProviderFactory, 'vision' | 'source' | 'media'>
  private stopping = false
  private readonly lifetime = new AbortController()
  private readonly foreground = new Set<Promise<unknown>>()
  private readonly sessionGrants = new Map<string, { sessionId: string; expiresAt: number }>()
  constructor(private readonly ctx: CuratorHost, input: unknown, private readonly dependencies: CuratorServiceDependencies = {}) {
    this.config = resolveConfig(input)
    this.profileId = createHash('sha256').update(resolve(ctx.profileContext.dir)).digest('hex')
    const l = this.config.limits
    this.files = new AssetFiles(join(ctx.profileContext.dir, 'visual-curator'), { maxFileBytes: l.maxImportBytes, maxPixels: l.maxPixels, maxDimension: l.maxDimension, previewMaxDimension: l.previewMaxDimension, maxStorageBytes: l.maxStorageBytes })
    this.providers = dependencies.providers ?? new ProviderFactory(ctx.credentials)
  }
  /** Acquire exclusive persistence before accepting Client or Agent operations. */
  async initialize(): Promise<void> {
    if (this.domainValue || this.stopping) throw new CuratorError('capability-unavailable', 'initialize', 'The provider is already initialized or stopping.')
    this.domainValue = this.dependencies.openDomain ? await this.dependencies.openDomain(this.files) : await openCuratorDomain({ profileId: this.profileId, facility: this.ctx.storageDomain, lockPath: join(this.files.root, 'writer.lock'), verifyImage: async image => { await this.files.read(image.blob) } })
    this.engineValue = new RunEngine(this.domainValue.repository, this.ctx.jobs, (run, request) => {
      if (run.owner.kind !== 'session') return
      const session = this.ctx.sessions.get(brandString<SessionId>(run.owner.sessionId))
      if (!session) throw new CuratorError('owner-denied', 'auxiliary-request-log', 'The owning Session is unavailable; no auxiliary model request can be dispatched.')
      appendPluginRecord(session, 'plugin:visual-curator/request', { version: 1, runId: run.id, requestId: request.id, state: request.state, requestDigest: request.requestDigest, data: request.data })
    })
    await this.engineValue.recover()
  }
  private get domain(): CuratorDomain { if (!this.domainValue) throw new CuratorError('capability-unavailable', 'service', 'The provider is unavailable.'); return this.domainValue }
  private get engine(): RunEngine { if (!this.engineValue) throw new CuratorError('capability-unavailable', 'service', 'The task controller is unavailable.'); return this.engineValue }
  private human(actor: DomainActor): void { if (actor.kind !== 'human') throw new CuratorError('owner-denied', 'confirmation', 'This operation requires the authenticated workbench owner.') }
  private scopedHuman(actor: DomainActor, args: Record<string, Json>): DomainActor {
    if (actor.kind !== 'human') return actor
    if (!args.sessionToken) return { kind: actor.kind, id: actor.id, profileId: actor.profileId }
    const grant = typeof args.sessionToken === 'string' ? this.sessionGrants.get(args.sessionToken) : undefined
    if (!grant || grant.expiresAt <= Date.now() || !this.ctx.sessions.get(brandString<SessionId>(grant.sessionId))) throw new CuratorError('owner-denied', 'session-channel', 'The Session channel expired or is unavailable. Open it again from the workbench.')
    return { ...actor, sessionId: grant.sessionId }
  }
  private worker(kind: ExecutionSpec['kind']): Worker {
    const dependencies = { domain: this.domain, files: this.files, vision: (config: CuratorConfig) => this.providers.vision(config) }
    if (kind === 'crop') return createCropWorker(dependencies)
    if (kind === 'search') {
      const crop = createCropProcessor(dependencies)
      return createSearchWorker({ ...dependencies, source: config => this.providers.source(config), media: config => this.providers.media(config), crop: async (ctx, ids) => {
        const { releaseSchema, usageSchema } = await import('../shared/model.ts')
        const release = releaseSchema.parse(ctx.spec.fixed.release), usage = usageSchema.parse(ctx.spec.fixed.usage)
        for (const id of ids) if (await crop(ctx, id, release, usage) === 'budget-exhausted') throw new CuratorError('budget-exhausted', 'cropping', 'The shared crop budget is exhausted.')
      } })
    }
    return createDataWorker(dependencies)
  }
  private spec(kind: ExecutionSpec['kind'], input: Record<string, Json>, fixed: Record<string, Json>, config = this.config): ExecutionSpec {
    return executionSchema.parse({ kind, config, input, fixed, specDigest: contentDigest({ kind, config, input, fixed }) })
  }
  private async launch(kind: ExecutionSpec['kind'], input: Record<string, Json>, fixed: Record<string, Json>, actor: DomainActor, operationId: string, config = this.config): Promise<Json> {
    const run = await this.engine.create(this.spec(kind, input, fixed, config), actor, this.worker(kind), operationId)
    return toJson({ runId: run.id, ...(dataOf(run).jobId ? { jobId: dataOf(run).jobId } : {}), status: run.status })
  }
  /** Validate external JSON once, then delegate to the same domain/workflows for both callers.
   * @param input Client or tool JSON envelope. @param actor Identity created by the Host adapter. @param signal Request lifetime, independent of accepted background jobs. @returns Safe JSON result or typed rejection.
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
      const effectiveActor = this.scopedHuman(actor, parsed.args)
      const { sessionToken, ...args } = parsed.args
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
        case 'session-open': {
          this.human(actor)
          const { sessionId } = z.strictObject({ sessionId: z.string().min(1), operationId: z.string().optional() }).parse(args)
          if (!this.ctx.sessions.get(brandString<SessionId>(sessionId))) throw new CuratorError('owner-denied', 'session-channel', 'The Session is unavailable in this profile.')
          const token = randomUUID()
          this.sessionGrants.set(token, { sessionId, expiresAt: Date.now() + this.config.limits.sessionGrantTtlMs })
          return { sessionToken: token, sessionId }
        }
        case 'snapshot': {
          const page = z.object({ pageSize: z.number().int().min(1).max(100).default(this.config.limits.pageSize), pageToken: z.string().optional() }).parse(args)
          const snapshot = projectSnapshot(this.domain, this.engine, this.config, effectiveActor, await this.credentialStatus())
          const ids = snapshot.images.map(image => image.imageVersionId), offset = this.pageOffset(page.pageToken, 'images', ids)
          snapshot.images = snapshot.images.slice(offset, offset + page.pageSize)
          snapshot.runs = snapshot.runs.map(run => ({ ...run, results: [] }))
          snapshot.exports = snapshot.exports.map(exp => ({ ...exp, ...(exp.preview ? { preview: exp.preview.slice(0, this.config.limits.maxExportPreviewChars) } : {}) }))
          snapshot.evaluations = snapshot.evaluations.map(evaluation => ({ ...evaluation, ...(evaluation.items ? { items: evaluation.items.slice(0, page.pageSize) } : {}) }))
          if (offset + page.pageSize < ids.length) snapshot.nextPageToken = this.pageToken('images', offset + page.pageSize, ids)
          return this.withSessionResources(toJson(snapshot), effectiveActor, typeof sessionToken === 'string' ? sessionToken : undefined)
        }
        case 'style-list': {
          const query = z.object({ pageSize: z.number().int().min(1).max(100).default(20), pageToken: z.string().optional() }).parse(args)
          const styles = projectSnapshot(this.domain, this.engine, this.config, effectiveActor, { source: false, vision: false }).styles
          const offset = this.pageOffset(query.pageToken, 'styles', styles.map(style => style.styleId))
          return toJson({ items: styles.slice(offset, offset + query.pageSize), ...(offset + query.pageSize < styles.length ? { pageToken: this.pageToken('styles', offset + query.pageSize, styles.map(style => style.styleId)) } : {}) })
        }
        case 'style-get': {
          const { styleId } = z.object({ styleId: z.string() }).parse(args)
          const style = projectSnapshot(this.domain, this.engine, this.config, effectiveActor, { source: false, vision: false }).styles.find(item => item.styleId === styleId)
          if (!style) throw new CuratorError('reference-unavailable', 'style-read', 'The requested style is unavailable.')
          return toJson(style)
        }
        case 'run-get': {
          const { runId, pageSize, pageToken } = z.object({ runId: z.string(), pageSize: z.number().int().min(1).max(100).default(20), pageToken: z.string().optional() }).parse(args)
          const run = projectRun(this.domain, this.engine.get(runId, effectiveActor), effectiveActor), ids = run.results.map(item => item.imageVersionId)
          const offset = this.pageOffset(pageToken, runId, ids)
          return this.withSessionResources(toJson({ ...run, results: run.results.slice(offset, offset + pageSize), ...(offset + pageSize < ids.length ? { pageToken: this.pageToken(runId, offset + pageSize, ids) } : {}) }), effectiveActor, typeof sessionToken === 'string' ? sessionToken : undefined)
        }
        case 'run-control': {
          this.human(actor)
          const { runId, command } = z.object({ runId: z.string(), command: z.enum(['pause', 'resume', 'cancel']) }).parse(args)
          const run = this.engine.get(runId, effectiveActor)
          if (command === 'resume') {
            const fixed = specOf(run)
            if (reviewerRevision(fixed.config) !== reviewerRevision(this.config) || fixed.kind === 'search' && configRevision(fixed.config.source) !== configRevision(this.config.source)) throw new CuratorError('constraint-conflict', 'resume', 'The provider configuration changed. Start a new task with an explicitly reviewed version.')
            if (fixed.kind !== 'export') await this.providers.vision(fixed.config)
            if (fixed.kind === 'search') await this.providers.source(fixed.config)
            for (const reference of this.domain.repository.list('imageVersion').filter(image => image.id === fixed.input.imageVersionId || Array.isArray(fixed.input.imageVersionIds) && fixed.input.imageVersionIds.includes(image.id))) await this.files.read(this.domain.authorizedImage(reference.id, effectiveActor).image.blob)
          }
          return toJson(projectRun(this.domain, await this.engine.control(runId, command, effectiveActor, this.worker(specOf(run).kind)), effectiveActor))
        }
        case 'reference-import': this.human(actor); return await this.importReferences(args, actor, signal)
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
        case 'reference-analyze': {
          this.human(actor)
          const { styleId, operationId } = z.object({ styleId: z.string(), operationId: z.string() }).parse(args)
          const style = this.domain.require('style', styleId), draft = this.domain.require('draft', style.draftId)
          for (const id of draft.referenceIds) this.domain.assertLearningFamily(this.domain.authorizedImage(this.domain.require('reference', id).imageVersionId, effectiveActor).asset.familyId)
          const provider = await this.providers.vision(this.config)
          provider.assertCapabilities(Math.min(draft.referenceIds.length, this.config.limits.maxReferenceImages))
          const current = this.domain.repository.manifest('split-index')?.state
          const splitId = current && typeof current === 'object' && !Array.isArray(current) && typeof current.currentSplitId === 'string' ? current.currentSplitId : undefined
          const references = draft.referenceIds.map(id => this.domain.require('reference', id))
          const referenceThreads = new Set(references.flatMap(reference => reference.feedbackThreadIds))
          const feedback = this.domain.snapshot(effectiveActor).feedback.filter(item => item.scope === 'style-candidate' && item.context.styleId === style.id && (referenceThreads.has(item.threadId) || draft.feedbackIds.includes(item.id)))
          return await this.launch('analyze', { styleId }, { invocationDigest: contentDigest({ operation, args }), draft: toJson(draft), references: toJson(references), feedback: toJson(feedback), recipe: toJson(this.recipe(operationId)), ...(splitId ? { split: toJson(this.domain.require('split', splitId)) } : {}) }, effectiveActor, operationId)
        }
        case 'search-start': case 'crop-start': case 'manual-crop-confirm': return await this.startTask(operation, args, effectiveActor)
        case 'library-save': this.human(actor); return await this.saveLibrary(args, effectiveActor)
        case 'split-create': return await this.createSplit(args, actor)
        case 'evaluate-start': return await this.startEvaluation(args, effectiveActor)
        case 'export-start': return await this.startExport(args, effectiveActor)
        case 'export-get': {
          const { exportId } = z.object({ exportId: z.string() }).parse(args)
          return this.withSessionResources(this.exportView(exportId, effectiveActor), effectiveActor, typeof sessionToken === 'string' ? sessionToken : undefined)
        }
        case 'config-read': this.human(actor); return toJson(projectSnapshot(this.domain, this.engine, this.config, actor, await this.credentialStatus()).configuration)
        case 'config-save': this.human(actor); return await this.saveConfig(args)
        default: return await this.domain.action(operation, args, effectiveActor)
      }
    } catch (error) {
      if (error instanceof z.ZodError) throw new CuratorError('invalid-input', input.operation, 'The operation input is invalid.', { cause: error })
      throw error
    }
  }
  private withSessionResources(value: Json, actor: DomainActor, token: string | undefined): Json {
    if (!token || actor.kind !== 'human' || !actor.sessionId) return value
    if (typeof value === 'string') return value.startsWith('/api/visual-curator/resource?') ? `${value}&sessionToken=${encodeURIComponent(token)}` : value
    if (Array.isArray(value)) return value.map(item => this.withSessionResources(item, actor, token))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.withSessionResources(item, actor, token)]))
    return value
  }
  private async credentialStatus(): Promise<{ source: boolean; vision: boolean }> {
    const { credentialRef } = await import('@deepseek-ai/dsh-credentials')
    return { source: !this.config.source.credentialRef || !!await this.ctx.credentials.resolve(credentialRef(this.config.source.credentialRef)), vision: !this.config.vision.credentialRef || !!await this.ctx.credentials.resolve(credentialRef(this.config.vision.credentialRef)) }
  }
  private recipe(operationId: Json | undefined): EvaluationRecipe {
    const id = `recipe-${contentDigest({ config: this.config, operationId }).slice(10, 42)}`, existing = this.domain.repository.get('recipe', id)
    return existing ?? recipeSchema.parse({ schemaVersion: 1, profileId: this.profileId, id, createdAt: new Date().toISOString(), kind: 'recipe', visionRevision: reviewerRevision(this.config), model: this.config.vision.model || 'unconfigured', vendorVersion: this.config.vision.vendorVersion, promptVersion: 'visual-curator-v1', outputSchemaVersion: '1', preprocessingVersion: this.files.processorVersion, referenceStrategy: { maxImages: this.config.limits.maxReferenceImages, maxBytes: this.config.limits.maxReferenceBytes }, preferenceScale: { min: 0, max: 1, weights: Object.fromEntries(['color', 'lighting', 'texture', 'subject', 'composition', 'density', 'depth'].map(dimension => [dimension, 1 / 7])) }, unknownPolicy: 'needs-review', tieBreak: 'stable-id' })
  }
  private ruleFromView(value: unknown, actor: DomainActor, previous: Rule[]): Rule {
    const input = z.object({ ruleId: z.string(), dimension: z.enum(['color', 'lighting', 'texture', 'subject', 'composition', 'density', 'depth']), statement: z.string().min(1), strength: z.enum(['required', 'preferred', 'reference-only']), stage: z.enum(['source', 'final']), confirmed: z.boolean(), condition: z.string(), exceptions: z.array(z.string()), supportRefs: z.array(z.string()), counterRefs: z.array(z.string()) }).parse(value)
    const old = previous.find(rule => rule.ruleId === input.ruleId)
    const same = old && old.statement === input.statement && old.strength === input.strength && old.stage === input.stage && old.dimension === input.dimension
    return { ruleId: input.ruleId, dimension: input.dimension, statement: input.statement, strength: input.strength, stage: input.stage, condition: { ...(old?.condition.usageRevisionIds ? { usageRevisionIds: old.condition.usageRevisionIds } : {}), ...(input.condition.trim() ? { subjects: input.condition.split(',').map(item => item.trim()).filter(Boolean) } : {}) }, exceptions: old && JSON.stringify(input.exceptions) === JSON.stringify(old.exceptions.map(condition => condition.subjects?.join(', ') ?? condition.usageRevisionIds?.join(', ') ?? '')) ? old.exceptions : input.exceptions.map(exception => ({ subjects: [exception] })), supportRefs: input.supportRefs, counterRefs: input.counterRefs, check: old?.check.kind === 'measured' ? old.check : { kind: 'visual', criterion: input.statement }, confirmation: input.confirmed ? same && old.confirmation.status === 'confirmed' ? old.confirmation : { status: 'confirmed', actor: { kind: 'authenticated-human', id: actor.id, confirmationMethod: 'client-action', confirmedAt: new Date().toISOString() } } : { status: 'suggested' } }
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
          if (file.base64.length > Math.ceil(this.config.limits.maxImportBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)) throw new CuratorError('invalid-input', 'import', 'The encoded image exceeds the configured limit or is malformed.')
          const media = await this.files.importBytes(Buffer.from(file.base64, 'base64'), file.mime, signal)
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
  private async startTask(operation: string, args: Record<string, Json>, actor: DomainActor): Promise<Json> {
    if (operation === 'manual-crop-confirm') this.human(actor)
    const input = startSchema.parse(operation === 'manual-crop-confirm' ? { ...args, taskBrief: typeof args.taskBrief === 'string' && args.taskBrief ? args.taskBrief : 'Review this manually selected crop against the frozen style and usage.' } : args)
    const release = this.domain.require('release', input.releaseId), style = this.domain.require('style', release.styleId)
    this.domain.resolveRelease(style.id, release.id)
    await this.domain.verifyRelease(release, actor)
    const usage = this.domain.require('usage', input.usageRevisionId)
    const limits = { ...this.config.limits }
    const hardBudgets = ['maxVisionCalls', 'maxSearchPages', 'maxCandidates', 'maxDownloadBytes', 'maxCropCandidatesPerImage', 'maxConcurrentRequests', 'maxRetryAttempts', 'deadlineMs']
    for (const [key, value] of Object.entries(input.budgets ?? {})) {
      if (key === 'targetCount') continue
      if (!hardBudgets.includes(key)) throw new CuratorError('invalid-input', 'resolve', 'Only the declared hard task budgets may be overridden.')
      const configured = Reflect.get(limits, key)
      if (typeof configured !== 'number' || value > configured) throw new CuratorError('invalid-input', 'resolve', 'A task budget exceeds the deployment limit.')
      Reflect.set(limits, key, value)
    }
    const config = resolveConfig({ ...this.config, limits })
    if (release.recipe.visionRevision !== reviewerRevision(config) || release.recipe.preprocessingVersion !== this.files.processorVersion) throw new CuratorError('constraint-conflict', 'resolve', 'The saved review recipe differs from this deployment. Publish a new reviewed version.')
    const vision = await this.providers.vision(config)
    vision.assertCapabilities(Math.min(release.references.length, release.recipe.referenceStrategy.maxImages) + 2)
    for (const rule of release.rules.filter(rule => rule.strength === 'required' && rule.stage === 'final' && rule.check.kind === 'measured')) {
      if (rule.check.kind !== 'measured' || rule.check.field === 'byteLength') continue
      const value = rule.check.field === 'width' ? usage.output.targetWidth : rule.check.field === 'height' ? usage.output.targetHeight : usage.output.aspectP / usage.output.aspectQ
      if (rule.check.min !== undefined && value < rule.check.min - rule.check.tolerance || rule.check.max !== undefined && value > rule.check.max + rule.check.tolerance) throw new CuratorError('constraint-conflict', 'resolve', 'The usage output conflicts with a required final rule.')
    }
    const fixed: Record<string, Json> = { invocationDigest: contentDigest({ operation, args }), release: toJson(release), usage: toJson({ ...usage, protectedContent: [...new Set([...usage.protectedContent, ...(input.protectedContent ?? [])])] }) }
    const kind = operation === 'search-start' ? 'search' : 'crop'
    const normalized: Record<string, Json> = { taskBrief: input.taskBrief }
    if (kind === 'search') {
      if (input.sourceId !== config.source.id) throw new CuratorError('invalid-input', 'resolve', 'The requested source is not configured.')
      await this.providers.source(config)
      const targetCount = input.budgets?.targetCount ?? input.targetCount ?? 10
      if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > config.limits.maxCandidates) throw new CuratorError('invalid-input', 'resolve', 'Target count exceeds the candidate budget.')
      Object.assign(normalized, { queries: input.queries ?? [input.taskBrief], targetCount })
    } else {
      const ids = input.imageVersionIds ?? (input.imageVersionId ? [input.imageVersionId] : [])
      if (!ids.length || ids.length > config.limits.maxCandidates) throw new CuratorError('invalid-input', 'resolve', 'Choose authorized saved image versions.')
      for (const id of ids) await this.files.read(this.domain.authorizedImage(id, actor).image.blob)
      normalized.imageVersionIds = ids
      if (operation === 'manual-crop-confirm') {
        const { normalizedRectSchema } = await import('../shared/model.ts')
        normalized.manualRect = toJson(normalizedRectSchema.parse(input.rect)); normalized.allowWarning = input.allowWarning ?? false; normalized.includeInLearning = input.includeInLearning ?? false
        for (const id of ids) resolveCrop(normalizedRectSchema.parse(input.rect), this.domain.authorizedImage(id, actor).image.geometry, usage.output)
        fixed.humanConfirmation = { kind: 'authenticated-human', id: actor.id, confirmationMethod: 'client-action', confirmedAt: new Date().toISOString() }
      }
    }
    return await this.launch(kind, normalized, fixed, actor, input.operationId, config)
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
  private async startEvaluation(args: Record<string, Json>, actor: DomainActor): Promise<Json> {
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
    return await this.launch('evaluate', { leftId, rightId, splitId, usageRevisionId }, { invocationDigest: contentDigest({ operation: 'evaluate-start', args }), left: toJson(left), right: toJson(right), split: toJson(split), usage: toJson(usage), feedback: toJson(this.domain.snapshot(actor).feedback), humanActor: toJson(actor), images: toJson(images) }, actor, operationId)
  }
  private async startExport(args: Record<string, Json>, actor: DomainActor): Promise<Json> {
    const { kind, operationId, ...rest } = z.object({ kind: z.enum(['style', 'classification', 'preference', 'crop', 'skill']), operationId: z.string(), purpose: z.enum(['training', 'development', 'holdout', 'reference']), releaseId: z.string(), splitId: z.string(), mode: z.enum(['references-only', 'with-bytes']).default('references-only'), usageRevisionId: z.string().optional() }).parse(args)
    this.domain.require('release', rest.releaseId); this.domain.require('split', rest.splitId)
    const exportInput = z.record(z.string(), jsonSchema).parse(toJson({ operationId: `${operationId}:export`, exportKind: kind, ...rest }))
    return await this.launch('export', exportInput, { invocationDigest: contentDigest({ operation: 'export-start', args }), actor: toJson(actor), feedbackHeads: toJson(this.domain.snapshot(actor).feedback.map(feedback => feedback.id)) }, actor, operationId)
  }
  private exportView(id: string, actor: DomainActor): Json {
    const snapshot = this.domain.snapshot(actor).exports.find(item => item.id === id)
    if (!snapshot) throw new CuratorError('owner-denied', 'export-read', 'This export is unavailable to the current owner.')
    return toJson({ exportId: snapshot.id, kind: snapshot.exportKind, status: 'ready', downloadPath: `/api/visual-curator/resource?exportId=${encodeURIComponent(id)}${actor.sessionId ? `&sessionId=${encodeURIComponent(actor.sessionId)}` : ''}`, checksum: contentDigest(snapshot.files), preview: snapshot.files.map(file => `${file.name}\n${file.content}`).join('\n\n'), exclusions: Object.entries(snapshot.exclusions).map(([reason, count]) => ({ reason, count })) })
  }
  private async saveConfig(args: Record<string, Json>): Promise<Json> {
    const input = z.object({ revision: z.string(), source: z.record(z.string(), jsonSchema), vision: z.record(z.string(), jsonSchema), limits: z.record(z.string(), jsonSchema) }).parse(args)
    if (input.revision !== configRevision(this.config)) throw new CuratorError('revision-conflict', 'configuration', 'Configuration changed; refresh before saving.')
    const next = resolveConfig({ source: { ...this.config.source, ...input.source }, vision: { ...this.config.vision, ...input.vision }, limits: { ...this.config.limits, ...input.limits } })
    const entry = this.ctx.configEditor.entries().find(row => row.options.id === 'visual-curator')
    if (!entry) throw new CuratorError('capability-unavailable', 'configuration', 'The profile configuration entry is unavailable.')
    await this.ctx.configEditor.edit(entry, current => {
      if (configRevision(resolveConfig(current)) !== input.revision) throw new CuratorError('revision-conflict', 'configuration', 'Configuration changed while saving.')
      return next
    })
    return { saved: true, revision: configRevision(next) }
  }
  private pageToken(scope: string, offset: number, ids: string[]): string { return Buffer.from(JSON.stringify({ scope, offset, digest: contentDigest(ids) })).toString('base64url') }
  private pageOffset(token: string | undefined, scope: string, ids: string[]): number {
    if (!token) return 0
    const value = z.strictObject({ scope: z.literal(scope), offset: z.number().int().nonnegative(), digest: z.literal(contentDigest(ids)) }).parse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')))
    if (value.offset > ids.length) throw new CuratorError('invalid-input', 'pagination', 'The saved page is unavailable; restart the listing.')
    return value.offset
  }
  /** Deliver private pixels/exports only after profile authentication and saved owner checks.
   * @param request Authenticated same-origin connection route request. @returns Verified bytes or a safe status; never external redirects.
   */
  resource(request: Request): Promise<Response> { return this.track(this.resourceNow(request)) }
  private async resourceNow(request: Request): Promise<Response> {
    try {
      if (this.stopping) throw new CuratorError('capability-unavailable', 'resource', 'The plugin is stopping.')
      const resourceSignal = AbortSignal.any([request.signal, this.lifetime.signal])
      const url = new URL(request.url)
      const actor = this.scopedHuman({ kind: 'human', id: 'profile-owner', profileId: this.profileId }, { ...(url.searchParams.get('sessionToken') ? { sessionToken: url.searchParams.get('sessionToken')! } : {}) })
      if (url.searchParams.get('sessionId') && actor.sessionId !== url.searchParams.get('sessionId')) throw new CuratorError('owner-denied', 'resource', 'Open the owning Session channel before requesting this resource.')
      const imageId = url.searchParams.get('imageVersionId'), exportId = url.searchParams.get('exportId')
      const headers = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" }
      if (imageId && !exportId) {
        const { image } = this.domain.authorizedImage(imageId, actor), bytes = await this.files.read(image.blob, resourceSignal)
        return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), { headers: { ...headers, 'content-type': image.blob.mime, 'content-length': String(bytes.length) } })
      }
      if (exportId && !imageId) {
        this.exportView(exportId, actor)
        const snapshot = this.domain.require('export', exportId)
        const resources: Json[] = []
        if (snapshot.mode === 'with-bytes') for (const resource of snapshot.resources) {
          const image = this.domain.authorizedImage(resource.imageVersionId, actor).image
          resources.push({ imageVersionId: image.id, mime: image.blob.mime, digest: image.blob.digest, base64: (await this.files.read(image.blob, resourceSignal)).toString('base64') })
        }
        const body = JSON.stringify({ formatVersion: 1, export: snapshot.id, files: snapshot.files, resources })
        return new Response(request.method === 'HEAD' ? null : body, { headers: { ...headers, 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="visual-curator-${snapshot.id}.json"` } })
      }
      return new Response(null, { status: 400 })
    } catch (error) { return new Response(JSON.stringify(safeFailure(error)), { status: error instanceof CuratorError && error.code === 'owner-denied' ? 403 : 404, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }) }
  }
  /** Read-only connection route avoids the plugin manager's bounded text-action response limit.
   * @param request Authenticated same-origin JSON request. @returns The same validated projection used by tools and the workbench.
   */
  async data(request: Request): Promise<Response> {
    try {
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
      const input = actionSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      if (!['snapshot', 'run-get', 'export-get'].includes(input.operation)) throw new CuratorError('owner-denied', 'data-read', 'This route accepts read operations only.')
      const value = await this.action(input, { kind: 'human', id: 'profile-owner', profileId: this.profileId }, request.signal)
      return Response.json({ ok: true, value }, { headers: { 'cache-control': 'private, no-store' } })
    } catch (error) { return Response.json({ ok: false, error: safeFailure(error) }, { status: 400, headers: { 'cache-control': 'no-store' } }) }
  }
  /** Stop admitting work, drain jobs, then release the sole profile writer. */
  async dispose(): Promise<void> {
    this.stopping = true
    const jobs = Promise.allSettled([this.engineValue?.dispose()])
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
