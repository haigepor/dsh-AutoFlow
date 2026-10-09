import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { resolveConfig } from '../config-schema.js'
import { Store } from '../src/host/afp-state-store.js'
import { AfpDiagnostics, diagnosticFailure } from '../src/host/afp-diagnostics.js'
import { AfpService } from '../src/host/afp-service.js'

async function fixture(t, configInput = {}, handles = {}) {
  const home = await mkdtemp(join(tmpdir(), 'afp-debug-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const config = resolveConfig({ targetPerCategory: 1, maxSearchRequests: 1, maxBatches: 1, ...configInput })
  const store = new Store(home, join(home, 'profile'), config.maxStateBytes), jobs = []
  const ctx = { profileContext: { home, dir: join(home, 'profile') }, jobs: { start(spec) {
    const jobId = `afp-${jobs.length + 1}`
    jobs.push(spec.run({ append() {}, updateProgress() {}, ...handles })); return jobId
  } } }
  const connection = { status: async () => ({}), open: async () => ({ account: 'synthetic-account',
    client: { listSelections: async () => [], searchPhotos: async () => ({ docs: [], hasMore: false }) } }) }
  return { home, config, store, jobs, ctx, connection }
}

test('disabled debug retains a failed run with timings and safe code frames despite a silent logger', async t => {
  const f = await fixture(t), service = new AfpService(f.ctx, f.config, { store: f.store, connection: f.connection })
  f.connection.open = async () => {
    const error = Object.assign(new Error('token=private-value response https://secret.test'), { code: 'EACCES' })
    error.stack = 'Error: private-value\n    at open (C:\\private\\afp-credentials.js:12:8)'
    throw error
  }
  await service.enable('refresh')
  const result = await service.startRefresh({ categories: ['food'] }, undefined, new AbortController().signal)
  assert.equal((await f.jobs[0].done).status, 'failed')
  const diagnostic = await service.pageAction({ operation: 'diagnostics', args: JSON.stringify({ runId: result.runId }) })
  assert.equal(diagnostic.debug, false)
  assert.deepEqual(diagnostic.events, [])
  assert.equal(diagnostic.failure.stage, 'connection')
  assert.equal(diagnostic.failure.systemCode, 'EACCES')
  assert.deepEqual(diagnostic.failure.frames, ['afp-credentials.js:12:8'])
  assert.ok(diagnostic.timings.some(row => row.stage === 'connection' && row.failed === 1))
  assert.doesNotMatch(JSON.stringify(diagnostic), /private-value|secret\.test|C:\\|synthetic-account/)
  await service.dispose()
})

test('saved reports expose refresh-attempt duration and sanitized failure independently of report-read duration', async t => {
  const f = await fixture(t), service = new AfpService(f.ctx, f.config, { store: f.store, connection: f.connection })
  f.connection.open = async () => { throw Object.assign(new Error('private-value'), { code: 'EPERM' }) }
  await service.enable('refresh')
  const handle = await service.startRefresh({ categories: ['food'] }, undefined, new AbortController().signal)
  await f.jobs[0].done
  const report = await service.report({ runId: handle.runId })
  assert.equal(report.diagnostics.durationScope, 'refresh-attempt')
  assert.ok(report.diagnostics.durationMs >= 0)
  assert.equal(report.diagnostics.failure.stage, 'connection')
  assert.equal(report.diagnostics.failure.systemCode, 'EPERM')
  assert.ok(report.diagnostics.timings.some(row => row.stage === 'connection'))
  assert.equal(report.diagnostics.events, undefined)
  assert.doesNotMatch(JSON.stringify(report), /private-value/)
})

test('a failed progress callback records its original step and cannot hide it during failure notification', async t => {
  const f = await fixture(t), service = new AfpService(f.ctx, f.config, { connection: f.connection })
  await service.enable('refresh')
  const result = await service.startRefresh({ categories: ['food'] }, undefined, new AbortController().signal,
    () => { throw new Error('private-progress-error') })
  const outcome = await f.jobs[0].done
  assert.equal(outcome.status, 'failed')
  const record = await service.diagnostics.read(result.runId)
  assert.equal(record.failure.stage, 'progress-update')
  assert.equal(record.outcome, 'failed')
  assert.doesNotMatch(JSON.stringify(record), /private-progress-error/)
  assert.equal((await service.store.readRun(result.runId)).status, 'failed')
  await service.dispose()
})

test('visual transition output failure identifies progress-output rather than blaming the vision provider', async t => {
  const f = await fixture(t, { debugEnabled: true }, { append(text) {
    if (JSON.parse(text).stage === 'visual') throw new Error('synthetic append failure')
  } })
  const service = new AfpService(f.ctx, f.config, { connection: f.connection })
  await service.enable('refresh')
  const result = await service.startRefresh({ categories: ['food'] }, undefined, new AbortController().signal)
  await f.jobs[0].done
  const record = await service.diagnostics.read(result.runId)
  assert.equal(record.failure.stage, 'progress-output')
  assert.ok(record.events.some(row => row.stage === 'progress-output' && row.event === 'error'))
  assert.equal(record.timings.some(row => row.stage === 'vision'), false)
  await service.dispose()
})

test('checkpoint save failure is retained independently of the failed run write', async t => {
  const f = await fixture(t), original = f.store.saveRun.bind(f.store)
  let writes = 0
  f.store.saveRun = async run => { if (++writes === 2) throw Object.assign(new Error('private filesystem path'), { code: 'EBUSY' }); return original(run) }
  const service = new AfpService(f.ctx, f.config, { store: f.store, connection: f.connection })
  await service.enable('refresh')
  const result = await service.startRefresh({ categories: ['food'] }, undefined, new AbortController().signal)
  await f.jobs[0].done
  const record = await service.diagnostics.read(result.runId)
  assert.equal(record.failure.stage, 'checkpoint-save')
  assert.equal(record.failure.systemCode, 'EBUSY')
  await service.dispose()
})

test('a completed refresh records search and checkpoint timings and reloads after a new diagnostics service', async t => {
  const f = await fixture(t, { debugEnabled: true }), service = new AfpService(f.ctx, f.config, { store: f.store, connection: f.connection })
  await service.enable('refresh')
  const result = await service.startRefresh({ categories: ['food'] }, undefined, new AbortController().signal)
  assert.equal((await f.jobs[0].done).status, 'completed')
  const fresh = new AfpDiagnostics(f.store, f.config), record = await fresh.read(result.runId)
  assert.equal(record.outcome, 'paused')
  assert.equal(record.jobId, result.jobId)
  assert.ok(record.events.some(row => row.stage === 'search-initialization'))
  assert.ok(record.timings.some(row => row.stage === 'search'))
  assert.equal(record.failure, null)
  await service.dispose()
})

test('detailed events stay bounded, retention limits old reports, and another profile cannot read them', async t => {
  const f = await fixture(t, { debugEnabled: true, debugMaxBytes: 65536, debugMaxRuns: 1 })
  const diagnostics = new AfpDiagnostics(f.store, f.config)
  const first = await f.store.createRun(['food'], f.config), trace = diagnostics.begin(first.id, 'afp-1')
  for (let i = 0; i < 1500; i++) trace.sync('search', () => {})
  await trace.finish('paused')
  const record = await diagnostics.read(first.id)
  assert.ok(record.droppedEvents > 0)
  assert.ok((await readFile(diagnostics.file(first.id))).length < 65536)
  const second = await f.store.createRun(['food'], f.config)
  await diagnostics.begin(second.id, 'afp-2').finish('paused')
  assert.equal((await readdir(join(f.store.profile, 'diagnostics'))).length, 1)
  assert.equal(await diagnostics.read(first.id), null)
  const other = new AfpDiagnostics(new Store(f.home, join(f.home, 'other'), f.config.maxStateBytes), f.config)
  await assert.rejects(other.read(second.id))
  await assert.rejects(diagnostics.read('../../credentials'))
})

test('diagnostic export filters unexpected durable fields and unsafe frames', async t => {
  const f = await fixture(t), run = await f.store.createRun(['food'], f.config), diagnostics = new AfpDiagnostics(f.store, f.config)
  await diagnostics.begin(run.id, 'afp-1').finish('failed', new Error('private'), 'search')
  const file = diagnostics.file(run.id), value = JSON.parse(await readFile(file, 'utf8'))
  value.token = 'unsafe-token'; value.jobId = 'https://private.test'; value.failure.frames.push('https://private.test/token')
  value.events = [{ stage: 'https://private.test', event: 'secret-event', body: 'unsafe-token' }]
  await writeFile(file, JSON.stringify(value), 'utf8')
  const record = await diagnostics.read(run.id)
  assert.equal(record.jobId, null)
  assert.doesNotMatch(JSON.stringify(record), /unsafe-token|private\.test|secret-event/)
})

test('diagnostic sink failures do not replace the operation error', async t => {
  const f = await fixture(t), run = await f.store.createRun(['food'], f.config), diagnostics = new AfpDiagnostics(f.store, f.config)
  const trace = diagnostics.begin(run.id, 'afp-1'), original = new Error('original operation')
  f.store.write = async () => { throw new Error('diagnostic disk failure') }
  await assert.rejects(trace.measure('vision', async () => { throw original }), error => error === original)
  await trace.finish('failed', original, 'vision')
  assert.equal(trace.snapshot().storageIssue, true)
  assert.equal(trace.snapshot().failure.stage, 'vision')
})

test('debug configuration rejects wrong types and unsafe bounds', () => {
  assert.equal(resolveConfig().debugEnabled, false)
  for (const config of [{ debugEnabled: 'true' }, { debugMaxBytes: 1 }, { debugMaxRuns: 0 }, { debugRetentionDays: 0 }, { debugFlushIntervalMs: 0 }]) {
    assert.throws(() => resolveConfig(config), /debug/)
  }
  assert.equal(diagnosticFailure(new Error('secret'), 'unknown').stage, 'workflow')
})

test('real Cordis job registry retains the failed diagnostic after job settlement',
  { skip: !existsSync(new URL('../../../../packages/jobs/jobs-local/lib/index.js', import.meta.url)) }, async t => {
    const { Context } = await import(new URL('../../../../vendor/cordis/lib/index.js', import.meta.url))
    const { default: Jobs } = await import(new URL('../../../../packages/jobs/jobs-local/lib/index.js', import.meta.url))
    const f = await fixture(t), ctx = new Context()
    await ctx.plugin(Jobs, {})
    ctx.provide('profileContext', f.ctx.profileContext)
    ctx.jobs.attachController('afp-debug-test')
    const service = new AfpService(ctx, f.config, { store: f.store, connection: { open: async () => { throw new Error('synthetic provider failure') } } })
    t.after(async () => { await service.dispose(); await ctx.fiber.dispose() })
    await service.enable('refresh')
    const result = await service.startRefresh({ categories: ['food'] }, undefined, new AbortController().signal)
    const job = await ctx.jobs.wait(result.jobId, 5000)
    assert.equal(job.status, 'failed')
    assert.equal((await service.diagnostics.read(result.runId)).failure.stage, 'connection')
  })
