import { activateFeature } from './src/host/demo-managed-content.js'

export const inject = ['profileContext']

/** The prompt row owns its global-memory lease. */
export async function apply(ctx) {
  const lease = await activateFeature('prompt', ctx.profileContext.dir)
  try { ctx.effect(() => () => lease.dispose(), 'demo: prompt lease') }
  catch (error) { await lease.dispose(); throw error }
}
