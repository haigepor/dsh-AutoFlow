/** Authorized task summaries retain only small derived facts; record validation stays with every read. */
import type { CuratorDomain } from '../domain/curator.ts'
import type { DomainActor, RunRecord } from '../shared/model.ts'
import type { AnalysisTask } from '../shared/analysis-process.ts'
import { analysisSelectionProgress } from './analysis-selection.ts'
import { analysisContinuationFromFacts, dataOf, specOf, taskTiming, type AnalysisContinuationFacts, type ExecutionSpec, type RunData, type RunEngine } from './runtime.ts'

interface TaskFacts {
  task: Omit<AnalysisTask, 'name' | 'phase' | 'continuation'> & { runId: RunRecord['id'] }
  savedPhase: AnalysisTask['phase'] | undefined
  continuation: AnalysisContinuationFacts
}
interface Prepared { spec: ExecutionSpec; data: RunData }

function factsOf(run: Readonly<RunRecord>, prepared?: Prepared): TaskFacts | null {
  const spec = prepared?.spec ?? specOf(run)
  if (spec.kind !== 'analyze') return null
  const data = prepared?.data ?? dataOf(run), { observed, total } = analysisSelectionProgress(spec, data)
  return { task: { runId: run.id, styleId: String(spec.input.styleId), status: run.status, observed, total, model: spec.config.vision.model,
    reasoningEffort: spec.config.vision.reasoningEffort ?? null, attempts: data.attempts, startedAt: run.createdAt, autoResume: data.autoResume === true,
    ...(data.counts.awaiting ? { awaitingReferences: data.counts.awaiting } : {}), ...(data.checkpoint.analysisNeedsPositiveReferences === true ? { needsPositiveReferences: true } : {}), ...(typeof data.checkpoint.finalDatasetId === 'string' ? { finalDatasetId: data.checkpoint.finalDatasetId } : {}), ...(typeof data.checkpoint.observationDatasetId === 'string' ? { observationDatasetId: data.checkpoint.observationDatasetId } : {}),
    ...(run.outcome ? { outcome: run.outcome } : {}), ...(data.error ? { error: data.error } : {}) }, savedPhase: data.process?.phase,
    continuation: { kind: spec.kind, status: run.status, retryable: data.error?.retryable === true, errorCode: data.error?.code, errorStage: data.error?.stage, deadlineAt: taskTiming(spec) === 'native-model' ? null : data.budget.deadlineAt, observed, total,
      buildDataset: spec.input.buildDataset === true, hasSummary: data.checkpoint.styleAnalysis !== undefined, vision: data.budget.vision, maxVisionCalls: spec.config.limits.maxVisionCalls } }
}

function view(domain: CuratorDomain, engine: RunEngine, facts: TaskFacts, now: number): AnalysisTask {
  const { task } = facts
  return { ...task, name: domain.require('style', task.styleId).name, phase: engine.processPhase(task.runId) ?? facts.savedPhase ?? (['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status) ? task.status as 'completed' | 'failed' | 'cancelled' | 'interrupted' : 'queued'), continuation: analysisContinuationFromFacts(facts.continuation, now) }
}

/** @param domain Current collection names. @param engine Live process owner. @param run Already-authorized analysis. @param prepared Spec and data parsed from this same record in the caller's synchronous read. @returns One summary, without enumerating unrelated runs. */
export function projectAnalysisTask(domain: CuratorDomain, engine: RunEngine, run: RunRecord, prepared?: Prepared): AnalysisTask | undefined {
  const facts = factsOf(run, prepared)
  return facts ? view(domain, engine, facts, Date.now()) : undefined
}

/** @param policy Current entry and derived-byte ceilings; either zero disables retention. @param now Current wall clock for continuation eligibility. @returns Service-owned bounded summaries; hashes and owner checks precede every cache lookup, and disposal releases all retained facts. */
export function createAnalysisTaskReads(policy: () => { maxEntries: number; maxBytes: number }, now: () => number = Date.now) {
  interface Cached { digest: string; facts: TaskFacts | null; bytes: number }
  const entries = new Map<string, Cached>()
  let disposed = false
  function prune() {
    const limits = policy()
    if (disposed || !limits.maxEntries || !limits.maxBytes) { entries.clear(); return undefined }
    let bytes = [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0)
    while (entries.size > limits.maxEntries || bytes > limits.maxBytes) { const id = entries.keys().next().value!; bytes -= entries.get(id)!.bytes; entries.delete(id) }
    return limits
  }
  function read(domain: CuratorDomain, id: string, actor: DomainActor) {
    const limits = prune()
    return domain.repository.project('run', id, (run, digest) => {
      if (run.profileId !== actor.profileId || (run.owner.kind === 'profile' ? actor.kind !== 'human' : run.owner.sessionId !== actor.sessionId)) return undefined
      const cached = entries.get(id)
      if (cached?.digest === digest) { entries.delete(id); entries.set(id, cached); return cached.facts }
      entries.delete(id)
      const facts = factsOf(run)
      if (limits) {
        const bytes = Buffer.byteLength(JSON.stringify({ digest, facts })) + Buffer.byteLength(id)
        if (bytes <= limits.maxBytes) { entries.set(id, { digest, facts, bytes }); prune() }
      }
      return facts
    })
  }
  return {
    /** @param domain Current verified records. @param engine Live process owner. @param actor Current reader. @returns Authorized summaries in descending creation order; missing or renamed collections are read afresh. */
    list(domain: CuratorDomain, engine: RunEngine, actor: DomainActor): AnalysisTask[] {
      return domain.repository.readSnapshot(() => {
        const ids = domain.repository.recordIds('run'), present = new Set(ids)
        for (const id of entries.keys()) if (!present.has(id)) entries.delete(id)
        return ids.flatMap(id => { const facts = read(domain, id, actor); return facts ? [view(domain, engine, facts, now())] : [] }).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      })
    },
    /** @param domain Current verified records. @param engine Live process owner. @param actor Current reader. @param id Selected analysis identity. @returns Its authorized summary, or absence without enumerating history. */
    get(domain: CuratorDomain, engine: RunEngine, actor: DomainActor, id: string): AnalysisTask | undefined {
      return domain.repository.readSnapshot(() => { const facts = read(domain, id, actor); return facts ? view(domain, engine, facts, now()) : undefined })
    },
    dispose() { disposed = true; entries.clear() },
  }
}

/** Service-owned summary cache with explicit lifetime cleanup. */
export type AnalysisTaskReads = ReturnType<typeof createAnalysisTaskReads>
