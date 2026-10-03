import { resolveConfig } from '../../config-schema.js'
import { digest } from './afp-state-store.js'

/** Non-secret deployment edits use the profile editor's validation, lock and rollback. */
export async function configurationAction(ctx, input, service, signal) {
  const entry = ctx.configEditor.entries().find(entry => entry.options.id === 'afp')
  if (!entry) throw new Error('AFP configuration entry unavailable')
  const config = resolveConfig(entry.fiber.config)
  if (input.operation === 'read' && Object.keys(input).length === 1) {
    if (!service) throw new Error('AFP configuration service unavailable')
    return JSON.stringify({ config, revision: digest(JSON.stringify(config)), ...(await service.connection.configurationInfo()) })
  }
  if (input.operation === 'acquire-token' && Object.keys(input).length === 1) {
    if (!service) throw new Error('AFP token service unavailable')
    await service.acquireToken(signal)
    return JSON.stringify({ acquired: true })
  }
  if (input.operation !== 'save' || Object.keys(input).some(key => !['operation', 'config', 'revision'].includes(key))) throw new Error('Invalid AFP configuration operation')
  const next = resolveConfig(JSON.parse(input.config))
  await ctx.configEditor.edit(entry, current => {
    if (digest(JSON.stringify(resolveConfig(current))) !== input.revision) throw new Error('AFP configuration changed; reopen the editor')
    return next
  })
  return JSON.stringify({ saved: true })
}
