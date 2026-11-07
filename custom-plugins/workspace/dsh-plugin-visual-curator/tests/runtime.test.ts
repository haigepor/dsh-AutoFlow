import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BudgetLedger, RunEngine, dataOf, decideAssessment, rankedSelections, readRunContinuation, runContinuation, type ExecutionSpec } from '../src/host/runtime.ts'
import { resolveConfig } from '../src/host/config.ts'
import { DomainRepository, MemoryDomainAdapter, contentDigest } from '../src/domain/repository.ts'
import { JobId, type JobOutcome, type JobRegistry } from '@deepseek-ai/dsh-jobs'
import { readFile } from 'node:fs/promises'
import { requestSchema, runSchema } from '../src/shared/model.ts'
import { MediaError } from '../src/media/index.ts'

function progressFixture() {
  const adapter = new MemoryDomainAdapter(), repository = new DomainRepository('progress-profile', adapter)
  const updates: { text: string; counts: Record<string, number> }[] = [], completions: Promise<JobOutcome>[] = []
  const jobs: Pick<JobRegistry, 'start'> = { start(spec) {
    const id = JobId(`progress-${completions.length}`)
    const hook = spec.run({ id, append: () => {}, updateProgress: text => { updates.push({ text, counts: dataOf(repository.list('run')[0]!).counts }) } })
    completions.push(hook.done)
    return id
  } }
  const config = resolveConfig({}), spec: ExecutionSpec = { kind: 'search', config, input: { targetCount: 10 }, fixed: {}, specDigest: contentDigest('progress-fixture') }
  const actor = { kind: 'human' as const, id: 'progress-owner', profileId: repository.profileId }
  return { adapter, repository, updates, completions, spec, actor, engine: new RunEngine(repository, jobs) }
}

test('last shared vision reservation cannot be spent twice; retries spend again', async () => {
  const limits = { ...resolveConfig({}).limits, maxVisionCalls: 1 }
  const ledger = new BudgetLedger(limits)
  const attempts = await Promise.allSettled([ledger.reserve('vision'), ledger.reserve('vision')])
  assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1)
  assert.equal(ledger.snapshot().vision, 1)
})
test('required failures and unknown cannot be averaged away by preferred scores', () => {
  assert.equal(decideAssessment([{ strength: 'required', result: 'violated' }]), 'reject')
  assert.equal(decideAssessment([{ strength: 'required', result: 'unknown' }]), 'needs-review')
  assert.equal(decideAssessment([{ strength: 'preferred', result: 'violated' }]), 'pass')
})
test('saved assessments have stable deterministic ranking', () => {
  assert.deepEqual(rankedSelections([{ id: 'b', score: 4 }, { id: 'a', score: 4 }, { id: 'c', score: 5 }]).map(x => x.id), ['c', 'a', 'b'])
})

