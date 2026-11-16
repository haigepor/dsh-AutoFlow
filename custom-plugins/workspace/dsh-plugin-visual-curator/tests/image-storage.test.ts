/** Real private files exercise preview confirmation, history retention and maintenance admission. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFile, mkdir, readdir, symlink, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { serviceFixture } from './helpers/service-fixture.ts'
import { importedRecords } from '../src/host/imports.ts'
import { imageStorageViewSchema, imageStorageCleanedSchema } from '../src/shared/image-storage.ts'
import { CuratorError } from '../src/shared/errors.ts'
import { MediaError } from '../src/media/errors.ts'
import { toJson } from '../src/host/runtime.ts'
import sharp from 'sharp'

test('confirmed cleanup removes only unreferenced blobs and retains hidden historical originals and derivatives', async () => {
  const f = await serviceFixture()
  try {
    await f.service.initialize()
    const kept = await f.files.importBytes(f.referenceImage)
    const records = importedRecords(f.profileId, f.actor, kept, { kind: 'local-import', description: 'Retained history' }, 'bytes-allowed')
    await f.repository.commit({ aggregateId: 'hidden-history', expectedRevision: 0, operationId: 'hidden-history', request: {}, records: records.records, state: { hidden: true } })
    const unused = await f.files.importBytes(f.http.image)
    const before = imageStorageViewSchema.parse(await f.action('image-storage-read'))
    assert(before.cleanupAllowed && before.reclaimableBytes > 0 && before.reclaimableFiles > 0)
    assert.deepEqual(await f.files.read(unused.originalBlob), f.http.image, 'Preview never removes files')
    await assert.rejects(f.action('image-storage-clean', { revision: before.revision, confirm: false }))
    const after = imageStorageCleanedSchema.parse(await f.action('image-storage-clean', { revision: before.revision, confirm: true }))
    assert.equal(after.freedBytes, before.reclaimableBytes)
    assert.equal(after.freedFiles, before.reclaimableFiles)
    assert.equal(after.usedBytes, before.usedBytes - before.reclaimableBytes)
    assert.equal(after.reclaimableFiles, 0)
    assert.deepEqual(await f.files.read(kept.originalBlob), f.referenceImage)
    await f.files.read(kept.normalized.blob); await f.files.read(kept.preview.blob)
    await assert.rejects(f.files.read(unused.originalBlob))
    assert.equal(f.repository.list('imageVersion').length, records.records.filter(record => record.kind === 'imageVersion').length)
  } finally { await f.cleanup() }
})

test('a changed preview cannot remove a blob newly protected by a committed receipt', async () => {
  const f = await serviceFixture()
  try {
    await f.service.initialize()
    const image = await f.files.importBytes(f.referenceImage)
    const before = imageStorageViewSchema.parse(await f.action('image-storage-read'))
    await f.repository.commit({ aggregateId: 'saved-receipt', expectedRevision: 0, operationId: 'saved-receipt', request: {}, records: [], state: toJson({ original: image.originalBlob, normalized: image.normalized.blob, preview: image.preview.blob }) })
    await assert.rejects(f.action('image-storage-clean', { revision: before.revision, confirm: true }), error => error instanceof MediaError && error.code === 'revision-conflict')
    assert.deepEqual(await f.files.read(image.originalBlob), f.referenceImage)
    assert.equal(imageStorageViewSchema.parse(await f.action('image-storage-read')).reclaimableFiles, 0)
    await assert.rejects(f.service.action({ operation: 'image-storage-clean', args: { revision: before.revision, confirm: true } }, { kind: 'agent', id: 'agent', sessionId: 'session', profileId: f.profileId }, new AbortController().signal), error => error instanceof CuratorError && error.code === 'owner-denied')
  } finally { await f.cleanup() }
})

test('new image work is rejected until confirmed cleanup has released its maintenance ownership', async () => {
  const f = await serviceFixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let cleanup: Promise<unknown> | undefined
  try {
    await f.service.initialize(); await f.files.importBytes(f.referenceImage)
    const preview = imageStorageViewSchema.parse(await f.action('image-storage-read')), maintain = f.files.maintainStorage.bind(f.files)
    f.files.maintainStorage = async (retained, revision) => { if (revision) { entered.resolve(); await release.promise } return await maintain(retained, revision) }
    cleanup = f.action('image-storage-clean', { revision: preview.revision, confirm: true })
    await entered.promise
    await assert.rejects(f.action('direct-crop-start', { operationId: 'during-cleanup', name: 'Deferred import', source: { kind: 'local', files: [{ path: join(f.root, 'source.png'), name: 'source.png' }] } }), error => error instanceof CuratorError && error.code === 'constraint-conflict' && error.stage === 'image-storage')
    release.resolve(); await cleanup
    assert.equal(imageStorageViewSchema.parse(await f.action('image-storage-read')).reclaimableFiles, 0)
  } finally { release.resolve(); try { await cleanup } finally { await f.cleanup() } }
})

test('a live image workflow prevents cleanup without cancelling the accepted task', async () => {
  const f = await serviceFixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    await f.service.initialize()
    const path = join(f.root, 'source.png'); await writeFile(path, f.referenceImage)
    const request = f.http.request.bind(f.http)
    f.http.request = async (url, input) => { if (url.startsWith('https://vision.example.test')) { entered.resolve(); await release.promise } return await request(url, input) }
    await f.action('direct-crop-start', { operationId: 'live-image', name: 'Live image', source: { kind: 'local', files: [{ path, name: 'source.png' }] } })
    await entered.promise
    const preview = imageStorageViewSchema.parse(await f.action('image-storage-read'))
    assert.equal(preview.cleanupAllowed, false)
    await assert.rejects(f.action('image-storage-clean', { revision: preview.revision, confirm: true }), error => error instanceof CuratorError && error.code === 'constraint-conflict')
    assert(f.repository.list('run').some(run => run.status === 'running'))
  } finally { release.resolve(); await f.jobs.drain(); await f.cleanup() }
})

test('a storage directory link cannot turn confirmed cleanup into deletion outside the private media root', async () => {
  const f = await serviceFixture()
  try {
    await f.service.initialize(); await f.files.importBytes(f.referenceImage)
    const preview = imageStorageViewSchema.parse(await f.action('image-storage-read'))
    const shards = await readdir(join(f.files.root, 'blobs'))
    const prefix = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, '0')).find(prefix => !shards.includes(prefix))
    assert(prefix !== undefined)
    const outside = join(f.root, 'outside-media'); await mkdir(outside)
    const protectedFile = join(outside, prefix + '0'.repeat(62)); await writeFile(protectedFile, 'Retain outside data')
    await symlink(outside, join(f.files.root, 'blobs', prefix), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(f.action('image-storage-clean', { revision: preview.revision, confirm: true }), error => error instanceof MediaError && error.code === 'reference-unavailable')
    assert.equal(await readFile(protectedFile, 'utf8'), 'Retain outside data')
  } finally { await f.cleanup() }
})

test('cleaning unreferenced imports restores capacity for a new original while retained images remain readable', async () => {
  const f = await serviceFixture()
  try {
    await f.service.initialize()
    const kept = await f.files.importBytes(f.referenceImage)
    const records = importedRecords(f.profileId, f.actor, kept, { kind: 'local-import', description: 'Saved original' }, 'bytes-allowed')
    await f.repository.commit({ aggregateId: 'retained-original', expectedRevision: 0, operationId: 'retained-original', request: {}, records: records.records, state: {} })
    for (const background of ['red', 'blue', 'yellow']) await f.files.importBytes(await sharp({ create: { width: 400, height: 200, channels: 3, background } }).png().toBuffer())
    const full = imageStorageViewSchema.parse(await f.action('image-storage-read'))
    f.files.limits.maxStorageBytes = full.usedBytes + 1
    const next = await sharp({ create: { width: 400, height: 200, channels: 3, background: 'purple' } }).png().toBuffer()
    await assert.rejects(f.files.importBytes(next), error => error instanceof MediaError && error.code === 'budget-exhausted')
    await f.action('image-storage-clean', { revision: full.revision, confirm: true })
    const imported = await f.files.importBytes(next)
    assert.deepEqual(await f.files.read(imported.originalBlob), next)
    assert.deepEqual(await f.files.read(kept.originalBlob), f.referenceImage)
  } finally { await f.cleanup() }
})
