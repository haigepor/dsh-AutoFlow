import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AfpService } from '../src/host/afp-service.js'
import { registerAgentTools } from '../src/host/afp-agent-tools.js'
import { registerExtendedAgentTools } from '../src/host/afp-agent-operations.js'
import { resolveConfig } from '../config-schema.js'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'afp-agent-operations-'))
  const jobs = [], writes = [], purchases = [], events = [], disposers = [], tools = new Map(), approval = []
  let account = 'account-a', cost = 3, serial = 0
  const catalog = [{ id: 'source', name: 'Source', isPrivate: true }, { id: 'target', name: 'Target', isPrivate: true }]
  const contents = new Map([['source', ['p1', 'p2']], ['target', ['p3']]])
  const photo = id => ({ id, guid: `guid-${id}`, title: `Photo ${id}`, provider: 'AFP' })
  const client = {
    listSelections: async () => structuredClone(catalog),
    getSelection: async id => ({ docs: [...(contents.get(id) ?? [])] }),
    photosByIds: async ids => ids.map(photo),
    addSelectionDoc: async (id, doc) => { writes.push(['add', id, doc.id]); contents.set(id, [...contents.get(id), doc.id]) },
    deleteSelectionDocs: async (id, ids) => { writes.push(['remove', id, ids]); contents.set(id, contents.get(id).filter(value => !ids.includes(value))) },
    downloadPhotoDetails: async id => ({ ...photo(id), downloadableMedias: [
      { name: 'Mockup', mediaKey: 'free', cost: 0, payable: true, href: 'https://afp.invalid/host-only-secret' },
      { name: 'HighRes', mediaKey: 'paid', cost, payable: true, validateOrderId: 'host-only-secret',
        ...(purchases.some(item => item.id === id) ? { href: 'https://afp.invalid/host-only-secret' } : {}) },
    ] }),
    buyPhoto: async args => { purchases.push(args); return { accepted: true, status: 202 } },
    downloadMedia: async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), { headers: { 'content-type': 'image/jpeg' } }),
  }
  const sessions = new Map(), ctx = {
    profileContext: { dir: join(home, 'profile'), home }, get: () => sessions,
    directoryPicker: { capability: () => ({ kind: 'native', pick: async () => home }) },
    jobs: { start(spec) {
      const id = `job-${jobs.length}`
      jobs.push({ id, spec, handle: spec.run({ append() {}, updateProgress() {} }) })
      return id
    } },
  }
  const connection = { open: async signal => { signal.throwIfAborted(); return { client, account, readAccountProfile: async () => ({ credit: 20 }) } } }
  const service = new AfpService(ctx, resolveConfig({}), { connection })
  const disableRead = await service.enable('read'), disableWrite = await service.enable('write')
  t.after(async () => {
    await service.dispose()
    for (const dispose of disposers.reverse()) dispose?.()
    await rm(home, { recursive: true, force: true })
  })
  const toolCtx = { effect(fn) { disposers.push(fn()) }, tools: { register(spec) { tools.set(spec.name, spec); return () => tools.delete(spec.name) } },
    on(name, fn) { if (name === 'tools/pre-execute') approval.push(fn); return () => {} } }
  registerAgentTools(toolCtx, service, 'read'); registerExtendedAgentTools(toolCtx, service)
  const append = (type, data) => events.push({ seq: events.length, type, data })
  append('turn/start', { turn: 1 })
  const session = { id: 'session-a', snapshotEvents: () => events }
  sessions.set(session.id, session)
  const exec = { agent: { id: session.id, session }, signal: new AbortController().signal }
  const invoke = async (name, args, context = exec) => {
    const callId = `call-${++serial}`, execution = { ...context, callId, name, arguments: args }
    append('tool/call', { turn: 1, callId, name, arguments: args })
    const value = await tools.get(name).execute(args, execution)
    append('tool/result', { turn: 1, message: { toolCallId: callId, content: [{ type: 'text', text: value }] }, meta: tools.get(name).output.presentationMeta(args, value) })
    return JSON.parse(value)
  }
  const decision = args => approval[0]({ ...exec, name: 'afp_operation_apply', arguments: args }, async () => ({ kind: 'allow' }))
  const add = { action: 'add', photoIds: ['p1'], sourceCollectionIds: [], targetCollectionId: 'target' }
  return { home, service, client, catalog, contents, jobs, writes, purchases, exec, events, append, invoke, decision, add, disableWrite, disableRead,
    setAccount: value => { account = value }, setCost: value => { cost = value } }
}


