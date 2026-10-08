/** Title refresh Remote semantics over the real title service and an idle agent. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitleService, { SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import type { SessionTitleProviderRequest } from '@deepseek-ai/dsh-session-title'
import { createSessionTestRemote } from './test-remote.ts'

async function composed() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 80, maxTitleBytes: 80 })
  const session = ctx.sessions.create(SessionId('title-refresh-remote'))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Find Hong Kong photographs' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
  ctx.sessionTitle.rename(session, 'User title')
  const remote = createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp',
  })
  return { ctx, session, remote }
}

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

describe('sessions.regenerateTitle', () => {
  it('coalesces concurrent clicks and deliberately replaces a manually named title', async () => {
    const { ctx, session, remote } = await composed()
    const started = gate()
    const completion = gate()
    const generate = vi.fn(async (request: SessionTitleProviderRequest) => {
      started.release()
      await completion.promise
      return { title: 'Hong Kong photographs', messageSeqs: request.messages.map(message => message.seq) }
    })
    ctx.sessionTitle.register({ id: SessionTitleProviderId('refresh'), automatic: 'first-prompt', generate })
    const first = remote.regenerateTitle({ sessionId: session.id })
    const second = remote.regenerateTitle({ sessionId: session.id })
    await started.promise
    expect(ctx.sessionTitle.get(session)?.title).toBe('User title')
    completion.release()
    const results = await Promise.all([first, second])
    expect(generate).toHaveBeenCalledOnce()
    expect(results[0]).toEqual(results[1])
    expect(results[0]).toMatchObject({ ok: true, value: { title: 'Hong Kong photographs' } })
    expect(ctx.sessionTitle.get(session)?.source.kind).toBe('provider')
  })

  it('keeps a newer manual rename when the older refresh completes late', async () => {
    const { ctx, session, remote } = await composed()
    const started = gate()
    const completion = gate()
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('refresh-late'), automatic: 'first-prompt',
      async generate(request) {
        started.release()
        await completion.promise
        return { title: 'Stale title', messageSeqs: request.messages.map(message => message.seq) }
      },
    })
    const pending = remote.regenerateTitle({ sessionId: session.id })
    await started.promise
    await remote.rename({ sessionId: session.id, title: 'Newer manual title' })
    completion.release()
    expect(await pending).toMatchObject({
      ok: false, error: { code: 'session/title-generation-failed', details: { reason: 'TITLE_CANCELLED' } },
    })
    expect(ctx.sessionTitle.get(session)?.title).toBe('Newer manual title')
  })

  it('preserves the existing title on authentication failure and permits a later retry', async () => {
    const { ctx, session, remote } = await composed()
    const generate = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('TITLE_AUTH'), { code: 'TITLE_AUTH' }))
      .mockImplementationOnce(async (request: SessionTitleProviderRequest) => ({
        title: 'Recovered title', messageSeqs: request.messages.map(message => message.seq),
      }))
    ctx.sessionTitle.register({ id: SessionTitleProviderId('refresh-auth'), automatic: 'first-prompt', generate })
    expect(await remote.regenerateTitle({ sessionId: session.id })).toMatchObject({
      ok: false, error: { code: 'session/title-generation-failed', message: 'TITLE_AUTH', details: { reason: 'TITLE_AUTH' } },
    })
    expect(ctx.sessionTitle.get(session)?.title).toBe('User title')
    expect(await remote.regenerateTitle({ sessionId: session.id })).toMatchObject({ ok: true, value: { title: 'Recovered title' } })
  })

  it('rejects an unavailable title provider without replacing the accepted title with a fallback', async () => {
    const { ctx, session, remote } = await composed()
    expect(await remote.regenerateTitle({ sessionId: session.id })).toMatchObject({
      ok: false, error: { details: { reason: 'TITLE_CONFIG' } },
    })
    expect(ctx.sessionTitle.get(session)?.title).toBe('User title')
  })

  it('rejects a cancelled refresh even when its provider ignores the abort', async () => {
    const { ctx, session, remote } = await composed()
    const started = gate()
    const completion = gate()
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('refresh-cancelled'), automatic: 'first-prompt',
      async generate(request) {
        started.release()
        await completion.promise
        return { title: 'Cancelled title', messageSeqs: request.messages.map(message => message.seq) }
      },
    })
    const pending = remote.regenerateTitle({ sessionId: session.id })
    await started.promise
    ctx.sessionTitle.cancel(session)
    completion.release()
    expect(await pending).toMatchObject({ ok: false, error: { details: { reason: 'TITLE_CANCELLED' } } })
    expect(ctx.sessionTitle.get(session)?.title).toBe('User title')
  })
})
