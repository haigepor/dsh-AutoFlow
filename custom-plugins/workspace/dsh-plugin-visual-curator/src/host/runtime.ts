/** Durable workflow lifecycle and budgets, independent of process-local job identities. */
import { randomUUID } from 'node:crypto'
import { setTimeout as waitForRetry } from 'node:timers/promises'
import { z } from 'zod'
import type { JobRegistry, JobHandle, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { DomainRepository, contentDigest } from '../domain/repository.ts'
import { CuratorError } from '../shared/errors.ts'
import { MediaError } from '../media/errors.ts'
import { jsonSchema, runSchema, requestSchema, type Json, type RunRecord, type DomainActor, type CuratorRecord, type RecordOf } from '../shared/model.ts'
import { settingsSchema, type Limits } from './config.ts'
import { analysisProcessSchema, type AnalysisProcess, type ProcessUpdate, type AnalysisStreamFrame, type AnalysisContinuation } from '../shared/analysis-process.ts'
import { updateAnalysisProcess } from './analysis-process.ts'

declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { visualCurator: 'visual-curator' } }
const countersSchema = z.strictObject({ vision: z.number().int().nonnegative(), search: z.number().int().nonnegative(), downloadBytes: z.number().int().nonnegative(), deadlineAt: z.number().finite() })
export type BudgetCounters = z.infer<typeof countersSchema>

/** Quota is spent before dispatch and is never refunded for an unknown response. */
export class BudgetLedger {
  private counters: BudgetCounters
  constructor(readonly limits: Limits, saved?: BudgetCounters, private readonly now: () => number = Date.now) {
    this.counters = saved ? structuredClone(saved) : { vision: 0, search: 0, downloadBytes: 0, deadlineAt: now() + limits.deadlineMs }
  }
  /** @param kind Attempt category. @param bytes Actual bytes admitted. @returns Reserved counters. */
  async reserve(kind: 'vision' | 'search' | 'download', bytes = 0): Promise<BudgetCounters> {
    if (this.now() >= this.counters.deadlineAt || (kind === 'vision' && this.counters.vision >= this.limits.maxVisionCalls)
      || (kind === 'search' && this.counters.search >= this.limits.maxSearchPages)
      || (kind === 'download' && this.counters.downloadBytes + bytes > this.limits.maxDownloadBytes)) {
      throw new CuratorError('budget-exhausted', 'budget', 'The saved task budget is exhausted.')
    }
    if (kind === 'vision') this.counters.vision++
    if (kind === 'search') this.counters.search++
    if (kind === 'download') this.counters.downloadBytes += bytes
    return this.snapshot()
  }
  snapshot(): BudgetCounters { return structuredClone(this.counters) }
  remainingBytes(): number { return this.limits.maxDownloadBytes - this.counters.downloadBytes }
  /** Known complete downloads release unused reserved bytes; unknown attempts keep their reservation. */
  settleDownload(reservedBytes: number, actualBytes: number): void {
    if (actualBytes < 0 || actualBytes > reservedBytes) throw new CuratorError('invalid-input', 'download-budget', 'Invalid completed byte count.')
    this.counters.downloadBytes -= reservedBytes - actualBytes
  }
}

/** @param results Required and preferred checks. @returns Required-first decision. */
export function decideAssessment(results: readonly { strength: string; result: string }[]): 'pass' | 'reject' | 'needs-review' {
  if (results.some(r => r.strength === 'required' && r.result === 'violated')) return 'reject'
  if (results.some(r => r.strength === 'required' && r.result === 'unknown')) return 'needs-review'
  return 'pass'
}
/** @param items Saved scores. @returns Descending score and stable ID order. */
export function rankedSelections<T extends { id: string; score: number }>(items: readonly T[]): T[] { return [...items].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id, 'en')) }

