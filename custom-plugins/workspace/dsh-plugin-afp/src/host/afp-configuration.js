import { resolveConfig } from '../../config-schema.js'
import { digest } from './afp-state-store.js'
import { agentError } from './afp-agent-errors.js'

/** Non-secret deployment edits use the profile editor's validation, lock and rollback. */
export async function configurationAction(ctx, input, service, signal) {
  const entry = ctx.configEditor.entries().find(entry => entry.options.id === 'afp')
  if (!entry) throw new Error('AFP configuration entry unavailable')
  const config = resolveConfig(entry.fiber.config)
  if (input.operation === 'read' && Object.keys(input).length === 1) {
    if (!service) throw new Error('AFP configuration service unavailable')
    return JSON.stringify({ config, revision: digest(JSON.stringify(config)), ...(await service.connection.configurationInfo()) })
  }
  if (input.operation === 'reveal-credential') {
    if (Object.keys(input).some(key => !['operation', 'key', 'revision'].includes(key))
      || !['passwordRef', 'accessTokenRef', 'visionKeyRef'].includes(input.key)) throw new Error('Invalid AFP credential field')
    if (input.revision !== digest(JSON.stringify(config))) throw new Error('AFP configuration changed; reopen the editor')
    if (!service) throw new Error('AFP configuration service unavailable')
    const details = await service.connection.configurationInfo(input.key)
    signal?.throwIfAborted()
    // 仅显式查看返回一个字段；常规配置、Agent 工具和任务记录不包含凭据值。
    return JSON.stringify({ value: details.value })
  }
  if (input.operation === 'acquire-token' && Object.keys(input).length === 1) {
    if (!service) throw new Error('AFP token service unavailable')
    const started = performance.now()
    try {
      await service.acquireToken(signal)
      return JSON.stringify({ acquired: true })
    } catch (error) {
      signal?.throwIfAborted()
      // 页面按固定类别提示认证故障，不将上游消息或凭据返回给浏览器。
      return JSON.stringify({ acquired: false, error: agentError(error, 'read', Math.round(performance.now() - started)) })
    }
  }
  if (input.operation !== 'save' || Object.keys(input).some(key => !['operation', 'config', 'revision'].includes(key))) throw new Error('Invalid AFP configuration operation')
  const next = resolveConfig(JSON.parse(input.config))
  await ctx.configEditor.edit(entry, current => {
    if (digest(JSON.stringify(resolveConfig(current))) !== input.revision) throw new Error('AFP configuration changed; reopen the editor')
    return next
  })
  return JSON.stringify({ saved: true })
}
