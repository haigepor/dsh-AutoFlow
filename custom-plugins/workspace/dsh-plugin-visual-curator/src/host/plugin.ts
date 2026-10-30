/** Independent profile provider; all registrations and in-flight work leave with its Cordis fiber. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { CuratorService } from './service.ts'
import { Config } from './config.ts'
import type { ClientActionInput } from '../client/contract.ts'
import { CuratorError } from '../shared/errors.ts'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import type {} from '@deepseek-ai/dsh-client-connection'

export { Config }
export const name = 'dsh-plugin-visual-curator'
export const inject = ['profileContext', 'storageDomain', 'credentials', 'jobs', 'pluginManager', 'configEditor', 'sessions', 'llm', 'attachments', 'tokenMeter']

declare module '@deepseek-ai/cordis' {
  interface Context { visualCurator: CuratorService }
}

/** Convert expected failures into safe fields without copying upstream messages.
 * @param error Operation rejection.
 * @returns JSON-safe failure fields for authenticated Client and Agent callers.
 */
export function safeFailure(error: unknown) {
  // The optional tools row and provider are separate ESM bundles, so class identity is not shared.
  if (error instanceof Error && 'code' in error && typeof error.code === 'string' && 'stage' in error && typeof error.stage === 'string'
    && 'safeMessage' in error && typeof error.safeMessage === 'string' && 'suggestedAction' in error && typeof error.suggestedAction === 'string') {
    return { code: error.code, stage: error.stage, retryable: 'retryable' in error && error.retryable === true,
      safeMessage: error.safeMessage, suggestedAction: error.suggestedAction,
      ...('attemptId' in error && typeof error.attemptId === 'string' ? { attemptId: error.attemptId } : {}) }
  }
  return { code: 'operation-failed', stage: 'host', retryable: false, safeMessage: 'The operation could not be completed.', suggestedAction: 'Inspect saved state and retry with current records.' }
}

/** Mount the provider and authenticated private resources; no built-in profile is changed.
 * @param ctx Profile-launched Cordis context.
 * @param input Deployment configuration, validated by the shared service.
 * @returns Settles after the durable repository and registrations are available.
 */
export async function apply(ctx: Context, input: unknown = {}): Promise<void> {
  const { compaction } = z.object({ compaction: z.record(z.string(), z.unknown()).optional() }).parse(input)
  const scope = await nativeContextScope(ctx, compaction)
  const read = () => {
    const { vision, compaction: _compaction, ...rest } = z.object({ vision: z.unknown().optional(), compaction: z.unknown().optional() }).passthrough().parse(input)
    return { ...rest, vision: vision && typeof vision === 'object' && 'get' in vision && typeof vision.get === 'function' ? vision.get() : vision }
  }
  const service = new CuratorService(scope, read())
  ctx.on('loader/volatile-update', () => service.updateConfiguration(read()))
  await mountCurator(scope, service)
  ctx.inject(['sessionController', 'workspaceRegistry', 'fileUploads', 'sessionTitle', 'tools'], () => service.restoreSearchLaunches())
}

/**
 * Reuse a profile backend or mount native input-only compaction in this plugin's private scope.
 * @param ctx Owner fiber with native LLM, token meter and Session storage.
 * @param config Optional native Basic policy; specifying it selects a private backend.
 * @returns Context whose compaction service is available until its owner fiber is disposed.
 */
export async function nativeContextScope(ctx: Context, config?: BasicCompactionConfig): Promise<Context> {
  if (config === undefined && ctx.get('compaction')) return ctx
  const scope = ctx.isolate('compaction')
  // 工作台没有 Agent turn；该实例仅供任务输入压缩，不能注册自动会话压缩监听。
  await scope.plugin(BasicCompactionEngine, { ...config, auto: false })
  if (!scope.get('compaction')) throw new CuratorError('capability-unavailable', 'context-compaction', 'The native input compaction backend did not load.')
  return scope
}

/** Mount an existing provider through the production registration path.
 * @param ctx Owner fiber for registrations and task drain.
 * @param service Uninitialized provider; test fixtures may inject its external HTTP adapters.
 * @returns Settles when storage and all profile entry points are ready.
 */
export async function mountCurator(ctx: Context, service: CuratorService): Promise<void> {
  // 初始化可能立即恢复任务，必须先注册可控制这些任务的能力。
  ctx.effect(() => ctx.jobs.attachController('visual-curator'), 'Visual Curator profile jobs')
  ctx.effect(() => () => service.dispose(), 'Visual Curator task drain')
  await service.initialize()
  ctx.provide('visualCurator', service)
  ctx.effect(() => ctx.pluginManager.registerAction(name, 'workbench', async (input, signal) => {
    try {
      if (Object.keys(input).some(key => key !== 'operation' && key !== 'args') || !input.operation || !input.args) {
        throw new CuratorError('invalid-input', 'action', 'The action envelope is incomplete.')
      }
      const args: ClientActionInput['args'] = JSON.parse(input.args)
      // Only the authenticated owner Remote reaches this registration; caller JSON cannot supply authorship.
      const result = await service.action({ operation: input.operation, args }, { kind: 'human', id: 'profile-owner', profileId: service.profileId }, signal)
      return JSON.stringify({ ok: true, value: result })
    } catch (error) {
      signal.throwIfAborted()
      return JSON.stringify({ ok: false, error: safeFailure(error) })
    }
  }), 'Visual Curator workbench actions')
  ctx.inject(['connection'], route => route.effect(() => route.connection.fetch.register({
    path: '/api/visual-curator/resource', methods: ['GET', 'HEAD'], requestBody: 'buffered', fetch: request => service.resource(request),
  }), 'Visual Curator private media and exports'))
  ctx.inject(['connection'], route => route.effect(() => route.connection.fetch.register({
    path: '/api/visual-curator/data', methods: ['POST'], requestBody: 'buffered', fetch: request => service.data(request),
  }), 'Visual Curator paginated workspace data'))
  ctx.inject(['connection'], route => route.effect(() => route.connection.fetch.register({
    path: '/api/visual-curator/analysis-stream', methods: ['POST'], requestBody: 'buffered', fetch: request => service.followAnalysis(request),
  }), 'Visual Curator live analysis output'))
  ctx.inject(['connection'], route => route.effect(() => route.connection.fetch.register({
    path: '/api/visual-curator/gallery', methods: ['POST'], requestBody: 'buffered', fetch: request => service.gallery(request),
  }), 'Visual Curator account galleries'))
  ctx.inject(['connection'], route => route.effect(() => route.connection.fetch.register({
    path: '/api/visual-curator/local-reference', methods: ['POST'], requestBody: 'buffered', fetch: request => service.localReferenceData(request),
  }), 'Visual Curator original-path references'))
}
