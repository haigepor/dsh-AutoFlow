import { acquireSkill, skillNames } from './src/host/afp-skill-leases.js'
export const inject = ['afp', 'profileContext']
export const Config = { '~standard': { version: 1, vendor: 'dsh-plugin-afp', validate(value) {
  return value && Object.keys(value).length === 1 && skillNames.includes(value.skill) ? { value } : { issues: [{ message: 'Unknown AFP Skill' }] }
} } }

/** One optional row contributes one Skill and releases its cross-profile lease on disposal. */
export async function apply(ctx, config) {
  const release = await acquireSkill({ home: ctx.profileContext.home, profile: ctx.profileContext.dir, skill: config.skill, maxStateBytes: ctx.afp.config.maxStateBytes })
  try { ctx.effect(() => release, `AFP Skill ${config.skill}`) }
  catch (error) { await release(); throw error }
}
