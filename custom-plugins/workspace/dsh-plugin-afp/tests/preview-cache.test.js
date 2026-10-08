import test from 'node:test'
import assert from 'node:assert/strict'
import { createPreviewCache } from '../src/client/afp-preview-cache.js'
import { createAfpGallery } from '../src/client/afp-workbench-gallery.js'
import { readFile } from 'node:fs/promises'

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const policy = { scope: 'scope-one', maxEntries: 3, maxBytes: 20, ttlMs: 100 }
function fixture(overrides = {}) {
  let time = 0, serial = 0
  const calls = [], created = [], revoked = []
  const cache = createPreviewCache({ now: () => time, createObjectURL: blob => { const url = `blob:${++serial}`; created.push({ url, size: blob.size }); return url },
    revokeObjectURL: url => revoked.push(url), load: (src, signal) => { const wait = deferred(); calls.push({ src, signal, ...wait }); return wait.promise }, ...overrides })
  cache.configure(policy)
  const blob = (size = 4) => new Blob([new Uint8Array(size)], { type: 'image/jpeg' })
  return { cache, calls, created, revoked, blob, advance: value => { time += value } }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('concurrent and later previews share bytes and leased URLs, releasing a URL only once', async () => {
  const { cache, calls, created, revoked, blob } = fixture()
  const one = cache.acquire('one'), two = cache.acquire('one')
  await tick(); assert.equal(calls.length, 1)
  calls[0].resolve(blob()); const [a, b] = await Promise.all([one, two])
  assert.equal(a.url, b.url); assert.equal(created.length, 1)
  a.release(); a.release(); assert.equal(revoked.length, 0)
  b.release(); assert.deepEqual(revoked, [a.url])
  const again = await cache.acquire('one'); assert.equal(calls.length, 1); assert.notEqual(again.url, a.url)
  again.release(); await cache.dispose()
  assert.equal(cache.stats().activeUrls, 0)
})

test('one consumer abort does not cancel another; the last pending consumer aborts upstream', async () => {
  const { cache, calls, blob } = fixture(), a = new AbortController(), b = new AbortController()
  const one = cache.acquire('one', a.signal), two = cache.acquire('one', b.signal)
  const rejected = assert.rejects(one, { name: 'AbortError' })
  await tick(); a.abort(); await rejected; assert.equal(calls[0].signal.aborted, false)
  calls[0].resolve(blob()); const lease = await two; b.abort(); assert.equal(cache.stats().activeUrls, 0)
  lease.release()
  const c = new AbortController(), last = cache.acquire('last', c.signal), cancelled = assert.rejects(last, { name: 'AbortError' })
  await tick(); c.abort(); await cancelled; assert.equal(calls[1].signal.aborted, true)
  calls[1].resolve(blob()); await tick(); assert.equal(cache.stats().entries, 1)
  await cache.dispose()
})

test('LRU and byte caps evict retained bytes without revoking active image leases', async () => {
  const { cache, calls, revoked, blob } = fixture()
  cache.configure({ ...policy, maxEntries: 2, maxBytes: 8 })
  const load = async key => { const next = cache.acquire(key); await tick(); calls.at(-1).resolve(blob()); return next }
  const a = await load('a'), b = await load('b')
  const hit = await cache.acquire('a'); hit.release()
  const c = await load('c'); assert.equal(cache.stats().entries, 2); assert.equal(cache.stats().bytes, 8)
  assert.equal(revoked.includes(b.url), false)
  b.release(); assert.equal(revoked.includes(b.url), true)
  const bAgain = await load('b'); assert.equal(calls.length, 4)
  a.release(); c.release(); bAgain.release(); await cache.dispose()
})

test('fixed TTL, oversized blobs and disabled retention cause fresh reads', async () => {
  const { cache, calls, blob, advance } = fixture()
  const load = async (key, size = 4) => { const next = cache.acquire(key); await tick(); calls.at(-1).resolve(blob(size)); return next }
  const first = await load('ttl'); first.release(); advance(90)
  const hit = await cache.acquire('ttl'); hit.release(); advance(10)
  const expired = await load('ttl'); expired.release(); assert.equal(calls.length, 2)
  const oversized = await load('big', 21); oversized.release(); assert.equal(cache.stats().bytes, 4)
  cache.configure({ ...policy, maxEntries: 0 })
  const disabled = await load('off'); disabled.release(); assert.equal(cache.stats().entries, 0)
  const again = await load('off'); again.release(); assert.equal(calls.length, 5)
  await cache.dispose()
})

test('failure and decoding invalidation permit retry without retiring another version', async () => {
  const { cache, calls, blob, revoked } = fixture()
  const failed = cache.acquire('photo'), failure = assert.rejects(failed, /failed/)
  await tick(); calls[0].reject(new Error('failed')); await failure
  const next = cache.acquire('photo'); await tick(); calls[1].resolve(blob()); const old = await next
  cache.invalidate('photo', old.url)
  const retry = cache.acquire('photo', undefined, { refresh: true }); await tick(); calls[2].resolve(blob()); const current = await retry
  cache.invalidate('photo', old.url)
  assert.equal(cache.stats().entries, 1); assert.equal(revoked.includes(old.url), false)
  const hit = await cache.acquire('photo'); assert.equal(hit.url, current.url)
  old.release(); hit.release(); current.release(); await cache.dispose()
})

test('clear and scope changes reject old consumers and prevent late completions from refilling', async () => {
  const { cache, calls, blob, revoked } = fixture()
  const visible = cache.acquire('visible'); await tick(); calls[0].resolve(blob()); const lease = await visible
  const stale = cache.acquire('stale'), rejected = assert.rejects(stale, { name: 'AbortError' }); await tick()
  cache.configure({ ...policy, scope: 'scope-two' }); await rejected
  assert.equal(calls[1].signal.aborted, true); assert.equal(revoked.includes(lease.url), true)
  const fresh = cache.acquire('stale'); await tick(); calls[1].resolve(blob()); calls[2].resolve(blob(5))
  const current = await fresh; assert.equal(cache.stats().bytes, 5)
  lease.release(); current.release(); await cache.dispose()
  assert.equal(new Set(revoked).size, revoked.length)
})

test('dispose waits for owned reads, rejects new reads and handles already-aborted consumers', async () => {
  const { cache, calls, blob } = fixture(), controller = new AbortController()
  controller.abort(); await assert.rejects(cache.acquire('abort', controller.signal), { name: 'AbortError' }); assert.equal(calls.length, 0)
  const pending = cache.acquire('pending'), rejected = assert.rejects(pending, { name: 'AbortError' }); await tick()
  let drained = false; const stopped = cache.dispose().then(() => { drained = true })
  await rejected; await tick(); assert.equal(drained, false)
  calls[0].resolve(blob()); await stopped; assert.equal(drained, true)
  await assert.rejects(cache.acquire('after'), { name: 'AbortError' })
  assert.equal(cache.stats().bytes, 0)
})

function nodes(tree, match) {
  if (Array.isArray(tree)) return tree.flatMap(item => nodes(item, match))
  if (!tree || typeof tree !== 'object') return []
  return [...(match(tree) ? [tree] : []), ...nodes(tree.props?.children, match)]
}
function component(store, UI, photo) {
  let cursor = 0
  const values = [], effects = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) { const slot = cursor++; if (!(slot in values)) values[slot] = initial; return [values[slot], value => { values[slot] = typeof value === 'function' ? value(values[slot]) : value }] },
    useRef() { const slot = cursor++; return values[slot] ??= { current: null } },
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useEffect(fn, deps) { const slot = cursor++; const old = effects[slot]; if (old && old.deps.every((item, index) => item === deps[index])) return; old?.cleanup?.(); effects[slot] = { fn, deps, pending: true } },
  }
  const Gallery = createAfpGallery(React, UI, {}, key => key, store)
  return {
    render(nextPhoto = photo) { cursor = 0; const tree = Gallery.ImagePreview({ photo: nextPhoto, large: true, retry: true }); for (const effect of effects) if (effect?.pending) { effect.pending = false; effect.cleanup = effect.fn() } return tree },
    unmount() { for (const effect of effects) effect?.cleanup?.() },
  }
}

