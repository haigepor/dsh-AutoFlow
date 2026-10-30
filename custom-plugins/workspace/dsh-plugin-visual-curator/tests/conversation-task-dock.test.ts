import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, type SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'
import { runSchema } from '../src/shared/model.ts'
import { resolveConfig } from '../src/host/config.ts'
import { createCuratorTransport } from '../src/client/transport.ts'

test('conversation task discovery restores only the granted Session search and crop records', async () => {
  const f = await serviceFixture(), sessions = new SessionStore(new Context())
  const sessionId = 'dock-session', otherId = 'other-session'
  sessions.create(brandString<SessionId>(sessionId), { meta: { cwd: f.root } })
  sessions.create(brandString<SessionId>(otherId), { meta: { cwd: f.root } })
  f.host.sessions.get = id => sessions.get(id)
  try {
    await f.service.initialize()
    const records = [
      { id: 'search-old', sessionId, kind: 'search', time: '2026-10-28T00:00:00.000Z' },
      { id: 'crop-new', sessionId, kind: 'crop', time: '2026-10-29T00:00:00.000Z' },
      { id: 'analysis', sessionId, kind: 'analyze', time: '2026-10-29T00:00:01.000Z' },
      { id: 'foreign', sessionId: otherId, kind: 'search', time: '2026-10-29T00:00:02.000Z' },
    ].map(item => runSchema.parse({ schemaVersion: 1, profileId: f.profileId, id: item.id, kind: 'run', createdAt: item.time, owner: { kind: 'session', sessionId: item.sessionId }, revision: 1, status: 'cancelled', stage: 'reviewing', spec: { kind: item.kind, config: resolveConfig({}), input: { taskBrief: item.id }, fixed: {}, specDigest: 'fixture' }, data: {} }))
    await f.repository.commit({ aggregateId: 'dock-fixture', expectedRevision: 0, operationId: 'seed', request: {}, records, state: {} })
    const grant = z.object({ sessionToken: z.string() }).parse(await f.action('session-open', { sessionId }))
    const transport = createCuratorTransport({ baseUrl: 'http://localhost/', signal: new AbortController().signal,
      action: async () => { throw new Error('Task discovery must not fall back to bounded action text') },
      fetch: async (url, init) => { assert.equal(init?.credentials, 'same-origin'); return f.service.data(new Request(url, init)) },
    })
    const result = z.object({ sessionId: z.string(), tasks: z.array(z.object({ runId: z.string(), taskBrief: z.string() })) }).parse(await transport.invoke('conversation-runs', { sessionId, sessionToken: grant.sessionToken }))
    assert.equal(result.sessionId, sessionId)
    assert.deepEqual(result.tasks.map(item => item.runId), ['crop-new', 'search-old'])
    await assert.rejects(f.action('conversation-runs', { sessionId }))
    await assert.rejects(f.action('conversation-runs', { sessionId: otherId, sessionToken: grant.sessionToken }))
    assert.equal(f.http.operations.length, 0)
  } finally { await f.cleanup() }
})
