/** Resolve only images already visible in this Session or owned by its image tasks. */
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { ImageBytes, ImageOwner, ImagesFacade, ImageTask } from './types.ts'
import { ImageServiceError } from './errors.ts'

/** Read a Session-authorized reference without accepting arbitrary storage IDs or local paths.
 * @param reference Attachment ID, or latest for the most recent visible image.
 * @param session Current tool Session and its cached message projection.
 * @param attachments Host image store; called only after membership validation.
 * @param images Task service enforcing the same Session ownership for generated originals.
 * @param maxBytes Current deployment bound applied before and after reading.
 * @param signal Tool-call cancellation.
 * @returns Bounded image bytes; generated assets use their preserved originals.
 */
export async function resolveSessionImage(reference: string, session: { id: string; deriveMessages(): Message[] },
  attachments: Pick<AttachmentStore, 'readImage'>,
  images: Pick<ImagesFacade, 'readAsset'> & { list(owner: ImageOwner): Promise<readonly Pick<ImageTask, 'id' | 'assets'>[]> },
  maxBytes: number, signal: AbortSignal): Promise<ImageBytes> {
  signal.throwIfAborted()
  const owner: ImageOwner = { kind: 'session', sessionId: session.id }
  const tasks = await images.list(owner)
  if (reference !== 'latest') {
    for (const task of tasks) for (const asset of task.assets) {
      if (asset.original.attachmentId === reference || asset.preview.attachmentId === reference) {
        if (asset.original.bytes > maxBytes) throw tooLarge()
        return bounded(await images.readAsset(task.id, asset.id, owner, signal), maxBytes)
      }
    }
  }
  // 使用现有消息投影；不能由模型提供的任意 attachmentId 直接读取全局附件仓库。
  for (const message of session.deriveMessages().reverse()) for (const block of [...message.content].reverse()) {
    if (block.type !== 'image' || block.offloaded === true || reference !== 'latest' && block.attachment.attachmentId !== reference) continue
    for (const task of tasks) for (const asset of task.assets) if (asset.preview.attachmentId === block.attachment.attachmentId) {
      if (asset.original.bytes > maxBytes) throw tooLarge()
      return bounded(await images.readAsset(task.id, asset.id, owner, signal), maxBytes)
    }
    if (block.attachment.bytes > maxBytes) throw tooLarge()
    const stored = await attachments.readImage(block.attachment, signal)
    return bounded({ data: stored.data, mimeType: block.attachment.mediaType }, maxBytes)
  }
  if (reference === 'latest') {
    const task = tasks.find(task => task.assets.length > 0), asset = task?.assets.at(-1)
    if (task !== undefined && asset !== undefined) {
      if (asset.original.bytes > maxBytes) throw tooLarge()
      return bounded(await images.readAsset(task.id, asset.id, owner, signal), maxBytes)
    }
  }
  throw new ImageServiceError('image-attachment-unavailable', 'The image is not referenced by this Session. Upload it here or use an attachment ID returned by this Session’s image tools.')
}

function bounded(image: ImageBytes, maxBytes: number): ImageBytes {
  if (image.data.byteLength > maxBytes) throw tooLarge()
  return image
}

function tooLarge(): ImageServiceError { return new ImageServiceError('image-too-large', 'The referenced image exceeds the configured byte limit.') }
