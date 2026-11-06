/** Host jobs own reference batches; HTTP and dialog lifetimes only own their views. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { JobRegistry, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CuratorDomain } from '../domain/curator.ts'
import { contentDigest } from '../domain/repository.ts'
import { galleryTaskActive, galleryTaskRecoverable, galleryTaskViewSchema, type GalleryTaskView } from '../shared/gallery-task.ts'
import type { DomainActor, Json } from '../shared/model.ts'
import { CuratorError } from '../shared/errors.ts'
import type { CuratorConfig } from './config.ts'
import { safeFailure, toJson } from './runtime.ts'
import { taskReferenceImportSchema, taskReferenceReceiptSchema, type TaskReferenceImport, type TaskReferenceReceipt } from '../shared/task-references.ts'
import { pendingTaskReferences } from './task-references.ts'

const galleryInputSchema = z.strictObject({ operationId: z.string().min(1).max(128), styleId: z.string().min(1), expectedRevision: z.number().int().positive().optional(), accountId: z.string().optional(), photoIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)).min(1), role: z.enum(['positive', 'negative']).default('positive'), analyzeAfter: z.boolean().default(false) })
const completedInputSchema = taskReferenceImportSchema.extend({ source: z.literal('completed-search') })
const inputSchema = z.union([galleryInputSchema, completedInputSchema])
const batchSchema = z.object({ operationId: z.string(), expectedRevision: z.number().int().positive(), photoIds: z.array(z.string()) })
const taskSchema = galleryTaskViewSchema.extend({ profileId: z.string(), sessionId: z.string().optional(), inputDigest: z.string(), ordinal: z.number().int().positive(), offset: z.number().int().nonnegative(), batch: batchSchema.optional(), referenceBatch: taskReferenceImportSchema.optional(), pendingPhotoIds: z.array(z.string()).optional(), attemptId: z.string().optional() })
type SavedTask = z.infer<typeof taskSchema>
type GalleryAction = (operation: string, args: Record<string, Json>, actor: DomainActor, signal: AbortSignal) => Promise<Json>
const receiptSchema = z.object({ results: z.array(z.object({ name: z.string(), ok: z.boolean(), error: z.object({ code: z.string() }).passthrough().optional() })) })

/** Persisted task metadata uses its own manifests; existing image and Session formats stay unchanged. */
export class GalleryReferenceTasks {
  private readonly tasks = new Map<string, SavedTask>()
  private readonly inputs = new Map<string, z.infer<typeof inputSchema>>()
  private readonly revisions = new Map<string, number>()
  private readonly live = new Map<string, { controller: AbortController; done: Promise<JobOutcome> }>()
  private writes: Promise<void> = Promise.resolve()
  private admissions: Promise<unknown> = Promise.resolve()
  private stopping = false
  constructor(private readonly config: CuratorConfig, private readonly domain: CuratorDomain, private readonly jobs: Pick<JobRegistry, 'start'>, private readonly gallery: GalleryAction, private readonly progress: (args: Record<string, Json>, actor: DomainActor) => Json, private readonly analyze: (styleId: string, actor: DomainActor) => Promise<void>, private readonly completed: { validate(input: TaskReferenceImport, actor: DomainActor): Promise<void>; import(input: TaskReferenceImport, actor: DomainActor, signal: AbortSignal): Promise<TaskReferenceReceipt> }) {}

