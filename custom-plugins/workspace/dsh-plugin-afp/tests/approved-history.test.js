import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../config-schema.js'
import { AfpService } from '../src/host/afp-service.js'
import { digest } from '../src/host/afp-state-store.js'

const signal = () => new AbortController().signal
const photo = (id, guid = `guid-${id}`, title = `Meal ${id}`) => ({ id, guid, title,
  caption: 'Fresh homemade meal with roasted food and vegetables on a plate' })

async function fixture(t, mode = 'full', overrides = {}) {
  const home = await mkdtemp(join(tmpdir(), 'afp-history-'))
  const jobs = [], previews = [], models = [], services = []
  let account = 'first-account', searches = 0
  const photos = [photo('one'), photo('two'), photo('three')]
  const config = resolveConfig({ dedupReadMode: mode, targetPerCategory: 1, batchSize: 1,
    pageSize: 3, maxPages: 1, maxBatches: 3, maxSearchRequests: 1, ...overrides })
  const client = {
    listSelections: async () => [{ id: 'private', name: 'Named private collection', isPrivate: true,
      docsCount: 0, lastContentUpdate: '2026-10-27T00:00:00Z' }],
    getSelection: async () => ({ docs: [] }),
    photoSelectionsByIds: async ids => ids.map(id => ({ id, selections: [] })),
    searchPhotos: async () => { searches++; return { docs: structuredClone(photos), hasMore: false } },
  }
  const connection = { open: async () => ({ client, account,
    previewClient: { getPreviewBytes: async id => { previews.push(id); return { bytes: new Uint8Array([255, 216, 255]), contentType: 'image/jpeg' } } },
    visionClient: { classify: async () => { models.push(true); return { category: 'food', keep: true, confidence: .99, reason: 'Visible food' } } },
  }) }
  const create = async (profile = 'profile') => {
    const service = new AfpService({ profileContext: { home, dir: join(home, profile) },
      jobs: { start(spec) { jobs.push(spec.run({ append() {}, updateProgress() {} })); return `job-${jobs.length}` } } }, config, { connection })
    services.push(service)
    await service.enable('refresh')
    return service
  }
  const start = async (service, args = { categories: ['food'] }) => {
    const task = await service.startRefresh(args, undefined, signal())
    const result = await jobs.at(-1).done
    return { result, run: await service.store.readRun(task.runId) }
  }
  const seed = async (service, { candidates, decisions, status = 'paused', savedAccount = account } = {}) => {
    const run = await service.store.createRun(['food'], config)
    run.account = savedAccount; run.status = status
    run.groups = { food: { candidates, batches: 1, exhausted: false } }
    run.decisions = decisions
    await service.store.saveRun(run)
    return run
  }
  t.after(async () => {
    await Promise.all(services.map(service => service.dispose()))
    await rm(home, { recursive: true, force: true })
  })
  return { config, photos, client, previews, models, create, start, seed, searches: () => searches,
    account: value => { account = value } }
}

for (const mode of ['full', 'candidate']) test(`${mode}: new reports and a rebuilt service exclude prior approvals before preview and model work`, async t => {
  const f = await fixture(t, mode), service = await f.create()
  const first = await f.start(service)
  assert.deepEqual(first.run.decisions.filter(item => item.keep).map(item => item.id), ['one'])
  const resumed = await f.start(service, { runId: first.run.id })
  assert.equal(resumed.result.status, 'completed')
  assert.deepEqual(f.previews, ['one'])
  const second = await f.start(service)
  assert.deepEqual(second.run.decisions.filter(item => item.keep).map(item => item.id), ['two'])
  await service.dispose()
  const rebuilt = await f.create(), third = await f.start(rebuilt)
  assert.deepEqual(third.run.decisions.filter(item => item.keep).map(item => item.id), ['three'])
  assert.deepEqual(f.previews, ['one', 'two', 'three'])
  assert.equal(f.models.length, 3)
  assert.equal(f.searches(), 3)
})

for (const status of ['paused', 'failed', 'cancelled']) test(`valid completed approvals in ${status} reports remain excluded after archival`, async t => {
  const f = await fixture(t), service = await f.create()
  const old = await f.seed(service, { candidates: [photo('one')], status,
    decisions: [{ id: 'one', category: 'food', keep: true, confidence: .99, reason: 'Visible food' }] })
  await service.store.archiveRun(old.id)
  const next = await f.start(service)
  assert.deepEqual(next.run.decisions.filter(item => item.keep).map(item => item.id), ['two'])
  assert.deepEqual(f.previews, ['two'])
})

