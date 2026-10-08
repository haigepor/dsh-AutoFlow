import test from 'node:test'
import assert from 'node:assert/strict'
import { cancelPhotoScroll, slidePhotoStrip } from '../src/client/afp-photo-scroll.js'

test('strip animation exposes intermediate frames, accumulates clicks, reverses and restores snapping', t => {
  const originals = Object.fromEntries(['requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'matchMedia'].map(key => [key, globalThis[key]]))
  t.after(() => { for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value } })
  const frames = new Map(); let sequence = 0
  globalThis.requestAnimationFrame = callback => { frames.set(++sequence, callback); return sequence }
  globalThis.cancelAnimationFrame = id => frames.delete(id)
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '0.3s' })
  globalThis.matchMedia = () => ({ matches: false })
  const frame = time => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(time) }
  const node = { scrollLeft: 0, scrollWidth: 1000, clientWidth: 400, style: { scrollSnapType: 'x proximity' }, children: [2, 190, 378, 566, 754].map(offsetLeft => ({ offsetLeft })), scrollTo({ left }) { this.scrollLeft = left } }
  const motion = {}
  slidePhotoStrip(node, 1, motion); frame(0); frame(150)
  assert.ok(node.scrollLeft > 0 && node.scrollLeft < 188)
  slidePhotoStrip(node, 1, motion)
  assert.equal(motion.target, 376, 'a second click advances beyond the unfinished destination')
  slidePhotoStrip(node, -1, motion)
  assert.equal(motion.target, 188)
  frame(200); frame(500)
  assert.equal(node.scrollLeft, 188); assert.equal(node.style.scrollSnapType, 'x proximity'); assert.equal(frames.size, 0)
  slidePhotoStrip(node, 1, motion); cancelPhotoScroll(motion)
  assert.equal(frames.size, 0); assert.equal(node.style.scrollSnapType, 'x proximity')
  globalThis.matchMedia = () => ({ matches: true })
  slidePhotoStrip(node, -1, motion)
  assert.equal(node.scrollLeft, 0); assert.equal(frames.size, 0)
})
