import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Context } from '@deepseek-ai/cordis'
import { JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { JobHooks, JobId, JobSpec } from '@deepseek-ai/dsh-jobs'
import { DomainRepository, MemoryDomainAdapter, contentDigest } from '../src/domain/index.ts'
import type { AggregateManifest } from '../src/domain/repository.ts'
import { RunEngine, dataOf, specOf, toJson, type ExecutionSpec, type Worker } from '../src/host/runtime.ts'
import * as configuration from '../src/host/config.ts'
import { createDataWorker } from '../src/host/data-workflows.ts'
import { mountCurator } from '../src/host/plugin.ts'
import { AssetFiles, CompatibleVisionProvider } from '../src/media/index.ts'
import type { DomainActor } from '../src/shared/model.ts'
import { serviceFixture } from './helpers/service-fixture.ts'
import { MediaError } from '../src/media/errors.ts'

const owner: DomainActor = { kind: 'human', id: 'analysis-owner', profileId: 'analysis-profile' }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}

async function waitForRelease(signal: AbortSignal, release: ReturnType<typeof deferred>): Promise<void> {
  signal.throwIfAborted()
  let onAbort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try { await Promise.race([release.promise, aborted]) }
  finally { signal.removeEventListener('abort', onAbort) }
}

class AnalysisJobs implements Pick<JobRegistry, 'start'> {
  readonly hooks: JobHooks[] = []
  start: JobRegistry['start'] = spec => {
    const id = brandString<JobId>(`analysis-job-${this.hooks.length}`)
    this.hooks.push(spec.run({ id, append: () => {}, updateProgress: () => {} }))
    return id
  }
}

function setup(repository = new DomainRepository(owner.profileId, new MemoryDomainAdapter()), capacity?: Pick<configuration.Limits, 'maxConcurrentAnalyses' | 'maxConcurrentRequests'>) {
  const jobs = new AnalysisJobs()
  return { repository, jobs, engine: new RunEngine(repository, jobs, undefined, capacity) }
}

function analysisSpec(styleId = 'style-a', config = configuration.resolveConfig({ vision: { reasoningEffort: 'low' }, limits: { maxVisionCalls: 4, maxRetryAttempts: 0 } })): ExecutionSpec {
  const input = { styleId, buildDataset: true }, fixed = { references: [] }
  return { kind: 'analyze', config, input, fixed, specDigest: contentDigest({ kind: 'analyze', config, input, fixed }) }
}