test('historical rejection and request failure remain eligible for a new judgment', async t => {
  const f = await fixture(t, 'candidate', { targetPerCategory: 3, batchSize: 3 }), service = await f.create()
  await f.seed(service, { candidates: f.photos.slice(0, 2), decisions: [
    { id: 'one', category: 'food', keep: false, confidence: .4, reason: 'Not clear enough' },
    { id: 'two', category: 'food', keep: false, confidence: 0, reason: 'preview or vision request failed' },
  ] })
  const next = await f.start(service)
  assert.deepEqual(next.run.decisions.filter(item => item.keep).map(item => item.id), ['one', 'two', 'three'])
  assert.deepEqual(f.previews, ['one', 'two', 'three'])
})

test('historical approvals remain isolated by account and profile', async t => {
  const f = await fixture(t), first = await f.create()
  await f.start(first)
  f.account('another-account')
  const otherAccount = await f.start(first)
  assert.deepEqual(otherAccount.run.decisions.filter(item => item.keep).map(item => item.id), ['one'])
  f.account('first-account')
  const otherProfile = await f.create('other-profile'), next = await f.start(otherProfile)
  assert.deepEqual(next.run.decisions.filter(item => item.keep).map(item => item.id), ['one'])
})

test('a verified historical GUID excludes another UNO while a different photo with the same title stays eligible', async t => {
  const f = await fixture(t, 'candidate'), service = await f.create()
  const old = photo('old-uno', 'same-guid', 'Same meal')
  await f.seed(service, { candidates: [old], decisions: [{ id: old.id, category: 'food', keep: true, confidence: .99 }] })
  f.photos.splice(0, f.photos.length, photo('new-uno', 'same-guid', 'Same meal'), photo('different', 'different-guid', 'Same meal'))
  const next = await f.start(service)
  assert.deepEqual(next.run.decisions.filter(item => item.keep).map(item => item.id), ['different'])
  assert.deepEqual(f.previews, ['different'])
})

test('an unreadable historical report stops admission rather than silently forgetting approvals', async t => {
  const f = await fixture(t), service = await f.create()
  const old = await f.seed(service, { candidates: [photo('one')], decisions: [{ id: 'one', category: 'food', keep: true }] })
  await writeFile(join(service.store.profile, 'runs', `${old.id}.json`), '{broken', 'utf8')
  const next = await f.start(service)
  assert.equal(next.result.status, 'failed')
  assert.equal(f.searches(), 0)
  assert.deepEqual(f.previews, [])
})

test('a previously failed photo approved by another report does not loop in resumed retries', async t => {
  const f = await fixture(t, 'candidate'), service = await f.create()
  const current = await f.seed(service, { candidates: [photo('one')],
    decisions: [{ id: 'one', category: 'food', keep: false, confidence: 0, reason: 'preview or vision request failed' }] })
  await f.seed(service, { candidates: [photo('one')], decisions: [{ id: 'one', category: 'food', keep: true }] })
  const save = service.store.saveRun.bind(service.store)
  let repeatedRetries = 0
  t.mock.method(service.store, 'saveRun', async run => {
    // 用状态次数界定旧缺陷的无穷重试，不依赖墙钟超时。
    if (run.pending?.retry && run.pending.candidates.some(item => item.id === 'one') && ++repeatedRetries > 3) throw new Error('Historical approval repeatedly reentered the retry queue')
    return save(run)
  })
  const next = await f.start(service, { runId: current.id })
  assert.equal(next.result.status, 'completed')
  assert.deepEqual(next.run.decisions.filter(item => item.keep).map(item => item.id), ['two'])
  assert.deepEqual(f.previews, ['two'])
})

test('a historical approval cannot be promoted from an old quantity-limit rejection', async t => {
  const f = await fixture(t), service = await f.create()
  const current = await f.seed(service, { candidates: [photo('one')], decisions: [{ id: 'one', category: 'food',
    keep: false, visualKeep: true, confidence: .99, reason: 'duplicate or category target reached' }] })
  await f.seed(service, { candidates: [photo('one')], decisions: [{ id: 'one', category: 'food', keep: true }] })
  const next = await f.start(service, { runId: current.id })
  assert.deepEqual(next.run.decisions.filter(item => item.keep).map(item => item.id), ['two'])
  assert.deepEqual(f.previews, ['two'])
})

