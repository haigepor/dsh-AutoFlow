/** Article image planning bundle: Host state and authenticated workbench operations. */
import { Config, resolveConfig } from './config-schema.js'
import { ArticleWorkflowService as ArticleService } from './src/host/workflow-service.js'
import { errorCode, failure, PACKAGE } from './src/shared/contracts.js'
export { Config }
export const name = PACKAGE
export const inject = ['profileContext', 'pluginManager', 'jobs', 'web']

/** Mount the profile service; unloading aborts and drains its tasks. @param {object} ctx Cordis context. @param {object} input Deployment fields. @returns {void} Effects own registrations. */
export function apply(ctx, input = {}) {
  const service = new ArticleService(ctx, resolveConfig(input))
  ctx.provide('articleImage', service)
  ctx.effect(() => () => service.dispose(), 'Article image task drain')
  ctx.effect(() => ctx.jobs.attachController('article-image'), 'Article image profile jobs')
  ctx.effect(() => ctx.pluginManager.registerAction(PACKAGE, 'workbench', async (input, signal) => {
    try {
      if (typeof input.operation !== 'string' || typeof input.args !== 'string' || Buffer.byteLength(input.args) > service.config.maxWireBytes) throw failure('invalid-request')
      const result = await service.action(input.operation, JSON.parse(input.args), signal)
      // 大正文走有界只读 HTTP；Remote 写操作仅返回保存后的标识及版本。
      const value = result?.id ? { id: result.id, revision: result.revision, state: result.state } : result?.rejected
        ? { ...result, rejectedCount: result.rejected.length, rejected: result.rejected.slice(0, 20) } : result
      return JSON.stringify(value)
    } catch (error) { throw new Error(errorCode(error)) }
  }), 'Article image workbench actions')
  ctx.inject(['connection'], route => route.effect(() => route.connection.fetch.register({
    path: '/api/article-image/data', methods: ['POST'], requestBody: 'streaming', fetch: request => service.dataResponse(request),
  }), 'Article image workbench data'))
  ctx.inject(['connection'], route => route.effect(() => route.connection.fetch.register({
    path: '/api/article-image/asset', methods: ['GET'], requestBody: 'buffered', fetch: request => {
      const url = new URL(request.url)
      return service.assetResponse(request, url.searchParams.get('snapshot'), url.searchParams.get('asset'))
    },
  }), 'Article image local originals'))
}
