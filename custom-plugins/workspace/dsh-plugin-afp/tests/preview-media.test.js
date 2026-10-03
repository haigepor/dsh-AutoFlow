import test from 'node:test'
import assert from 'node:assert/strict'
import { previewSource, readPreviewMedia } from '../src/client/afp-preview-media.js'

test('preview paths only address the same-origin proxy with a single photo ID', () => {
  const base = 'https://profile.test/app/'
  assert.equal(previewSource('api/afp/preview?photoId=photo%2F1', base), 'https://profile.test/app/api/afp/preview?photoId=photo%2F1')
  for (const path of ['https://outside.test/image', 'data:image/png;base64,AAA', 'api/afp/preview?photoId=',
    'api/afp/preview?photoId=1&photoId=2', 'api/afp/preview?photoId=1&url=https://outside.test/', 'api/afp/preview?photoId=1#hash']) {
    assert.equal(previewSource(path, base), null)
  }
})

test('preview requests retain the cancellation signal and only return raster bytes', async () => {
  const signal = new AbortController().signal
  const bytes = new Uint8Array([255, 216, 255])
  const blob = await readPreviewMedia('/preview', signal, async (_url, init) => {
    assert.equal(init.credentials, 'same-origin'); assert.equal(init.signal, signal)
    return new Response(bytes, { headers: { 'content-type': 'image/jpeg' } })
  })
  assert.equal(blob.type, 'image/jpeg')
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes)
  await assert.rejects(readPreviewMedia('/preview', signal, async () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } })))
})

test('preview errors expose a validated host but never raw server messages or URLs', async () => {
  const signal = new AbortController().signal
  const error = await readPreviewMedia('/preview', signal, async () => Response.json({
    code: 'preview-host-blocked', host: 'cdn.example.test', message: 'secret-token', url: 'https://cdn.example.test/?signature=secret',
  }, { status: 502 })).catch(error => error)
  assert.equal(error.host, 'cdn.example.test')
  assert.doesNotMatch(error.message + JSON.stringify(error), /secret|signature/)
  for (const host of ['cdn.test/?token=secret', '<script>']) {
    await assert.rejects(readPreviewMedia('/preview', signal, async () => Response.json({ code: 'preview-host-blocked', host }, { status: 502 })),
      error => error.host === null && error.code === 'preview-unavailable')
  }
})