test('whole-category clearing excludes an overlapping exact-photo write', async t => {
  const f = await fixture(t)
  await f.service.store.saveBindings('account-a', { animals: { id: 'target', name: 'Target' } })
  await f.invoke('afp_photo_details', { photoId: 'p1' })
  const subset = await f.invoke('afp_collection_plan', f.add)
  const whole = await f.service.changes.plan({ operation: 'clear', categories: ['animals'] }, f.exec.agent.id, f.exec.signal)
  assert.equal((await f.decision({ planId: subset.planId })).kind, 'ask')
  assert.equal((await f.service.changes.check(whole.planId, f.exec.agent.id)).requiresApproval, true)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  f.client.clearSelectionDocs = async id => { entered.resolve(); await release.promise; f.writes.push(['clear', id]); f.contents.set(id, []) }
  const clearing = f.service.changes.execute(whole.planId, f.exec.agent.id, f.exec.signal)
  await entered.promise
  try {
    await f.invoke('afp_operation_apply', { planId: subset.planId })
    assert.equal((await f.jobs.at(-1).handle.done).status, 'failed')
    assert.deepEqual(f.contents.get('target'), ['p3'])
    assert.equal(f.writes.length, 0)
  } finally { release.resolve(); await clearing }
  assert.deepEqual(f.contents.get('target'), [])
  assert.deepEqual(f.writes, [['clear', 'target']])
  assert.equal((await f.decision({ planId: subset.planId })).kind, 'deny')
  const fresh = await f.invoke('afp_collection_plan', f.add)
  assert.equal((await f.decision({ planId: fresh.planId })).kind, 'ask')
  assert.deepEqual(f.writes, [['clear', 'target']])
})

test('an exact-photo write excludes overlapping whole-category clearing', async t => {
  const f = await fixture(t)
  await f.service.store.saveBindings('account-a', { animals: { id: 'target', name: 'Target' } })
  await f.invoke('afp_photo_details', { photoId: 'p1' })
  const subset = await f.invoke('afp_collection_plan', f.add)
  const whole = await f.service.changes.plan({ operation: 'clear', categories: ['animals'] }, f.exec.agent.id, f.exec.signal)
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), add = f.client.addSelectionDoc
  f.client.addSelectionDoc = async (...args) => { entered.resolve(); await release.promise; return add(...args) }
  f.client.clearSelectionDocs = async id => { f.writes.push(['clear', id]); f.contents.set(id, []) }
  await f.invoke('afp_operation_apply', { planId: subset.planId })
  await entered.promise
  try {
    await assert.rejects(f.service.changes.execute(whole.planId, f.exec.agent.id, f.exec.signal), /operation busy/)
    assert.deepEqual(f.contents.get('target'), ['p3'])
    assert.equal(f.writes.length, 0)
  } finally { release.resolve(); await f.jobs.at(-1).handle.done }
  assert.equal((await f.jobs.at(-1).handle.done).status, 'completed')
  assert.deepEqual(f.contents.get('target'), ['p3', 'p1'])
  await assert.rejects(f.service.changes.execute(whole.planId, f.exec.agent.id, f.exec.signal), /collections changed/)
  assert.deepEqual(f.writes, [['add', 'target', 'p1']])
})

