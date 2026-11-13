import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk, type ImageGenerationId, type ImageGenerationRequest, type ImageGenerationProvider } from '@deepseek-ai/dsh-llm'

class TextAdapter extends LlmAdapter {
  async *stream(_options: GenerateOptions): AsyncGenerator<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}

const request = (): ImageGenerationRequest => ({ id: brandString<ImageGenerationId>('aux-image'), provider: 'image-route', model: 'image-model', prompt: 'A blue cup', references: [], size: '1024x1024', quality: 'auto', signal: new AbortController().signal })

describe('auxiliary image generation', () => {
  it('accepts an image-only provider and exposes selectable source labels', async () => {
    const ctx = new Context(), llm = new LlmRuntime(ctx)
    const provider: ImageGenerationProvider = { listModels: async () => [{ id: 'image-model', name: 'Images' }], listSources: async () => [{ id: 'account-a', name: 'Account A', available: true }], generate: async (request) => { expect(request.sourceId).toBe('account-a'); return [] } }
    const dispose = llm.registerImageProvider('image-route', provider)
    try {
      expect(await llm.listImageModels('image-route')).toHaveLength(1)
      expect(await llm.listImageSources('image-route')).toEqual([{ id: 'account-a', name: 'Account A', available: true }])
      await llm.generateImages({ ...request(), sourceId: 'account-a' })
    } finally { dispose(); await ctx.fiber.dispose() }
  })
  it('publishes models only after registration and removes the provider with its effect', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const row = ctx.plugin((scope) => {
      scope.effect(() => ctx.llm.registerAdapter(['image-route'], new TextAdapter()), 'text adapter')
      scope.effect(() => ctx.llm.registerImageProvider('image-route', { listModels: async () => [{ id: 'image-model', name: 'Images' }], generate: async () => [] }), 'image provider')
    })
    await row
    try {
      expect(await ctx.llm.listImageModels('image-route')).toEqual([{ id: 'image-model', name: 'Images' }])
      await row.dispose()
      await expect(ctx.llm.listImageModels('image-route')).rejects.toMatchObject({ code: 'NO_ADAPTER' })
      const remove = ctx.llm.registerAdapter(['image-route'], new TextAdapter())
      expect(await ctx.llm.listImageModels('image-route')).toEqual([])
      remove()
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects text-only routes, unknown image models and aborted calls before dispatch', async () => {
    const ctx = new Context(), llm = new LlmRuntime(ctx)
    const remove = llm.registerAdapter(['image-route'], new TextAdapter())
    let calls = 0
    const provider: ImageGenerationProvider = { listModels: async () => [{ id: 'image-model', name: 'Images' }], generate: async () => { calls++; return [] } }
    try {
      await expect(llm.generateImages(request())).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
      const dispose = llm.registerImageProvider('image-route', provider)
      expect(() => llm.registerImageProvider('image-route', provider)).toThrow('already registered')
      await expect(llm.generateImages({ ...request(), model: 'text-model' })).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
      await expect(llm.generateImages({ ...request(), signal: AbortSignal.abort() })).rejects.toBeDefined()
      expect(calls).toBe(0)
      await llm.generateImages(request()); expect(calls).toBe(1)
      dispose()
    } finally { remove(); await ctx.fiber.dispose() }
  })

  it('does not dispatch a previous adapter owner after a provider route is reassigned', async () => {
    const ctx = new Context(), llm = new LlmRuntime(ctx)
    const first = llm.registerAdapter(['image-route'], new TextAdapter())
    let calls = 0
    const dispose = llm.registerImageProvider('image-route', { listModels: async () => [{ id: 'image-model', name: 'Images' }], generate: async () => { calls++; return [] } })
    first(); const second = llm.registerAdapter(['image-route'], new TextAdapter())
    try { expect(await llm.listImageModels('image-route')).toEqual([]); await expect(llm.generateImages(request())).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' }); expect(calls).toBe(0) }
    finally { dispose(); second(); await ctx.fiber.dispose() }
  })

  it('does not dispatch after the image provider is disposed while its catalog is loading', async () => {
    const ctx = new Context(), llm = new LlmRuntime(ctx)
    const remove = llm.registerAdapter(['image-route'], new TextAdapter())
    let release!: () => void, calls = 0
    const pending = new Promise<void>((resolve) => { release = resolve })
    const dispose = llm.registerImageProvider('image-route', { listModels: async () => { await pending; return [{ id: 'image-model', name: 'Images' }] }, generate: async () => { calls++; return [] } })
    try {
      const work = llm.generateImages(request())
      dispose(); release()
      await expect(work).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
      expect(calls).toBe(0)
    } finally { release(); dispose(); remove(); await ctx.fiber.dispose() }
  })
})
