/** Deterministic remote responses for a two-original batch. The worker owns every transform, check and transfer. */
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { type ImageGenerationTask, type ImageGenerationTaskId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import LocalAttachmentStore from '../../../../../packages/attachment/attachment-local/src/index.ts'

export function serverReworkScenario(root: string) {
  const context = new Context(), llm = new LlmRuntime(context), attachments = new LocalAttachmentStore(context, { dshHome: root })
  const generations = new Map<string, ImageGenerationTask>()
  llm.getImageGeneration = async handle => {
    const saved = generations.get(handle.id)
    if (!saved) throw Object.assign(new Error('No isolated generation exists'), { code: 'IMAGE_GENERATION_NOT_FOUND' })
    return saved
  }
  llm.startImageGeneration = async request => {
    assert.equal(request.references?.length, 1)
    assert.equal(request.mask, undefined)
    assert.ok(request.id)
    assert.equal(generations.has(request.id), false)
    const bytes = await sharp({ create: { width: 1845, height: 3280, channels: 3, background: generations.size ? '#536f53' : '#1c3020' } }).png().toBuffer()
    const original = await attachments.saveFile({ data: bytes, name: 'isolated-background.png' })
    const [preview] = await attachments.saveImages([{ data: bytes, mediaType: 'image/png' }])
    const saved: ImageGenerationTask = { id: request.id, provider: request.provider, model: request.model, taskId: brandString<ImageGenerationTaskId>('server-rework-' + generations.size), state: 'succeeded', images: [{ original, preview: preview! }] }
    generations.set(request.id, saved)
    return saved
  }
  return { llm, attachments, generations, close: () => context.fiber.dispose() }
}
