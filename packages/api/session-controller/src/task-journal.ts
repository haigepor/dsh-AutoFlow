/** Serializes display checkpoints and acknowledges them only after the Session durability barrier. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Session, SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { SessionTaskId, SessionTaskRecord, SessionTaskSnapshot, SessionTaskSourceId } from './task-types.ts'

const snapshotSchema = z.strictObject({
  schemaVersion: z.literal(1), provider: z.string().min(1),
  taskId: z.string().min(1).transform(brandString<SessionTaskId>),
  sourceId: z.string().min(1).transform(brandString<SessionTaskSourceId>),
  revision: z.number().int().positive(), title: z.string().min(1),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), data: z.json(),
})
const eventSchema = snapshotSchema.extend({ owner: z.string().min(1).transform(brandString<SessionId>) })
const recordSchema = eventSchema.extend({ eventSeq: z.number().int().nonnegative().transform(SessionSeq) })
const sameSource = (a: SessionTaskSnapshot, b: SessionTaskSnapshot) =>
  a.provider === b.provider && a.taskId === b.taskId && a.sourceId === b.sourceId

function fold(records: readonly SessionTaskRecord[], event: SessionEvent): readonly SessionTaskRecord[] {
  if (event.type !== 'session/task') return records
  const data = eventSchema.parse(event.data)
  const index = records.findIndex(record => sameSource(record, data))
  const previous = records[index]
  if (previous && previous.owner !== data.owner) throw new Error('Session task history changes its execution owner')
  if (previous && previous.revision >= data.revision) {
    const { eventSeq: _seq, ...saved } = previous
    if (previous.revision === data.revision && !isDeepStrictEqual(saved, data)) throw new Error('Session task history contains conflicting source revisions')
    return records
  }
  const record = { ...data, eventSeq: event.seq }
  return index < 0 ? [...records, record] : records.map((value, position) => position === index ? record : value)
}

/** Keeps one current record per producer source, rather than a second request or execution history. */
export class SessionTaskJournal {
  private handle!: ProjectionHandle<readonly SessionTaskRecord[]>
  private readonly chains = new Map<SessionId, Promise<void>>()
  private closed = false

  /**
   * @param ctx Session and Projection owner.
   * @param resolve Explicit cold-Session admission.
   * @param maxBytes Configured serialized snapshot limit.
   */
  constructor(
    private readonly ctx: Context,
    private readonly resolve: (id: SessionId) => Promise<Session>,
    private readonly maxBytes: number,
  ) {}

  /** Register task projection ownership and drain pending writes during teardown.
   * @returns After the task projection and its teardown owner are ready.
   */
  async initialize(): Promise<void> {
    this.handle = await this.ctx.sessionProjections.register({
      key: 'sessionTasks', stateVersion: 1, stateSchema: z.array(recordSchema).readonly(),
      init: () => [], apply: fold, wire: { viewSchema: z.array(recordSchema).readonly(), view: records => records, summary: false },
    })
    this.ctx.effect(() => async () => {
      this.closed = true
      await Promise.allSettled([...this.chains.values()])
    }, 'session-controller task presentation drain')
  }

  /**
   * Append a newer checkpoint or finish flushing its previous, uncertain acknowledgement.
   * @param id Owning Session, already authorized by the Host producer.
   * @param input Complete display checkpoint; the same source/revision must retain identical data.
   * @returns The current accepted record after persistence has acknowledged it.
   */
  async publish(id: SessionId, input: SessionTaskSnapshot): Promise<SessionTaskRecord> {
    const parsed = snapshotSchema.safeParse(input)
    if (!parsed.success) throw new RemoteError('session/task-checkpoint-failed', 'The task display checkpoint is invalid', { reason: 'invalid' })
    const snapshot = parsed.data
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > this.maxBytes) throw new RemoteError('session/task-checkpoint-failed', 'Session task checkpoint exceeds the configured byte limit', { reason: 'too-large' })
    const previous = this.chains.get(id) ?? Promise.resolve()
    const work = previous.then(async () => {
      if (this.closed) throw new RemoteError('session/task-checkpoint-failed', 'Session task presentation is closing', { reason: 'closing' })
      const session = this.ctx.sessions.get(id) ?? await this.resolve(id)
      const current = this.handle.stateOf(session).find(record => sameSource(record, snapshot))
      if (current && current.owner !== id) throw new RemoteError('session/task-checkpoint-failed', 'Inherited task records do not transfer execution ownership', { reason: 'inherited' })
      if (current?.revision === snapshot.revision) {
        const { eventSeq: _seq, owner: _owner, ...saved } = current
        if (!isDeepStrictEqual(saved, snapshot)) throw new RemoteError('session/task-checkpoint-failed', 'Session task source revision has conflicting data', { reason: 'revision-conflict' })
      }
      if (!current || current.revision < snapshot.revision) session.append('session/task', { ...snapshot, owner: id })
      // An append can succeed while its flush acknowledgement fails. Retry flush without appending again.
      let acknowledged: boolean
      try { acknowledged = await this.ctx.sessions.flush(session) }
      catch (cause) { throw new RemoteError('session/task-checkpoint-failed', 'The task checkpoint was appended but persistence has not acknowledged it; retry display synchronization', { reason: 'persistence-unconfirmed' }, { cause }) }
      if (!acknowledged) throw new RemoteError('session/task-checkpoint-failed', 'Session task presentation requires an active persistence checkpoint', { reason: 'persistence-unconfirmed' })
      const accepted = this.handle.stateOf(session).find(record => sameSource(record, snapshot))
      if (!accepted) throw new Error('Session task checkpoint was not projected')
      return accepted
    })
    const settled = work.then(() => {}, () => {})
    this.chains.set(id, settled)
    void settled.finally(() => { if (this.chains.get(id) === settled) this.chains.delete(id) })
    return work
  }
}
