/** Wallpaper response recovery reads only receipts owned by the current or explicitly replayed task. */
import type { DomainRepository } from '../domain/repository.ts'
import type { RunRecord } from '../shared/model.ts'
import { dataOf } from './runtime.ts'

/** @param repository Profile-owned committed records. @param current Current task and receipt identities. @param requestId Stable model request identity. @param digest Exact prepared request digest. @param replayable Whether an original task's committed response may be reused. @returns An exact committed response, without reading unrelated historical request bodies. */
export function findWallpaperResponse(repository: DomainRepository, current: RunRecord, requestId: string, digest: string, replayable: boolean) {
  return repository.readSnapshot(() => {
    const owners = [current]
    const separator = requestId.indexOf(':')
    if (replayable && separator > 0) {
      const ownerId = requestId.slice(0, separator)
      if (ownerId !== current.id) {
        const owner = repository.get('run', ownerId)
        if (owner?.profileId === current.profileId) owners.push(owner)
      }
    }
    for (const owner of owners) for (const id of dataOf(owner).requestIds) {
      const request = repository.get('request', id)
      if (request?.state === 'committed' && request.runId === owner.id && request.requestDigest === digest) return request
    }
    return undefined
  })
}
