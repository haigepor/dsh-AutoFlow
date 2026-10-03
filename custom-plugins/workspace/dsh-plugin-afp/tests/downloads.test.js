import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../config-schema.js'
import { AfpDownloads } from '../src/host/afp-downloads.js'
import { Store } from '../src/host/afp-state-store.js'

const signal = () => new AbortController().signal
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0x00])

async function harness(t, { credit = 20, cost = 4, deliverAfterPurchase = true,
  maxDownloadBytes = 128 * 1024 * 1024 } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'afp-downloads-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const directory = join(home, 'chosen output')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(directory)
  const config = resolveConfig({ downloadConcurrency: 2, maxDownloadBytes })
  const store = new Store(home, join(home, 'profile', 'desktop'), config.maxStateBytes)
  const purchased = new Set(), purchases = [], delivered = [], opens = [], scheduled = [], featureChecks = []
  const client = {
    async downloadPhotoDetails(photoId) {
      return { id: photoId, guid: `guid-${photoId}`, title: `Title ${photoId}`, downloadableMedias: [
        { name: 'Mockup', mediaKey: `free-${photoId}`, cost: 0, width: 300, height: 200, sizeInBytes: 1234,
          payable: true, href: `https://cdn.afp.example/free/${photoId}` },
        { name: 'HighRes', role: 'HighDef', mediaKey: `paid-${photoId}`, cost, width: 3000, height: 2000, sizeInBytes: 2000000,
          payable: true, validateOrderId: `validation-${photoId}`,
          ...(purchased.has(photoId) && deliverAfterPurchase ? { href: `https://delivery.afp.example/${photoId}?signature=host-only-secret` } : {}) },
      ] }
    },
    async buyPhoto(input) { purchases.push(input); purchased.add(input.id); return { accepted: true, status: 202 } },
    async downloadMedia(href) {
      delivered.push(href)
      return new Response(jpeg, { status: 200, headers: { 'content-length': String(jpeg.byteLength),
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent('AFP original.jpg')}` } })
    },
  }
  const connection = { async open(_abortSignal, write = false) {
    opens.push(write)
    return { client, account: 'account-a', readAccountProfile: async () => ({ credit }) }
  } }
  const ctx = { directoryPicker: { capability: () => ({ kind: 'native', pick: async () => directory }) } }
  const manager = new AfpDownloads({ ctx, config, connection, store,
    schedule(feature, label, operation) { scheduled.push({ feature, label, operation }); return { jobId: 'afp-1', taskId: 'task-1' } },
    requireFeature(feature) { featureChecks.push(feature) },
  })
  t.after(() => manager.dispose())
  return { home, directory, client, connection, manager, store, purchases, delivered, opens, scheduled, featureChecks }
}

test('one unavailable photo keeps the other quotes and missing balance allows only free downloads', async t => {
  const fixture = await harness(t)
  const details = fixture.client.downloadPhotoDetails
  fixture.client.downloadPhotoDetails = async id => { if (id === 'missing') throw new Error('signed-url-secret'); return details(id) }
  const openConnection = fixture.connection.open
  fixture.connection.open = async (...args) => ({ ...await openConnection(...args), readAccountProfile: async () => { throw new Error('private-account-error') } })
  const options = await fixture.manager.options({ photoIds: ['missing', 'free'] }, signal())
  assert.equal(options.creditBalance, null)
  assert.equal(options.creditError, 'download-balance-unavailable')
  assert.equal(options.photos[0].errorCode, 'download-photo-unavailable')
  assert.equal(options.photos[1].renditions.length, 2)
  assert.doesNotMatch(JSON.stringify(options), /signed-url-secret|private-account-error/)
  const directory = await fixture.manager.pickDirectory(signal())
  const photo = options.photos[1]
  const free = photo.renditions.find(row => row.purchaseCost === 0)
  const plan = await fixture.manager.prepare({ directoryId: directory.directoryId, items: [{ photoId: photo.id, renditionId: free.id }] }, signal())
  assert.equal(plan.totalCost, 0)
  const paid = photo.renditions.find(row => row.purchaseCost > 0)
  await assert.rejects(fixture.manager.prepare({ directoryId: directory.directoryId, items: [{ photoId: photo.id, renditionId: paid.id }] }, signal()),
    error => error.code === 'download-balance-unavailable')
  assert.equal(fixture.purchases.length, 0)
})

test('fallback names preserve dotted GUIDs and filename suffixes without a delivered filename', async t => {
  const fixture = await harness(t)
  const details = fixture.client.downloadPhotoDetails
  fixture.client.downloadPhotoDetails = async id => ({ ...await details(id), guid: 'afp.com.20261002-photo-unique' })
  fixture.client.downloadMedia = async () => new Response(jpeg)
  const options = await fixture.manager.options({ photoIds: ['photo'] }, signal())
  const directory = await fixture.manager.pickDirectory(signal())
  const plan = await fixture.manager.prepare({ directoryId: directory.directoryId, prefix: 'batch_', suffix: '_final',
    items: [{ photoId: 'photo', renditionId: options.photos[0].renditions[0].id }] }, signal())
  await fixture.manager.confirm({ planId: plan.planId, confirmation: plan.confirmation, confirmed: true }, signal())
  await fixture.scheduled[0].operation(signal(), { updateProgress() {} })
  assert.deepEqual(await readdir(fixture.directory), ['batch_afp.com.20261002-photo-unique_final.jpg'])
})

test('download preview exposes safe quality metadata and confirms cost before scheduling paid work', async t => {
  const fixture = await harness(t)
  const options = await fixture.manager.options({ photoIds: ['photo-1', 'photo-2'] }, signal())
  assert.equal(options.creditBalance, 20)
  assert.deepEqual(options.photos.map(photo => photo.renditions.map(row => row.quality)), [
    ['Mockup', 'HighRes · HighDef'], ['Mockup', 'HighRes · HighDef'],
  ])
  assert.equal(JSON.stringify(options).includes('mediaKey'), false)
  assert.equal(JSON.stringify(options).includes('signature'), false)
  const items = options.photos.map(photo => ({ photoId: photo.id, renditionId: photo.renditions.find(row => row.quality.startsWith('HighRes')).id }))
  const directory = await fixture.manager.pickDirectory(signal())
  const plan = await fixture.manager.prepare({ directoryId: directory.directoryId, prefix: 'batch_', suffix: '_final', items }, signal())
  assert.equal(plan.totalCost, 8)
  assert.equal(fixture.purchases.length, 0)
  assert.deepEqual(fixture.featureChecks, [])
  const queued = await fixture.manager.confirm({ planId: plan.planId, confirmation: plan.confirmation, confirmed: true }, signal())
  assert.equal(queued.queued, true)
  assert.deepEqual(fixture.featureChecks, ['write'])
  assert.equal(fixture.purchases.length, 0)
  const outcome = await fixture.scheduled[0].operation(signal(), { updateProgress() {} })
  assert.equal(outcome.status, 'completed')
  assert.equal(fixture.purchases.length, 2)
  assert.deepEqual(fixture.purchases.map(item => item.id).sort(), ['photo-1', 'photo-2'])
  assert.equal(fixture.delivered.length, 2)
  const files = (await readdir(fixture.directory)).sort()
  assert.deepEqual(files, ['batch_AFP original_final (1).jpg', 'batch_AFP original_final.jpg'])
  for (const file of files) assert.deepEqual(await readFile(join(fixture.directory, file)), Buffer.from(jpeg))
  const records = await fixture.store.readDownloads()
  assert.equal(records[0].status, 'completed')
  assert.deepEqual(records[0].items.map(item => item.fileName).sort(), files)
  assert.doesNotMatch(JSON.stringify(records), /signature|host-only-secret|chosen output/)
})

test('confirmation returns the first changed balance snapshot without reading a reverting quote', async t => {
  const fixture = await harness(t)
  const balances = [20, 20, 19, 20]
  let reads = 0
  const open = fixture.connection.open
  fixture.connection.open = async (...args) => ({ ...await open(...args), readAccountProfile: async () => ({ credit: balances[reads++] }) })
  const options = await fixture.manager.options({ photoIds: ['photo'] }, signal())
  const directory = await fixture.manager.pickDirectory(signal())
  const plan = await fixture.manager.prepare({ directoryId: directory.directoryId,
    items: [{ photoId: 'photo', renditionId: options.photos[0].renditions[0].id }] }, signal())
  const result = await fixture.manager.confirm({ planId: plan.planId, confirmation: plan.confirmation, confirmed: true }, signal())
  assert.equal(reads, 3)
  assert.equal(result.requiresReconfirmation, true)
  assert.equal(result.changed, true)
  assert.equal(result.creditBalance, 19)
  assert.equal(result.photos[0].renditions.length, 2)
  assert.equal(result.selected[0].photoId, 'photo')
  assert.equal(fixture.scheduled.length, 0)
  assert.equal(fixture.purchases.length, 0)
  assert.doesNotMatch(JSON.stringify(result), /mediaKey|href|validateOrderId/)
})

test('startup authentication failure finalizes every queued download item with safe errors', async t => {
  const fixture = await harness(t)
  const options = await fixture.manager.options({ photoIds: ['one', 'two'] }, signal())
  const directory = await fixture.manager.pickDirectory(signal())
  const plan = await fixture.manager.prepare({ directoryId: directory.directoryId,
    items: options.photos.map(photo => ({ photoId: photo.id, renditionId: photo.renditions[0].id })) }, signal())
  await fixture.manager.confirm({ planId: plan.planId, confirmation: plan.confirmation, confirmed: true }, signal())
  fixture.connection.open = async () => { throw new Error('private-credential-error') }
  await assert.rejects(fixture.scheduled[0].operation(signal(), { updateProgress() {} }), error => error.code === 'download-task-failed' && !error.message.includes('private-credential-error'))
  const [record] = await fixture.store.readDownloads()
  assert.equal(record.status, 'failed')
  assert.equal(record.failed, 2)
  assert.deepEqual(record.items.map(item => [item.status, item.errorCode]), [['failed', 'download-task-failed'], ['failed', 'download-task-failed']])
  assert.doesNotMatch(JSON.stringify(record), /private-credential-error/)
})

test('changed accounts cannot prepare, confirm or execute a paid plan from earlier credentials', async t => {
  const fixture = await harness(t)
  let account = 'account-a'
  const open = fixture.connection.open
  fixture.connection.open = async (...args) => ({ ...await open(...args), account })
  const options = await fixture.manager.options({ photoIds: ['photo'] }, signal())
  const directory = await fixture.manager.pickDirectory(signal())
  const selection = { directoryId: directory.directoryId, items: [{ photoId: 'photo',
    renditionId: options.photos[0].renditions.find(row => row.purchaseCost > 0).id }] }
  account = 'account-b'
  await assert.rejects(fixture.manager.prepare(selection, signal()), error => error.code === 'download-account-changed')
  account = 'account-a'
  const plan = await fixture.manager.prepare(selection, signal())
  account = 'account-b'
  await assert.rejects(fixture.manager.confirm({ planId: plan.planId, confirmation: plan.confirmation, confirmed: true }, signal()),
    error => error.code === 'download-account-changed')
  account = 'account-a'
  const next = await fixture.manager.prepare(selection, signal())
  await fixture.manager.confirm({ planId: next.planId, confirmation: next.confirmation, confirmed: true }, signal())
  account = 'account-b'
  await assert.rejects(fixture.scheduled[0].operation(signal(), { updateProgress() {} }), error => error.code === 'download-account-changed')
  assert.equal(fixture.purchases.length, 0)
  assert.equal(fixture.delivered.length, 0)
  assert.doesNotMatch(JSON.stringify(options), /account-a/)
  assert.doesNotMatch(JSON.stringify(next), /account-a/)
})

test('initial quote drift requires review and returns all current qualities before any purchase', async t => {
  const fixture = await harness(t, { cost: 3 })
  const options = await fixture.manager.options({ photoIds: ['photo-1'] }, signal())
  const paid = options.photos[0].renditions.find(row => row.quality.startsWith('HighRes'))
  const directory = await fixture.manager.pickDirectory(signal())
  fixture.client.downloadPhotoDetails = async photoId => ({ id: photoId, guid: `guid-${photoId}`, title: photoId, downloadableMedias: [
    { name: 'Mockup', mediaKey: `free-${photoId}`, cost: 0, width: 300, height: 200, payable: true, href: `https://cdn.afp.example/free/${photoId}` },
    { name: 'HighRes', mediaKey: `paid-${photoId}`, cost: 5, width: 3000, height: 2000, payable: true },
  ] })
  const updated = await fixture.manager.prepare({ directoryId: directory.directoryId, items: [{ photoId: 'photo-1', renditionId: paid.id }] }, signal())
  assert.equal(updated.changed, true)
  assert.equal(updated.totalCost, 5)
  assert.deepEqual(updated.photos[0].renditions.map(row => row.quality), ['Mockup', 'HighRes'])
  assert.equal(updated.selected[0].renditionId, updated.photos[0].renditions[1].id)
  assert.equal(fixture.purchases.length, 0)
})

