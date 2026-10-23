import test from 'node:test'
import assert from 'node:assert/strict'
import { fitCropRect, validCropRect } from '../src/client/crop-geometry.ts'

test('physical output ratio accounts for landscape and portrait source dimensions', () => {
  for (const [width, height] of [[800, 400], [400, 800], [100, 100]]) {
    const rect = fitCropRect({ x: 0, y: 0, width: 1, height: 1 }, width!, height!, 9 / 16)
    assert.ok(validCropRect(rect))
    assert.ok(Math.abs(rect.width * width! / (rect.height * height!) - 9 / 16) < 1e-12)
    assert.ok(Math.abs(rect.x - (1 - rect.width) / 2) < 1e-12)
    assert.ok(Math.abs(rect.y - (1 - rect.height) / 2) < 1e-12)
  }
})

test('locked numeric edits preserve the edited dimension and keep its partner within the source', () => {
  const rect = { x: 0.3, y: 0, width: 0.25, height: 1 }
  const fromWidth = fitCropRect(rect, 800, 400, 9 / 16, 'width')
  assert.equal(fromWidth.width, 0.25)
  assert.ok(Math.abs(fromWidth.height - 8 / 9) < 1e-12)
  const fromHeight = fitCropRect({ ...rect, height: 0.5 }, 800, 400, 9 / 16, 'height')
  assert.equal(fromHeight.height, 0.5)
  assert.equal(fromHeight.width, 9 / 64)
  assert.ok(validCropRect(fitCropRect({ ...rect, x: 0.99, width: 1 }, 800, 400, 9 / 16, 'width')))
})

test('free crops retain their ratio while invalid numeric values cannot become a valid crop', () => {
  const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }
  assert.deepEqual(fitCropRect(rect, 800, 400), rect)
  for (const width of [0, -1, NaN, Infinity]) {
    const invalid = fitCropRect({ ...rect, width }, 800, 400, 9 / 16, 'width')
    assert.equal(validCropRect(invalid), false)
  }
})
