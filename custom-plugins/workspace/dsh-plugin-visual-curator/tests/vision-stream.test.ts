import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { CompatibleVisionProvider } from '../src/media/vision.ts'
import { VisionStream } from '../src/media/vision-stream.ts'
import type { HttpClient } from '../src/media/network.ts'

const config = { endpoint: 'https://vision.example.test/chat/completions', model: 'stream-fixture', supportsMultiImage: true, supportsStreaming: true, maxImages: 1, maxImageBytes: 65536, maxRequestBytes: 100000, maxOutputTokens: 2048, temperature: 0 }
const bounds = { maxBytes: 65536, timeoutMs: 1000, maxRedirects: 0 }
async function input() {
  const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } }).png().toBuffer()
  return { requestId: 'stream-request', taskBrief: 'Observe pixels', rules: [], images: [{ imageVersionId: 'image-one', bytes, digest: createHash('sha256').update(bytes).digest('hex'), mime: 'image/png', role: 'positive' }] }
}
const output = { observations: [{ imageVersionId: 'image-one', dimensions: [{ dimension: 'color', observation: '红色', uncertain: false }] }], suggestedRules: [] }

test('stream transport failures retain exact diagnostics and retry only recoverable errors', () => {
  const incomplete = new VisionStream()
  assert.throws(() => incomplete.finish(Buffer.from('data: {"choices":[]}\n\n')), error => error instanceof Error && 'retryable' in error && error.retryable === true && 'diagnostics' in error && JSON.stringify(error.diagnostics).includes('incomplete-stream'))
  const invalidFields = new VisionStream()
  assert.throws(() => invalidFields.push(Buffer.from('data: {"unexpected":"frame"}\n\n')), error => error instanceof Error && 'diagnostics' in error && JSON.stringify(error.diagnostics).includes('invalid-event-fields'))
  for (const [code, retryable] of [['server_error', true], ['invalid_api_key', false]] as const) {
    const failed = new VisionStream()
    assert.throws(() => failed.push(Buffer.from(`data: ${JSON.stringify({ error: { code } })}\n\n`)), error => error instanceof Error && 'code' in error && error.code === 'remote-request-failed' && 'retryable' in error && error.retryable === retryable)
  }
})

test('retains observations with omitted uncertainty as uncertain and diagnoses invalid fields', async () => {
  let row: Record<string, unknown> = { dimension: 'color', observation: '红色' }
  const http: HttpClient = { async request() { return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ observations: [{ imageVersionId: 'image-one', dimensions: [row] }], suggestedRules: [] }) }, finish_reason: 'stop' }] })) } } }
  const provider = new CompatibleVisionProvider(config, http)
  const actual = await provider.analyze(await input(), bounds)
  assert.equal(actual.observations[0]?.dimensions[0]?.uncertain, true)
  row = { ...row, uncertain: 'false' }
  await assert.rejects(provider.analyze(await input(), bounds), error => error instanceof Error && 'diagnostics' in error && JSON.stringify(error.diagnostics).includes('observations.0.dimensions.0.uncertain'))
})

test('keeps the output schema and stable instructions ahead of changing image and request identities', async () => {
  const original = await input(), provider = new CompatibleVisionProvider(config, { async request() { throw new Error('Description must not call the provider') } })
  const first = provider.describeRequest(original, 'analyze')
  const next = provider.describeRequest({ ...original, requestId: 'another-request', images: original.images.map(image => ({ ...image, imageVersionId: 'image-two' })) }, 'analyze')
  let common = 0
  while (first.inputText[common] === next.inputText[common] && common < first.inputText.length) common++
  assert.ok(common > 1000)
  assert.ok(first.inputText.indexOf('outputSchema') < first.inputText.indexOf('"input"'))
  assert.ok(first.inputText.lastIndexOf('"requestId"') > first.inputText.lastIndexOf('"images"'))
})

test('accepts one complete JSON fence but rejects surrounding prose and invalid dimension identifiers', async () => {
  let text = `\`\`\`json\n${JSON.stringify(output)}\n\`\`\``
  const http: HttpClient = { async request() { return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] })) } } }
  const provider = new CompatibleVisionProvider(config, http)
  assert.deepEqual(await provider.analyze(await input(), bounds), output)
  text = `Explanation before JSON\n${text}`
  await assert.rejects(provider.analyze(await input(), bounds), { code: 'vision-invalid-output' })
  text = JSON.stringify({ ...output, observations: [{ ...output.observations[0], dimensions: [{ dimension: '色彩与饱和度', observation: '红色', uncertain: false }] }] })
  await assert.rejects(provider.analyze(await input(), bounds), { code: 'vision-invalid-output' })
})

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

test('reasoning-only token exhaustion reports truncation without accepting an empty observation or retrying', async () => {
  let calls = 0
  const http: HttpClient = { async request(_url, request) {
    calls++
    const bytes = Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'The output budget was spent on reasoning.' } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`)
    request.onChunk?.(bytes, 'text/event-stream')
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, bytes }
  } }
  await assert.rejects(new CompatibleVisionProvider(config, http).analyze(await input(), bounds), { code: 'vision-output-truncated' })
  assert.equal(calls, 1)
})

test('invalid stream encoding fails as non-retryable model output', async () => {
  const http: HttpClient = { async request(_url, request) {
    const bytes = Buffer.from([0xc0, 0x80])
    request.onChunk?.(bytes, 'text/event-stream')
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, bytes }
  } }
  await assert.rejects(new CompatibleVisionProvider(config, http).analyze(await input(), bounds), { code: 'vision-invalid-output', retryable: false })
})

test('JSON fallback retains paid partial output before reporting token exhaustion', async () => {
  let calls = 0
  const received: { content?: string; reasoning?: string }[] = []
  const http: HttpClient = { async request() {
    calls++
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: '{"observations":[', reasoning_content: '接口已返回的推理' }, finish_reason: 'length' }] })) }
  } }
  await assert.rejects(new CompatibleVisionProvider(config, http).analyze(await input(), { ...bounds, onOutput: delta => received.push(delta) }), { code: 'vision-output-truncated' })
  assert.equal(calls, 1)
  assert.deepEqual(received, [{ content: '{"observations":[', reasoning: '接口已返回的推理' }])
})
