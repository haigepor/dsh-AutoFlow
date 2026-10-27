/** Public gateway protocol tests use injected transport and durable-task stand-ins. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { startRelay } from '../src/host/relay/server.ts'
import { chatRequest, ChatStream } from '../src/host/relay/chat.ts'
import type { RelayConfig, RelayDependencies } from '../src/host/relay/types.ts'
import type { ImageInput, ImageOwner, ImageTask } from '../src/host/images/types.ts'

const config: RelayConfig = { host: '127.0.0.1', port: 0, gatewayKeys: [{ id: 'one', secret: 'gateway-key-one-123456' }, { id: 'two', secret: 'gateway-key-two-123456' }], allowedOrigins: [], maxRequestBytes: 1024 * 1024, maxResponseBytes: 1024 * 1024, requestTimeoutMs: 5000, imageWaitMs: 50, assetUrlTtlMs: 60000, maxConcurrentRequests: 8 }
const authorization = { Authorization: `Bearer ${config.gatewayKeys[0]?.secret}`, 'Content-Type': 'application/json' }
const terminal = { id: 'resp-a', model: 'codex-test', created_at: 1000, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }, { type: 'function_call', id: 'fc-a', call_id: 'call-a', name: 'lookup', arguments: '{"q":"x"}' }], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } }
const events = [{ type: 'response.created', response: { id: 'resp-a', model: 'codex-test' } }, { type: 'response.output_text.delta', delta: 'Hello' }, { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc-a', call_id: 'call-a', name: 'lookup', arguments: '' } }, { type: 'response.function_call_arguments.delta', item_id: 'fc-a', delta: '{"q":"x"}' }, { type: 'response.completed', response: terminal }]
function upstream(): Response { return new Response(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }) }
const unusedImages = { submit: async (): Promise<ImageTask> => { throw new Error('unused') }, getResult: async (): Promise<ImageTask> => { throw new Error('unused') } }

test('raw Responses preserves SSE and reconstructs the exact terminal JSON for nonstream clients', async () => {
  const relay = await startRelay(config, { requestResponses: async () => upstream(), listModels: async () => [], images: unusedImages, readAsset: async () => { throw new Error('unused') } })
  try {
    const stream = await fetch(`${relay.origin}/v1/responses`, { method: 'POST', headers: authorization, body: JSON.stringify({ model: 'x', input: [], stream: true }) })
    assert.match(await stream.text(), /response\.function_call_arguments\.delta/)
    const result = await fetch(`${relay.origin}/v1/responses`, { method: 'POST', headers: authorization, body: JSON.stringify({ model: 'x', input: [], stream: false }) })
    assert.deepEqual(await result.json(), terminal)
  } finally { await relay.close() }
})

test('chat codec preserves text, image, system instructions and function exchanges', () => {
  const converted = chatRequest({ model: 'x', messages: [{ role: 'system', content: 'AutoFlow instructions' }, { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] }, { role: 'assistant', content: null, tool_calls: [{ id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call-a', content: 'result' }], tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }] })
  assert.equal(converted.instructions, 'AutoFlow instructions')
  assert.deepEqual(converted.tools, [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }])
  assert.match(JSON.stringify(converted.input), /input_image/)
  assert.match(JSON.stringify(converted.input), /function_call_output/)
  const midConversation = chatRequest({ model: 'x', messages: [{ role: 'system', content: 'initial' }, { role: 'user', content: 'first' }, { role: 'developer', content: 'updated' }, { role: 'user', content: 'second' }] })
  assert.equal(midConversation.instructions, 'initial')
  assert.deepEqual((midConversation.input as Array<{ role: string }>).map(message => message.role), ['user', 'developer', 'user'])
})

test('nonstream clients receive an explicit error when SSE ends without a terminal response', async () => {
  const relay = await startRelay(config, { requestResponses: async () => new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'), listModels: async () => [], images: unusedImages, readAsset: async () => { throw new Error('unused') } })
  try {
    const response = await fetch(`${relay.origin}/v1/responses`, { method: 'POST', headers: authorization, body: JSON.stringify({ model: 'x', input: [] }) })
    assert.equal(response.status, 502)
    assert.equal((await response.json()).error.code, 'incomplete_response')
  } finally { await relay.close() }
})

test('closing the listener aborts an active upstream stream and removes its sockets', async () => {
  let aborted = false
  const relay = await startRelay(config, {
    requestResponses: async (_body, signal) => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: first\n\n')); signal.addEventListener('abort', () => { aborted = true; controller.close() }, { once: true }) } })),
    listModels: async () => [], images: unusedImages, readAsset: async () => { throw new Error('unused') },
  })
  const response = await fetch(`${relay.origin}/v1/responses`, { method: 'POST', headers: authorization, body: JSON.stringify({ model: 'x', input: [], stream: true }) })
  const body = response.body?.getReader()
  await body?.read()
  await relay.close()
  assert.equal(aborted, true)
  await body?.cancel().catch(() => { /* The deliberate shutdown may already have errored the fetch body. */ })
})