export const executionSchema = z.strictObject({
  kind: z.enum(['search', 'crop', 'analyze', 'evaluate', 'export']), config: settingsSchema,
  input: z.record(z.string(), jsonSchema), fixed: z.record(z.string(), jsonSchema), specDigest: z.string(),
})
export type ExecutionSpec = z.infer<typeof executionSchema>
const runDataSchema = z.strictObject({
  jobId: z.string().optional(), attemptId: z.string(), attempts: z.number().int().positive(),
  budget: countersSchema, checkpoint: z.record(z.string(), jsonSchema), counts: z.record(z.string(), z.number()),
  warnings: z.array(z.string()), resultIds: z.array(z.string()), requestIds: z.array(z.string()),
  autoResume: z.boolean().optional(), process: analysisProcessSchema.optional(),
  retryAfterRequestId: requestSchema.shape.id.optional(),
  error: z.strictObject({ code: z.string(), stage: z.string(), retryable: z.boolean(), safeMessage: z.string(), suggestedAction: z.string() }).optional(),
})
export type RunData = z.infer<typeof runDataSchema>
/** @param value JSON-compatible internal value. @returns Detached validated JSON. */
export function toJson(value: unknown): Json { return jsonSchema.parse(JSON.parse(JSON.stringify(value))) }
/** Unknown errors never expose provider bodies or authentication fields. */
export function safeFailure(error: unknown) {
  if (error instanceof CuratorError || (error instanceof Error && 'code' in error && 'safeMessage' in error && 'stage' in error)) {
    const parsed = runDataSchema.shape.error.unwrap().safeParse(error)
    if (parsed.success) return parsed.data
    const e = error as CuratorError
    return { code: String(e.code), stage: String(e.stage), retryable: e.retryable === true, safeMessage: String(e.safeMessage), suggestedAction: String(e.suggestedAction) }
  }
  return { code: 'capability-unavailable', stage: 'workflow', retryable: false, safeMessage: 'The operation failed. Saved results remain available.', suggestedAction: 'Check configuration and the saved task diagnostics.' }
}
export function dataOf(run: RunRecord): RunData { return runDataSchema.parse(run.data) }
export function specOf(run: RunRecord): ExecutionSpec { return executionSchema.parse(run.spec) }
/** @param run Authorized saved analysis. @returns Explicit continuation eligibility under its original budget and terminal state. */
export function analysisContinuation(run: RunRecord): AnalysisContinuation {
  const spec = specOf(run), data = dataOf(run)
  const denied = (reason: AnalysisContinuation['reason']): AnalysisContinuation => ({ allowed: false, reason })
  if (spec.kind !== 'analyze') return denied('unavailable')
  if (['created', 'running', 'pausing', 'cancelling'].includes(run.status)) return denied('active')
  if (run.status === 'completed') return denied('completed')
  if (run.status === 'cancelled') return denied('cancelled')
  if (run.status === 'failed' && !data.error?.retryable) return denied('not-retryable')
  if (!['paused', 'interrupted', 'failed'].includes(run.status)) return denied('unavailable')
  if (Date.now() >= data.budget.deadlineAt) return denied('deadline')
  const needsVision = (data.counts.observed ?? 0) < (Array.isArray(spec.fixed.references) ? spec.fixed.references.length : 0) || spec.input.buildDataset === true && data.checkpoint.styleAnalysis === undefined
  if (needsVision && data.budget.vision >= spec.config.limits.maxVisionCalls) return denied('vision-limit')
  return { allowed: true, reason: 'ready' }
}
interface LiveRun { run: RunRecord; controller: AbortController; pauseAdmissions: AbortController; completion: Promise<JobOutcome>; command: 'pause' | 'cancel' | 'interrupt' | undefined }

/** Workers expose committed checkpoints and bounded live provider output. */
export interface WorkContext {
  readonly runId: string
  readonly signal: AbortSignal
  readonly spec: ExecutionSpec
  readonly ledger: BudgetLedger
  current(): RunRecord
  report(update: ProcessUpdate): void
  save(stage: NonNullable<RunRecord['stage']>, patch: Partial<RunData>, records?: CuratorRecord[]): Promise<void>
  request<T>(kind: 'vision' | 'search' | 'download', bundle: Json, work: (signal: AbortSignal, recordMetadata: (metadata: Json) => Promise<void>) => Promise<T>, summarize?: (result: T) => Json): Promise<T>
}
export type Worker = (context: WorkContext) => Promise<NonNullable<RunRecord['outcome']>>

