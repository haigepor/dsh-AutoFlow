/** Deleting a task-history entry never removes its saved observations, profile, or immutable run. */
import { z } from 'zod'
import type { DomainRepository } from '../domain/repository.ts'
import type { RunRecord } from '../shared/model.ts'
import { CuratorError } from '../shared/errors.ts'

const prefix = 'task-history-hidden:'
const stateSchema = z.strictObject({ runId: z.string().min(1), hidden: z.literal(true) })

/** @param repository Authorized profile repository. @returns Hidden run IDs used only by history listings. */
export function hiddenTaskIds(repository: DomainRepository): ReadonlySet<string> {
  return new Set(repository.manifests().filter(manifest => manifest.aggregateId.startsWith(prefix)).map(manifest => stateSchema.parse(manifest.state).runId))
}

/** @param repository Owning profile. @param run Already-authorized run. @param operationId Idempotent human action. @returns Durable deletion receipt; saved results remain addressable. */
export async function deleteTaskHistory(repository: DomainRepository, run: RunRecord, operationId: string): Promise<{ runId: string; deleted: true }> {
  if (!['completed', 'failed', 'cancelled'].includes(run.status)) throw new CuratorError('constraint-conflict', 'task-delete', 'Stop the task before deleting its history entry.')
  const aggregateId = `${prefix}${run.id}`, prior = repository.manifest(aggregateId)
  await repository.commit({ aggregateId, expectedRevision: prior?.revision ?? 0, operationId, request: { runId: run.id }, records: [], state: { runId: run.id, hidden: true } })
  return { runId: run.id, deleted: true }
}
