/** Authoritative task records use one storage-domain table and fail closed on invalid durable data. */
import { z } from 'zod'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { defineDomain, domainTable, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { ImageTask, ImageTaskRecord, ImageTaskRepository } from '../images/types.ts'
import { parseImageAssetId, parseImageTaskId, type ImageTaskId } from '../images/ids.ts'

const id = z.string().min(1).max(256)
const opaqueId = id.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/)
const attachmentId = id.transform(value => AttachmentId(value))
const dimensions = z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict()
const mediaType = z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const fileRef = z.object({ attachmentId, name: z.string(), bytes: z.number().int().nonnegative() }).strict()
const imageRef = z.object({
  attachmentId, mediaType, bytes: z.number().int().nonnegative(), width: z.number().int().positive(),
  height: z.number().int().positive(), name: z.string().optional(), originalDimensions: dimensions.optional(),
}).strict()

/** Persisted v1 tasks never retain credentials, inline data URLs, or remote signed image URLs. */
const recordSchema = z.object({
  id: opaqueId,
  owner: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('session'), sessionId: id, toolCallId: id.optional() }).strict(),
    z.object({ kind: z.literal('gateway'), keyId: id }).strict(),
  ]),
  state: z.enum(['queued', 'sent', 'succeeded', 'failed', 'cancelled', 'outcome-unknown']),
  prompt: z.string(), model: id, createdAt: z.number().finite(), updatedAt: z.number().finite(), deadlineAt: z.number().finite(),
  accountKey: id.optional(),
  assets: z.array(z.object({ id: opaqueId, mimeType: mediaType, original: fileRef, preview: imageRef }).strict()).max(4),
  error: z.object({ code: id, message: z.string().max(1024), status: z.number().int().optional(), retryAt: z.number().finite().optional(), requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional() }).strict().optional(),
}).strict()

/** Validate durable JSON while preserving nominal attachment IDs, which are strings on the medium. */
export const imageTaskSchema = z.custom<ImageTask>(value => recordSchema.safeParse(value).success).transform(task => ({
  ...task, id: parseImageTaskId(task.id), assets: task.assets.map(asset => ({ ...asset, id: parseImageAssetId(asset.id) })),
}))

/** Open one caller-owned image-task domain; close only after its ImageService has drained.
 * @param facility Injected storage-domain facility.
 * @param domainName Profile-local domain name supplied by plugin configuration.
 * @param lockPath Profile-private path whose writer lease lasts until repository close.
 * @returns A repository whose writes are durable and whose reads are detached copies.
 */
export async function openImageTaskRepository(facility: Pick<DomainFacility, 'open'>, domainName: string, lockPath: string): Promise<ImageTaskRepository> {
  const spec = defineDomain({ name: domainName, version: 1, tables: { tasks: domainTable<ImageTaskId, ImageTaskRecord>(imageTaskSchema) } })
  const release = await acquireTaskWriter(lockPath)
  let domain
  try { domain = await facility.open(spec) } catch (error) { await release(); throw error }
  const tasks = domain.table('tasks')
  return {
    get: id => Promise.resolve(clone(tasks.get(id))),
    list: () => Promise.resolve([...tasks.entries()].map(([, value]) => structuredClone(value))),
    put: task => tasks.put(task.id, structuredClone(task)),
    delete: async id => { await tasks.delete(id) },
    close: async () => { try { await domain.close() } finally { await release() } },
  }
}

/** Hold one cross-process writer through task recovery and the last durable terminal write.
 * @param lockPath Profile-private lock address.
 * @returns Idempotent asynchronous release; a second active Host fails before opening storage.
 */
export async function acquireTaskWriter(lockPath: string): Promise<() => Promise<void>> {
  const absolute = resolve(lockPath)
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 })
  const released = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>()
  const holding = withFileLock(absolute, async () => { ready.resolve(); await released.promise }, { waitMs: 0 })
  void holding.catch(ready.reject)
  await ready.promise
  return async () => { released.resolve(); await holding }
}

function clone(task: ImageTaskRecord | undefined): ImageTaskRecord | undefined {
  return task === undefined ? undefined : structuredClone(task)
}
