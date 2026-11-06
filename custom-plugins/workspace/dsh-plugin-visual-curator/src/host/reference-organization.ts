/** Import completion records one organization intent; concurrent imports share the active analysis and queue the newest revision. */
import { z } from 'zod'
import type { CuratorDomain } from '../domain/curator.ts'
import type { DomainActor, Json, RunRecord } from '../shared/model.ts'
import { CuratorError } from '../shared/errors.ts'
import { dataOf, safeFailure, specOf, toJson } from './runtime.ts'

const stateSchema = z.strictObject({ version: z.literal(1), styleId: z.string(), draftId: z.string(), revision: z.number().int().positive(),
  actor: z.strictObject({ kind: z.literal('human'), id: z.string(), profileId: z.string(), sessionId: z.string().optional() }).transform(({ sessionId, ...actor }): DomainActor & { kind: 'human' } => ({ ...actor, ...(sessionId === undefined ? {} : { sessionId }) })),
  pending: z.boolean(), runId: z.string().optional(), error: z.json().optional() })
type Intent = z.infer<typeof stateSchema>

/** Organization reuses the reference-analysis worker, its observation cache and automatic dataset export. */
export class ReferenceOrganization {
  private tail: Promise<void> = Promise.resolve()
  /** @param domain Profile records. @param start Existing analysis admission with an explicit frozen revision. */
  constructor(private readonly domain: CuratorDomain, private readonly start: (intent: Intent) => Promise<Json>) {}
  private key(styleId: string, actor: DomainActor) { return `reference-organization:${styleId}:${actor.sessionId ?? 'profile'}` }
  private async save(value: Intent) {
    const aggregateId = this.key(value.styleId, value.actor), revision = this.domain.repository.manifest(aggregateId)?.revision ?? 0
    await this.domain.repository.commit({ aggregateId, expectedRevision: revision, operationId: `${aggregateId}:${revision + 1}`, request: value, records: [], state: toJson(value) })
  }
  private serialize(work: () => Promise<Json>): Promise<Json> {
    const pending = this.tail.then(work); this.tail = pending.then(() => {}, () => {}); return pending
  }
  /** @param styleId Imported collection. @param actor Authenticated importing owner. @returns Existing or newly accepted analysis, without repeating observations from unchanged images. */
  request(styleId: string, actor: DomainActor): Promise<Json> {
    return this.serialize(async () => {
      if (actor.kind !== 'human') throw new CuratorError('owner-denied', 'reference-organization', 'Automatic organization requires the importing owner.')
      this.domain.repository.assertProfile(actor.profileId)
      const style = this.domain.require('style', styleId), draft = this.domain.require('draft', style.draftId)
      for (const id of draft.referenceIds) this.domain.authorizedImage(this.domain.require('reference', id).imageVersionId, actor)
      const value = stateSchema.parse({ version: 1, styleId, draftId: draft.id, revision: draft.revision, actor, pending: true })
      await this.save(value)
      return this.advance(value)
    })
  }
  private async advance(value: Intent): Promise<Json> {
    const runs = this.domain.repository.list('run').filter(run => specOf(run).kind === 'analyze' && specOf(run).input.styleId === value.styleId && (run.owner.kind === 'session' ? run.owner.sessionId === value.actor.sessionId : !value.actor.sessionId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    const same = runs.find(run => {
      const spec = specOf(run), draft = z.object({ id: z.string(), revision: z.number() }).parse(spec.fixed.draft)
      return draft.id === value.draftId && draft.revision === value.revision && spec.input.buildDataset === true && (spec.input.analysisScope === 'all' || spec.input.analysisScope === undefined)
    })
    const active = runs.find(run => ['created', 'running', 'pausing', 'paused', 'interrupted', 'cancelling'].includes(run.status))
    if (same || active) {
      const run = same ?? active!, settled = same && ['completed', 'failed', 'cancelled'].includes(run.status)
      await this.save({ ...value, pending: !settled, runId: run.id, ...(dataOf(run).error ? { error: toJson(dataOf(run).error) } : {}) })
      return toJson({ runId: run.id, status: run.status, queued: !same })
    }
    try {
      const result = await this.start(value)
      const run = z.object({ runId: z.string() }).parse(result)
      await this.save({ ...value, runId: run.runId })
      return result
    } catch (error) { await this.save({ ...value, error: toJson(safeFailure(error)) }); throw error }
  }
  /** @param run Settled analysis. @returns Completion after starting any newer imported revision; explicit cancellation also stops its queued organization intent. */
  async settled(run: RunRecord): Promise<void> {
    const styleId = specOf(run).input.styleId
    if (typeof styleId !== 'string') return
    const actor: DomainActor = { kind: 'human', id: 'profile-owner', profileId: run.profileId, ...(run.owner.kind === 'session' ? { sessionId: run.owner.sessionId } : {}) }
    await this.serialize(async () => {
      const saved = this.domain.repository.manifest(this.key(styleId, actor))
      if (!saved) return null
      const value = stateSchema.parse(saved.state)
      if (run.status === 'cancelled') { await this.save({ ...value, pending: false }); return null }
      if (value.pending) return this.advance(value)
      return null
    })
  }
  /** @returns Recovery of recorded import intents; failed analyses remain available for explicit continuation. */
  async recover(): Promise<void> {
    for (const saved of this.domain.repository.manifests().filter(item => item.aggregateId.startsWith('reference-organization:'))) {
      const value = stateSchema.parse(saved.state)
      if (!value.pending) continue
      try { await this.serialize(() => this.advance(value)) }
      catch (error) { /* advance persists the actionable preparation failure; initialization keeps imported data available. */ }
    }
  }
  /** @returns Settlement before the profile storage closes. */
  async drain(): Promise<void> { await this.tail }
}
