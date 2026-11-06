/** Wallpaper reads and execution share the same queue, including the interval before its first checkpoint. */
import { z } from 'zod'
import type { CuratorDomain } from '../domain/curator.ts'
import type { RunRecord } from '../shared/model.ts'
import { wallpaperStateSchema, type WallpaperState } from '../shared/wallpaper.ts'
import { dataOf, specOf } from './runtime.ts'

/** @param domain The task's profile records. @param run Frozen wallpaper task. @returns Its committed queue, or the exact initial queue before dispatch. */
export function wallpaperRunState(domain: CuratorDomain, run: RunRecord): WallpaperState {
  const spec = specOf(run), saved = dataOf(run).checkpoint.wallpaper ?? spec.fixed.initialWallpaperState
  if (saved !== undefined) return wallpaperStateSchema.parse(saved)
  const ids = z.array(z.string()).parse(spec.input.imageVersionIds), skill = z.object({ id: z.string() }).parse(spec.fixed.skill)
  return { version: 1, sourceRunId: z.string().parse(spec.input.sourceRunId), skillVersion: skill.id, budgetStopped: false,
    items: ids.map(id => ({ imageVersionId: id, familyId: domain.familyOf(domain.require('asset', domain.require('imageVersion', id).assetId).familyId), status: 'queued', edits: 0, attempts: [] })) }
}
