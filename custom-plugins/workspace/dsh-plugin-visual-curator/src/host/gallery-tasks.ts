/** Host jobs own reference batches; HTTP and dialog lifetimes only own their views. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { JobRegistry, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CuratorDomain } from '../domain/curator.ts'
import { contentDigest } from '../domain/repository.ts'
import { galleryTaskActive, galleryTaskViewSchema, type GalleryTaskView } from '../shared/gallery-task.ts'
import type { DomainActor, Json } from '../shared/model.ts'
import { CuratorError } from '../shared/errors.ts'
import type { CuratorConfig } from './config.ts'
import { safeFailure, toJson } from './runtime.ts'

const inputSchema = z.strictObject({ operationId: z.string().min(1).max(128), styleId: z.string().min(1), expectedRevision: z.number().int().positive().optional(), accountId: z.string().optional(), photoIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)).min(1), role: z.enum(['positive', 'negative']).default('positive'), analyzeAfter: z.boolean().default(false) })
const batchSchema = z.object({ operationId: z.string(), expectedRevision: z.number().int().positive(), photoIds: z.array(z.string()) })
const taskSchema = galleryTaskViewSchema.extend({ profileId: z.string(), sessionId: z.string().optional(), inputDigest: z.string(), ordinal: z.number().int().positive(), offset: z.number().int().nonnegative(), batch: batchSchema.optional() })
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
  constructor(private readonly config: CuratorConfig, private readonly domain: CuratorDomain, private readonly jobs: Pick<JobRegistry, 'start'>, private readonly gallery: GalleryAction, private readonly progress: (args: Record<string, Json>, actor: DomainActor) => Json, private readonly analyze: (styleId: string, actor: DomainActor) => Promise<void>) {}

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
    const { profileId, sessionId, inputDigest, ordinal, offset, batch, ...view } = task
    if (galleryTaskActive(task.status) && batch) {
      const progress = z.object({ phase: galleryTaskViewSchema.shape.phase.optional(), rows: z.array(z.object({ ok: z.boolean() })) }).parse(this.galleryProgress(task, actor))
      // 批次结束到任务检查点落盘之间，仍以已提交的回执保持进度连续。
      view.registered = Math.max(progress.rows.filter(row => row.ok).length, this.published(task))
      if (progress.phase) view.phase = progress.phase
    }
    return view
  }
  private published(task: SavedTask): number {
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
  /** @param styleId Target being modified. @returns Whether any task is still writing this collection. */
  busy(styleId: string): boolean { return [...this.tasks.values()].some(task => task.styleId === styleId && galleryTaskActive(task.status)) }

  /** @param args Explicit, fully enumerated selection. @param actor Trusted initiating owner. @returns Durable acceptance independent of the caller's AbortSignal. */
  start(args: Record<string, Json>, actor: DomainActor): Promise<GalleryTaskView> {
    const result = this.admissions.then(async () => {
      if (this.stopping) throw new CuratorError('capability-unavailable', 'gallery-task', 'The reference service is stopping.')
      const input = inputSchema.parse(args)
      if (input.photoIds.length > this.config.limits.maxGalleryReferenceFiles || new Set(input.photoIds).size !== input.photoIds.length) throw new CuratorError('invalid-input', 'gallery-task', 'Choose a bounded set of distinct photos.')
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
      if (input.accountId && !this.config.source.unsplash.accounts.some(account => account.id === input.accountId)) throw new CuratorError('invalid-input', 'gallery-task', 'The selected account is unavailable.')
      const now = new Date().toISOString()
      const task = taskSchema.parse({ id, styleId: input.styleId, ...(input.accountId ? { accountId: input.accountId } : {}), profileId: actor.profileId, ...(actor.sessionId ? { sessionId: actor.sessionId } : {}), inputDigest: contentDigest(input), ordinal: [...this.tasks.values()].reduce((value, task) => Math.max(value, task.ordinal), 0) + 1, status: 'queued', phase: 'verifying', total: input.photoIds.length, completed: 0, failed: 0, registered: 0, offset: 0, createdAt: now, updatedAt: now })
      await this.domain.repository.commit({ aggregateId: `gallery-task-input:${id}`, expectedRevision: 0, operationId: `gallery-task-input:${id}`, request: input, records: [], state: toJson(input) })
      this.tasks.set(id, task); this.inputs.set(id, input); this.revisions.set(id, 0)
      try { await this.update(id, {}) } catch (error) { this.tasks.delete(id); this.inputs.delete(id); this.revisions.delete(id); throw error }
      const controller = new AbortController(), live = { controller, done: Promise.resolve<JobOutcome>({ status: 'completed' }) }
      this.live.set(id, live)
      try {
        this.jobs.start({ kind: 'visual-curator', label: 'Gallery references', ...(actor.sessionId ? { owner: brandString<SessionId>(actor.sessionId) } : {}), run: handle => {
          live.done = this.execute(id, actor, controller, value => handle.updateProgress(JSON.stringify(value)))
          return { done: live.done, cancel: () => { controller.abort() } }
        } })
      } catch (error) { controller.abort(); await live.done; this.live.delete(id); await this.update(id, { status: 'failed', errorCode: safeFailure(error).code }); throw error }
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
  private async execute(id: string, actor: DomainActor, controller: AbortController, report: (view: GalleryTaskView) => void): Promise<JobOutcome> {
    const input = this.inputs.get(id)!, deadline = AbortSignal.timeout(this.config.limits.deadlineMs), signal = AbortSignal.any([controller.signal, deadline])
    try {
      await this.update(id, { status: 'running' })
      while (this.tasks.get(id)!.offset < input.photoIds.length) {
        signal.throwIfAborted()
        const task = this.tasks.get(id)!, style = this.domain.require('style', task.styleId)
        if (style.archived) throw new CuratorError('constraint-conflict', 'gallery-task', 'The target collection was archived.')
        const batch = { operationId: `gallery-task:${id}:${task.offset}`, expectedRevision: style.revision, photoIds: input.photoIds.slice(task.offset, task.offset + this.config.limits.maxImportFiles) }
        await this.update(id, { batch, phase: 'referencing' })
        // 批次由 Host 发起，浏览器关闭不会取消；提交回执是累计成功数的唯一依据。
        const response = await this.gallery('gallery-import', { ...batch, transferId: id, mode: 'remote-reference', styleId: task.styleId, role: input.role, ...(input.accountId ? { accountId: input.accountId } : {}) }, actor, signal)
        await this.acceptReceipt(id, response); report(this.view(this.tasks.get(id)!, actor))
      }
      const task = this.tasks.get(id)!
      await this.update(id, { status: signal.aborted ? this.stopping ? 'interrupted' : 'cancelled' : task.failed ? task.completed ? 'partial' : 'failed' : 'completed', phase: 'saving' })
      if (input.analyzeAfter && this.tasks.get(id)!.status === 'completed') await this.analyze(input.styleId, actor)
    } catch (error) {
      const failure = safeFailure(error), task = this.tasks.get(id)!
      await this.update(id, { status: this.stopping ? 'interrupted' : controller.signal.aborted ? 'cancelled' : task.status === 'completed' ? 'partial' : task.batch ? 'needs-review' : 'failed', completed: task.completed + this.published(task), registered: 0, batch: undefined, errorCode: deadline.aborted ? 'budget-exhausted' : failure.code })
    } finally { this.live.delete(id) }
    const task = this.tasks.get(id)!
    return { status: task.status === 'cancelled' ? 'killed' : 'completed', result: JSON.stringify(this.view(task, actor)) }
  }

  /** @param id Saved task. @param actor Trusted owner. @returns Cancellation acknowledgement; final receipts arrive through list(). */
  async cancel(id: string, actor: DomainActor): Promise<GalleryTaskView> {
    const task = this.tasks.get(id)
    if (!task) throw new CuratorError('reference-unavailable', 'gallery-task', 'The reference task is unavailable.')
    this.authorize(task, actor)
    if (galleryTaskActive(task.status)) { await this.update(id, current => galleryTaskActive(current.status) ? { status: 'cancelling' } : {}); this.live.get(id)?.controller.abort() }
    return this.view(this.tasks.get(id)!, actor)
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