test('transient previews recover automatically within one budget and unmount cancels pending recovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const originalDocument = globalThis.document
  globalThis.document = { baseURI: 'https://profile.test/', addEventListener() {}, removeEventListener() {} }
  const { cache, calls, blob } = fixture()
  const snapshot = { status: { features: ['read'], previewCache: { retryCount: 2, retryDelayMs: 1000 } }, previewGeneration: 0 }
  const store = { subscribe() {}, getSnapshot: () => snapshot, acquirePreview: (...args) => cache.acquire(...args), invalidatePreview: (...args) => cache.invalidate(...args) }
  const UI = { Button: Symbol('Button') }, photo = { id: 'photo', previewPath: 'api/afp/preview?photoId=photo' }
  const view = component(store, UI, photo), output = []
  const present = tree => ({ busy: nodes(tree, node => node.props?.['aria-busy'] === true).length > 0,
    retrying: nodes(tree, node => node.props?.className === 'afp-wb-preview-retrying').length > 0,
    error: nodes(tree, node => node.props?.className?.includes('afp-wb-image-fallback')).length > 0 })
  try {
    view.render(); await tick()
    calls[0].reject(Object.assign(new Error('temporary'), { retryable: true })); await tick()
    output.push(present(view.render()))
    t.mock.timers.tick(1000); view.render(); await tick(); assert.equal(calls.length, 2)
    calls[1].reject(Object.assign(new Error('temporary'), { retryable: true })); await tick()
    output.push(present(view.render()))
    t.mock.timers.tick(1999); view.render(); await tick(); assert.equal(calls.length, 2)
    t.mock.timers.tick(1); view.render(); await tick(); assert.equal(calls.length, 3)
    calls[2].reject(Object.assign(new Error('temporary'), { retryable: true })); await tick()
    const failed = view.render(); output.push(present(failed)); t.mock.timers.tick(10000); view.render(); await tick(); assert.equal(calls.length, 3)
    nodes(failed, node => node.type === UI.Button)[0].props.onClick({ stopPropagation() {} }); view.render(); await tick()
    calls[3].resolve(blob()); await tick(); const image = nodes(view.render(), node => node.type === 'img')[0]
    image.props.onError(); output.push(present(view.render()))
    view.unmount(); t.mock.timers.tick(10000); await tick(); assert.equal(calls.length, 4)
    assert.deepEqual(output, JSON.parse(await readFile(new URL('./fixtures/preview-recovery.json', import.meta.url), 'utf8')))
  } finally { view.unmount(); await cache.dispose(); globalThis.document = originalDocument }
})

