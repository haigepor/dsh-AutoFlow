/** Expose the existing account-backed image service through the public LLM image API. */
import { LlmError, type ImageGenerationProvider } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ImagesFacade } from './types.ts'

/** @param images Initialized image service. @param attachments Profile attachment reader. @param listModels Current explicit image catalog. @param waitMs Current configured image deadline used for bounded result waits. @returns Lifecycle-owned LLM provider. */
export function imageLlmProvider(images: ImagesFacade, attachments: Pick<AttachmentStore, 'readImage'>, listModels: ImageGenerationProvider['listModels'], waitMs: () => number): ImageGenerationProvider {
  return { listModels, async generate(request) {
    // A private owner per auxiliary operation keeps these tasks out of public gateway keys and Sessions.
    const owner = { kind: 'gateway' as const, keyId: `llm-operation:${request.id}` }
    const referenceImages = await Promise.all(request.references.map(async reference => {
      const image = await attachments.readImage(reference, request.signal)
      return `data:${image.ref.mediaType};base64,${Buffer.from(image.data).toString('base64')}`
    }))
    request.signal.throwIfAborted()
    const accepted = await images.submit({ model: request.model, prompt: request.prompt, size: request.size, quality: request.quality, n: 1, referenceImages }, owner)
    try {
      let task = accepted
      while (task.state === 'queued' || task.state === 'sent') {
        task = await images.getResult(task.id, owner, { waitMs: waitMs(), signal: request.signal })
      }
      if (task.state !== 'succeeded' || !task.assets.length) throw new LlmError('Image generation did not produce an image', task.state === 'cancelled' ? 'ABORTED' : 'IMAGE_GENERATION_FAILED')
      return task.assets.map(asset => ({ original: asset.original, preview: asset.preview }))
    } catch (error) {
      if (request.signal.aborted) await images.cancel(accepted.id, owner)
      throw error
    }
  } }
}