test('paused run items deduplicate category-photo identities before filtering and pagination', async t => {
  const f = await fixture(t), run = await f.service.store.createRun(['animals', 'food'], f.service.config)
  const photo = id => ({ id, title: 'Photo ' + id })
  run.status = 'paused'
  run.groups = { animals: { candidates: ['p1', 'p2', 'p1'].map(photo), batches: 0, exhausted: false },
    food: { candidates: [photo('p1')], batches: 0, exhausted: false } }
  run.pending = { category: 'animals', candidates: ['p1', 'p2', 'p3', 'p3'].map(photo), exhausted: false }
  run.decisions = [{ id: 'p1', category: 'animals', keep: true, confidence: .99, reason: 'Visible animal' },
    { id: 'p2', category: 'animals', keep: false, reason: 'preview or vision request failed' },
    { id: 'p1', category: 'food', keep: false, reason: 'Not food' }]
  await f.service.store.saveRun(run)
  const args = { runId: run.id, category: 'all', decision: 'all', offset: 0, limit: 2 }
  const first = await f.invoke('afp_run_items', args)
  const second = await f.invoke('afp_run_items', { ...args, offset: first.runNextOffset })
  assert.equal(first.total, 4); assert.equal(second.total, 4); assert.equal(second.runNextOffset, null)
  assert.deepEqual([...first.items, ...second.items].map(item => [item.category, item.id]),
    [['animals', 'p1'], ['animals', 'p2'], ['food', 'p1'], ['animals', 'p3']])
  assert.equal(second.items[1].keep, null)
  for (const [decision, category, id] of [['kept', 'animals', 'p1'], ['failed', 'animals', 'p2'], ['rejected', 'food', 'p1']]) {
    const page = await f.invoke('afp_run_items', { ...args, decision })
    assert.equal(page.total, 1); assert.equal(page.runNextOffset, null)
    assert.deepEqual(page.items.map(item => [item.category, item.id]), [[category, id]])
  }
  const animals = await f.invoke('afp_run_items', { ...args, category: 'animals', limit: 10 })
  assert.equal(animals.total, 3)
  assert.equal(f.writes.length, 0); assert.equal(f.purchases.length, 0)
})

test('whole-category previews skip unnamed rows and retain named shared reads and failures', async t => {
  const f = await fixture(t), bindings = { animals: { id: 'target', name: 'Target' } }
  await f.service.store.saveBindings('account-a', bindings)
  const run = await f.service.store.createRun(['animals'], f.service.config)
  run.account = 'account-a'; run.status = 'ready'; run.bindings = bindings
  run.groups = { animals: { candidates: [{ id: 'p4', guid: 'guid-p4', title: 'An animal' }], batches: 1, exhausted: false } }
  run.decisions = [{ id: 'p4', category: 'animals', keep: true, confidence: 1 }]
  await f.service.store.saveRun(run)
  f.catalog.push({ id: 'unnamed', name: '', isPrivate: false }, { id: 'shared', name: 'Shared', isPrivate: false })
  f.contents.set('shared', ['shared-photo'])
  const reads = [], original = f.client.getSelection
  const denied = Object.assign(new Error('Shared read denied'), { code: 'EACCES' })
  let denyShared = false
  f.client.getSelection = async id => {
    reads.push(id)
    if (id === 'unnamed') throw new Error('Directory row is not a collection')
    if (id === 'shared' && denyShared) throw denied
    return original(id)
  }
  for (const operation of ['append', 'replace', 'clear']) {
    const plan = await f.service.changes.plan({ operation, categories: ['animals'], ...(operation === 'clear' ? {} : { runId: run.id }) },
      f.exec.agent.id, f.exec.signal)
    assert.equal(plan.requiresApproval, true)
    assert.equal(plan.categories[0].add, operation === 'clear' ? 0 : 1)
  }
  assert.equal(reads.includes('unnamed'), false); assert.equal(reads.filter(id => id === 'shared').length, 3)
  denyShared = true
  await assert.rejects(f.service.changes.plan({ operation: 'clear', categories: ['animals'] }, f.exec.agent.id, f.exec.signal), error => error === denied)
  assert.equal(f.writes.length, 0); assert.equal(f.jobs.length, 0)
})

test('binding previews reject the same invalid and occupied targets as execution', async t => {
  for (const scenario of ['duplicate name', 'default category', 'explicit category', 'read-only']) await t.test(scenario, async child => {
    const f = await fixture(child)
    if (scenario === 'duplicate name') f.catalog[0].name = 'Target'
    if (scenario === 'default category') f.catalog[1].name = 'AutoFlow_食物'
    if (scenario === 'explicit category') await f.service.store.saveBindings('account-a', { food: { id: 'target', name: 'Target' } })
    if (scenario === 'read-only') f.catalog[1].readOnly = true
    const args = { category: 'animals', collectionId: 'target' }
    await assert.rejects(f.invoke('afp_category_plan', args), error => {
      const value = JSON.parse(error.message)
      assert.equal(value.code, 'operation-invalid-choice'); assert.equal(value.field, 'collectionId')
      assert.match(value.action, /null/); assert.equal(value.retryable, false)
      return true
    })
    await assert.rejects(f.service.bindCategory(args, f.exec.signal))
    assert.equal(f.service.agentOperations.plans.size, 0)
    assert.equal(f.writes.length, 0); assert.equal(f.jobs.length, 0)
  })
})