test('preview recovery pauses on page hide, coalesces consumers and ignores permanent errors', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const originalDocument = globalThis.document, listeners = new Set()
  globalThis.document = { baseURI: 'https://profile.test/', hidden: false,
    addEventListener(_name, fn) { listeners.add(fn) }, removeEventListener(_name, fn) { listeners.delete(fn) } }
  const { cache, calls, blob } = fixture()
  const snapshot = { status: { features: ['read'], previewCache: { retryCount: 2, retryDelayMs: 1000 } }, previewGeneration: 0 }
  const store = { subscribe() {}, getSnapshot: () => snapshot, acquirePreview: (...args) => cache.acquire(...args), invalidatePreview: (...args) => cache.invalidate(...args) }
  const photo = { id: 'photo', previewPath: 'api/afp/preview?photoId=photo' }, UI = { Button: Symbol('Button') }
  const a = component(store, UI, photo), b = component(store, UI, photo)
  try {
    a.render(); b.render(); await tick(); assert.equal(calls.length, 1)
    calls[0].reject(Object.assign(new Error('temporary'), { retryable: true })); await tick(); a.render(); b.render()
    globalThis.document.hidden = true; for (const fn of listeners) fn()
    t.mock.timers.tick(10000); a.render(); b.render(); await tick(); assert.equal(calls.length, 1)
    globalThis.document.hidden = false; for (const fn of listeners) fn()
    t.mock.timers.tick(1000); a.render(); b.render(); await tick(); assert.equal(calls.length, 2)
    calls[1].resolve(blob()); await tick()
    const imageA = nodes(a.render(), n => n.type === 'img')[0], imageB = nodes(b.render(), n => n.type === 'img')[0]
    assert.equal(imageA.props.src, imageB.props.src); imageA.props.onLoad(); imageB.props.onLoad(); a.render(); b.render()
    a.unmount(); b.unmount(); assert.equal(listeners.size, 0)
    const c = component(store, UI, { id: 'blocked', previewPath: 'api/afp/preview?photoId=blocked' })
    c.render(); await tick(); calls[2].reject(Object.assign(new Error('denied'), { retryable: false })); await tick()
    assert.equal(nodes(c.render(), n => n.props?.className?.includes('afp-wb-image-fallback')).length, 1)
    t.mock.timers.tick(10000); c.render(); await tick(); assert.equal(calls.length, 3); c.unmount()
  } finally { a.unmount(); b.unmount(); await cache.dispose(); globalThis.document = originalDocument }
})

