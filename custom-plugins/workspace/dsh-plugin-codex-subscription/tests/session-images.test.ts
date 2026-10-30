/** Session attachment references are resolved before an image task can dispatch. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { resolveSessionImage } from '../src/host/images/session-references.ts'

const ref = { attachmentId: AttachmentId('uploaded-image'), mediaType: 'image/png' as const, bytes: 4, width: 1, height: 1 }
const session = { id: 'own-session', deriveMessages: () => [createUserMessage({ content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } })] }
const signal = () => new AbortController().signal

test('uploaded image IDs and latest resolve only from this Session with bounded bytes', async () => {
  let reads = 0
  const attachments = { readImage: async () => { reads++; return { ref, data: Uint8Array.of(1, 2, 3, 4) } } }
  const images = { list: async () => [], readAsset: async () => { throw new Error('unused') } }
  assert.deepEqual((await resolveSessionImage('latest', session, attachments, images, 4, signal())).data, Uint8Array.of(1, 2, 3, 4))
  await resolveSessionImage('uploaded-image', session, attachments, images, 4, signal())
  await assert.rejects(resolveSessionImage('foreign-image', session, attachments, images, 4, signal()), { code: 'image-attachment-unavailable' })
  await assert.rejects(resolveSessionImage('uploaded-image', { ...session, deriveMessages: () => [] }, attachments, images, 4, signal()), { code: 'image-attachment-unavailable' })
  await assert.rejects(resolveSessionImage('uploaded-image', session, attachments, images, 3, signal()), { code: 'image-too-large' })
  assert.equal(reads, 2)
})

test('previous generated original and preview IDs resolve through owned task assets, never arbitrary store IDs', async () => {
  const asset = { id: 'asset', mimeType: 'image/png' as const, original: { attachmentId: AttachmentId('original'), bytes: 4, name: 'original.png' }, preview: ref }
  const images = { list: async (owner: { kind: string; sessionId?: string }) => owner.sessionId === session.id ? [{ id: 'task', assets: [asset] }] : [],
    readAsset: async (_task: string, _asset: string, owner: { kind: string; sessionId?: string }) => { assert.equal(owner.sessionId, session.id); return { data: Uint8Array.of(1, 2, 3, 4), mimeType: 'image/png' as const } } }
  const attachments = { readImage: async () => { throw new Error('Generated originals must use their task authorization') } }
  const empty = { ...session, deriveMessages: () => [] }
  for (const id of ['original', 'uploaded-image', 'latest']) assert.equal((await resolveSessionImage(id, empty, attachments, images, 4, signal())).data.byteLength, 4)
  assert.equal((await resolveSessionImage('latest', session, attachments, images, 4, signal())).data.byteLength, 4)
  await assert.rejects(resolveSessionImage('original', { ...empty, id: 'foreign-session' }, attachments, images, 4, signal()), { code: 'image-attachment-unavailable' })
})
