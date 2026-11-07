/** Task checkpoints read their saved request identities without loading unrelated history. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CuratorDomain } from '../src/domain/curator.ts'
import { DomainRepository, MemoryDomainAdapter, contentDigest } from '../src/domain/repository.ts'
import { resolveCurrentConfig } from '../src/host/config.ts'
import { presentRun } from '../src/host/task-presentation.ts'
import { requestSchema, runSchema, type RecordOf } from '../src/shared/model.ts'
import { runPresentationSchema } from '../src/shared/task-presentation.ts'

const stamp = '2026-11-01T00:00:00.000Z'
const common = { launchId: 'launch', brief: 'A saved scene search', target: 2, outputKind: 'preview', pollMs: 2000, wallpaper: false, modelProfileId: 'profile', styleId: 'style', profileRevision: 1, model: { model: 'fixture' } }
function request(id: string, seconds: number, digest: string, failed = false, runId = 'run') {
  return requestSchema.parse({ schemaVersion: 1, profileId: 'fixture', id, createdAt: new Date(Date.parse(stamp) + seconds * 1000).toISOString(), kind: 'request', runId, state: 'committed', requestDigest: contentDigest(digest), data: { bundle: { operation: 'review' }, ...(failed ? { error: { code: 'fixture-failure', safeMessage: 'The saved request failed.' } } : { output: { verdict: 'pass' } }) } })
}
async function fixture(requestIds: string[], requests: RecordOf<'request'>[]) {
  const adapter = new MemoryDomainAdapter(), repository = new DomainRepository('fixture', adapter), domain = new CuratorDomain('fixture', repository)
  const run = runSchema.parse({ schemaVersion: 1, profileId: 'fixture', id: 'run', createdAt: stamp, kind: 'run', owner: { kind: 'profile' }, revision: 1, status: 'running', stage: 'reviewing', spec: { kind: 'search', config: resolveCurrentConfig({ limits: { pageSize: 2 } }), input: {}, fixed: {}, specDigest: 'fixture' }, data: { attemptId: 'attempt', attempts: 1, budget: { vision: 0, search: 0, downloadBytes: 0, deadlineAt: Date.parse(stamp) + 600000 }, checkpoint: {}, counts: {}, warnings: [], resultIds: [], requestIds } })
  await repository.commit({ aggregateId: 'fixture', expectedRevision: 0, operationId: 'fixture', request: {}, records: [run, ...requests], state: {} })
  return { adapter, repository, present: () => repository.readSnapshot(() => runPresentationSchema.parse(presentRun(domain, run, common, stamp))) }
}

test('saved requests retain chronological retries and separate recent failure history without reading another task', async () => {
  const f = await fixture(['last', 'third', 'second', 'first'], [request('first', 1, 'same', true), request('second', 2, 'same'), request('third', 3, 'other', true), request('last', 4, 'same'), request('unrelated', 5, 'foreign', false, 'another-run')])
  const read = f.adapter.readRecord.bind(f.adapter)
  f.adapter.readRecord = key => {
    const record = read(key)
    if (record?.kind === 'request' && record.runId !== 'run') throw new Error('Unrelated task request is unavailable')
    return record
  }
  try {
    const shown = f.present()
    assert.equal(shown.requestCount, 4)
    assert.deepEqual(shown.requests.map(row => [row.id, row.attempt]), [['third', 1], ['last', 3]])
    assert.deepEqual(shown.failures.map(row => [row.id, row.attempt]), [['first', 1], ['third', 1]])
    assert.equal(shown.requests[1]?.output, '{"verdict":"pass"}')
  } finally { await f.repository.close() }
})

test('a missing request referenced by a saved task cannot produce a complete checkpoint', async () => {
  const f = await fixture(['missing'], [])
  try { assert.throws(f.present, { code: 'reference-unavailable' }) }
  finally { await f.repository.close() }
})

test('a request from another task cannot enter its checkpoint', async () => {
  const f = await fixture(['foreign'], [request('foreign', 1, 'foreign', false, 'another-run')])
  try { assert.throws(f.present, { code: 'reference-unavailable', stage: 'task-presentation' }) }
  finally { await f.repository.close() }
})
