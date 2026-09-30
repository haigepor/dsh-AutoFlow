import { activateFeature } from './src/host/demo-managed-content.js'

export const inject = ['profileContext']

/** The Skill row owns its filesystem Skill lease. */
export async function apply(ctx) {
  const lease = await activateFeature('skill', ctx.profileContext.dir)
  try { ctx.effect(() => () => lease.dispose(), 'demo: Skill lease') }
  catch (error) { await lease.dispose(); throw error }
}