describe('background analysis lifecycle', () => {
  it('explicit failed continuations retain the global model-call limit despite new retry windows', async t => {
    const fixture = setup(), config = configuration.resolveConfig({ limits: { maxVisionCalls: 3, maxRetryAttempts: 0 } })
    t.after(() => fixture.engine.dispose())
    let calls = 0
    const worker: Worker = async work => {
      await work.request('vision', { operation: 'summarize' }, async () => { calls++; throw new MediaError('request-timeout', 'reviewing', true, 'Timed out', 'Continue from the checkpoint') })
      return 'target-met'
    }
    const run = await fixture.engine.create(analysisSpec('explicit-retries', config), owner, worker)
    await fixture.jobs.hooks[0]!.done
    const deadline = dataOf(fixture.engine.get(run.id, owner)).budget.deadlineAt
    for (const attempt of [1, 2]) { await fixture.engine.control(run.id, 'resume', owner, worker); await fixture.jobs.hooks[attempt]!.done }
    const last = fixture.engine.get(run.id, owner)
    assert.equal(last.status, 'failed'); assert.equal(calls, 3)
    assert.equal(dataOf(last).budget.vision, 3)
    assert.equal(dataOf(last).budget.deadlineAt, deadline)
    await assert.rejects(fixture.engine.control(run.id, 'resume', owner, worker), { code: 'budget-exhausted' })
    assert.equal(fixture.jobs.hooks.length, 3)
    const expired = { ...last, revision: last.revision + 1, data: toJson({ ...dataOf(last), budget: { ...dataOf(last).budget, deadlineAt: Date.now() - 1 } }) }
    await fixture.repository.commit({ aggregateId: `run:${last.id}`, expectedRevision: last.revision, operationId: 'expired-continuation', request: {}, records: [expired], state: {} })
    await assert.rejects(fixture.engine.control(run.id, 'resume', owner, worker), { code: 'budget-exhausted' })
    assert.equal(fixture.jobs.hooks.length, 3)
  })

  it('non-retryable failures cannot be continued as another model request', async t => {
    const fixture = setup()
    t.after(() => fixture.engine.dispose())
    const worker: Worker = async () => { throw new MediaError('configuration-required', 'reviewing', false, 'Check configuration', 'Review the configured model') }
    const run = await fixture.engine.create(analysisSpec('not-retryable'), owner, worker)
    await fixture.jobs.hooks[0]!.done
    await assert.rejects(fixture.engine.control(run.id, 'resume', owner, worker), { code: 'invalid-input' })
    assert.equal(fixture.jobs.hooks.length, 1)
  })

  it('streamed output does not reread the durable Run for each token while public reads stay verified', async t => {
    class StreamAdapter extends MemoryDomainAdapter {
      runReads = 0
      override readRecord(key: string) { if (key.startsWith('run-')) this.runReads++; return super.readRecord(key) }
    }
    const adapter = new StreamAdapter(), fixture = setup(new DomainRepository(owner.profileId, adapter)), entered = deferred(), begin = deferred()
    let streamReads = -1, streamedFrames = 0
    t.after(() => fixture.engine.dispose())
    const run = await fixture.engine.create(analysisSpec('streaming-cost'), owner, async work => {
      entered.resolve(); await begin.promise
      const before = adapter.runReads
      work.report({ phase: 'analyzing', resetOutput: true, imageIds: [] })
      for (let index = 0; index < 1000; index++) work.report({ phase: 'receiving', content: 'x' })
      streamReads = adapter.runReads - before
      await work.save('reviewing', { counts: { observed: 1 } })
      return 'target-met'
    })
    await entered.promise
    const unsubscribe = fixture.engine.subscribeProcess(run.id, owner, frame => { if (frame.process?.phase === 'receiving') { assert.equal(frame.status, 'running'); streamedFrames++ } })
    begin.resolve(); await fixture.jobs.hooks[0]!.done; unsubscribe()
    assert.equal(streamReads, 0, 'live presentation uses the execution owner\'s last committed Run')
    assert.ok(streamedFrames >= 1000)
    const reads = adapter.runReads, complete = fixture.engine.get(run.id, owner)
    assert.ok(adapter.runReads > reads, 'public reads continue verifying the persisted record')
    assert.equal(complete.status, 'completed')
    assert.equal(dataOf(complete).process?.content, 'x'.repeat(1000))
  })

  it('records admitted native input before dispatch and retains usage beside the settled request', async t => {
    const fixture = setup()
    t.after(() => fixture.engine.dispose())
    const run = await fixture.engine.create(analysisSpec('native-recording'), owner, async work => {
      await work.request('vision', { operation: 'analyze', model: 'native' }, async (_signal, recordMetadata) => {
        await recordMetadata({ transport: 'native-llm', request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'Actual admitted input' }] }] } })
        const pending = fixture.repository.list('request')[0]!
        assert.equal(pending.state, 'reserved')
        assert.ok(JSON.stringify(pending.data).includes('Actual admitted input'))
        await recordMetadata({ transport: 'native-llm', usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 80 } })
        return { observations: [] }
      })
      return 'target-met'
    })
    await fixture.jobs.hooks[0]!.done
    assert.equal(fixture.engine.get(run.id, owner).status, 'completed')
    const request = fixture.repository.list('request')[0]!
    assert.equal(request.state, 'committed')
    assert.ok(JSON.stringify(request.data).includes('cacheReadTokens'))
    assert.ok(JSON.stringify(request.data).includes('"operation":"analyze"'))
  })

  it('keeps a reported native call receipt when structured output validation fails', async t => {
    const fixture = setup()
    t.after(() => fixture.engine.dispose())
    const run = await fixture.engine.create(analysisSpec('native-invalid'), owner, async work => {
      await work.request('vision', { operation: 'analyze' }, async (_signal, recordMetadata) => {
        await recordMetadata({ transport: 'native-llm', usage: { inputTokens: 30, outputTokens: 7 } })
        throw new MediaError('vision-invalid-output', 'reviewing', false, 'Invalid structured output.', 'Inspect saved response.')
      })
      return 'target-met'
    })
    await fixture.jobs.hooks[0]!.done
    assert.equal(fixture.engine.get(run.id, owner).status, 'failed')
    const request = fixture.repository.list('request')[0]!
    assert.equal(request.state, 'outcome-unknown')
    assert.ok(JSON.stringify(request.data).includes('"inputTokens":30'))
  })

  it('cancels a retry wait without dispatching another paid request', async t => {
    const fixture = setup(), entered = deferred(), begin = deferred()
    const config = configuration.resolveConfig({ limits: { maxRetryAttempts: 2, retryDelayMs: 60_000 } })
    let calls = 0
    t.after(() => fixture.engine.dispose())
    const run = await fixture.engine.create(analysisSpec('cancel-retry', config), owner, async work => {
      await begin.promise
      await work.request('vision', { batch: 'one' }, async () => { calls++; throw new MediaError('remote-request-failed', 'reviewing', true, 'Unavailable.', 'Retry pending batch.') })
      return 'target-met'
    })
    const off = fixture.engine.subscribeProcess(run.id, owner, frame => { if (frame.checkpoint && frame.process?.phase === 'retrying') entered.resolve() })
    t.after(off)
    begin.resolve(); await entered.promise
    await fixture.engine.control(run.id, 'cancel', owner)
    assert.equal(fixture.engine.get(run.id, owner).status, 'cancelled')
    assert.equal(dataOf(fixture.engine.get(run.id, owner)).autoResume, false)
    assert.equal(calls, 1)
  })
  it('pauses a retry wait without waiting for another attempt or spending its quota', { timeout: 10_000 }, async t => {
    const fixture = setup(), entered = deferred(), begin = deferred()
    const config = configuration.resolveConfig({ limits: { maxRetryAttempts: 2, retryDelayMs: 60_000 } })
    let calls = 0
    t.after(() => fixture.engine.dispose())
    const run = await fixture.engine.create(analysisSpec('pause-retry', config), owner, async work => {
      await begin.promise
      await work.request('vision', { batch: 'pause-one' }, async () => { calls++; throw new MediaError('remote-request-failed', 'reviewing', true, 'Unavailable.', 'Retry pending batch.') })
      return 'target-met'
    })
    const off = fixture.engine.subscribeProcess(run.id, owner, frame => { if (frame.checkpoint && frame.process?.phase === 'retrying') entered.resolve() })
    t.after(off)
    begin.resolve(); await entered.promise
    const paused = await fixture.engine.control(run.id, 'pause', owner)
    assert.equal(paused.status, 'paused')
    assert.equal(dataOf(paused).autoResume, false)
    assert.equal(dataOf(paused).budget.vision, 1)
    assert.equal(calls, 1)
  })
  it('pauses a request-slot waiter without interrupting the collection that owns the slot', { timeout: 10_000 }, async t => {
    const fixture = setup(undefined, { maxConcurrentAnalyses: 2, maxConcurrentRequests: 1 }), entered = deferred(), waiting = deferred(), release = deferred()
    t.after(async () => { release.resolve(); await fixture.engine.dispose() })
    const active = await fixture.engine.create(analysisSpec('pause-slot-active'), owner, async work => {
      await work.request('vision', { batch: 'active' }, async signal => { entered.resolve(); await waitForRelease(signal, release); return 'active-output' })
      return 'target-met'
    })
    await entered.promise
    const waiter = await fixture.engine.create(analysisSpec('pause-slot-waiter'), owner, async work => {
      waiting.resolve()
      await work.request('vision', { batch: 'waiting' }, async () => { assert.fail('A paused waiter cannot dispatch a paid request') })
      return 'target-met'
    })
    await waiting.promise
    const paused = await fixture.engine.control(waiter.id, 'pause', owner)
    assert.equal(paused.status, 'paused')
    assert.equal(dataOf(paused).budget.vision, 0)
    assert.equal(fixture.repository.list('request').filter(request => request.runId === waiter.id).length, 0)
    assert.equal(fixture.engine.get(active.id, owner).status, 'running')
    release.resolve(); await fixture.jobs.hooks[0]!.done
    assert.equal(fixture.engine.get(active.id, owner).status, 'completed')
  })
  it('does not spend a reservation that had not become durable before pause was accepted', { timeout: 10_000 }, async t => {
    const fixture = setup(), reserved = deferred(), release = deferred()
    t.after(async () => { release.resolve(); await fixture.engine.dispose() })
    const run = await fixture.engine.create(analysisSpec('pause-before-reservation'), owner, async work => {
      const reserve = work.ledger.reserve.bind(work.ledger)
      work.ledger.reserve = async (kind, bytes) => { const value = await reserve(kind, bytes); reserved.resolve(); await release.promise; return value }
      await work.request('vision', { batch: 'not-admitted' }, async () => { assert.fail('Pausing before durable admission must prevent dispatch') })
      return 'target-met'
    })
    await reserved.promise
    assert.equal((await fixture.engine.control(run.id, 'pause', owner, undefined, false)).status, 'pausing')
    release.resolve(); await fixture.jobs.hooks[0]!.done
    const paused = fixture.engine.get(run.id, owner)
    assert.equal(paused.status, 'paused')
    assert.equal(dataOf(paused).budget.vision, 0)
    assert.equal(fixture.repository.list('request').length, 0)
  })
  it('keeps a resumed attempt controllable when continuation is requested from the durable paused frame', { timeout: 10_000 }, async t => {
    const fixture = setup(), entered = deferred(), release = deferred(), continued = deferred(), finish = deferred()
    t.after(async () => { release.resolve(); finish.resolve(); await fixture.engine.dispose() })
    const worker: Worker = async work => {
      if (dataOf(work.current()).attempts > 1) {
        continued.resolve()
        await waitForRelease(work.signal, finish)
        return 'target-met'
      }
      await work.request('vision', { batch: 'first' }, async () => { entered.resolve(); await release.promise; return 'first-output' })
      await work.save('reviewing', { checkpoint: { saved: true } })
      await work.request('vision', { batch: 'second' }, async () => { assert.fail('The next request must wait for explicit continuation') })
      return 'target-met'
    }
    const run = await fixture.engine.create(analysisSpec('immediate-resume'), owner, worker)
    await entered.promise
    let resuming: Promise<unknown> | undefined
    const off = fixture.engine.subscribeProcess(run.id, owner, frame => {
      if (frame.checkpoint && frame.status === 'paused' && !resuming) resuming = fixture.engine.control(run.id, 'resume', owner, worker)
    })
    t.after(off)
    await fixture.engine.control(run.id, 'pause', owner, undefined, false)
    release.resolve()
    await continued.promise
    await resuming
    const cancelled = await fixture.engine.control(run.id, 'cancel', owner)
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(dataOf(cancelled).attempts, 2)
  })
  it('retains an accepted pause through shutdown and never automatically continues it after restart', { timeout: 10_000 }, async t => {
    const first = setup(), entered = deferred(), release = deferred()
    t.after(async () => { release.resolve(); await first.engine.dispose() })
    const run = await first.engine.create(analysisSpec('pause-shutdown'), owner, async work => {
      await work.save('reviewing', { checkpoint: { analysisDoneImageIds: ['saved-image'] }, counts: { observed: 1 } })
      await work.request('vision', { batch: 'in-flight' }, async signal => { entered.resolve(); await waitForRelease(signal, release); return 'pending-output' })
      return 'target-met'
    })
    await entered.promise
    assert.equal((await first.engine.control(run.id, 'pause', owner, undefined, false)).status, 'pausing')
    await first.engine.dispose()
    const paused = first.engine.get(run.id, owner)
    assert.equal(paused.status, 'paused')
    assert.equal(dataOf(paused).autoResume, false)
    assert.deepEqual(dataOf(paused).checkpoint, { analysisDoneImageIds: ['saved-image'] })
    assert.equal(first.repository.list('request')[0]?.state, 'outcome-unknown')
    const restarted = setup(first.repository)
    t.after(() => restarted.engine.dispose())
    await restarted.engine.recover()
    await restarted.engine.resumeAnalyses(async () => { assert.fail('A user pause must survive recovery without automatic dispatch') })
    assert.equal(restarted.engine.get(run.id, owner).status, 'paused')
    assert.equal(restarted.jobs.hooks.length, 0)
  })
  it('recovers a durably accepted pause as paused when a process ended before acknowledgement', { timeout: 10_000 }, async t => {
    const first = setup()
    const run = await first.engine.create(analysisSpec('pause-crash'), owner, async () => 'target-met')
    await first.jobs.hooks[0]!.done
    const saved = first.engine.get(run.id, owner), pausedIntent = { ...saved, status: 'pausing' as const, data: toJson({ ...dataOf(saved), autoResume: false }) }
    await first.repository.commit({ aggregateId: `run:${saved.id}`, expectedRevision: saved.revision, operationId: 'crash-after-pause-intent', request: {}, records: [pausedIntent], state: {} })
    const restarted = setup(first.repository)
    t.after(async () => { await restarted.engine.dispose(); await first.engine.dispose() })
    await restarted.engine.recover()
    await restarted.engine.resumeAnalyses(async () => { assert.fail('Recovery must not override an explicitly accepted pause') })
    const paused = restarted.engine.get(run.id, owner)
    assert.equal(paused.status, 'paused')
    assert.equal(dataOf(paused).process?.phase, 'paused')
    assert.equal(restarted.jobs.hooks.length, 0)
  })
  it('does not reset the failed-batch retry allowance on restart', async t => {
    const fixture = setup(), config = configuration.resolveConfig({ limits: { maxRetryAttempts: 1, retryDelayMs: 0 } })
    let calls = 0
    const worker: Worker = async work => {
      await work.request('vision', { stableBatch: 'one' }, async () => { calls++; throw new MediaError('remote-request-failed', 'reviewing', true, 'Unavailable.', 'Review saved output.') })
      return 'target-met'
    }
    t.after(() => fixture.engine.dispose())
    const started = await fixture.engine.create(analysisSpec('retry-restart', config), owner, worker)
    await fixture.jobs.hooks[0]!.done
    assert.equal(calls, 2)
    const old = fixture.engine.get(started.id, owner), crashed = { ...old, status: 'running' as const }
    await fixture.repository.commit({ aggregateId: `run:${old.id}`, expectedRevision: old.revision, operationId: 'crash-after-retry-failure', request: {}, records: [crashed], state: {} })
    await fixture.engine.recover(); await fixture.engine.resumeAnalyses(worker); await fixture.jobs.hooks[1]!.done
    assert.equal(calls, 2)
    assert.equal(dataOf(fixture.engine.get(old.id, owner)).budget.vision, 2)
    assert.equal(fixture.engine.get(old.id, owner).status, 'failed')
    assert.equal(dataOf(fixture.engine.get(old.id, owner)).error?.retryable, true)
    await fixture.engine.control(old.id, 'resume', owner, worker); await fixture.jobs.hooks[2]!.done
    assert.equal(calls, 4, 'Only an explicit continuation opens a new bounded retry window')
  })
  it('restores queued dispatch if persisting its pause fails', async t => {
    const adapter = new MemoryDomainAdapter(), fixture = setup(new DomainRepository(owner.profileId, adapter), { maxConcurrentAnalyses: 1, maxConcurrentRequests: 1 })
    const entered = deferred(), release = deferred()
    t.after(async () => { release.resolve(); await fixture.engine.dispose() })
    await fixture.engine.create(analysisSpec('queue-failure-active'), owner, async work => { entered.resolve(); await waitForRelease(work.signal, release); return 'target-met' })
    await entered.promise
    let executions = 0
    const queued = await fixture.engine.create(analysisSpec('queue-failure-waiting'), owner, async () => { executions++; return 'target-met' })
    adapter.failNextManifest = true
    await assert.rejects(fixture.engine.control(queued.id, 'pause', owner), { code: 'storage-commit-failed' })
    release.resolve(); await fixture.jobs.hooks[0]!.done; await fixture.jobs.hooks[1]!.done
    assert.equal(executions, 1)
    assert.equal(fixture.engine.get(queued.id, owner).status, 'completed')
  })
  it('pauses a queued analysis without dispatching it and resumes its frozen work explicitly', async t => {
    const fixture = setup(undefined, { maxConcurrentAnalyses: 1, maxConcurrentRequests: 1 }), entered = deferred(), release = deferred()
    t.after(async () => { release.resolve(); await fixture.engine.dispose() })
    await fixture.engine.create(analysisSpec('queue-pause-active'), owner, async work => { entered.resolve(); await waitForRelease(work.signal, release); return 'target-met' })
    await entered.promise
    let executions = 0
    const worker: Worker = async () => { executions++; return 'target-met' }
    const queued = await fixture.engine.create(analysisSpec('queue-pause-waiting'), owner, worker)
    assert.equal((await fixture.engine.control(queued.id, 'pause', owner)).status, 'paused')
    release.resolve(); await fixture.jobs.hooks[0]!.done
    assert.equal(executions, 0)
    await fixture.engine.control(queued.id, 'resume', owner, worker)
    await fixture.jobs.hooks[1]!.done
    assert.equal(executions, 1)
    assert.equal(fixture.engine.get(queued.id, owner).status, 'completed')
  })
  it('automatically resumes a system interruption with its frozen spec and committed checkpoint', { timeout: 15_000 }, async t => {
    const first = setup(), pending = deferred(), neverReleased = deferred()
    t.after(() => first.engine.dispose())
    const frozen = analysisSpec()
    const started = await first.engine.create(frozen, owner, async context => {
      await context.request('vision', { imageVersionId: 'observed-one' }, async () => 'committed-observation')
      await context.save('reviewing', { checkpoint: { observedImageVersionIds: ['observed-one'] }, counts: { observed: 1, total: 2 } })
      await context.request('vision', { imageVersionId: 'pending-two' }, async signal => {
        pending.resolve()
        await waitForRelease(signal, neverReleased)
        return 'late-observation'
      })
      return 'target-met'
    }, 'system-interruption')
    await pending.promise
    const saved = dataOf(first.engine.get(started.id, owner))
    await first.engine.dispose()
    const interrupted = first.engine.get(started.id, owner)
    assert.equal(interrupted.status, 'interrupted')
    assert.equal(dataOf(interrupted).autoResume, true)
    assert.deepEqual(dataOf(interrupted).checkpoint, { observedImageVersionIds: ['observed-one'] })
    assert.equal(first.repository.list('request').filter(request => request.state === 'committed').length, 1)
    assert.equal(first.repository.list('request').filter(request => request.state === 'outcome-unknown').length, 1)

    const restarted = setup(first.repository), resumed = deferred(), finish = deferred()
    t.after(() => restarted.engine.dispose())
    await restarted.engine.recover()
    const worker: Worker = async context => {
      assert.deepEqual(context.spec, frozen)
      assert.equal(context.runId, started.id)
      assert.deepEqual(dataOf(context.current()).checkpoint, { observedImageVersionIds: ['observed-one'] })
      assert.deepEqual(context.ledger.snapshot(), saved.budget)
      resumed.resolve()
      await waitForRelease(context.signal, finish)
      await context.request('vision', { imageVersionId: 'pending-two' }, async () => 'retried-observation')
      await context.save('finalizing', { checkpoint: { observedImageVersionIds: ['observed-one', 'pending-two'] }, counts: { observed: 2, total: 2 } })
      return 'target-met'
    }
    await restarted.engine.resumeAnalyses(worker)
    await resumed.promise
    await restarted.engine.resumeAnalyses(worker)
    assert.equal(restarted.jobs.hooks.length, 1)
    finish.resolve()
    await restarted.jobs.hooks[0]!.done
    const complete = restarted.engine.get(started.id, owner)
    assert.equal(complete.status, 'completed')
    assert.equal(dataOf(complete).attempts, 2)
    assert.notEqual(dataOf(complete).attemptId, saved.attemptId)
    assert.equal(dataOf(complete).budget.vision, 3)
    assert.equal(dataOf(complete).budget.deadlineAt, saved.budget.deadlineAt)
    assert.deepEqual(specOf(complete), frozen)
    assert.deepEqual(dataOf(complete).counts, { observed: 2, total: 2 })
  })

  it('retains committed analysis progress after explicit cancel and never restores that task', { timeout: 15_000 }, async t => {
    const first = setup(), entered = deferred(), neverReleased = deferred()
    t.after(() => first.engine.dispose())
    const started = await first.engine.create(analysisSpec(), owner, async context => {
      await context.save('reviewing', { checkpoint: { observedImageVersionIds: ['observed-one'] }, counts: { observed: 1, total: 2 } })
      entered.resolve()
      await waitForRelease(context.signal, neverReleased)
      return 'target-met'
    }, 'explicit-cancel')
    await entered.promise
    const cancelled = await first.engine.control(started.id, 'cancel', owner)
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(dataOf(cancelled).autoResume, false)
    await first.engine.dispose()

    const restarted = setup(first.repository)
    t.after(() => restarted.engine.dispose())
    await restarted.engine.recover()
    await restarted.engine.resumeAnalyses(async () => { assert.fail('A deliberately cancelled analysis must not execute again') })
    assert.equal(restarted.jobs.hooks.length, 0)
    const retained = restarted.engine.get(started.id, owner)
    assert.equal(retained.status, 'cancelled')
    assert.deepEqual(dataOf(retained).checkpoint, { observedImageVersionIds: ['observed-one'] })
    assert.deepEqual(dataOf(retained).counts, { observed: 1, total: 2 })
    assert.equal(dataOf(retained).attempts, 1)
  })

  it('runs distinct collections concurrently and rejects a second analysis for the same collection', { timeout: 15_000 }, async t => {
    const fixture = setup(), enteredA = deferred(), enteredB = deferred(), release = deferred()
    t.after(() => fixture.engine.dispose())
    const worker = (entered: ReturnType<typeof deferred>): Worker => async context => {
      entered.resolve()
      await waitForRelease(context.signal, release)
      return 'target-met'
    }
    const [first, second] = await Promise.all([
      fixture.engine.create(analysisSpec('style-a'), owner, worker(enteredA), 'first-a'),
      fixture.engine.create(analysisSpec('style-b'), owner, worker(enteredB), 'first-b'),
    ])
    await Promise.all([enteredA.promise, enteredB.promise])
    assert.equal(fixture.engine.get(first.id, owner).status, 'running')
    assert.equal(fixture.engine.get(second.id, owner).status, 'running')
    const repeated = await fixture.engine.create(analysisSpec('style-a'), owner, worker(enteredA), 'first-a')
    assert.equal(repeated.id, first.id)
    await assert.rejects(fixture.engine.create(analysisSpec('style-a'), owner, worker(enteredA), 'duplicate-a'), { code: 'constraint-conflict' })
    assert.equal(fixture.repository.list('run').length, 2)
    release.resolve()
    await Promise.all(fixture.jobs.hooks.map(hook => hook.done))
    assert.ok(fixture.repository.list('run').every(run => run.status === 'completed'))
  })

  it('queues analysis beyond the configured collection limit and starts it when a slot is released', { timeout: 15_000 }, async t => {
    const fixture = setup()
    t.after(() => fixture.engine.dispose())
    const config = configuration.resolveConfig({ limits: { maxConcurrentAnalyses: 2 } })
    const entered = [deferred(), deferred(), deferred()], release = [deferred(), deferred(), deferred()]
    let active = 0, maximum = 0
    const worker = (index: number): Worker => async context => {
      active++
      maximum = Math.max(maximum, active)
      entered[index]!.resolve()
      try { await waitForRelease(context.signal, release[index]!) }
      finally { active-- }
      return 'target-met'
    }
    const runs = await Promise.all([0, 1, 2].map(index => fixture.engine.create(analysisSpec(`style-${index}`, config), owner, worker(index), `limited-${index}`)))
    await Promise.all([entered[0]!.promise, entered[1]!.promise])
    assert.equal(active, 2)
    assert.equal(fixture.engine.get(runs[2]!.id, owner).status, 'created')
    release[0]!.resolve()
    await entered[2]!.promise
    assert.equal(active, 2)
    assert.equal(maximum, 2)
    release[1]!.resolve()
    release[2]!.resolve()
    await Promise.all(fixture.jobs.hooks.map(hook => hook.done))
    assert.ok(fixture.repository.list('run').every(run => run.status === 'completed'))
  })

  it('inherits native defaults without changing a legacy frozen execution spec', async t => {
    const fixture = setup()
    t.after(() => fixture.engine.dispose())
    const legacyConfig = configuration.resolveConfig({})
    assert.equal(Object.hasOwn(legacyConfig.vision, 'reasoningEffort'), false)
    const legacy = analysisSpec('legacy-style', legacyConfig)
    const oldRun = await fixture.engine.create(legacy, owner, async () => 'target-met', 'legacy-analysis')
    await fixture.jobs.hooks[0]!.done
    const fixed = specOf(fixture.engine.get(oldRun.id, owner))
    assert.equal(Object.hasOwn(fixed.config.vision, 'reasoningEffort'), false)
    assert.equal(fixed.specDigest, legacy.specDigest)

    const current = configuration.resolveCurrentConfig({})
    assert.equal(current.vision.reasoningEffort, undefined)
    assert.equal(current.vision.useModelDefaults, true)
    assert.equal(current.limits.maxConcurrentAnalyses, 2)
    assert.equal(configuration.resolveCurrentConfig({ vision: { backend: 'compatible', reasoningEffort: 'low' } }).vision.reasoningEffort, 'low')
    assert.equal(Object.hasOwn(configuration.resolveCurrentConfig({ vision: { reasoningEffort: null } }).vision, 'reasoningEffort'), false)
    assert.equal(Object.hasOwn(specOf(fixture.engine.get(oldRun.id, owner)).config.vision, 'reasoningEffort'), false)
  })

  it('shares vision request slots across collections without spending quota for a cancelled waiter', { timeout: 15_000 }, async t => {
    const fixture = setup(undefined, { maxConcurrentAnalyses: 2, maxConcurrentRequests: 1 }), entered = deferred(), release = deferred(), waiting = deferred(), laterWaiting = deferred(), laterEntered = deferred()
    t.after(() => fixture.engine.dispose())
    const config = configuration.resolveConfig({ limits: { maxConcurrentAnalyses: 2, maxConcurrentRequests: 3 } })
    let active = 0, maximum = 0, cancelledDispatches = 0
    const first = await fixture.engine.create(analysisSpec('request-a', config), owner, async context => {
      await context.request('vision', { image: 'a' }, async signal => {
        active++
        maximum = Math.max(maximum, active)
        entered.resolve()
        try { await waitForRelease(signal, release) }
        finally { active-- }
        return 'a'
      })
      return 'target-met'
    }, 'request-a')
    await entered.promise
    const cancelled = await fixture.engine.create(analysisSpec('request-b', config), owner, async context => {
      const request = context.request('vision', { image: 'b' }, async () => { cancelledDispatches++; return 'b' })
      waiting.resolve()
      await request
      return 'target-met'
    }, 'request-b')
    await waiting.promise
    assert.equal(dataOf(fixture.engine.get(cancelled.id, owner)).budget.vision, 0)
    assert.deepEqual(dataOf(fixture.engine.get(cancelled.id, owner)).requestIds, [])
    await fixture.engine.control(cancelled.id, 'cancel', owner)
    assert.equal(cancelledDispatches, 0)
    assert.equal(dataOf(fixture.engine.get(cancelled.id, owner)).budget.vision, 0)
    assert.equal(fixture.repository.list('request').filter(request => request.runId === cancelled.id).length, 0)

    const later = await fixture.engine.create(analysisSpec('request-c', config), owner, async context => {
      const request = context.request('vision', { image: 'c' }, async () => {
        active++
        maximum = Math.max(maximum, active)
        laterEntered.resolve()
        active--
        return 'c'
      })
      laterWaiting.resolve()
      await request
      return 'target-met'
    }, 'request-c')
    await laterWaiting.promise
    assert.equal(dataOf(fixture.engine.get(later.id, owner)).budget.vision, 0)
    release.resolve()
    await laterEntered.promise
    await Promise.all(fixture.jobs.hooks.map(hook => hook.done))
    assert.equal(maximum, 1)
    assert.equal(fixture.engine.get(first.id, owner).status, 'completed')
    assert.equal(fixture.engine.get(later.id, owner).status, 'completed')
    assert.equal(fixture.engine.get(cancelled.id, owner).status, 'cancelled')
    assert.equal(fixture.repository.list('request').length, 2)
  })

  it('cancels a queued collection before starting a job and never restores it', { timeout: 15_000 }, async t => {
    const fixture = setup(undefined, { maxConcurrentAnalyses: 1, maxConcurrentRequests: 1 }), entered = deferred(), release = deferred()
    t.after(() => fixture.engine.dispose())
    const config = configuration.resolveConfig({ limits: { maxConcurrentAnalyses: 3 } })
    const first = await fixture.engine.create(analysisSpec('queued-active', config), owner, async context => {
      entered.resolve()
      await waitForRelease(context.signal, release)
      return 'target-met'
    }, 'queued-active')
    await entered.promise
    const queued = await fixture.engine.create(analysisSpec('queued-cancelled', config), owner, async () => { assert.fail('A cancelled queued collection must never start') }, 'queued-cancelled')
    assert.equal(queued.status, 'created')
    const cancelled = await fixture.engine.control(queued.id, 'cancel', owner)
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(dataOf(cancelled).autoResume, false)
    assert.equal(dataOf(cancelled).budget.vision, 0)
    release.resolve()
    await fixture.jobs.hooks[0]!.done
    assert.equal(fixture.jobs.hooks.length, 1)
    assert.equal(fixture.engine.get(first.id, owner).status, 'completed')
    await fixture.engine.dispose()
    const restarted = setup(fixture.repository)
    t.after(() => restarted.engine.dispose())
    await restarted.engine.recover()
    await restarted.engine.resumeAnalyses(async () => { assert.fail('Queued cancellation must survive system recovery') })
    assert.equal(restarted.jobs.hooks.length, 0)
    assert.equal(restarted.engine.get(queued.id, owner).status, 'cancelled')
  })

  it('restores the production analysis worker without replaying a committed model response', { timeout: 15_000 }, async t => {
    for (const point of ['before-checkpoint', 'after-checkpoint'] as const) await t.test(point, async child => {
      const fixture = await serviceFixture()
      let firstEngine: RunEngine | undefined, restartedEngine: RunEngine | undefined
      child.after(async () => { await restartedEngine?.dispose(); await firstEngine?.dispose(); await fixture.cleanup() })
      await fixture.service.initialize()
      const identity = z.object({ id: z.string() }), handle = z.object({ runId: z.string() })
      const style = identity.parse(await fixture.action('style-create', { operationId: 'cache-style', name: 'Cached analysis' }))
      await fixture.action('reference-import', { operationId: 'cache-reference', styleId: style.id, expectedRevision: 1, files: [{ name: 'cache.png', mime: 'image/png', base64: fixture.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
      const initial = handle.parse(await fixture.action('reference-analyze', { operationId: 'cache-initial', styleId: style.id }))
      await fixture.jobs.drain()
      const template = fixture.domain.require('run', initial.runId)
      assert.equal(template.status, 'completed')
      const frozen = specOf(template), limits = frozen.config.limits
      const files = new AssetFiles(join(fixture.root, 'visual-curator'), { maxFileBytes: limits.maxImportBytes, maxPixels: limits.maxPixels, maxDimension: limits.maxDimension, previewMaxDimension: limits.previewMaxDimension, maxStorageBytes: limits.maxStorageBytes })
      const provider = new CompatibleVisionProvider({ endpoint: frozen.config.vision.endpoint, model: frozen.config.vision.model, supportsMultiImage: true, maxImages: 10, maxImageBytes: 1_000_000, maxRequestBytes: 10_000_000, maxOutputTokens: 4000, temperature: 0, declaredModelVersion: 'fixture-v1' }, fixture.http)
      const production = createDataWorker({ domain: fixture.domain, files, vision: async () => provider })
      const before = fixture.http.operations.length, reached = deferred(), neverReleased = deferred()
      const first = setup(fixture.repository)
      firstEngine = first.engine
      const interrupted = await first.engine.create(frozen, fixture.actor, async context => {
        const outcome = await production(point === 'before-checkpoint' ? { ...context, save: async (stage, patch, records) => {
          if (Array.isArray(patch.checkpoint?.analysisDoneImageIds) && patch.checkpoint.analysisDoneImageIds.length) {
            reached.resolve()
            await waitForRelease(context.signal, neverReleased)
          }
          await context.save(stage, patch, records)
        } } : context)
        reached.resolve()
        await waitForRelease(context.signal, neverReleased)
        return outcome
      }, `cache-${point}`)
      await reached.promise
      assert.equal(fixture.http.operations.length - before, 1)
      const committed = fixture.repository.list('request').filter(request => request.runId === interrupted.id)
      assert.equal(committed.length, 1)
      assert.equal(committed[0]?.state, 'committed')
      await first.engine.dispose()
      assert.equal(first.engine.get(interrupted.id, fixture.actor).status, 'interrupted')
      const restarted = setup(fixture.repository)
      restartedEngine = restarted.engine
      await restarted.engine.recover()
      await restarted.engine.resumeAnalyses(production)
      await restarted.jobs.hooks[0]!.done
      const complete = restarted.engine.get(interrupted.id, fixture.actor)
      assert.equal(complete.status, 'completed', JSON.stringify(dataOf(complete).error))
      assert.equal(fixture.http.operations.length - before, 1)
      assert.equal(dataOf(complete).budget.vision, 1)
      assert.equal(dataOf(complete).counts.observed, 1)
      assert.equal(dataOf(complete).attempts, 2)
      assert.equal(fixture.repository.list('request').filter(request => request.runId === interrupted.id).length, 1)
      assert.equal(fixture.repository.list('observation').filter(observation => dataOf(complete).resultIds.includes(observation.id)).length, 1)
    })
  })

  it('keeps cancellation terminal when automatic recovery and cancel are requested together', { timeout: 15_000 }, async t => {
    const first = setup(), entered = deferred(), neverReleased = deferred()
    t.after(() => first.engine.dispose())
    const run = await first.engine.create(analysisSpec('recovery-cancel'), owner, async context => {
      entered.resolve()
      await waitForRelease(context.signal, neverReleased)
      return 'target-met'
    }, 'recovery-cancel')
    await entered.promise
    await first.engine.dispose()
    const restarted = setup(first.repository)
    t.after(() => restarted.engine.dispose())
    await restarted.engine.recover()
    let executions = 0
    const recovering = restarted.engine.resumeAnalyses(async () => { executions++; return 'target-met' })
    const cancelling = restarted.engine.control(run.id, 'cancel', owner)
    await Promise.all([recovering, cancelling])
    await Promise.all(restarted.jobs.hooks.map(hook => hook.done))
    assert.equal(executions, 0)
    assert.equal(restarted.engine.get(run.id, owner).status, 'cancelled')
    assert.equal(dataOf(restarted.engine.get(run.id, owner)).autoResume, false)
  })

  it('admits only one attempt when two manual resumes target the same interrupted analysis', { timeout: 15_000 }, async t => {
    const first = setup(), entered = deferred(), neverReleased = deferred()
    t.after(() => first.engine.dispose())
    const run = await first.engine.create(analysisSpec('duplicate-resume'), owner, async context => {
      entered.resolve()
      await waitForRelease(context.signal, neverReleased)
      return 'target-met'
    }, 'duplicate-resume')
    await entered.promise
    await first.engine.dispose()
    const restarted = setup(first.repository), release = deferred()
    t.after(() => restarted.engine.dispose())
    await restarted.engine.recover()
    const worker: Worker = async context => { await waitForRelease(context.signal, release); return 'target-met' }
    const attempts = await Promise.allSettled([
      restarted.engine.control(run.id, 'resume', owner, worker),
      restarted.engine.control(run.id, 'resume', owner, worker),
    ])
    assert.ok(attempts.some(attempt => attempt.status === 'fulfilled'))
    const jobs = restarted.jobs.hooks.length, count = dataOf(restarted.engine.get(run.id, owner)).attempts
    release.resolve()
    await Promise.all(restarted.jobs.hooks.map(hook => hook.done))
    assert.equal(jobs, 1)
    assert.equal(count, 2)
    assert.equal(restarted.engine.get(run.id, owner).status, 'completed')
  })

  it('settles rejected queued jobs as failed and continues dispatch without rejecting an earlier completed job', { timeout: 15_000 }, async t => {
    const fixture = setup(), entered = deferred(), release = deferred(), lastEntered = deferred()
    t.after(() => fixture.engine.dispose())
    const config = configuration.resolveConfig({ limits: { maxConcurrentAnalyses: 1 } })
    const start = fixture.jobs.start
    let attempts = 0
    fixture.jobs.start = spec => {
      attempts++
      // 原生 JobRegistry 会在同属主容量耗尽或控制器不可用时拒绝受理。
      if (attempts === 2 || attempts === 3) throw new Error('Injected job admission rejection')
      return start(spec)
    }
    const first = await fixture.engine.create(analysisSpec('dispatch-first', config), owner, async context => {
      entered.resolve()
      await waitForRelease(context.signal, release)
      return 'target-met'
    }, 'dispatch-first')
    await entered.promise
    const rejected = []
    for (const suffix of ['second', 'third']) rejected.push(await fixture.engine.create(analysisSpec(`dispatch-${suffix}`, config), owner, async () => {
      assert.fail('A job rejected by the registry must not execute its worker')
    }, `dispatch-${suffix}`))
    const last = await fixture.engine.create(analysisSpec('dispatch-last', config), owner, async () => { lastEntered.resolve(); return 'target-met' }, 'dispatch-last')
    release.resolve()
    const completion = await Promise.allSettled([fixture.jobs.hooks[0]!.done])
    assert.equal(completion[0]!.status, 'fulfilled', 'A later scheduling failure must not reject the already completed job')
    await lastEntered.promise
    await Promise.all(fixture.jobs.hooks.map(hook => hook.done))
    assert.equal(fixture.engine.get(first.id, owner).status, 'completed')
    assert.equal(fixture.engine.get(last.id, owner).status, 'completed')
    for (const run of rejected) {
      const saved = fixture.engine.get(run.id, owner)
      assert.equal(saved.status, 'failed')
      assert.equal(dataOf(saved).error?.code, 'capability-unavailable')
      assert.equal(dataOf(saved).budget.vision, 0)
    }
    assert.equal(attempts, 4)
    assert.equal(fixture.jobs.hooks.length, 2)
  })

  it('registers its controller before recovering jobs and releases it when initialization fails', { timeout: 15_000 }, async t => {
    const fixture = await serviceFixture(), context = new Context(), entered = deferred(), release = deferred()
    const first = new RunEngine(fixture.repository, fixture.jobs)
    t.after(async () => { await first.dispose(); await context.fiber.dispose(); await fixture.cleanup() })
    const run = await first.create(analysisSpec('mount-recovery', fixture.service.config), fixture.actor, async work => {
      entered.resolve()
      await waitForRelease(work.signal, release)
      return 'target-met'
    }, 'mount-recovery')
    await entered.promise
    await first.dispose()
    assert.equal(first.get(run.id, fixture.actor).status, 'interrupted')
    let attached = false
    class ControllerJobs extends JobRegistry {
      readonly events = { subscribe: () => () => {} }
      start(spec: JobSpec): JobId {
        if (!attached) throw new Error('No controller serves this owner')
        return fixture.jobs.start(spec)
      }
      attachController(): () => void { attached = true; return () => { attached = false } }
      list(): [] { return [] }
      get(): never { throw new Error('Unused fixture operation') }
      read(): never { throw new Error('Unused fixture operation') }
      readAt(): never { throw new Error('Unused fixture operation') }
      kill(): never { throw new Error('Unused fixture operation') }
      wait(): never { throw new Error('Unused fixture operation') }
      remove(): never { throw new Error('Unused fixture operation') }
    }
    await context.plugin(ControllerJobs)
    fixture.host.jobs = context.jobs
    const initializationFailure = new Error('Injected failure after recovery'), initialize = fixture.service.initialize.bind(fixture.service)
    fixture.service.initialize = async () => { await initialize(); throw initializationFailure }
    await assert.rejects(mountCurator(context, fixture.service), error => error === initializationFailure)
    assert.equal(fixture.jobs.hooks.length, 2, 'The saved task must be admitted during initialization')
    await context.fiber.dispose()
    assert.equal(attached, false)
    await assert.rejects(fixture.action('config-read'), { name: 'AbortError' })
  })

  it('stops dispatching while shutdown waits for a rejected queued job to become durable', { timeout: 15_000 }, async t => {
    const failedWrite = deferred(), commitFailure = deferred(), active = deferred(), release = deferred()
    class FailedWriteBarrier extends MemoryDomainAdapter {
      override async writeManifest(manifest: AggregateManifest): Promise<void> {
        const pointer = manifest.records.find(record => record.kind === 'run'), record = pointer ? this.readRecord(pointer.key) : undefined
        if (record?.kind === 'run' && record.status === 'failed') { failedWrite.resolve(); await commitFailure.promise }
        await super.writeManifest(manifest)
      }
    }
    const fixture = setup(new DomainRepository(owner.profileId, new FailedWriteBarrier())), config = configuration.resolveConfig({ limits: { maxConcurrentAnalyses: 1 } })
    t.after(async () => { commitFailure.resolve(); release.resolve(); await fixture.engine.dispose() })
    const start = fixture.jobs.start
    let attempts = 0
    fixture.jobs.start = spec => { if (++attempts === 2) throw new Error('Injected job admission rejection'); return start(spec) }
    await fixture.engine.create(analysisSpec('shutdown-first', config), owner, async work => { active.resolve(); await waitForRelease(work.signal, release); return 'target-met' }, 'shutdown-first')
    await active.promise
    const rejected = await fixture.engine.create(analysisSpec('shutdown-rejected', config), owner, async () => { assert.fail('A rejected job must not execute') }, 'shutdown-rejected')
    const queued = await fixture.engine.create(analysisSpec('shutdown-unstarted', config), owner, async () => { assert.fail('A task queued at shutdown must not execute') }, 'shutdown-unstarted')
    const completion = Promise.allSettled([fixture.jobs.hooks[0]!.done])
    release.resolve()
    await failedWrite.promise
    const closing = fixture.engine.dispose()
    commitFailure.resolve()
    await closing
    assert.equal((await completion)[0]!.status, 'fulfilled')
    assert.equal(attempts, 2)
    assert.equal(fixture.jobs.hooks.length, 1)
    assert.equal(fixture.engine.get(rejected.id, owner).status, 'failed')
    assert.equal(fixture.engine.get(queued.id, owner).status, 'interrupted')
  })
})
