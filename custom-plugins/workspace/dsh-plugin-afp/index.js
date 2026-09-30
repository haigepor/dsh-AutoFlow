import { Config, resolveConfig } from './config-schema.js'
import { AfpService } from './src/host/afp-service.js'
import { configurationAction } from './src/host/afp-configuration.js'
export { Config }
export const name = 'dsh-plugin-afp'
export const inject = ['credentials', 'jobs', 'profileContext', 'pluginManager', 'configEditor']

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
      throw new Error('AFP operation failed. Check setup and the saved report; remote writes may be partial.')
    }
  }), 'AFP workbench operation')
}