test('a changed photo cancels its delayed recovery without allowing the stale request to replace it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const originalDocument = globalThis.document
  globalThis.document = { baseURI: 'https://profile.test/', addEventListener() {}, removeEventListener() {} }
  const { cache, calls, blob } = fixture()
  const snapshot = { status: { features: ['read'], previewCache: { retryCount: 2, retryDelayMs: 1000 } }, previewGeneration: 0 }
  const store = { subscribe() {}, getSnapshot: () => snapshot, acquirePreview: (...args) => cache.acquire(...args), invalidatePreview: (...args) => cache.invalidate(...args) }
  const old = { id: 'old', previewPath: 'api/afp/preview?photoId=old' }, next = { id: 'next', previewPath: 'api/afp/preview?photoId=next' }
  const view = component(store, { Button: Symbol('Button') }, old)
  try {
    view.render(); await tick(); calls[0].reject(Object.assign(new Error('temporary'), { retryable: true })); await tick(); view.render()
    view.render(next); await tick(); calls[1].resolve(blob()); await tick(); view.render(next)
    t.mock.timers.tick(10000); view.render(next); await tick(); assert.equal(calls.length, 2)
    assert.ok(calls[1].src.endsWith('photoId=next'))
  } finally { view.unmount(); await cache.dispose(); globalThis.document = originalDocument }
})

test('gallery previews share cache leases, preserve loading states and fetch again after decode retry', async () => {
  const originalDocument = globalThis.document
  globalThis.document = { baseURI: 'https://profile.test/' }
  const { cache, calls, blob, revoked } = fixture()
  const snapshot = { status: { features: ['read'] }, previewGeneration: 0 }, UI = { Button: Symbol('Button') }
  const store = { subscribe() {}, getSnapshot: () => snapshot, acquirePreview: (...args) => cache.acquire(...args), invalidatePreview: (...args) => cache.invalidate(...args) }
  const photo = { id: 'photo', previewPath: 'api/afp/preview?photoId=photo', title: 'Sample' }
  const a = component(store, UI, photo), b = component(store, UI, photo)
  const present = tree => ({ loading: nodes(tree, node => node.props?.['aria-busy'] === true).length > 0,
    visibleLoader: nodes(tree, node => node.type?.name === 'PreviewLoading').length > 0,
    image: nodes(tree, node => node.type === 'img').length > 0, error: nodes(tree, node => node.props?.className?.includes('afp-wb-image-fallback')).length > 0 })
  try {
    const initial = a.render()
    assert.equal(nodes(initial, node => node.type?.name === 'PreviewLoading').length, 1)
    assert.equal(nodes(initial, node => node.type?.name === 'PreviewLoading')[0].props.label, 'loading')
    const output = [present(initial)]; b.render(); await tick(); assert.equal(calls.length, 1)
    calls[0].resolve(blob()); await tick(); const first = a.render(), second = b.render()
    const oldImage = nodes(first, node => node.type === 'img')[0]
    assert.equal(nodes(first, node => node.type?.name === 'PreviewLoading').length, 1, 'Loading indicator remains while browser decodes the fetched raster')
    assert.equal(oldImage.props.src, nodes(second, node => node.type === 'img')[0].props.src)
    output.push(present(first)); oldImage.props.onLoad(); output.push(present(a.render()))
    assert.equal(nodes(a.render(), node => node.type?.name === 'PreviewLoading').length, 0)
    oldImage.props.onError(); output.push(present(a.render())); assert.equal(cache.stats().entries, 0)
    b.unmount(); assert.equal(revoked.length, 1)
    nodes(a.render(), node => node.type === UI.Button)[0].props.onClick({ stopPropagation() {} })
    a.render(); output.push(present(a.render())); await tick(); assert.equal(calls.length, 2); assert.equal(revoked.length, 1)
    calls[1].resolve(blob()); await tick(); const current = a.render()
    oldImage.props.onLoad(); oldImage.props.onError(); assert.deepEqual(present(a.render()), present(current))
    assert.equal(cache.stats().entries, 1)
    nodes(current, node => node.type === 'img')[0].props.onLoad(); output.push(present(a.render()))
    const expected = JSON.parse(await readFile(new URL('./fixtures/preview-cache.json', import.meta.url), 'utf8'))
    assert.deepEqual(output, expected)
    a.unmount(); b.unmount(); assert.equal(cache.stats().activeUrls, 0)
  } finally { a.unmount(); b.unmount(); await cache.dispose(); globalThis.document = originalDocument }
})
