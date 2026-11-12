/** Exact response recovery remains task-owned without loading unrelated request history. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DomainRepository, MemoryDomainAdapter, contentDigest } from '../src/domain/repository.ts'
import { requestSchema, runSchema } from '../src/shared/model.ts'
import { findWallpaperResponse } from '../src/host/wallpaper-requests.ts'

test('response recovery reads current receipts and explicit original receipts without reading unrelated history', async () => {
  const profileId = 'response-recovery', createdAt = '2026-11-12T00:00:00.000Z', base = { schemaVersion: 1, profileId, createdAt }
  const run = (id: string, requestIds: string[]) => runSchema.parse({ ...base, id, kind: 'run', owner: { kind: 'profile' }, revision: 1, status: 'running', stage: 'planning', spec: {}, data: { attemptId: 'attempt', attempts: 1, budget: { vision: 0, search: 0, downloadBytes: 0, deadlineAt: 1 }, checkpoint: {}, counts: {}, warnings: [], resultIds: [], requestIds } })
  const digest = contentDigest('prepared-request'), current = run('current', ['pending']), parent = run('parent', ['saved'])
  const requests = [requestSchema.parse({ ...base, kind: 'request', id: 'pending', runId: current.id, state: 'reserved', requestDigest: digest, data: {} }), requestSchema.parse({ ...base, kind: 'request', id: 'saved', runId: parent.id, state: 'committed', requestDigest: digest, data: { output: { result: 'saved response' } } }), requestSchema.parse({ ...base, kind: 'request', id: 'unrelated', runId: 'unrelated-run', state: 'committed', requestDigest: digest, data: { unrelated: 'history' } })]
  const adapter = new MemoryDomainAdapter(), repository = new DomainRepository(profileId, adapter)
  await repository.commit({ aggregateId: 'records', expectedRevision: 0, operationId: 'seed', request: {}, records: [current, parent, ...requests], state: {} })
  const unrelatedKey = repository.manifest('records')!.records.find(pointer => pointer.id === 'unrelated')!.key
  const read = adapter.readRecord.bind(adapter)
  adapter.readRecord = key => { assert.notEqual(key, unrelatedKey, 'Unrelated request bodies must remain unread'); return read(key) }
  assert.equal(findWallpaperResponse(repository, current, 'parent:image:detail:1', digest, false), undefined)
  assert.equal(findWallpaperResponse(repository, current, 'parent:image:detail:1', digest, true)?.id, 'saved')
  assert.equal(findWallpaperResponse(repository, current, 'parent:image:detail:1', contentDigest('other-request'), true), undefined)
  assert.equal(findWallpaperResponse(repository, current, 'missing:image:detail:1', digest, true), undefined)
  const wrongOwnership = run('current', ['saved'])
  assert.equal(findWallpaperResponse(repository, wrongOwnership, 'current:image:detail:1', digest, false), undefined)
})
