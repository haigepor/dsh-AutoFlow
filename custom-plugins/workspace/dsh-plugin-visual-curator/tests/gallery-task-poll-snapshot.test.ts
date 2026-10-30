/** Lightweight task polling shares verified records and the same committed revision identity. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { CuratorDomain } from '../src/domain/curator.ts'
import { contentDigest, DomainRepository, MemoryDomainAdapter } from '../src/domain/repository.ts'
import { CuratorService } from '../src/host/service.ts'
import { analysisTaskSchema } from '../src/shared/analysis-process.ts'
import { runSchema } from '../src/shared/model.ts'
import { serviceFixture } from './helpers/service-fixture.ts'

class PollAdapter extends MemoryDomainAdapter {
  manifestReads = 0
  readonly reads = new Map<string, number>()
  override manifests() { this.manifestReads++; return super.manifests() }
  override readRecord(key: string) { this.reads.set(key, (this.reads.get(key) ?? 0) + 1); return super.readRecord(key) }
  reset() { this.manifestReads = 0; this.reads.clear() }
}

test('task polling keeps hidden and Session ownership filters while reading one record snapshot', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  let service: CuratorService | undefined
  try {
    const style = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'poll-style', name: 'Synthetic poll' }))
    await f.action('reference-import', { operationId: 'poll-reference', styleId: style.id, expectedRevision: 1, files: [{ name: 'synthetic.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    const started = z.object({ runId: z.string() }).parse(await f.action('reference-analyze', { operationId: 'poll-analysis', styleId: style.id }))
    await f.jobs.drain()
    const adapter = new PollAdapter(), original = f.domain.require('run', started.runId)
    const records = [f.domain.require('style', style.id), original, runSchema.parse({ ...original, id: 'hidden-analysis' }), runSchema.parse({ ...original, id: 'foreign-analysis', owner: { kind: 'session', sessionId: 'foreign-session' } })]
    const pointers = records.map(record => {
      const digest = contentDigest(record), key = `${record.kind}-${digest.slice(10)}`
      adapter.records.set(key, record)
      return { key, kind: record.kind, id: record.id, digest }
    })
    adapter.commits.set('poll-fixture', { schemaVersion: 1, profileId: f.profileId, aggregateId: 'poll-fixture', revision: 1, records: pointers, state: {}, receipts: {} })
    adapter.commits.set('task-history-hidden:hidden-analysis', { schemaVersion: 1, profileId: f.profileId, aggregateId: 'task-history-hidden:hidden-analysis', revision: 1, records: [], state: { runId: 'hidden-analysis', hidden: true }, receipts: {} })
    const repository = new DomainRepository(f.profileId, adapter), domain = new CuratorDomain(f.profileId, repository)
    service = new CuratorService(f.host, f.service.config, { openDomain: async () => domain, providers: { source: async () => { throw new Error('Poll cannot search') }, vision: async () => { throw new Error('Poll cannot call a model') }, media: () => f.http } })
    await service.initialize()
    const activeService = service, expectedRevision = repository.revisionDigest()
    let clonedPointers = 0
    const readManifests = repository.manifests.bind(repository)
    repository.manifests = prefix => { const rows = readManifests(prefix); clonedPointers += rows.reduce((count, row) => count + row.records.length, 0); return rows }
    const poll = async () => z.object({ tasks: z.array(z.json()), analyses: z.array(analysisTaskSchema), workspaceRevision: z.string() }).parse(await activeService.action({ operation: 'gallery-reference-tasks', args: {} }, f.actor, new AbortController().signal))
    adapter.reset()
    const result = await poll()
    assert.deepEqual(result.tasks, [])
    assert.deepEqual(result.analyses.map(task => task.runId), [started.runId])
    assert.equal(result.analyses[0]?.observed, 1)
    assert.equal(result.analyses[0]?.total, 1)
    assert.equal(result.workspaceRevision, expectedRevision)
    assert.equal(adapter.manifestReads, 2, 'one pointer snapshot plus the existing history-hiding read; revisionDigest reuses the snapshot')
    assert.ok([...adapter.reads.values()].every(count => count === 1))
    assert.equal(clonedPointers, 0, 'poll history filtering must not clone unrelated task or request manifests')
    await repository.commit({ aggregateId: 'poll-next-revision', expectedRevision: 0, operationId: 'poll-next-revision', request: {}, records: [], state: {} })
    assert.notEqual((await poll()).workspaceRevision, expectedRevision)
    await assert.rejects(activeService.action({ operation: 'gallery-reference-tasks', args: {} }, { ...f.actor, kind: 'agent' }, new AbortController().signal), { code: 'owner-denied' })
  } finally { await service?.dispose(); await f.cleanup() }
})