test('gateway deadline aborts pending upstream headers and returns a sanitized timeout', async () => {
  let aborted = false
  const relay = await startRelay({ ...config, requestTimeoutMs: 50 }, {
    requestResponses: async (_body, signal) => await new Promise<Response>((_resolve, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(new Error('private-token-must-not-leak')) }, { once: true }) }),
    listModels: async () => [], images: unusedImages, readAsset: async () => { throw new Error('unused') },
  })
  try {
    const response = await fetch(`${relay.origin}/v1/responses`, { method: 'POST', headers: authorization, body: JSON.stringify({ model: 'x', input: [] }) })
    assert.equal(response.status, 504)
    assert.equal(aborted, true)
    assert.equal((await response.text()).includes('private-token'), false)
  } finally { await relay.close() }
})

test('chat stream projects function argument deltas, terminal reason and usage', async () => {
  const relay = await startRelay(config, { requestResponses: async () => upstream(), listModels: async () => [], images: unusedImages, readAsset: async () => { throw new Error('unused') } })
  try {
    const request = { model: 'x', messages: [{ role: 'user', content: 'hello' }] }
    const result = await fetch(`${relay.origin}/v1/chat/completions`, { method: 'POST', headers: authorization, body: JSON.stringify(request) })
    const body = await result.json()
    assert.equal(body.choices[0].finish_reason, 'tool_calls')
    assert.equal(body.choices[0].message.tool_calls[0].id, 'call-a')
    assert.equal(body.usage.total_tokens, 5)
    const stream = await fetch(`${relay.origin}/v1/chat/completions`, { method: 'POST', headers: authorization, body: JSON.stringify({ ...request, stream: true }) })
    const output = await stream.text()
    assert.match(output, /chat\.completion\.chunk/)
    assert.match(output, /tool_calls/)
    assert.match(output, /\[DONE\]/)
  } finally { await relay.close() }
})

test('chat streaming reconciles done-only values and emits only missing argument suffixes', () => {
  const codec = new ChatStream()
  codec.convert({ type: 'response.created', response: { id: 'r', model: 'x' } })
  codec.convert({ type: 'response.output_item.added', item: { type: 'function_call', id: 'f', call_id: 'c', name: 'lookup', arguments: '' } })
  const partial = codec.convert({ type: 'response.function_call_arguments.delta', item_id: 'f', delta: '{"q":' }).join('')
  assert.match(partial, /arguments/)
  const done = codec.convert({ type: 'response.function_call_arguments.done', item_id: 'f', arguments: '{"q":"x"}' }).join('')
  assert.match(done, /\\"x\\"/)
  assert.equal(done.includes('q'), false)
  const final = codec.convert({ type: 'response.completed', response: { id: 'r', model: 'x', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Only terminal text' }] }, { type: 'function_call', id: 'f', call_id: 'c', name: 'lookup', arguments: '{"q":"x"}' }] } }).join('')
  assert.match(final, /Only terminal text/)
  assert.equal(final.includes('arguments'), false)
  assert.match(final, /\[DONE\]/)
  const onlyDone = new ChatStream()
  const functionDone = onlyDone.convert({ type: 'response.output_item.done', item: { type: 'function_call', id: 'f', call_id: 'c', name: 'lookup', arguments: '{}' } }).join('')
  assert.match(functionDone, /lookup/)
})

test('chat streaming refuses a final value that contradicts already emitted bytes', () => {
  const codec = new ChatStream()
  codec.convert({ type: 'response.output_item.added', item: { type: 'function_call', id: 'f', call_id: 'c', name: 'lookup', arguments: '' } })
  codec.convert({ type: 'response.function_call_arguments.delta', item_id: 'f', delta: '{"q":"first' })
  assert.throws(() => codec.convert({ type: 'response.function_call_arguments.done', item_id: 'f', arguments: '{"q":"other"}' }), /changed tool arguments/)
  const text = new ChatStream()
  text.convert({ type: 'response.output_text.delta', delta: 'first' })
  assert.throws(() => text.convert({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'different' }] }] } }), /changed text/)
})

