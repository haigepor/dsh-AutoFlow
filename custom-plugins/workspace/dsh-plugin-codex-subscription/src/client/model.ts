/** Pure card derivation from live task views and durable tool metadata. */
import { z } from 'zod'
import { imageViewTaskSchema, type ImageSessionView, type ImageViewTask, type ImageViewAsset } from '../shared/image-view.ts'

const recorded = z.object({ version: z.literal(1), taskId: z.string().min(1).max(256), state: imageViewTaskSchema.shape.state,
  createdAt: z.number().finite(), deadlineAt: z.number().finite(), assets: z.array(z.object({ id: z.string().min(1).max(256), name: z.string().max(4096),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), width: z.number().int().positive(), height: z.number().int().positive() })).max(4),
  error: z.object({ code: z.string().max(256) }).nullable().optional(),
})

/** Read only recognized durable image metadata, including nested calls' canonical text fallback.
 * @param meta Persisted presentation metadata.
 * @param content Settled tool blocks.
 * @param settledAt Tool result timestamp.
 * @returns Safe task facts, or undefined when the result does not match.
 */
export function recordedImageTask(meta: unknown, content: readonly { type: string; text?: string }[], settledAt: number): ImageViewTask | undefined {
  const envelope = z.object({ codexImage: recorded }).safeParse(meta)
  let value = envelope.success ? envelope.data.codexImage : undefined
  if (!value) for (const block of content) {
    if (block.type !== 'text' || block.text === undefined || block.text.length > 262144) continue
    try { const candidate = recorded.safeParse({ version: 1, ...z.record(z.string(), z.unknown()).parse(JSON.parse(block.text)) }); if (candidate.success) { value = candidate.data; break } }
    catch (error) { /* Noncanonical tool text contributes no image task facts. */ }
  }
  if (!value) return undefined
  return { taskId: value.taskId, state: value.state, createdAt: value.createdAt, updatedAt: settledAt, deadlineAt: value.deadlineAt,
    assets: value.assets.map(asset => ({ assetId: asset.id, name: asset.name, mimeType: asset.mimeType, width: asset.width, height: asset.height })),
    ...(value.error ? { errorCode: value.error.code } : {}) }
}

/** Whether a task is still admitted or dispatched, rather than settled or unknown.
 * @param task Task view.
 * @returns True for queued or sent work only.
 */
export function imageTaskActive(task: ImageViewTask): boolean { return task.state === 'queued' || task.state === 'sent' }

/** Select live facts without downgrading a recorded terminal result to stale pending work.
 * @param view Session resource value.
 * @param callId Current tool invocation.
 * @param taskId Explicit result-query target.
 * @param saved Durable fallback.
 * @returns Current task, when identified.
 */
export function selectImageTask(view: ImageSessionView | undefined, callId: string, taskId: string | undefined, saved: ImageViewTask | undefined): ImageViewTask | undefined {
  const live = view?.tasks.find(task => task.taskId === (taskId ?? saved?.taskId) || task.callId === callId)
  if (!live) return saved
  // 工具结果的日志时间晚于任务写入时间，不代表它保存的 queued/sent 状态比后台完成结果更新。
  if (saved && saved.taskId === live.taskId && imageTaskActive(saved) && !imageTaskActive(live)) return live
  if (saved && saved.taskId === live.taskId && (!imageTaskActive(saved) && imageTaskActive(live) || saved.updatedAt > live.updatedAt)) {
    return { ...saved, ...(live.callId === undefined ? {} : { callId: live.callId }) }
  }
  return live
}

/** One stable gallery item with a task-qualified asset key. */
export interface GalleryImage extends ImageViewAsset { key: string; taskId: string }

/** Merge task assets without duplicating the same image across result polls.
 * @param view Same-Session resource value.
 * @param current Current call's durable fallback.
 * @returns Images in creation order with stable selection keys.
 */
export function sessionGallery(view: ImageSessionView | undefined, current: ImageViewTask | undefined): GalleryImage[] {
  const tasks = new Map((view?.tasks ?? []).map(task => [task.taskId, task]))
  if (current) tasks.set(current.taskId, current)
  const images = new Map<string, GalleryImage>()
  for (const task of [...tasks.values()].sort((a, b) => a.createdAt - b.createdAt)) for (const asset of task.assets) {
    const key = `${task.taskId}:${asset.assetId}`; images.set(key, { ...asset, key, taskId: task.taskId })
  }
  return [...images.values()]
}

/** Bounded display estimate; only a durable successful state can represent completion.
 * @param task Current task.
 * @param now Browser wall clock.
 * @returns Estimated percentage below completion for active work.
 */
export function imageEstimate(task: ImageViewTask, now: number): number {
  if (task.state === 'succeeded') return 100
  if (!imageTaskActive(task)) return 0
  if (task.state === 'queued') return 0
  const duration = Math.max(1000, task.deadlineAt - task.createdAt), elapsed = Math.max(0, now - task.createdAt)
  return Math.min(90, Math.floor(5 + 85 * (1 - Math.exp(-elapsed / (duration * .3)))))
}