  /** Recover confirmed batch receipts and expose unfinished work as interrupted, without replaying writes. */
  async initialize(): Promise<void> {
    for (const manifest of this.domain.repository.manifests()) {
      if (!manifest.aggregateId.startsWith('gallery-task:')) continue
      const task = taskSchema.parse(manifest.state)
      this.domain.repository.assertProfile(task.profileId)
      this.tasks.set(task.id, task); this.revisions.set(task.id, manifest.revision)
      this.inputs.set(task.id, inputSchema.parse(this.domain.repository.manifest(`gallery-task-input:${task.id}`)?.state))
    }
    for (const task of this.tasks.values()) if (galleryTaskActive(task.status)) {
      if (task.referenceBatch) await this.update(task.id, { completed: task.completed + this.published(task), registered: 0, referenceBatch: undefined })
      if (task.batch) {
        const aggregateId = `gallery-reference:${contentDigest({ profileId: task.profileId, sessionId: task.sessionId ?? null, operationId: task.batch.operationId })}`
        const manifest = this.domain.repository.manifest(aggregateId)
        if (manifest?.receipts[task.batch.operationId]) await this.acceptReceipt(task.id, manifest.state)
        else await this.update(task.id, { completed: task.completed + this.published(task), registered: 0, batch: undefined })
      }
      await this.update(task.id, { status: 'interrupted', errorCode: 'reference-task-interrupted' })
    }
  }

  private authorize(task: SavedTask, actor: DomainActor): void {
    if (actor.kind !== 'human' || task.profileId !== actor.profileId || task.sessionId !== actor.sessionId) throw new CuratorError('owner-denied', 'gallery-task', 'This reference task belongs to another owner.')
  }
  private view(task: SavedTask, actor: DomainActor): GalleryTaskView {
    this.authorize(task, actor)
    const { profileId, sessionId, inputDigest, ordinal, offset, batch, referenceBatch, pendingPhotoIds, attemptId, ...view } = task
    if (galleryTaskActive(task.status) && referenceBatch) view.registered = this.published(task)
    if (galleryTaskActive(task.status) && batch) {
      const progress = z.object({ phase: galleryTaskViewSchema.shape.phase.optional(), rows: z.array(z.object({ ok: z.boolean() })) }).parse(this.galleryProgress(task, actor))
      // 批次结束到任务检查点落盘之间，仍以已提交的回执保持进度连续。
      view.registered = Math.max(progress.rows.filter(row => row.ok).length, this.published(task))
      if (progress.phase) view.phase = progress.phase
    }
    return view
  }
  private published(task: SavedTask): number {
    if (task.referenceBatch) {
      const receipt = this.domain.repository.manifest(`task-reference:${contentDigest({ profileId: task.profileId, operationId: task.referenceBatch.operationId })}`)
      const parsed = taskReferenceReceiptSchema.safeParse(receipt?.state)
      return parsed.success ? parsed.data.results.filter(row => row.status !== 'failed').length : 0
    }
    const batch = task.batch
    if (!batch) return 0
    const aggregateId = `gallery-reference:${contentDigest({ profileId: task.profileId, sessionId: task.sessionId ?? null, operationId: batch.operationId })}`
    const manifest = this.domain.repository.manifest(aggregateId)
    if (manifest?.receipts[batch.operationId]) {
      const parsed = receiptSchema.safeParse(manifest.state)
      if (parsed.success && parsed.data.results.length === batch.photoIds.length && parsed.data.results.every((row, index) => row.name === batch.photoIds[index])) return parsed.data.results.filter(row => row.ok).length
    }
    const receipts = this.domain.repository.manifest(`style:${task.styleId}`)?.receipts
    return batch.photoIds.filter(photoId => receipts?.[`${aggregateId}:${photoId}:draft`]).length
  }
  private galleryProgress(task: SavedTask, actor: DomainActor): Json {
    return this.progress({ transferId: task.id, ...(task.accountId ? { accountId: task.accountId } : {}) }, actor)
  }

  /** @param actor Authenticated owner. @returns Lightweight progress without image, model or export projections. */
  list(actor: DomainActor): GalleryTaskView[] { return [...this.tasks.values()].filter(task => task.profileId === actor.profileId && task.sessionId === actor.sessionId).sort((a, b) => b.ordinal - a.ordinal || b.id.localeCompare(a.id)).map(task => this.view(task, actor)) }
  /** @param styleId Target being modified. @returns Whether a task can still write references; saving-only handoffs allow analysis admission. */
  busy(styleId: string): boolean { return [...this.tasks.values()].some(task => task.styleId === styleId && galleryTaskActive(task.status) && (task.phase !== 'saving' || task.batch !== undefined || task.referenceBatch !== undefined)) }