test('images accept multipart edits, return original bytes and enforce signed-download task ownership', async () => {
  let accepted: ImageInput | undefined
  const attachmentId = AttachmentId('a'.repeat(64))
  const task = (owner: ImageOwner): ImageTask => ({ id: 'image-task', owner, state: 'succeeded', prompt: 'test', model: 'image-model', createdAt: 1000, updatedAt: 1000, deadlineAt: 5000, assets: [{ id: 'asset', mimeType: 'image/png', original: { attachmentId, bytes: 3, name: 'image.png' }, preview: { attachmentId, bytes: 3, mediaType: 'image/png', width: 1, height: 1 } }] })
  const dependencies: RelayDependencies = { requestResponses: async () => upstream(), listModels: async () => [], images: { submit: async (input, owner) => { accepted = input; return task(owner) }, getResult: async (_id, owner) => task(owner) }, readAsset: async (_task, _asset, owner) => { if (owner.kind !== 'gateway' || owner.keyId !== 'one') throw new Error('Forbidden'); return { data: Buffer.from('png'), mimeType: 'image/png' } } }
  const relay = await startRelay(config, dependencies)
  try {
    const form = new FormData()
    form.set('prompt', 'edit image')
    form.set('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'test.png')
    form.set('mask', new Blob([new Uint8Array([4, 5, 6])], { type: 'image/png' }), 'mask.png')
    const edit = await fetch(`${relay.origin}/v1/images/edits`, { method: 'POST', headers: { Authorization: authorization.Authorization }, body: form })
    assert.equal(edit.status, 200)
    assert.equal((await edit.json()).data[0].b64_json, Buffer.from('png').toString('base64'))
    assert.equal(accepted?.referenceImages?.[0], 'data:image/png;base64,AQID')
    assert.equal(accepted?.mask, 'data:image/png;base64,BAUG')
    const jsonEdit = await fetch(`${relay.origin}/v1/images/edits`, { method: 'POST', headers: authorization, body: JSON.stringify({ prompt: 'masked edit', image: 'https://example.com/image.png', mask: { image_url: 'https://example.com/mask.png' } }) })
    assert.equal(jsonEdit.status, 200)
    assert.equal(accepted?.mask, 'https://example.com/mask.png')
    const generated = await fetch(`${relay.origin}/v1/images/generations`, { method: 'POST', headers: authorization, body: JSON.stringify({ prompt: 'new image', response_format: 'url' }) })
    const url: string = (await generated.json()).data[0].url
    assert.equal(url.includes(config.gatewayKeys[0]?.secret ?? ''), false)
    assert.equal(await (await fetch(url)).text(), 'png')
    assert.equal((await fetch(url.replace('key_id=one', 'key_id=two'))).status, 401)
    const privateUrl = new URL(url); privateUrl.search = ''
    assert.equal((await fetch(privateUrl, { headers: { Authorization: `Bearer ${config.gatewayKeys[1]?.secret}` } })).status, 502)
  } finally { await relay.close() }
})
