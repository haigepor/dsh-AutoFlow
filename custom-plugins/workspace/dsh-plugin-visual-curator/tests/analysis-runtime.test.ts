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
import { RunEngine, dataOf, specOf, type ExecutionSpec, type Worker } from '../src/host/runtime.ts'
import * as configuration from '../src/host/config.ts'
import { createDataWorker } from '../src/host/data-workflows.ts'
import { mountCurator } from '../src/host/plugin.ts'
import { AssetFiles, CompatibleVisionProvider } from '../src/media/index.ts'
import type { DomainActor } from '../src/shared/model.ts'
import { serviceFixture } from './helpers/service-fixture.ts'

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

  it('defaults new tasks to high without adding reasoningEffort to a legacy frozen execution spec', async t => {
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
    assert.equal(current.vision.reasoningEffort, 'high')
    assert.equal(current.limits.maxConcurrentAnalyses, 2)
    assert.equal(configuration.resolveCurrentConfig({ vision: { reasoningEffort: 'low' } }).vision.reasoningEffort, 'low')
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
