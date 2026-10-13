/** Independent updater for the official Better Sidebar package. */
import z from '@deepseek-ai/schemastery'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { SidebarUpdater } from './src/host/service.js'
import { preservePreferences } from './src/host/preserve-preferences.js'

export const name = 'dsh-plugin-better-sidebar-updater'
export const inject = ['pluginManager', 'profileContext', 'settings', 'configEditor']
export const Config = z.object({
  checkIntervalMs: z.number().step(1).min(0).default(3600000),
  pollIntervalMs: z.number().step(1).min(250).default(1000),
  timeoutMs: z.number().step(1).min(1000).default(30000),
  jsonBytes: z.number().step(1).min(1024).default(1048576),
  archiveBytes: z.number().step(1).min(1024).default(67108864),
})

/** Own the action and background checks without depending on the sidebar being enabled. */
export function apply(ctx, config) {
  const service = new SidebarUpdater({ pluginManager: ctx.pluginManager, profileContext: { ...ctx.profileContext, runtimeVersion: getDshRuntimeVersion() }, preservePreferences: () => preservePreferences(ctx) }, config)
  ctx.effect(() => () => service.dispose(), 'Sidebar updater drain')
  ctx.effect(() => ctx.pluginManager.registerAction(name, 'update', async input => JSON.stringify(await service.run(input.operation))), 'Sidebar update action')
  ctx.inject(['appReady'], ready => {
    ready.effect(() => {
      let timer
      const remove = ready.appReady.onReady(() => {
        if (config.checkIntervalMs === 0) return
        const check = () => { void service.run('check').catch(error => { if (!service.abort.signal.aborted) ctx.logger.warn('Sidebar update check failed', error) }) }
        check()
        timer = setInterval(check, config.checkIntervalMs)
        timer.unref()
      })
      return () => { remove(); if (timer) clearInterval(timer) }
    }, 'Sidebar update checks')
  })
}
