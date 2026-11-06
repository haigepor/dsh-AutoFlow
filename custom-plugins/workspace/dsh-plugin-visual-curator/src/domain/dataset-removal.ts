/** Dataset removal keeps immutable packages available to already accepted tasks. */
import { z } from 'zod'
import type { DomainRepository } from './repository.ts'

const prefix = 'dataset-removed:'
const removedSchema = z.strictObject({ ids: z.array(z.string().min(1)), exportIds: z.array(z.string().min(1)), runIds: z.array(z.string().min(1)) })
/** Catalog identities removed together by one confirmed human action. */
export type RemovedDatasetRecords = z.infer<typeof removedSchema>

/** @param repository Owning profile. @param id Selected dataset identity. @returns Previously committed removal, including its equivalent exports. */
export function datasetRemoval(repository: DomainRepository, id: string): RemovedDatasetRecords | undefined {
  const manifest = repository.manifest(prefix + id)
  return manifest ? removedSchema.parse(manifest.state) : undefined
}

/** @param repository Owning profile. @returns Removed catalog, export and run identities; immutable records remain readable by existing tasks. */
export function removedDatasetIds(repository: DomainRepository) {
  const removed = repository.manifests(prefix).map(manifest => removedSchema.parse(manifest.state))
  return { ids: new Set(removed.flatMap(item => item.ids)), exports: new Set(removed.flatMap(item => item.exportIds)), runs: new Set(removed.flatMap(item => item.runIds)) }
}

/** @param repository Owning profile. @param id Authorized selected dataset. @param operationId Retained human action identity. @param selection Authorized equivalent records. @returns Durable removal; source images, profiles, analysis and frozen task inputs remain intact. */
export async function recordDatasetRemoval(repository: DomainRepository, id: string, operationId: string, selection: RemovedDatasetRecords): Promise<void> {
  await repository.commit({ aggregateId: prefix + id, expectedRevision: 0, operationId, request: { id }, records: [], state: selection })
}
