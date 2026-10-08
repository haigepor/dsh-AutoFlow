import test from 'node:test'
import assert from 'node:assert/strict'
import { photoDisplayTitle } from '../src/client/afp-photo-labels.js'

test('placeholder titles use captions or a localized fallback without changing AFP metadata', () => {
  for (const title of ['', '  ', '-', ' — ', '–']) {
    const photo = { title, caption: ' 香港太平山全景 ' }
    assert.equal(photoDisplayTitle(photo, '图片'), '香港太平山全景')
    assert.equal(photo.title, title)
  }
  assert.equal(photoDisplayTitle({ title: '-', caption: ' ' }, '图片 3'), '图片 3')
  assert.equal(photoDisplayTitle({ title: ' City - harbour ', caption: 'Caption' }, '图片'), 'City - harbour')
})