test('continuation list reads retain exact outcome policy without cloning heavy or unrelated request bodies', async context => {
  const f = progressFixture(), now = Date.now(), payload = 'Synthetic context. '.repeat(16384)
  const cases = [
    { state: 'reserved', data: { operation: 'review', payload }, reason: 'outcome-unknown' },
    { state: 'outcome-unknown', data: { bundle: { operation: 'review', payload }, error: { outcome: 'unknown', code: 'remote-timeout' } }, reason: 'outcome-unknown' },
    { state: 'outcome-unknown', data: { bundle: { operation: 'review', payload }, error: { outcome: 'unknown', code: 'cancelled' } }, reason: 'ready' },
    { state: 'outcome-unknown', data: { bundle: { operation: 'review', payload }, error: { code: 'vision-invalid-output' } }, reason: 'ready' },
    { state: 'reserved', data: { operation: 'wallpaper-review', payload }, reason: 'ready' },
    { state: 'outcome-unknown', data: { bundle: { operation: 123 }, error: { outcome: 'unknown' }, payload }, reason: 'ready' },
    { state: 'committed', data: { bundle: { operation: 'review', payload }, output: { pass: true } }, reason: 'ready' },
  ]
  const requests = cases.map((row, index) => requestSchema.parse({ schemaVersion: 1, profileId: f.repository.profileId, id: `target-${index}`, createdAt: '2026-11-07T00:00:00.000Z', kind: 'request', runId: `run-${index}`, state: row.state, requestDigest: contentDigest(index), data: row.data }))
  const foreign = requestSchema.parse({ ...requests[0], id: 'foreign', runId: 'another-run' })
  try {
    await f.repository.commit({ aggregateId: 'continuation-history', expectedRevision: 0, operationId: 'history', request: {}, records: [...requests, foreign], state: {} })
    let requestClones = 0
    const clone = structuredClone
    context.mock.method(globalThis, 'structuredClone', <T>(value: T): T => { if (value && typeof value === 'object' && 'kind' in value && value.kind === 'request') requestClones++; return clone(value) })
    for (const [index, request] of requests.entries()) {
      const run = runSchema.parse({ schemaVersion: 1, profileId: f.repository.profileId, id: request.runId, createdAt: request.createdAt, kind: 'run', owner: { kind: 'profile' }, revision: 1, status: 'paused', stage: 'reviewing', spec: f.spec, data: { attemptId: 'saved', attempts: 1, budget: { ...new BudgetLedger(f.spec.config.limits).snapshot(), deadlineAt: now + 60000 }, checkpoint: {}, counts: {}, warnings: [], resultIds: [], requestIds: [request.id, foreign.id] } })
      const expected = { allowed: cases[index]!.reason === 'ready', reason: cases[index]!.reason }
      assert.deepEqual(readRunContinuation(run, f.repository, now), expected)
      assert.deepEqual(runContinuation(run, [request, foreign], now), expected)
      for (const status of ['running', 'completed', 'cancelled'] as const) {
        const before = f.adapter.readRecord.bind(f.adapter)
        let reads = 0; f.adapter.readRecord = key => { reads++; return before(key) }
        try {
          assert.deepEqual(readRunContinuation({ ...run, status }, f.repository, now), runContinuation({ ...run, status }, [request, foreign], now))
          assert.equal(reads, 0, `${status} does not inspect request outcomes`)
        } finally { f.adapter.readRecord = before }
      }
    }
    assert.equal(requestClones, 0)
  } finally { await f.engine.dispose() }
})

test('job progress reports saved image-search stages, candidates and matches', async () => {
  const f = progressFixture()
  try {
    await f.engine.create(f.spec, f.actor, async ctx => {
      await ctx.save('planning', {})
      await ctx.save('retrieving', { counts: { candidates: 12, distinct: 10, qualified: 3 } })
      await ctx.save('screening', { counts: { candidates: 18, distinct: 15, qualified: 6, failedQueries: 1, technicalFailed: 2, unavailable: 1 } })
      await ctx.save('finalizing', { counts: { candidates: 24, distinct: 20, qualified: 10 } })
      return 'target-met'
    })
    await Promise.all(f.completions)
    assert.deepEqual(f.updates.map(update => update.text), JSON.parse(await readFile(new URL('./fixtures/runtime-progress.expected.json', import.meta.url), 'utf8')))
    assert.deepEqual(f.updates.map(update => update.counts.qualified), [undefined, 3, 6, 10])
  } finally { await f.engine.dispose() }
})

test('job progress waits for persistence and never announces a rejected checkpoint', async () => {
  const f = progressFixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), saved = Promise.withResolvers<void>(), rejectNext = Promise.withResolvers<void>()
  const write = f.adapter.writeManifest.bind(f.adapter)
  let hold = false
  f.adapter.writeManifest = async manifest => { if (hold) { hold = false; entered.resolve(); await release.promise } await write(manifest) }
  try {
    const run = await f.engine.create(f.spec, f.actor, async ctx => {
      hold = true
      await ctx.save('screening', { counts: { candidates: 12, qualified: 3 } })
      saved.resolve()
      await rejectNext.promise
      f.adapter.failNextManifest = true
      await ctx.save('screening', { counts: { candidates: 99, qualified: 9 } })
      return 'target-met'
    })
    await entered.promise
    assert.equal(f.updates.length, 0)
    release.resolve()
    await saved.promise
    assert.deepEqual(f.updates.map(update => update.counts), [{ candidates: 12, qualified: 3 }])
    rejectNext.resolve()
    await Promise.all(f.completions)
    assert.equal(f.engine.get(run.id, f.actor).status, 'failed')
    assert.deepEqual(f.updates.map(update => update.counts), [{ candidates: 12, qualified: 3 }])
    assert.ok(f.updates.every(update => !update.text.includes('99') && !update.text.includes('9/10')))
  } finally { release.resolve(); rejectNext.resolve(); await Promise.all(f.completions); await f.engine.dispose() }
})