  /** @param args Explicit, fully enumerated selection. @param actor Trusted initiating owner. @returns Durable acceptance independent of the caller's AbortSignal. */
  start(args: Record<string, Json>, actor: DomainActor): Promise<GalleryTaskView> {
    const result = this.admissions.then(async () => {
      if (this.stopping) throw new CuratorError('capability-unavailable', 'gallery-task', 'The reference service is stopping.')
      const input = inputSchema.parse(args)
      const completed = 'images' in input, selectedIds = completed ? input.images.map(image => image.imageVersionId) : input.photoIds
      if (selectedIds.length > (completed ? this.config.limits.maxImportFiles : this.config.limits.maxGalleryReferenceFiles) || new Set(selectedIds).size !== selectedIds.length) throw new CuratorError('invalid-input', 'gallery-task', 'Choose a bounded set of distinct photos.')
      const id = contentDigest({ profileId: actor.profileId, sessionId: actor.sessionId ?? null, operationId: input.operationId }).slice(10), old = this.tasks.get(id)
      if (old) {
        this.authorize(old, actor)
        if (old.inputDigest !== contentDigest(input)) throw new CuratorError('operation-conflict', 'gallery-task', 'The operation ID describes another selection.')
        return this.view(old, actor)
      }
      const style = this.domain.require('style', input.styleId)
      if (style.archived || input.expectedRevision !== undefined && style.revision !== input.expectedRevision) throw new CuratorError('revision-conflict', 'gallery-task', 'The target collection changed.')
      if (this.busy(style.id)) throw new CuratorError('constraint-conflict', 'gallery-task', 'This collection already has an active reference task.')
      if (this.live.size >= this.config.limits.maxConcurrentRequests) throw new CuratorError('constraint-conflict', 'gallery-task', 'The configured background reference capacity is in use.')
      const accountId = 'accountId' in input ? input.accountId : undefined
      if (accountId && !this.config.source.unsplash.accounts.some(account => account.id === accountId)) throw new CuratorError('invalid-input', 'gallery-task', 'The selected account is unavailable.')
      if ('images' in input) { const { source, ...selection } = input; await this.completed.validate(selection, actor) }
      const now = new Date().toISOString()
      const task = taskSchema.parse({ id, styleId: input.styleId, ...(accountId ? { accountId } : {}), ...(completed ? { source: 'completed-search' } : {}), profileId: actor.profileId, ...(actor.sessionId ? { sessionId: actor.sessionId } : {}), inputDigest: contentDigest(input), ordinal: [...this.tasks.values()].reduce((value, task) => Math.max(value, task.ordinal), 0) + 1, status: 'queued', phase: 'verifying', total: selectedIds.length, completed: 0, failed: 0, registered: 0, offset: 0, createdAt: now, updatedAt: now })
      await this.domain.repository.commit({ aggregateId: `gallery-task-input:${id}`, expectedRevision: 0, operationId: `gallery-task-input:${id}`, request: input, records: [], state: toJson(input) })
      this.tasks.set(id, task); this.inputs.set(id, input); this.revisions.set(id, 0)
      try { await this.update(id, {}) } catch (error) { this.tasks.delete(id); this.inputs.delete(id); this.revisions.delete(id); throw error }
      await this.schedule(id, actor)
      return this.view(this.tasks.get(id)!, actor)
    })
    this.admissions = result.catch(() => {})
    return result
  }

