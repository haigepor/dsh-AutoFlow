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
  ctx.effect(() => () => service.dispose(), 'Style Prompt task and storage drain')
  await service.initialize()

  async function invoke(raw: unknown, signal: AbortSignal) {
    try { return { ok: true as const, value: await service.action(actionSchema.parse(raw), signal) } }
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
}
