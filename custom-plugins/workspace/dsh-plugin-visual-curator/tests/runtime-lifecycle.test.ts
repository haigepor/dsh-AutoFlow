import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { JobRegistry, JobHooks, JobId } from '@deepseek-ai/dsh-jobs'
import { DomainRepository, MemoryDomainAdapter, contentDigest } from '../src/domain/index.ts'
import { RunEngine, BudgetLedger, dataOf, specOf, toJson, type ExecutionSpec } from '../src/host/runtime.ts'
import { settingsSchema, limitsSchema } from '../src/host/config.ts'
import { requestSchema, type DomainActor, type RunRecord } from '../src/shared/model.ts'

const human: DomainActor = { kind: 'human', id: 'human-a', profileId: 'profile-a' }
const agent: DomainActor = { kind: 'agent', id: 'agent-a', profileId: 'profile-a', sessionId: 'session-a' }
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}
class FixtureJobs implements Pick<JobRegistry, 'start'> {
  readonly hooks: JobHooks[] = []
  rejectStart = false
  start: JobRegistry['start'] = spec => {
    if (this.rejectStart) throw new Error('No controller for owner')
    const id = brandString<JobId>(`fixture-${this.hooks.length}`)
    const hooks = spec.run({ id, append: () => {}, updateProgress: () => {} })
    this.hooks.push(hooks)
    return id
  }
}
function setup() {
  const repository = new DomainRepository('profile-a', new MemoryDomainAdapter())
  const jobs = new FixtureJobs()
  return { repository, jobs, engine: new RunEngine(repository, jobs) }
}
function spec(): ExecutionSpec {
  const config = settingsSchema.parse({ limits: { maxVisionCalls: 2, maxRetryAttempts: 0 } })
  return { kind: 'search', config, input: { taskBrief: 'fixture' }, fixed: { release: { id: 'release-a' } }, specDigest: contentDigest('fixed-spec') }
}

