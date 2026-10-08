import test from 'node:test'
import assert from 'node:assert/strict'
import { createAfpSelector } from '../src/client/afp-selector.js'

test('choice menus measure their actual trigger and reject disabled choices', () => {
  const Menu = Symbol('Menu'), Button = Symbol('Button'), selected = []
  let open = false
  const ref = { current: null }
  const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), useRef: () => ref,
    useState: () => [open, value => { open = typeof value === 'function' ? value(open) : value }] }
  const Selector = createAfpSelector(React, { Menu, Button })
  const render = () => Selector({ value: '', options: [{ value: '', label: 'Choose', disabled: true }, { value: 'target', label: 'Named collection' }], label: 'Target', onChange: value => selected.push(value) }).props.children[0]
  const initial = render()
  assert.equal(initial.props.listClassName, 'afp-wb-selector-menu')
  assert.equal(initial.props.getAnchorRect(), null)
  const rect = { left: 200, top: 300, width: 400, height: 36 }
  ref.current = { getBoundingClientRect: () => rect }
  assert.equal(render().props.getAnchorRect(), rect)
  initial.props.anchor.props.onClick()
  assert.equal(render().props.open, true)
  render().props.onSelect('0')
  assert.deepEqual(selected, [])
  render().props.onSelect('1')
  assert.deepEqual(selected, ['target'])
  assert.equal(render().props.open, false)
})