test('archived unrelated reports do not block metadata-backed collection or download previews', async t => {
  const f = await fixture(t)
  await f.invoke('afp_photo_details', { photoId: 'p1' })
  const old = await f.service.store.createRun(['animals'], f.service.config)
  await f.invoke('afp_report', { kind: 'run', id: old.id })
  await f.invoke('afp_run_control', { action: 'archive', runId: old.id })
  const collection = await f.invoke('afp_collection_plan', f.add)
  assert.equal((await f.decision({ planId: collection.planId })).kind, 'ask')
  const options = await f.invoke('afp_download_options', { photoIds: ['p1'] })
  const directory = await f.invoke('afp_download_directory', { action: 'select', path: null })
  const free = options.photos[0].renditions.find(row => row.purchaseCost === 0)
  const download = await f.invoke('afp_download_plan', { items: [{ photoId: 'p1', renditionId: free.id }],
    directoryId: directory.directory.directoryId, prefix: '', suffix: '' })
  assert.equal((await f.decision({ planId: download.planId })).kind, 'ask')
  assert.equal(f.jobs.length, 0); assert.equal(f.writes.length, 0); assert.equal(f.purchases.length, 0)
})

test('missing old reports contribute no evidence and do not hide a later valid report', async t => {
  const f = await fixture(t)
  const old = await f.service.store.createRun(['animals'], f.service.config)
  await f.invoke('afp_report', { kind: 'run', id: old.id })
  await f.invoke('afp_run_control', { action: 'archive', runId: old.id })
  await assert.rejects(f.invoke('afp_collection_plan', f.add), e => JSON.parse(e.message).code === 'operation-evidence-missing')
  const current = await f.service.store.createRun(['animals'], f.service.config)
  current.groups.animals = { candidates: [{ id: 'p1', title: 'Cat' }], batches: 1 }
  current.decisions = [{ id: 'p1', category: 'animals', keep: true }]
  await f.service.store.saveRun(current)
  await f.invoke('afp_report', { kind: 'run', id: current.id })
  assert.ok((await f.invoke('afp_collection_plan', f.add)).planId)
  const read = f.service.store.readRun.bind(f.service.store)
  const denied = Object.assign(new Error('Access denied'), { code: 'EACCES' })
  f.service.store.readRun = async id => { if (id === old.id) throw denied; return read(id) }
  await assert.rejects(f.service.agentOperations.evidence(f.exec, ['not-read']), error => error === denied)
  assert.equal(f.writes.length, 0)
})

test('long run items use bounded saved results without losing review fields or either pagination cursor', async t => {
  const f = await fixture(t)
  f.service.config.agentResultMaxBytes = 4096
  const photos = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, title: 'Cat', caption: 'C'.repeat(12000), provider: 'AFP' }))
  const verdicts = photos.map((photo, i) => ({ id: photo.id, category: 'animals', keep: i % 4 === 0,
    confidence: .91, reason: i % 4 === 2 ? 'preview or vision request failed' : 'Visible subject. '.repeat(25) })).filter((_row, i) => i % 4 !== 3)
  const run = await f.service.store.createRun(['animals'], f.service.config)
  run.groups.animals = { candidates: photos, batches: 1 }; run.decisions = verdicts
  await f.service.store.saveRun(run)
  const collected = [], pages = []
  let offset = 0
  do {
    const batch = await f.invoke('afp_run_items', { runId: run.id, category: 'all', decision: 'all', offset, limit: 6 })
    assert.equal(batch.runOffset, offset); assert.equal(batch.total, 12)
    assert.ok(batch.items.length < 6); assert.ok(batch.resultRef)
    const saved = await f.service.conversationRecords.read({ sessionId: f.exec.agent.id, turn: 1 }, batch.resultRef)
    assert.equal(saved.items[0].caption.length, 12000)
    let page = batch
    for (;;) {
      pages.push(page); collected.push(...page.items)
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4096)
      assert.equal(page.runOffset, offset); assert.equal(page.runNextOffset, batch.runNextOffset)
      assert.equal(page.total, 12)
      if (page.nextOffset === null) break
      assert.ok(page.nextOffset > page.offset)
      page = await f.invoke('afp_result_page', { resultRef: page.resultRef, offset: page.nextOffset, limit: 2 })
    }
    offset = batch.runNextOffset
  } while (offset !== null)
  assert.ok(pages.length > 2)
  assert.deepEqual(collected.map(photo => photo.id), photos.map(photo => photo.id))
  for (const photo of collected) {
    const verdict = verdicts.find(row => row.id === photo.id)
    assert.equal(photo.category, 'animals'); assert.equal(photo.keep, verdict?.keep ?? null)
    assert.equal(photo.confidence, verdict?.confidence ?? null); assert.equal(photo.reason, verdict?.reason ?? '')
    assert.equal(photo.requestFailed, verdict?.reason === 'preview or vision request failed')
    assert.ok(photo.caption.length <= 400)
  }
  assert.equal(f.writes.length, 0); assert.equal(f.purchases.length, 0)
})

