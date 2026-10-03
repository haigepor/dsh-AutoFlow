/** Offline request-count benchmark using the shipped raster loader and cache; no AFP purchases or network access. */
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { readPreviewMedia } from '../src/client/afp-preview-media.js'
import { createPreviewCache } from '../src/client/afp-preview-cache.js'

const src = 'https://offline.test/api/afp/preview?photoId=sample', consumers = 6
let requests = 0
const fetchImpl = async (_url, { signal }) => {
  requests++; await delay(40, undefined, { signal })
  return new Response(new Uint8Array([255, 216, 255, 0]), { headers: { 'content-type': 'image/jpeg' } })
}
const load = (url, signal) => readPreviewMedia(url, signal, fetchImpl)
const rows = []
let start = performance.now()
for (let index = 0; index < consumers; index++) await load(src, new AbortController().signal)
rows.push({ scenario: 'uncached-sequential', consumers, requests, elapsedMs: Math.round(performance.now() - start) })
assert.equal(requests, consumers)
for (const concurrent of [false, true]) {
  requests = 0
  const cache = createPreviewCache({ load })
  cache.configure({ scope: 'offline', maxEntries: 300, maxBytes: 67108864, ttlMs: 600000 })
  start = performance.now()
  const use = async () => { const lease = await cache.acquire(src); lease.release() }
  if (concurrent) await Promise.all(Array.from({ length: consumers }, use))
  else for (let index = 0; index < consumers; index++) await use()
  rows.push({ scenario: concurrent ? 'cached-concurrent' : 'cached-sequential', consumers, requests, elapsedMs: Math.round(performance.now() - start) })
  assert.equal(requests, 1); await cache.dispose()
}
console.log(JSON.stringify({ transport: 'simulated-40ms', rows }, null, 2))