  private async schedule(id: string, actor: DomainActor): Promise<void> {
    const controller = new AbortController(), live = { controller, done: Promise.resolve<JobOutcome>({ status: 'completed' }) }
    this.live.set(id, live)
    try {
      this.jobs.start({ kind: 'visual-curator', label: this.tasks.get(id)!.source === 'completed-search' ? 'Completed search references' : 'Gallery references', ...(actor.sessionId ? { owner: brandString<SessionId>(actor.sessionId) } : {}), run: handle => {
        live.done = this.execute(id, actor, controller, value => handle.updateProgress(JSON.stringify(value)))
        return { done: live.done, cancel: () => { controller.abort() } }
      } })
    } catch (error) { controller.abort(); await live.done; this.live.delete(id); await this.update(id, { status: 'failed', errorCode: safeFailure(error).code }); throw error }
  }

  /** Reconcile the original selection against committed collection references before restarting missing photos.
   * @param id Interrupted task identity. @param actor Authenticated owner. @returns The same task with saved progress; concurrent retries share its execution.
   */
  resume(id: string, actor: DomainActor): Promise<GalleryTaskView> {
    const result = this.admissions.then(async () => {
      if (this.stopping) throw new CuratorError('capability-unavailable', 'gallery-task', 'The reference service is stopping.')
      const task = this.tasks.get(id)
      if (!task) throw new CuratorError('reference-unavailable', 'gallery-task', 'The reference task is unavailable.')
      this.authorize(task, actor)
      if (galleryTaskActive(task.status) || task.status === 'completed') return this.view(task, actor)
      if (!galleryTaskRecoverable(task.status)) throw new CuratorError('invalid-input', 'gallery-task', 'This reference task cannot continue.')
      await this.live.get(id)?.done
      const style = this.domain.require('style', task.styleId)
      if (style.archived || this.busy(style.id)) throw new CuratorError('constraint-conflict', 'gallery-task', 'The target collection is archived or already has an active reference task.')
      const originalInput = this.inputs.get(id)!
      if ('images' in originalInput) {
        const { source, ...selection } = originalInput
        await this.completed.validate(selection, actor)
        const images = pendingTaskReferences(this.domain, selection)
        const needsWork = images.length > 0 || selection.analyzeAfter === true && task.total > 0
        if (needsWork && this.live.size >= this.config.limits.maxConcurrentRequests) throw new CuratorError('constraint-conflict', 'gallery-task', 'The configured background reference capacity is in use.')
        const referenceBatch = images.length ? { ...selection, images, expectedRevision: style.revision, operationId: randomUUID() } : undefined
        await this.update(id, { status: needsWork ? 'queued' : 'completed', phase: images.length ? 'verifying' : 'saving', completed: task.total - images.length, failed: 0, registered: 0, referenceBatch, errorCode: undefined })
        if (needsWork) await this.schedule(id, actor)
        return this.view(this.tasks.get(id)!, actor)
      }
      const draft = this.domain.require('draft', style.draftId), imported = new Set<string>()
      for (const refId of draft.referenceIds) {
        const reference = this.domain.require('reference', refId), { asset } = this.domain.authorizedImage(reference.imageVersionId, actor)
        if (asset.source.kind === 'provider' && asset.source.providerId === 'unsplash') imported.add(asset.source.providerAssetId)
      }
      const input = originalInput, pendingPhotoIds = input.photoIds.filter(photoId => !imported.has(photoId))
      const needsWork = pendingPhotoIds.length > 0 || input.analyzeAfter && input.photoIds.length > 0
      if (needsWork && this.live.size >= this.config.limits.maxConcurrentRequests) throw new CuratorError('constraint-conflict', 'gallery-task', 'The configured background reference capacity is in use.')
      // 新执行只包含未提交的图片；新批次身份不能复用已保存的失败回执。
      await this.update(id, { status: needsWork ? 'queued' : 'completed', phase: pendingPhotoIds.length ? 'verifying' : 'saving', completed: input.photoIds.length - pendingPhotoIds.length, failed: 0, registered: 0, offset: 0, batch: undefined, pendingPhotoIds, attemptId: randomUUID(), errorCode: undefined })
      if (needsWork) await this.schedule(id, actor)
      return this.view(this.tasks.get(id)!, actor)
    })
    this.admissions = result.catch(() => {})
    return result
  }

