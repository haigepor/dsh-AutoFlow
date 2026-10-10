import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AfpService } from '../src/host/afp-service.js'
import { resolveConfig } from '../config-schema.js'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'afp-bindings-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const config = resolveConfig({}), selections = [
    { id: 'food', name: 'AutoFlow_食物', isPrivate: true, docsCount: 0 },
    { id: 'custom', name: 'My food', isPrivate: true, docsCount: 0 },
    { id: 'shared', name: 'Shared food', isPrivate: false },
  ]
  let account = 'first', writes = 0
  const client = { listSelections: async () => selections, getSelection: async () => ({ docs: [] }),
    clearSelectionDocs: async () => { writes++ }, addSelectionDoc: async () => { writes++ } }
  const connection = { open: async () => ({ account, client }), status: async () => ({}) }
  const ctx = { profileContext: { home, dir: join(home, 'profile') }, jobs: {} }
  const service = new AfpService(ctx, config, { connection }); t.after(() => service.dispose())
  await service.enable('read'); await service.enable('write')
  return { service, selections, signal: new AbortController().signal, writes: () => writes, switchAccount: value => { account = value } }
}

test('binding edits persist by account, reject shared/conflicting collections and explicit detachment survives reload', async t => {
  const f = await fixture(t), { service, signal } = f
  await assert.rejects(service.bindCategory({ category: 'food', collectionId: 'shared' }, signal), /shared/)
  await service.bindCategory({ category: 'food', collectionId: 'custom' }, signal)
  assert.equal((await service.workbench.collectionList(signal)).items.find(item => item.id === 'custom').category, 'food')
  assert.equal((await service.collections(signal)).categories.find(item => item.category === 'food').selectionName, 'My food')
  await assert.rejects(service.bindCategory({ category: 'animals', collectionId: 'custom' }, signal), /another category/)
  const plan = await service.pagePlan({ operation: 'clear', categories: ['food'] }, signal)
  assert.equal(plan.categories[0].selectionName, 'My food')
  await service.bindCategory({ category: 'food', collectionId: null }, signal)
  await assert.rejects(service.pageConfirm({ ...plan, confirmed: true }, signal), /refused/)
  await assert.rejects(service.changes.execute(plan.planId, service.pageOwner, signal), /binding.*changed/)
  await assert.rejects(service.pagePlan({ operation: 'clear', categories: ['food'] }, signal), /unbound/)
  const bindings = await service.store.readBindings('first')
  assert.equal(bindings.values.food, null)
  assert.equal((await service.workbench.collectionList(signal)).items.find(item => item.id === 'food').category, null)
  f.switchAccount('second')
  assert.equal((await service.workbench.collectionList(signal)).items.find(item => item.id === 'food').category, 'food')
  assert.equal(f.writes(), 0)
})

test('reports retain their target snapshot and cannot create a write preview against a changed binding', async t => {
  const { service, signal } = await fixture(t)
  const run = await service.store.createRun(['food'], service.config)
  run.account = 'first'; run.status = 'ready'; run.bindings = {}; await service.store.saveRun(run)
  await service.bindCategory({ category: 'food', collectionId: 'custom' }, signal)
  assert.equal((await service.report({ runId: run.id })).categories[0].selectionName, 'AutoFlow_食物')
  await assert.rejects(service.pagePlan({ operation: 'append', categories: ['food'], runId: run.id }, signal), /binding.*changed/)
})

test('a renamed private collection keeps its ID binding while new plans use its current name and old plans refuse drift', async t => {
  const f = await fixture(t), { service, signal } = f
  await service.bindCategory({ category: 'food', collectionId: 'custom' }, signal)
  const oldPlan = await service.pagePlan({ operation: 'clear', categories: ['food'] }, signal)
  f.selections.find(item => item.id === 'custom').name = 'Renamed private collection'
  const plan = await service.pagePlan({ operation: 'clear', categories: ['food'] }, signal)
  assert.equal(plan.categories[0].selectionName, 'Renamed private collection')
  assert.equal((await service.changes.check(plan.planId, service.pageOwner)).planId, plan.planId)
  await assert.rejects(service.changes.execute(oldPlan.planId, service.pageOwner, signal), /collections changed/)
  assert.equal(f.writes(), 0)
  assert.equal((await service.changes.execute(plan.planId, service.pageOwner, signal)).status, 'completed')
  assert.equal(f.writes(), 1)
})
