/** Keyless browser-only adapter loaded by a scratch dsh profile, never by the published package. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { observation, newInput } from '../fixture.ts'
import { compileQuick } from '../../src/shared/compose.ts'
import type {} from '@deepseek-ai/dsh-client-connection'

export const name = 'style-prompt-browser-model'
export const inject = ['llm', 'connection']
class BrowserAdapter extends LlmAdapter {
  constructor(private readonly mode: () => string) { super() }
  override async listModels(provider: string) { return [{ provider, id: 'style-vision-fixture', name: 'Style Prompt · Keyless fixture' }] }
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: 'Style Prompt · Keyless fixture', inputModalities: ['text', 'image'] as const } }
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    options.signal?.throwIfAborted()
    if (this.mode() === 'waiting') {
      await new Promise<void>(resolve => { if (options.signal?.aborted) resolve(); else options.signal?.addEventListener('abort', () => resolve(), { once: true }) })
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Fixture stopped' } } }; return
    }
    if (this.mode() === 'invalid') { yield { type: 'text-delta', index: 0, text: '{broken' }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
    const hasImage = options.messages.some(message => message.content.some(block => block.type === 'image'))
    const base = compileQuick(observation, newInput())
    const output = hasImage ? observation : { ...base, variants: [0, 1, 2].map(index => ({ title: { zh: `街角方案 ${index + 1}`, en: `Street corner ${index + 1}` }, prompt: { zh: `街角咖啡店，方案${index + 1}的空间布局，低饱和暖灰，纸张颗粒与松散边缘`, en: `A corner coffee shop with layout ${index + 1}, muted warm greys, paper grain and loose edges` }, changes: [{ zh: `重新组织空间布局 ${index + 1}`, en: `Reorganize spatial layout ${index + 1}` }] })) }
    yield { type: 'text-delta', index: 0, text: JSON.stringify(output) }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
/** @param ctx Isolated browser profile. @returns Registration lifetime owned by the fixture row. */
export function apply(ctx: Context): void {
  let mode = 'success'
  ctx.effect(() => ctx.llm.registerAdapter(['style-prompt-fixture'], new BrowserAdapter(() => mode)), 'Style Prompt keyless browser model')
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/style-prompt/test-control', methods: ['POST'], requestBody: 'buffered', fetch: async request => {
    const value: unknown = await request.json()
    if (value && typeof value === 'object' && 'mode' in value && typeof value.mode === 'string') mode = value.mode
    return Response.json({ mode })
  } }), 'Style Prompt synthetic response control')
}
