/** Real temporary image files exercise transfer, admission, interruption and directory recovery without model calls. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'
import { importedRecords } from '../src/host/imports.ts'
import { CuratorService } from '../src/host/service.ts'
import { toJson } from '../src/host/runtime.ts'
import { CuratorDomain } from '../src/domain/curator.ts'
import { DomainRepository } from '../src/domain/repository.ts'
import { CuratorError } from '../src/shared/errors.ts'
import { MediaError } from '../src/media/errors.ts'
import { imageStorageViewSchema } from '../src/shared/image-storage.ts'
import { imageStorageInventory, isImageStorageBlob, prepareStorageDirectory } from '../src/media/storage-directory.ts'

test('migration preserves image identities and hidden history, removes verified old blobs and restores the custom directory on restart', async () => {
  const f = await serviceFixture()
  let restarted: CuratorService | undefined
  try {
    await f.service.initialize()
    const image = await f.files.importBytes(f.referenceImage), source = f.files.root, target = join(f.root, 'custom-images')
    const records = importedRecords(f.profileId, f.actor, image, { kind: 'local-import', description: 'Saved history' }, 'bytes-allowed')
    await f.repository.commit({ aggregateId: 'hidden-images', expectedRevision: 0, operationId: 'hidden-images', request: {}, records: records.records, state: { hidden: true } })
    await writeFile(join(source, 'writer.lock'), 'Retain the profile lock')
    await mkdir(target)
    const before = await imageStorageInventory(source), id = randomUUID(), input = { operationId: id, sourceDirectory: source, directory: target, confirm: true }
    await f.action('image-storage-migrate', input)
    await f.jobs.drain()
    const view = imageStorageViewSchema.parse(await f.action('image-storage-read'))
    assert.equal(view.directory, target)
    assert.equal(view.migration?.status, 'completed')
    assert.equal(view.migration.totalFiles, before.filter(file => isImageStorageBlob(file.ref)).length)
    assert.equal(view.reclaimableFiles, 0, 'References remain protected after transfer')
    assert.equal((await imageStorageInventory(source)).filter(file => isImageStorageBlob(file.ref)).length, 0)
    assert.equal(await readFile(join(source, 'writer.lock'), 'utf8'), 'Retain the profile lock')
    assert.deepEqual(await f.files.read(image.originalBlob), f.referenceImage)
    await f.files.read(image.normalized.blob); await f.files.read(image.preview.blob)
    assert.equal(f.repository.list('imageVersion').length, records.records.filter(record => record.kind === 'imageVersion').length)
    const hooks = f.jobs.hooks.length
    await f.action('image-storage-migrate', input)
    assert.equal(f.jobs.hooks.length, hooks, 'An acknowledged retry does not migrate twice')
    const added = await f.files.importBytes(f.http.image)
    assert.deepEqual(await readFile(join(target, added.originalBlob.storageRef)), f.http.image, 'Later imports use the selected directory')
    await f.service.dispose()
    restarted = new CuratorService(f.host, f.service.config, { providers: f.providers, openDomain: async files => new CuratorDomain(f.profileId, new DomainRepository(f.profileId, f.adapter), { verifyImage: async value => { await files.verifyReference(value.blob) } }) })
    await restarted.initialize()
    const value = imageStorageViewSchema.parse(await restarted.action({ operation: 'image-storage-read', args: {} }, f.actor, new AbortController().signal))
    assert.equal(value.directory, target)
    assert.equal(value.migration?.status, 'completed')
    await restarted.action({ operation: 'image-storage-migrate', args: { operationId: randomUUID(), sourceDirectory: target, directory: source, confirm: true } }, f.actor, new AbortController().signal)
    await f.jobs.drain()
    const restored = imageStorageViewSchema.parse(await restarted.action({ operation: 'image-storage-read', args: {} }, f.actor, new AbortController().signal))
    assert.equal(restored.directory, source, 'The original profile directory remains a supported destination')
    assert.equal(restored.migration?.status, 'completed')
    assert.deepEqual(await readFile(join(source, image.originalBlob.storageRef)), f.referenceImage)
    assert.deepEqual(f.http.operations, [], 'Moving files never calls an image or vision model')
  } finally { await restarted?.dispose(); await f.cleanup() }
})

test('missing historical images do not prevent verified migration of available files or erase the missing records', async () => {
  const f = await serviceFixture()
  try {
    await f.service.initialize()
    const historical = await f.files.importBytes(f.referenceImage), available = await f.files.importBytes(f.http.image), source = f.files.root
    const saved = importedRecords(f.profileId, f.actor, historical, { kind: 'local-import', description: 'Earlier saved history' }, 'bytes-allowed')
    await f.repository.commit({ aggregateId: 'earlier-images', expectedRevision: 0, operationId: 'earlier-images', request: {}, records: saved.records, state: { hidden: true } })
    await unlink(join(source, historical.originalBlob.storageRef))
    const before = [...f.repository.list('imageVersion')], target = join(f.root, 'available-images')
    await mkdir(target)
    await f.action('image-storage-migrate', { operationId: randomUUID(), sourceDirectory: source, directory: target, confirm: true })
    await f.jobs.drain()
    const view = imageStorageViewSchema.parse(await f.action('image-storage-read'))
    assert.equal(view.migration?.status, 'completed', 'An existing historical gap is not a copy or verification failure')
    assert.equal(view.migration.missingFiles, 1)
    assert.equal(view.directory, target)
    assert.deepEqual(f.repository.list('imageVersion'), before, 'Missing image references and hidden history remain unchanged')
    assert.deepEqual(await readFile(join(target, available.originalBlob.storageRef)), f.http.image)
    await assert.rejects(readFile(join(target, historical.originalBlob.storageRef)), { code: 'ENOENT' }, 'Migration cannot restore a file that was already missing')
    assert.equal((await imageStorageInventory(source)).filter(file => isImageStorageBlob(file.ref)).length, 0)
  } finally { await f.cleanup() }
})

test('a legacy failed preparation resumes the same operation with historical gaps and keeps its records', async () => {
  const f = await serviceFixture()
  let restarted: CuratorService | undefined
  try {
    await f.service.initialize()
    const image = await f.files.importBytes(f.referenceImage), available = await f.files.importBytes(f.http.image)
    const saved = importedRecords(f.profileId, f.actor, image, { kind: 'local-import', description: 'Historical gap' }, 'bytes-allowed')
    await f.repository.commit({ aggregateId: 'history-gap', expectedRevision: 0, operationId: 'history-gap', request: {}, records: saved.records, state: { hidden: true } })
    await unlink(join(f.files.root, image.originalBlob.storageRef))
    const { directory: source, migration: _migration, ...usage } = imageStorageViewSchema.parse(await f.action('image-storage-read'))
    const target = join(f.root, 'legacy-transfer'), id = randomUUID()
    await mkdir(target); await prepareStorageDirectory(target, source, f.profileId, source)
    await f.repository.commit({ aggregateId: 'image-storage-location:v1', expectedRevision: 0, operationId: id, request: {}, records: [], state: toJson({ version: 1, directory: source, usage, migration: { id, status: 'failed', phase: 'preparing', sourceDirectory: source, targetDirectory: target, totalFiles: 0, totalBytes: 0, copiedFiles: 0, copiedBytes: 0, verifiedFiles: 0, verifiedBytes: 0, removedFiles: 0, removedBytes: 0, files: [], autoResume: false, errorCode: 'reference-unavailable' } }) })
    await f.service.dispose()
    restarted = new CuratorService(f.host, f.service.config, { providers: f.providers, openDomain: async files => new CuratorDomain(f.profileId, new DomainRepository(f.profileId, f.adapter), { verifyImage: async value => { await files.verifyReference(value.blob) } }) })
    await restarted.initialize()
    await restarted.action({ operation: 'image-storage-migration-resume', args: { id } }, f.actor, new AbortController().signal)
    await f.jobs.drain()
    const view = imageStorageViewSchema.parse(await restarted.action({ operation: 'image-storage-read', args: {} }, f.actor, new AbortController().signal))
    assert.equal(view.migration?.id, id); assert.equal(view.migration.status, 'completed'); assert.equal(view.migration.missingFiles, 1)
    assert.deepEqual(new Map(f.repository.list('imageVersion').map(record => [record.id, record])), new Map(saved.records.filter(record => record.kind === 'imageVersion').map(record => [record.id, record])))
    assert.deepEqual(await readFile(join(target, available.originalBlob.storageRef)), f.http.image)
  } finally { await restarted?.dispose(); await f.cleanup() }
})

test('a file lost after inventory still stops migration before changing the active directory', async () => {
  const f = await serviceFixture()
  try {
    await f.service.initialize()
    const image = await f.files.importBytes(f.referenceImage), source = f.files.root, target = join(f.root, 'source-loss')
    await mkdir(target)
    const writeManifest = f.adapter.writeManifest.bind(f.adapter)
    let removed = false
    f.adapter.writeManifest = async manifest => {
      await writeManifest(manifest)
      if (manifest.aggregateId !== 'image-storage-location:v1') return
      const state = z.object({ migration: z.object({ phase: z.string() }) }).parse(manifest.state)
      if (state.migration.phase === 'copying' && !removed) { removed = true; await unlink(join(source, image.originalBlob.storageRef)) }
    }
    await f.action('image-storage-migrate', { operationId: randomUUID(), sourceDirectory: source, directory: target, confirm: true })
    await f.jobs.drain()
    const view = imageStorageViewSchema.parse(await f.action('image-storage-read'))
    assert.equal(removed, true)
    assert.equal(view.directory, source)
    assert.equal(view.migration?.status, 'failed')
    assert.equal(view.migration.missingFiles, 0, 'A new source loss cannot become a pre-existing historical warning')
    assert.equal(view.migration.errorCode, 'reference-unavailable')
  } finally { await f.cleanup() }
})

test('an accepted transfer outlives its request, exposes progress and excludes new image work', async () => {
  const f = await serviceFixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    await f.service.initialize(); const image = await f.files.importBytes(f.referenceImage)
    const target = join(f.root, 'background-images'); await mkdir(target)
    const activate = f.files.activateStorageDirectory.bind(f.files)
    f.files.activateStorageDirectory = async (directory, commit) => { entered.resolve(); await release.promise; await activate(directory, commit) }
    const controller = new AbortController()
    await f.service.action({ operation: 'image-storage-migrate', args: { operationId: randomUUID(), sourceDirectory: f.files.root, directory: target, confirm: true } }, f.actor, controller.signal)
    controller.abort(); await entered.promise
    const view = imageStorageViewSchema.parse(await f.action('image-storage-read'))
    assert.equal(view.migration?.status, 'running'); assert.equal(view.cleanupAllowed, false)
    assert.deepEqual(await f.files.read(image.originalBlob), f.referenceImage)
    await assert.rejects(f.action('direct-crop-start'), error => error instanceof CuratorError && error.stage === 'storage-migration')
    await assert.rejects(f.action('image-storage-clean', { revision: view.revision, confirm: true }))
    release.resolve(); await f.jobs.drain()
    assert.equal(imageStorageViewSchema.parse(await f.action('image-storage-read')).migration?.status, 'completed')
  } finally { release.resolve(); await f.jobs.drain(); await f.cleanup() }
})

test('host interruption preserves source images and startup resumes the durable transfer before image work', async () => {
  const f = await serviceFixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let restarted: CuratorService | undefined
  try {
    await f.service.initialize(); const image = await f.files.importBytes(f.referenceImage), source = f.files.root
    const target = join(f.root, 'resumed-images'); await mkdir(target)
    const activate = f.files.activateStorageDirectory.bind(f.files)
    f.files.activateStorageDirectory = async (directory, commit) => { entered.resolve(); await release.promise; await activate(directory, commit) }
    await f.action('image-storage-migrate', { operationId: randomUUID(), sourceDirectory: source, directory: target, confirm: true })
    await entered.promise
    const stopped = f.service.dispose(); release.resolve(); await stopped
    assert.deepEqual(await readFile(join(source, image.originalBlob.storageRef)), f.referenceImage)
    restarted = new CuratorService(f.host, f.service.config, { providers: f.providers, openDomain: async files => new CuratorDomain(f.profileId, new DomainRepository(f.profileId, f.adapter), { verifyImage: async value => { await files.verifyReference(value.blob) } }) })
    await restarted.initialize(); await f.jobs.drain()
    const view = imageStorageViewSchema.parse(await restarted.action({ operation: 'image-storage-read', args: {} }, f.actor, new AbortController().signal))
    assert.equal(view.directory, target); assert.equal(view.migration?.status, 'completed')
    assert.deepEqual(await readFile(join(target, image.originalBlob.storageRef)), f.referenceImage)
  } finally { release.resolve(); await restarted?.dispose(); await f.cleanup() }
})

test('a failed location commit keeps source files and blocks new writes until explicit recovery succeeds', async () => {
  const f = await serviceFixture()
  try {
    await f.service.initialize(); const image = await f.files.importBytes(f.referenceImage), source = f.files.root
    const target = join(f.root, 'commit-recovery'); await mkdir(target)
    const activate = f.files.activateStorageDirectory.bind(f.files)
    f.files.activateStorageDirectory = async (directory, commit) => { f.adapter.failNextManifest = true; await activate(directory, commit) }
    await f.action('image-storage-migrate', { operationId: randomUUID(), sourceDirectory: source, directory: target, confirm: true }); await f.jobs.drain()
    const view = imageStorageViewSchema.parse(await f.action('image-storage-read'))
    assert.equal(view.directory, source); assert.equal(view.migration?.status, 'blocked')
    assert.deepEqual(await f.files.read(image.originalBlob), f.referenceImage)
    await assert.rejects(f.action('direct-crop-start'), error => error instanceof CuratorError && error.stage === 'storage-migration')
    f.files.activateStorageDirectory = activate
    await f.action('image-storage-migration-resume', { id: view.migration.id }); await f.jobs.drain()
    assert.equal(imageStorageViewSchema.parse(await f.action('image-storage-read')).migration?.status, 'completed')
  } finally { await f.cleanup() }
})

test('foreign, overlapping and linked destination directories are rejected without changing the active library', async () => {
  const f = await serviceFixture()
  try {
    await f.service.initialize(); const image = await f.files.importBytes(f.referenceImage), source = f.files.root
    const target = join(f.root, 'foreign'); await mkdir(target); await writeFile(join(target, 'keep.txt'), 'Unrelated file')
    const start = (directory: string) => f.action('image-storage-migrate', { operationId: randomUUID(), sourceDirectory: source, directory, confirm: true })
    await assert.rejects(start(target), error => error instanceof MediaError && error.code === 'storage-directory-not-empty')
    await assert.rejects(start(source), error => error instanceof MediaError && error.code === 'storage-directory-overlap')
    const linked = join(f.root, 'linked'); await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(start(linked), error => error instanceof MediaError && error.code === 'reference-unavailable')
    assert.equal(f.files.root, source); assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'Unrelated file')
    assert.deepEqual(await f.files.read(image.originalBlob), f.referenceImage)
    assert.equal(f.jobs.hooks.length, 0)
  } finally { await f.cleanup() }
})

test('a corrupt destination digest is never overwritten and source copies are retained', async () => {
  const f = await serviceFixture()
  try {
    await f.service.initialize(); const image = await f.files.importBytes(f.referenceImage), source = f.files.root
    const target = join(f.root, 'corrupt-target'); await mkdir(join(target, 'blobs', image.originalBlob.digest.slice(0, 2)), { recursive: true })
    await writeFile(join(target, '.visual-curator-storage.json'), JSON.stringify({ version: 1, profileId: f.profileId }))
    const corrupt = join(target, image.originalBlob.storageRef); await writeFile(corrupt, 'Incorrect image bytes')
    await f.action('image-storage-migrate', { operationId: randomUUID(), sourceDirectory: source, directory: target, confirm: true }); await f.jobs.drain()
    const view = imageStorageViewSchema.parse(await f.action('image-storage-read'))
    assert.equal(view.directory, source); assert.equal(view.migration?.status, 'failed'); assert.equal(view.migration.errorCode, 'storage-checksum-mismatch')
    assert.equal(await readFile(corrupt, 'utf8'), 'Incorrect image bytes')
    assert.deepEqual(await f.files.read(image.originalBlob), f.referenceImage)
    assert.equal((await readdir(target)).some(name => name.endsWith('.tmp')), false)
  } finally { await f.cleanup() }
})
