/** Optional Agent tools and workbench availability rows. */
import { registerTools } from './src/host/tools.js'
export const inject = ['articleImage', 'tools']
export const Config = { '~standard': { version: 1, vendor: 'dsh-plugin-article-image', validate(value) {
  return value && Object.keys(value).length === 1 && ['tools', 'ui-panel'].includes(value.feature)
    ? { value } : { issues: [{ message: 'Unknown article image feature' }] }
} } }

/** Enable one capability and release it on disposal. @param {object} ctx Context. @param {object} config Feature row. @returns {Promise<void>} Registration completion. */
export async function apply(ctx, config) {
  const release = await ctx.articleImage.enable(config.feature)
  ctx.effect(() => release, `Article image ${config.feature}`)
  if (config.feature === 'tools') registerTools(ctx, ctx.articleImage)
}