test('nullable operation fields identify the correction and preserve approval requirements', async t => {
  const f = await fixture(t)
  await f.invoke('afp_photo_details', { photoId: 'p1' })
  const remove = { action: 'remove', photoIds: ['p1'], sourceCollectionIds: ['source'], targetCollectionId: 'null' }
  await assert.rejects(f.invoke('afp_collection_plan', remove), error => {
    const value = JSON.parse(error.message)
    assert.equal(value.code, 'operation-invalid-choice'); assert.equal(value.field, 'targetCollectionId')
    assert.equal(value.expectedType, 'null'); assert.equal(value.receivedType, 'string')
    return true
  })
  const removal = await f.invoke('afp_collection_plan', { ...remove, targetCollectionId: null })
  assert.equal((await f.decision({ planId: removal.planId })).kind, 'ask')
  await assert.rejects(f.invoke('afp_category_plan', { category: 'animals', collectionId: 'null' }), error => {
    const value = JSON.parse(error.message)
    assert.equal(value.code, 'operation-invalid-choice'); assert.equal(value.field, 'collectionId')
    assert.match(value.action, /"collectionId":null/)
    return true
  })
  const binding = await f.invoke('afp_category_plan', { category: 'animals', collectionId: null })
  assert.equal((await f.decision({ planId: binding.planId })).kind, 'ask')
  await assert.rejects(f.invoke('afp_download_directory', { action: 'select', path: 'null' }), error => {
    const value = JSON.parse(error.message)
    assert.equal(value.code, 'operation-failed'); assert.equal(value.field, 'path'); assert.equal(value.expectedType, 'null')
    return true
  })
  assert.ok((await f.invoke('afp_download_directory', { action: 'select', path: null })).directory.directoryId)
  assert.equal(f.jobs.length, 0); assert.equal(f.writes.length, 0); assert.equal(f.purchases.length, 0)
})

test('opaque collection IDs and browse paths named null are preserved as strings', async t => {
  const f = await fixture(t)
  f.catalog.push({ id: 'null', name: 'Named null', isPrivate: true }); f.contents.set('null', [])
  await f.invoke('afp_photo_details', { photoId: 'p1' })
  assert.ok((await f.invoke('afp_collection_plan', { ...f.add, targetCollectionId: 'null' })).planId)
  assert.ok((await f.invoke('afp_category_plan', { category: 'animals', collectionId: 'null' })).planId)
  let path
  f.service.ctx.directoryPicker.capability = () => ({ kind: 'browse', list: async requested => { path = requested; return { path: f.home, entries: [] } } })
  assert.ok((await f.invoke('afp_download_directory', { action: 'select', path: 'null' })).directory.directoryId)
  assert.equal(path, 'null'); assert.equal(f.writes.length, 0)
})

test('exact subset preview asks for approval and writes only the approved photos in a Session-owned job', async t => {
  const f = await fixture(t)
  await f.invoke('afp_photo_details', { photoId: 'p1' })
  await f.invoke('afp_photo_details', { photoId: 'p2' })
  const plan = await f.invoke('afp_collection_plan', f.add)
  assert.equal(plan.add, 1); assert.equal(plan.remove, 0)
  assert.deepEqual(plan.photoIds, ['p1']); assert.deepEqual(plan.target, { id: 'target', name: 'Target' })
  assert.equal((await f.decision({ planId: plan.planId })).kind, 'ask')
  assert.equal(f.writes.length, 0)
  const queued = await f.invoke('afp_operation_apply', { planId: plan.planId })
  assert.equal(queued.jobId, 'job-0'); assert.equal(f.jobs[0].spec.owner, f.exec.agent.id)
  assert.equal((await f.jobs[0].handle.done).status, 'completed')
  assert.deepEqual(f.contents.get('target'), ['p3', 'p1'])
  assert.equal((await f.decision({ planId: plan.planId })).kind, 'deny')
})

