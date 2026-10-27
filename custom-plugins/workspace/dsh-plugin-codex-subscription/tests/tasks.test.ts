import test from 'node:test'
import assert from 'node:assert/strict'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { imageTaskSchema } from '../src/host/tasks/repository.ts'
import { imageAttachmentAdapter } from '../src/host/images/attachments.ts'
import type { ImageAsset, ImageTask } from '../src/host/images/types.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
const asset: ImageAsset = { id: 'asset', mimeType: 'image/png',
  original: { attachmentId: AttachmentId('original'), bytes: png.length, name: 'generated.png' },
  preview: { attachmentId: AttachmentId('preview'), mediaType: 'image/png', bytes: 25, width: 1, height: 1 } }
const task: ImageTask = { id: 'task', owner: { kind: 'gateway', keyId: 'local-client' }, state: 'succeeded', prompt: 'One square',
  model: 'gpt-image-2', createdAt: 1, updatedAt: 2, deadlineAt: 3, assets: [asset] }

test('durable task parser accepts attachment references and rejects unrecognized credential fields', () => {
  assert.deepEqual(imageTaskSchema.parse(JSON.parse(JSON.stringify(task))), task)
  assert.equal(imageTaskSchema.safeParse({ ...task, accessToken: 'must-not-persist' }).success, false)
  assert.equal(imageTaskSchema.safeParse({ ...task, state: 'completed-but-uncommitted' }).success, false)
  assert.equal(imageTaskSchema.safeParse({ ...task, owner: { kind: 'session', sessionId: '' } }).success, false)
  assert.equal(imageTaskSchema.safeParse({ ...task, assets: [{ ...asset, preview: { ...asset.preview, width: -1 } }] }).success, false)
})

test('attachment adapter preserves original bytes and stores normalized previews separately', async () => {
  const writes: { kind: string; bytes: Uint8Array }[] = []
  const adapter = imageAttachmentAdapter({
    validateImage: () => Promise.resolve(),
    saveFile: input => { writes.push({ kind: 'original', bytes: input.data }); return Promise.resolve(asset.original) },
    saveImage: input => { writes.push({ kind: 'preview', bytes: input.data }); return Promise.resolve(asset.preview) },
    async *readFileStream() { yield png.subarray(0, 10); yield png.subarray(10) },
  }, 1024)
  const stored = await adapter.saveAssets([{ data: png, mimeType: 'image/png', name: 'generated.png' }])
  assert.deepEqual(writes.map(write => write.kind), ['original', 'preview'])
  assert.deepEqual(writes[0]?.bytes, png)
  assert.equal(stored[0]?.original.attachmentId, 'original')
  assert.equal(stored[0]?.preview.attachmentId, 'preview')
  assert.deepEqual((await adapter.readAsset(stored[0]!)).data, png)
})

test('the whole image batch is validated before any attachment write', async () => {
  let validation = 0, writes = 0
  const adapter = imageAttachmentAdapter({
    validateImage: () => ++validation === 2 ? Promise.reject(new Error('invalid second image')) : Promise.resolve(),
    saveFile: () => { writes++; return Promise.resolve(asset.original) },
    saveImage: () => { writes++; return Promise.resolve(asset.preview) },
    async *readFileStream() { yield png },
  }, 1024)
  await assert.rejects(adapter.saveAssets([{ data: png, mimeType: 'image/png' }, { data: png, mimeType: 'image/png' }]), /invalid second/)
  assert.equal(writes, 0)
})

test('original reads enforce both declared and streamed byte limits', async () => {
  const adapter = imageAttachmentAdapter({
    validateImage: () => Promise.resolve(), saveFile: () => Promise.resolve(asset.original), saveImage: () => Promise.resolve(asset.preview),
    async *readFileStream() { yield png },
  }, 4)
  await assert.rejects(adapter.readAsset(asset), /read limit/)
  await assert.rejects(adapter.readAsset({ ...asset, original: { ...asset.original, bytes: 1 } }), /read limit/)
})
