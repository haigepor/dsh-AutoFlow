/** Durable workflow lifecycle and budgets, independent of process-local job identities. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { JobRegistry, JobHandle, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { DomainRepository, contentDigest } from '../domain/repository.ts'
import { CuratorError } from '../shared/errors.ts'
import { jsonSchema, runSchema, requestSchema, type Json, type RunRecord, type DomainActor, type CuratorRecord, type RecordOf } from '../shared/model.ts'
import { settingsSchema, type Limits } from './config.ts'

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
interface LiveRun { controller: AbortController; completion: Promise<JobOutcome>; command: 'pause' | 'cancel' | undefined }

/** Worker state exposes only manifest-committed progress. */
export interface WorkContext {
  readonly runId: string
  readonly signal: AbortSignal
  readonly spec: ExecutionSpec
  readonly ledger: BudgetLedger
  current(): RunRecord
  save(stage: NonNullable<RunRecord['stage']>, patch: Partial<RunData>, records?: CuratorRecord[]): Promise<void>
  request<T>(kind: 'vision' | 'search' | 'download', bundle: Json, work: (signal: AbortSignal) => Promise<T>, summarize?: (result: T) => Json): Promise<T>
}
export type Worker = (context: WorkContext) => Promise<NonNullable<RunRecord['outcome']>>

