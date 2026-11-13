/** Expose the existing account-backed image service through the public LLM image API. */
import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { LlmError, type ImageGenerationProvider, type ImageGenerationSource, type ImageGenerationRequest, type ImageGenerationHandle, type ImageGenerationTask, type ImageGenerationTaskId } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ImagesFacade, ImageTask } from './types.ts'

/**
 * @param images Initialized image service.
 * @param attachments Profile attachment reader.
 * @param listModels Current explicit image catalog.
 * @param waitMs Current configured image deadline used for bounded result waits.
 * @returns Lifecycle-owned LLM provider.
 */
export function imageLlmProvider(images: ImagesFacade, attachments: Pick<AttachmentStore, 'readImage'> & Partial<Pick<AttachmentStore, 'readFileStream'>>, listModels: ImageGenerationProvider['listModels'], waitMs: () => number, listSources?: () => Promise<readonly ImageGenerationSource[]>): ImageGenerationProvider {
  const owner = (id: string) => ({ kind: 'gateway' as const, keyId: `llm-operation:${id}` })
  const project = (handle: Omit<ImageGenerationHandle, 'taskId'>, task: ImageTask): ImageGenerationTask => ({ ...handle, taskId: brandString<ImageGenerationTaskId>(task.id), state: task.state,
    images: task.assets.map(asset => ({ original: asset.original, preview: asset.preview })), ...(task.error ? { error: { code: task.error.code, message: task.error.message } } : {}) })
  const start = async (request: ImageGenerationRequest): Promise<ImageGenerationTask> => {
    if (request.sourceId && (!listSources || !(await listSources()).some(source => source.id === request.sourceId && source.available))) throw new LlmError('The selected Codex account is unavailable', 'UNSUPPORTED_OPTION')
    const references = await Promise.all(request.references.map(reference => attachments.readImage(reference, request.signal)))
    const referenceImages = references.map(image => `data:${image.ref.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
    let mask: string | undefined
    if (request.mask) {
      if (!attachments.readFileStream) throw new LlmError('Verbatim mask attachments are unavailable', 'UNSUPPORTED_OPTION')
      const chunks: Uint8Array[] = []; let length = 0
      for await (const chunk of attachments.readFileStream(request.mask, request.signal)) { length += chunk.byteLength; if (length > request.mask.bytes) throw new LlmError('The mask attachment length is invalid', 'UNSUPPORTED_OPTION'); chunks.push(chunk) }
      const first = references[0], bytes = Buffer.concat(chunks)
      if (!first || bytes.length !== request.mask.bytes || bytes.length < 26 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
        || bytes.readUInt32BE(16) !== first.ref.width || bytes.readUInt32BE(20) !== first.ref.height || ![4, 6].includes(bytes[25]!)) throw new LlmError('An edit mask must be an alpha-channel PNG matching the first reference dimensions', 'UNSUPPORTED_OPTION')
      mask = `data:image/png;base64,${bytes.toString('base64')}`
    }
    request.signal.throwIfAborted()
    const input = { model: request.model, prompt: request.prompt, size: request.size, quality: request.quality, n: 1, referenceImages, ...(mask ? { mask } : {}) }
    const digest = createHash('sha256').update(JSON.stringify({ ...input, sourceId: request.sourceId ?? null })).digest('hex')
    const task = await images.submit(input, owner(request.id), { id: request.id, digest }, request.signal, request.sourceId)
    return project({ id: request.id, provider: request.provider, model: request.model }, task)
  }
  const get: NonNullable<ImageGenerationProvider['get']> = async (handle, options) => {
    const taskId = handle.taskId ?? (await images.list(owner(handle.id))).find(task => task.operation?.id === handle.id)?.id
    if (!taskId) throw new LlmError('No image task was accepted for this operation', 'IMAGE_GENERATION_NOT_FOUND')
    const task = await images.getResult(taskId, owner(handle.id), options)
    if (task.model !== handle.model || task.operation?.id !== handle.id) throw new LlmError('The image receipt does not match this operation', 'UNSUPPORTED_OPTION')
    return project(handle, task)
  }
  return { listModels, ...(listSources ? { listSources } : {}), start, get, async cancel(handle) { const task = await get(handle); return project(handle, await images.cancel(task.taskId, owner(handle.id))) }, async generate(request) {
    const accepted = await start(request)
    try {
      let task = accepted
      while (task.state === 'queued' || task.state === 'sent') task = await get(accepted, { waitMs: waitMs(), signal: request.signal })
      if (task.state !== 'succeeded' || !task.images.length) throw new LlmError('Image generation did not produce a complete result', task.state === 'cancelled' ? 'ABORTED' : 'IMAGE_GENERATION_FAILED')
      return task.images
    } catch (error) {
      if (request.signal.aborted) await images.cancel(accepted.taskId, owner(request.id))
      throw error
    }
  } }
}
