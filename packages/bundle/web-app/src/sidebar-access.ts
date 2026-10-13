/** Keep upstream Sidebar routes inside the Host's browser authentication policy. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'

/** Services required before the guard can be registered. */
export const inject = ['webServer', 'connection']

/** Loader identity of the Web-owned Sidebar authentication adapter. */
export const name = 'better-sidebar-access'

/**
 * Guard Sidebar HTTP and WebSocket routes independently of optional plugin activation.
 * @param ctx - Web composition context carrying the shared authentication service.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.webServer.registerRequestGuard('/sidebar', request => ctx.connection.requestRejection(request)), 'Better Sidebar authentication')
}
