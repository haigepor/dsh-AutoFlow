/** Immutable records and image bytes must survive incomplete or hostile filesystem input. */
import { test, expect } from 'vitest'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ArtifactStore } from '../src/host/artifact-store.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'article-artifacts-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  return new ArtifactStore(root, { maxDocumentBytes: 10000, maxAssetBytes: 10000 })
}

test('publishes immutable records and detects a changed durable payload', async t => {
  const store = await fixture(t)
  const id = await store.put('snapshots', { title: '正文与图片', blocks: [{ id: 'b1', text: 'Article' }] })
  expect(await store.get('snapshots', id)).toEqual({ title: '正文与图片', blocks: [{ id: 'b1', text: 'Article' }] })
  const path = join(store.root, 'snapshots', `${id}.json`)
  const envelope = JSON.parse(await readFile(path, 'utf8'))
  envelope.value.title = 'changed'
  await writeFile(path, JSON.stringify(envelope), 'utf8')
  await expect(store.get('snapshots', id)).rejects.toThrow('storage-integrity')
})

test('stores image bytes separately, deduplicates them and verifies their digest', async t => {
  const store = await fixture(t), bytes = Buffer.from('image fixture bytes')
  const digest = createHash('sha256').update(bytes).digest('hex')
  await store.putAsset({ bytes, contentHash: digest })
  await store.putAsset({ bytes, contentHash: digest })
  expect(await store.getAsset(digest)).toEqual(bytes)
  await writeFile(join(store.root, 'assets', `${digest}.bin`), 'changed', 'utf8')
  await expect(store.getAsset(digest)).rejects.toThrow('storage-integrity')
  await expect(store.putAsset({ bytes, contentHash: '0'.repeat(64) })).rejects.toThrow('storage-integrity')
})

test('rejects paths, incomplete records, directories in place of records and oversized documents', async t => {
  const store = await fixture(t)
  await expect(store.get('snapshots', '../escape')).rejects.toThrow()
  await expect(store.getAsset('../escape')).rejects.toThrow()
  await expect(store.put('snapshots', { text: 'x'.repeat(11000) })).rejects.toThrow('storage-size')
  await mkdir(join(store.root, 'snapshots'), { recursive: true })
  const id = '1'.repeat(32), path = join(store.root, 'snapshots', `${id}.json`)
  await writeFile(path, '{', 'utf8')
  await expect(store.get('snapshots', id)).rejects.toThrow('storage-invalid')
  const dirId = '2'.repeat(32)
  await mkdir(join(store.root, 'snapshots', `${dirId}.json`))
  await expect(store.get('snapshots', dirId)).rejects.toThrow('storage-path')
})
