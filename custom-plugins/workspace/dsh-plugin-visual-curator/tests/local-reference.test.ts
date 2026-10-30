import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { AssetFiles } from '../src/media/assets.ts'
import { serviceFixture } from './helpers/service-fixture.ts'
import { createCuratorStore } from '../src/client/store.ts'
import { importLocalPaths, importPickedReferences } from '../src/client/local-import.ts'
import { resultId } from '../src/client/workbench-actions.ts'
import { dataOf } from '../src/host/runtime.ts'
import { CuratorError } from '../src/shared/errors.ts'
import type { CommitInput } from '../src/domain/repository.ts'
import type { Json } from '../src/shared/model.ts'

test('one native selection accepts an individual image and an entire folder while retaining original paths', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'curator-combined-reference-')))
  let selection: string[] = []
  const f = await serviceFixture(undefined, {}, { pickLocalPaths: async (kind) => { assert.equal(kind, 'references'); return selection } })
  await f.service.initialize()
  try {
    const folder = join(root, '照片'), nested = join(folder, '子目录')
    await mkdir(nested, { recursive: true }); await writeFile(join(folder, 'a.JPG'), f.http.image); await writeFile(join(nested, 'b.PNG'), f.http.image)
    const args = { kind: 'references', title: 'Images or folder', folderLabel: 'Current folder', imagesLabel: 'Images' }
    selection = [join(folder, 'a.JPG')]
    const image = await f.action('local-reference-pick', args)
    selection = [folder]
    const directory = await f.action('local-reference-pick', args)
    assert.ok(image && typeof image === 'object' && !Array.isArray(image) && Array.isArray(image.files))
    assert.ok(directory && typeof directory === 'object' && !Array.isArray(directory) && Array.isArray(directory.files))
    assert.equal(image.files.length, 1); assert.equal(directory.files.length, 2)
    assert.ok(JSON.stringify(directory).includes('子目录/b.PNG'))
    assert.equal(f.repository.list('asset').length, 0)
    await assert.rejects(readdir(join(f.root, 'visual-curator', 'blobs')), { code: 'ENOENT' })
    await assert.rejects(f.action('local-reference-pick', { kind: 'references', title: 'Missing labels' }))
  } finally { await f.cleanup(); await rm(root, { recursive: true, force: true }) }
})

