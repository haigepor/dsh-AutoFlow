import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createPreviewReads, type PreviewBytes } from '../src/host/preview-cache.ts'
import { resolveConfig } from '../src/host/config.ts'
import { serviceFixture } from './helpers/service-fixture.ts'

const image: PreviewBytes = { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' }

test('Host gallery resources admit only the configured number of unique previews while sharing identical URLs', async () => {
  const gates = Array.from({ length: 12 }, () => Promise.withResolvers<void>()), requested: string[] = []
  let active = 0, peak = 0
  let bytes: Buffer = Buffer.alloc(0)
  const settings = resolveConfig({ source: { provider: 'unsplash', unsplash: { previewConcurrency: 2 } } }).source
  const fixture = await serviceFixture(undefined, {}, { galleryMedia: { request: async location => {
    const index = Number(new URL(location).pathname.split('-').at(-1)); requested.push(location); active++; peak = Math.max(active, peak)
    try { await gates[index]!.promise; return { status: 200, headers: { 'content-type': 'image/png' }, bytes } } finally { active-- }
  } } }, { provider: settings.provider, unsplash: settings.unsplash })
  bytes = fixture.http.image
  try {
    await fixture.service.initialize()
    const reads = Array.from({ length: 24 }, (_, index) => fixture.service.resource(new Request(`http://localhost/api/visual-curator/resource?galleryUrl=${encodeURIComponent(`https://images.unsplash.com/synthetic-${index % 12}`)}`)))
    await setImmediate(); assert.equal(requested.length, 2)
    gates[0]!.resolve(); await setImmediate(); assert.equal(requested.length, 3, 'One completed source admits one new unique URL')
    gates.forEach(gate => gate.resolve())
    const responses = await Promise.all(reads)
    assert.ok(responses.every(response => response.status === 200)); assert.equal(peak, 2); assert.equal(requested.length, 12)
    for (const response of responses) assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  } finally { gates.forEach(gate => gate.resolve()); await fixture.cleanup() }
})

test('queued preview readers cancel independently and a fully cancelled URL never reaches the source', async () => {
  const gate = Promise.withResolvers<PreviewBytes>(), requests: string[] = []
  const reads = createPreviewReads(async location => { requests.push(location); return location === 'first' ? await gate.promise : image }, () => 1)
  try {
    const first = reads.read('first', new AbortController().signal), cancelled = new AbortController(), allCancelled = new AbortController()
    const one = assert.rejects(reads.read('shared', cancelled.signal), { name: 'AbortError' })
    const retained = reads.read('shared', new AbortController().signal)
    const dropped = assert.rejects(reads.read('never-start', allCancelled.signal), { name: 'AbortError' })
    cancelled.abort(); allCancelled.abort(); await one; await dropped
    await setImmediate(); assert.deepEqual(requests, ['first'])
    gate.resolve(image); await first; assert.deepEqual(await retained, image); assert.deepEqual(requests, ['first', 'shared'])
  } finally { gate.resolve(image); await reads.dispose() }
})

test('an aborted source keeps its slot until transport settles and disposal releases queued readers', async () => {
  const gate = Promise.withResolvers<PreviewBytes>(), requests: string[] = []
  const reads = createPreviewReads(async location => { requests.push(location); return requests.length === 1 ? await gate.promise : image }, () => 1)
  try {
    const controller = new AbortController(), first = assert.rejects(reads.read('shared', controller.signal), { name: 'AbortError' })
    await setImmediate(); controller.abort(); await first
    const replacement = reads.read('shared', new AbortController().signal)
    await setImmediate(); assert.equal(requests.length, 1, 'Cancellation alone cannot release a still-running transport slot')
    gate.resolve(image); assert.deepEqual(await replacement, image); assert.equal(requests.length, 2)
  } finally { gate.resolve(image); await reads.dispose() }

  const blocking = createPreviewReads(async (_location, signal) => await new Promise<PreviewBytes>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), () => 1)
  const active = assert.rejects(blocking.read('active', new AbortController().signal), { name: 'AbortError' })
  const queued = assert.rejects(blocking.read('queued', new AbortController().signal), { name: 'AbortError' })
  await setImmediate(); await blocking.dispose(); await active; await queued
})
