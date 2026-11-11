/** Deterministic remote responses for a two-original batch. The worker owns every transform, check and transfer. */
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { type ImageGenerationTask, type ImageGenerationTaskId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import LocalAttachmentStore from '../../../../../packages/attachment/attachment-local/src/index.ts'
import { wallpaperObservationPlanSchema } from '../../src/shared/wallpaper.ts'

export function serverReworkScenario(root: string) {
  const context = new Context(), llm = new LlmRuntime(context), attachments = new LocalAttachmentStore(context, { dshHome: root })
  const generations = new Map<string, ImageGenerationTask>()
  let target: string | undefined, reviews = 0
  llm.getImageGeneration = async handle => {
    const saved = generations.get(handle.id)
    if (!saved) throw Object.assign(new Error('No isolated generation exists'), { code: 'IMAGE_GENERATION_NOT_FOUND' })
    return saved
  }
  llm.startImageGeneration = async request => {
    assert.ok(request.id && request.references?.length && request.mask)
    assert.equal(generations.has(request.id), false)
    const bytes = await sharp({ create: { width: 1872, height: 3328, channels: 3, background: generations.size ? '#536f53' : '#1c3020' } }).png().toBuffer()
    const original = await attachments.saveFile({ data: bytes, name: 'isolated-background.png' })
    const [preview] = await attachments.saveImages([{ data: bytes, mediaType: 'image/png' }])
    const saved: ImageGenerationTask = { id: request.id, provider: request.provider, model: request.model, taskId: brandString<ImageGenerationTaskId>('server-rework-' + generations.size), state: 'succeeded', images: [{ original, preview: preview! }] }
    generations.set(request.id, saved)
    return saved
  }
  function reply(input: { operation: string; images: { role: string; imageVersionId: string }[]; usage?: unknown }, fallback: object): object {
    const source = input.images.find(image => image.role === 'wallpaper-original')!.imageVersionId
    target ??= source
    if (source !== target) return fallback
    if (input.operation === 'wallpaper-plan') {
      const plan = wallpaperObservationPlanSchema.parse(fallback)
      const detail = input.images.find(image => image.role === 'wallpaper-original-detail-only')
      plan.regions[0]!.rect = { x: 0.06, y: 0.2, width: 0.88, height: 0.65 }
      if (detail) {
        const { truncations: backgroundTruncations, ...observation } = plan
        const { concerns } = z.object({ concerns: z.array(z.object({ id: z.string() })) }).parse(input.usage)
        return { version: 'wallpaper-plan-detail-v3', imageVersionId: source, protectedSubjectExtent: { extent: 'complete', reason: 'The whole vehicle is visible.', evidenceImageVersionIds: [source, detail.imageVersionId] }, backgroundTruncations,
          findings: concerns.map(concern => ({ concernId: concern.id, result: 'resolved', reason: 'The native view identifies the intact outline.', evidenceImageVersionIds: [detail.imageVersionId] })), observation }
      }
      if (!reviews) plan.uncertainties = ['Inspect the visible outline at native resolution.']
      else {
        assert.ok(input.images.some(image => image.role === 'rejected-wallpaper'))
        plan.editPrompt = 'Correct the dark seam from the rejected version by matching the original muted green boundary. Keep the subject unchanged.'
      }
      return plan
    }
    assert.equal(input.operation, 'wallpaper-review')
    if (++reviews > 1) return fallback
    const { checks } = z.object({ checks: z.record(z.string(), z.unknown()) }).parse(fallback)
    return { ...fallback, checks: { ...checks, background: { result: 'violated', reason: 'The generated background has a dark seam.' } }, issues: [{ kind: 'background', reason: 'Match the source color at the transition.' }] }
  }
  return { llm, attachments, reply, target: () => target, reviews: () => reviews, generations, close: () => context.fiber.dispose() }
}
