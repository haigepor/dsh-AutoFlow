/** Host-only Codex subscription bundle; all resources leave with this fiber. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-fs'
import { Config } from './config.ts'
import { CodexSubscriptionService, GATEWAY_KEY, safeCode } from './service.ts'
import { CodexPoolAdapter } from './llm/index.ts'
import { codexDiscoveryView } from './models.ts'

export { Config }
export const name = 'dsh-plugin-codex-subscription'
export const inject = ['profileContext', 'credentials', 'authorization', 'storageDomain', 'attachments', 'llm', 'pluginManager', 'settings']

declare module '@deepseek-ai/cordis' {
  interface Context { codexSubscription: CodexSubscriptionService }
}

/** Mount subscription accounts, model discovery, management and durable image work.
 * @param ctx Owner profile context.
 * @param config Loader-validated deployment fields and live options.
 * @returns Completion after all services are ready.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const settingsNs = ctx.fiber.entry?.options.id ?? 'codex-subscription'
  const service = new CodexSubscriptionService(ctx, settingsNs, config, config.options.get())
  ctx.effect(() => () => service.dispose(), 'Codex subscription shutdown')
  await service.initialize()
  ctx.provide('codexSubscription', service)
  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber), 'Codex subscription configuration')
  ctx.on('loader/volatile-update', () => service.reconfigure(config.options.get()).catch(() => {
    ctx.logger.warn('Codex subscription could not start the requested listener; inspect its configuration and management status.')
  }))
  ctx.on('credentials/record-updated', key => {
    if (key !== GATEWAY_KEY) return
    return service.refreshGateway().catch(() => {
      ctx.logger.warn('Codex gateway credential changed; its listener is stopped or needs configuration repair.')
    })
  })
  const adapter = new CodexPoolAdapter(service.accounts, { provider: 'autoflow-codex', displayName: 'ChatGPT / Codex',
    listModels: () => service.catalogModels(),
    baseUrl: 'https://chatgpt.com/backend-api/codex', streamIdleTimeoutMs: config.streamIdleTimeoutMs, timeoutMs: config.requestTimeoutMs,
    maxRequestImageBytes: config.maxRequestImageBytes, requestImagePixelBudget: config.requestImagePixelBudget, requestImageMaxBytes: config.requestImageMaxBytes,
    resolveAttachments: () => ctx.attachments,
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, path => ctx.get('fs')?.processPathFromHostPath(path), ref),
  })
  ctx.effect(() => ctx.llm.registerAdapter(['autoflow-codex'], adapter), 'Codex subscription model adapter')
  ctx.effect(() => ctx.llm.registerConfigurableProviders([{ provider: 'autoflow-codex', displayName: 'ChatGPT / Codex', settingsNs, settingsPath: [],
    nativeAuth: { env: [], oauth: true } }]), 'Codex subscription model directory')
  ctx.effect(() => ctx.llm.registerModelDiscovery(settingsNs, async (_request, signal) => {
    signal?.throwIfAborted()
    return (await service.catalogModels()).map(codexDiscoveryView)
  }), 'Codex subscription discovery')
  ctx.effect(() => ctx.pluginManager.registerAction(name, 'manage', async (input, signal) => {
    try {
      const value = await service.action({ operation: input.operation, args: JSON.parse(input.args ?? '{}') }, signal)
      return JSON.stringify({ ok: true, value })
    } catch (error) { return JSON.stringify({ ok: false, error: { code: safeCode(error) } }) }
  }), 'Codex subscription owner actions')
  ctx.inject(['connection'], scoped => {
    for (const route of [
      { path: '/api/codex-subscription/manage', methods: ['POST'] },
      { path: '/api/codex-subscription/media', methods: ['GET', 'HEAD'] },
    ] as const) scoped.effect(() => scoped.connection.fetch.register({ ...route, requestBody: 'buffered', fetch: request => service.handle(request) }), 'Codex subscription private route')
  })
}
