import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serviceFixture } from './helpers/service-fixture.ts'
import { analysisDetailSchema } from '../src/shared/analysis-process.ts'
import { DomainRepository, MemoryDomainAdapter } from '../src/domain/repository.ts'
import { deleteTaskHistory, hiddenTaskIds } from '../src/host/task-history.ts'
import { runSchema } from '../src/shared/model.ts'

test('deleting completed history keeps saved analysis, inputs and profile; listings stay deleted', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const style = await f.action('style-create', { name: 'History', operationId: 'history-style' }) as { id: string }
    await f.action('reference-import', { operationId: 'history-images', styleId: style.id, expectedRevision: 1, files: [{ name: 'saved.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    const started = await f.action('reference-analyze', { styleId: style.id, operationId: 'history-analysis', buildDataset: true }) as { runId: string }
    await f.jobs.drain()
    const before = analysisDetailSchema.parse(await f.action('analysis-detail', { runId: started.runId }))
    assert.equal(before.task.status, 'completed')
    const profiles = f.repository.list('modelProfile'), observations = f.repository.list('observation'), run = f.repository.get('run', started.runId)
    const args = { runId: started.runId, operationId: 'delete-history' }
    assert.deepEqual(await f.action('run-delete', args), { runId: started.runId, deleted: true })
    await f.action('run-delete', args)
    assert.equal(f.repository.manifest(`task-history-hidden:${started.runId}`)?.revision, 1)
    const listing = await f.action('snapshot') as { runs: { runId: string }[]; styles: { analysis?: { runId: string } }[] }
    assert.equal(listing.runs.length, 0)
    assert.equal(listing.styles[0]?.analysis?.runId, started.runId)
    const tasks = await f.action('gallery-reference-tasks') as { analyses: unknown[] }
    assert.deepEqual(tasks.analyses, [])
    assert.deepEqual(analysisDetailSchema.parse(await f.action('analysis-detail', { runId: started.runId })), before)
    assert.deepEqual(f.repository.list('modelProfile'), profiles)
    assert.deepEqual(f.repository.list('observation'), observations)
    assert.deepEqual(f.repository.get('run', started.runId), run)
    assert.ok(await f.action('analysis-input', { runId: started.runId, requestId: before.requests[0]!.requestId }))
    await assert.rejects(f.service.action({ operation: 'run-delete', args }, { ...f.actor, kind: 'agent' }, new AbortController().signal), { code: 'owner-denied' })
    await assert.rejects(f.service.action({ operation: 'run-delete', args }, { ...f.actor, profileId: 'foreign-profile' }, new AbortController().signal), { code: 'owner-denied' })
  } finally { await f.cleanup() }
})

test('deletion rejects unsettled tasks and retains its receipt across repository reopening', async () => {
  const adapter = new MemoryDomainAdapter(), repository = new DomainRepository('profile', adapter)
  const base = { schemaVersion: 1, profileId: 'profile', id: 'run', kind: 'run', createdAt: '2026-10-26T00:00:00.000Z', owner: { kind: 'profile' }, revision: 1, stage: null, spec: {}, data: {} }
  for (const status of ['created', 'running', 'pausing', 'paused', 'interrupted', 'cancelling']) await assert.rejects(deleteTaskHistory(repository, runSchema.parse({ ...base, status }), status), { code: 'constraint-conflict' })
  assert.equal(repository.manifests().length, 0)
  for (const status of ['completed', 'failed', 'cancelled']) await deleteTaskHistory(repository, runSchema.parse({ ...base, id: status, status }), status)
  assert.deepEqual([...hiddenTaskIds(new DomainRepository('profile', adapter))].sort(), ['cancelled', 'completed', 'failed'])
  adapter.failNextManifest = true
  await assert.rejects(deleteTaskHistory(repository, runSchema.parse({ ...base, status: 'failed' }), 'failed-write'), { code: 'storage-commit-failed' })
  assert.equal(hiddenTaskIds(repository).has('run'), false)
})
