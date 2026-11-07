/** Wallpaper reads and execution share the same queue, including the interval before its first checkpoint. */
import { z } from 'zod'
import type { CuratorDomain } from '../domain/curator.ts'
import type { DomainActor, RunRecord } from '../shared/model.ts'
import { wallpaperStateSchema, type WallpaperState } from '../shared/wallpaper.ts'
import { dataOf, specOf } from './runtime.ts'

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
  if (saved !== undefined) return wallpaperStateSchema.parse(saved)
  const ids = z.array(z.string()).parse(spec.input.imageVersionIds), skill = z.object({ id: z.string() }).parse(spec.fixed.skill)
  return { version: 1, sourceRunId: z.string().parse(spec.input.sourceRunId), skillVersion: skill.id, budgetStopped: false,
    items: ids.map(id => ({ imageVersionId: id, familyId: domain.familyOf(domain.require('asset', domain.require('imageVersion', id).assetId).familyId), status: 'queued', edits: 0, attempts: [] })) }
}
