import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BudgetLedger, RunEngine, dataOf, decideAssessment, rankedSelections, type ExecutionSpec } from '../src/host/runtime.ts'
import { resolveConfig } from '../src/host/config.ts'
import { DomainRepository, MemoryDomainAdapter, contentDigest } from '../src/domain/repository.ts'
import { JobId, type JobOutcome, type JobRegistry } from '@deepseek-ai/dsh-jobs'
import { readFile } from 'node:fs/promises'

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
