import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { analysisReadFixture } from './helpers/analysis-read-fixture.ts'
import { analysisPlanFixture } from './helpers/analysis-plan-fixture.ts'
import { readAnalysisDetail } from '../src/host/analysis-detail.ts'
import { dataOf, specOf, toJson } from '../src/host/runtime.ts'
import { requestSchema, runSchema } from '../src/shared/model.ts'
import { analysisDetailSchema } from '../src/shared/analysis-process.ts'
import { createCuratorStore } from '../src/client/store.ts'
import { analysisContextUsage } from '../src/client/analysis-context.ts'

type Fixture = Awaited<ReturnType<typeof analysisReadFixture>>
async function progress(f: Fixture, count: number, operationId: string) {
  const { outcome: _outcome, ...current } = f.domain.require('run', f.historical.id), data = dataOf(current)
  const observations = f.records.filter(record => record.kind === 'observation').slice(0, count)
  const run = runSchema.parse({ ...current, status: 'running', data: toJson({ ...data, resultIds: observations.map(record => record.id), counts: { ...data.counts, observed: count } }) })
  await f.commit([run], operationId)
  return run
}
async function usage(f: Fixture, inputTokens: number, operationId: string) {
  const id = dataOf(f.domain.require('run', f.historical.id)).requestIds[0]!, saved = f.domain.require('request', id)
  const data = z.record(z.string(), z.json()).parse(saved.data)
  await f.commit([requestSchema.parse({ ...saved, data: toJson({ ...data, metadata: { transport: 'native-llm', provider: 'synthetic', context: { contextWindow: 1000 }, usage: { inputTokens, outputTokens: 0 }, timing: { elapsedMs: 1 } } }) })], operationId)
}

test('the production service route and Client exchange cursors while updating usage on the same saved request', async () => {
  const f = await analysisPlanFixture(8, 4), calls: Record<string, unknown>[] = []
  const observations = f.records.filter(record => record.kind === 'observation')
  async function commit(count: number, inputTokens: number, operationId: string) {
    const run = f.domain.require('run', f.historical.id), data = dataOf(run), request = f.domain.require('request', data.requestIds[0]!)
    const requestData = z.record(z.string(), z.json()).parse(request.data), manifest = f.repository.manifest(f.aggregateId)!
    await f.repository.commit({ aggregateId: manifest.aggregateId, expectedRevision: manifest.revision, operationId, request: {}, state: manifest.state, records: [
      runSchema.parse({ ...run, data: toJson({ ...data, resultIds: observations.slice(0, count).map(row => row.id), counts: { ...data.counts, observed: count } }) }),
      requestSchema.parse({ ...request, data: toJson({ ...requestData, metadata: { transport: 'native-llm', provider: 'synthetic-service', context: { contextWindow: 1000 }, usage: { inputTokens, outputTokens: 0 }, timing: { elapsedMs: 1 } } }) }),
    ] })
  }
  const store = createCuratorStore({ invoke: async (operation, args) => {
    calls.push(args)
    return f.service.action({ operation, args }, f.actor, new AbortController().signal)
  } })
  try {
    await commit(1, 10, 'service-initial')
    store.openAnalysis(f.historical.id); await store.refreshAnalysisDetail()
    const first = store.getSnapshot().analysisDetail!
    assert.equal(first.observations.length, 1); assert.equal(analysisContextUsage(first.requests).usedTokens, 10)
    await commit(2, 50, 'service-appended')
    await store.refreshAnalysisDetail()
    const current = store.getSnapshot().analysisDetail!
    assert.equal(calls[1]!.observationCursor, first.observationCursor)
    assert.deepEqual(current.observations.map(row => row.imageVersionId), ['plan-image-0', 'plan-image-1'])
    assert.equal(current.images.length, 4)
    assert.equal(current.requests[0]!.requestId, first.requests[0]!.requestId)
    assert.equal(analysisContextUsage(current.requests).usedTokens, 50)
    assert.equal(f.http.operations.length, 2, 'Reading progress must not invoke the model again')
  } finally { store.dispose(); await f.cleanup() }
})

