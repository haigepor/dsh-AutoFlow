/** Permanent Session removal keeps admission, retirement and derived-data cleanup together. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionErasureError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-workspace'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ApiSessionAgentController } from './agent.ts'
import type { SessionDeleteRequest, SessionDeleteValue } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Permanent removal of ordinary Session records. */
    sessionDeletion: SessionDeletion
  }
}

/** Host Remote service exposed only while the selected backend supports erasure. */
export class SessionDeletion extends TypertRemoteService {
  static inject = ['sessionErasure', 'sessionPersistence', 'sessionProjectionCache', 'sessionQuery', 'workspaceRegistry', 'sessions', 'typert']
  private readonly live = { accepting: true, pending: new Set<Promise<SessionDeleteValue>>() }

  /** @param ctx - record, index and Workspace owners. @param config - API Agent disposal capabilities. */
  constructor(ctx: Context, private readonly config: { owner: Pick<ApiSessionAgentController, 'withDeletion'>; recover: (id: SessionId) => Promise<void> }) {
    super(ctx, 'sessionDeletion', { namespace: 'sessionDeletion' })
    ctx.effect(() => async () => {
      this.live.accepting = false
      await Promise.allSettled([...this.live.pending])
    }, 'session-deletion: request drain')
  }

  /**
   * Permanently remove one ordinary Session without deleting Workspace files or other Sessions.
   * Active work and foreign write ownership refuse deletion. Cleanup failure after removal
   * reports sessionDeletion/cleanup-failed; retrying completes the idempotent cleanup.
   * @param request - Session whose complete stored record may be removed.
   * @returns confirmation that its record, checkpoints and list references are gone.
   */
  @Remote
  deleteSession(request: SessionDeleteRequest): Promise<SessionDeleteValue> {
    const id = request.sessionId
    if (!this.live.accepting) return Promise.reject(new RemoteError('sessionDeletion/busy', 'Session deletion is closing', { sessionId: id }))
    const task = this.config.owner.withDeletion<SessionDeleteValue>(id, async (retire) => {
      const ctx = this.ctx
      const header = ctx.sessions.get(id)?.header ?? (await ctx.sessionPersistence.stat(id))?.header
      if (header?.origin === 'subagent') throw new RemoteError('sessionDeletion/owned', 'Subagent Sessions belong to their runtime owner', { sessionId: id })
      if (header !== undefined && !ctx.workspaceRegistry.archivedSessionIds.includes(id)) {
        throw new RemoteError('sessionDeletion/not-archived', 'Archive the Session before deleting its record', { sessionId: id })
      }
      let committed = false
      let physicalCleanupFailed = false
      const activity = await ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]))
      if (activity.length > 0) throw new RemoteError('sessionDeletion/active', 'The Session still has running work', { sessionId: id })
      if (header !== undefined && !ctx.workspaceRegistry.archivedSessionIds.includes(id)) {
        throw new RemoteError('sessionDeletion/not-archived', 'The Session was restored during deletion admission', { sessionId: id })
      }
      try {
        await retire()
        await ctx.sessionErasure.erase(id)
        committed = true
      } catch (error: unknown) {
        const erasure = error instanceof Error && error.name === 'SessionErasureError' ? error as SessionErasureError : undefined
        committed = header === undefined || erasure?.committed === true
        ctx.logger.warn(`Session deletion failed for "${id}":`, error)
        if (!committed) {
          await this.config.recover(id)
          if (error instanceof RemoteError) throw error
          throw new RemoteError('sessionDeletion/failed', 'The Session record was not removed', { sessionId: id })
        }
        physicalCleanupFailed = true
      }
      // The record is gone even if secondary cleanup fails or is still running.
      ctx.emit('api-session/removed', id)
      const cleanup = await Promise.allSettled([
        ctx.sessionProjectionCache.remove(id, header),
        ctx.workspaceRegistry.unpinSession(id),
        ctx.workspaceRegistry.unarchiveSession(id),
      ])
      cleanup.push(...await Promise.allSettled(ctx.workspaceRegistry.list()
        .filter(workspace => workspace.sessionIds.includes(id)).map(workspace => workspace.detachSession(id))))
      // Reconciliation removes the deleted record from persistent search indexes as well.
      const indexed = await Promise.allSettled([ctx.sessionQuery.listSessions()])
      if (physicalCleanupFailed || cleanup.some(result => result.status === 'rejected') || indexed.some(result => result.status === 'rejected')) {
        throw new RemoteError('sessionDeletion/cleanup-failed', 'The record was removed but list cleanup is incomplete; retry deletion', { sessionId: id, deleted: true })
      }
      return { deleted: true }
    })
    this.live.pending.add(task)
    void task.then(() => this.live.pending.delete(task), () => this.live.pending.delete(task))
    return task
  }
}
