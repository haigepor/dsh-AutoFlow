/** Publish initial Session and Workspace arrival for the early startup overlay. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'

/** Initial data providers; their streams start independently of the animation. */
export const inject = ['sessions', 'workspaces']

/**
 * Keep one document marker in sync with the first accepted data baselines.
 * @param ctx - Client plugin context owning the subscriptions and marker.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const root = document.documentElement
    const previous = root.getAttribute('data-dsh-startup-state')
    const publish = (): void => {
      const sessions = ctx.sessions.list.getSnapshot()
      const workspaces = ctx.workspaces.list.getSnapshot()
      const state = workspaces.state === 'error' ? 'error'
        : sessions.phase === 'ready' && workspaces.phase === 'ready' ? 'ready' : 'loading'
      root.setAttribute('data-dsh-startup-state', state)
    }
    const disposers = [ctx.sessions.list.subscribe(publish), ctx.workspaces.list.subscribe(publish)]
    publish()
    return () => {
      for (const dispose of disposers) dispose()
      if (previous === null) root.removeAttribute('data-dsh-startup-state')
      else root.setAttribute('data-dsh-startup-state', previous)
    }
  }, 'boot-animation: initial data')
}
