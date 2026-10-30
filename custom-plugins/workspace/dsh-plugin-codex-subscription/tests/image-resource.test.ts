/** Resource reads stop with their last holder and never submit or cancel generation. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createImageResource, imageSessionAddress } from '../src/client/resource.ts'

const snapshot = { version: 1, sessionId: 'one', pollIntervalMs: 250, tasks: [] }

test('a released resource aborts its pending wait without another read', async () => {
  const controller = new AbortController(); let reads = 0
  const stream = createImageResource(async sessionId => { assert.equal(sessionId, 'one'); reads++; return snapshot }).open(imageSessionAddress('one'), { signal: controller.signal })[Symbol.asyncIterator]()
  assert.equal((await stream.next()).value?.ok, true)
  const next = stream.next(); controller.abort()
  assert.equal((await next).done, true)
  assert.equal(reads, 1)
})

test('a mismatched Session or malformed address never publishes foreign images', async () => {
  const controller = new AbortController()
  const provider = createImageResource(async () => snapshot)
  const wrong = provider.open(imageSessionAddress('two'), { signal: controller.signal })[Symbol.asyncIterator]()
  assert.equal((await wrong.next()).value?.ok, false); controller.abort(); await wrong.next()
  const invalid = provider.open('dsh-resource://codex-images/bad', { signal: new AbortController().signal })[Symbol.asyncIterator]()
  assert.equal((await invalid.next()).value?.ok, false)
  assert.equal((await invalid.next()).done, true)
})

test('recovery republishes an identical value after an intervening failure', async () => {
  let reads = 0; const controller = new AbortController()
  const stream = createImageResource(async () => { if (++reads === 2) throw new Error('private carrier message'); return snapshot })
    .open(imageSessionAddress('one'), { signal: controller.signal })[Symbol.asyncIterator]()
  assert.equal((await stream.next()).value?.ok, true)
  const failure = (await stream.next()).value
  assert.equal(failure?.ok, false)
  assert.doesNotMatch(JSON.stringify(failure), /private carrier message/)
  assert.equal((await stream.next()).value?.ok, true)
  controller.abort(); await stream.next()
})
