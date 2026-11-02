import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPreviewReads, remotePreviewLocation, type PreviewBytes } from '../src/host/preview-cache.ts'
import { remoteImageSourceSchema } from '../src/shared/gallery.ts'

const value: PreviewBytes = { bytes: new Uint8Array([1, 2, 3]), mime: 'image/jpeg' }

test('legacy grid previews use a small public representation while saved identity and full review URLs remain unchanged', () => {
  const url = 'https://images.unsplash.com/photo-1?w=1080&h=1200&dpr=2&q=80'
  const source = remoteImageSourceSchema.parse({ providerId: 'unsplash', photoId: 'photo-1', accountId: 'fixture', url, thumbnailUrl: url })
  const before = structuredClone(source), small = new URL(remotePreviewLocation(source, true))
  assert.equal(small.hostname, 'images.unsplash.com'); assert.equal(small.searchParams.get('w'), '400'); assert.equal(small.searchParams.get('dpr'), '1')
  assert.equal(small.searchParams.has('h'), false); assert.equal(small.searchParams.get('q'), '80')
  assert.equal(remotePreviewLocation(source, false), url); assert.deepEqual(source, before)
  const independent = { ...source, thumbnailUrl: 'https://images.unsplash.com/photo-1?w=240' }
  assert.equal(remotePreviewLocation(independent, true), independent.thumbnailUrl)
  assert.equal(new URL(remotePreviewLocation({ ...source, url: independent.thumbnailUrl, thumbnailUrl: independent.thumbnailUrl }, true)).searchParams.get('w'), '240')
  const premium = { ...source, url: 'https://plus.unsplash.com/photo-1?w=1080', thumbnailUrl: 'https://plus.unsplash.com/photo-1?w=1080' }
  assert.equal(remotePreviewLocation(premium, true), premium.thumbnailUrl)
})

test('concurrent authorized preview readers share one fetch and receive independent bytes', async () => {
  const gate = Promise.withResolvers<PreviewBytes>(), requests: string[] = []
  const cache = createPreviewReads(async location => { requests.push(location); return await gate.promise }, () => 2)
  try {
    const readers = Array.from({ length: 6 }, () => cache.read('https://images.unsplash.com/same?w=400', new AbortController().signal))
    await Promise.resolve(); assert.equal(requests.length, 1)
    gate.resolve(value)
    const loaded = await Promise.all(readers)
    loaded[0]!.bytes[0] = 9
    assert.equal(loaded[1]!.bytes[0], 1)
    await cache.read('https://images.unsplash.com/same?w=400', new AbortController().signal)
    assert.equal(requests.length, 2, 'completed response storage belongs to browser caching, not another Host cache')
  } finally { gate.resolve(value); await cache.dispose() }
})

test('cancelling one preview reader leaves the shared fetch available to another', async () => {
  const gate = Promise.withResolvers<PreviewBytes>(), signals: AbortSignal[] = []
  const cache = createPreviewReads(async (_location, signal) => { signals.push(signal); return await gate.promise }, () => 2)
  try {
    const first = new AbortController(), other = new AbortController()
    const cancelled = assert.rejects(cache.read('shared', first.signal), { name: 'AbortError' })
    const retained = cache.read('shared', other.signal)
    await Promise.resolve(); first.abort(); await cancelled
    assert.equal(signals[0]!.aborted, false)
    gate.resolve(value); assert.deepEqual(await retained, value)
  } finally { gate.resolve(value); await cache.dispose() }
})

test('the last detached reader cancels transport and a later read starts independently', async () => {
  let requests = 0, firstSignal: AbortSignal | undefined
  const cache = createPreviewReads(async (_location, signal) => {
    if (++requests > 1) return value
    firstSignal = signal
    return await new Promise<PreviewBytes>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }, () => 2)
  try {
    const controller = new AbortController(), cancelled = assert.rejects(cache.read('shared', controller.signal), { name: 'AbortError' })
    await Promise.resolve(); controller.abort(); await cancelled
    assert.equal(firstSignal?.aborted, true)
    assert.deepEqual(await cache.read('shared', new AbortController().signal), value)
    assert.equal(requests, 2)
  } finally { await cache.dispose() }
})

test('different representations do not merge and failed fetches remain retryable', async () => {
  const requests: string[] = []
  const cache = createPreviewReads(async location => {
    requests.push(location)
    if (location === 'failed' && requests.filter(item => item === 'failed').length === 1) throw new Error('Temporary media failure')
    return value
  }, () => 2)
  try {
    await Promise.all([cache.read('https://images.unsplash.com/photo?w=400', new AbortController().signal), cache.read('https://images.unsplash.com/photo?w=1080', new AbortController().signal)])
    assert.equal(requests.length, 2)
    await assert.rejects(cache.read('failed', new AbortController().signal), /Temporary media failure/)
    assert.deepEqual(await cache.read('failed', new AbortController().signal), value)
  } finally { await cache.dispose() }
})

test('disposing preview reads cancels pending callers and admits no later work', async () => {
  const cache = createPreviewReads(async (_location, signal) => await new Promise<PreviewBytes>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), () => 2)
  const pending = assert.rejects(cache.read('shared', new AbortController().signal), { name: 'AbortError' })
  await Promise.resolve(); await cache.dispose(); await pending
  await assert.rejects(cache.read('shared', new AbortController().signal), { name: 'AbortError' })
})
