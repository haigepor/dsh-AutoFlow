/** MCP tests exercise the official HTTP SDK adapter and gateway-bound tool ownership. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { z } from 'zod'
import { startRelay } from '../src/host/relay/server.ts'
import type { RelayConfig } from '../src/host/relay/types.ts'
import type { ImageTask } from '../src/host/images/types.ts'

const config: RelayConfig = { host: '127.0.0.1', port: 0, gatewayKeys: [{ id: 'first', secret: 'gateway-key-first-12345' }, { id: 'second', secret: 'gateway-key-second-12345' }], allowedOrigins: [], maxRequestBytes: 4096, maxResponseBytes: 1024 * 1024, requestTimeoutMs: 5000, imageWaitMs: 50, assetUrlTtlMs: 60000, maxConcurrentRequests: 8 }

const resultSchema = z.object({ result: z.object({ tools: z.array(z.object({ name: z.string() })).default([]), content: z.array(z.object({ type: z.string(), text: z.string().optional(), data: z.string().optional(), mimeType: z.string().optional() })).default([]), isError: z.boolean().optional(), _meta: z.record(z.string(), z.unknown()).optional() }) })

async function rpc(origin: string, key: string, method: string, params: object): Promise<z.infer<typeof resultSchema>> {
  const response = await fetch(`${origin}/mcp/image`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  assert.equal(response.status, 200)
  const body = await response.text()
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = body.split('\n').find(line => line.startsWith('data:'))?.slice(5)
    return resultSchema.parse(JSON.parse(data ?? ''))
  }
  return resultSchema.parse(JSON.parse(body))
}

test('MCP lists real tools and returns saved images only to the submitting gateway key', async () => {
  let task: ImageTask | undefined
  const attachmentId = AttachmentId('b'.repeat(64))
  const relay = await startRelay(config, {
    listModels: async () => [], requestResponses: async () => { throw new Error('unused') },
    images: {
      submit: async (input, owner) => { task = { id: 'task-first', owner, state: 'queued', prompt: input.prompt, model: 'image-model', createdAt: 1, updatedAt: 1, deadlineAt: 10000, assets: [] }; return task },
      getResult: async (id, owner) => {
        if (task === undefined || id !== task.id || JSON.stringify(owner) !== JSON.stringify(task.owner)) throw new Error('Private task')
        return { ...task, state: 'succeeded', assets: [{ id: 'saved-image', mimeType: 'image/png', original: { attachmentId, bytes: 3, name: 'image.png' }, preview: { attachmentId, bytes: 3, mediaType: 'image/png', width: 1, height: 1 } }] }
      },
    },
    readAsset: async (_id, _asset, owner) => {
      assert.deepEqual(owner, { kind: 'gateway', keyId: 'first' })
      return { data: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }
    },
  })
  try {
    const listed = await rpc(relay.origin, config.gatewayKeys[0]?.secret ?? '', 'tools/list', {})
    assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name), ['generate_image', 'generation_result'])
    const started = await rpc(relay.origin, config.gatewayKeys[0]?.secret ?? '', 'tools/call', { name: 'generate_image', arguments: { prompt: 'draw a tree' } })
    assert.equal(JSON.parse(started.result.content[0]?.text ?? '').task_id, 'task-first')
    const denied = await rpc(relay.origin, config.gatewayKeys[1]?.secret ?? '', 'tools/call', { name: 'generation_result', arguments: { task_id: 'task-first' } })
    assert.equal(denied.result.isError, true)
    assert.equal(JSON.stringify(denied).includes('Private task'), false)
    const done = await rpc(relay.origin, config.gatewayKeys[0]?.secret ?? '', 'tools/call', { name: 'generation_result', arguments: { task_id: 'task-first', wait_ms: 0 } })
    assert.equal(done.result.content[1]?.type, 'image')
    assert.equal(done.result.content[1]?.data, 'AQID')
    assert.equal(done.result.content[1]?.mimeType, 'image/png')
  } finally { await relay.close() }
})

test('MCP rejects oversized JSON before invoking an image generation', async () => {
  let submitted = false
  const relay = await startRelay(config, { requestResponses: async () => { throw new Error('unused') }, listModels: async () => [], images: { submit: async () => { submitted = true; throw new Error('unused') }, getResult: async () => { throw new Error('unused') } }, readAsset: async () => { throw new Error('unused') } })
  try {
    const response = await fetch(`${relay.origin}/mcp/image`, { method: 'POST', headers: { Authorization: `Bearer ${config.gatewayKeys[0]?.secret}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'generate_image', arguments: { prompt: 'x'.repeat(8192) } } }) })
    assert.equal(response.status, 413)
    assert.equal(submitted, false)
  } finally { await relay.close() }
})

test('Magpie MCP arguments and pending metadata work, and oversized images retain signed downloads', async () => {
  let task: ImageTask | undefined, received: unknown
  const attachmentId = AttachmentId('c'.repeat(64))
  const relay = await startRelay({ ...config, maxResponseBytes: 2048 }, {
    listModels: async () => [], requestResponses: async () => { throw new Error('unused') },
    images: {
      submit: async (input, owner) => { received = input; task = { id: 'magpie-task', owner, state: 'queued', prompt: input.prompt, model: 'image-model', createdAt: 1, updatedAt: 1, deadlineAt: 10000, assets: [] }; return task },
      getResult: async (id, owner) => {
        assert.equal(id, task?.id); assert.deepEqual(owner, task?.owner)
        assert.ok(task)
        return task
      },
    },
    readAsset: async () => ({ data: new Uint8Array(1800), mimeType: 'image/png' }),
  })
  try {
    const key = config.gatewayKeys[0]!.secret
    const started = await rpc(relay.origin, key, 'tools/call', { name: 'generate_image', arguments: { prompt: 'edit', reference_images: ['https://images.example.com/one.png'], output_format: 'webp', size: '16:9' } })
    assert.equal(started.result.isError, undefined)
    assert.deepEqual(received, { prompt: 'edit', referenceImages: ['https://images.example.com/one.png'], outputFormat: 'webp', size: '16:9' })
    assert.equal(started.result._meta?.['usemagpie.ai/pending'], 'magpie-task')
    assert.ok(task)
    task = { ...task, state: 'succeeded', assets: [{ id: 'large-image', mimeType: 'image/png', original: { attachmentId, bytes: 1800, name: 'large.png' }, preview: { attachmentId, mediaType: 'image/png', bytes: 3, width: 1, height: 1 } }] }
    const done = await rpc(relay.origin, key, 'tools/call', { name: 'generation_result', arguments: { id: task.id } })
    assert.equal(done.result.isError, undefined)
    const files = z.array(z.object({ url: z.string(), inline: z.boolean() })).parse(done.result._meta?.['usemagpie.ai/files'])
    assert.equal(files[0]?.inline, false)
    assert.ok(files[0]?.url.startsWith(relay.origin))
    const downloaded = await fetch(files[0]!.url)
    assert.equal(downloaded.status, 200)
    assert.equal((await downloaded.arrayBuffer()).byteLength, 1800)
    assert.equal(JSON.stringify(done).includes('gateway-key-first'), false)
    const conflict = await rpc(relay.origin, key, 'tools/call', { name: 'generation_result', arguments: { id: 'other', task_id: task.id } })
    assert.equal(conflict.result.isError, true)
  } finally { await relay.close() }
})
