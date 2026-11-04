/** User cancellation reaches accepted visual work independently of the conversation driver's cleanup. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CuratorService } from './service.ts'
import { safeFailure } from './runtime.ts'

/** @param ctx Provider scope owning listeners and pending cancellation work. @param service Sole visual task owner. */
export function bindSessionCancellation(ctx: Context, service: Pick<CuratorService, 'stopSessionTasks'>): void {
  const turns = new Map<SessionId, { signal: AbortSignal; cancelled: boolean; dispose(): void }>()
  const pending = new Set<Promise<void>>()
  const stop = (id: SessionId) => {
    const work = service.stopSessionTasks(id).catch(error => { ctx.logger.warn('Visual Curator Session stop failed: %s', safeFailure(error).code) }).finally(() => pending.delete(work))
    pending.add(work)
  }
  const detach = (id: SessionId) => { turns.get(id)?.dispose(); turns.delete(id) }
  ctx.effect(() => async () => {
    for (const id of turns.keys()) detach(id)
    await Promise.allSettled([...pending])
  }, 'Visual Curator Session cancellation drain')
  ctx.on('agent/pre-step', ({ agent, signal }, next) => {
    if (turns.get(agent.id)?.signal !== signal) {
      detach(agent.id)
      const binding = { signal, cancelled: false, dispose: () => signal.removeEventListener('abort', abort) }
      const abort = () => {
        const cause: unknown = signal.reason
        if (typeof cause !== 'object' || cause === null || !('kind' in cause) || cause.kind !== 'user') return
        binding.cancelled = true; stop(agent.id)
      }
      signal.addEventListener('abort', abort, { once: true }); turns.set(agent.id, binding)
      if (signal.aborted) abort()
    }
    return next()
  })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const cancelled = turns.get(session.id)?.cancelled
    detach(session.id)
    if (!cancelled && event.data.reason.kind === 'aborted' && event.data.reason.reason.kind === 'user') stop(session.id)
  })
  ctx.on('agent/disposed', ({ agent }) => detach(agent.id))
}