test('local references retain original paths without writing image copies and reject changed sources', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'curator-path-reference-')))
  try {
    const input = join(root, 'original.JPG'), mediaRoot = join(root, 'media')
    const original = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#759881' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer()
    await writeFile(input, original)
    const files = new AssetFiles(mediaRoot, { maxFileBytes: 20_000_000, maxPixels: 80_000_000, maxDimension: 20_000, previewMaxDimension: 256, maxStorageBytes: 100_000_000 })
    const referenced = await files.referenceFile(input)
    assert.equal(referenced.normalized.blob.localSource?.path, input)
    assert.equal(referenced.normalized.width, 171)
    assert.equal(referenced.normalized.height, 256)
    assert.deepEqual(await readdir(root), ['original.JPG'])
    const pixels = await files.read(referenced.normalized.blob)
    assert.equal((await sharp(pixels).metadata()).height, 256)
    await files.read(referenced.preview.blob)
    assert.deepEqual(await readdir(root), ['original.JPG'])
    await writeFile(input, Buffer.alloc(original.length, 1))
    await assert.rejects(files.read(referenced.normalized.blob), { code: 'reference-unavailable' })
    await assert.rejects(files.read(referenced.preview.blob), { code: 'reference-unavailable' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('folder references analyze from original paths and create no private image blobs', async () => {
  const f = await serviceFixture(undefined, { maxImportFiles: 1 }); await f.service.initialize()
  const store = createCuratorStore({ invoke: f.action })
  try {
    const folder = join(f.root, 'originals'), nested = join(folder, 'nested')
    await mkdir(nested, { recursive: true })
    await writeFile(join(folder, 'one.PNG'), f.http.image)
    await writeFile(join(nested, 'two.PNG'), f.http.image)
    await writeFile(join(folder, 'notes.txt'), 'not an image', 'utf8')
    const styleId = resultId(await store.execute('style-create', { name: 'Path references', operationId: 'create' }))
    const rows = await importLocalPaths(store, { path: folder, kind: 'folder', styleId, role: 'positive', limits: { maxImportFiles: 1, maxImportBytes: 1_000_000 } }, () => {})
    assert.equal(rows.filter(row => row.status === 'imported').length, 2)
    assert.equal(rows.filter(row => row.status === 'skipped').length, 1)
    assert.equal(f.domain.require('style', styleId).revision, 3)
    assert.equal(new Set(f.repository.list('asset').map(asset => asset.familyId)).size, 1)
    assert.ok(f.repository.list('imageVersion').every(image => image.blob.localSource?.path.startsWith(folder)))
    await assert.rejects(readdir(join(f.root, 'visual-curator', 'blobs')), { code: 'ENOENT' })
    const runId = resultId(await store.execute('reference-analyze', { styleId, operationId: 'analyze', buildDataset: true }), 'runId')
    await f.jobs.drain()
    assert.equal(f.domain.require('run', runId).status, 'completed', JSON.stringify(dataOf(f.domain.require('run', runId)).error))
    assert.deepEqual(f.http.operations, ['analyze:', 'summarize:'])
    await assert.rejects(readdir(join(f.root, 'visual-curator', 'blobs')), { code: 'ENOENT' })
    const savedPath = f.repository.list('imageVersion')[0]!.blob.localSource!.path
    await writeFile(savedPath, 'changed source', 'utf8')
    const failedId = resultId(await store.execute('reference-analyze', { styleId, operationId: 'changed-analysis', buildDataset: true }), 'runId')
    await f.jobs.drain()
    assert.equal(f.domain.require('run', failedId).status, 'failed')
    assert.equal(f.http.operations.length, 2, 'changed paths must fail before sending any image to the API')
    await assert.rejects(f.service.action({ operation: 'local-files-list', args: { path: folder, kind: 'folder' } }, { kind: 'agent', id: 'agent', sessionId: 'other', profileId: f.profileId }, new AbortController().signal), { code: 'owner-denied' })
  } finally { store.dispose(); await f.cleanup() }
})

test('local-path registration recovers a failed batch receipt without duplicating references or copying pixels', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const path = join(f.root, 'original.PNG'); await writeFile(path, f.http.image)
    const styleId = resultId(await f.action('style-create', { operationId: 'create', name: 'Path recovery' }))
    const input: Record<string, Json> = { operationId: 'recover-paths', styleId, expectedRevision: 1, role: 'positive', files: [{ path, name: 'original.PNG' }] }
    const commit = f.repository.commit.bind(f.repository)
    let fail = true
    f.repository.commit = async (request: CommitInput) => {
      if (fail && request.aggregateId === 'local-reference:recover-paths' && request.operationId === 'recover-paths') { fail = false; throw new CuratorError('storage-commit-failed', 'local-reference', 'Injected receipt failure.') }
      return await commit(request)
    }
    await assert.rejects(f.action('reference-local-import', input), { code: 'storage-commit-failed' })
    const retried = await f.action('reference-local-import', input)
    assert.deepEqual(await f.action('reference-local-import', input), retried)
    assert.equal(f.repository.list('asset').length, 1)
    assert.equal(f.repository.list('reference').length, 1)
    assert.equal(f.domain.require('style', styleId).revision, 2)
    await assert.rejects(readdir(join(f.root, 'visual-curator', 'blobs')), { code: 'ENOENT' })
    const denied = await f.service.data(new Request('https://owner.example/api/visual-curator/data', { method: 'POST', body: JSON.stringify({ operation: 'reference-local-import', args: input }) }))
    assert.equal(denied.status, 400)
    assert.equal((await denied.json()).error.code, 'owner-denied')
  } finally { await f.cleanup() }
})

test('system selections register multiple original files; cancellation and late selections leave the collection unchanged', async () => {
  let selected: string[] | null = null
  const choices: string[] = []
  const f = await serviceFixture(undefined, { maxImportFiles: 1 }, { pickLocalPaths: async (kind, title) => { choices.push(`${kind}:${title}`); return selected } })
  await f.service.initialize()
  const store = createCuratorStore({ invoke: f.action })
  try {
    const first = join(f.root, '一.PNG'), second = join(f.root, '二.PNG')
    await writeFile(first, f.http.image); await writeFile(second, f.http.image)
    const styleId = resultId(await store.execute('style-create', { operationId: 'create', name: 'System references' }))
    const input = { styleId, role: 'positive' as const, limits: { maxImportFiles: 1, maxImportBytes: 1_000_000 } }
    const pick = () => f.action('local-reference-pick', { kind: 'file', title: '引用图片' })
    let callbacks = 0
    await importPickedReferences(store, input, pick, () => { callbacks++ }, new AbortController().signal)
    assert.equal(callbacks, 0)
    assert.equal(f.domain.require('style', styleId).revision, 1)
    selected = [first, second]
    const rows = await importPickedReferences(store, input, pick, () => {}, new AbortController().signal)
    assert.deepEqual(rows.map(row => [row.name, row.status]), [[first, 'imported'], [second, 'imported']])
    const aborted = new AbortController()
    await importPickedReferences(store, input, async () => { const result = await pick(); aborted.abort(); return result }, () => { throw new Error('late selection must not update the UI') }, aborted.signal)
    assert.equal(f.repository.list('reference').length, 2)
    assert.ok(choices.every(choice => choice === 'file:引用图片'))
    await assert.rejects(readdir(join(f.root, 'visual-curator', 'blobs')), { code: 'ENOENT' })
    await assert.rejects(f.service.action({ operation: 'local-reference-pick', args: { kind: 'file', title: 'Pick' } }, { kind: 'agent', id: 'agent', sessionId: 'other', profileId: f.profileId }, new AbortController().signal), { code: 'owner-denied' })
  } finally { store.dispose(); await f.cleanup() }
})
