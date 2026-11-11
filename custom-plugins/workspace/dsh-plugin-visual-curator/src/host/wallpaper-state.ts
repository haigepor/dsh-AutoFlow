/** Wallpaper reads and execution share the same queue, including the interval before its first checkpoint. */
import { z } from 'zod'
import type { CuratorDomain } from '../domain/curator.ts'
import type { DomainActor, RunRecord } from '../shared/model.ts'
import { CuratorError } from '../shared/errors.ts'
import { wallpaperStateSchema, type WallpaperItem, type WallpaperState } from '../shared/wallpaper.ts'
import { dataOf, specOf } from './runtime.ts'
import { hiddenTaskIds } from './task-history.ts'

/** Project a manual inspection from an older task's saved request when it predates inspection checkpoints.
 * @param domain Profile records. @param run Authorized manual inspection task. @param item Inspected source.
 * @returns The saved inspection result or the observed request state for display.
 */
export function legacyManualInspection(domain: CuratorDomain, run: RunRecord, item: WallpaperItem): WallpaperItem['detailInspection'] {
  const prior = item.attempts.find(attempt => attempt.detailAnalysis?.requestId === `${run.id}:${item.imageVersionId}:detail:${attempt.revision}`)
  const attempt = prior ?? item.attempts.at(-1)
  if (!attempt) return
  const requestId = `${run.id}:${item.imageVersionId}:detail:${attempt.revision}`
  const decisionRoundAtStart = item.decisions?.findLast(record => !record.id.startsWith(run.id + ':'))?.round ?? 0
  const inspection = { origin: 'manual' as const, planRevision: attempt.revision, requestId, decisionRoundAtStart }
  if (prior?.detailAnalysis) return { ...inspection, status: prior.detailAnalysis.outcome }
  const entries = domain.repository.manifest('run:' + run.id)?.records ?? []
  const descriptor = z.object({ requestId: z.literal(requestId) })
  const envelope = z.object({ bundle: descriptor, error: z.object({ code: z.string() }).optional() })
  const requests = entries.filter(entry => entry.kind === 'request')
    .map(entry => domain.repository.get('request', entry.id))
    .filter(request => request !== undefined)
    .filter(request => request.runId === run.id && (descriptor.safeParse(request.data).success || envelope.safeParse(request.data).success))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  const request = requests[0]
  if (request?.state === 'outcome-unknown') {
    const errorCode = envelope.parse(request.data).error?.code ?? item.errorCode
    return { ...inspection, status: 'failed', ...(errorCode ? { errorCode } : {}) }
  }
  if (run.status === 'created') return { ...inspection, status: 'queued' }
  if (run.status === 'running') return { ...inspection, status: request ? 'running' : 'queued' }
  return { ...inspection, status: 'unavailable', ...(item.errorCode ? { errorCode: item.errorCode } : {}) }
}

/** Read the current snapshot and execution blockers for one authorized wallpaper batch.
 * @param domain Profile records. @param run Any saved snapshot in the batch.
 * @returns Newest snapshot, all historical snapshots and whether list removal can proceed.
 */
export function wallpaperBatch(domain: CuratorDomain, run: RunRecord) {
  const spec = specOf(run), runs = domain.repository.list('run').filter(other => other.profileId === run.profileId
    && specOf(other).input.workflow === spec.input.workflow && specOf(other).input.sourceRunId === spec.input.sourceRunId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  const current = runs[0]!
  return { current, runs, stopped: ['completed', 'failed', 'cancelled'].includes(current.status) && !runs.some(other => ['created', 'running', 'pausing', 'cancelling'].includes(other.status)) }
}

/** @param domain Profile records. @param run Authorized wallpaper snapshot. @returns Whether explicit or automatic work may still use this snapshot. */
export function wallpaperAcceptsWork(domain: CuratorDomain, run: RunRecord): boolean {
  const batch = wallpaperBatch(domain, run)
  return batch.current.id === run.id && !['cancelled', 'cancelling'].includes(run.status) && !hiddenTaskIds(domain.repository).has(String(specOf(run).input.sourceRunId))
    && !batch.runs.some(other => other.id !== run.id && ['created', 'running', 'pausing', 'cancelling'].includes(other.status))
}

/** Permit an Agent to observe only the wallpaper child of its own search Session.
 * @param domain Profile-owned records. @param run Candidate child. @param actor Original Session reader.
 * @returns Whether the frozen child and search parent grant this read; control authority is unchanged.
 */
export function canReadWallpaperChild(domain: CuratorDomain, run: RunRecord, actor: DomainActor): boolean {
  if (actor.kind !== 'agent' || !actor.sessionId || actor.profileId !== domain.profileId || run.profileId !== actor.profileId || run.owner.kind !== 'profile') return false
  const spec = specOf(run)
  if (spec.kind !== 'crop' || spec.input.workflow !== 'wallpaper-v1' || spec.fixed.sourceSessionId !== actor.sessionId || typeof spec.input.sourceRunId !== 'string') return false
  const source = domain.repository.get('run', spec.input.sourceRunId)
  return !!source && source.profileId === actor.profileId && source.owner.kind === 'session' && source.owner.sessionId === actor.sessionId && specOf(source).kind === 'search' && wallpaperRunState(domain, run).sourceRunId === source.id
}

/** @param domain The task's profile records. @param run Frozen wallpaper task. @returns Its committed queue, or the exact initial queue before dispatch. */
export function wallpaperRunState(domain: CuratorDomain, run: RunRecord): WallpaperState {
  const spec = specOf(run), saved = dataOf(run).checkpoint.wallpaper ?? spec.fixed.initialWallpaperState
  if (saved !== undefined) {
    const state = wallpaperStateSchema.parse(saved)
    if ((state.version === 2) !== (spec.input.workflow === 'wallpaper-direct-v1')) throw new CuratorError('reference-unavailable', 'wallpaper-read', 'The saved checkpoint version does not match this workflow.')
    return state
  }
  const ids = z.array(z.string()).parse(spec.input.imageVersionIds), skill = z.object({ id: z.string() }).parse(spec.fixed.skill)
  return { version: spec.input.workflow === 'wallpaper-direct-v1' ? 2 : 1, sourceRunId: z.string().parse(spec.input.sourceRunId), skillVersion: skill.id, budgetStopped: false,
    items: ids.map(id => ({ imageVersionId: id, familyId: domain.familyOf(domain.require('asset', domain.require('imageVersion', id).assetId).familyId), status: 'queued', edits: 0, attempts: [] })) }
}
