/** Search attempts freeze each checkpoint before queueing it and stop publishing after the first failed save. */
import type { CuratorDomain } from '../domain/curator.ts'
import type { CuratorRecord } from '../shared/model.ts'

type SearchStage = 'retrieving' | 'screening' | 'reviewing'

/** @param state Mutable state owned by one search attempt.
 * @param persist Commit the detached checkpoint and its record dependencies together; failure stops this writer.
 * @returns Ordered saves whose snapshots cannot include mutations made by later callers. A new attempt creates a new writer.
 */
export function createSearchCheckpointWriter<State>(state: State, persist: (snapshot: State, records: CuratorRecord[], stage: SearchStage) => Promise<void>): (records?: CuratorRecord[], stage?: SearchStage) => Promise<void> {
  let writing = Promise.resolve()
  return (records = [], stage = 'screening') => {
    const snapshot = structuredClone(state), dependencies = structuredClone(records)
    const pending = writing.then(() => persist(snapshot, dependencies, stage))
    writing = pending
    return pending
  }
}

/** @param domain Authoritative committed records.
 * @param importedImages Search-owned candidate mappings, updated in place; image files and records remain untouched.
 * @returns Candidates to retry because an earlier failed save published their mapping without the image dependencies.
 */
export function removeUncommittedSearchImports(domain: CuratorDomain, importedImages: Record<string, string>): string[] {
  const pending: string[] = []
  for (const [candidateId, imageId] of Object.entries(importedImages)) {
    const image = domain.repository.get('imageVersion', imageId)
    if (image && domain.repository.get('asset', image.assetId)) continue
    delete importedImages[candidateId]
    pending.push(candidateId)
  }
  return pending
}
