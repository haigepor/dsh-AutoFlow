import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCuratorTransport } from '../src/client/transport.ts'
import { largeWallpaperExperience, largeWallpaperView } from './fixtures/wallpaper-transport.ts'

test('large workspace reads use the authenticated data route instead of bounded action text', async () => {
  const operations: string[] = [], paths: string[] = []
  const largeValue = { styles: [{ name: 'large collection', observations: 'x'.repeat(30_000) }] }
  const transport = createCuratorTransport({ baseUrl: 'https://owner.example/dsh/', signal: new AbortController().signal,
    action: async operation => { operations.push(operation); return { ok: true, value: { id: 'created' } } },
    fetch: async (url, init) => { paths.push(String(url)); assert.equal(init?.credentials, 'same-origin'); return Response.json({ ok: true, value: largeValue }) },
  })
  assert.deepEqual(await transport.invoke('snapshot', {}), largeValue)
  assert.deepEqual(await transport.invoke('run-get', { runId: 'run' }), largeValue)
  assert.deepEqual(await transport.invoke('run-control', { runId: 'run', command: 'pause' }), largeValue)
  assert.deepEqual(await transport.invoke('export-get', { exportId: 'export' }), largeValue)
  assert.deepEqual(await transport.invoke('style-create', {}), { id: 'created' })
  assert.deepEqual(operations, ['style-create'])
  assert.deepEqual(paths, Array(4).fill('https://owner.example/dsh/api/visual-curator/data'))
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
  for (const operation of ['gallery-validate', 'gallery-collections', 'gallery-photos', 'gallery-import', 'gallery-login-start', 'gallery-login-status', 'gallery-login-retry', 'gallery-login-finish', 'gallery-login-cancel']) await transport.invoke(operation, {})
  assert.deepEqual(received, Array(9).fill('https://owner.example/api/visual-curator/gallery'))
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

test('wallpaper views, experience and owner actions use authenticated JSON beyond the plugin action byte limit', async () => {
  const view = largeWallpaperView(), experience = largeWallpaperExperience(), calls: { operation: string; args: Record<string, unknown> }[] = []
  assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, value: view })) > 27890)
  assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, value: experience })) > 16384)
  const transport = createCuratorTransport({ baseUrl: 'https://owner.example/dsh/', signal: new AbortController().signal,
    action: async () => { throw new Error('Wallpaper must not use bounded plugin action text') },
    fetch: async (url, options) => {
      assert.equal(String(url), 'https://owner.example/dsh/api/visual-curator/data'); assert.equal(options?.credentials, 'same-origin'); assert.equal(options?.cache, 'no-store')
      const request = JSON.parse(String(options?.body)); calls.push(request)
      return Response.json({ ok: true, value: request.operation === 'wallpaper-read' ? view : request.operation === 'wallpaper-experience' ? experience : { runId: 'accepted' } })
    },
  })
  assert.deepEqual(await transport.invoke('wallpaper-read', { sourceRunId: 'search', offset: 0 }), view)
  assert.deepEqual(await transport.invoke('wallpaper-experience', {}), experience)
  for (const operation of ['wallpaper-start', 'wallpaper-options', 'wallpaper-control', 'wallpaper-continue', 'wallpaper-plan-update', 'wallpaper-experience-action', 'wallpaper-case']) await transport.invoke(operation, { operationId: 'stable-owner-action' })
  assert.equal(calls.length, 9)
  assert.ok(calls.slice(2).every(call => call.args.operationId === 'stable-owner-action'))
})

test('wallpaper HTTP failures preserve errors, cancellation and explicit retry identity without action fallbacks', async () => {
  const lifetime = new AbortController(), page = new AbortController(), bodies: string[] = []
  const failure = { code: 'owner-denied', safeMessage: 'Unavailable', suggestedAction: 'Refresh' }
  let mode: 'error' | 'abort' | 'unknown' | 'success' = 'error', received: AbortSignal | null | undefined
  const transport = createCuratorTransport({ baseUrl: 'https://owner.example/', signal: lifetime.signal,
    action: async () => { throw new Error('Wallpaper must never fall back to action text') },
    fetch: async (_url, options) => {
      bodies.push(String(options?.body)); received = options?.signal
      if (mode === 'error') return Response.json({ ok: false, error: failure }, { status: 400 })
      if (mode === 'unknown') throw new TypeError('Acknowledgement unavailable')
      if (mode === 'success') return Response.json({ ok: true, value: { runId: 'same-accepted-run' } })
      return await new Promise<Response>((_resolve, reject) => received?.addEventListener('abort', () => reject(received?.reason), { once: true }))
    },
  })
  await assert.rejects(transport.invoke('wallpaper-read', { sourceRunId: 'search' }), failure)
  mode = 'abort'
  const reading = transport.invoke('wallpaper-read', { sourceRunId: 'search' }, page.signal)
  page.abort(); await assert.rejects(reading, error => error instanceof Error && error.name === 'AbortError')
  assert.equal(received?.aborted, true)
  const args = { operationId: 'retained-operation', runId: 'wallpaper' }
  mode = 'unknown'; await assert.rejects(transport.invoke('wallpaper-continue', args), TypeError)
  mode = 'success'; assert.deepEqual(await transport.invoke('wallpaper-continue', args), { runId: 'same-accepted-run' })
  assert.equal(bodies.length, 4, 'No automatic mutation retry is dispatched')
  assert.equal(bodies[2], bodies[3], 'An explicit retry retains the exact operation identity')
})
