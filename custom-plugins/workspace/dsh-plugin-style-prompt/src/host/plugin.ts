/** Independent DSH bundle; native profile services own authentication, attachments and model connections. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import type {} from '@deepseek-ai/dsh-client-connection'
import { join } from 'node:path'
import { z } from 'zod'
import { actionSchema, taskIdSchema, referenceIdSchema, StylePromptError, failureOf } from '../shared/model.ts'
import { Config } from './config.ts'
import { openRepository } from './repository.ts'
import { StylePromptService } from './service.ts'
import { CanvasService } from './canvas-service.ts'
import { openCanvasRepository } from './canvas-repository.ts'
import { canvasActionSchema, assetId, runId, nodeId } from '../shared/canvas.ts'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { nativeRef } from './native-model.ts'

export { Config }
export const name = 'dsh-plugin-style-prompt'
export const inject = ['profileContext', 'storageDomain', 'attachments', 'llm', 'pluginManager', 'connection']

/** Mount bounded authenticated workbench routes and release every task on unload.
 * @param ctx Active profile's Cordis context. @param input Deployment limits, validated before storage admission.
 * @returns Completion after persistent recovery and registration.
 */
export async function apply(ctx: Context, input: z.input<typeof Config>): Promise<void> {
  const config = Config.parse(input)
  const repository = await openRepository(ctx.storageDomain, ctx.profileContext.dir, join(ctx.profileContext.dir, 'style-prompt', 'writer.lock'))
  const service = new StylePromptService(repository, { llm: ctx.llm, attachments: ctx.attachments }, config, () => ctx.logger.error('Style Prompt cannot commit task state; new work is stopped. Inspect profile storage before restarting.'))
  const canvasRepository = await openCanvasRepository(ctx.storageDomain, ctx.profileContext.dir).catch(async error => { await service.dispose(); throw error })
  const canvas = new CanvasService(canvasRepository, service, repository, { llm: ctx.llm, attachments: ctx.attachments }, config, () => ctx.logger.error('Style Prompt cannot persist canvas state; new runs are stopped.'))
  ctx.effect(() => async () => { try { await canvas.dispose() } finally { await service.dispose() } }, 'Style Prompt task and storage drain')
  await service.initialize()
  await canvas.initialize()

  async function invoke(raw: unknown, signal: AbortSignal) {
    try {
      const graphAction = canvasActionSchema.safeParse(raw)
      if (graphAction.success) return { ok: true as const, value: await canvas.action(graphAction.data, signal) }
      const action = actionSchema.parse(raw)
      if (action.operation === 'delete' && canvas.referencesTask(action.id)) throw new StylePromptError('operation-conflict')
      return { ok: true as const, value: await service.action(action, signal) }
    }
    catch (error) { return { ok: false as const, error: error instanceof z.ZodError ? { code: 'invalid-input' as const } : failureOf(error) } }
  }

  ctx.effect(() => ctx.pluginManager.registerAction(name, 'workbench', async (fields, signal) => {
    const text = fields.input ?? '{}'
    if (Buffer.byteLength(text) > config.maxRequestBytes) return JSON.stringify({ ok: false, error: { code: 'invalid-input' } })
    try { return JSON.stringify(await invoke(JSON.parse(text), signal)) }
    catch (error) { return JSON.stringify({ ok: false, error: { code: 'invalid-input' } }) }
  }), 'Style Prompt owner actions')

  // 原生 connection.fetch 统一鉴权；数据路由避免插件动作的短文本响应上限。
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/style-prompt/data', methods: ['POST'], requestBody: 'buffered', fetch: async request => {
    try {
      const reader = request.body?.getReader()
      if (!reader) throw new StylePromptError('invalid-input')
      const chunks: Uint8Array[] = []; let bytes = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > config.maxRequestBytes) { await reader.cancel(); throw new StylePromptError('invalid-input') }
          chunks.push(chunk.value)
        }
      } finally { reader.releaseLock() }
      const result = await invoke(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), request.signal)
      return Response.json(result, { status: result.ok ? 200 : 400, headers: { 'cache-control': 'no-store' } })
    } catch (error) { return Response.json({ ok: false, error: { code: 'invalid-input' } }, { status: 400, headers: { 'cache-control': 'no-store' } }) }
  } }), 'Style Prompt private data')
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/style-prompt/image', methods: ['GET'], requestBody: 'buffered', fetch: async request => {
    try {
      const url = new URL(request.url), id = taskIdSchema.parse(url.searchParams.get('id'))
      const image = await service.image(id, referenceIdSchema.parse(url.searchParams.get('reference')), request.signal)
      return new Response(new Uint8Array(image.data), { headers: { 'content-type': image.ref.mediaType, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } })
    } catch (error) { return new Response(null, { status: 404 }) }
  } }), 'Style Prompt private reference images')
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/style-prompt/canvas-image', methods: ['GET'], requestBody: 'buffered', fetch: async request => {
    try {
      const params = new URL(request.url).searchParams, asset = params.get('asset')
      if (asset) {
        const image = await canvas.image(assetId.parse(asset), request.signal)
        return new Response(new Uint8Array(image.data), { headers: { 'content-type': image.ref.mediaType, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } })
      }
      const run = canvasRepository.run(runId.parse(params.get('run'))), node = run?.nodes.find(node => node.nodeId === nodeId.parse(params.get('node')))
      const index = Number(params.get('index') ?? 0), reference = Number.isSafeInteger(index) && index >= 0 ? node?.images[index] : undefined
      if (!reference) throw new StylePromptError('missing-record')
      if (params.get('original') === '1') {
        const original = node?.originals[index]
        if (!original) throw new StylePromptError('missing-record')
        const iterator = ctx.attachments.readFileStream({ ...original, attachmentId: AttachmentId(original.attachmentId) }, request.signal)[Symbol.asyncIterator]()
        const stream = new ReadableStream<Uint8Array>({ async pull(controller) { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value) }, async cancel() { await iterator.return?.() } })
        return new Response(stream, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(original.name)}`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } })
      }
      const image = await ctx.attachments.readImage(nativeRef(reference), request.signal)
      return new Response(new Uint8Array(image.data), { headers: { 'content-type': image.ref.mediaType, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } })
    } catch (error) { return new Response(null, { status: 404 }) }
  } }), 'Style Prompt private canvas images')
}
