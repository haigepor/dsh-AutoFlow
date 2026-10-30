/** First-event refusals may switch accounts; progress publication permanently disables replay. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { preflightResponse } from '../src/host/accounts/preflight.ts'

const signal = new AbortController().signal
const sse = (text: string) => new Response(text, { headers: { 'content-type': 'text/event-stream', 'retry-after-ms': '2500' } })

test('early typed stream errors become sanitized HTTP refusals', async () => {
  for (const type of ['error', 'response.failed']) {
    const error = { code: 'model_not_found', message: 'private-token', param: 'model' }
    const response = await preflightResponse(sse(`data: ${JSON.stringify({ type, ...(type === 'error' ? { error } : { response: { error } }) })}\n\n`), signal)
    assert.equal(response.status, 404); assert.equal(response.headers.get('retry-after-ms'), '2500')
    assert.deepEqual(await response.json(), { error: { code: 'model_not_found', param: 'model' } })
  }
})

test('a progress frame publishes immediately and preserves a later refusal without replay', async () => {
  const progress = 'data: {"type":"response.created","response":{"id":"r"}}\n\n'
  let output: ReadableStreamDefaultController<Uint8Array> | undefined, cancelled = false
  const response = await preflightResponse(new Response(new ReadableStream<Uint8Array>({ start(controller) { output = controller; controller.enqueue(new TextEncoder().encode(progress)) }, cancel() { cancelled = true } }), { headers: { 'content-type': 'text/event-stream' } }), signal)
  assert.equal(response.status, 200)
  const reader = response.body!.getReader(); assert.equal(new TextDecoder().decode((await reader.read()).value), progress)
  output!.enqueue(new TextEncoder().encode('data: {"type":"error","error":{"code":"rate_limit_exceeded"}}\n\n'))
  assert.match(new TextDecoder().decode((await reader.read()).value), /rate_limit_exceeded/)
  await reader.cancel(); assert.equal(cancelled, true)
})

test('bounded protocol metadata before a refusal does not commit model output', async () => {
  const prefix = 'data: {"type":"codex.rate_limits","rate_limits":{}}\n\n'
  const failure = 'data: {"type":"response.failed","response":{"error":{"code":"rate_limit_exceeded"}}}\n\n'
  const denied = await preflightResponse(sse(prefix + failure), signal)
  assert.equal(denied.status, 429)
  const success = prefix + 'data: {"type":"response.created","response":{"id":"r"}}\n\n'
  assert.equal(await (await preflightResponse(sse(success), signal)).text(), success)
})