test('incremental analysis keeps ordered observations and complete current request usage through Client refresh', async () => {
  const f = await analysisReadFixture(), calls: Record<string, unknown>[] = []
  await progress(f, 2, 'partial-two'); await usage(f, 10, 'usage-ten')
  const store = createCuratorStore({ invoke: async (operation, args) => {
    assert.equal(operation, 'analysis-detail'); calls.push(args)
    return readAnalysisDetail(f.domain, f.engine, f.actor, args)
  } })
  try {
    store.openAnalysis(f.historical.id); await store.refreshAnalysisDetail()
    const first = store.getSnapshot().analysisDetail!
    assert.equal(first.observations.length, 2); assert.equal(first.images.length, 12)
    assert.equal(analysisContextUsage(first.requests).usedTokens, 10)
    await progress(f, 3, 'partial-three'); await usage(f, 20, 'usage-twenty')
    const suffix = readAnalysisDetail(f.domain, f.engine, f.actor, { runId: f.historical.id, observationCursor: first.observationCursor })
    assert.equal(suffix.observations.length, 1); assert.deepEqual(suffix.images, []); assert.equal(suffix.observationBase, first.observationCursor)
    await store.refreshAnalysisDetail()
    const loaded = store.getSnapshot().analysisDetail!.observations
    await store.refreshAnalysisDetail()
    const current = store.getSnapshot().analysisDetail!
    assert.equal(current.observations, loaded, 'Usage-only refreshes retain the loaded observation array')
    const unchanged = readAnalysisDetail(f.domain, f.engine, f.actor, { runId: f.historical.id, observationCursor: current.observationCursor })
    const actual = { firstCount: first.observations.length, appendedCount: suffix.observations.length, unchangedCount: unchanged.observations.length,
      observationOrder: current.observations.map(row => row.imageVersionId), retainedImages: current.images.length, requestCount: current.requests.length,
      usedTokens: analysisContextUsage(current.requests).usedTokens, sendsCursor: calls.slice(1).every(args => typeof args.observationCursor === 'string'),
      boundedCursor: Buffer.byteLength(current.observationCursor!) <= 2048 }
    assert.deepEqual(actual, JSON.parse(await readFile(new URL('./fixtures/analysis-refresh.expected.json', import.meta.url), 'utf8')))
  } finally { store.dispose(); await f.cleanup() }
})

test('changed observation prefixes and frozen references return replacements rather than appending stale results', async () => {
  const f = await analysisReadFixture()
  try {
    const run = await progress(f, 2, 'prefix-two'), first = readAnalysisDetail(f.domain, f.engine, f.actor, { runId: run.id }), data = dataOf(run)
    await f.commit([runSchema.parse({ ...run, data: toJson({ ...data, resultIds: [...data.resultIds].reverse() }) })], 'prefix-reordered')
    const replaced = readAnalysisDetail(f.domain, f.engine, f.actor, { runId: run.id, observationCursor: first.observationCursor })
    assert.equal(replaced.observationBase, undefined); assert.equal(replaced.images.length, 12)
    assert.deepEqual(replaced.observations.map(row => row.imageVersionId), ['plan-image-1', 'plan-image-0'])
    const current = f.domain.require('run', run.id), spec = specOf(current)
    const references = z.array(z.json()).parse(spec.fixed.references)
    await f.commit([runSchema.parse({ ...current, spec: toJson({ ...spec, fixed: { ...spec.fixed, references: references.reverse() } }) })], 'references-reordered')
    const changed = readAnalysisDetail(f.domain, f.engine, f.actor, { runId: run.id, observationCursor: replaced.observationCursor })
    assert.equal(changed.observationBase, undefined); assert.equal(changed.images.length, 12)
  } finally { await f.cleanup() }
})

