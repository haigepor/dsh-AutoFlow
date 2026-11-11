/** Deleting a task-history entry never removes its saved observations, profile, or immutable run. */
import { z } from 'zod'
import type { DomainRepository } from '../domain/repository.ts'
import type { RunRecord } from '../shared/model.ts'
import { CuratorError } from '../shared/errors.ts'
import { workflowHistoryMarkerSchema } from '../shared/workflow-history.ts'

const prefix = 'task-history-hidden:'
const stateSchema = z.strictObject({ runId: z.string().min(1), hidden: z.literal(true) })

/** @param repository Authorized profile repository. @returns Hidden run IDs used only by history listings. */
export function hiddenTaskIds(repository: DomainRepository): ReadonlySet<string> {
  return new Set(repository.manifests([prefix, 'workflow-history-hidden:']).flatMap(manifest => manifest.aggregateId.startsWith(prefix) ? [stateSchema.parse(manifest.state).runId] : workflowHistoryMarkerSchema.parse(manifest.state).runIds))
}

/** @param repository Authorized profile repository. @returns Launches removed with their associated workflow records. */
export function hiddenLaunchIds(repository: DomainRepository): ReadonlySet<string> {
  return new Set(repository.manifests('workflow-history-hidden:').flatMap(manifest => workflowHistoryMarkerSchema.parse(manifest.state).launchIds))
}

/** @param repository Owning profile. @param run Already-authorized list entry. @param operationId Idempotent human action. @param current Authorized current snapshot when this entry aggregates revisions; the caller checks execution blockers. @returns Durable deletion receipt; saved results remain addressable. */
export async function deleteTaskHistory(repository: DomainRepository, run: RunRecord, operationId: string, current = run): Promise<{ runId: string; deleted: true }> {
  if (!['completed', 'failed', 'cancelled'].includes(current.status)) throw new CuratorError('constraint-conflict', 'task-delete', 'Stop the task before deleting its history entry.')
  const aggregateId = `${prefix}${run.id}`, prior = repository.manifest(aggregateId)
  await repository.commit({ aggregateId, expectedRevision: prior?.revision ?? 0, operationId, request: { runId: run.id }, records: [], state: { runId: run.id, hidden: true } })
  return { runId: run.id, deleted: true }
}
