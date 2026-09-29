import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const runFile = promisify(execFile)
const NAME = 'dsh-custom-plugin-demo'
const SCRIPT = fileURLToPath(new URL('./scripts/demo.mjs', import.meta.url))

export const inject = ['pluginManager', 'tools']

/** Register one operation for both the browser action and model-facing tool. */
export function apply(ctx) {
  const manager = ctx.pluginManager
  ctx.effect(() => manager.registerAction(NAME, 'run', async (_input, signal) => {
    const { stdout } = await runFile(process.execPath, [SCRIPT], {
      signal, timeout: 5000, maxBuffer: 16384,
      env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' },
    })
    return stdout.trimEnd()
  }), 'demo: executable action')
  ctx.effect(() => ctx.tools.register({
    name: 'custom_plugin_demo',
    description: 'Run the installed custom plugin demo operation and return its output.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, output) => [{ type: 'text', text: output }] },
    async execute(_args, execution) {
      return (await manager.invokeAction(NAME, 'run', {}, execution.signal)).output
    },
  }), 'demo: Agent tool')
}