test('an accepted purchase without a confirmed delivery URL is recorded pending and never bought again', async t => {
  const fixture = await harness(t, { deliverAfterPurchase: false })
  const options = await fixture.manager.options({ photoIds: ['photo-1'] }, signal())
  const paid = options.photos[0].renditions.find(row => row.quality.startsWith('HighRes'))
  const directory = await fixture.manager.pickDirectory(signal())
  const plan = await fixture.manager.prepare({ directoryId: directory.directoryId, items: [{ photoId: 'photo-1', renditionId: paid.id }] }, signal())
  await fixture.manager.confirm({ planId: plan.planId, confirmation: plan.confirmation, confirmed: true }, signal())
  const outcome = await fixture.scheduled[0].operation(signal(), { updateProgress() {} })
  assert.equal(outcome.status, 'partial')
  assert.equal(outcome.pending, 1)
  assert.equal(fixture.purchases.length, 1)
  assert.equal(fixture.delivered.length, 0)
  const record = (await fixture.store.readDownloads())[0]
  assert.equal(record.items[0].status, 'pending')
  assert.equal(record.items[0].errorCode, 'purchase-pending')
  assert.doesNotMatch(JSON.stringify(record), /signature|validation-/)
})

test('download rejects oversized responses before saving and removes temporary files', async t => {
  const fixture = await harness(t, { maxDownloadBytes: 1024 * 1024 })
  fixture.client.downloadMedia = async () => new Response(jpeg, { status: 200,
    headers: { 'content-length': String(1024 * 1024 + 1) } })
  const options = await fixture.manager.options({ photoIds: ['photo-1'] }, signal())
  const free = options.photos[0].renditions[0]
  const directory = await fixture.manager.pickDirectory(signal())
  const plan = await fixture.manager.prepare({ directoryId: directory.directoryId,
    items: [{ photoId: free.photoId, renditionId: free.id }] }, signal())
  await fixture.manager.confirm({ planId: plan.planId, confirmation: plan.confirmation, confirmed: true }, signal())
  const outcome = await fixture.scheduled[0].operation(signal(), { updateProgress() {} })
  assert.equal(outcome.status, 'failed')
  assert.deepEqual(await readdir(fixture.directory), [])
  const record = (await fixture.store.readDownloads())[0]
  assert.equal(record.items[0].errorCode, 'image-too-large')
})