test('request retries inspect only their task receipts and preserve the shared call budget', async () => {
  const f = progressFixture()
  const foreign = requestSchema.parse({ schemaVersion: 1, profileId: f.repository.profileId, id: 'foreign-request', createdAt: '2026-11-07T00:00:00.000Z', kind: 'request', runId: 'foreign-run', state: 'outcome-unknown', requestDigest: contentDigest({ operation: 'review' }), data: { error: { code: 'remote-timeout', stage: 'fixture', retryable: true, safeMessage: 'Synthetic timeout', suggestedAction: 'Retry' } } })
  await f.repository.commit({ aggregateId: 'foreign-history', expectedRevision: 0, operationId: 'foreign', request: {}, records: [foreign], state: {} })
  const foreignKeys = new Set(f.adapter.manifests().flatMap(manifest => manifest.records.filter(pointer => pointer.id === foreign.id).map(pointer => pointer.key)))
  const read = f.adapter.readRecord.bind(f.adapter)
  let foreignReads = 0, dispatched = 0
  f.adapter.readRecord = key => { if (foreignKeys.has(key)) foreignReads++; return read(key) }
  f.spec.config = resolveConfig({ limits: { maxRetryAttempts: 1, retryDelayMs: 0 } })
  try {
    const run = await f.engine.create(f.spec, f.actor, async ctx => {
      await ctx.request('vision', { operation: 'review' }, async () => {
        if (++dispatched === 1) throw new MediaError('remote-timeout', 'fixture', true, 'Synthetic timeout', 'Retry')
        return { pass: true }
      })
      return 'target-met'
    })
    await Promise.all(f.completions)
    assert.equal(f.engine.get(run.id, f.actor).outcome, 'target-met')
    assert.equal(dispatched, 2)
    assert.equal(dataOf(f.engine.get(run.id, f.actor)).budget.vision, 2)
    assert.equal(dataOf(f.engine.get(run.id, f.actor)).requestIds.length, 2)
    assert.equal(foreignReads, 0, 'Retry admission must not load unrelated request bodies')
  } finally { f.adapter.readRecord = read; await f.engine.dispose() }
})

test('missing and foreign saved request receipts stop before another paid dispatch', async () => {
  for (const mode of ['missing', 'foreign'] as const) {
    const f = progressFixture()
    const receipt = requestSchema.parse({ schemaVersion: 1, profileId: f.repository.profileId, id: 'saved-request', createdAt: '2026-11-07T00:00:00.000Z', kind: 'request', runId: 'different-run', state: 'committed', requestDigest: contentDigest({ operation: 'review' }), data: {} })
    if (mode === 'foreign') await f.repository.commit({ aggregateId: 'foreign-history', expectedRevision: 0, operationId: 'foreign', request: {}, records: [receipt], state: {} })
    let dispatched = 0
    try {
      const run = await f.engine.create(f.spec, f.actor, async ctx => {
        await ctx.save('planning', { requestIds: [receipt.id] })
        await ctx.request('vision', { operation: 'review' }, async () => { dispatched++; return { pass: true } })
        return 'target-met'
      })
      await Promise.all(f.completions)
      const saved = f.engine.get(run.id, f.actor)
      assert.equal(saved.status, 'failed', mode)
      assert.equal(dataOf(saved).error?.code, 'reference-unavailable', mode)
      assert.equal(dataOf(saved).error?.stage, 'request-history', mode)
      assert.equal(dispatched, 0, mode)
      assert.equal(dataOf(saved).budget.vision, 0, mode)
    } finally { await f.engine.dispose() }
  }
})