test('copy, move and remove preserve unrelated collection members', async t => {
  const f = await fixture(t)
  await f.invoke('afp_collection_items', { collectionId: 'source' })
  for (const action of ['copy', 'move', 'remove']) {
    f.contents.set('source', ['p1', 'p2']); f.contents.set('target', ['p3'])
    const plan = await f.invoke('afp_collection_plan', { ...f.add, action, sourceCollectionIds: ['source'], targetCollectionId: action === 'remove' ? null : 'target' })
    await f.invoke('afp_operation_apply', { planId: plan.planId })
    assert.equal((await f.jobs.at(-1).handle.done).status, 'completed')
    assert.deepEqual(f.contents.get('source'), action === 'copy' ? ['p1', 'p2'] : ['p2'])
    assert.deepEqual(f.contents.get('target'), action === 'remove' ? ['p3'] : ['p3', 'p1'])
  }
})

test('foreign sessions, changed account, changed collections and expired plans cannot write', async t => {
  const f = await fixture(t)
  await f.invoke('afp_photo_details', { photoId: 'p1' })
  const plan = await f.service.agentOperations.collectionPlan(f.add, f.exec)
  assert.throws(() => f.service.agentOperations.check(plan.planId, 'other'), /another conversation/)
  f.setAccount('account-b')
  await assert.rejects(f.service.agentOperations.apply(plan.planId, f.exec), /state changed/)
  f.setAccount('account-a'); f.contents.set('target', ['new'])
  await assert.rejects(f.service.agentOperations.apply(plan.planId, f.exec), /state changed/)
  f.service.agentOperations.plans.get(plan.planId).expiresAt = 0
  assert.throws(() => f.service.agentOperations.check(plan.planId, f.exec.agent.id), /expired/)
  assert.equal(f.writes.length, 0); assert.equal(f.jobs.length, 0)
})

test('overlapping apply calls consume one approval only once', async t => {
  const f = await fixture(t)
  await f.invoke('afp_photo_details', { photoId: 'p1' })
  const plan = await f.service.agentOperations.collectionPlan(f.add, f.exec)
  const results = await Promise.allSettled([f.service.agentOperations.apply(plan.planId, f.exec), f.service.agentOperations.apply(plan.planId, f.exec)])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  await f.jobs[0].handle.done
  assert.equal(f.jobs.length, 1); assert.deepEqual(f.writes, [['add', 'target', 'p1']])
})

test('membership drift while an approved job is queued is checked inside the write lock', async t => {
  const f = await fixture(t)
  await f.invoke('afp_photo_details', { photoId: 'p1' })
  const plan = await f.service.agentOperations.collectionPlan(f.add, f.exec)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const held = f.service.store.lock('account:account-a', async () => { entered.resolve(); await release.promise })
  await entered.promise
  await f.service.agentOperations.apply(plan.planId, f.exec)
  f.contents.set('target', ['changed-after-approval'])
  release.resolve(); await held
  assert.equal((await f.jobs[0].handle.done).status, 'failed')
  assert.equal(f.writes.length, 0)
})

test('missing current-Turn evidence and read-only targets are rejected before approval', async t => {
  const f = await fixture(t)
  await assert.rejects(f.invoke('afp_collection_plan', f.add), error => JSON.parse(error.message).code === 'operation-evidence-missing')
  await f.invoke('afp_photo_details', { photoId: 'p1' })
  const plan = await f.invoke('afp_collection_plan', f.add)
  assert.ok(plan.planId)
  f.catalog[1].readOnly = true
  await assert.rejects(f.service.agentOperations.collectionPlan(f.add, f.exec), /writable/)
  f.append('turn/start', { turn: 2 })
  await assert.rejects(f.service.agentOperations.collectionPlan(f.add, f.exec), /evidence/)
  assert.equal(f.writes.length, 0)
})