test('download cancellation aborts the response stream and persists the cancelled task', async t => {
  const fixture = await harness(t)
  let markStarted
  const started = new Promise(resolve => { markStarted = resolve })
  fixture.client.downloadMedia = async (_href, _redirects, _timeout, signal) => {
    markStarted()
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(jpeg)
      signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true })
    } }))
  }
  const options = await fixture.manager.options({ photoIds: ['photo-1'] }, signal())
  const free = options.photos[0].renditions[0]
  const directory = await fixture.manager.pickDirectory(signal())
  const plan = await fixture.manager.prepare({ directoryId: directory.directoryId,
    items: [{ photoId: free.photoId, renditionId: free.id }] }, signal())
  await fixture.manager.confirm({ planId: plan.planId, confirmation: plan.confirmation, confirmed: true }, signal())
  const controller = new AbortController()
  const job = fixture.scheduled[0].operation(controller.signal, { updateProgress() {} })
  await started
  controller.abort()
  const outcome = await job
  assert.equal(outcome.status, 'cancelled')
  assert.deepEqual(await readdir(fixture.directory), [])
  assert.equal((await fixture.store.readDownloads())[0].items[0].status, 'cancelled')
})

test('partial batches keep the successful stable filename and sanitize AFP names', async t => {
  const fixture = await harness(t)
  fixture.client.downloadMedia = async href => {
    if (href.endsWith('/photo-2')) throw new Error('simulated transport failure')
    if (href.endsWith('/photo-3')) return new Response(jpeg, { status: 200 })
    return new Response(jpeg, { status: 200,
      headers: { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent('CON:hero?.jpg')}` } })
  }
  const options = await fixture.manager.options({ photoIds: ['photo-1', 'photo-2', 'photo-3'] }, signal())
  const directory = await fixture.manager.pickDirectory(signal())
  const plan = await fixture.manager.prepare({ directoryId: directory.directoryId,
    items: options.photos.map(photo => ({ photoId: photo.id, renditionId: photo.renditions[0].id })) }, signal())
  await fixture.manager.confirm({ planId: plan.planId, confirmation: plan.confirmation, confirmed: true }, signal())
  const outcome = await fixture.scheduled[0].operation(signal(), { updateProgress() {} })
  assert.equal(outcome.status, 'partial')
  assert.equal(outcome.completed, 2)
  assert.equal(outcome.failed, 1)
  assert.deepEqual((await readdir(fixture.directory)).sort(), ['CON_hero_.jpg', 'guid-photo-3.jpg'])
  const [record] = await fixture.store.readDownloads()
  assert.deepEqual(record.items.map(item => item.status).sort(), ['completed', 'completed', 'failed'])
  assert.equal(record.items.find(item => item.fileName === 'CON_hero_.jpg').status, 'completed')
  assert.ok(record.items.some(item => item.fileName === 'guid-photo-3.jpg'))
})

test('persisted queued downloads become interrupted after Host restart', async t => {
  const fixture = await harness(t)
  const options = await fixture.manager.options({ photoIds: ['photo-1'] }, signal())
  const free = options.photos[0].renditions[0]
  const directory = await fixture.manager.pickDirectory(signal())
  const plan = await fixture.manager.prepare({ directoryId: directory.directoryId,
    items: [{ photoId: free.photoId, renditionId: free.id }] }, signal())
  await fixture.manager.confirm({ planId: plan.planId, confirmation: plan.confirmation, confirmed: true }, signal())
  fixture.manager.dispose()
  const restarted = new AfpDownloads({ ctx: fixture.manager.ctx, config: fixture.manager.config,
    connection: fixture.manager.connection, store: fixture.store, schedule() { throw new Error('must not schedule') },
    requireFeature() {} })
  t.after(() => restarted.dispose())
  const [record] = await restarted.status()
  assert.equal(record.status, 'interrupted')
  assert.equal(record.failed, 1)
  assert.equal(record.items[0].errorCode, 'host-stopped')
})
