/** Quota observation must preserve every SSE byte and stop inspecting bounded metadata. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { observeCodexQuota } from '../src/host/codex-quota.ts'
import type { AccountUsage } from '../src/host/accounts/types.ts'

const event = (metered = '') => `data: ${JSON.stringify({ type: 'codex.rate_limits', metered_limit_name: metered, rate_limits: { primary: { used_percent: 100, window_minutes: 300, reset_after_seconds: 30 } } })}\n\n`

test('split SSE metadata updates account quota while preserving exact UTF-8 bytes', async () => {
  const bytes = Buffer.from(event('image_model') + event() + 'data: {"type":"response.output_text.delta","delta":"你好"}\n\n')
  const seen: Pick<AccountUsage, 'primary' | 'secondary'>[] = []
  let offset = 0
  const original = new Response(new ReadableStream<Uint8Array>({ pull(output) {
    if (offset === bytes.length) { output.close(); return }
    output.enqueue(bytes.subarray(offset, offset + 1)); offset++
  } }), { headers: { 'content-type': 'text/event-stream', 'x-codex-secondary-used-percent': '20', 'x-codex-secondary-window-minutes': '10080' } })
  const observed = observeCodexQuota(original, 1000, windows => seen.push(windows))
  assert.deepEqual(Buffer.from(await observed.arrayBuffer()), bytes)
  assert.equal(seen.length, 2)
  assert.equal(seen[0]?.secondary?.usedPercent, 20)
  assert.equal(seen[1]?.primary?.resetAt, 31000)
  assert.equal(seen[1]?.primary?.windowSeconds, 18000)
})

test('SSE inspection stops after its bounded prelude and cancellation reaches the original reader', async () => {
  const data = ':' + 'x'.repeat(65536) + '\n\n' + event()
  let noted = 0
  const observed = observeCodexQuota(new Response(data, { headers: { 'content-type': 'text/event-stream' } }), 1000, () => { noted++ })
  assert.equal(await observed.text(), data)
  assert.equal(noted, 0)
  let cancelled = false
  const original = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }), { headers: { 'content-type': 'text/event-stream' } })
  const waiting = observeCodexQuota(original, 1000, () => { throw new Error('unused') })
  await waiting.body!.cancel()
  assert.equal(cancelled, true)
  assert.equal(original.body?.locked, false)
})