test('revoking read capability drains a pending operation preview without publishing its result', async t => {
  const f = await fixture(t)
  await f.invoke('afp_photo_details', { photoId: 'p1' })
  const entered = Promise.withResolvers()
  let activeSignal
  const open = f.service.connection.open
  f.service.connection.open = async signal => { activeSignal = signal; return open(signal) }
  f.client.listSelections = async () => {
    entered.resolve()
    await new Promise(resolve => activeSignal.addEventListener('abort', resolve, { once: true }))
    activeSignal.throwIfAborted()
  }
  const reading = f.invoke('afp_collection_plan', f.add)
  const refused = assert.rejects(reading, error => JSON.parse(error.message).code === 'feature-disabled')
  await entered.promise
  await f.disableRead()
  await refused
  assert.equal(f.service.agentOperations.plans.size, 0)
  assert.equal(f.writes.length, 0)
})

test('an uncertain remote write fails the job and cannot be retried with the consumed plan', async t => {
  const f = await fixture(t)
  await f.invoke('afp_photo_details', { photoId: 'p1' })
  const plan = await f.invoke('afp_collection_plan', f.add)
  f.client.addSelectionDoc = async () => { throw new Error('unknown remote outcome') }
  await f.invoke('afp_operation_apply', { planId: plan.planId })
  const result = await f.jobs[0].handle.done
  assert.equal(result.status, 'failed'); assert.equal(JSON.parse(result.result).pending, 1)
  await assert.rejects(f.service.agentOperations.apply(plan.planId, f.exec), /used/)
  assert.equal(f.jobs.length, 1)
})

test('category binding preview is approved locally and refuses a changed account', async t => {
  const f = await fixture(t)
  const args = { category: 'food', collectionId: 'target' }
  const plan = await f.invoke('afp_category_plan', args)
  f.setAccount('other')
  await assert.rejects(f.service.agentOperations.apply(plan.planId, f.exec), /state changed/)
  f.setAccount('account-a')
  assert.equal((await f.decision({ planId: plan.planId })).kind, 'ask')
  const applied = await f.invoke('afp_operation_apply', { planId: plan.planId })
  assert.deepEqual(applied.binding, { id: 'target', name: 'Target' })
  assert.equal((await f.service.store.readBindings('account-a')).values.food.id, 'target')
  assert.equal(f.writes.length, 0)
})

test('saved-run paging retains decisions and supplies metadata evidence without claiming visual acceptance', async t => {
  const f = await fixture(t)
  const run = await f.service.store.createRun(['animals'], f.service.config)
  run.groups.animals = { candidates: ['p1', 'p2', 'p3'].map(id => ({ id, title: id })), batches: 1 }
  run.decisions = [{ id: 'p1', category: 'animals', keep: true, reason: 'Clear subject' },
    { id: 'p2', category: 'animals', keep: false, reason: 'Obstructed subject' }]
  await f.service.store.saveRun(run)
  const page = await f.invoke('afp_run_items', { runId: run.id, category: 'all', decision: 'all', offset: 1, limit: 1 })
  assert.equal(page.runOffset, 1); assert.equal(page.runNextOffset, 2)
  assert.equal(page.items.length, 1); assert.equal(page.items[0].id, 'p2')
  assert.equal(page.items[0].keep, false); assert.equal(page.items[0].reason, 'Obstructed subject')
  const selection = { photoIds: ['p2'], criteria: 'Inspect rejected metadata', basis: 'metadata', runId: null }
  assert.equal((await f.invoke('afp_photo_selection', selection)).items[0].id, 'p2')
  await assert.rejects(f.invoke('afp_photo_selection', { ...selection, basis: 'visual', runId: run.id }),
    error => JSON.parse(error.message).code === 'selection-report-missing')
  const history = await f.invoke('afp_history', { kind: 'runs', offset: 0, limit: 1 })
  assert.equal(history.items[0].id, run.id)
})

test('the owning Agent pauses to a durable checkpoint and archives the settled report', async t => {
  const f = await fixture(t)
  await f.service.enable('refresh')
  const entered = Promise.withResolvers()
  f.service.connection.open = async signal => {
    entered.resolve()
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    signal.throwIfAborted()
  }
  const job = await f.service.startRefresh({ categories: ['food'] }, f.exec.agent.id, f.exec.signal)
  await entered.promise
  await assert.rejects(f.service.pauseRun(job.runId, 'foreign-session'), /owning AFP Agent/)
  const paused = await f.invoke('afp_run_control', { action: 'pause', runId: job.runId })
  assert.equal(paused.paused, true); assert.equal((await f.service.store.readRun(job.runId)).status, 'paused')
  const diagnostics = await f.invoke('afp_diagnostics', { runId: job.runId, offset: 0, limit: 1 })
  assert.ok(diagnostics.diagnostics); assert.ok(diagnostics.diagnostics.timings.length <= 1)
  assert.doesNotMatch(JSON.stringify(diagnostics), /host-only-secret/)
  assert.equal((await f.invoke('afp_run_control', { action: 'archive', runId: job.runId })).archived, true)
  await assert.rejects(f.service.store.readRun(job.runId), /Missing AFP record/)
  const archived = await f.service.store.read(join(f.service.store.profile, 'archived-runs', `${job.runId}.json`))
  assert.equal(archived.status, 'paused')
  assert.equal(f.writes.length, 0)
})

