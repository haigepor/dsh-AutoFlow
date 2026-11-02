import { registerExtendedAgentTools } from './src/host/afp-agent-operations.js'

const workflowTools = new Set(['read', 'skill', 'job_output', 'job_list', 'job_kill', 'todo_write', 'ask_user_question'])

/** AFP-only workflow and tool visibility for the dedicated preset. */
export const inject = ['afp', 'tools', 'systemPrompt']

/** Contribute AFP tools without enabling a second profile feature instance.
 * @param {object} ctx Preset-scoped Cordis context.
 * @returns {void} Contributions follow the retained preset revision.
 */
export function apply(ctx) {
  registerExtendedAgentTools(ctx, ctx.afp)
  let release, lastNames, changing = false
  const sync = () => {
    if (changing) return
    // Agents inherit this preset's tools; an allowlist here would mask those too.
    const names = ctx.root.tools.schemas().map(tool => tool.name)
      .filter(name => !name.startsWith('afp_') && !workflowTools.has(name)).sort()
    const key = JSON.stringify(names)
    if (key === lastNames) return
    changing = true
    try {
      const next = ctx.tools.restrict({ deny: names })
      const previous = release
      release = next; lastNames = key
      previous?.()
    } finally { changing = false }
  }
  ctx.effect(() => {
    const stop = ctx.on('tools/change', sync)
    sync()
    return () => { stop(); release?.() }
  }, 'AFP Agent tool visibility')
}
