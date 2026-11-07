/** Durable task display cannot submit a conversation turn or repeat an accepted source revision. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SessionTaskJournal } from '../src/task-journal.ts'
import type { SessionTaskId, SessionTaskSnapshot, SessionTaskSourceId } from '../src/task-types.ts'

const contexts = new Set<Context>()
afterEach(async () => { await Promise.all([...contexts].map(ctx => ctx.fiber.dispose())); contexts.clear() })
async function harness() {
  const ctx = new Context(); contexts.add(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  let rejectFlush = false
  ctx.on('session/flush', async () => { if (rejectFlush) throw new Error('lost persistence acknowledgement') })
  const session = ctx.sessions.create()
  const journal = new SessionTaskJournal(ctx, async (id: SessionId) => {
    const found = ctx.sessions.get(id)
    if (!found) throw new Error('Session missing')
    return found
  }, 16_384)
  await journal.initialize()
  const snapshot: SessionTaskSnapshot = {
    schemaVersion: 1, provider: 'fixture', taskId: brandString<SessionTaskId>('task-one'), sourceId: brandString<SessionTaskSourceId>('run-one'),
    revision: 1, title: 'Find landscape images', createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z', data: { status: 'running' },
  }
  return { ctx, session, journal, snapshot, flushFails(value: boolean) { rejectFlush = value } }
}
describe('Session task presentation', () => {
  it('records concurrent duplicate checkpoints once without starting a turn', async () => {
    const { session, journal, snapshot, ctx } = await harness()
    const [a, b] = await Promise.all([journal.publish(session.id, snapshot), journal.publish(session.id, snapshot)])
    expect(a.eventSeq).toBe(b.eventSeq)
    expect(session.snapshotEvents().map(event => event.type)).toEqual(['session/task'])
    const { eventSeq: _position, owner, ...checkpoint } = a
    expect({ owned: owner === session.id, checkpoint }).toMatchInlineSnapshot(`
      {
        "checkpoint": {
          "createdAt": "2026-11-06T00:00:00.000Z",
          "data": {
            "status": "running",
          },
          "provider": "fixture",
          "revision": 1,
          "schemaVersion": 1,
          "sourceId": "run-one",
          "taskId": "task-one",
          "title": "Find landscape images",
          "updatedAt": "2026-11-06T00:00:00.000Z",
        },
        "owned": true,
      }
    `)
    expect(ctx.sessionProjections.snapshot(session).values.sessionTasks).toEqual([a])
    expect(ctx.sessionProjections.summaryKeys().has('sessionTasks')).toBe(false)
  })
  it('retains a newer source revision and rejects a conflicting duplicate', async () => {
    const { session, journal, snapshot } = await harness()
    await journal.publish(session.id, { ...snapshot, revision: 2, data: { status: 'completed' } })
    expect((await journal.publish(session.id, snapshot)).revision).toBe(2)
    await expect(journal.publish(session.id, { ...snapshot, revision: 2 })).rejects.toThrow('conflicting data')
    expect(session.snapshotEvents()).toHaveLength(1)
  })
  it('retries an uncertain durability acknowledgement without appending another checkpoint', async () => {
    const f = await harness()
    f.flushFails(true)
    await expect(f.journal.publish(f.session.id, f.snapshot)).rejects.toMatchObject({ code: 'session/task-checkpoint-failed', details: { reason: 'persistence-unconfirmed' } })
    expect(f.session.snapshotEvents()).toHaveLength(1)
    f.flushFails(false)
    expect((await f.journal.publish(f.session.id, f.snapshot)).revision).toBe(1)
    expect(f.session.snapshotEvents()).toHaveLength(1)
  })
  it('preserves original task ownership in copied records', async () => {
    const { ctx, session, journal, snapshot } = await harness()
    const child = ctx.sessions.create()
    child.append('session/task', { ...snapshot, owner: session.id })
    await expect(journal.publish(child.id, snapshot)).rejects.toThrow('do not transfer execution ownership')
    expect(ctx.sessionProjections.snapshot(child).values.sessionTasks?.[0]?.owner).toBe(session.id)
  })
})