  private update(id: string, patch: Partial<SavedTask> | ((task: SavedTask) => Partial<SavedTask>)): Promise<void> {
    const work = this.writes.then(async () => {
      const current = this.tasks.get(id)!
      const task = taskSchema.parse({ ...current, ...(typeof patch === 'function' ? patch(current) : patch), updatedAt: new Date().toISOString() })
      const revision = this.revisions.get(id) ?? 0
      await this.domain.repository.commit({ aggregateId: `gallery-task:${id}`, expectedRevision: revision, operationId: randomUUID(), request: toJson(task), records: [], state: toJson(task) })
      this.tasks.set(id, task); this.revisions.set(id, revision + 1)
    })
    this.writes = work.catch(() => {})
    return work
  }
  private async acceptReceipt(id: string, response: Json): Promise<void> {
    const task = this.tasks.get(id)!, batch = task.batch!, receipt = receiptSchema.parse(response)
    if (receipt.results.length !== batch.photoIds.length || receipt.results.some((row, index) => row.name !== batch.photoIds[index])) throw new CuratorError('reference-unavailable', 'gallery-task', 'The saved batch receipt is incomplete.')
    await this.update(id, { completed: task.completed + receipt.results.filter(row => row.ok).length, failed: task.failed + receipt.results.filter(row => !row.ok && row.error?.code !== 'cancelled').length, offset: task.offset + batch.photoIds.length, registered: 0, batch: undefined })
  }
  private async finish(id: string, actor: DomainActor, signal: AbortSignal): Promise<void> {
    await this.update(id, { phase: 'saving' })
    signal.throwIfAborted()
    const input = this.inputs.get(id)!, task = this.tasks.get(id)!
    // 整理意图确认前保留运行态；中断后，即使图片已全部导入也能补交接。
    if (input.analyzeAfter && task.completed > 0) await this.analyze(input.styleId, actor)
    signal.throwIfAborted()
    await this.update(id, { status: task.failed ? task.completed ? 'partial' : 'failed' : 'completed' })
  }
  private async execute(id: string, actor: DomainActor, controller: AbortController, report: (view: GalleryTaskView) => void): Promise<JobOutcome> {
    const input = this.inputs.get(id)!
    if ('images' in input) { const { source, ...selection } = input; return this.executeCompleted(id, selection, actor, controller, report) }
    const photoIds = this.tasks.get(id)!.pendingPhotoIds ?? input.photoIds, deadline = AbortSignal.timeout(this.config.limits.deadlineMs), signal = AbortSignal.any([controller.signal, deadline])
    try {
      await this.update(id, { status: 'running' })
      while (this.tasks.get(id)!.offset < photoIds.length) {
        signal.throwIfAborted()
        const task = this.tasks.get(id)!, style = this.domain.require('style', task.styleId)
        if (style.archived) throw new CuratorError('constraint-conflict', 'gallery-task', 'The target collection was archived.')
        const batch = { operationId: `gallery-task:${id}:${task.attemptId ? `${task.attemptId}:` : ''}${task.offset}`, expectedRevision: style.revision, photoIds: photoIds.slice(task.offset, task.offset + this.config.limits.maxImportFiles) }
        await this.update(id, { batch, phase: 'referencing' })
        // 批次由 Host 发起，浏览器关闭不会取消；提交回执是累计成功数的唯一依据。
        const response = await this.gallery('gallery-import', { ...batch, transferId: id, mode: 'remote-reference', styleId: task.styleId, role: input.role, ...(input.accountId ? { accountId: input.accountId } : {}) }, actor, signal)
        await this.acceptReceipt(id, response); report(this.view(this.tasks.get(id)!, actor))
      }
      await this.finish(id, actor, signal)
    } catch (error) {
      const failure = safeFailure(error), task = this.tasks.get(id)!
      await this.update(id, { status: this.stopping ? 'interrupted' : controller.signal.aborted ? 'cancelled' : task.batch ? 'needs-review' : task.completed ? 'partial' : 'failed', completed: task.completed + this.published(task), registered: 0, batch: undefined, errorCode: deadline.aborted ? 'budget-exhausted' : failure.code })
    } finally { this.live.delete(id) }
    const task = this.tasks.get(id)!
    return { status: task.status === 'cancelled' ? 'killed' : 'completed', result: JSON.stringify(this.view(task, actor)) }
  }

