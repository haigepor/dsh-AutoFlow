import { categories } from './afp-refresh-workflow.js'
const categorySchema = { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', enum: categories } }
const idSchema = { type: 'string', pattern: '^[a-f0-9-]{36}$' }
function owner(exec) { if (!exec.agent?.id) throw new Error('AFP tools require a Session'); return exec.agent.id }

/** Register one capability's tools, preserving stable names and Session ownership. */
export function registerAgentTools(ctx, service, feature) {
  function tool(name, description, properties, required, kind, run) {
    ctx.effect(() => ctx.tools.register({ name, description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      presentCall: () => ({ card: 'generic', title: name, kind }),
      async execute(args, exec) {
        try {
          service.require(feature); owner(exec)
          if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !Object.hasOwn(properties, key)) || required.some(key => !Object.hasOwn(args, key))) throw new Error('Invalid AFP arguments')
          return JSON.stringify(await run(args, exec))
        } catch (error) { exec.signal.throwIfAborted(); throw new Error('AFP operation failed. Check setup and afp_report before retrying a write.') }
      },
    }), `AFP tool ${name}`)
  }
  if (feature === 'read') {
    tool('afp_status', 'Check credential presence and capabilities without returning values.', {}, [], 'read', () => service.status())
    tool('afp_search_plan', 'Plan a photo search offline; no remote mutation.', { query: { type: 'string', minLength: 1, maxLength: 2000 } }, ['query'], 'search', args => service.search(args.query))
    tool('afp_collections', 'Read exact private AFP target names and membership counts.', {}, [], 'read', (_args, exec) => service.collections(exec.signal))
    tool('afp_report', 'Read a saved visual dry-run or write report.', { runId: idSchema, planId: idSchema }, [], 'read', args => service.report(args))
    tool('afp_plan_change', 'Prepare an expiring Session-owned dry-run for append, replace or clear. Present exact targets and counts before afp_apply; never writes AFP.',
      { operation: { type: 'string', enum: ['append', 'replace', 'clear'] }, categories: categorySchema, runId: idSchema }, ['operation', 'categories'], 'read', (args, exec) => service.changes.plan(args, owner(exec), exec.signal))
  } else if (feature === 'refresh') {
    tool('afp_refresh', 'Start or resume a background visual dry-run. Never writes AFP. Use job_output and afp_report; stop with job_kill.', { categories: categorySchema, runId: idSchema }, [], 'execute', (args, exec) => service.startRefresh(args, owner(exec), exec.signal))
  } else if (feature === 'write') {
    ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next()
      if (exec.name !== 'afp_apply' || decision.kind !== 'allow') return decision
      try {
        service.require('write')
        const report = await service.changes.check(exec.arguments?.planId, owner(exec))
        return { kind: 'ask', reason: `AFP remote write: ${JSON.stringify(report)}`,
          displayReason: { en: `Apply AFP ${report.operation}? ${JSON.stringify(report.categories)}`, zh: `执行 AFP ${report.operation}？${JSON.stringify(report.categories)}` } }
      } catch (error) { return { kind: 'deny', reason: 'Invalid, expired, used or foreign AFP plan. Create a new dry-run plan.' } }
    })
    tool('afp_apply', 'Apply a Session-owned plan after DSH human approval. Rechecks account and membership; no automatic retry or rollback. Inspect job_output and afp_report for partial writes.',
      { planId: idSchema }, ['planId'], 'edit', async (args, exec) => {
        await service.changes.check(args.planId, owner(exec))
        return { ...service.job('write', owner(exec), 'AFP approved write', signal => service.changes.execute(args.planId, owner(exec), signal)), planId: args.planId }
      })
  }
}
