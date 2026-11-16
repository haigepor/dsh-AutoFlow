/** DeepSeek Harness occupants for browser-brand slots and the official home frame. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { PixelWhale } from './home-whale/PixelWhale.tsx'
import { OfficialBrandIdentity, OfficialBrandMark, OfficialBrandName } from './Brand.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Fill sidebar brand slots and the official profile's home frame.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  if (process.env.DSH_CLIENT_BUILD_PROFILE === 'official') {
    ctx.slots.inject('conversation.hero.frame', () => ctx.slots.register({
      name: 'conversation.hero.frame',
      id: 'pixel-whale',
    }, PixelWhale))
  }
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', () => ctx.slots.inject('sidebar.brand.identity', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, OfficialBrandMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name' }, OfficialBrandName)
      yield ctx.slots.register({ name: 'sidebar.brand.identity' }, OfficialBrandIdentity)
    })))
}
