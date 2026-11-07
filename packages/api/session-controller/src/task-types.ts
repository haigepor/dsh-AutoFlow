/** Durable, display-only background task records; these records never dispatch a model turn. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionSummaryExcluded } from '@deepseek-ai/dsh-session-projection/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-typert-protocol'

/** Stable producer-owned task identity, retained across execution attempts. */
export type SessionTaskId = Branded<'SessionTaskId'>
/** Identity of one independently revisioned source within a task. */
export type SessionTaskSourceId = Branded<'SessionTaskSourceId'>

/** One complete producer checkpoint. Source revisions are compared only within the same source. */
export interface SessionTaskSnapshot {
  readonly schemaVersion: 1
  readonly provider: string
  readonly taskId: SessionTaskId
  readonly sourceId: SessionTaskSourceId
  readonly revision: number
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  /** Producer-owned JSON, validated by its renderer rather than interpreted by the Session driver. */
  readonly data: JsonValue
}

/** Original execution owner; copying a Session does not transfer its task controls. */
export interface SessionTaskEvent extends SessionTaskSnapshot {
  readonly owner: SessionId
}
/** A checkpoint and the exact Session position that accepted it. */
export interface SessionTaskRecord extends SessionTaskEvent {
  readonly eventSeq: SessionSeq
}

/** Host-only capability checked by independent plugins before admitting background task presentation. */
export interface SessionTaskPublisher {
  /** @param sessionId Authorized owner. @param snapshot Complete producer checkpoint. @returns Durable current checkpoint. */
  recordTask(sessionId: SessionId, snapshot: SessionTaskSnapshot): Promise<SessionTaskRecord>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Repeating a checkpoint is safe only after correcting invalid inputs or retrying an unconfirmed flush. */
    'session/task-checkpoint-failed': { readonly reason: 'invalid' | 'too-large' | 'closing' | 'inherited' | 'revision-conflict' | 'persistence-unconfirmed' }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Records a display-only checkpoint of an external background task.
     * @param data - Stable task/source identity, source revision and complete presentation checkpoint.
     */
    'session/task': SessionTaskEvent
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Latest task checkpoints; opened Sessions receive them, list summaries omit producer payloads. */
    sessionTasks: SessionProjectionSummaryExcluded<readonly SessionTaskRecord[]>
  }
}
