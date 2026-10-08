import { Config, resolveConfig } from './config-schema.js'
import { AfpService } from './src/host/afp-service.js'
import { configurationAction } from './src/host/afp-configuration.js'
import { downloadErrorCode } from './src/host/afp-downloads.js'
export { Config }
export const name = 'dsh-plugin-afp'
// Cordis 将 inject 对象的键作为服务名；此处使用服务名数组声明真实依赖。
export const inject = ['credentials', 'jobs', 'profileContext', 'pluginManager', 'configEditor', 'directoryPicker', 'sessions', 'sessionQuery']

/** Root owns shared profile state; optional rows own tools, skills and UI availability. */
export function apply(ctx, input = {}) {
  const service = new AfpService(ctx, resolveConfig(input))
  ctx.provide('afp', service)
  ctx.effect(() => () => service.dispose(), 'AFP task drain')
  ctx.effect(() => ctx.jobs.attachController(), 'AFP profile jobs')
  ctx.effect(() => ctx.pluginManager.registerAction(name, 'configuration', async (input, signal) => {
    try { return await configurationAction(ctx, input, service, signal) }
    catch (error) { throw new Error('AFP configuration rejected. Reopen the editor, check field values and profile permissions.') }
  }), 'AFP deployment configuration')
  ctx.effect(() => ctx.pluginManager.registerAction(name, 'workbench', async (input, signal) => {
    try { return JSON.stringify(await service.pageAction(input, signal)) }
    catch (error) {
      // 凭据与网络异常可能带 token 或 URL 参数，页面只接收脱敏错误。
      signal.throwIfAborted()
      const code = downloadErrorCode(error)
      if (code) throw new Error(code)
      throw new Error('AFP operation failed. Check setup and the saved report; remote writes may be partial.')
    }
  }), 'AFP workbench operation')
  ctx.inject(['connection'], routeCtx => routeCtx.effect(() => routeCtx.connection.fetch.register({
    path: '/api/afp/preview', methods: ['GET'], requestBody: 'buffered',
    fetch: request => service.previewResponse(request),
  }), 'AFP workbench photo preview route'))
  ctx.inject(['connection'], routeCtx => routeCtx.effect(() => routeCtx.connection.fetch.register({
    path: '/api/afp/workbench-data', methods: ['POST'], requestBody: 'buffered',
    fetch: request => service.workbenchDataResponse(request),
  }), 'AFP workbench metadata route'))
}
