/** Analysis ranges retain current role counts and reuse only registered committed requests. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { analysisPlanFixture } from './helpers/analysis-plan-fixture.ts'
import { analysisRoleCounts, referenceStateSchema } from '../src/shared/reference-state.ts'
import { dataOf, specOf } from '../src/host/runtime.ts'
import { planReferenceAnalysis, validObservationReuse } from '../src/host/reference-state.ts'
import { recipeSchema, requestSchema } from '../src/shared/model.ts'

test('329-image planning reports roles for each range without scanning unrelated request history', async () => {
  const f = await analysisPlanFixture(), list = f.repository.list.bind(f.repository), get = f.repository.get.bind(f.repository), requests = new Set<string>()
  try {
    const unrelated = requestSchema.parse({ ...f.repository.list('request')[0]!, id: 'unrelated-request', runId: 'unrelated-run', data: { trace: 'Unrelated model history. '.repeat(1024) } })
    await f.repository.commit({ aggregateId: 'unrelated-requests', expectedRevision: 0, operationId: 'unrelated-request', request: {}, state: {}, records: [unrelated] })
    f.repository.list = kind => { assert.notEqual(kind, 'request', 'Analysis preflight must not load a profile-wide request table'); return list(kind) }
    f.repository.get = (kind, id) => { if (kind === 'request') { assert.notEqual(id, unrelated.id); requests.add(id) }; return get(kind, id) }
    const plan = referenceStateSchema.parse(await f.action('reference-state', { styleId: f.styleId }))
    assert.deepEqual([plan.total, plan.reusable, plan.pending, plan.changed], [329, 299, 30, 0])
    assert.deepEqual(analysisRoleCounts(plan, 'all'), { positive: 299, negative: 30, undecided: 0, mixed: 0 })
    assert.deepEqual(analysisRoleCounts(plan, 'pending'), { positive: 0, negative: 30, undecided: 0, mixed: 0 })
    assert.deepEqual([...requests].sort(), dataOf(f.historical).requestIds.sort())
  } finally { f.repository.list = list; f.repository.get = get; await f.cleanup() }
})

test('reuse validation reads each source run once and still detects a changed reference role', async () => {
  const f = await analysisPlanFixture(20, 18), get = f.repository.get.bind(f.repository)
  try {
    const recipe = recipeSchema.parse(specOf(f.historical).fixed.recipe)
    const plan = f.repository.readSnapshot(() => planReferenceAnalysis(f.domain, f.styleId, f.actor, recipe))
    const input = { draft: plan.draft, references: plan.references, feedback: plan.feedback, recipe, analysisOutput: 'observations-only' }
    let sourceReads = 0
    f.repository.get = (kind, id) => { if (kind === 'run') sourceReads++; return get(kind, id) }
    assert.equal(f.repository.readSnapshot(() => validObservationReuse(f.domain, input, plan.reused, f.actor)), true)
    assert.equal(sourceReads, 1)
    const changed = { ...input, references: input.references.map((reference, index) => index ? reference : { ...reference, role: 'negative' }) }
    assert.equal(f.repository.readSnapshot(() => validObservationReuse(f.domain, changed, plan.reused, f.actor)), false)
  } finally { f.repository.get = get; await f.cleanup() }
})

test('an uncommitted source request never counts as a reusable observation', async () => {
  const f = await analysisPlanFixture(4, 3)
  try {
    const requestId = dataOf(f.historical).requestIds[0]!, manifest = f.repository.manifest(f.aggregateId)!
    await f.repository.commit({ aggregateId: f.aggregateId, expectedRevision: manifest.revision, operationId: 'unknown-source-request', request: {}, state: {}, records: f.records.map(record => record.kind === 'request' && record.id === requestId ? requestSchema.parse({ ...record, state: 'outcome-unknown' }) : record) })
    const plan = referenceStateSchema.parse(await f.action('reference-state', { styleId: f.styleId }))
    assert.deepEqual([plan.reusable, plan.pending, plan.changed], [0, 4, 3])
  } finally { await f.cleanup() }
})

test('role counts deduplicate repeated references and keep mixed or undecided roles explicit', () => {
  const plan = referenceStateSchema.parse({ styleId: 'style', revision: 1, digest: 'scope', total: 2, pending: 2, reusable: 0, changed: 0, entries: [{ referenceId: 'positive', imageVersionId: 'same-image', role: 'positive', state: 'pending' }, { referenceId: 'negative', imageVersionId: 'same-image', role: 'negative', state: 'pending' }, { referenceId: 'undecided', imageVersionId: 'other-image', role: 'undecided', state: 'pending' }] })
  assert.deepEqual(analysisRoleCounts(plan, 'all'), { positive: 0, negative: 0, mixed: 1, undecided: 1 })
})
