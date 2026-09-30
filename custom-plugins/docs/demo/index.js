import { removeFeature, status } from './src/host/demo-managed-content.js'

export const inject = ['pluginManager']

/** Keep management actions available while the bundle is mounted. */
export function apply(ctx) {
  const manager = ctx.pluginManager
  const packageName = 'dsh-custom-plugin-demo'
  for (const [id, run] of [
    ['status', async () => JSON.stringify(await status())],
    ['remove-prompt', async () => JSON.stringify(await removeFeature('prompt'))],
    ['remove-skill', async () => JSON.stringify(await removeFeature('skill'))],
  ]) ctx.effect(() => manager.registerAction(packageName, id, run), `demo: ${id}`)
}
