/** Isolated browser fixture: production lifecycle/storage/UI with a controlled upstream response. */
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout } from 'node:timers/promises'
import { z } from 'zod'
import { CuratorService } from '../../src/host/service.ts'
import { mountCurator } from '../../src/host/plugin.ts'
import { Config } from '../../src/host/config.ts'
import { CompatibleVisionProvider } from '../../src/media/vision.ts'
import { ProviderFactory } from '../../src/host/providers.ts'
import { UnsplashApi } from '../../src/media/unsplash.ts'
import type { HttpClient } from '../../src/media/network.ts'

export { Config }
export const name = 'visual-curator-analysis-browser'
export const inject = ['profileContext', 'storageDomain', 'credentials', 'jobs', 'pluginManager', 'configEditor', 'sessions', 'connection']

/** @param ctx Dedicated test profile. @param input Defaults persisted through the normal ConfigEditor. */
export async function apply(ctx: Context, input: unknown = {}): Promise<void> {
  const read = () => {
    const { vision, ...rest } = z.object({ vision: z.unknown().optional() }).passthrough().parse(input)
    return { ...rest, vision: vision && typeof vision === 'object' && 'get' in vision && typeof vision.get === 'function' ? vision.get() : vision }
  }
  let permits = 1
  const requests: { operation: string; requestId: string; reasoningEffort: string | null; imageIds: string[] }[] = []
  const http: HttpClient = { async request(_url, request) {
    const body = JSON.parse(Buffer.from(request.body!).toString('utf8'))
    const payload = JSON.parse(body.messages[1].content[0].text).input
    const imageIds = payload.images.map((image: { imageVersionId: string }) => image.imageVersionId)
    requests.push({ operation: payload.operation, requestId: payload.requestId, reasoningEffort: body.reasoning_effort ?? null, imageIds })
    const raw: Buffer[] = []
    const emit = (value: unknown) => { const bytes = Buffer.from(`data: ${JSON.stringify(value)}\n\n`); raw.push(bytes); request.onChunk?.(bytes, 'text/event-stream') }
    emit({ choices: [{ delta: { reasoning_content: '正在观察授权参考图片。' } }] })
    await setTimeout(300, undefined, { signal: request.signal })
    emit({ choices: [{ delta: { reasoning_content: '将逐图记录色彩与光线，再归纳风格。' } }] })
    while (permits === 0) await setTimeout(150, undefined, { signal: request.signal })
    if (permits > 0) permits--
    const rule = { statement: '保留柔和的自然光线', dimension: 'lighting', strength: 'preferred', stage: 'source', supportImageVersionIds: imageIds, counterImageVersionIds: [], condition: '', exceptions: [] }
    const output = payload.operation === 'summarize' ? { name: '自然光风格', summary: '自然光与清晰层次。', matchingPrompt: '检查候选图片的自然光线。', searchHints: ['soft natural light'], avoidTerms: [], dimensions: [{ dimension: 'lighting', description: '柔和自然光', consistency: 'consistent', supportImageVersionIds: imageIds, counterImageVersionIds: [] }], conflicts: [], suggestedRules: [rule], organization: { groups: [], selections: [{ ruleIndex: 0, enabled: true, groupId: null, reason: '参考图均有支持' }] } } : { observations: imageIds.map((imageVersionId: string) => ({ imageVersionId, dimensions: [{ dimension: 'lighting', observation: '柔和自然光，明暗层次清晰。', uncertain: false }] })), suggestedRules: [] }
    emit({ choices: [{ delta: { content: JSON.stringify(output) }, finish_reason: 'stop' }] })
    const done = Buffer.from('data: [DONE]\n\n'); raw.push(done); request.onChunk?.(done, 'text/event-stream')
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, bytes: Buffer.concat(raw) }
  } }
  const fallback = new ProviderFactory(ctx.credentials)
  const api = new UnsplashApi({ request: async () => { throw new Error('This fixture uses explicit local references only.') } })
  const service = new CuratorService(ctx, read(), { galleryApi: async () => api, providers: {
    source: config => fallback.source(config), media: config => fallback.media(config),
    vision: async config => new CompatibleVisionProvider({ endpoint: config.vision.endpoint, model: config.vision.model, supportsMultiImage: true, supportsStreaming: true, maxImages: config.limits.maxReferenceImages, maxImageBytes: config.limits.maxReferenceBytes, maxRequestBytes: config.limits.maxVisionRequestBytes, maxOutputTokens: config.limits.maxVisionOutputTokens, temperature: 0, ...(config.vision.reasoningEffort ? { reasoningEffort: config.vision.reasoningEffort } : {}) }, http),
  } })
  ctx.on('loader/volatile-update', () => service.updateConfiguration(read()))
  await mountCurator(ctx, service)
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/visual-curator/test-control', methods: ['POST'], requestBody: 'buffered', fetch: async request => {
    const input = z.object({ permits: z.number().int().min(-1).optional() }).parse(await request.json())
    if (input.permits !== undefined) permits = input.permits
    return Response.json({ permits, requests })
  } }), 'Synthetic upstream controls')
}
