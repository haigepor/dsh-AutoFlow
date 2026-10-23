import assert from 'node:assert/strict'
import { test } from 'node:test'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { JobHooks, JobId, JobRegistry } from '@deepseek-ai/dsh-jobs'
import { contentDigest, DomainRepository, MemoryDomainAdapter } from '../src/domain/repository.ts'
import type { AggregateManifest } from '../src/domain/repository.ts'
import { RunEngine } from '../src/host/runtime.ts'
import type { ExecutionSpec } from '../src/host/runtime.ts'
import { resolveConfig } from '../src/host/config.ts'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept }); return { promise, resolve } }
class Jobs implements Pick<JobRegistry, 'start'> {
  readonly hooks: JobHooks[] = []
  start: JobRegistry['start'] = spec => {
    const id = brandString<JobId>(`job-${this.hooks.length}`)
    this.hooks.push(spec.run({ id, append() {}, updateProgress() {} }))
    return id
  }
}
class AdmissionBarrier extends MemoryDomainAdapter {
  readonly entered = deferred()
  readonly release = deferred()
  private held = false
  override async writeManifest(manifest: AggregateManifest): Promise<void> {
    if (!this.held && manifest.aggregateId.startsWith('run:')) { this.held = true; this.entered.resolve(); await this.release.promise }
    await super.writeManifest(manifest)
  }
}
const actor = { kind: 'human' as const, id: 'human', profileId: 'p' }
function spec(): ExecutionSpec { return { kind: 'search', config: resolveConfig({}), input: { taskBrief: 'Same task.' }, fixed: {}, specDigest: contentDigest('same-spec') } }

test('concurrent identical operation admissions both return the same original Run and start exactly one job', async () => {
  const repository = new DomainRepository('p', new MemoryDomainAdapter()), jobs = new Jobs(), engine = new RunEngine(repository, jobs)
  try {
    const results = await Promise.all([engine.create(spec(), actor, async () => 'source-exhausted', 'same-operation'), engine.create(spec(), actor, async () => 'source-exhausted', 'same-operation')])
    assert.equal(results[0]?.id, results[1]?.id)
    assert.equal(jobs.hooks.length, 1)
    await jobs.hooks[0]?.done
  } finally { await engine.dispose(); await repository.close() }
})

test('shutdown waits for an admitted initial commit and drains the job before acknowledging disposal', async () => {
  const adapter = new AdmissionBarrier(), repository = new DomainRepository('p', adapter), jobs = new Jobs(), engine = new RunEngine(repository, jobs)
  const interrupted = deferred()
  const created = engine.create(spec(), actor, async ctx => {
    const abort = () => interrupted.resolve()
    if (ctx.signal.aborted) abort()
    else ctx.signal.addEventListener('abort', abort, { once: true })
    await interrupted.promise
    ctx.signal.throwIfAborted()
    return 'target-met'
  }, 'shutdown-admission')
  let closing: Promise<void> | undefined
  try {
    await adapter.entered.promise
    closing = engine.dispose()
    adapter.release.resolve()
    const results = await Promise.allSettled([created, closing])
    assert.equal(results[1]?.status, 'fulfilled')
    const terminal = repository.list('run')[0]
    assert.ok(terminal)
    assert.equal(terminal.status, 'cancelled')
    assert.notEqual(terminal.outcome, 'target-met')
    await jobs.hooks[0]?.done
  } finally {
    adapter.release.resolve(); interrupted.resolve()
    await Promise.allSettled([created, ...(closing ? [closing] : [])])
    await engine.dispose(); await Promise.allSettled(jobs.hooks.map(hook => hook.done)); await repository.close()
  }
})
