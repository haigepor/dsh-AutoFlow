/** Independent profile provider; all registrations and in-flight work leave with its Cordis fiber. */
import type { Context } from '@deepseek-ai/cordis'
import { CuratorService } from './service.ts'
import { Config } from './config.ts'
import type { ClientActionInput } from '../client/contract.ts'
import { CuratorError } from '../shared/errors.ts'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import type {} from '@deepseek-ai/dsh-client-connection'

export { Config }
export const name = 'dsh-plugin-visual-curator'
export const inject = ['profileContext', 'storageDomain', 'credentials', 'jobs', 'pluginManager', 'configEditor', 'sessions']

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
  const service = new CuratorService(ctx, input)
  await mountCurator(ctx, service)
}

/** Mount an existing provider through the production registration path.
 * @param ctx Owner fiber for registrations and task drain.
 * @param service Uninitialized provider; test fixtures may inject its external HTTP adapters.
 * @returns Settles when storage and all profile entry points are ready.
 */
export async function mountCurator(ctx: Context, service: CuratorService): Promise<void> {
  ctx.effect(() => () => service.dispose(), 'Visual Curator task drain')
  await service.initialize()
  ctx.provide('visualCurator', service)
  ctx.effect(() => ctx.jobs.attachController('visual-curator'), 'Visual Curator profile jobs')
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
}
