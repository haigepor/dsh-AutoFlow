/** One profile owns one validated task domain and holds its writer lease until shutdown. */
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { defineDomain, domainTable, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { recordSchema, type TaskId, type TaskRecord } from '../shared/model.ts'

/** Durable writes settle before new task state becomes visible. */
export interface Repository {
  get(id: TaskId): TaskRecord | undefined
  list(): TaskRecord[]
  put(record: TaskRecord): Promise<void>
  delete(id: TaskId): Promise<void>
  close(): Promise<void>
}

/** @param facility Profile storage. @param profilePath Unique profile location. @param lockPath Private writer path. @returns Caller-owned repository. */
export async function openRepository(facility: Pick<DomainFacility, 'open'>, profilePath: string, lockPath: string): Promise<Repository> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
  const released = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>()
  const holding = withFileLock(lockPath, async () => { ready.resolve(); await released.promise }, { waitMs: 0 })
  void holding.catch(ready.reject)
  await ready.promise
  const release = async () => { released.resolve(); await holding }
  const spec = defineDomain({ name: `style_prompt_${createHash('sha256').update(profilePath).digest('hex').slice(0, 24)}`, version: 1, tables: { tasks: domainTable<TaskId, TaskRecord>(recordSchema) } })
  let domain
  try { domain = await facility.open(spec) } catch (error) { await release(); throw error }
  const tasks = domain.table('tasks')
  return {
    get(id) { const value = tasks.get(id); return value ? structuredClone(value) : undefined },
    list: () => [...tasks.entries()].map(([, value]) => structuredClone(value)),
    put: record => tasks.put(record.id, structuredClone(record)),
    delete: async id => { await tasks.delete(id) },
    close: async () => { try { await domain.close() } finally { await release() } },
  }
}
