/** Optional Cordis row registering Session-owned Codex image tools. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ImagesFacade } from './images/types.ts'
import { createImageTools } from './images/tools.ts'
import { resolveSessionImage } from './images/session-references.ts'
import { ImageServiceError } from './images/errors.ts'

/** Tools bind only while the shared subscription provider exists. */
export const name = 'codex-subscription-tools'
/** Shared image service, tool registry and current-model capabilities. */
export const inject = ['tools', 'codexSubscription', 'llm', 'attachments']
/** This feature row has no independent deployment options. */
export const Config = z.object({})

/** Register reversible tool contributions on the row's Cordis scope.
 * @param ctx Tool registry and initialized subscription service supplied by the host.
 */
export function apply(ctx: Context & { codexSubscription: { images: ImagesFacade; quickWaitMs: number; imageReferenceLimits: { maxImageBytes: number; maxReferenceImages: number } } }): void {
  for (const tool of createImageTools(ctx.codexSubscription.images, { quickWaitMs: () => ctx.codexSubscription.quickWaitMs, admitImages: exec => admitsImages(ctx, exec),
    resolveAttachments: async (ids, exec) => {
      const limits = ctx.codexSubscription.imageReferenceLimits
      if (ids.length > limits.maxReferenceImages + 1) throw new ImageServiceError('invalid-image-input', 'Too many Session image references.')
      if (exec.agent === undefined) throw new ImageServiceError('image-session-required', 'A Session is required to resolve images.')
      const references: string[] = []
      for (const id of ids) {
        const image = await resolveSessionImage(id, exec.agent.session, ctx.attachments, ctx.codexSubscription.images, limits.maxImageBytes, exec.signal)
        references.push(`data:${image.mimeType};base64,${Buffer.from(image.data).toString('base64')}`)
      }
      return references
    } })) {
    ctx.effect(() => ctx.tools.register(tool), `codex-subscription tool ${tool.name}`)
  }
}

async function admitsImages(ctx: Context, exec: ToolRunContext): Promise<boolean> {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  if (provider === undefined || model === undefined) return false
  try {
    const info = await ctx.llm.resolveModelInfo(provider, model, exec.signal)
    return info.inputModalities?.includes('image') === true
  } catch (_error) {
    // 能力目录暂不可用时保留附件引用；未知能力不把图片内容发给当前模型。
    return false
  }
}
