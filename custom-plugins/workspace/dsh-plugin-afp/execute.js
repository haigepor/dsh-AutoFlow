import { registerAgentTools } from './src/host/afp-agent-tools.js'
export const inject = ['afp', 'tools']
export const Config = { '~standard': { version: 1, vendor: 'dsh-plugin-afp', validate(value) {
  return value && Object.keys(value).length === 1 && ['read', 'refresh', 'write', 'ui-settings', 'ui-panel', 'ui-conversation'].includes(value.feature)
    ? { value } : { issues: [{ message: 'Invalid AFP feature row configuration' }] }
} } }

/** Each row activates only its own capability and drains related tasks on disposal. */
export async function apply(ctx, config) {
  const dispose = await ctx.afp.enable(config.feature)
  try {
    ctx.effect(() => dispose, `AFP feature ${config.feature}`)
    if (!config.feature.startsWith('ui-')) registerAgentTools(ctx, ctx.afp, config.feature)
  } catch (error) { await dispose(); throw error }
}
