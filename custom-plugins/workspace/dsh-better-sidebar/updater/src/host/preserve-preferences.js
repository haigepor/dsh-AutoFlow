/** Retain raw profile configuration even when the sidebar has no active settings registration. */
import { PACKAGE } from './source.js'

export async function preservePreferences(ctx) {
  const bundle = (await ctx.pluginManager.listBundles()).find(item => item.name === PACKAGE)
  if (bundle?.enabled === false) {
    await ctx.configEditor.retainDisabledBundle(PACKAGE)
    return
  }
  const rows = bundle?.rows.filter(row => row.moduleName === PACKAGE) ?? []
  const entries = ctx.configEditor.entries()
  const targets = rows.map(row => entries.find(entry => entry.options.id === row.rowId && entry.options.name === row.moduleName))
  // 无法确认配置所有者时停止安装，不能把缺失的 settings 描述误判为空配置。
  if (!targets.length || targets.some(entry => !entry)) throw new Error('Sidebar configuration is unavailable')
  for (const entry of targets) await ctx.configEditor.edit(entry, current => current, { retainOverride: true })
}
