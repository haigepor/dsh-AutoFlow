import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireSkill, skillNames } from '../src/host/afp-skill-leases.js'
import { AfpService } from '../src/host/afp-service.js'
import { resolveConfig } from '../config-schema.js'
import { runAfpTask } from '../cli/afp-task.js'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'afp-life-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const jobs = []
  const ctx = { profileContext: { dir: join(home, 'profile'), home }, jobs: { start(spec) { const id = `job-${jobs.length}`; jobs.push({ spec, handle: spec.run({ append() {}, updateProgress() {} }) }); return id } } }
  const connection = { status: async () => ({ credentials: {}, visionConfigured: false }) }
  return { home, ctx, jobs, config: resolveConfig({}), connection }
}

test('all six Skills share holders, retain edits and refuse user-owned directories', async t => {
  const { home, config } = await fixture(t)
  for (const skill of skillNames) {
    const params = { home, skill, maxStateBytes: config.maxStateBytes }
    const first = await acquireSkill({ ...params, profile: join(home, 'one') })
    const second = await acquireSkill({ ...params, profile: join(home, 'two') })
    const path = join(home, 'skills', skill, 'SKILL.md')
    await writeFile(path, (await readFile(path, 'utf8')) + '\nUser edit\n', 'utf8')
    await first(); assert.match(await readFile(path, 'utf8'), /User edit/)
    await second(); await assert.rejects(readFile(path, 'utf8'), { code: 'ENOENT' })
    const third = await acquireSkill({ ...params, profile: join(home, 'one') })
    assert.match(await readFile(path, 'utf8'), /User edit/); await third()
  }
  const path = join(home, 'skills', skillNames[0])
  await mkdir(path); await writeFile(join(path, 'SKILL.md'), 'Existing user content', 'utf8')
  await assert.rejects(acquireSkill({ home, profile: join(home, 'other'), skill: skillNames[0], maxStateBytes: config.maxStateBytes }), /marker|conflict/)
  assert.equal(await readFile(join(path, 'SKILL.md'), 'utf8'), 'Existing user content')
})

test('a dead Skill holder is recovered, while a damaged ownership marker is retained', async t => {
  const { home, config } = await fixture(t), skill = skillNames[0]
  const release = await acquireSkill({ home, profile: join(home, 'old'), skill, maxStateBytes: config.maxStateBytes })
  const stateFile = join(home, '.plugins', 'dsh-plugin-afp', 'skills', skill, 'state.json')
  const state = JSON.parse(await readFile(stateFile, 'utf8')); state.leases[0].pid = 2147483647
  await writeFile(stateFile, JSON.stringify(state), 'utf8')
  const recovered = await acquireSkill({ home, profile: join(home, 'new'), skill, maxStateBytes: config.maxStateBytes })
  await release()
  const marker = join(home, 'skills', skill, '.dsh-afp-owner.json')
  await writeFile(marker, '{}', 'utf8')
  await assert.rejects(recovered(), /ownership/)
  assert.equal(await readFile(marker, 'utf8'), '{}')
})

test('page confirmation refuses denial, expiration and repeat; jobs are profile-owned and execution disposal drains', async t => {
  const { ctx, jobs, config, connection } = await fixture(t)
  let writes = 0, finish
  const changes = { plan: async () => ({ planId: 'plan', expiresAt: Date.now() + 10000, categories: [] }), check: async () => {}, execute: async (_id, _owner, signal) => {
    writes++
    await new Promise(resolve => { finish = resolve; signal.addEventListener('abort', resolve, { once: true }) })
    return { status: signal.aborted ? 'cancelled' : 'completed' }
  } }
  const service = new AfpService(ctx, config, { connection, changes })
  const disable = await service.enable('write'), signal = new AbortController().signal
  const preview = await service.pagePlan({}, signal)
  await assert.rejects(service.pageConfirm({ ...preview, confirmed: false }, signal), /refused/)
  service.challenges.get(preview.confirmation).expiresAt = 0
  await assert.rejects(service.pageConfirm({ ...preview, confirmed: true }, signal), /expired/)
  const valid = await service.pagePlan({}, signal)
  const first = runAfpTask(service, { operation: 'confirm', args: JSON.stringify({ planId: valid.planId, confirmation: valid.confirmation, confirmed: true }) }, signal)
  await assert.rejects(service.pageConfirm({ ...valid, confirmed: true }, signal), /consumed/)
  const result = await first
  assert.equal(result.jobId, 'job-0'); assert.equal(jobs[0].spec.owner, undefined)
  await assert.rejects(service.pageConfirm({ ...valid, confirmed: true }, signal), /consumed/)
  await new Promise(resolve => setImmediate(resolve)); assert.equal(writes, 1)
  await disable(); assert.equal((await jobs[0].handle.done).status, 'killed'); assert.equal(service.live.size, 0)
  await assert.rejects(service.pagePlan({}, signal), /unavailable/)
  finish(); await service.dispose()
})

test('Agent-owned jobs and unrelated UI toggles remain independent', async t => {
  const { ctx, config, connection, jobs } = await fixture(t)
  const service = new AfpService(ctx, config, { connection })
  await service.enable('refresh'); const hide = await service.enable('ui-panel')
  let complete
  service.job('refresh', 'session-1', 'test', async () => { await new Promise(resolve => { complete = resolve }); return { status: 'ready' } })
  await new Promise(resolve => setImmediate(resolve)); await hide()
  assert.equal(jobs[0].spec.owner, 'session-1'); assert.equal(service.live.size, 1)
  assert.equal((await service.status()).tasks.length, 0)
  await assert.rejects(service.cancel([...service.live.keys()][0]), /Session cancellation/)
  complete(); await jobs[0].handle.done; await service.dispose()
})