test('download preview hides confirmation secrets, owns its job and preserves the selected rendition', async t => {
  const f = await fixture(t)
  await f.invoke('afp_photo_details', { photoId: 'p1' })
  const options = await f.invoke('afp_download_options', { photoIds: ['p1'] })
  const directory = await f.invoke('afp_download_directory', { action: 'select', path: null })
  const free = options.photos[0].renditions.find(row => row.purchaseCost === 0)
  const plan = await f.invoke('afp_download_plan', { items: [{ photoId: 'p1', renditionId: free.id }], directoryId: directory.directory.directoryId, prefix: '', suffix: '' })
  assert.equal(plan.totalCost, 0); assert.equal(plan.destination.directoryId, directory.directory.directoryId)
  assert.equal(plan.confirmation, undefined); assert.doesNotMatch(JSON.stringify(plan), /host-only-secret|https:/)
  assert.equal((await f.decision({ planId: plan.planId })).kind, 'ask')
  await f.invoke('afp_operation_apply', { planId: plan.planId })
  assert.equal(f.jobs[0].spec.owner, f.exec.agent.id)
  assert.equal((await f.jobs[0].handle.done).status, 'completed')
  const image = (await readdir(f.home)).find(name => name.endsWith('.jpg'))
  assert.ok(image); assert.deepEqual([...await readFile(join(f.home, image))], [0xff, 0xd8, 0xff, 0x00])
  assert.equal(f.purchases.length, 0)
})

test('a changed paid download quote requests a new selection without purchasing', async t => {
  const f = await fixture(t)
  await f.invoke('afp_photo_details', { photoId: 'p1' })
  const options = await f.invoke('afp_download_options', { photoIds: ['p1'] })
  const directory = await f.invoke('afp_download_directory', { action: 'select', path: null })
  const paid = options.photos[0].renditions.find(row => row.purchaseCost > 0)
  const plan = await f.invoke('afp_download_plan', { items: [{ photoId: 'p1', renditionId: paid.id }], directoryId: directory.directory.directoryId, prefix: '', suffix: '' })
  assert.equal(plan.totalCost, 3)
  f.setCost(7)
  const changed = await f.invoke('afp_operation_apply', { planId: plan.planId })
  assert.equal(changed.requiresReconfirmation, true); assert.equal(changed.totalCost, 7)
  assert.equal(f.purchases.length, 0); assert.equal(f.jobs.length, 0)
})

test('paid downloads require write capability and purchase once after approval', async t => {
  const f = await fixture(t)
  await f.invoke('afp_photo_details', { photoId: 'p1' })
  const options = await f.invoke('afp_download_options', { photoIds: ['p1'] })
  const directory = await f.invoke('afp_download_directory', { action: 'select', path: null })
  const paid = options.photos[0].renditions.find(row => row.purchaseCost > 0)
  const args = { items: [{ photoId: 'p1', renditionId: paid.id }], directoryId: directory.directory.directoryId, prefix: '', suffix: '' }
  const blocked = await f.service.agentOperations.downloadPlan(args, f.exec)
  await f.disableWrite()
  assert.equal((await f.decision({ planId: blocked.planId })).kind, 'deny')
  assert.equal(f.purchases.length, 0)
  await f.service.enable('write')
  const approved = await f.service.agentOperations.downloadPlan(args, f.exec)
  assert.equal((await f.decision({ planId: approved.planId })).kind, 'ask')
  assert.equal(f.purchases.length, 0)
  await f.service.agentOperations.apply(approved.planId, f.exec)
  assert.equal((await f.jobs[0].handle.done).status, 'completed')
  assert.equal(f.purchases.length, 1)
  await assert.rejects(f.service.agentOperations.apply(approved.planId, f.exec), /used/)
  assert.equal(f.purchases.length, 1)
})
