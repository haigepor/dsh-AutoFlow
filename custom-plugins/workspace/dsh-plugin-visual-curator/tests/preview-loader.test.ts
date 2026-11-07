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

test('consumers of the same Blob share its live URL while retaining independent cancellation and release', async () => {
  const f = fixture(), first = new AbortController(), second = new AbortController(), third = new AbortController()
  const a = f.loader.load('shared', first.signal), b = f.loader.load('shared', second.signal), settled = Promise.allSettled([a, b])
  try {
    await turn(); assert.equal(f.calls.length, 1); f.finish(0)
    const [left, right] = await Promise.all([a, b])
    assert.notEqual(left, right); assert.equal(left.url, right.url)
    left.release(); left.release(); first.abort(); assert.deepEqual(f.revoked, [])
    const cached = await f.loader.load('shared', third.signal)
    assert.equal(cached.url, right.url); assert.equal(f.calls.length, 1)
    second.abort(); assert.deepEqual(f.revoked, [])
    cached.release(); assert.deepEqual(f.revoked, [right.url])
    const reopened = await f.loader.load('shared', new AbortController().signal)
    assert.notEqual(reopened.url, right.url); assert.equal(f.calls.length, 1)
    reopened.release(); assert.equal(f.revoked.length, 2)
  } finally { first.abort(); second.abort(); third.abort(); await f.loader.dispose(); await settled }
})

test('an immediate same-source reload with caching disabled cannot join an already delivered job', async () => {
  const f = fixture(1), first = new AbortController(), second = new AbortController()
  f.loader.configure(1, { ttlMs: 0, maxEntries: 0, maxBytes: 1024 })
  const pending = [f.loader.load('uncached', first.signal)]
  try {
    await turn(); f.finish(0); (await pending[0]!).release()
    pending.push(f.loader.load('uncached', second.signal))
    await turn(); assert.equal(f.calls.length, 2)
    f.finish(1); (await pending[1]!).release()
  } finally { const settled = Promise.allSettled(pending); first.abort(); second.abort(); await f.loader.dispose(); await settled }
})

test('an immediate retry retains the original failure and starts a new request after delivery', async () => {
  const f = fixture(1), first = new AbortController(), second = new AbortController()
  const initial = f.loader.load('retry', first.signal), retried = initial.catch(() => f.loader.load('retry', second.signal)), settled = Promise.allSettled([initial, retried])
  try {
    await turn(); f.finish(0, 503)
    await turn(); assert.equal(f.calls.length, 2)
    f.finish(1); (await retried).release()
    assert.equal((await settled)[0]!.status, 'rejected')
  } finally { first.abort(); second.abort(); await f.loader.dispose(); await settled }
})

test('10 and 20 previews across three views release every URL through six activation cycles', async context => {
  for (const count of [10, 20]) {
    const live = new Set<string>()
    let created = 0, revoked = 0, requests = 0, peak = 0, active = 0, networkPeak = 0
    const loader = createPreviewLoader({ concurrency: 2, createObjectURL: () => { const url = `blob:scale-${++created}`; live.add(url); peak = Math.max(peak, live.size); return url }, revokeObjectURL: url => { assert.ok(live.delete(url)); revoked++ }, fetch: async () => {
      requests++; active++; networkPeak = Math.max(networkPeak, active)
      try { await turn(); return new Response(new Blob(['synthetic preview'], { type: 'image/png' })) } finally { active-- }
    } })
    let controls: AbortController[] = []
    try {
      for (let cycle = 0; cycle < 6; cycle++) {
        loader.configure(2, { ttlMs: 300000, maxEntries: 96, maxBytes: 64 * 1024 * 1024 }, cycle)
        controls = Array.from({ length: count * 3 }, () => new AbortController())
        const loaded = await Promise.all(controls.map((control, index) => loader.load(`synthetic-${index % count}`, control.signal)))
        assert.equal(new Set(loaded.map(lease => lease.url)).size, count)
        assert.equal(live.size, count)
        controls.slice(0, count).forEach(control => control.abort())
        assert.equal(live.size, count, 'Other mounted views retain their shared URLs')
        assert.ok(live.has(loaded[count]!.url))
        controls.slice(count).forEach(control => control.abort())
        await loader.dispose(); assert.equal(live.size, 0); assert.equal(active, 0)
      }
      assert.equal(requests, count * 6); assert.equal(created, count * 6); assert.equal(revoked, created); assert.equal(networkPeak, 2)
      context.diagnostic(JSON.stringify({ images: count, views: 3, cycles: 6, createdUrls: created, revokedUrls: revoked, peakUrls: peak, fetches: requests, networkPeak, retainedUrls: live.size }))
    } finally { controls.forEach(control => control.abort()); await loader.dispose() }
  }
})

test('cancelling 10 and 20 queued previews drains active reads and discards late image bodies', async context => {
  for (const count of [10, 20]) {
    const calls: { signal: AbortSignal; response: ReturnType<typeof Promise.withResolvers<Response>> }[] = []
    let created = 0
    const loader = createPreviewLoader({ concurrency: 2, createObjectURL: () => { created++; return 'unexpected-url' }, revokeObjectURL() {}, fetch: async (_input, init) => {
      assert.ok(init?.signal); const response = Promise.withResolvers<Response>(); calls.push({ signal: init.signal, response }); return await response.promise
    } })
    let controls: AbortController[] = []
    try {
      for (let cycle = 0; cycle < 6; cycle++) {
        loader.configure(2, undefined, cycle)
        controls = Array.from({ length: count }, () => new AbortController())
        const pending = controls.map((control, index) => loader.load(`cancel-${cycle}-${index}`, control.signal)), settled = Promise.allSettled(pending)
        await turn(); assert.equal(calls.length, (cycle + 1) * 2)
        controls.forEach(control => control.abort())
        const closing = loader.dispose()
        for (const call of calls.slice(cycle * 2)) { assert.equal(call.signal.aborted, true); call.response.resolve(new Response(new Blob(['late synthetic image']))) }
        await closing; assert.ok((await settled).every(result => result.status === 'rejected')); assert.equal(created, 0)
      }
      context.diagnostic(JSON.stringify({ cancelledImages: count, cycles: 6, startedReads: calls.length, queuedReadsDispatched: 0, createdUrls: created }))
    } finally { controls.forEach(control => control.abort()); for (const call of calls) call.response.resolve(new Response()); await loader.dispose() }
  }
})