/** One execution owner per task; restart restores checkpoints rather than pretending jobs survived. */
export class RunEngine {
  private readonly live = new Map<string, LiveRun>()
  private readonly chains = new Map<string, Promise<void>>()
  private closed = false
  private admissions: Promise<void> = Promise.resolve()
  constructor(readonly repository: DomainRepository, private readonly jobs: Pick<JobRegistry, 'start'>, private readonly audit?: (run: RunRecord, request: RecordOf<'request'>) => void) {}
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
    })
    this.chains.set(id, next.catch(() => {})); await next
  }
  async recover(): Promise<void> {
    for (const run of this.repository.list('run')) {
      if (['created', 'running', 'pausing', 'cancelling'].includes(run.status)) await this.update(run.id, old => {
        const data = dataOf(old)
        const records = this.repository.list('request').filter(request => request.runId === old.id && request.state === 'reserved').map(request => ({ ...request, state: 'outcome-unknown' as const }))
        return { run: { ...old, status: old.status === 'cancelling' ? 'cancelled' : 'interrupted', data: toJson({ ...data, warnings: [...data.warnings, 'Interrupted requests may have incurred charges; reserved quota is retained.'] }) }, records }
      })
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
    const run = runSchema.parse({ schemaVersion: 1, profileId: actor.profileId, id, createdAt: now, kind: 'run', owner: actor.sessionId ? { kind: 'session', sessionId: actor.sessionId } : { kind: 'profile' }, revision: 1, status: 'created', stage: null, spec: toJson(spec), data: toJson({ attemptId: randomUUID(), attempts: 1, budget: new BudgetLedger(spec.config.limits).snapshot(), checkpoint: {}, counts: {}, warnings: [], resultIds: [], requestIds: [] }) })
    await this.repository.commit({ aggregateId: `run:${id}`, expectedRevision: 0, operationId: id, request: run, records: [run], state: { runId: id } })
    if (this.closed) {
      await this.update(id, old => ({ run: { ...old, status: 'cancelled' } }))
      throw new CuratorError('capability-unavailable', 'run-start', 'The plugin stopped while accepting this task.')
    }
    try { this.schedule(run, worker) }
    catch (error) { await this.update(id, old => ({ run: { ...old, status: 'failed', data: toJson({ ...dataOf(old), error: safeFailure(error) }) } })); throw error }
    await this.chains.get(id)
    return this.repository.get('run', id)!
  }
  private schedule(saved: RunRecord, worker: Worker): void {
    const controller = new AbortController(), spec = specOf(saved)
    const live: LiveRun = { controller, command: undefined, completion: Promise.resolve({ status: 'completed' }) }
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
      const ctx: WorkContext = {
        runId: id, signal: executionSignal, spec, ledger,
        current: () => this.repository.get('run', id)!,
        save: async (stage, patch, records = []) => {
          executionSignal.throwIfAborted()
          await this.update(id, old => {
            executionSignal.throwIfAborted()
            const data = { ...dataOf(old), ...patch, budget: ledger.snapshot() }
            handle.updateProgress(JSON.stringify({ runId: id, stage, counts: data.counts }))
            return { run: { ...old, stage, data: toJson(data) }, records }
          })
        },
        request: async <T>(kind: 'vision' | 'search' | 'download', bundle: Json, work: (signal: AbortSignal) => Promise<T>, summarize?: (result: T) => Json): Promise<T> => {
          for (let retry = 0; ; retry++) {
            executionSignal.throwIfAborted(); await ledger.reserve(kind)
            const requestId = randomUUID(), stamp = new Date().toISOString()
            const request = requestSchema.parse({ schemaVersion: 1, profileId: saved.profileId, id: requestId, createdAt: stamp, kind: 'request', runId: id, state: 'reserved', requestDigest: contentDigest(bundle), data: bundle })
            await ctx.save(ctx.current().stage ?? 'planning', { requestIds: [...dataOf(ctx.current()).requestIds, requestId] }, [request])
            try {
              if (kind === 'vision') this.audit?.(saved, request)
              const result = await work(executionSignal)
              executionSignal.throwIfAborted()
              const committed = { ...request, state: 'committed' as const, data: toJson({ bundle, output: summarize ? summarize(result) : result }) }
              await ctx.save(ctx.current().stage ?? 'planning', {}, [committed])
              if (kind === 'vision') this.audit?.(saved, committed)
              return result
            } catch (error) {
              if (executionSignal.aborted) {
                await this.update(id, old => ({ run: old, records: [{ ...request, state: 'outcome-unknown', data: toJson({ bundle, error: { code: 'cancelled', outcome: 'unknown' } }) }] }))
                throw error
              }
              const failure = safeFailure(error)
              await ctx.save(ctx.current().stage ?? 'planning', {}, [{ ...request, state: 'outcome-unknown', data: toJson({ bundle, error: failure }) }])
              if (!failure.retryable || retry >= spec.config.limits.maxRetryAttempts) throw error
            }
          }
        },
      }
      const outcome = await worker(ctx)
      executionSignal.throwIfAborted()
      await this.update(id, old => ({ run: { ...old, status: 'completed', stage: 'finalizing', outcome } }))
      return { status: 'completed', result: JSON.stringify({ runId: id, outcome }) }
    } catch (error) {
      const cancelled = live.controller.signal.aborted
      if (!cancelled && (error instanceof CuratorError && error.code === 'budget-exhausted' || Date.now() >= dataOf(this.repository.get('run', id)!).budget.deadlineAt)) {
        await this.update(id, old => ({ run: { ...old, status: 'completed', outcome: 'budget-exhausted', data: toJson({ ...dataOf(old), warnings: [...dataOf(old).warnings, 'Task budget exhausted; committed results remain available.'] }) } }))
        return { status: 'completed', result: JSON.stringify({ runId: id, outcome: 'budget-exhausted' }) }
      }
      await this.update(id, old => ({ run: { ...old, status: cancelled ? live.command === 'pause' ? 'paused' : 'cancelled' : 'failed', data: toJson({ ...dataOf(old), ...(cancelled ? {} : { error: safeFailure(error) }) }) } }))
      return { status: cancelled ? 'killed' : 'failed', detail: cancelled ? live.command ?? 'cancelled' : safeFailure(error).code }
    } finally { this.live.delete(id) }
  }
  async control(id: string, command: 'pause' | 'resume' | 'cancel', actor: DomainActor, worker?: Worker): Promise<RunRecord> {
    const run = this.get(id, actor), live = this.live.get(id)
    if (command === 'resume') {
      if (!worker || !['paused', 'interrupted'].includes(run.status) || this.closed) throw new CuratorError('invalid-input', 'resume', 'Only a paused or interrupted task can resume.')
      await this.update(id, old => ({ run: { ...old, status: 'created', data: toJson({ ...dataOf(old), attempts: dataOf(old).attempts + 1, attemptId: randomUUID() }) } }))
      this.schedule(this.repository.get('run', id)!, worker)
    } else if (live) {
      live.command = command === 'pause' ? 'pause' : 'cancel'
      await this.update(id, old => ({ run: { ...old, status: command === 'pause' ? 'pausing' : 'cancelling' } }))
      live.controller.abort(); await live.completion
    } else if (command === 'cancel' && ['paused', 'interrupted', 'created'].includes(run.status)) await this.update(id, old => ({ run: { ...old, status: 'cancelled' } }))
    else throw new CuratorError('invalid-input', 'run-control', 'This task is not active.')
    return this.get(id, actor)
  }
  async dispose(): Promise<void> {
    this.closed = true
    await this.admissions
    const live = [...this.live.values()]
    for (const task of live) { task.command = 'cancel'; task.controller.abort() }
    const settled = await Promise.allSettled(live.map(task => task.completion))
    const rejected = settled.filter((item): item is PromiseRejectedResult => item.status === 'rejected')
    if (rejected.length) throw new AggregateError(rejected.map(item => item.reason), 'Task shutdown could not persist every terminal state.')
  }
}
