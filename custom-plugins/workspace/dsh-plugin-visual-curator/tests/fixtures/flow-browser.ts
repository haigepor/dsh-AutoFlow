/** Full isolated Host flow; only Unsplash and vision transports return controlled fixtures. */
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout } from 'node:timers/promises'
import sharp from 'sharp'
import { z } from 'zod'
import { CuratorService } from '../../src/host/service.ts'
import { mountCurator } from '../../src/host/plugin.ts'
import { Config } from '../../src/host/config.ts'
import { CompatibleVisionProvider } from '../../src/media/vision.ts'
import { UnsplashApi, UnsplashSourceProvider } from '../../src/media/unsplash.ts'
import { FixtureHttp } from '../helpers/service-fixture.ts'
import { jsonSchema } from '../../src/shared/model.ts'
import type { HttpClient } from '../../src/media/network.ts'

export { Config }
export const name = 'visual-curator-flow-browser'
export const inject = ['profileContext', 'storageDomain', 'credentials', 'jobs', 'pluginManager', 'configEditor', 'sessions', 'connection']
const preview = 'https://images.unsplash.com/photo-1470770841072-f978cf4d019e?w=320'
const photo = (id: string) => ({ id, width: 400, height: 200, alt_description: `Fixture ${id}`, urls: { small: preview, regular: `https://images.unsplash.com/${id}` }, user: { username: 'fixture', name: 'Fixture' } })

/** @param ctx Private test profile with ordinary storage, jobs, routes and UI. @param input Production configuration. */
export async function apply(ctx: Context, input: unknown = {}): Promise<void> {
  const read = () => {
    const { vision, ...rest } = z.object({ vision: z.unknown().optional() }).passthrough().parse(input)
    return { ...rest, vision: vision && typeof vision === 'object' && 'get' in vision && typeof vision.get === 'function' ? vision.get() : vision }
  }
  let permits = -1, analysisPermits = -1, finalReviews = 0
  const requests: { path: string; query?: string; operation?: string; stage?: string; imageIds?: string[] }[] = []
  const api = new UnsplashApi({ request: async (path, params, bounds) => {
    bounds.signal?.throwIfAborted()
    requests.push({ path, ...(typeof params.query === 'string' ? { query: params.query } : {}) })
    if (path === '/me') return { id: 'fixture-user', username: 'fixture-user', name: 'Fixture account', total_collections: 1 }
    if (path.startsWith('/users/')) return [{ id: 'flow-folder', title: 'Flow references', total_photos: 3, cover_photo: { urls: { small: preview } } }]
    if (path.startsWith('/collections/')) return { results: ['reference-a', 'reference-b', 'reference-c'].map(photo), total: 3 }
    if (path.startsWith('/search/')) return { results: (Number(params.page) === 1 ? ['low', 'high'] : []).map(photo), total: 2, total_pages: 1 }
    return photo(path.split('/').at(-1)!)
  } })
  const base = new FixtureHttp()
  const images = new Map<string, Buffer>()
  for (const [name, color] of [['low', '#536f53'], ['high', '#234799']] as const) images.set(name, await sharp({ create: { width: 400, height: 200, channels: 3, background: color } }).png().toBuffer())
  base.image = images.get('low')!
  let service: CuratorService
  const http: HttpClient = { async request(url, request) {
    if (!url.startsWith('https://vision.example.test')) return { status: 200, headers: { 'content-type': 'image/png' }, bytes: images.get(url.split('/').at(-1)!) ?? base.image }
    const body = JSON.parse(Buffer.from(request.body!).toString('utf8'))
    const prompt = JSON.parse(body.messages[1].content[0].text).input
    requests.push({ path: 'vision', operation: prompt.operation, ...(prompt.stage ? { stage: prompt.stage } : {}), imageIds: prompt.images.map((image: { imageVersionId: string }) => image.imageVersionId) })
    const raw: Buffer[] = []
    const emit = (value: unknown) => { const bytes = Buffer.from(`data: ${JSON.stringify(value)}\n\n`); raw.push(bytes); request.onChunk?.(bytes, 'text/event-stream') }
    emit({ choices: [{ delta: { reasoning_content: '正在读取本批参考，检查色彩与光线。' } }] })
    const analysis = prompt.operation === 'analyze' || prompt.operation === 'summarize'
    // 独立放行分析和搜索，复验另一素材集仍分析时的结果刷新与分页。
    while ((analysis ? analysisPermits : permits) === 0) await setTimeout(100, undefined, { signal: request.signal })
    if (analysis && analysisPermits > 0) analysisPermits--
    else if (!analysis && permits > 0) permits--
    const response = await base.request(url, request)
    const output = JSON.parse(JSON.parse(response.bytes.toString('utf8')).choices[0].message.content)
    if (prompt.operation === 'review' && prompt.stage === 'final') {
      const score = finalReviews++ % 2 === 0 ? 0.1 : 0.9
      output.preferenceScores = output.preferenceScores.map((row: { dimension: string; score: number }) => ({ ...row, score }))
    }
    const content = JSON.stringify(output), split = Math.floor(content.length / 2)
    emit({ choices: [{ delta: { content: content.slice(0, split) } }] })
    await setTimeout(80, undefined, { signal: request.signal })
    emit({ choices: [{ delta: { content: content.slice(split) }, finish_reason: 'stop' }] })
    const done = Buffer.from('data: [DONE]\n\n'); raw.push(done); request.onChunk?.(done, 'text/event-stream')
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, bytes: Buffer.concat(raw) }
  } }
  service = new CuratorService(ctx, read(), { galleryApi: async () => api, galleryMedia: http, providers: {
    source: async () => new UnsplashSourceProvider(api), media: () => http,
    vision: async config => new CompatibleVisionProvider({ endpoint: config.vision.endpoint, model: config.vision.model, supportsMultiImage: true, supportsStreaming: true, maxImages: config.limits.maxReferenceImages + 2, maxImageBytes: config.limits.maxReferenceBytes, maxRequestBytes: config.limits.maxVisionRequestBytes, maxOutputTokens: config.limits.maxVisionOutputTokens, temperature: 0, ...(config.vision.reasoningEffort ? { reasoningEffort: config.vision.reasoningEffort } : {}) }, http),
  } })
  ctx.on('loader/volatile-update', () => service.updateConfiguration(read()))
  await mountCurator(ctx, service)
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/visual-curator/test-control', methods: ['POST'], requestBody: 'buffered', fetch: async request => {
    const body = z.object({ permits: z.number().int().min(-1).optional(), analysisPermits: z.number().int().min(-1).optional(), operation: z.string().optional(), args: z.record(z.string(), jsonSchema).default({}) }).parse(await request.json())
    if (body.permits !== undefined) permits = body.permits
    if (body.analysisPermits !== undefined) analysisPermits = body.analysisPermits
    const value = body.operation ? await service.action({ operation: body.operation, args: body.args }, { kind: 'human', id: 'fixture', profileId: service.profileId }, request.signal) : undefined
    return Response.json({ permits, analysisPermits, requests, ...(value !== undefined ? { value } : {}) })
  } }), 'Isolated full-flow controls')
}
