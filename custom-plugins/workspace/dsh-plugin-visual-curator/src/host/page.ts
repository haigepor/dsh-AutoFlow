/** Optional page rows advertise their active entry to the Client without changing business data. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import type {} from './plugin.ts'
import { z } from 'zod'

export const name = 'visual-curator-page'
export const inject = ['visualCurator', 'pluginManager']
export const Config = z.strictObject({ page: z.enum(['settings', 'panel', 'conversation']) })

/** Keep each page entry's availability tied to its Host row lifecycle.
 * @param ctx Scoped context with the authenticated plugin action registry.
 * @param config Validated optional page identifier.
 */
export function apply(ctx: Context, config: z.infer<typeof Config>): void {
  ctx.effect(() => ctx.pluginManager.registerAction('dsh-plugin-visual-curator', `page-${config.page}`,
    async () => JSON.stringify({ page: config.page, stage: 'entry-only' })), `Visual Curator page ${config.page}`)
}
