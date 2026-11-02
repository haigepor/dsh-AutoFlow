import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as turn } from 'node:timers/promises'
import { createPreviewLoader, resolvePreviewConcurrency } from '../src/client/preview-loader.ts'
import { resolveConfig } from '../src/host/config.ts'

function fixture(concurrency = 2) {
  const calls: { src: string; signal: AbortSignal; response: ReturnType<typeof Promise.withResolvers<Response>> }[] = [], revoked: string[] = []
  let nextUrl = 0
  const loader = createPreviewLoader({ concurrency, createObjectURL: () => `blob:preview-${++nextUrl}`, revokeObjectURL: url => revoked.push(url), fetch: async (input, init) => {
    assert.ok(init?.signal)
    const response = Promise.withResolvers<Response>(), signal = init.signal
    calls.push({ src: String(input), signal, response })
    const abort = () => response.reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    try { return await response.promise } finally { signal.removeEventListener('abort', abort) }
  } })
  const finish = (index: number, status = 200) => calls[index]!.response.resolve(new Response(new Blob(['raster fixture'], { type: 'image/jpeg' }), { status }))
  return { loader, calls, revoked, finish }
}

test('preview slots reserve a separate bounded UI lane and reject invalid deployment concurrency', () => {
  assert.equal(resolvePreviewConcurrency(undefined), 2)
  assert.equal(resolveConfig({}).source.unsplash.previewConcurrency, 2)
  for (const value of [1, 2, 4]) assert.equal(resolveConfig({ source: { unsplash: { previewConcurrency: value } } }).source.unsplash.previewConcurrency, value)
  for (const value of [0, 5, 1.5]) assert.throws(() => resolveConfig({ source: { unsplash: { previewConcurrency: value } } }))
})

test('six images start only two fetches and a completed image admits one continuation', async () => {
  const f = fixture(), controllers = Array.from({ length: 6 }, () => new AbortController())
  const loads = controllers.map((controller, index) => f.loader.load(`image-${index}`, controller.signal)), settled = Promise.allSettled(loads)
  try {
    await turn(); assert.equal(f.calls.length, 2)
    f.finish(0); const first = await loads[0]!
    await turn(); assert.equal(f.calls.length, 3); assert.equal(f.calls[2]!.src, 'image-2')
    first.release(); first.release(); assert.deepEqual(f.revoked, ['blob:preview-1'])
  } finally { for (const controller of controllers) controller.abort(); await f.loader.dispose(); await settled }
})

test('leaving before an image starts removes it from the queue without a request', async () => {
  const f = fixture(1), first = new AbortController(), hidden = new AbortController(), next = new AbortController()
  const a = f.loader.load('visible', first.signal), b = f.loader.load('hidden', hidden.signal), c = f.loader.load('next', next.signal), settled = Promise.allSettled([a, b, c])
  try {
    await turn(); hidden.abort(); f.finish(0)
    const displayed = await a; displayed.release()
    await turn(); assert.deepEqual(f.calls.map(call => call.src), ['visible', 'next'])
    f.finish(1); (await c).release()
    assert.equal((await settled)[1]!.status, 'rejected')
  } finally { first.abort(); next.abort(); await f.loader.dispose() }
})

test('leaving during download aborts the transport and finished image leases follow cancellation', async () => {
  const f = fixture(1), leaving = new AbortController(), retained = new AbortController()
  const first = f.loader.load('leaving', leaving.signal), second = f.loader.load('retained', retained.signal), settled = Promise.allSettled([first, second])
  try {
    await turn(); leaving.abort(); await turn()
    assert.equal(f.calls[0]!.signal.aborted, true); assert.equal(f.calls[1]!.src, 'retained')
    f.finish(1); await second
    retained.abort(); assert.deepEqual(f.revoked, ['blob:preview-1'])
  } finally { await f.loader.dispose(); await settled }
})

test('failed images release their slot and disposal can be followed by a new entry activation', async () => {
  const f = fixture(1), signal = new AbortController().signal
  const failed = assert.rejects(f.loader.load('bad', signal), /Preview media unavailable/), next = f.loader.load('good', signal)
  try {
    await turn(); f.finish(0, 503); await failed; await turn(); f.finish(1)
    const image = await next
    await f.loader.dispose(); assert.deepEqual(f.revoked, [image.url])
    await assert.rejects(f.loader.load('disabled', signal), { name: 'AbortError' })
    f.loader.configure(2)
    const reopened = f.loader.load('reopened', signal)
    await turn(); f.finish(2); (await reopened).release()
    assert.deepEqual(f.calls.map(call => call.src), ['bad', 'good', 'reopened'])
  } finally { await f.loader.dispose() }
})