  private async executeCompleted(id: string, input: TaskReferenceImport, actor: DomainActor, controller: AbortController, report: (view: GalleryTaskView) => void): Promise<JobOutcome> {
    const deadline = AbortSignal.timeout(this.config.limits.deadlineMs), signal = AbortSignal.any([controller.signal, deadline])
    try {
      const task = this.tasks.get(id)!
      await this.update(id, { status: 'running' })
      if (task.completed < task.total) {
        const referenceBatch = task.referenceBatch ?? input
        await this.update(id, { phase: 'referencing', referenceBatch })
        const receipt = await this.completed.import(referenceBatch, actor, signal)
        if (receipt.results.length !== referenceBatch.images.length || receipt.results.some((row, index) => row.sourceImageVersionId !== referenceBatch.images[index]?.imageVersionId)) throw new CuratorError('reference-unavailable', 'task-reference', 'The saved reference receipt is incomplete.')
        const failed = receipt.results.filter(row => row.status === 'failed').length, completed = task.completed + receipt.results.length - failed
        await this.update(id, { completed, failed, registered: 0, referenceBatch: undefined, phase: 'saving', ...(failed ? { errorCode: receipt.results.find(row => row.status === 'failed')?.code } : {}) })
      }
      await this.finish(id, actor, signal)
      report(this.view(this.tasks.get(id)!, actor))
    } catch (error) {
      const task = this.tasks.get(id)!
      await this.update(id, { status: this.stopping ? 'interrupted' : controller.signal.aborted ? 'cancelled' : task.referenceBatch ? 'needs-review' : task.completed ? 'partial' : 'failed', completed: task.completed + this.published(task), registered: 0, referenceBatch: undefined, errorCode: deadline.aborted ? 'budget-exhausted' : safeFailure(error).code })
    } finally { this.live.delete(id) }
    const task = this.tasks.get(id)!
    return { status: task.status === 'cancelled' ? 'killed' : 'completed', result: JSON.stringify(this.view(task, actor)) }
  }

  /** @param id Saved task. @param actor Trusted owner. @returns Cancellation acknowledgement; final receipts arrive through list(). */
  cancel(id: string, actor: DomainActor): Promise<GalleryTaskView> {
    const result = this.admissions.then(async () => {
      const task = this.tasks.get(id)
      if (!task) throw new CuratorError('reference-unavailable', 'gallery-task', 'The reference task is unavailable.')
      this.authorize(task, actor)
      if (galleryTaskActive(task.status)) { await this.update(id, current => galleryTaskActive(current.status) ? { status: 'cancelling' } : {}); this.live.get(id)?.controller.abort() }
      else if (galleryTaskRecoverable(task.status)) await this.update(id, { status: 'cancelled' })
      return this.view(this.tasks.get(id)!, actor)
    })
    this.admissions = result.catch(() => {})
    return result
  }
  /** Stop admitting tasks, finish admitted batch receipts, and persist interruption before the domain closes. */
  async dispose(): Promise<void> {
    this.stopping = true; await this.admissions
    const live = [...this.live.values()]
    for (const task of live) task.controller.abort()
    const settled = await Promise.allSettled(live.map(task => task.done)); await this.writes
    const failed = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Reference task shutdown could not save every final receipt.')
  }
}