describe('durable run lifecycle', () => {
  it('retains the exact spec/checkpoint and creates a new attempt after pause', async () => {
    const { engine, jobs } = setup()
    const entered = deferred(), wait = deferred()
    const fixed = spec()
    const initial = await engine.create(fixed, human, async context => {
      await context.save('retrieving', { checkpoint: { nextCursor: 'page-two', pageIds: ['page-one'] }, resultIds: ['result-one'] })
      entered.resolve()
      context.signal.addEventListener('abort', () => wait.reject(context.signal.reason), { once: true })
      await wait.promise
      return 'source-exhausted'
    })
    await entered.promise
    const attempt = dataOf(engine.get(initial.id, human)).attemptId
    const paused = await engine.control(initial.id, 'pause', human)
    assert.equal(paused.status, 'paused')
    assert.equal(dataOf(paused).checkpoint.nextCursor, 'page-two')
    assert.deepEqual(dataOf(paused).resultIds, ['result-one'])
    await engine.control(initial.id, 'resume', human, async context => {
      assert.deepEqual(context.spec, fixed)
      assert.equal(dataOf(context.current()).checkpoint.nextCursor, 'page-two')
      await context.save('finalizing', { resultIds: ['result-one', 'result-two'] })
      return 'target-met'
    })
    await jobs.hooks[1]!.done
    const complete = engine.get(initial.id, human)
    assert.equal(complete.status, 'completed')
    assert.equal(dataOf(complete).attempts, 2)
    assert.notEqual(dataOf(complete).attemptId, attempt)
    assert.deepEqual(specOf(complete), fixed)
    assert.deepEqual(dataOf(complete).resultIds, ['result-one', 'result-two'])
  })
  it('blocks late success and preserves spent quota when cancelling a remote request', async () => {
    const { engine, jobs, repository } = setup()
    const entered = deferred(), response = deferred<string>(), aborted = deferred()
    const initial = await engine.create(spec(), agent, async context => {
      const value = await context.request('vision', { request: 'fixture' }, async signal => {
        signal.addEventListener('abort', () => aborted.resolve(), { once: true })
        entered.resolve()
        return response.promise
      })
      await context.save('reviewing', { resultIds: [value] })
      return 'target-met'
    })
    await entered.promise
    const cancelling = engine.control(initial.id, 'cancel', agent)
    await aborted.promise
    response.resolve('late-result')
    const terminal = await cancelling
    await jobs.hooks[0]!.done
    assert.equal(terminal.status, 'cancelled')
    assert.deepEqual(dataOf(terminal).resultIds, [])
    assert.equal(dataOf(terminal).budget.vision, 1)
    assert.equal(repository.list('request')[0]?.state, 'outcome-unknown')
  })
  it('marks interrupted external reservations unknown and retains budget on restart', async () => {
    const { repository, jobs, engine } = setup()
    const initial = await engine.create(spec(), human, async () => 'target-met')
    await jobs.hooks[0]!.done
    const current = engine.get(initial.id, human)
    const request = requestSchema.parse({ schemaVersion: 1, kind: 'request', id: 'uncommitted-request', profileId: human.profileId, createdAt: current.createdAt, runId: current.id, state: 'reserved', requestDigest: contentDigest('remote'), data: { externalAttempt: true } })
    const run: RunRecord = { ...current, status: 'running', revision: current.revision + 1, data: toJson({ ...dataOf(current), budget: { ...dataOf(current).budget, vision: 1 }, requestIds: [request.id], checkpoint: { pageIds: ['committed-page'], nextCursor: 'page-two' } }) }
    await repository.commit({ aggregateId: `run:${run.id}`, expectedRevision: current.revision, operationId: 'simulate-crash', request: run, records: [run, request], state: { runId: run.id } })
    const restarted = new RunEngine(repository, new FixtureJobs())
    await restarted.recover()
    const recovered = restarted.get(run.id, human)
    assert.equal(recovered.status, 'interrupted')
    assert.equal(dataOf(recovered).budget.vision, 1)
    assert.equal(dataOf(recovered).checkpoint.nextCursor, 'page-two')
    assert.equal(repository.get('request', request.id)?.state, 'outcome-unknown')
    assert.match(dataOf(recovered).warnings.join(' '), /charges/)
  })
  it('denies cross-profile, cross-Session and Agent access to Client-owned runs', async () => {
    const { engine, jobs } = setup()
    const owned = await engine.create(spec(), agent, async () => 'target-met')
    await jobs.hooks[0]!.done
    assert.throws(() => engine.get(owned.id, { ...agent, sessionId: 'session-b' }), { code: 'owner-denied' })
    assert.throws(() => engine.get(owned.id, { ...agent, profileId: 'profile-b' }), { code: 'owner-denied' })
    assert.throws(() => engine.get(owned.id, human), { code: 'owner-denied' })
    const client = await engine.create(spec(), human, async () => 'target-met')
    await jobs.hooks[1]!.done
    assert.throws(() => engine.get(client.id, agent), { code: 'owner-denied' })
  })
  it('keeps preflight failure out of jobs and refuses new work after disposal', async () => {
    const { engine, jobs } = setup()
    jobs.rejectStart = true
    await assert.rejects(engine.create(spec(), human, async () => 'target-met'), /No controller/)
    assert.equal(jobs.hooks.length, 0)
    await engine.dispose()
    await assert.rejects(engine.create(spec(), human, async () => 'target-met'), { code: 'capability-unavailable' })
  })
})

describe('shared hard quotas', () => {
  it('admits only the remaining attempts under concurrent reservations and keeps unknown quota', async () => {
    const limits = limitsSchema.parse({ maxVisionCalls: 1, maxSearchPages: 1, maxDownloadBytes: 10, deadlineMs: 100 })
    const ledger = new BudgetLedger(limits, undefined, () => 0)
    const attempts = await Promise.allSettled(Array.from({ length: 10 }, () => ledger.reserve('vision')))
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(ledger.snapshot().vision, 1)
    await ledger.reserve('download', 8)
    await assert.rejects(ledger.reserve('download', 3), { code: 'budget-exhausted' })
    const resumed = new BudgetLedger(limits, ledger.snapshot(), () => 0)
    await assert.rejects(resumed.reserve('vision'), { code: 'budget-exhausted' })
    const expired = new BudgetLedger(limits, resumed.snapshot(), () => 100)
    await assert.rejects(expired.reserve('search'), { code: 'budget-exhausted' })
  })
})
