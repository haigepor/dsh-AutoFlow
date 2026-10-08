import test from 'node:test'
import assert from 'node:assert/strict'
import { createPreviewLoading } from '../src/client/afp-preview-loading.js'

function fixture(observe = true) {
  const listeners = new Map(), attributes = new Map()
  let callback, effect, disconnected = 0
  const document = { hidden: false, defaultView: { IntersectionObserver: observe ? class {
    constructor(fn) { callback = fn }
    observe() {}
    disconnect() { disconnected++ }
  } : undefined }, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) }
  const element = { ownerDocument: document, setAttribute: (name, value) => attributes.set(name, value) }
  const React = { createElement: (type, props, ...children) => ({ type, props, children }), useRef: () => ({ current: element }), useEffect: fn => { effect = fn } }
  const PreviewLoading = createPreviewLoading(React)
  return { document, attributes, listeners, element, render: props => PreviewLoading(props), start: () => effect(),
    visible(value) { callback([{ target: element, isIntersecting: value }]) }, disconnected: () => disconnected }
}

test('shimmer visibility follows intersection and page visibility and disposes its observers', () => {
  const f = fixture(); f.render({ label: 'Loading' }); const stop = f.start()
  assert.equal(f.attributes.get('data-active'), 'false')
  f.visible(true); assert.equal(f.attributes.get('data-active'), 'true')
  f.document.hidden = true; f.listeners.get('visibilitychange')(); assert.equal(f.attributes.get('data-active'), 'false')
  f.document.hidden = false; f.listeners.get('visibilitychange')(); assert.equal(f.attributes.get('data-active'), 'true')
  f.visible(false); assert.equal(f.attributes.get('data-active'), 'false')
  stop(); assert.equal(f.listeners.size, 0); assert.equal(f.disconnected(), 1)
})

test('older browsers without intersection observation retain loading feedback and page hiding', () => {
  const f = fixture(false); f.render({ label: 'Loading' }); const stop = f.start()
  assert.equal(f.attributes.get('data-active'), 'true')
  f.document.hidden = true; f.listeners.get('visibilitychange')(); assert.equal(f.attributes.get('data-active'), 'false')
  stop(); assert.equal(f.listeners.size, 0)
})

test('loading remains localized and accessible when animation is disabled without creating a canvas', () => {
  const f = fixture(), tree = f.render({ label: '加载中', animation: { enabled: false } })
  assert.equal(tree.props.role, 'status'); assert.equal(tree.props['aria-label'], '加载中')
  assert.equal(tree.props['data-animation-enabled'], false)
  const types = node => [node.type, ...node.children.flatMap(types)]
  assert.ok(!types(tree).includes('canvas'))
})
