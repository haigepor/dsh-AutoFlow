/** The public LLM bridge delegates to the existing image task owner, including its cancellation. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { brandString } from '@deepseek-ai/dsh-brand'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageGenerationId, ImageGenerationRequest } from '@deepseek-ai/dsh-llm'
import { imageLlmProvider } from '../src/host/images/llm.ts'
import type { ImagesFacade, ImageTask } from '../src/host/images/types.ts'

function fixture() {
  const preview = { attachmentId: AttachmentId('preview'), mediaType: 'image/png' as const, bytes: 3, width: 1, height: 1 }
  const original = { attachmentId: AttachmentId('original'), name: 'original.png', bytes: 3 }
  let submitted = 0, cancelled = 0, waiting = false
  let captured: Parameters<ImagesFacade['submit']>[0] | undefined, selectedAccount: string | undefined
  const owner = { kind: 'gateway' as const, keyId: 'llm-operation:operation' }
  let task: ImageTask = { id: 'image-task', owner, state: 'sent', prompt: 'A cup', model: 'image-model', createdAt: 0, updatedAt: 0, deadlineAt: 10000, assets: [] }
  const facade: ImagesFacade = {
    submit: async (input, actualOwner, operation, _signal, accountKey) => { assert.deepEqual(actualOwner, owner); assert.equal(operation?.id, 'operation'); task = { ...task, ...(operation ? { operation } : {}) }; captured = input; selectedAccount = accountKey; submitted++; return task },
    getResult: async (_id, actualOwner, options) => { assert.deepEqual(actualOwner, owner); assert.equal(options?.waitMs, 20000); if (waiting) await new Promise<void>((_resolve, reject) => { options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true }) }); return { ...task, state: 'succeeded', assets: [{ id: 'asset', mimeType: 'image/png', preview, original }] } },
    cancel: async () => { cancelled++; return { ...task, state: 'cancelled' } }, list: async () => [], readAsset: async () => ({ data: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }),
  }
  const provider = imageLlmProvider(facade, { readImage: async () => ({ data: new Uint8Array([1, 2, 3]), ref: preview }) }, async () => [{ id: 'image-model', name: 'Images' }], () => 20000, async () => [{ id: 'account-a', name: 'Account A', available: true }])
  const request: ImageGenerationRequest = { id: brandString<ImageGenerationId>('operation'), provider: 'test', model: 'image-model', prompt: 'A cup', references: [preview], size: '1024x1024', quality: 'high', signal: new AbortController().signal }
  return { provider, request, original, preview, waiting() { waiting = true }, get submitted() { return submitted }, get cancelled() { return cancelled }, get captured() { return captured }, get selectedAccount() { return selectedAccount } }
}

test('fixed Codex account reaches the accepted image task', async () => {
  const f = fixture()
  await f.provider.start!({ ...f.request, sourceId: 'account-a' })
  assert.equal(f.selectedAccount, 'account-a')
  await assert.rejects(f.provider.start!({ ...f.request, sourceId: 'missing' }), { code: 'UNSUPPORTED_OPTION' })
  assert.equal(f.submitted, 1)
})

test('LLM image calls preserve original attachments and resolve references through the profile', async () => {
  const f = fixture(), images = await f.provider.generate(f.request)
  assert.deepEqual(images, [{ original: f.original, preview: f.preview }]); assert.equal(f.submitted, 1)
  assert.equal(f.captured?.referenceImages?.[0], 'data:image/png;base64,AQID'); assert.equal(f.captured?.quality, 'high')
})

test('aborting an accepted image wait cancels its existing task without resubmission', async () => {
  const f = fixture(), abort = new AbortController(); f.waiting()
  const promise = f.provider.generate({ ...f.request, signal: abort.signal })
  while (!f.submitted) await new Promise<void>(resolve => setImmediate(resolve))
  abort.abort(); await assert.rejects(promise); assert.equal(f.cancelled, 1); assert.equal(f.submitted, 1)
})
