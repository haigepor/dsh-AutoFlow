import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../config-schema.js'
import { reservedIds } from '../src/host/afp-refresh-workflow.js'
import { createAfpApiClient } from '../src/vendor/auto-afp-img/afp-api-client.mjs'

function fixture(config = resolveConfig(), { chunked = false } = {}) {
  const pending = new Map(), requested = [], cancelled = []
  let released = false, ready
  const entered = new Promise(resolve => { ready = resolve })
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: `collection-${i}`, name: `Synthetic ${i}`,
    docsCount: i === 9 ? 0 : 2048, isPrivate: i % 2 === 0 }))
  const client = createAfpApiClient({ accessToken: 'fixture-only', retries: 0, maxResponseBytes: config.maxResponseBytes,
    fetchImpl: async url => {
      if (url.includes('/byuser')) return Response.json([...rows, { id: 'directory', name: '' }])
      const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1))
      requested.push(id)
      const row = rows.find(row => row.id === id)
      const bytes = new TextEncoder().encode(JSON.stringify({ docs: Array.from({ length: row.docsCount }, (_, i) => ({
        id: i === 0 ? 'common-photo' : `${id}-photo-${i}`, caption: id === 'collection-0' ? '合成说明'.repeat(64) : 'Synthetic',
      })) }))
      const body = new ReadableStream({
        start(controller) {
          const send = () => {
            pending.delete(id)
            // 跨分块的 UTF-8 字符必须完整保留；最大收藏夹响应超过 1 MiB。
            for (let offset = 0; offset < bytes.length; offset += 65533) controller.enqueue(bytes.subarray(offset, offset + 65533))
            controller.close()
          }
          if (released) send()
          else pending.set(id, send)
        },
        cancel() { pending.delete(id); cancelled.push(id) },
      })
      if (requested.length === Math.min(4, config.collectionConcurrency)) ready()
      return new Response(body, { headers: { 'content-type': 'application/json', ...(!chunked ? { 'content-length': String(bytes.length) } : {}) } })
    } })
  return { client, entered, pending, requested, cancelled, config,
    release() { released = true; for (const send of [...pending.values()]) send() } }
}

test('cold collection preparation admits eight default reads and retains every member of large shared and private responses', async () => {
  const f = fixture(), checkpoint = {}
  const task = reservedIds(f.client, new AbortController().signal, { checkpoint, ttlMs: 0 })
  await f.entered
  try { assert.equal(f.pending.size, 8) }
  finally { f.release(); await task }
  const ids = await task
  assert.equal(ids.size, 1 + 9 * 2047)
  assert.equal(f.requested.length, 10)
  assert.deepEqual([...f.requested].sort(), Object.keys(checkpoint.collections).sort())
  assert.deepEqual(checkpoint.collections['collection-9'].ids, [])
  assert.ok(ids.has('collection-0-photo-2047'))
  assert.ok(ids.has('collection-8-photo-2047'))
})

test('an explicit smaller read limit is honored while cold preparation still reads every collection', async () => {
  const f = fixture(resolveConfig({ collectionConcurrency: 2 }))
  const task = reservedIds(f.client, new AbortController().signal, { concurrency: f.config.collectionConcurrency, ttlMs: 0 })
  await f.entered
  try { assert.equal(f.pending.size, 2) }
  finally { f.release(); await task }
  assert.equal((await task).size, 1 + 9 * 2047)
  assert.equal(f.requested.length, 10)
})

test('oversized chunked members fail preparation, cancel their bodies and never become an incomplete dedup snapshot', async () => {
  const f = fixture(resolveConfig({ maxResponseBytes: 4096 }), { chunked: true }), checkpoint = {}
  const task = reservedIds(f.client, new AbortController().signal, { concurrency: f.config.collectionConcurrency, checkpoint, ttlMs: 0 })
  const failed = assert.rejects(task, /response exceeded/)
  await f.entered
  f.release(); await failed
  assert.ok(f.cancelled.length > 0)
  assert.equal(Object.keys(checkpoint.collections).length, 0)
  assert.equal(f.requested.length, f.config.collectionConcurrency)
})

test('cancellation drains admitted cold reads and never admits the remaining collections', async () => {
  const f = fixture(), controller = new AbortController()
  const task = reservedIds(f.client, controller.signal, { concurrency: f.config.collectionConcurrency, ttlMs: 0 })
  const stopped = assert.rejects(task, { name: 'AbortError' })
  await f.entered
  controller.abort(); f.release(); await stopped
  assert.equal(f.requested.length, f.config.collectionConcurrency)
  assert.equal(f.pending.size, 0)
})
