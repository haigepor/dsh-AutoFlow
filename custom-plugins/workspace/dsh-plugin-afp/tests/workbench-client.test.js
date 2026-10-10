import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createAfpClientStore } from '../src/client/afp-client-store.js'

test('metadata reads use browser fetch without accessing undeclared Cordis services', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), operation: JSON.parse(init.body).operation })
    return { ok: true, json: async () => ({ ok: true, value: { username: 'a***e', settings: {} } }) }
  }
  const ctx = new Proxy({}, { get(_target, key) { throw new Error(`undeclared service: ${String(key)}`) } })
  const store = createAfpClientStore(ctx, { baseURI: 'https://profile.test/' })
  try {
    assert.equal(await store.loadAccount(), true)
    assert.deepEqual(calls, [{ url: 'https://profile.test/api/afp/workbench-data', operation: 'account-summary' }])
    assert.equal(store.getSnapshot().account.username, 'a***e')
  } finally { store.dispose(); globalThis.fetch = originalFetch }
})

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness(options = {}) {
  const calls = [], remoteCalls = []
  const pluginManager = {
    invokeAction: async (_name, _action, input) => {
      const args = JSON.parse(input.args ?? '{}')
      const wait = deferred()
      remoteCalls.push({ operation: input.operation, args, wait })
      return wait.promise
    },
    listBundles: async () => ({ ok: true, value: [] }),
    listPlugins: async () => ({ ok: true, value: [] }),
  }
  const fetchImpl = async (url, init) => {
    const { operation, args } = JSON.parse(init.body)
    const wait = deferred()
    calls.push({ url: String(url), init, operation, args, wait })
    return wait.promise
  }
  const store = createAfpClientStore({ remote: { pluginManager } }, { fetchImpl, baseURI: 'https://profile.test/app/', ...options })
  const reply = (index, value) => calls[index].wait.resolve({ ok: true, json: async () => ({ ok: true, value }) })
  const replyRemote = (index, value) => remoteCalls[index].wait.resolve({ ok: true, value: { output: JSON.stringify(value) } })
  return { store, calls, remoteCalls, reply, replyRemote }
}

test('batch archive retains failed selections and closes only the successfully archived open report', async t => {
  const h = harness(); t.after(() => h.store.dispose())
  const rows = [{ id: 'one' }, { id: 'two' }]
  h.store.set({ runId: 'one', selectedRuns: ['one', 'two'], plan: { planId: 'old' }, confirmChecked: true,
    regions: { ...h.store.getSnapshot().regions, runs: { data: { items: rows, offset: 0, total: 2, hasMore: false }, loading: false, error: '' } } })
  const pending = h.store.manageRuns('delete-run', ['one', 'one', 'two'])
  assert.deepEqual(h.remoteCalls[0].args, { runId: 'one' })
  h.replyRemote(0, {})
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.remoteCalls[1].args, { runId: 'two' })
  h.remoteCalls[1].wait.resolve({ ok: false, error: { message: 'still running' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.store.getSnapshot().runId, '')
  assert.deepEqual(h.store.getSnapshot().selectedRuns, ['two'])
  assert.equal(h.store.getSnapshot().plan, null)
  assert.equal(h.store.getSnapshot().confirmChecked, false)
  const page = { items: rows.slice(1), offset: 0, total: 1, hasMore: false }
  h.reply(0, page)
  await new Promise(resolve => setImmediate(resolve))
  h.replyRemote(2, { features: ['read'], reports: [], tasks: [] })
  assert.equal(await pending, false)
  h.reply(1, page)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.store.getSnapshot().runActionResult.outcomes, [{ runId: 'one', ok: true }, { runId: 'two', ok: false }])
  assert.deepEqual(h.remoteCalls.map(row => row.operation), ['delete-run', 'delete-run', 'status'])
  assert.equal(h.store.getSnapshot().busy, false)
})

test('batch pause stops issuing actions after profile reset and ignores the late completion', async t => {
  const h = harness(); t.after(() => h.store.dispose())
  h.store.set({ selectedRuns: ['one', 'two'] })
  const pending = h.store.manageRuns('pause-run', ['one', 'two'])
  h.store.resetData()
  h.replyRemote(0, {})
  assert.equal(await pending, false)
  assert.equal(h.remoteCalls.length, 1)
  assert.equal(h.calls.length, 0)
  assert.equal(h.store.getSnapshot().runActionResult, null)
  assert.deepEqual(h.store.getSnapshot().selectedRuns, [])
  assert.equal(h.store.getSnapshot().busy, false)
})

