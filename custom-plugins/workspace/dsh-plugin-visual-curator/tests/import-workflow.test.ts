import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'
import { decodeUpload } from '../src/host/imports.ts'

test('imports a large camera JPEG without overflowing Base64 validation', async () => {
  const f = await serviceFixture(undefined, { maxImportBytes: 20 * 1024 * 1024 }); await f.service.initialize()
  try {
    const pixels = Buffer.alloc(3072 * 2048 * 3)
    let state = 12345
    for (let index = 0; index < pixels.length; index++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; pixels[index] = state >>> 24 }
    const bytes = await sharp(pixels, { raw: { width: 3072, height: 2048, channels: 3 } }).jpeg({ quality: 90 }).toBuffer()
    assert.ok(bytes.length > 4_000_000 && bytes.length < 20 * 1024 * 1024)
    const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'style', name: 'Camera JPEG' }))
    const input = { operationId: 'large-jpeg', styleId, expectedRevision: 1, files: [{ name: 'DSC-camera.JPG', mime: 'image/jpeg', base64: bytes.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] }
    const result = z.object({ results: z.array(z.object({ ok: z.boolean(), error: z.unknown().optional() })) }).parse(await f.action('reference-import', input))
    assert.equal(result.results[0]?.ok, true, JSON.stringify(result))
    assert.equal(f.domain.require('draft', f.domain.require('style', styleId).draftId).referenceIds.length, 1)
    assert.equal(f.http.operations.length, 0, 'import must not dispatch a paid vision request')
  } finally { await f.cleanup() }
})

test('upload decoding rejects malformed alphabet, padding and decoded byte overflow', () => {
  for (const value of ['a', 'a===', 'ab=c', 'abc===', '=abc', 'ab-c', 'ab_c', 'ab c', 'ab\nc', '====']) assert.throws(() => decodeUpload(value, 20), { code: 'invalid-input' }, value)
  assert.throws(() => decodeUpload('YWJj', 2), { code: 'invalid-input' })
  assert.equal(decodeUpload('YQ==', 1).toString(), 'a')
  assert.equal(decodeUpload('YWI=', 2).toString(), 'ab')
  assert.equal(decodeUpload('YWJj', 3).toString(), 'abc')
})
