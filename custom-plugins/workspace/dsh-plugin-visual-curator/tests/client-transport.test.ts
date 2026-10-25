import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCuratorTransport } from '../src/client/transport.ts'

test('large workspace reads use the authenticated data route instead of bounded action text', async () => {
  const operations: string[] = [], paths: string[] = []
  const largeValue = { styles: [{ name: 'large collection', observations: 'x'.repeat(30_000) }] }
  const transport = createCuratorTransport({ baseUrl: 'https://owner.example/dsh/', signal: new AbortController().signal,
    action: async operation => { operations.push(operation); return { ok: true, value: { id: 'created' } } },
    fetch: async (url, init) => { paths.push(String(url)); assert.equal(init?.credentials, 'same-origin'); return Response.json({ ok: true, value: largeValue }) },
  })
  assert.deepEqual(await transport.invoke('snapshot', {}), largeValue)
  assert.deepEqual(await transport.invoke('run-get', { runId: 'run' }), largeValue)
  assert.deepEqual(await transport.invoke('export-get', { exportId: 'export' }), largeValue)
  assert.deepEqual(await transport.invoke('style-create', {}), { id: 'created' })
  assert.deepEqual(operations, ['style-create'])
  assert.deepEqual(paths, Array(3).fill('https://owner.example/dsh/api/visual-curator/data'))
})

test('data read failures retain safe Host errors and never retry through the action route', async () => {
  const error = { code: 'owner-denied', safeMessage: '', suggestedAction: '' }
  const transport = createCuratorTransport({ baseUrl: 'https://owner.example/', signal: new AbortController().signal,
    action: async () => { throw new Error('read must not fall back to actions') }, fetch: async () => Response.json({ ok: false, error }, { status: 400 }),
  })
  await assert.rejects(transport.invoke('snapshot', {}), error)
})

test('gallery responses and account validation use an authenticated cancellable route without action truncation', async () => {
  const abort = new AbortController(), received: string[] = []
  const transport = createCuratorTransport({ baseUrl: 'https://owner.example/', signal: abort.signal,
    action: async () => { throw new Error('Gallery data must not use action text') },
    fetch: async (url, options) => { received.push(String(url)); assert.equal(options?.credentials, 'same-origin'); return Response.json({ ok: true, value: { items: [], nextCursor: null } }) },
  })
  for (const operation of ['gallery-validate', 'gallery-collections', 'gallery-photos', 'gallery-import', 'gallery-login-start', 'gallery-login-status', 'gallery-login-finish', 'gallery-login-cancel']) await transport.invoke(operation, {})
  assert.deepEqual(received, Array(8).fill('https://owner.example/api/visual-curator/gallery'))
})

test('system picker uses the dedicated route and cancels with its page lifetime', async () => {
  const lifetime = new AbortController(), page = new AbortController()
  let receivedSignal: AbortSignal | undefined
  const transport = createCuratorTransport({ baseUrl: 'https://owner.example/dsh/', signal: lifetime.signal,
    action: async () => { throw new Error('system picker must not use bounded actions') },
    fetch: async (url, init) => { assert.equal(String(url), 'https://owner.example/dsh/api/visual-curator/local-reference'); receivedSignal = init?.signal ?? undefined; return Response.json({ ok: true, value: { files: [], cancelled: true } }) },
  })
  assert.deepEqual(await transport.invoke('local-reference-pick', { kind: 'file', title: 'Pick' }, page.signal), { files: [], cancelled: true })
  assert.equal(receivedSignal?.aborted, false)
  page.abort()
  assert.equal(receivedSignal?.aborted, true)
})
