import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analysisReadFixture } from './helpers/analysis-read-fixture.ts'
import { createAnalysisTaskReads } from '../src/host/analysis-task-reads.ts'
import { executionSchema, dataOf, toJson } from '../src/host/runtime.ts'
import { runSchema, type DomainActor } from '../src/shared/model.ts'

test('warm task summaries validate records without reparsing whole specs or listing complete runs', async context => {
  const f = await analysisReadFixture(), reads = createAnalysisTaskReads(() => ({ maxEntries: 8, maxBytes: 65536 }))
  const parse = context.mock.method(executionSchema, 'parse'), list = context.mock.method(f.repository, 'list')
  try {
    const first = reads.list(f.domain, f.engine, f.actor), count = parse.mock.callCount()
    assert.equal(first.length, 2); assert.equal(count, 2)
    first[0]!.continuation!.reason = 'ready'
    const again = reads.list(f.domain, f.engine, f.actor)
    assert.equal(parse.mock.callCount(), count)
    assert.equal(list.mock.calls.some(call => call.arguments[0] === 'run'), false)
    assert.equal(again.every(task => task.continuation?.reason === 'completed'), true)
    const style = f.domain.require('style', f.styleId)
    await f.domain.action('style-rename', { operationId: 'rename-summary', styleId: style.id, expectedRevision: style.revision, name: 'Renamed summary' }, f.actor)
    assert.equal(reads.get(f.domain, f.engine, f.actor, f.historical.id)!.name, 'Renamed summary')
    assert.equal(parse.mock.callCount(), count, 'A current name must not require parsing old model inputs')
  } finally { reads.dispose(); await f.cleanup() }
})

test('summary reuse checks current owner and storage integrity before reading cached facts', async () => {
  const f = await analysisReadFixture(), reads = createAnalysisTaskReads(() => ({ maxEntries: 8, maxBytes: 65536 }))
  try {
    const run = runSchema.parse({ ...f.historical, owner: { kind: 'session', sessionId: 'private-analysis-session' } })
    await f.commit([run], 'private-summary')
    const allowed: DomainActor = { ...f.actor, ...(run.owner.kind === 'session' ? { sessionId: run.owner.sessionId } : {}) }
    assert.ok(reads.get(f.domain, f.engine, allowed, run.id))
    assert.equal(reads.get(f.domain, f.engine, f.actor, run.id), undefined)
    assert.equal(reads.get(f.domain, f.engine, { ...allowed, profileId: 'foreign-profile' }, run.id), undefined)
    const pointer = f.repository.manifests().flatMap(manifest => manifest.records).find(item => item.kind === 'run' && item.id === run.id)!
    f.adapter.records.set(pointer.key, { ...run, createdAt: 'tampered-after-warm-read' })
    assert.throws(() => reads.get(f.domain, f.engine, allowed, run.id), { code: 'reference-unavailable' })
    f.adapter.records.delete(pointer.key)
    assert.throws(() => reads.get(f.domain, f.engine, allowed, run.id), { code: 'reference-unavailable' })
  } finally { reads.dispose(); await f.cleanup() }
})

test('changed or malformed frozen specs invalidate summary facts instead of hiding invalid execution input', async () => {
  const f = await analysisReadFixture(), reads = createAnalysisTaskReads(() => ({ maxEntries: 8, maxBytes: 65536 }))
  try {
    assert.ok(reads.get(f.domain, f.engine, f.actor, f.historical.id))
    const current = f.domain.require('run', f.historical.id), data = dataOf(current)
    await f.commit([runSchema.parse({ ...current, data: toJson({ ...data, counts: { ...data.counts, observed: 7 } }) })], 'summary-progress')
    assert.equal(reads.get(f.domain, f.engine, f.actor, current.id)!.observed, 7)
    await f.commit([runSchema.parse({ ...current, spec: { kind: 'future-analysis' } })], 'invalid-summary-spec')
    assert.throws(() => reads.get(f.domain, f.engine, f.actor, current.id))
  } finally { reads.dispose(); await f.cleanup() }
})

test('cached continuation budgets use the current clock and live phases remain independent of record revisions', async context => {
  const f = await analysisReadFixture(); let time = 1000
  const reads = createAnalysisTaskReads(() => ({ maxEntries: 8, maxBytes: 65536 }), () => time)
  try {
    const current = f.domain.require('run', f.historical.id), data = dataOf(current)
    await f.commit([runSchema.parse({ ...current, status: 'paused', data: toJson({ ...data, budget: { ...data.budget, deadlineAt: 2000 }, counts: { ...data.counts, observed: 0 } }) })], 'summary-deadline')
    let phase: 'receiving' | 'validating' = 'receiving'
    context.mock.method(f.engine, 'processPhase', () => phase)
    assert.equal(reads.get(f.domain, f.engine, f.actor, current.id)!.continuation!.reason, 'ready')
    assert.equal(reads.get(f.domain, f.engine, f.actor, current.id)!.phase, 'receiving')
    phase = 'validating'; time = 2000
    assert.equal(reads.get(f.domain, f.engine, f.actor, current.id)!.continuation!.reason, 'deadline')
    assert.equal(reads.get(f.domain, f.engine, f.actor, current.id)!.phase, 'validating')
    time = 900
    assert.equal(reads.get(f.domain, f.engine, f.actor, current.id)!.continuation!.reason, 'ready')
  } finally { reads.dispose(); await f.cleanup() }
})

test('summary caches obey entry and byte ceilings, zero policy and disposal', async context => {
  const f = await analysisReadFixture(); let maxBytes = 65536
  const reads = createAnalysisTaskReads(() => ({ maxEntries: 1, maxBytes })), parse = context.mock.method(executionSchema, 'parse')
  try {
    const ids = f.repository.recordIds('run')
    reads.get(f.domain, f.engine, f.actor, ids[0]!); reads.get(f.domain, f.engine, f.actor, ids[1]!); reads.get(f.domain, f.engine, f.actor, ids[0]!)
    assert.equal(parse.mock.callCount(), 3, 'The prior task is evicted at a one-entry ceiling')
    maxBytes = 1; reads.get(f.domain, f.engine, f.actor, ids[0]!); reads.get(f.domain, f.engine, f.actor, ids[0]!)
    assert.equal(parse.mock.callCount(), 5, 'Oversized summaries stay readable without retention')
    maxBytes = 0; reads.get(f.domain, f.engine, f.actor, ids[0]!); reads.get(f.domain, f.engine, f.actor, ids[0]!)
    assert.equal(parse.mock.callCount(), 7)
    maxBytes = 65536; reads.get(f.domain, f.engine, f.actor, ids[0]!); reads.dispose(); reads.get(f.domain, f.engine, f.actor, ids[0]!)
    assert.equal(parse.mock.callCount(), 9, 'Disposal releases all derived facts')
  } finally { reads.dispose(); await f.cleanup() }
})
