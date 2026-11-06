/** Workflow visibility changes only after the selected background work has settled. */
import { z } from 'zod'
import type { CuratorDomain } from '../domain/curator.ts'
import { contentDigest } from '../domain/repository.ts'
import { CuratorError } from '../shared/errors.ts'
import type { DomainActor, RunRecord } from '../shared/model.ts'
import { workflowHistoryDeleteSchema, workflowHistoryMarkerSchema, workflowHistoryReceiptSchema, type WorkflowHistoryReceipt } from '../shared/workflow-history.ts'
import { RunEngine, specOf, toJson } from './runtime.ts'
import type { SearchLaunches } from './search-launch.ts'

/** One profile owns deletion admission, cancellation, and its atomic history marker. */
export class WorkflowHistory {
  private readonly active = new Map<string, Promise<WorkflowHistoryReceipt>>()
  private closed = false
  constructor(private readonly domain: CuratorDomain, private readonly engine: RunEngine, private readonly launches: SearchLaunches) {}
  /** @param raw Confirmed workflow and stop consent. @param actor Authenticated owner. @returns The same committed visibility result on repeated removal. */
  remove(raw: unknown, actor: DomainActor): Promise<WorkflowHistoryReceipt> {
    if (this.closed) return Promise.reject(new CuratorError('capability-unavailable', 'workflow-delete', 'The workflow history is stopping.'))
    if (actor.kind !== 'human') return Promise.reject(new CuratorError('owner-denied', 'workflow-delete', 'Workflow removal requires its authenticated owner.'))
    this.domain.repository.assertProfile(actor.profileId)
    const input = workflowHistoryDeleteSchema.parse(raw)
    this.domain.require('style', input.styleId)
    const key = `workflow-history-hidden:${contentDigest({ styleId: input.styleId, target: input.target }).slice(10)}`
    const prior = this.domain.repository.manifest(key)
    if (prior) {
      const saved = workflowHistoryMarkerSchema.parse(prior.state)
      return Promise.resolve({ deleted: true, target: saved.target, runIds: saved.runIds, launchIds: saved.launchIds })
    }
    const pending = this.active.get(key)
    if (pending) return pending
    const work = this.removeNow(input, key).finally(() => this.active.delete(key))
    this.active.set(key, work)
    return work
  }
  private async removeNow(input: z.infer<typeof workflowHistoryDeleteSchema>, key: string): Promise<WorkflowHistoryReceipt> {
    let sources: RunRecord[], launchIds: string[] = []
    if (input.target.kind === 'launch') {
      const launch = await this.launches.deletionTarget(input.target.id, input.styleId)
      const stopped = await this.launches.stop(input.target.id, true, false)
      if (stopped.status !== 'stopped') throw new CuratorError('constraint-conflict', 'workflow-delete', 'The task could not stop. Its history remains visible.', { retryable: true })
      launchIds = [input.target.id]
      sources = this.domain.repository.list('run').filter(run => run.owner.kind === 'session' && run.owner.sessionId === launch.sessionId && specOf(run).kind === 'search' && specOf(run).fixed.searchLaunchId === input.target.id)
    } else {
      const run = this.domain.require('run', input.target.id), spec = specOf(run), style = z.object({ styleId: z.string() }).safeParse(spec.fixed.release)
      if (run.profileId !== this.domain.profileId || !['search', 'crop'].includes(spec.kind) || spec.input.workflow === 'wallpaper-v1' || !style.success || style.data.styleId !== input.styleId) throw new CuratorError('owner-denied', 'workflow-delete', 'This workflow is unavailable in the selected collection.')
      // A linked run belongs to its launch; use the same selection whether deletion starts from a card or history.
      if (typeof spec.fixed.searchLaunchId === 'string') return this.remove({ ...input, target: { kind: 'launch', id: spec.fixed.searchLaunchId } }, { kind: 'human', id: 'profile-owner', profileId: this.domain.profileId })
      sources = [run]
    }
    const sourceIds = new Set<string>(sources.map(run => run.id))
    const linkedChildren = () => this.domain.repository.list('run').filter(run => { const spec = specOf(run); return spec.input.workflow === 'wallpaper-v1' && typeof spec.input.sourceRunId === 'string' && sourceIds.has(spec.input.sourceRunId) })
    const stopAll = async (runs: RunRecord[], wait: boolean) => {
      const results = await Promise.allSettled(runs.map(run => this.engine.control(run.id, 'cancel', { kind: 'human', id: 'profile-owner', profileId: this.domain.profileId, ...(run.owner.kind === 'session' ? { sessionId: run.owner.sessionId } : {}) }, undefined, wait)))
      const failure = results.find((item): item is PromiseRejectedResult => item.status === 'rejected')
      if (failure) throw failure.reason
    }
    await stopAll([...sources, ...linkedChildren()], false)
    await stopAll(sources, true)
    const children = linkedChildren()
    await stopAll(children, true)
    const runIds = [...sourceIds, ...children.map(run => run.id)]
    if (runIds.some(id => !['completed', 'failed', 'cancelled'].includes(this.domain.require('run', id).status))) throw new CuratorError('constraint-conflict', 'workflow-delete', 'Some workflow tasks have not stopped; their history remains visible.', { retryable: true })
    const receipt = workflowHistoryReceiptSchema.parse({ deleted: true, target: input.target, runIds, launchIds })
    const marker = workflowHistoryMarkerSchema.parse({ ...receipt, version: 1, styleId: input.styleId })
    await this.domain.repository.commit({ aggregateId: key, expectedRevision: 0, operationId: input.operationId, request: toJson(input), records: [], state: toJson(marker) })
    return receipt
  }
  /** @returns Settlement of admitted removals before the engine and profile storage close. */
  async dispose(): Promise<void> { this.closed = true; await Promise.allSettled(this.active.values()) }
}
