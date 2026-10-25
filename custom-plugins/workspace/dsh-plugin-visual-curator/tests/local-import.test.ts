import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import { createCuratorStore } from '../src/client/store.ts'
import { droppedImageSources, importLocalImages, type LocalImageSource, type DroppedEntry } from '../src/client/local-import.ts'
import { serviceFixture } from './helpers/service-fixture.ts'
import { resultId } from '../src/client/workbench-actions.ts'

test('folder imports retain relative paths, batch revisions, individual errors and empty MIME support', async () => {
  const f = await serviceFixture(undefined, { maxImportFiles: 2 }); await f.service.initialize()
  const revisions: unknown[] = []
  const store = createCuratorStore({ invoke: async (operation, args) => { if (operation === 'reference-import') revisions.push(args.expectedRevision); return await f.action(operation, args) } })
  try {
    const styleId = resultId(await store.execute('style-create', { operationId: 'style', name: 'Folder' }))
    const jpeg = await sharp(f.http.image).jpeg().toBuffer()
    const source = (path: string, bytes: Uint8Array, type = ''): LocalImageSource => ({ path, file: new File([new Uint8Array(bytes)], path.split('/').at(-1)!, { type }) })
    const inputs = [source('folder/a.JPG', jpeg), source('folder/sub/a.PNG', f.http.image), source('folder/readme.txt', new Uint8Array([1, 2])), source('folder/bad.PNG', new Uint8Array([1, 2, 3])), source('folder/too-large.jpg', new Uint8Array(6000))]
    const rows = await importLocalImages(store, { styleId, role: 'positive', files: inputs, limits: { maxImportFiles: 2, maxImportBytes: 5000 } }, () => {})
    assert.deepEqual(rows.map(row => row.status), ['imported', 'imported', 'skipped', 'failed', 'failed'])
    const expected = JSON.parse(await readFile(new URL('./fixtures/import-results.expected.json', import.meta.url), 'utf8'))
    assert.deepEqual(rows.map(row => ({ name: row.name, status: row.status, reason: row.reason ?? null, errorCode: row.error?.code ?? null })), expected)
    assert.deepEqual(revisions, [1, 2])
    assert.equal(rows[2]?.reason, 'unsupportedFile')
    assert.equal(rows[3]?.error?.code, 'invalid-input')
    assert.equal(rows[4]?.reason, 'fileTooLarge')
    assert.deepEqual(f.repository.list('asset').map(asset => asset.source.description).sort(), ['folder/a.JPG', 'folder/sub/a.PNG'])
    assert.equal(f.http.operations.length, 0)
  } finally { store.dispose(); await f.cleanup() }
})

test('dragged folders read every directory page and retain nested relative paths', async () => {
  const file = (name: string): DroppedEntry => ({ name, isDirectory: false, file: success => success(new File([new Uint8Array([1])], name)) })
  const nested: DroppedEntry = { name: 'nested', isDirectory: true, createReader: () => { let read = false; return { readEntries: success => { success(read ? [] : [file('deep.png')]); read = true } } } }
  let reads = 0
  const pages = [Array.from({ length: 100 }, (_, index) => file(`${index}.jpg`)), [file('last.webp'), nested], []]
  const root: DroppedEntry = { name: 'photos', isDirectory: true, createReader: () => ({ readEntries: success => success(pages[reads++] ?? []) }) }
  const files = await droppedImageSources([root], [])
  assert.equal(reads, 3)
  assert.equal(files.length, 102)
  assert.equal(files.at(-1)?.path, 'photos/nested/deep.png')
  assert.equal(files[100]?.path, 'photos/last.webp')
})

test('closing the importer stops undispatched batches without overwriting committed successes', async () => {
  const f = await serviceFixture(undefined, { maxImportFiles: 1 }); await f.service.initialize()
  const lifetime = new AbortController()
  const store = createCuratorStore({ invoke: f.action })
  try {
    const styleId = resultId(await store.execute('style-create', { operationId: 'style', name: 'Cancelled upload' }))
    const actions = { getSnapshot: store.getSnapshot, execute: async (...args: Parameters<typeof store.execute>) => { const result = await store.execute(...args); lifetime.abort(); return result } }
    const files = Array.from({ length: 3 }, (_, index) => ({ path: `${index}.png`, file: new File([new Uint8Array(f.http.image)], `${index}.png`, { type: 'image/png' }) }))
    const rows = await importLocalImages(actions, { styleId, role: 'positive', files, limits: { maxImportFiles: 1, maxImportBytes: 5000 } }, () => assert.equal(lifetime.signal.aborted, false), lifetime.signal)
    assert.deepEqual(rows.map(row => row.status), ['imported', 'skipped', 'skipped'])
    assert.equal(f.repository.list('reference').length, 1)
  } finally { store.dispose(); await f.cleanup() }
})

test('a failed batch keeps earlier successes, marks unknown outcomes and stops queued uploads', async () => {
  const f = await serviceFixture(undefined, { maxImportFiles: 2 }); await f.service.initialize()
  let batches = 0
  const store = createCuratorStore({ invoke: async (operation, args) => { if (operation === 'reference-import' && ++batches === 2) throw { code: 'network-failure', safeMessage: '', suggestedAction: '' }; return await f.action(operation, args) } })
  try {
    const styleId = resultId(await store.execute('style-create', { operationId: 'style', name: 'Interrupted import' }))
    const files = Array.from({ length: 5 }, (_, index) => ({ path: `folder/${index}.png`, file: new File([new Uint8Array(f.http.image)], `${index}.png`, { type: 'image/png' }) }))
    const rows = await importLocalImages(store, { styleId, role: 'positive', files, limits: { maxImportFiles: 2, maxImportBytes: 5000 } }, () => {})
    assert.deepEqual(rows.map(row => row.status), ['imported', 'imported', 'unconfirmed', 'unconfirmed', 'skipped'])
    assert.equal(batches, 2)
    assert.equal(f.repository.list('reference').length, 2)
  } finally { store.dispose(); await f.cleanup() }
})