test('unchanged reports use the persistent compact index and a same-size rewrite invalidates it', async t => {
  const f = await fixture(t), service = await f.create()
  const old = await f.seed(service, { candidates: [photo('one')], decisions: [{ id: 'one', category: 'food', keep: true }] })
  const current = await service.store.createRun(['food'], f.config)
  const source = join(service.store.profile, 'runs', `${old.id}.json`)
  const read = () => service.store.readApprovedHistory('first-account', current.id, signal())
  assert.deepEqual([...((await read()).ids)], ['one'])
  let sourceReads = 0
  const originalRead = service.store.read.bind(service.store)
  t.mock.method(service.store, 'read', file => { if (file === source) sourceReads++; return originalRead(file) })
  assert.deepEqual([...((await read()).ids)], ['one'])
  assert.equal(sourceReads, 0)
  const before = await stat(source), content = await readFile(source, 'utf8')
  await writeFile(source, content.replaceAll('one', 'two'), 'utf8')
  // 恢复 mtime 即使发生精度损失也不影响断言：其他文件版本信息仍应使索引失效。
  await utimes(source, before.atime, before.mtime)
  assert.equal((await stat(source)).size, before.size)
  assert.deepEqual([...((await read()).ids)], ['two'])
  assert.equal(sourceReads, 1)
  const rebuilt = await f.create()
  const originalRebuiltRead = rebuilt.store.read.bind(rebuilt.store)
  let rebuiltSourceReads = 0
  t.mock.method(rebuilt.store, 'read', file => { if (file === source) rebuiltSourceReads++; return originalRebuiltRead(file) })
  assert.deepEqual([...((await rebuilt.store.readApprovedHistory('first-account', current.id, signal())).ids)], ['two'])
  assert.equal(rebuiltSourceReads, 0)
})

test('archiving between history enumeration and reading retains the approval', async t => {
  const f = await fixture(t), service = await f.create()
  const old = await f.seed(service, { candidates: [photo('one')], decisions: [{ id: 'one', category: 'food', keep: true }] })
  const current = await service.store.createRun(['food'], f.config)
  const readRun = service.store.readRun.bind(service.store)
  let moved = false
  t.mock.method(service.store, 'readRun', async (id, options) => {
    if (id === old.id && !moved) { moved = true; await service.store.archiveRun(id) }
    return readRun(id, options)
  })
  const history = await service.store.readApprovedHistory('first-account', current.id, signal())
  assert.equal(moved, true)
  assert.deepEqual([...history.ids], ['one'])
})

test('malformed compact history stops the next task before candidate search and model work', async t => {
  const f = await fixture(t), service = await f.create()
  await f.start(service); await f.start(service)
  const searches = f.searches(), previews = [...f.previews]
  await writeFile(join(service.store.profile, 'approved-history', `${digest('first-account')}.json`),
    JSON.stringify({ schema: 1, account: 'different-account', records: {} }), 'utf8')
  const next = await f.start(service)
  assert.equal(next.result.status, 'failed')
  assert.equal(next.run.failure.stage, 'approved-history')
  assert.equal(f.searches(), searches)
  assert.deepEqual(f.previews, previews)
})

test('an index write failure stops admission and retains the original report', async t => {
  const f = await fixture(t), service = await f.create()
  const old = await f.seed(service, { candidates: [photo('one')], decisions: [{ id: 'one', category: 'food', keep: true }] })
  const originalWrite = service.store.write.bind(service.store)
  t.mock.method(service.store, 'write', (file, record) => {
    if (file.includes('approved-history')) throw Object.assign(new Error('Synthetic disk failure'), { code: 'ENOSPC' })
    return originalWrite(file, record)
  })
  const next = await f.start(service)
  assert.equal(next.result.status, 'failed')
  assert.equal(next.run.failure.stage, 'approved-history')
  assert.equal(f.searches(), 0)
  assert.equal((await service.store.readRun(old.id)).decisions[0].keep, true)
})

test('a new photo appearing on the latest page remains eligible after earlier approvals', async t => {
  const f = await fixture(t), service = await f.create()
  await f.start(service)
  f.photos.unshift(photo('latest-photo'))
  const next = await f.start(service)
  assert.deepEqual(next.run.decisions.filter(item => item.keep).map(item => item.id), ['latest-photo'])
  assert.deepEqual(f.previews, ['one', 'latest-photo'])
})

test('candidate fallback preserves local approvals without publishing them as remote members', async t => {
  const f = await fixture(t, 'candidate'), service = await f.create()
  await f.seed(service, { candidates: [photo('one')], decisions: [{ id: 'one', category: 'food', keep: true }] })
  f.client.photoSelectionsByIds = async () => []
  const next = await f.start(service)
  assert.deepEqual(next.run.decisions.filter(item => item.keep).map(item => item.id), ['two'])
  assert.deepEqual(f.previews, ['two'])
  assert.deepEqual(next.run.dedup.collections.private.ids, [])
  assert.deepEqual(service.dedupSnapshot.collections.private.ids, [])
})