test('history paging advances and automatic refresh retains every loaded row while manual refresh owns loading', async t => {
  const h = harness(); t.after(() => h.store.dispose())
  const rows = [{ id: 'one' }, { id: 'two' }]
  const initial = h.store.loadHistory('runs')
  h.reply(0, { items: rows, offset: 0, total: 4, hasMore: true }); await initial
  const more = h.store.loadHistory('runs', { more: true })
  assert.equal(h.calls[1].args.offset, 2)
  h.reply(1, { items: [{ id: 'three' }, { id: 'four' }], offset: 2, total: 4, hasMore: false }); await more
  const auto = h.store.loadHistory('runs', { mode: 'auto' })
  assert.equal(h.store.getSnapshot().regions.runs.data.items.length, 4)
  assert.equal(h.store.getSnapshot().regions.runs.loadMode, 'auto')
  h.reply(2, { items: [{ id: 'new' }, ...rows.slice(0, 1)], offset: 0, total: 5, hasMore: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.calls[3].args.offset, 2)
  h.reply(3, { items: [rows[1], { id: 'three' }], offset: 2, total: 5, hasMore: true }); await auto
  assert.deepEqual(h.store.getSnapshot().regions.runs.data.items.map(row => row.id), ['new', 'one', 'two', 'three'])
  const manual = h.store.loadHistory('runs', { mode: 'manual' })
  assert.equal(h.store.getSnapshot().regions.runs.data.items.length, 4)
  assert.equal(h.store.getSnapshot().regions.runs.loadMode, 'manual')
  assert.equal(await h.store.loadHistory('runs', { mode: 'auto' }), false)
  h.calls[4].wait.reject(new Error('offline')); await manual
  assert.equal(h.store.getSnapshot().regions.runs.data.items.length, 4)
})

test('each poll synchronizes loaded report history without clearing it', async t => {
  const h = harness(); t.after(() => h.store.dispose())
  const data = { items: [{ id: 'one' }], offset: 0, total: 1, hasMore: false }
  h.store.set({ regions: { ...h.store.getSnapshot().regions, runs: { data, loading: false, error: '' } } })
  const poll = h.store.reload()
  h.replyRemote(0, { features: ['read'], reports: [], tasks: [] }); await poll
  assert.equal(h.calls[0].operation, 'history-list')
  assert.equal(h.store.getSnapshot().regions.runs.data, data)
  h.reply(0, data)
})

test('status polling refreshes an open report when a resumed run changes and retains its filter', async () => {
  const h = harness(), initial = { runId: 'run-one', status: 'paused', categories: [{ reviewed: 1 }] }
  const updated = { ...initial, status: 'failed', categories: [{ reviewed: 2 }] }
  h.store.set({ status: { features: ['read'] }, runId: initial.runId, reportCategory: 'animals', reportFilter: 'rejected',
    regions: { ...h.store.getSnapshot().regions, run: { data: { run: initial, items: [{ id: 'old' }] }, loading: false, error: '' } } })
  const poll = h.store.reload()
  h.replyRemote(0, { features: ['read'], reports: [{ ...updated, diagnostics: { durationMs: 100 } }] })
  await poll
  assert.equal(h.calls.length, 1)
  assert.deepEqual(h.calls[0].args, { runId: initial.runId, category: 'animals', decision: 'rejected' })
  assert.equal(h.store.getSnapshot().regions.run.loading, true)
  h.reply(0, { run: updated, items: [{ id: 'new' }] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.store.getSnapshot().regions.run.data.run.status, 'failed')
  const same = h.store.reload()
  h.replyRemote(1, { features: ['read'], reports: [{ ...updated, diagnostics: { durationMs: 120 } }] })
  await same
  assert.equal(h.calls.length, 1)
  h.store.dispose()
})

test('diagnostic metadata does not clear an unchanged open report during status polling', async t => {
  const h = harness(), run = { runId: 'run-one', status: 'paused', categories: [{ reviewed: 2, kept: 0 }] }
  t.after(() => h.store.dispose())
  const data = { run, items: [{ id: 'reviewed' }] }
  h.store.set({ status: { features: ['read'] }, runId: run.runId,
    regions: { ...h.store.getSnapshot().regions, run: { data, loading: false, error: '' } } })
  for (const diagnostics of [{ durationMs: 100, errors: [] }, { unavailable: true }]) {
    const poll = h.store.reload()
    h.replyRemote(h.remoteCalls.length - 1, { features: ['read'], reports: [{ ...run, diagnostics }] })
    await poll
    assert.equal(h.calls.length, 0)
    assert.equal(h.store.getSnapshot().regions.run.data, data)
    assert.equal(h.store.getSnapshot().regions.run.loading, false)
  }
})

test('report filters retain the summary and cached pages while stale requests and new runs cannot replace them', async t => {
  const h = harness(), run = { runId: 'run-one', status: 'ready', categories: [{ category: 'food', reviewed: 2, kept: 1 }] }
  t.after(() => h.store.dispose())
  const all = { run, items: [{ id: 'one', category: 'food', keep: true }, { id: 'two', category: 'food', keep: false }], hasMore: false }
  const initial = h.store.openRun(run.runId)
  h.reply(0, all); await initial
  const kept = h.store.openRun(run.runId, { decision: 'kept' })
  assert.equal(h.store.getSnapshot().regions.run.data.run, run)
  assert.deepEqual(h.store.getSnapshot().regions.run.data.items, [all.items[0]])
  assert.equal(h.store.getSnapshot().regions.run.loadMode, 'refresh')
  const back = h.store.openRun(run.runId)
  assert.deepEqual(h.store.getSnapshot().regions.run.data, all)
  h.reply(1, { ...all, items: [all.items[0]] }); await kept
  assert.equal(h.store.getSnapshot().reportFilter, 'all')
  assert.deepEqual(h.store.getSnapshot().regions.run.data, all)
  h.reply(2, all); await back
  const other = h.store.openRun('run-two')
  assert.equal(h.store.getSnapshot().regions.run.data, null)
  h.reply(3, { run: { ...run, runId: 'run-two' }, items: [] }); await other
  const previous = h.store.openRun(run.runId)
  assert.equal(h.store.getSnapshot().regions.run.data, null)
  h.reply(4, all); await previous
})

test('browse download selection keeps the prior destination until the Host adopts a directory', async () => {
  const fixture = harness()
  fixture.store.set({ downloadDirectory: { directoryId: 'prior', label: 'Prior' } })
  const opening = fixture.store.pickDownloadDirectory()
  fixture.replyRemote(0, { browse: true })
  await opening
  assert.equal(fixture.store.getSnapshot().downloadBrowsing, true)
  assert.equal(fixture.remoteCalls[1].operation, 'browse-download-directory')
  fixture.replyRemote(1, { path: '/selected', entries: [], crumbs: [] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fixture.store.getSnapshot().downloadDirectory.directoryId, 'prior')
  const picking = fixture.store.pickDownloadDirectory('/selected')
  assert.deepEqual(fixture.remoteCalls[2].args, { path: '/selected' })
  fixture.replyRemote(2, { directoryId: 'verified', label: 'Selected' })
  assert.equal(await picking, true)
  assert.equal(fixture.store.getSnapshot().downloadDirectory.directoryId, 'verified')
  assert.equal(fixture.store.getSnapshot().downloadBrowsing, false)
  fixture.store.dispose()
})

test('closing download setup discards a late browse listing', async () => {
  const fixture = harness()
  fixture.store.set({ collectionAction: 'download', downloadBrowsing: true })
  const loading = fixture.store.browseDownloadDirectory('/selected')
  fixture.store.set({ collectionAction: null })
  fixture.replyRemote(0, { path: '/selected', entries: [], crumbs: [] })
  assert.equal(await loading, false)
  assert.equal(fixture.store.getSnapshot().downloadDirectoryListing, null)
  assert.equal(fixture.store.getSnapshot().downloadBrowsing, false)
  fixture.store.dispose()
})

test('collection operations discard stale account results without unlocking a newer request', async () => {
  const h = harness(), store = h.store
  store.selectPhoto({ id: 'old-photo' }, 'old-source')
  const old = store.submitCollectionOperation('copy', 'old-target')
  store.resetData()
  store.selectPhoto({ id: 'new-photo' }, 'new-source')
  const current = store.submitCollectionOperation('copy', 'new-target')
  h.replyRemote(0, { completed: 1, items: [{ photoId: 'old-photo', status: 'completed', sourceCollectionIds: ['old-source', 'old-target'] }] })
  assert.equal(await old, false)
  assert.equal(store.getSnapshot().busy, true)
  assert.deepEqual(store.getSnapshot().photoSources, { 'new-photo': ['new-source'] })
  assert.equal(store.getSnapshot().collectionActionResult, null)
  await store.dispose()
  h.replyRemote(1, { completed: 1, items: [{ photoId: 'new-photo', status: 'completed' }] })
  assert.equal(await current, false)
  assert.equal(h.calls.length, 0)
})

test('collection select-all reads every page and cancellation preserves selections from other collections', async () => {
  const h = harness(), store = h.store
  store.set({ status: { features: ['read'] }, collectionId: 'travel' })
  store.selectPhoto({ id: 'shared' }, 'other')
  store.selectPhoto({ id: 'outside' }, 'other')
  const pending = store.toggleCollectionSelection()
  assert.equal(store.getSnapshot().collectionSelecting, true)
  assert.deepEqual(h.calls[0].args, { collectionId: 'travel', offset: 0 })
  h.reply(0, { items: [{ id: 'shared' }, { id: 'new' }], offset: 0, total: 3, hasMore: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.calls[1].args, { collectionId: 'travel', offset: 2 })
  h.reply(1, { items: [{ id: 'last' }], offset: 2, total: 3, hasMore: false })
  assert.equal(await pending, true)
  assert.equal(store.isCollectionFullySelected(), true)
  const snapshot = () => Object.keys(store.getSnapshot().selectedPhotos).sort().map(id => ({ id, sources: store.getSnapshot().photoSources[id] }))
  const expected = JSON.parse(await readFile(new URL('./fixtures/collection-bulk-selection.json', import.meta.url), 'utf8'))
  assert.deepEqual(snapshot(), expected.selected)
  assert.equal(await store.toggleCollectionSelection(), true)
  assert.deepEqual(snapshot(), expected.cleared)
  assert.equal(store.isCollectionFullySelected(), false)
  assert.equal(h.calls.length, 2)
  await store.dispose()
})

test('failed or inconsistent select-all does not leave a partially selected collection', async () => {
  const h = harness()
  h.store.set({ status: { features: ['read'] }, collectionId: 'a' })
  h.store.selectPhoto({ id: 'kept' }, 'other')
  const pending = h.store.toggleCollectionSelection()
  h.reply(0, { items: [{ id: 'first' }], offset: 0, total: 2, hasMore: true })
  await new Promise(resolve => setImmediate(resolve))
  h.calls[1].wait.reject(new Error('remote failure'))
  assert.equal(await pending, false)
  assert.deepEqual(Object.keys(h.store.getSnapshot().selectedPhotos), ['kept'])
  assert.equal(h.store.getSnapshot().collectionSelectionError, 'collection-selection-failed')
  const retry = h.store.toggleCollectionSelection()
  h.reply(2, { items: [], offset: 0, total: 2, hasMore: true })
  assert.equal(await retry, false)
  assert.equal(h.calls.length, 3)
  assert.equal(h.store.getSnapshot().collectionSelecting, false)
  await h.store.dispose()
})

test('navigation, manual selection and account reset cancel bulk reads and ignore late pages', async () => {
  for (const mode of ['navigate', 'manual', 'reset', 'dispose']) {
    const h = harness()
    h.store.set({ status: { features: ['read'] }, collectionId: 'a' })
    const pending = h.store.toggleCollectionSelection()
    let navigation
    if (mode === 'navigate') navigation = h.store.openCollection('b')
    else if (mode === 'manual') h.store.togglePhoto({ id: 'manual' }, 'a')
    else if (mode === 'reset') h.store.resetData()
    else await h.store.dispose()
    assert.equal(h.calls[0].init.signal.aborted, true, mode)
    h.reply(0, { items: [{ id: 'late' }], offset: 0, total: 1, hasMore: false })
    assert.equal(await pending, false, mode)
    assert.equal(h.store.getSnapshot().selectedPhotos.late, undefined, mode)
    if (navigation) { h.reply(1, { items: [], offset: 0, total: 0, hasMore: false }); await navigation }
    await h.store.dispose()
  }
})

test('select-all requires read access and cancelling a pending operation keeps previous selections', async () => {
  const h = harness()
  h.store.set({ collectionId: 'a' })
  assert.equal(await h.store.toggleCollectionSelection(), false)
  assert.equal(h.calls.length, 0)
  h.store.set({ status: { features: ['read'] } })
  h.store.selectPhoto({ id: 'kept' }, 'other')
  const pending = h.store.toggleCollectionSelection()
  assert.equal(await h.store.toggleCollectionSelection(), false)
  assert.equal(h.calls[0].init.signal.aborted, true)
  h.reply(0, { items: [{ id: 'late' }], offset: 0, total: 1, hasMore: false })
  assert.equal(await pending, false)
  assert.deepEqual(Object.keys(h.store.getSnapshot().selectedPhotos), ['kept'])
  await h.store.dispose()
})

test('preview cache follows read access, Host scope, credentials and store disposal', async () => {
  let reads = 0, urls = 0
  const revoked = []
  const h = harness({ previewCacheOptions: { load: async () => { reads++; return new Blob(['image'], { type: 'image/jpeg' }) },
    createObjectURL: () => `blob:${++urls}`, revokeObjectURL: url => revoked.push(url) } })
  const policy = { scope: 'first-host', maxEntries: 3, maxBytes: 100, ttlMs: 10000 }
  const status = async (features, scope = policy.scope) => {
    const pending = h.store.reload()
    h.replyRemote(h.remoteCalls.length - 1, { features, tasks: [], downloads: [], previewCache: { ...policy, scope } })
    await pending
  }
  await assert.rejects(h.store.acquirePreview('one'), /unavailable/)
  await status(['read'])
  const a = await h.store.acquirePreview('one'); a.release()
  const b = await h.store.acquirePreview('one'); b.release(); assert.equal(reads, 1)
  const before = h.store.getSnapshot().previewGeneration
  await status([]); assert.ok(h.store.getSnapshot().previewGeneration > before)
  await assert.rejects(h.store.acquirePreview('one'), /unavailable/)
  await status(['read']); const c = await h.store.acquirePreview('one'); c.release(); assert.equal(reads, 2)
  h.store.selectPhoto({ id: 'old-account' })
  await status(['read'], 'new-host')
  assert.equal(Object.keys(h.store.getSnapshot().selectedPhotos).length, 0)
  h.reply(h.calls.length - 1, { references: { passwordRef: 'AFP_PASSWORD' }, settings: {} })
  await new Promise(resolve => setImmediate(resolve))
  const d = await h.store.acquirePreview('one'); d.release(); assert.equal(reads, 3)
  const changed = h.store.credentialReferenceUpdated('AFP_PASSWORD')
  await assert.rejects(h.store.acquirePreview('one'), /unavailable/)
  h.replyRemote(h.remoteCalls.length - 1, { features: ['read'], tasks: [], previewCache: { ...policy, scope: 'new-host' } })
  h.reply(h.calls.length - 1, { references: { passwordRef: 'AFP_PASSWORD' }, settings: {} })
  await changed
  const visible = await h.store.acquirePreview('one'); assert.equal(reads, 4)
  await h.store.dispose(); assert.ok(revoked.includes(visible.url))
  await assert.rejects(h.store.acquirePreview('one'), { name: 'AbortError' })
  visible.release(); assert.equal(new Set(revoked).size, revoked.length)
})

test('read revocation clears active previews even when an older Host omits the cache policy', async () => {
  const revoked = [], h = harness({ previewCacheOptions: { load: async () => new Blob(['preview']),
    createObjectURL: () => 'blob:legacy', revokeObjectURL: url => revoked.push(url) } })
  const initial = h.store.reload(); h.replyRemote(0, { features: ['read'], tasks: [] }); await initial
  const lease = await h.store.acquirePreview('legacy')
  const changed = h.store.reload(); h.replyRemote(1, { features: [], tasks: [] }); await changed
  assert.deepEqual(revoked, [lease.url])
  lease.release(); await h.store.dispose()
})

test('download cancellation ignores a late failure after profile reset', async () => {
  const { store, remoteCalls } = harness()
  const pending = store.cancelDownload('task')
  assert.equal(store.getSnapshot().downloadCancellingId, 'task')
  store.resetData()
  remoteCalls[0].wait.resolve({ ok: false, error: { message: 'host-only failure' } })
  assert.equal(await pending, false)
  assert.equal(store.getSnapshot().downloadNotice, null)
  assert.equal(store.getSnapshot().downloadCancellingId, '')
  const retry = store.cancelDownload('task-2')
  remoteCalls[1].wait.resolve({ ok: false, error: { message: 'host-only failure' } })
  assert.equal(await retry, false)
  assert.equal(store.getSnapshot().downloadNotice.kind, 'cancelFailed')
  store.dispose()
})

test('persisted download history replaces the temporary accepted batch', async () => {
  const { store, replyRemote } = harness()
  store.set({ downloadResult: { downloadId: 'batch', taskId: 'task', total: 1 } })
  const pending = store.reload()
  replyRemote(0, { features: ['read'], tasks: [], downloads: [{ id: 'batch', status: 'completed' }] })
  await pending
  assert.equal(store.getSnapshot().downloadResult, null)
  store.dispose()
})

test('closing and reopening downloads aborts the old quote and ignores its late result', async () => {
  const { store, calls, reply } = harness()
  store.selectPhoto({ id: 'old' })
  store.set({ collectionAction: 'download' })
  const old = store.loadDownloadOptions({ reset: true })
  store.set({ collectionAction: null })
  store.clearSelection()
  store.selectPhoto({ id: 'new' })
  store.set({ collectionAction: 'download' })
  const current = store.loadDownloadOptions({ reset: true })
  assert.equal(calls[0].init.signal.aborted, true)
  reply(1, { photos: [{ id: 'new', renditions: [{ id: 'new-free', purchaseCost: 0, available: true }] }], creditBalance: 5 })
  assert.equal(await current, true)
  reply(0, { photos: [{ id: 'old', renditions: [] }], creditBalance: 100 })
  assert.equal(await old, false)
  assert.equal(store.getSnapshot().downloadOptions.photos[0].id, 'new')
  store.dispose()
})

test('download quote retry retains the destination and replaces a safe stage-specific failure', async () => {
  const { store, calls, reply } = harness()
  store.selectPhoto({ id: 'photo' })
  store.set({ collectionAction: 'download', downloadDirectory: { directoryId: 'folder', label: 'Pictures' } })
  const failed = store.loadDownloadOptions()
  calls[0].wait.resolve(Response.json({ ok: false, error: { code: 'invalid-request' } }, { status: 400 }))
  assert.equal(await failed, false)
  assert.equal(store.getSnapshot().downloadErrorStage, 'options')
  assert.equal(store.getSnapshot().downloadError, 'invalid-request')
  assert.equal(store.getSnapshot().downloadDirectory.directoryId, 'folder')
  const retry = store.loadDownloadOptions()
  reply(1, { photos: [{ id: 'photo', renditions: [{ id: 'paid', purchaseCost: 3, available: true, width: 3000, height: 2000 },
    { id: 'free', purchaseCost: 0, available: true, width: 300, height: 200 }] }], creditBalance: 10 })
  assert.equal(await retry, true)
  assert.equal(store.getSnapshot().downloadSelected.photo, 'free')
  assert.equal(store.getSnapshot().downloadError, '')
  store.dispose()
})

test('changing the download destination invalidates the reviewed plan', async () => {
  const { store, replyRemote } = harness()
  store.set({ collectionAction: 'download', downloadDirectory: { directoryId: 'old', label: 'Old' },
    downloadPlan: { planId: 'reviewed', confirmation: 'receipt' } })
  const pick = store.pickDownloadDirectory()
  replyRemote(0, { directoryId: 'new', label: 'New' })
  assert.equal(await pick, true)
  assert.equal(store.getSnapshot().downloadDirectory.directoryId, 'new')
  assert.equal(store.getSnapshot().downloadPlan, null)
  store.dispose()
})

test('changed download confirmation refreshes quotes instead of publishing a plan without a receipt', async () => {
  const { store, remoteCalls, replyRemote } = harness()
  store.set({ collectionAction: 'download', downloadOptions: { photos: [], creditBalance: 20 },
    downloadPlan: { planId: 'old', confirmation: 'receipt', totalCost: 3 } })
  const confirm = store.confirmDownload()
  replyRemote(0, { requiresReconfirmation: true, changed: true, creditBalance: 17, totalCost: 4,
    photos: [{ id: 'photo', renditions: [{ id: 'updated', purchaseCost: 4, available: true }] }],
    selected: [{ photoId: 'photo', renditionId: 'updated' }] })
  assert.equal(await confirm, false)
  assert.equal(store.getSnapshot().downloadPlan, null)
  assert.equal(store.getSnapshot().downloadQuoteChanged, true)
  assert.equal(store.getSnapshot().downloadOptions.creditBalance, 17)
  assert.equal(store.getSnapshot().downloadSelected.photo, 'updated')
  assert.equal(await store.confirmDownload(), false)
  assert.equal(remoteCalls.length, 1)
  store.dispose()
})

test('accepted downloads notify outside the closed dialog and keep the dock collapsed', async () => {
  const { store, replyRemote, remoteCalls } = harness()
  store.set({ collectionAction: 'download', downloadDockHidden: true, downloadPlan: { planId: 'plan', confirmation: 'receipt', items: [{ photoId: 'p1' }] } })
  const confirmation = store.confirmDownload()
  replyRemote(0, { queued: true, downloadId: 'batch', taskId: 'task', jobId: 'afp-1' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(store.getSnapshot().collectionAction, null)
  assert.equal(store.getSnapshot().downloadNotice.kind, 'started')
  assert.equal(store.getSnapshot().downloadResult.total, 1)
  assert.equal(store.getSnapshot().downloadDockOpen, false)
  assert.equal(store.getSnapshot().downloadDockHidden, false)
  replyRemote(1, { features: ['read'], tasks: [], downloads: [] })
  assert.equal(await confirmation, true)
  store.set({ downloadDockOpen: true, tab: 'account' })
  assert.equal(store.getSnapshot().downloadDockOpen, true)
  const firstNotice = store.getSnapshot().downloadNotice.id
  store.set({ downloadNotice: { id: 'new-notice', kind: 'started' } })
  store.dismissDownloadNotice(firstNotice)
  assert.equal(store.getSnapshot().downloadNotice.id, 'new-notice')
  store.resetData()
  assert.equal(store.getSnapshot().downloadNotice, null)
  assert.equal(store.getSnapshot().downloadDockOpen, false)
  assert.equal(remoteCalls.filter(call => call.operation === 'download-confirm').length, 1)
  store.dispose()
})

test('late account profile responses cannot replace a newer credential generation', async () => {
  const { store, calls, reply } = harness()
  const old = store.loadProfile()
  store.resetData()
  const current = store.loadProfile()
  reply(1, { login: 'new', credit: 0 })
  assert.equal(await current, true)
  reply(0, { login: 'old', credit: 100 })
  assert.equal(await old, false)
  assert.deepEqual(store.getSnapshot().regions.profile.data, { login: 'new', credit: 0 })
  assert.equal(calls[0].init.signal.aborted, true)
  store.dispose()
})

test('changing collections closes and aborts old detail reads while preserving the selection', async () => {
  const { store, calls, reply } = harness()
  store.selectPhoto({ id: 'selected' })
  const detail = store.openPhoto({ id: 'old-detail' })
  const collection = store.openCollection('new')
  assert.equal(store.getSnapshot().detail, null)
  assert.equal(calls[0].init.signal.aborted, true)
  reply(1, { items: [], offset: 0, hasMore: false, collection: { id: 'new' } })
  await collection
  reply(0, { id: 'old-detail' })
  await detail
  assert.equal(store.getSnapshot().detail, null)
  assert.ok(store.getSnapshot().selectedPhotos.selected)
  store.dispose()
})

test('late photo search results cannot replace a newer query and load-more deduplicates by ID', async () => {
  const { store, calls, reply } = harness()
  store.set({ queryDraft: 'old' })
  const old = store.searchPhotos()
  store.set({ queryDraft: 'new' })
  const current = store.searchPhotos()
  reply(1, { items: [{ id: '2' }], cursor: 'next', hasMore: true })
  await current
  reply(0, { items: [{ id: '1' }], cursor: null, hasMore: false })
  await old
  const more = store.searchPhotos({ more: true })
  assert.equal(calls[2].operation, 'photo-search')
  assert.deepEqual(calls[2].args, { query: 'new', cursor: 'next' })
  reply(2, { items: [{ id: '2' }, { id: '3' }], cursor: null, hasMore: false })
  await more
  assert.deepEqual(store.getSnapshot().regions.search.data.items.map(item => item.id), ['2', '3'])
  store.dispose()
})

test('search pagination is guarded and keeps the submitted language after the selector changes', async () => {
  const { store, calls, reply } = harness()
  store.set({ queryDraft: 'forest', language: 'en' })
  const first = store.searchPhotos()
  reply(0, { items: [{ id: '1' }], cursor: 'c1', hasMore: true })
  await first
  store.set({ language: 'fr' })
  const more = store.searchPhotos({ more: true })
  assert.deepEqual(calls[1].args, { query: 'forest', language: 'en', cursor: 'c1' })
  assert.equal(await store.searchPhotos({ more: true }), false)
  reply(1, { items: [{ id: '2' }], cursor: null, hasMore: false })
  assert.equal(await more, true)
  assert.deepEqual(store.getSnapshot().regions.search.data.items.map(item => item.id), ['1', '2'])
  store.dispose()
})

test('search pagination stops on an empty page, a duplicate-only page or a cursor cycle', async () => {
  for (const mode of ['empty', 'duplicates', 'cycle']) {
    const { store, calls, reply } = harness()
    store.set({ queryDraft: 'nebula' })
    const first = store.searchPhotos()
    reply(0, { items: [{ id: '1' }], cursor: 'c1', hasMore: true }); await first
    const more = store.searchPhotos({ more: true })
    assert.equal(store.getSnapshot().regions.search.loadMode, 'more')
    reply(1, { items: mode === 'empty' ? [] : [{ id: mode === 'duplicates' ? '1' : '2' }], cursor: 'c2', hasMore: true }); await more
    if (mode === 'cycle') {
      const third = store.searchPhotos({ more: true })
      reply(2, { items: [{ id: '3' }], cursor: 'c1', hasMore: true }); await third
    }
    assert.equal(store.getSnapshot().regions.search.data.hasMore, false, mode)
    assert.equal(store.getSnapshot().regions.search.data.cursor, null, mode)
    const count = calls.length
    assert.equal(await store.searchPhotos({ more: true }), false)
    assert.equal(calls.length, count)
    await store.dispose()
  }
})

test('failed search pagination retains photos and retries the same cursor before appending', async () => {
  const { store, calls, reply } = harness()
  store.set({ queryDraft: 'nebula' })
  const first = store.searchPhotos()
  reply(0, { items: [{ id: '1' }], cursor: 'c1', hasMore: true }); await first
  const more = store.searchPhotos({ more: true })
  calls[1].wait.reject(new Error('temporary failure'))
  assert.equal(await more, false)
  assert.equal(store.getSnapshot().regions.search.loadMode, 'more')
  assert.deepEqual(store.getSnapshot().regions.search.data.items.map(row => row.id), ['1'])
  const retry = store.searchPhotos({ more: true })
  assert.equal(calls[2].args.cursor, 'c1')
  reply(2, { items: [{ id: '2' }], cursor: null, hasMore: false }); await retry
  assert.deepEqual(store.getSnapshot().regions.search.data.items.map(row => row.id), ['1', '2'])
  await store.dispose()
})

test('starting a new search cancels pending pagination and forgets prior cursors without clearing selections', async () => {
  const { store, calls, reply } = harness()
  store.selectPhoto({ id: 'selected' }, 'source')
  store.set({ queryDraft: 'nebula' })
  const first = store.searchPhotos()
  reply(0, { items: [{ id: '1' }], cursor: 'c1', hasMore: true }); await first
  const more = store.searchPhotos({ more: true })
  store.set({ queryDraft: 'cat' })
  const fresh = store.searchPhotos()
  assert.equal(calls[1].init.signal.aborted, true)
  reply(2, { items: [{ id: 'new' }], cursor: 'c1', hasMore: true }); await fresh
  reply(1, { items: [{ id: 'late' }], cursor: 'c2', hasMore: true })
  assert.equal(await more, false)
  assert.deepEqual(store.getSnapshot().regions.search.data.items.map(row => row.id), ['new'])
  assert.equal(store.getSnapshot().regions.search.data.hasMore, true)
  assert.equal(store.getSnapshot().regions.search.loadMode, '')
  assert.ok(store.getSnapshot().selectedPhotos.selected)
  await store.dispose()
})

test('collection pagination rejects a repeated offset and retries without losing the first page', async () => {
  const { store, calls, reply } = harness()
  const first = store.openCollection('a')
  reply(0, { items: [{ id: '1' }], offset: 0, total: 3, hasMore: true }); await first
  const second = store.loadMoreCollection()
  reply(1, { items: [{ id: '2' }], offset: 0, total: 3, hasMore: true })
  assert.equal(await second, false)
  assert.deepEqual(store.getSnapshot().regions.collection.data.items.map(row => row.id), ['1'])
  assert.equal(store.getSnapshot().collectionNextOffset, 1)
  const retry = store.loadMoreCollection()
  assert.equal(calls[2].args.offset, 1)
  reply(2, { items: [{ id: '2' }], offset: 1, total: 3, hasMore: true }); await retry
  const empty = store.loadMoreCollection()
  reply(3, { items: [], offset: 2, total: 3, hasMore: true }); await empty
  assert.equal(store.getSnapshot().regions.collection.data.hasMore, false)
  assert.equal(await store.loadMoreCollection(), false)
  await store.dispose()
})

test('collection pagination advances by server offsets across three pages', async () => {
  const { store, calls, reply } = harness()
  const first = store.openCollection('collection-a')
  reply(0, { collection: { id: 'collection-a' }, items: [{ id: '1' }, { id: '2' }], offset: 0, total: 6, hasMore: true })
  await first
  const second = store.loadMoreCollection()
  assert.equal(calls[1].args.offset, 2)
  reply(1, { collection: { id: 'collection-a' }, items: [{ id: '3' }, { id: '4' }], offset: 2, total: 6, hasMore: true })
  await second
  const third = store.loadMoreCollection()
  assert.equal(calls[2].args.offset, 4)
  reply(2, { collection: { id: 'collection-a' }, items: [{ id: '5' }, { id: '6' }], offset: 4, total: 6, hasMore: false })
  await third
  assert.deepEqual(store.getSnapshot().regions.collection.data.items.map(item => item.id), ['1', '2', '3', '4', '5', '6'])
  store.dispose()
})

test('collection switching ignores the late prior response and keeps each region loading independent', async () => {
  const { store, calls, reply } = harness()
  store.set({ collectionId: 'a' })
  const first = store.openCollection('a')
  store.set({ tab: 'tasks' })
  const history = store.loadHistory('runs')
  assert.equal(store.getSnapshot().regions.collection.loading, true)
  assert.equal(store.getSnapshot().regions.runs.loading, true)
  store.set({ collectionId: 'b' })
  const second = store.openCollection('b')
  reply(2, { collection: { id: 'b' }, items: [{ id: 'b1' }], offset: 0, total: 1, hasMore: false })
  await second
  reply(1, { items: [{ id: 'r' }], offset: 0, total: 1, hasMore: false })
  await history
  reply(0, { collection: { id: 'a' }, items: [{ id: 'a1' }], offset: 0, total: 1, hasMore: false })
  await first
  assert.equal(store.getSnapshot().regions.collection.data.collection.id, 'b')
  assert.deepEqual(store.getSnapshot().regions.runs.data.items.map(item => item.id), ['r'])
  store.dispose()
})

test('tab changes preserve selected photos and selection stays local', () => {
  const { store, calls } = harness()
  const photo = { id: 'photo-1', title: 'One' }
  store.selectPhoto(photo)
  store.selectTab('collections')
  assert.equal(store.getSnapshot().tab, 'collections')
  assert.deepEqual(store.getSnapshot().selectedPhotos, { 'photo-1': photo })
  assert.equal(calls.length, 0)
  store.dispose()
})

test('changing run, categories or operation invalidates an existing plan and confirmation check', () => {
  const { store } = harness()
  store.set({ runId: 'run-a', selected: ['food'], operation: 'append', plan: { planId: 'p' }, confirmChecked: true })
  for (const update of [{ runId: 'run-b' }, { selected: ['animals'] }, { operation: 'replace' }]) {
    store.set({ plan: { planId: 'p' }, confirmChecked: true })
    store.set(update)
    assert.equal(store.getSnapshot().plan, null)
    assert.equal(store.getSnapshot().confirmChecked, false)
  }
  store.dispose()
})

test('late plan responses are discarded when their fingerprint changes', async () => {
  const { store, remoteCalls, replyRemote } = harness()
  store.set({ status: { features: ['write'] }, runId: 'run-a', selected: ['food'], operation: 'append' })
  const plan = store.previewPlan()
  store.set({ selected: ['animals'] })
  replyRemote(0, { planId: 'late', expiresAt: Date.now() + 60_000, confirmation: 'secret' })
  await plan
  assert.equal(store.getSnapshot().plan, null)
  assert.equal(remoteCalls[0].args.confirmed, undefined)
  store.dispose()
})

test('plan confirmation requires an active write feature, matching live plan, consent and unexpired receipt', async () => {
  const { store, remoteCalls, replyRemote } = harness()
  const plan = { planId: 'p', confirmation: 'receipt', expiresAt: Date.now() + 60_000 }
  store.set({ status: { features: [] }, plan, planFingerprint: store.planFingerprint(), confirmChecked: true })
  assert.equal(await store.confirmPlan(), false)
  store.set({ status: { features: ['write'] }, confirmChecked: false })
  assert.equal(await store.confirmPlan(), false)
  store.set({ confirmChecked: true, plan: { ...plan, expiresAt: Date.now() - 1 }, planFingerprint: store.planFingerprint() })
  assert.equal(await store.confirmPlan(), false)
  store.set({ plan, planFingerprint: store.planFingerprint() })
  const pending = store.confirmPlan()
  assert.equal(store.getSnapshot().plan, null)
  assert.equal(remoteCalls[0].args.confirmed, true)
  assert.equal(await store.confirmPlan(), false)
  replyRemote(0, { taskId: 'write-task' })
  await new Promise(resolve => setImmediate(resolve))
  replyRemote(1, { features: ['write'], tasks: [] })
  assert.equal(await pending, true)
  store.dispose()
})

test('resetData invalidates outstanding gallery results and clears account-local selection', async () => {
  const { store, calls, reply } = harness()
  store.set({ queryDraft: 'forest' })
  const request = store.searchPhotos()
  store.selectPhoto({ id: 'old-photo' })
  store.resetData()
  reply(0, { items: [{ id: 'stale' }], cursor: null, hasMore: false })
  await request
  assert.deepEqual(store.getSnapshot().selectedPhotos, {})
  assert.equal(store.getSnapshot().regions.search.data, null)
  store.dispose()
})

test('resetData lets a fresh reload win over an older pending profile poll', async () => {
  const { store, remoteCalls, replyRemote } = harness()
  const old = store.reload()
  store.resetData()
  const fresh = store.reload()
  replyRemote(1, { features: ['read'], tasks: [] })
  await fresh
  replyRemote(0, { features: ['write'], tasks: [] })
  await old
  assert.deepEqual(store.getSnapshot().status.features, ['read'])
  store.dispose()
})

test('resetData suppresses errors from a stale plan request', async () => {
  const { store, remoteCalls } = harness()
  store.set({ status: { features: ['write'] }, runId: 'run-a', selected: ['food'] })
  const plan = store.previewPlan()
  store.resetData()
  remoteCalls[0].wait.reject(new Error('stale failure'))
  await plan
  assert.equal(store.getSnapshot().error, '')
  store.dispose()
})

test('dispose suppresses notifications from pending actions', async () => {
  const { store, calls, reply } = harness()
  let notifications = 0
  store.subscribe(() => notifications++)
  const request = store.loadAccount()
  const beforeDispose = notifications
  store.dispose()
  reply(0, { username: 'a***e' })
  await request
  assert.equal(notifications, beforeDispose)
  assert.equal(calls[0].operation, 'account-summary')
})
