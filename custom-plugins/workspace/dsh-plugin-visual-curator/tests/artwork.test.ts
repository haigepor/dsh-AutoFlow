/** Deferred artwork preserves the shipped pixels and supports browser cache revalidation. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createExecutionArtwork } from '../src/host/artwork.ts'

test('execution artwork serves unchanged packaged bytes, HEAD and conditional cache responses', async () => {
  const fetch = createExecutionArtwork(), url = 'https://fixture.invalid/api/visual-curator/artwork/execution-empty-v1.webp'
  const response = await fetch(new Request(url)), expected = await readFile(new URL('../assets/execution-empty-v1.webp', import.meta.url))
  assert.equal(response.headers.get('content-type'), 'image/webp')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected)
  const head = await fetch(new Request(url, { method: 'HEAD' }))
  assert.equal(head.headers.get('content-length'), String(expected.length))
  assert.equal((await head.arrayBuffer()).byteLength, 0)
  const cached = await fetch(new Request(url, { headers: { 'if-none-match': head.headers.get('etag')! } }))
  assert.equal(cached.status, 304)
  assert.equal((await cached.arrayBuffer()).byteLength, 0)
})
