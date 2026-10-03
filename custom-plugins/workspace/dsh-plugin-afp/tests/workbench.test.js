import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AfpService } from '../src/host/afp-service.js'
import { Store } from '../src/host/afp-state-store.js'
import { resolveConfig } from '../config-schema.js'
import { Connection } from '../src/host/afp-credentials.js'
import { createAfpApiClient } from '../src/vendor/auto-afp-img/afp-api-client.mjs'

const image = {
  id: 'photo-1', guid: 'guid-1', title: 'Sample title', caption: 'Sample caption',
  afpEntityKeyword: [{ keyword: 'sample' }], partner: { gcp: { provider_code: 'AFP' } },
  mockup: [{ href: 'https://private.example/media?token=do-not-project' }],
}

async function fixture(t, overrides = {}) {
  const home = await mkdtemp(join(tmpdir(), 'afp-workbench-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const config = resolveConfig({ pageSize: 2, ...overrides.config })
  const store = new Store(home, join(home, 'profile', 'desktop'), config.maxStateBytes)
  const calls = { search: [], selectionList: 0, selectionDetails: [], hydrate: [], open: [] }
  const selections = [
    { id: 's-food', name: 'AutoFlow_食物', isPrivate: true },
    { id: 's-unknown', name: 'External', isPrivate: true },
    { id: 's-shared', name: 'AutoFlow_风景', isPrivate: false },
  ]
  const selectionDocs = {
    's-food': { docs: [{ id: 'photo-2' }, { uno: 'photo-missing' }, { id: 'photo-1' }] },
    's-unknown': { docs: [] }, 's-shared': { docs: [] },
  }
  const client = {
    async searchPhotos(request) {
      calls.search.push(request)
      return { docs: [image], cursor: 'next-token', hasMore: true }
    },
    async photosByIds(ids) {
      calls.hydrate.push([...ids])
      return ids.filter(id => id !== 'photo-missing').map(id => ({ ...image, id }))
    },
    async listSelections() { calls.selectionList++; return selections },
    async getSelection(id) { calls.selectionDetails.push(id); return selectionDocs[id] },
  }
  const credentialValues = { AFP_USERNAME: 'alice', AFP_ACCESS_TOKEN: 'secret-token' }
  const connection = {
    config,
    credentials: { async resolve(ref) { return credentialValues[ref] ? { value: credentialValues[ref] } : undefined } },
    async configurationInfo() {
      return { credentials: { accessTokenRef: { configured: true }, usernameRef: { configured: true }, passwordRef: { configured: false }, visionKeyRef: { configured: false } },
        token: { configured: true, expiresAt: 1234, verifiedAt: 1000 } }
    },
    async open(signal, write = false, vision = false, preview = false) {
      calls.open.push({ signal, write, vision, preview })
      if (signal?.aborted) throw signal.reason
      return { client, account: 'account', ...(preview ? { previewClient: overrides.previewClient } : {}) }
    },
  }
  const ctx = {
    profileContext: { home, dir: join(home, 'profile', 'desktop') },
    jobs: { start(spec) { const id = `job-${calls.open.length}`; overrides.jobs?.push(spec); return id } },
  }
  const service = new AfpService(ctx, config, { store, connection, ...(overrides.dependencies ?? {}) })
  return { home, config, store, calls, client, connection, service, selections }
}

const page = (service, operation, args = {}, signal = new AbortController().signal) => service.pageAction({ operation, args: JSON.stringify(args) }, signal)

test('private page status supplies cache policy and a Host scope without changing Agent status', async t => {
  const { service, connection } = await fixture(t)
  connection.status = async () => ({ ready: true })
  const agent = await service.status(), first = await page(service, 'status'), second = await page(service, 'status')
  assert.equal(agent.previewCache, undefined)
  assert.match(first.previewCache.scope, /^[0-9a-f-]{36}$/)
  assert.deepEqual(first.previewCache, second.previewCache)
  assert.deepEqual({ ...first.previewCache, scope: '' }, { scope: '', maxEntries: 300, maxBytes: 67108864, ttlMs: 600000 })
  const stop = await service.enable('read')
  const enabled = await page(service, 'status'); assert.notEqual(enabled.previewCache.scope, first.previewCache.scope)
  await stop(); assert.notEqual((await page(service, 'status')).previewCache.scope, enabled.previewCache.scope)
  const next = await fixture(t)
  next.connection.status = async () => ({ ready: true })
  assert.notEqual((await page(next.service, 'status')).previewCache.scope, first.previewCache.scope)
})

test('account summary masks resolved usernames and omits credential values', async t => {
  const { service } = await fixture(t)
  const summary = await page(service, 'account-summary')
  assert.deepEqual(summary, {
    username: 'a***e',
    credentials: { accessTokenRef: { configured: true }, usernameRef: { configured: true }, passwordRef: { configured: false }, visionKeyRef: { configured: false } },
    token: { configured: true, expiresAt: 1234, verifiedAt: 1000 },
    references: { accessTokenRef: 'AFP_ACCESS_TOKEN', usernameRef: 'AFP_USERNAME', passwordRef: 'AFP_PASSWORD', visionKeyRef: 'VISION_API_KEY' },
    visionConfigured: false,
    profile: 'desktop',
    settings: { language: 'en', pageSize: 2, targetPerCategory: 100, threshold: .8 },
  })
  assert.doesNotMatch(JSON.stringify(summary), /alice|secret-token/)
})

test('photo search builds a quoted caption query, forwards language and returns an allowlisted DTO', async t => {
  const { service, calls, config } = await fixture(t)
  await service.enable('read')
  const result = await page(service, 'photo-search', { query: '  bird "nest"  ', cursor: 'opaque', limit: 1, language: 'fr' })
  assert.equal(calls.search[0].variables.input.query, 'caption="bird \\"nest\\""')
  assert.equal(calls.search[0].variables.input.lang, 'fr')
  assert.equal(calls.search[0].variables.input.maxRows, 1)
  assert.equal(calls.search[0].variables.input.cursor, 'opaque')
  assert.deepEqual(result, {
    items: [{ id: 'photo-1', guid: 'guid-1', title: 'Sample title', caption: 'Sample caption', keywords: ['sample'],
      provider: 'AFP', previewPath: 'api/afp/preview?photoId=photo-1' }],
    cursor: 'next-token', hasMore: true,
  })
  assert.equal(JSON.stringify(result).includes('private.example'), false)
  assert.equal(config.pageSize, 2)
})

test('photo search rejects missing read access, extra fields and invalid bounds or language', async t => {
  const { service, calls } = await fixture(t)
  await assert.rejects(page(service, 'photo-search', { query: 'bird' }), /unavailable/)
  await service.enable('read')
  for (const args of [
    {}, { query: ' ' }, { query: 'x'.repeat(2001) }, { query: 'bird', cursor: 'c'.repeat(8193) },
    { query: 'bird', limit: 0 }, { query: 'bird', limit: 3 }, { query: 'bird', language: 'zh' }, { query: 'bird', surprise: true },
  ]) await assert.rejects(page(service, 'photo-search', args))
  assert.equal(calls.search.length, 0)
})

test('photo search stops pagination when upstream returns an empty or repeated cursor', async t => {
  const { service, client } = await fixture(t)
  await service.enable('read')
  client.searchPhotos = async () => ({ docs: [image], hasMore: true, cursor: '' })
  const empty = await page(service, 'photo-search', { query: 'bird' })
  assert.equal(empty.cursor, null)
  assert.equal(empty.hasMore, false)
  client.searchPhotos = async () => ({ docs: [image], hasMore: true, cursor: 'same' })
  const repeated = await page(service, 'photo-search', { query: 'bird', cursor: 'same' })
  assert.equal(repeated.cursor, null)
  assert.equal(repeated.hasMore, false)
  assert.equal(repeated.paginationStopped, true)
})

test('photo search marks an empty result page terminal even when AFP supplies another cursor', async t => {
  const { service, client } = await fixture(t)
  await service.enable('read')
  client.searchPhotos = async () => ({ docs: [], hasMore: true, cursor: 'next' })
  const result = await page(service, 'photo-search', { query: 'nebula', cursor: 'previous' })
  assert.equal(result.hasMore, false)
  assert.equal(result.cursor, null)
})

test('photo details uses batch hydration and returns null when the ID is absent', async t => {
  const { service, calls } = await fixture(t)
  await service.enable('read')
  const result = await page(service, 'photo-details', { photoId: 'photo-1' })
  assert.equal(result.id, 'photo-1')
  assert.equal(result.previewPath, 'api/afp/preview?photoId=photo-1')
  assert.equal(Object.hasOwn(result, 'mockup'), false)
  assert.deepEqual(calls.hydrate, [['photo-1']])
  assert.equal(await page(service, 'photo-details', { photoId: 'photo-missing' }), null)
})

test('photo DTO rejects upstream IDs that cannot safely enter previewPath', async t => {
  const { service, client } = await fixture(t)
  await service.enable('read')
  client.searchPhotos = async () => ({ docs: [{ ...image, id: `unsafe-${'x'.repeat(257)}` }], hasMore: false })
  await assert.rejects(page(service, 'photo-search', { query: 'bird' }), /photo ID/i)
})

test('collection list reads account selections once without detail N+1 and only assigns unique private categories', async t => {
  const { service, calls, client } = await fixture(t)
  await service.enable('read')
  const result = await page(service, 'collection-list')
  assert.deepEqual(result.items, [
    { id: 's-food', name: 'AutoFlow_食物', isPrivate: true, readOnly: false, count: null, category: 'food' },
    { id: 's-unknown', name: 'External', isPrivate: true, readOnly: false, count: null, category: null },
    { id: 's-shared', name: 'AutoFlow_风景', isPrivate: false, readOnly: true, count: null, category: null },
  ])
  assert.equal(calls.selectionList, 1)
  assert.deepEqual(calls.selectionDetails, [])
})

test('collection items authorize listed IDs, page remote docs, preserve order and include missing metadata placeholders', async t => {
  const { service, calls, client } = await fixture(t)
  await service.enable('read')
  const result = await page(service, 'collection-items', { collectionId: 's-food', offset: 0, limit: 2 })
  assert.equal(result.total, 3)
  assert.equal(result.hasMore, true)
  assert.deepEqual(result.items.map(item => item.id), ['photo-2', 'photo-missing'])
  assert.equal(result.items[1].title, 'photo-missing')
  assert.equal(result.collection.category, 'food')
  assert.deepEqual(calls.hydrate[0], ['photo-2', 'photo-missing'])
  await assert.rejects(page(service, 'collection-items', { collectionId: 'arbitrary-selection-id' }), /collection/i)
  assert.deepEqual(calls.selectionDetails, ['s-food'])
  const hydrated = calls.hydrate.length
  client.getSelection = async () => ({ docs: [] })
  const empty = await page(service, 'collection-items', { collectionId: 's-food' })
  const pastEnd = await page(service, 'collection-items', { collectionId: 's-food', offset: 10 })
  assert.deepEqual(empty.items, [])
  assert.deepEqual(pastEnd.items, [])
  assert.equal(calls.hydrate.length, hydrated)
})

test('collection browsing excludes explicit non-photos, uses counts and tolerates unrelated malformed metadata', async t => {
  const { service, client, selections } = await fixture(t)
  await service.enable('read')
  selections[0].docsCount = 4
  client.getSelection = async () => ({ docs: [{ id: 'photo-1', docClass: 'picture' }, { id: 'article', docClass: 'text' },
    { id: 'video', docClass: 'video' }, { id: 'legacy-photo' }] })
  client.photosByIds = async () => [null, { surprise: true }, image]
  const result = await page(service, 'collection-items', { collectionId: 's-food' })
  assert.equal(result.total, 2)
  assert.equal(result.collection.count, 4)
  assert.deepEqual(result.items.map(item => item.id), ['photo-1', 'legacy-photo'])
  assert.equal(result.items[1].title, 'legacy-photo')
})

test('moving selected photos verifies the target membership before unlinking each source', async t => {
  const { service, client, selections } = await fixture(t)
  await service.enable('write')
  selections.push({ id: 's-target', name: 'Target', isPrivate: true })
  const members = new Map([['s-food', new Set(['photo-1'])], ['s-target', new Set()]])
  const order = []
  client.getSelection = async id => { order.push(`read:${id}`); return { docs: [...members.get(id)].map(photoId => ({ id: photoId })) } }
  client.addSelectionDoc = async (id, doc) => { order.push(`add:${id}`); members.get(id).add(doc.id) }
  client.deleteSelectionDocs = async (id, ids) => { order.push(`remove:${id}`); for (const photoId of ids) members.get(id).delete(photoId) }
  const result = await page(service, 'collection-operation', { action: 'move', photoIds: ['photo-1'],
    photoSources: { 'photo-1': ['s-food'] }, targetCollectionId: 's-target' })
  assert.equal(result.completed, 1)
  assert.equal(result.pending, 0)
  assert.equal(members.get('s-target').has('photo-1'), true)
  assert.equal(members.get('s-food').has('photo-1'), false)
  assert.ok(order.indexOf('add:s-target') < order.indexOf('remove:s-food'))
  assert.deepEqual(result.items[0].sourceCollectionIds, ['s-target'])
})

test('copy reports additions and existing photos without requiring source reads', async t => {
  const { service, client, calls } = await fixture(t)
  await service.enable('write')
  const members = new Set(['photo-1']), added = []
  client.getSelection = async id => { calls.selectionDetails.push(id); assert.equal(id, 's-unknown'); return { docs: [...members].map(id => ({ id })) } }
  client.addSelectionDoc = async (_target, doc) => { added.push(doc.id); members.add(doc.id) }
  const result = await page(service, 'collection-operation', { action: 'copy', photoIds: ['photo-1', 'photo-2'],
    photoSources: { 'photo-1': ['s-shared'], 'photo-2': ['removed-source'] }, targetCollectionId: 's-unknown' })
  assert.deepEqual(added, ['photo-2'])
  assert.deepEqual(result.items.map(row => row.membershipChange), ['already-present', 'added'])
  assert.deepEqual(result.items[1].sourceCollectionIds, ['removed-source', 's-unknown'])
  assert.equal(result.completed, 2)
  assert.equal(calls.selectionDetails.every(id => id === 's-unknown'), true)
})

test('copy blocks readonly and oversized targets and never retries uncertain additions', async t => {
  const { service, client } = await fixture(t)
  await service.enable('write')
  const members = new Set(), writes = []
  client.getSelection = async () => ({ docs: [...members].map(id => ({ id })) })
  client.addSelectionDoc = async (_target, doc) => { writes.push(doc.id); if (doc.id === 'photo-2') throw new Error('uncertain response'); members.add(doc.id) }
  const args = { action: 'copy', photoIds: ['photo-1', 'photo-2'], photoSources: {}, targetCollectionId: 's-unknown' }
  await assert.rejects(page(service, 'collection-operation', { ...args, targetCollectionId: 's-shared' }), /private|read-only/i)
  await assert.rejects(page(service, 'collection-operation', { ...args, photoIds: Array.from({ length: 121 }, (_, index) => `id-${index}`) }), /Invalid AFP collection operation/)
  assert.deepEqual(writes, [])
  const result = await page(service, 'collection-operation', args)
  assert.equal(result.completed, 1)
  assert.equal(result.pending, 1)
  assert.deepEqual(writes, ['photo-1', 'photo-2'])
  assert.equal(result.items[1].status, 'pending')
})

test('a partial move keeps completed photos and marks uncertain relationship writes pending', async t => {
  const { service, client, selections } = await fixture(t)
  await service.enable('write')
  selections.push({ id: 's-target', name: 'Target', isPrivate: true })
  const members = new Map([['s-food', new Set(['photo-1', 'photo-2'])], ['s-target', new Set()]])
  client.photosByIds = async () => [image, { ...image, id: 'photo-2' }]
  client.getSelection = async id => ({ docs: [...members.get(id)].map(photoId => ({ id: photoId })) })
  client.addSelectionDoc = async (id, doc) => {
    if (doc.id === 'photo-2') throw new Error('simulated ambiguous AFP response')
    members.get(id).add(doc.id)
  }
  client.deleteSelectionDocs = async (id, ids) => { for (const photoId of ids) members.get(id).delete(photoId) }
  const result = await page(service, 'collection-operation', { action: 'move', photoIds: ['photo-1', 'photo-2'],
    photoSources: { 'photo-1': ['s-food'], 'photo-2': ['s-food'] }, targetCollectionId: 's-target' })
  assert.equal(result.completed, 1)
  assert.equal(result.pending, 1)
  assert.equal(members.get('s-target').has('photo-1'), true)
  assert.equal(members.get('s-food').has('photo-1'), false)
  assert.equal(members.get('s-target').has('photo-2'), false)
  assert.equal(members.get('s-food').has('photo-2'), true)
})

test('collection removal refuses shared sources before any relationship changes', async t => {
  const { service, client } = await fixture(t)
  await service.enable('write')
  let removed = false
  client.deleteSelectionDocs = async () => { removed = true }
  await assert.rejects(page(service, 'collection-operation', { action: 'remove', photoIds: ['photo-1'],
    photoSources: { 'photo-1': ['s-shared'] } }), /shared or read-only/i)
  assert.equal(removed, false)
})

test('account profile requires read access and does not accept arbitrary query arguments', async t => {
  const { service, connection } = await fixture(t)
  connection.open = async () => ({ readAccountProfile: async () => ({ login: 'alice', credit: 0 }) })
  await assert.rejects(page(service, 'account-profile'), /unavailable/)
  await service.enable('read')
  assert.deepEqual(await page(service, 'account-profile'), { login: 'alice', credit: 0 })
  await assert.rejects(page(service, 'account-profile', { query: 'mutation' }), /argument/)
})

test('preview proxy recognizes raster octet streams and emits only a safe blocked hostname', async t => {
  const previewClient = { async getPreviewBytes() { return { bytes: new Uint8Array([255, 216, 255]), contentType: 'application/octet-stream' } } }
  const { service } = await fixture(t, { previewClient })
  await service.enable('read')
  const request = () => new Request('https://local/api/afp/preview?photoId=photo-1')
  const image = await service.previewResponse(request())
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('content-type'), 'image/jpeg')
  previewClient.getPreviewBytes = async () => { throw Object.assign(new Error('URL with secret'), { code: 'preview-host-blocked', hostname: 'cdn.example.test' }) }
  const denied = await service.previewResponse(request())
  assert.equal(denied.status, 502)
  assert.deepEqual(await denied.json(), { code: 'preview-host-blocked', host: 'cdn.example.test' })
})

test('run item report distinguishes rejected, request-failed and pending candidates', async t => {
  const { service, store } = await fixture(t, { config: { pageSize: 10 } })
  const run = {
    schema: 1, id: '4a8b7032-fc24-4a8c-85fb-6c3a3c108b8f', categories: ['food'], settings: resolveConfig({}),
    status: 'paused', createdAt: 100, pending: { category: 'food', candidates: [{ ...image, id: 'pending' }] },
    groups: { food: { batches: 1, candidates: [{ ...image, id: 'kept', entityKeywords: ['normalized keyword'] }, { ...image, id: 'rejected' }, { ...image, id: 'failed' }] } },
    decisions: [
      { id: 'kept', category: 'food', keep: true, confidence: .93, reason: 'accepted' },
      { id: 'rejected', category: 'food', keep: false, confidence: .31, reason: 'not relevant' },
      { id: 'failed', category: 'food', keep: false, confidence: null, reason: 'preview or vision request failed' },
    ],
  }
  await store.saveRun(run)
  const all = await page(service, 'run-items', { runId: run.id, decision: 'all', limit: 10 })
  assert.deepEqual(all.items.map(item => item.id), ['kept', 'rejected', 'failed', 'pending'])
  assert.deepEqual(all.items[0].keywords, ['normalized keyword'])
  assert.equal(all.items[2].requestFailed, true)
  assert.equal(all.items[2].keep, false)
  assert.equal(all.items[3].keep, null)
  assert.equal(all.items[3].confidence, null)
  assert.equal(all.items[3].reason, '')
  assert.equal(all.total, 4)
  const rejected = await page(service, 'run-items', { runId: run.id, decision: 'rejected' })
  assert.deepEqual(rejected.items.map(item => item.id), ['rejected'])
  const failed = await page(service, 'run-items', { runId: run.id, decision: 'failed' })
  assert.deepEqual(failed.items.map(item => item.id), ['failed'])
  await assert.rejects(page(service, 'run-items', { runId: run.id, category: 'animals' }), /category/i)
})

test('history projects safe run and plan records, orders real dates before legacy null dates', async t => {
  const { service, store } = await fixture(t, { config: { pageSize: 10 } })
  const run = {
    schema: 1, id: '4a8b7032-fc24-4a8c-85fb-6c3a3c108b8f', categories: ['food'], settings: resolveConfig({}),
    status: 'ready', createdAt: 200, pending: null, groups: { food: { batches: 1, candidates: [] } }, decisions: [],
  }
  await store.saveRun(run)
  const plan = { schema: 1, id: '4a8b7032-fc24-4a8c-85fb-6c3a3c108b90', owner: 'private-owner', account: 'private-account',
    operation: 'append', remoteHash: 'private-hash', expiresAt: 300, state: 'completed', createdAt: 100,
    targets: [{ category: 'food', name: 'AutoFlow_食物', id: 's-food', existing: 2, docs: [{ id: 'photo-1' }] }],
    result: { status: 'completed', error: 'internal detail', categories: [{ category: 'food', status: 'completed', removed: 0, added: 1 }] } }
  const oldPlan = { ...plan, id: '4a8b7032-fc24-4a8c-85fb-6c3a3c108b91', state: 'planned', expiresAt: 400, createdAt: undefined, result: undefined }
  const storedRun = { schema: 1, id: '4a8b7032-fc24-4a8c-85fb-6c3a3c108b8f', categories: ['food'], settings: resolveConfig({}),
    status: 'ready', createdAt: 200, pending: null, groups: { food: { batches: 1, candidates: [] } }, decisions: [] }
  await store.saveRun(storedRun)
  await store.savePlan(plan)
  await store.savePlan(oldPlan)
  const mixed = await page(service, 'history-list', {}, new AbortController().signal)
  assert.deepEqual(mixed.items.map(item => item.kind), ['run', 'plan', 'plan'])
  const result = await page(service, 'history-list', { kind: 'plans', limit: 10 })
  assert.deepEqual(result.items.map(item => item.id), [plan.id, oldPlan.id])
  assert.equal(result.items[0].createdAt, 100)
  assert.equal(result.items[1].createdAt, null)
  assert.equal(result.items[0].plan.targets[0].add, 1)
  assert.deepEqual(result.items[0].plan.result.categories, [{ category: 'food', status: 'completed', removed: 0, added: 1 }])
  assert.doesNotMatch(JSON.stringify(result), /private-owner|private-account|private-hash|internal detail/)
})

test('preview route returns guarded image bytes, rejects invalid IDs and requests preview without vision config', async t => {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
  const { service, calls } = await fixture(t, { previewClient: { async getPreviewBytes(id) { assert.equal(id, 'photo-1'); return { bytes: png, contentType: 'image/png' } } } })
  const denied = await service.previewResponse(new Request('https://local/api/afp/preview?photoId=photo-1'))
  assert.equal(denied.status, 403)
  assert.equal(denied.headers.get('cache-control'), 'no-store')
  assert.equal(denied.headers.get('x-content-type-options'), 'nosniff')
  await service.enable('read')
  const response = await service.previewResponse(new Request('https://local/api/afp/preview?photoId=photo-1'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png)
  assert.equal(calls.open.at(-1).preview, true)
  assert.equal(calls.open.at(-1).vision, false)
  const invalid = await service.previewResponse(new Request('https://local/api/afp/preview?photoId=bad%0A'))
  assert.equal(invalid.status, 400)
  const extra = await service.previewResponse(new Request('https://local/api/afp/preview?photoId=photo-1&debug=1'))
  assert.equal(extra.status, 400)
  const mismatch = await fixture(t, { previewClient: { async getPreviewBytes() { return { bytes: png, contentType: 'image/jpeg' } } } })
  await mismatch.service.enable('read')
  const rejected = await mismatch.service.previewResponse(new Request('https://local/api/afp/preview?photoId=photo-1'))
  assert.equal(rejected.status, 502)
})

test('Connection builds the preview client without requiring vision settings or a vision key', async () => {
  const config = resolveConfig({})
  const credentials = {
    async resolve(ref) { return ref === config.accessTokenRef ? { value: 'non-jwt-token' } : undefined },
    async describe(ref) { return { configured: ref === config.accessTokenRef } },
    async modifyRecord(_key, update) { await update(undefined) },
    async readRecord() { return undefined },
  }
  const connection = new Connection(credentials, config, async () => new Response('[]', { status: 200 }))
  const result = await connection.open(new AbortController().signal, false, false, true)
  assert.equal(typeof result.client.photosByIds, 'function')
  assert.equal(typeof result.previewClient.getPreviewBytes, 'function')
  assert.equal(Object.hasOwn(result, 'visionClient'), false)
})

test('preview read cancellation and service disposal drain active reads', async t => {
  let entered
  let started = new Promise(resolve => { entered = resolve })
  const { service } = await fixture(t, { dependencies: { connection: null } })
  assert.ok(service.workbench, 'service owns the workbench read lifecycle')
  let active = true
  service.connection.open = async signal => ({ client: { async listSelections() {
    entered()
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    active = false
    signal.throwIfAborted()
  } } })
  const disable = await service.enable('read')
  const pending = page(service, 'collection-list').catch(error => error)
  await started
  await disable()
  assert.equal(active, false)
  assert.match(String((await pending).message), /read capability disabled/i)
  await service.enable('read')
  active = true
  started = new Promise(resolve => { entered = resolve })
  const disposalRead = page(service, 'collection-list').catch(error => error)
  await started
  await service.dispose()
  assert.equal(active, false)
  assert.match(String((await disposalRead).message), /disposed/i)
})

test('FAR photosByIds query returns metadata without requesting preview or download fields', async () => {
  let request
  const client = createAfpApiClient({ accessToken: 'test', fetchImpl: async (_url, options) => {
    request = JSON.parse(options.body)
    return new Response(JSON.stringify({ data: { docs: [image] } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }, sleep: async () => {} })
  const result = await client.photosByIds(['photo-1'])
  assert.equal(request.operationName, 'getPhotosByIds')
  assert.deepEqual(request.variables, { ids: ['photo-1'], input: { isUno: true } })
  assert.match(request.query, /partner\s*\{\s*gcp\s*\{\s*provider_code/)
  assert.doesNotMatch(request.query, /mockup|HighRes|MidRes|href/)
  assert.deepEqual(result, [image])
})

test('confirmed AFP purchases use one network attempt and ambiguous responses are not retried', async () => {
  let calls = 0, sleeps = 0
  const client = createAfpApiClient({ accessToken: 'host-secret', retries: 4, sleep: async () => { sleeps++ }, fetchImpl: async (_url, options) => {
    calls++
    const request = JSON.parse(options.body)
    assert.equal(request.operationName, 'buyPhoto')
    assert.deepEqual(request.variables, { id: 'photo-1', cost: 3, mediaKeys: ['high'] })
    return Response.json({ data: { buyPhoto: { requestId: 'private-order', status: 'accepted' } } }, { status: 503 })
  } })
  await assert.rejects(client.buyPhoto({ id: 'photo-1', cost: 3, mediaKeys: ['high'] }), /202 accepted/)
  assert.equal(calls, 1)
  assert.equal(sleeps, 0)
})

test('AFP image delivery follows HTTPS redirects without forwarding credentials', async () => {
  const requests = []
  const client = createAfpApiClient({ accessToken: 'host-secret', fetchImpl: async (url, options) => {
    requests.push({ url: String(url), options })
    if (requests.length === 1) return new Response(null, { status: 302, headers: { location: 'https://delivery.afp-cdn.example/photo.jpg' } })
    return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200 })
  } })
  const response = await client.downloadMedia('https://hub.afp-cdn.example/short-lived', 2, 5000)
  assert.equal(response.status, 200)
  assert.deepEqual(requests.map(item => item.url), ['https://hub.afp-cdn.example/short-lived', 'https://delivery.afp-cdn.example/photo.jpg'])
  for (const { options } of requests) {
    assert.equal(options.redirect, 'manual')
    assert.equal(Object.keys(options.headers).some(name => name.toLowerCase() === 'authorization'), false)
  }
  await assert.rejects(client.downloadMedia('https://127.0.0.1/private'), /disallowed/)
})

test('AFP image delivery forwards task cancellation through its timeout signal', async () => {
  let requestSignal
  const client = createAfpApiClient({ accessToken: 'host-secret', fetchImpl: async (_url, options) => {
    requestSignal = options.signal
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
  } })
  const controller = new AbortController()
  const pending = client.downloadMedia('https://delivery.afp-cdn.example/photo.jpg', 2, 5000, controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending, error => error.name === 'AbortError')
  assert.equal(requestSignal.aborted, true)
})

test('single-photo favorite removal uses the relationship endpoint and never deletes a collection', async () => {
  let request
  const client = createAfpApiClient({ accessToken: 'host-secret', fetchImpl: async (url, options) => {
    request = { url: String(url), options, body: JSON.parse(options.body) }
    return Response.json({ ok: true }, { status: 200 })
  } })
  await client.deleteSelectionDocs('selection-1', ['photo-1', 'photo-1'])
  assert.equal(request.url, 'https://slt-api-news.app.afp.com/delete-selection-docs/selection-1')
  assert.equal(request.options.method, 'PUT')
  assert.deepEqual(request.body, { docIds: ['photo-1'], deleteAll: false })
  assert.doesNotMatch(request.url, /delete-selection\//)
})

test('page refresh overrides apply only to new reports and enforce config bounds', async t => {
  const jobs = []
  const { service, config, store } = await fixture(t, { jobs })
  await service.enable('refresh')
  const scheduled = await page(service, 'refresh', { categories: ['food'], targetPerCategory: 12, threshold: .91 })
  const saved = await store.readRun(scheduled.runId)
  assert.equal(saved.settings.targetPerCategory, 12)
  assert.equal(saved.settings.threshold, .91)
  assert.equal(config.targetPerCategory, 100)
  assert.equal(config.threshold, .8)
  assert.equal(jobs.length, 1)
  await assert.rejects(page(service, 'refresh', { runId: scheduled.runId, targetPerCategory: 12 }), /resume|override/i)
  await assert.rejects(service.startRefresh({ categories: ['food'], targetPerCategory: 12 }, 'session', new AbortController().signal), /agent|override|page/i)
  for (const args of [{ targetPerCategory: 0 }, { targetPerCategory: 1001 }, { threshold: .79 }, { threshold: 1.01 }]) {
    await assert.rejects(page(service, 'refresh', { categories: ['food'], ...args }))
  }
  assert.equal(config.pageSize, 2)
})

function dataRequest(operation, args = {}, options = {}) {
  return new Request('https://local/api/afp/workbench-data', {
    method: options.method ?? 'POST',
    headers: options.headers ?? { 'content-type': 'application/json; charset=utf-8' },
    body: options.body ?? JSON.stringify({ operation, args }),
    signal: options.signal,
  })
}

test('metadata route returns large allowlisted DTOs outside plugin-manager output limits', async t => {
  const longImage = { ...image, caption: 'a'.repeat(20_000) }
  const { service, client } = await fixture(t)
  client.searchPhotos = async () => ({ docs: [longImage], cursor: null, hasMore: false })
  await service.enable('read')
  const response = await service.workbenchDataResponse(dataRequest('photo-search', { query: 'caption' }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  const result = await response.json()
  assert.equal(result.ok, true)
  assert.equal(result.value.items[0].caption.length, 20_000)
})

test('metadata route rejects write operations, extra fields, query strings and malformed request bodies', async t => {
  const { service, calls } = await fixture(t)
  await service.enable('read')
  for (const operation of ['status', 'refresh', 'plan', 'confirm', 'cancel', 'write']) {
    const response = await service.workbenchDataResponse(dataRequest(operation))
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { ok: false, error: { code: 'invalid-request' } })
  }
  for (const request of [
    dataRequest('photo-search', {}, { body: JSON.stringify({ operation: 'photo-search', args: {}, extra: true }) }),
    dataRequest('photo-search', {}, { body: JSON.stringify({ operation: 'photo-search', args: [] }) }),
    dataRequest('photo-search', {}, { body: '{' }),
    dataRequest('photo-search', {}, { headers: { 'content-type': 'text/plain' } }),
    new Request('https://local/api/afp/workbench-data?debug=1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'collection-list' }) }),
  ]) {
    const response = await service.workbenchDataResponse(request)
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { ok: false, error: { code: 'invalid-request' } })
  }
  assert.equal(calls.search.length, 0)
  assert.equal(calls.selectionList, 0)
})

test('metadata route bounds request and response bytes and returns a fixed unavailable code for read denial', async t => {
  const oversized = await fixture(t, { config: { maxResponseBytes: 1024 } })
  const largeBody = new Request('https://local/api/afp/workbench-data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'photo-search', args: { query: 'x'.repeat(1100) } }) })
  const bodyResult = await oversized.service.workbenchDataResponse(largeBody)
  assert.equal(bodyResult.status, 413)
  assert.deepEqual(await bodyResult.json(), { ok: false, error: { code: 'response-too-large' } })
  const denied = await oversized.service.workbenchDataResponse(dataRequest('photo-search', { query: 'private token value' }))
  assert.equal(denied.status, 503)
  assert.deepEqual(await denied.json(), { ok: false, error: { code: 'unavailable' } })

  const responseBounded = await fixture(t, { config: { maxResponseBytes: 1024 } })
  responseBounded.client.searchPhotos = async () => ({ docs: [{ ...image, caption: 'x'.repeat(1800) }], hasMore: false })
  await responseBounded.service.enable('read')
  const responseResult = await responseBounded.service.workbenchDataResponse(dataRequest('photo-search', { query: 'caption' }))
  assert.equal(responseResult.status, 413)
  assert.deepEqual(await responseResult.json(), { ok: false, error: { code: 'response-too-large' } })
})

test('metadata route propagates request cancellation into the workbench read lifecycle', async t => {
  const { service, connection } = await fixture(t)
  await service.enable('read')
  let entered
  const started = new Promise(resolve => { entered = resolve })
  let released = false
  connection.open = async signal => ({ client: { async searchPhotos() {
    entered()
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    released = true
    signal.throwIfAborted()
  } } })
  const controller = new AbortController()
  const pending = service.workbenchDataResponse(dataRequest('photo-search', { query: 'caption' }, { signal: controller.signal }))
  await started
  controller.abort()
  await assert.rejects(pending)
  assert.equal(released, true)
})
