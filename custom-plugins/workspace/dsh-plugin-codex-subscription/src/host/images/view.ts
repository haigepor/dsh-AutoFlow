/** Browser image views exclude account identity, prompts, credentials and upstream messages. */
import type { ImageTask } from './types.ts'
import type { ImageSessionView } from '../../shared/image-view.ts'

/** Project only the addressed Session's durable tasks, including partial assets.
 * @param sessionId Session named by the owner-authorized UI request.
 * @param tasks Tasks read from the image service.
 * @param pollIntervalMs Validated display refresh cadence.
 * @returns A credential-free, versioned browser view.
 */
export function projectImageSession(sessionId: string, tasks: readonly ImageTask[], pollIntervalMs: number): ImageSessionView {
  return { version: 1, sessionId, pollIntervalMs,
    tasks: tasks.filter(task => task.owner.kind === 'session' && task.owner.sessionId === sessionId).map(task => ({
      taskId: task.id, ...(task.owner.kind === 'session' && task.owner.toolCallId !== undefined ? { callId: task.owner.toolCallId } : {}),
      state: task.state, createdAt: task.createdAt, updatedAt: task.updatedAt, deadlineAt: task.deadlineAt,
      assets: task.assets.map(asset => ({ assetId: asset.id, name: asset.original.name, mimeType: asset.mimeType,
        width: asset.preview.width, height: asset.preview.height })),
      ...(task.error === undefined ? {} : { errorCode: task.error.code }),
    })) }
}
