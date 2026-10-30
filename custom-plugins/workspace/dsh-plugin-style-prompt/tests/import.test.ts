/** Picker and drop imports share the same profile-owned metadata limits. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateImageSelection } from '../src/client/import.ts'

const limits = { maxImages: 2, maxImageBytes: 8, maxUploadBytes: 12 }
const image = (size = 4, type = 'image/png') => ({ size, type })

test('accepts supported image types and exact per-file and batch limits', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) assert.equal(validateImageSelection([image(8, type)], limits), null)
  assert.equal(validateImageSelection([image(8), image(4)], limits), null)
})

test('rejects empty selections, empty images and mixed unsupported batches', () => {
  assert.equal(validateImageSelection([], limits), 'no-files')
  assert.equal(validateImageSelection([image(0)], limits), 'empty-file')
  assert.equal(validateImageSelection([image(), image(4, 'text/plain')], limits), 'unsupported')
  assert.equal(validateImageSelection([image(4, 'image/svg+xml')], limits), 'unsupported')
})

test('reports the configured count, per-file and combined size limits separately', () => {
  assert.equal(validateImageSelection([image(), image(), image()], limits), 'count')
  assert.equal(validateImageSelection([image(9)], limits), 'file-size')
  assert.equal(validateImageSelection([image(8), image(5)], limits), 'batch-size')
  assert.equal(validateImageSelection([image(), image()], { ...limits, maxImages: 1 }), 'count')
})
