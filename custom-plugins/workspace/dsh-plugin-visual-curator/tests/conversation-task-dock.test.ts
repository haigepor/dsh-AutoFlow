import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, type SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'
import { runSchema, imageVersionSchema } from '../src/shared/model.ts'
import { resolveConfig } from '../src/host/config.ts'
import { createCuratorTransport } from '../src/client/transport.ts'
import { importedRecords } from '../src/host/imports.ts'
import { conversationRunSchema } from '../src/client/conversation-feedback.ts'

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

test('conversation results use an authorized same-asset saved preview and leave old missing previews absent', async () => {
  const f = await serviceFixture(), sessions = new SessionStore(new Context()), sessionId = 'thumbnail-session'
  sessions.create(brandString<SessionId>(sessionId), { meta: { cwd: f.root } }); f.host.sessions.get = id => sessions.get(id)
  try {
    await f.service.initialize()
    const files = await f.files.importBytes(f.http.image, 'image/png')
    const ready = importedRecords(f.profileId, f.actor, files, { kind: 'local-import', description: 'With preview' })
    const legacy = importedRecords(f.profileId, f.actor, files, { kind: 'local-import', description: 'Legacy original' })
    const foreign = imageVersionSchema.parse({ ...ready.preview, id: 'wrong-asset-preview', parentImageVersionId: legacy.image.id })
    const run = runSchema.parse({ schemaVersion: 1, profileId: f.profileId, id: 'thumbnail-search', kind: 'run', createdAt: '2026-11-07T00:00:00.000Z', owner: { kind: 'session', sessionId }, revision: 1, status: 'completed', stage: 'finalizing', spec: { kind: 'search', config: f.service.config, input: { taskBrief: 'Saved source images', targetCount: 2 }, fixed: { output: { kind: 'original' } }, specDigest: 'fixture' }, data: { attemptId: 'attempt', attempts: 1, budget: { vision: 0, search: 0, downloadBytes: 0, deadlineAt: 1 }, checkpoint: { search: { importedImages: { ready: ready.image.id, legacy: legacy.image.id }, issues: [] } }, counts: {}, warnings: [], resultIds: [], requestIds: [] } })
    await f.repository.commit({ aggregateId: 'thumbnail-fixture', expectedRevision: 0, operationId: 'seed', request: {}, records: [run, ...ready.records, ...legacy.records.filter(row => row.id !== legacy.preview.id), foreign], state: {} })
    const grant = z.object({ sessionToken: z.string() }).parse(await f.action('session-open', { sessionId }))
    const view = conversationRunSchema.parse(await f.action('run-get', { runId: run.id, sessionId, sessionToken: grant.sessionToken }))
    const shown = view.results.find(row => row.imageVersionId === ready.image.id)!, old = view.results.find(row => row.imageVersionId === legacy.image.id)!
    assert.equal(new URL(shown.previewPath, 'http://fixture').searchParams.get('imageVersionId'), ready.image.id)
    assert.equal(new URL(shown.thumbnailPath!, 'http://fixture').searchParams.get('imageVersionId'), ready.preview.id)
    assert.equal(old.thumbnailPath, undefined, 'Another asset preview with the same parent cannot become this source thumbnail')
    const thumbnail = await f.service.resource(new Request(new URL(shown.thumbnailPath!, 'http://fixture')))
    assert.equal(thumbnail.status, 200); await thumbnail.body?.cancel()
    const original = await f.service.resource(new Request(new URL(shown.previewPath, 'http://fixture')))
    assert.equal(original.status, 200)
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), await f.files.read(ready.image.blob))
    assert.equal(f.http.operations.length, 0)
  } finally { await f.cleanup() }
})