/** One execution owner per task; restart restores checkpoints rather than pretending jobs survived. */
export class RunEngine {
  private readonly live = new Map<string, LiveRun>()
  private readonly chains = new Map<string, Promise<void>>()
  private readonly queued = new Map<string, Worker>()
  private readonly processes = new Map<string, AnalysisProcess>()
  private readonly processLimits = new Map<string, Limits>()
  private readonly processListeners = new Map<string, Set<(frame: AnalysisStreamFrame) => void>>()
  private readonly stopIntents = new Set<string>()
  private visionRequests = 0
  private readonly requestWaiters: { signal: AbortSignal; limit: number; resolve: () => void; reject: (error: unknown) => void; abort: () => void }[] = []
  private closed = false
  private admissions: Promise<void> = Promise.resolve()
  private drainTail: Promise<void> = Promise.resolve()
  /** @param repository Durable task owner. @param jobs Host job dispatch. @param audit Optional Session request logger. @param capacity Current Host admission limits; standalone engines without them use frozen task limits. */
  constructor(readonly repository: DomainRepository, private readonly jobs: Pick<JobRegistry, 'start'>, private readonly audit?: (run: RunRecord, request: RecordOf<'request'>) => void, private readonly capacity?: Pick<Limits, 'maxConcurrentAnalyses' | 'maxConcurrentRequests'>) {}
  authorize(run: RunRecord, actor: DomainActor): void {
    if (actor.profileId !== run.profileId || (run.owner.kind === 'profile' && actor.kind === 'agent') || (run.owner.kind === 'session' && actor.sessionId !== run.owner.sessionId)) throw new CuratorError('owner-denied', 'authorization', 'This task belongs to another owner.')
  }
  get(runId: string, actor: DomainActor): RunRecord {
    const run = this.repository.get('run', runId)
    if (!run) throw new CuratorError('reference-unavailable', 'run-read', 'The saved task is unavailable.')
    this.authorize(run, actor); return run
  }
  private async update(id: string, transform: (run: RunRecord) => { run: RunRecord; records?: CuratorRecord[] }): Promise<void> {
    const previous = this.chains.get(id) ?? Promise.resolve()
    const next = previous.then(async () => {
      const current = this.repository.get('run', id)
      if (!current) throw new CuratorError('reference-unavailable', 'run-update', 'The saved task is unavailable.')
      const updated = transform(current), revision = this.repository.manifest(`run:${id}`)?.revision ?? 0
      const run = runSchema.parse({ ...updated.run, revision: revision + 1 })
      await this.repository.commit({ aggregateId: `run:${id}`, expectedRevision: revision, operationId: randomUUID(), request: run, records: [run, ...(updated.records ?? [])], state: { runId: id } })
      const live = this.live.get(id)
      if (live) live.run = run
      this.broadcast(run, true)
    })
    this.chains.set(id, next.catch(() => {})); await next
  }
  async recover(): Promise<void> {
    for (const run of this.repository.list('run')) {
      if (['created', 'running', 'pausing', 'cancelling'].includes(run.status)) await this.update(run.id, old => {
        const data = dataOf(old)
        const records = this.repository.list('request').filter(request => request.runId === old.id && request.state === 'reserved').map(request => ({ ...request, state: 'outcome-unknown' as const, data: toJson({ bundle: request.data, error: { code: 'cancelled', outcome: 'unknown' } }) }))
        const paused = old.status === 'pausing' && specOf(old).kind === 'analyze'
        return { run: { ...old, status: old.status === 'cancelling' ? 'cancelled' : paused ? 'paused' : 'interrupted', data: toJson({ ...data, ...(paused ? { autoResume: false, process: updateAnalysisProcess(data.process, { phase: 'paused' }, specOf(old).config.limits, new Date().toISOString()) } : {}), warnings: [...data.warnings, 'Interrupted requests may have incurred charges; reserved quota is retained.'] }) }, records }
      })
    }
  }
  /** Continue only analysis tasks carrying explicit automatic recovery intent, using their saved spec.
   * @param worker The analysis worker owned by the newly initialized service.
   */
  async resumeAnalyses(worker: Worker): Promise<void> {
    const task = this.admissions.then(async () => {
      for (const run of this.repository.list('run')) {
        if (this.closed || run.status !== 'interrupted' || specOf(run).kind !== 'analyze' || dataOf(run).autoResume !== true) continue
        let resumed = false
        await this.update(run.id, old => {
          if (this.stopIntents.has(old.id) || old.status !== 'interrupted' || dataOf(old).autoResume !== true) return { run: old }
          resumed = true
          return { run: { ...old, status: 'created', data: toJson({ ...dataOf(old), attempts: dataOf(old).attempts + 1, attemptId: randomUUID() }) } }
        })
        if (resumed && !this.stopIntents.has(run.id)) await this.enqueue(this.repository.get('run', run.id)!, worker)
      }
    })
    this.admissions = task.then(() => {}, () => {})
    await task
  }
  /** @param run Saved authorized task. @returns Latest bounded output, including uncommitted stream chunks. */
  process(run: RunRecord): AnalysisProcess | undefined { return this.processes.get(run.id) ?? dataOf(run).process }
  /** @param id Task identity. @param actor Authenticated owner. @param listener Queues bounded frames without performing work in the model callback. @returns Idempotent subscription disposer. */
  subscribeProcess(id: string, actor: DomainActor, listener: (frame: AnalysisStreamFrame) => void): () => void {
    const run = this.get(id, actor)
    if (specOf(run).kind !== 'analyze') throw new CuratorError('invalid-input', 'analysis-follow', 'Choose an analysis task.')
    const listeners = this.processListeners.get(id) ?? new Set<(frame: AnalysisStreamFrame) => void>()
    this.processListeners.set(id, listeners); listeners.add(listener)
    return () => { listeners.delete(listener); if (!listeners.size) this.processListeners.delete(id) }
  }
  private broadcast(run: RunRecord, checkpoint: boolean): void {
    const listeners = this.processListeners.get(run.id)
    if (!listeners?.size) return
    const process = this.process(run), frame = { runId: run.id, status: run.status, ...(process ? { process } : {}), checkpoint }
    for (const listener of listeners) listener(frame)
  }
  private report(id: string, update: ProcessUpdate): void {
    // 执行者只在提交成功后更新此副本；逐 token 展示不重复读取和校验完整任务。
    const run = this.live.get(id)?.run ?? this.repository.get('run', id)!, limits = this.processLimits.get(id) ?? specOf(run).config.limits
    this.processLimits.set(id, limits)
    this.processes.set(id, updateAnalysisProcess(this.process(run), update, limits, new Date().toISOString()))
    this.broadcast(run, false)
  }
  private async enqueue(run: RunRecord, worker: Worker): Promise<void> {
    if (specOf(run).kind !== 'analyze') { this.schedule(run, worker); return }
    this.report(run.id, { phase: 'queued' })
    this.queued.set(run.id, worker)
    await this.drain()
  }
  private drain(): Promise<void> {
    const task = this.drainTail.then(() => this.drainNow())
    this.drainTail = task.then(() => {}, () => {})
    return task
  }
  private async drainNow(): Promise<void> {
    if (this.closed) return
    for (const [id, worker] of this.queued) {
      if (this.closed) break
      const run = this.repository.get('run', id)!
      const active = [...this.live.keys()].filter(key => specOf(this.repository.get('run', key)!).kind === 'analyze').length
      if (active >= (this.capacity?.maxConcurrentAnalyses ?? specOf(run).config.limits.maxConcurrentAnalyses)) break
      this.queued.delete(id)
      try { this.schedule(run, worker) }
      catch (error) {
        // 调度拒绝只终结对应任务；后续排队项及已完成任务不承担这个失败。
        this.report(id, { phase: 'failed' })
        await this.update(id, old => ({ run: ['cancelled', 'completed', 'failed'].includes(old.status) ? old : { ...old, status: 'failed', data: toJson({ ...dataOf(old), autoResume: false, error: safeFailure(error), process: this.process(old) }) } }))
        this.processes.delete(id); this.processLimits.delete(id); this.stopIntents.delete(id)
      }
    }
  }
  private async acquireVision(limit: number, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    if (this.visionRequests < limit && this.requestWaiters.length === 0) this.visionRequests++
    else await new Promise<void>((resolve, reject) => {
      const waiter = { signal, limit, resolve, reject, abort: () => {
        const index = this.requestWaiters.indexOf(waiter)
        if (index >= 0) this.requestWaiters.splice(index, 1)
        reject(signal.reason)
      } }
      signal.addEventListener('abort', waiter.abort, { once: true })
      this.requestWaiters.push(waiter)
    })
    return () => {
      this.visionRequests--
      while (this.requestWaiters[0] && this.visionRequests < this.requestWaiters[0].limit) {
        const waiter = this.requestWaiters.shift()!
        waiter.signal.removeEventListener('abort', waiter.abort)
        if (waiter.signal.aborted) { waiter.reject(waiter.signal.reason); continue }
        this.visionRequests++
        waiter.resolve()
      }
    }
  }
  create(spec: ExecutionSpec, actor: DomainActor, worker: Worker, operationId: string = randomUUID()): Promise<RunRecord> {
    if (this.closed) return Promise.reject(new CuratorError('capability-unavailable', 'run-start', 'The plugin is stopping.'))
    const task = this.admissions.then(() => this.createNow(spec, actor, worker, operationId))
    this.admissions = task.then(() => {}, () => {})
    return task
  }
  private async createNow(spec: ExecutionSpec, actor: DomainActor, worker: Worker, operationId: string): Promise<RunRecord> {
    if (this.closed) throw new CuratorError('capability-unavailable', 'run-start', 'The plugin is stopping.')
    if (actor.kind === 'agent' && !actor.sessionId) throw new CuratorError('owner-denied', 'run-start', 'Agent tasks require their Session.')
    const id = contentDigest({ profileId: actor.profileId, sessionId: actor.sessionId ?? null, operationId }).slice(10), now = new Date().toISOString()
    const existing = this.repository.get('run', id)
    if (existing) {
      this.authorize(existing, actor)
      if (specOf(existing).specDigest !== spec.specDigest) throw new CuratorError('operation-conflict', 'run-start', 'The operation ID was used for a different task.')
      return existing
    }
    if (spec.kind === 'analyze' && this.repository.list('run').some(run => specOf(run).kind === 'analyze' && specOf(run).input.styleId === spec.input.styleId && ['created', 'running', 'pausing', 'paused', 'cancelling', 'interrupted'].includes(run.status))) throw new CuratorError('constraint-conflict', 'analysis-start', 'This collection already has an unfinished analysis. Resume or cancel it before starting another.')
    const run = runSchema.parse({ schemaVersion: 1, profileId: actor.profileId, id, createdAt: now, kind: 'run', owner: actor.sessionId ? { kind: 'session', sessionId: actor.sessionId } : { kind: 'profile' }, revision: 1, status: 'created', stage: null, spec: toJson(spec), data: toJson({ attemptId: randomUUID(), attempts: 1, budget: new BudgetLedger(spec.config.limits).snapshot(), checkpoint: {}, counts: {}, warnings: [], resultIds: [], requestIds: [], ...(spec.kind === 'analyze' ? { autoResume: true } : {}) }) })
    await this.repository.commit({ aggregateId: `run:${id}`, expectedRevision: 0, operationId: id, request: run, records: [run], state: { runId: id } })
    if (this.closed) {
      await this.update(id, old => ({ run: { ...old, status: 'cancelled' } }))
      throw new CuratorError('capability-unavailable', 'run-start', 'The plugin stopped while accepting this task.')
    }
    try { await this.enqueue(run, worker) }
    catch (error) { await this.update(id, old => ({ run: { ...old, status: 'failed', data: toJson({ ...dataOf(old), error: safeFailure(error) }) } })); throw error }
    await this.chains.get(id)
    return this.repository.get('run', id)!
  }
  private schedule(saved: RunRecord, worker: Worker): void {
    const controller = new AbortController(), spec = specOf(saved)
    const live: LiveRun = { run: saved, controller, pauseAdmissions: new AbortController(), command: undefined, completion: Promise.resolve({ status: 'completed' }) }
    this.live.set(saved.id, live)
    try {
      this.jobs.start({ kind: 'visual-curator', label: `Visual curator: ${spec.kind}`, ...(saved.owner.kind === 'session' ? { owner: brandString<SessionId>(saved.owner.sessionId) } : {}), outputLimitBytes: 16_384,
        run: handle => {
          live.completion = this.execute(saved.id, worker, handle, live)
          return { cancel: () => { live.command = 'cancel'; controller.abort() }, done: live.completion }
        },
      })
    } catch (error) { this.live.delete(saved.id); throw error }
  }
  private async execute(id: string, worker: Worker, handle: JobHandle, live: LiveRun): Promise<JobOutcome> {
    try {
      await this.update(id, old => ({ run: { ...old, status: 'running', data: toJson({ ...dataOf(old), jobId: handle.id }) } }))
      const saved = this.repository.get('run', id)!, spec = specOf(saved), ledger = new BudgetLedger(spec.config.limits, dataOf(saved).budget)
      const executionSignal = AbortSignal.any([live.controller.signal, AbortSignal.timeout(Math.max(1, ledger.snapshot().deadlineAt - Date.now()))])
      // 暂停只撤回尚未受理的请求；已持久化预留的请求及其检查点继续使用执行信号。
      const admissionSignal = AbortSignal.any([executionSignal, live.pauseAdmissions.signal])
      const checkAdmission = () => {
        if (spec.kind === 'analyze' && this.repository.get('run', id)!.status === 'pausing') live.pauseAdmissions.abort()
        admissionSignal.throwIfAborted()
      }
      const save = async (stage: NonNullable<RunRecord['stage']>, patch: Partial<RunData>, records: CuratorRecord[] = [], beforeSave?: () => void) => {
        executionSignal.throwIfAborted(); beforeSave?.()
        await this.update(id, old => {
          executionSignal.throwIfAborted(); beforeSave?.()
          const data = { ...dataOf(old), ...patch, budget: ledger.snapshot(), ...(this.process(old) ? { process: this.process(old) } : {}) }
          handle.updateProgress(JSON.stringify({ runId: id, stage, counts: data.counts }))
          return { run: { ...old, stage, data: toJson(data) }, records }
        })
      }
      const ctx: WorkContext = {
        runId: id, signal: executionSignal, spec, ledger,
        current: () => this.repository.get('run', id)!, report: update => this.report(id, update),
        save,
        request: async <T>(kind: 'vision' | 'search' | 'download', bundle: Json, work: (signal: AbortSignal, recordMetadata: (metadata: Json) => Promise<void>) => Promise<T>, summarize?: (result: T) => Json): Promise<T> => {
          checkAdmission()
          // 用持久化的失败回执计算余量，服务重启不能重新获得同一批的重试次数。
          const digest = contentDigest(bundle)
          const currentData = dataOf(ctx.current()), marker = currentData.retryAfterRequestId
          const markerIndex = marker === undefined ? -1 : currentData.requestIds.indexOf(marker)
          if (marker !== undefined && markerIndex < 0) throw new CuratorError('reference-unavailable', 'analysis-resume', 'The saved continuation request is unavailable.')
          const retryIds = marker === undefined ? undefined : new Set(currentData.requestIds.slice(markerIndex + 1))
          const previousFailures = this.repository.list('request').filter(request => request.runId === id && (!retryIds || retryIds.has(request.id)) && request.requestDigest === digest && request.state === 'outcome-unknown').flatMap(request => {
            const parsed = z.object({ error: runDataSchema.shape.error.unwrap() }).safeParse(request.data)
            return parsed.success && parsed.data.error.code !== 'cancelled' ? [parsed.data.error] : []
          })
          const prior = previousFailures.at(-1)
          if (prior && (!prior.retryable || previousFailures.length > spec.config.limits.maxRetryAttempts)) throw new MediaError(prior.code, prior.stage, prior.retryable, prior.safeMessage, prior.suggestedAction)
          for (let retry = previousFailures.length; ; retry++) {
            checkAdmission()
            if (retry > 0) {
              try { await waitForRetry(spec.config.limits.retryDelayMs * retry, undefined, { signal: admissionSignal }) }
              catch (error) { admissionSignal.throwIfAborted(); throw error }
            }
            const release = kind === 'vision' ? await this.acquireVision(this.capacity?.maxConcurrentRequests ?? spec.config.limits.maxConcurrentRequests, admissionSignal) : () => {}
            try {
              checkAdmission(); await ledger.reserve(kind)
              if (retry > 0 && kind === 'vision' && spec.kind === 'analyze') {
                const previous = this.process(ctx.current())?.messages?.at(-1)
                ctx.report({ phase: previous?.kind === 'summary' ? 'summarizing' : 'analyzing', resetOutput: true, ...(previous ? { imageIds: previous.imageIds, ...(previous.batch !== undefined ? { batch: previous.batch } : {}) } : {}) })
              }
              const requestId = randomUUID(), stamp = new Date().toISOString()
              const request = requestSchema.parse({ schemaVersion: 1, profileId: saved.profileId, id: requestId, createdAt: stamp, kind: 'request', runId: id, state: 'reserved', requestDigest: contentDigest(bundle), data: bundle })
              await save(ctx.current().stage ?? 'planning', { requestIds: [...dataOf(ctx.current()).requestIds, requestId] }, [request], checkAdmission)
              // 使用实际预留记录关联响应，重试和恢复不能按批次数或返回顺序猜测归属。
              if (kind === 'vision' && spec.kind === 'analyze') ctx.report({ phase: this.process(ctx.current())?.phase ?? 'preparing', requestId: request.id })
              let metadata: Json | undefined
              const recordMetadata = async (value: Json) => {
                metadata = value
                await ctx.save(ctx.current().stage ?? 'planning', {}, [{ ...request, data: toJson({ ...typeof bundle === 'object' && bundle !== null && !Array.isArray(bundle) ? bundle : { bundle }, metadata }) }])
              }
              try {
                if (kind === 'vision') this.audit?.(saved, request)
                const result = await work(executionSignal, recordMetadata)
                executionSignal.throwIfAborted()
                const committed = { ...request, state: 'committed' as const, data: toJson({ bundle, output: summarize ? summarize(result) : result, ...(metadata === undefined ? {} : { metadata }) }) }
                await ctx.save(ctx.current().stage ?? 'planning', {}, [committed])
                if (kind === 'vision') this.audit?.(saved, committed)
                return result
              } catch (error) {
                if (executionSignal.aborted) {
                  await this.update(id, old => ({ run: old, records: [{ ...request, state: 'outcome-unknown', data: toJson({ bundle, error: { code: 'cancelled', outcome: 'unknown' }, ...(metadata === undefined ? {} : { metadata }) }) }] }))
                  throw error
                }
                const failure = safeFailure(error)
                const diagnostics = error instanceof MediaError && error.diagnostics ? jsonSchema.safeParse(error.diagnostics) : undefined
                if (kind === 'vision' && spec.kind === 'analyze' && failure.retryable && retry < spec.config.limits.maxRetryAttempts) ctx.report({ phase: 'retrying' })
                await ctx.save(ctx.current().stage ?? 'planning', {}, [{ ...request, state: 'outcome-unknown', data: toJson({ bundle, error: failure, ...(metadata === undefined ? {} : { metadata }), ...(diagnostics?.success ? { diagnostics: diagnostics.data } : {}) }) }])
                if (!failure.retryable || retry >= spec.config.limits.maxRetryAttempts) throw error
              }
            } finally { release() }
          }
        },
      }
      const outcome = await worker(ctx)
      executionSignal.throwIfAborted()
      if (spec.kind === 'analyze') this.report(id, { phase: 'completed' })
      await this.update(id, old => ({ run: { ...old, status: 'completed', stage: 'finalizing', outcome, data: toJson({ ...dataOf(old), ...(this.process(old) ? { process: this.process(old) } : {}) }) } }))
      return { status: 'completed', result: JSON.stringify({ runId: id, outcome }) }
    } catch (error) {
      const cancelled = live.controller.signal.aborted || live.pauseAdmissions.signal.aborted && error === live.pauseAdmissions.signal.reason
      if (!cancelled && (error instanceof CuratorError && error.code === 'budget-exhausted' || Date.now() >= dataOf(this.repository.get('run', id)!).budget.deadlineAt)) {
        if (specOf(this.repository.get('run', id)!).kind === 'analyze') this.report(id, { phase: 'failed' })
        await this.update(id, old => ({ run: { ...old, status: 'completed', outcome: 'budget-exhausted', data: toJson({ ...dataOf(old), ...(this.process(old) ? { process: this.process(old) } : {}), warnings: [...dataOf(old).warnings, 'Task budget exhausted; committed results remain available.'] }) } }))
        return { status: 'completed', result: JSON.stringify({ runId: id, outcome: 'budget-exhausted' }) }
      }
      this.report(id, { phase: cancelled ? live.command === 'pause' ? 'paused' : live.command === 'interrupt' ? 'interrupted' : 'cancelled' : 'failed' })
      await this.update(id, old => ({ run: { ...old, status: cancelled ? live.command === 'pause' ? 'paused' : live.command === 'interrupt' ? 'interrupted' : 'cancelled' : 'failed', data: toJson({ ...dataOf(old), ...(live.command === 'cancel' ? { autoResume: false } : {}), process: this.process(old), ...(cancelled ? {} : { error: safeFailure(error) }) }) } }))
      return { status: cancelled ? 'killed' : 'failed', detail: cancelled ? live.command ?? 'cancelled' : safeFailure(error).code }
    } finally { this.live.delete(id); this.processes.delete(id); this.processLimits.delete(id); this.stopIntents.delete(id); await this.drain() }
  }
  async control(id: string, command: 'pause' | 'resume' | 'cancel', actor: DomainActor, worker?: Worker, wait = true): Promise<RunRecord> {
    this.get(id, actor)
    if (command === 'cancel') this.stopIntents.add(id)
    if (command !== 'resume') return this.controlNow(id, command, actor, worker, wait)
    const task = this.admissions.then(() => this.controlNow(id, command, actor, worker, wait))
    this.admissions = task.then(() => {}, () => {})
    return task
  }
  private async controlNow(id: string, command: 'pause' | 'resume' | 'cancel', actor: DomainActor, worker?: Worker, wait = true): Promise<RunRecord> {
    const run = this.get(id, actor), live = this.live.get(id)
    if (command === 'resume') {
      const spec = specOf(run)
      if (spec.kind === 'analyze' && this.repository.list('run').some(other => other.id !== id && specOf(other).kind === 'analyze' && specOf(other).input.styleId === spec.input.styleId && ['created', 'running', 'pausing', 'cancelling'].includes(other.status))) throw new CuratorError('constraint-conflict', 'resume', 'This collection already has an active analysis.')
      const continuation = spec.kind === 'analyze' ? analysisContinuation(run) : undefined
      if (continuation && !continuation.allowed) throw new CuratorError(['deadline', 'vision-limit'].includes(continuation.reason) ? 'budget-exhausted' : 'invalid-input', 'analysis-resume', 'This analysis cannot continue under its saved task state or budget.')
      if (!worker || !(spec.kind === 'analyze' ? continuation?.allowed : ['paused', 'interrupted'].includes(run.status)) || this.closed || this.stopIntents.has(id)) throw new CuratorError('invalid-input', 'resume', 'Only an unfinished recoverable task can resume.')
      let resumed = false
      await this.update(id, old => {
        if (!(spec.kind === 'analyze' ? analysisContinuation(old).allowed : ['paused', 'interrupted'].includes(old.status)) || this.stopIntents.has(id)) return { run: old }
        resumed = true
        const { error: previousError, ...data } = dataOf(old)
        // 显式重试失败分析可获得新的单批重试窗口；原总额度、期限与回执均保留。
        const retryAfterRequestId = old.status === 'failed' ? data.requestIds.at(-1) : undefined
        return { run: { ...old, status: 'created', data: toJson({ ...data, ...(spec.kind === 'analyze' ? { autoResume: true, ...(retryAfterRequestId ? { retryAfterRequestId } : {}) } : previousError ? { error: previousError } : {}), attempts: data.attempts + 1, attemptId: randomUUID() }) } }
      })
      if (!resumed || this.stopIntents.has(id)) return this.get(id, actor)
      await this.enqueue(this.repository.get('run', id)!, worker)
    } else if (live) {
      // 取消是终止意图；迟到的暂停不能把它降为可恢复的任务。
      if (command === 'pause' && (this.stopIntents.has(id) || live.command === 'cancel' || run.status === 'cancelling')) return run
      const previousCommand = live.command
      live.command = command
      try { await this.update(id, old => ({ run: ['completed', 'failed', 'cancelled'].includes(old.status) ? old : { ...old, status: command === 'pause' ? 'pausing' : 'cancelling', data: toJson({ ...dataOf(old), autoResume: false }) } })) }
      catch (error) { if (live.command === command) live.command = previousCommand; throw error }
      if (command === 'pause' && specOf(run).kind === 'analyze') live.pauseAdmissions.abort()
      else live.controller.abort()
      if (wait) await live.completion
    } else if (command === 'pause' && run.status === 'created' && this.queued.has(id)) {
      const queuedWorker = this.queued.get(id)!
      // 排队任务还没有 AbortController；先移出调度，暂停写入失败时恢复等待项。
      this.queued.delete(id)
      try { await this.update(id, old => ({ run: old.status !== 'created' || this.stopIntents.has(id) ? old : { ...old, status: 'paused', data: toJson({ ...dataOf(old), autoResume: false }) } })) }
      catch (error) {
        if (!this.closed && !this.stopIntents.has(id) && this.repository.get('run', id)?.status === 'created') { this.queued.set(id, queuedWorker); await this.drain() }
        throw error
      }
    } else if (command === 'cancel' && ['paused', 'interrupted', 'created'].includes(run.status)) {
      this.queued.delete(id)
      this.report(id, { phase: 'cancelled' })
      await this.update(id, old => ({ run: { ...old, status: 'cancelled', data: toJson({ ...dataOf(old), autoResume: false, process: this.process(old) }) } }))
      this.processes.delete(id)
      this.processLimits.delete(id)
      this.stopIntents.delete(id)
    }
    else if (command === 'cancel' && ['cancelled', 'completed', 'failed'].includes(run.status)) { this.stopIntents.delete(id); return run }
    else throw new CuratorError('invalid-input', 'run-control', 'This task is not active.')
    return this.get(id, actor)
  }
  async dispose(): Promise<void> {
    this.closed = true
    await this.admissions
    await this.drainTail
    for (const id of this.queued.keys()) await this.update(id, old => ({ run: { ...old, status: 'interrupted', data: toJson({ ...dataOf(old), process: this.process(old) }) } }))
    this.queued.clear()
    const live = [...this.live.entries()]
    for (const [id, task] of live) { if (task.command !== 'cancel' && task.command !== 'pause') task.command = specOf(this.repository.get('run', id)!).kind === 'analyze' ? 'interrupt' : 'cancel'; task.controller.abort() }
    const settled = await Promise.allSettled(live.map(([, task]) => task.completion))
    const rejected = settled.filter((item): item is PromiseRejectedResult => item.status === 'rejected')
    if (rejected.length) throw new AggregateError(rejected.map(item => item.reason), 'Task shutdown could not persist every terminal state.')
  }
}
