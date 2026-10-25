import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { CompatibleVisionProvider } from '../src/media/vision.ts'
import type { HttpClient } from '../src/media/network.ts'

const config = { endpoint: 'https://vision.example.test/chat/completions', model: 'stream-fixture', supportsMultiImage: true, supportsStreaming: true, maxImages: 1, maxImageBytes: 65536, maxRequestBytes: 100000, maxOutputTokens: 2048, temperature: 0 }
const bounds = { maxBytes: 65536, timeoutMs: 1000, maxRedirects: 0 }
async function input() {
  const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } }).png().toBuffer()
  return { requestId: 'stream-request', taskBrief: 'Observe pixels', rules: [], images: [{ imageVersionId: 'image-one', bytes, digest: createHash('sha256').update(bytes).digest('hex'), mime: 'image/png', role: 'positive' }] }
}
const output = { observations: [{ imageVersionId: 'image-one', dimensions: [{ dimension: 'color', observation: '红色', uncertain: false }] }], suggestedRules: [] }

test('streams actual provider content and reasoning across split UTF-8 and SSE frames before completion', async () => {
  const chunks: string[] = []
  const http: HttpClient = { async request(_url, request) {
    assert.equal(JSON.parse(Buffer.from(request.body!).toString('utf8')).stream, true)
    const content = JSON.stringify(output)
    const raw = Buffer.from(`: keepalive\r\n\r\ndata: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '观察红色' } }] })}\r\n\r\ndata: ${JSON.stringify({ choices: [{ delta: { content: content.slice(0, 15) } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: content.slice(15) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    for (const byte of raw) request.onChunk?.(Buffer.from([byte]), 'text/event-stream; charset=utf-8')
    assert.ok(chunks.join('').includes('观察红色'))
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, bytes: raw }
  } }
  const value = await new CompatibleVisionProvider(config, http).analyze(await input(), { ...bounds, onOutput: delta => chunks.push(delta.reasoning ?? delta.content ?? '') })
  assert.deepEqual(value, output)
  assert.ok(chunks.join('').includes('红色'))
})

test('accepts JSON from providers ignoring stream and exposes only returned reasoning', async () => {
  const deltas: string[] = []
  const http: HttpClient = { async request() { return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output), reasoning_content: '可见说明' }, finish_reason: 'stop' }] })) } } }
  assert.deepEqual(await new CompatibleVisionProvider(config, http).analyze(await input(), { ...bounds, onOutput: delta => deltas.push(delta.reasoning ?? '') }), output)
  assert.equal(deltas.join(''), '可见说明')
})

test('rejects incomplete streams and token truncation without replacing the paid request', async () => {
  for (const suffix of ['', `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`]) {
    let calls = 0
    const http: HttpClient = { async request(_url, request) {
      calls++
      const bytes = Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(output) } }] })}\n\n${suffix}`)
      request.onChunk?.(bytes, 'text/event-stream')
      return { status: 200, headers: { 'content-type': 'text/event-stream' }, bytes }
    } }
    await assert.rejects(new CompatibleVisionProvider(config, http).analyze(await input(), bounds), { code: suffix ? 'vision-output-truncated' : 'vision-invalid-output' })
    assert.equal(calls, 1)
  }
})

test('invalid stream encoding fails as non-retryable model output', async () => {
  const http: HttpClient = { async request(_url, request) {
    const bytes = Buffer.from([0xc0, 0x80])
    request.onChunk?.(bytes, 'text/event-stream')
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, bytes }
  } }
  await assert.rejects(new CompatibleVisionProvider(config, http).analyze(await input(), bounds), { code: 'vision-invalid-output', retryable: false })
})