test('incremental reads still reject tampered old observations and unavailable current images', async () => {
  const f = await analysisReadFixture()
  try {
    const run = await progress(f, 2, 'integrity-two'), first = readAnalysisDetail(f.domain, f.engine, f.actor, { runId: run.id })
    const observationPointer = f.repository.manifests().flatMap(manifest => manifest.records).find(pointer => pointer.kind === 'observation' && pointer.id === dataOf(run).resultIds[0])!
    const saved = f.adapter.records.get(observationPointer.key)!
    f.adapter.records.set(observationPointer.key, { ...saved, createdAt: 'tampered-prefix' })
    assert.throws(() => readAnalysisDetail(f.domain, f.engine, f.actor, { runId: run.id, observationCursor: first.observationCursor }), { code: 'reference-unavailable' })
    f.adapter.records.set(observationPointer.key, saved)
    const imagePointer = f.repository.manifests().flatMap(manifest => manifest.records).find(pointer => pointer.kind === 'imageVersion' && pointer.id === first.images[0]!.imageVersionId)!
    f.adapter.records.delete(imagePointer.key)
    assert.throws(() => readAnalysisDetail(f.domain, f.engine, f.actor, { runId: run.id, observationCursor: first.observationCursor }), { code: 'reference-unavailable' })
  } finally { await f.cleanup() }
})

test('owner changes and removed observation pointers cannot preserve a stale prefix', async () => {
  const f = await analysisReadFixture()
  try {
    const run = await progress(f, 2, 'scope-two'), first = readAnalysisDetail(f.domain, f.engine, f.actor, { runId: run.id })
    const otherHuman = readAnalysisDetail(f.domain, f.engine, { ...f.actor, id: 'another-profile-owner' }, { runId: run.id, observationCursor: first.observationCursor })
    assert.equal(otherHuman.observationBase, undefined)
    const id = dataOf(run).resultIds[0]!
    for (const manifest of f.adapter.commits.values()) if (manifest.records.some(pointer => pointer.kind === 'observation' && pointer.id === id)) f.adapter.commits.set(manifest.aggregateId, { ...manifest, revision: manifest.revision + 1, records: manifest.records.filter(pointer => pointer.kind !== 'observation' || pointer.id !== id) })
    const removed = readAnalysisDetail(f.domain, f.engine, f.actor, { runId: run.id, observationCursor: first.observationCursor })
    assert.equal(removed.observationBase, undefined); assert.deepEqual(removed.observations.map(row => row.imageVersionId), ['plan-image-1'])
    await f.commit([runSchema.parse({ ...run, owner: { kind: 'session', sessionId: 'another-session' } })], 'private-read')
    assert.throws(() => readAnalysisDetail(f.domain, f.engine, f.actor, { runId: run.id, observationCursor: first.observationCursor }), { code: 'owner-denied' })
  } finally { await f.cleanup() }
})

test('Client rejects mismatched delta bases and a replacement response resets earlier observations', async () => {
  const f = await analysisReadFixture(); await progress(f, 2, 'client-prefix')
  const first = readAnalysisDetail(f.domain, f.engine, f.actor, { runId: f.historical.id }); let response = first
  const store = createCuratorStore({ invoke: async () => response })
  try {
    store.openAnalysis(f.historical.id); await store.refreshAnalysisDetail()
    response = analysisDetailSchema.parse({ ...first, observationBase: 'another-prefix', observations: [] })
    await store.refreshAnalysisDetail()
    assert.ok(store.getSnapshot().analysisError)
    assert.equal(store.getSnapshot().analysisDetail!.observations.length, 2)
    response = analysisDetailSchema.parse({ ...first, observationBase: undefined, observations: first.observations.slice(0, 1) })
    await store.refreshAnalysisDetail()
    assert.equal(store.getSnapshot().analysisError, null); assert.equal(store.getSnapshot().analysisDetail!.observations.length, 1)
  } finally { store.dispose(); await f.cleanup() }
})
