import test from 'node:test'
import assert from 'node:assert/strict'
import { createAfpSearchInput } from '../src/client/afp-search-input.js'

function element(type, props, ...children) { return { type, props: { ...props, children } } }
function nodes(tree, match) {
  if (Array.isArray(tree)) return tree.flatMap(item => nodes(item, match))
  if (!tree || typeof tree !== 'object') return []
  return [...(match(tree) ? [tree] : []), ...nodes(tree.props?.children, match)]
}
function harness() {
  const slots = [], refs = [], fills = [], effects = []
  let cursor = 0, refCursor = 0, value = '猫', enabled = true
  const React = { createElement: element, useId: () => 'keywords', useEffect(fn) { effects.push(fn) }, useLayoutEffect() {},
    useRef(initial) { const index = refCursor++; return refs[index] ??= { current: initial } },
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], next => { slots[index] = next }] } }
  const UI = Object.fromEntries(['Input', 'Button', 'Tag', 'MenuSurface'].map(name => [name, Symbol(name)]))
  UI.createPortal = tree => tree
  const dismissed = []
  UI.useDismissOnOutsidePointer = (...args) => dismissed.push(args)
  const Search = createAfpSearchInput(React, UI, {}, key => key)
  return { UI, fills, effects, dismissed, refs,
    setEnabled(next) { enabled = next }, setValue(next) { value = next },
    render() { cursor = 0; refCursor = 0; effects.length = 0; return Search({ value, enabled, onChange(next) { fills.push(next); value = next } }) } }
}
function keyboard(key, extra = {}) {
  return { key, prevented: false, stopped: false, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true }, ...extra }
}

test('combobox keeps search explicit, accepts keyboard options and closes without closing the workbench drawer', t => {
  const prior = globalThis.document
  globalThis.document = { body: {} }
  t.after(() => { globalThis.document = prior })
  const h = harness(), input = () => nodes(h.render(), node => node.type === h.UI.Input)[0]
  assert.equal(input().props.role, 'combobox')
  input().props.onFocus()
  assert.equal(input().props['aria-expanded'], true)
  const initialEnter = keyboard('Enter'); input().props.onKeyDown(initialEnter)
  assert.equal(initialEnter.prevented, false)
  assert.deepEqual(h.fills, [])
  const down = keyboard('ArrowDown'); input().props.onKeyDown(down)
  assert.equal(down.prevented, true)
  assert.equal(input().props['aria-activedescendant'], 'keywords-option-0')
  const enter = keyboard('Enter'); input().props.onKeyDown(enter)
  assert.equal(enter.prevented, true)
  assert.deepEqual(h.fills, ['cat'])
  assert.equal(input().props['aria-expanded'], false)
  input().props.onFocus()
  const escape = keyboard('Escape'); input().props.onKeyDown(escape)
  assert.equal(escape.stopped, true)
  assert.equal(input().props['aria-expanded'], false)
})

test('IME Enter never submits or fills, and an inactive search tab cannot retain a portaled menu', t => {
  const prior = globalThis.document
  globalThis.document = { body: {} }
  t.after(() => { globalThis.document = prior })
  const h = harness(), input = () => nodes(h.render(), node => node.type === h.UI.Input)[0]
  input().props.onFocus()
  input().props.onKeyDown(keyboard('ArrowDown'))
  for (const extra of [{ nativeEvent: { isComposing: true } }, { keyCode: 229 }]) {
    const enter = keyboard('Enter', extra); input().props.onKeyDown(enter); assert.equal(enter.prevented, true)
  }
  input().props.onCompositionStart()
  const enter = keyboard('Enter'); input().props.onKeyDown(enter)
  assert.equal(enter.prevented, true)
  assert.deepEqual(h.fills, [])
  input().props.onCompositionEnd()
  h.setEnabled(false)
  assert.equal(input().props['aria-expanded'], false)
  h.effects[0]()
  h.setEnabled(true)
  assert.equal(input().props['aria-expanded'], false)
})

test('mouse recommendations only fill text, category selection filters locally and outside dismissal closes the menu', t => {
  const prior = globalThis.document
  globalThis.document = { body: {} }
  t.after(() => { globalThis.document = prior })
  const h = harness(), input = () => nodes(h.render(), node => node.type === h.UI.Input)[0]
  input().props.onFocus()
  const row = nodes(h.render(), node => node.props?.role === 'option')[0]
  const pointer = keyboard(''); row.props.onMouseDown(pointer)
  assert.equal(pointer.prevented, true)
  row.props.onClick()
  assert.deepEqual(h.fills, ['cat'])
  h.setValue(''); input().props.onFocus()
  nodes(h.render(), node => node.type === h.UI.Button && node.props.children[0] === 'food')[0].props.onClick()
  assert.ok(nodes(h.render(), node => node.props?.role === 'option').every(row =>
    nodes(row, node => node.type === h.UI.Tag)[0].props.children[0].includes('food')))
  const dismiss = h.dismissed.at(-1)
  assert.equal(dismiss[3], h.refs[1])
  dismiss[2](false)
  assert.equal(input().props['aria-expanded'], false)
  input().props.onFocus()
  h.refs[0].current = { querySelector: () => ({ focus: () => input().props.onFocus() }) }
  const menu = nodes(h.render(), node => node.type === h.UI.MenuSurface)[0]
  menu.props.onKeyDown(keyboard('Escape'))
  assert.equal(input().props['aria-expanded'], false, 'restoring input focus must not reopen the menu')
})
