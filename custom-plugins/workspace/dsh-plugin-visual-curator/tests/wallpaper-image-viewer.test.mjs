/** The production inspector measures image-pixel scale and keeps annotations in the same transform. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire, Module } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setImmediate } from 'node:timers/promises'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { zh } from '../src/client/workbench-locale.ts'

const root = fileURLToPath(new URL('../', import.meta.url)), require = createRequire(import.meta.url)
const compiled = await build({ entryPoints: [resolve(root, 'src/client/wallpaper-image-viewer.tsx')], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' })
const module = new Module(resolve(root, 'tests/inspector-memory.cjs')); module.filename = resolve(root, 'tests/inspector-memory.cjs'); module.paths = Module._nodeModulePaths(dirname(module.filename)); module._compile(compiled.outputFiles[0].text, module.filename)

test('fit, actual pixels, cursor zoom, pan and guide toggles operate on the same image', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://owner.example/', pretendToBeVisual: true }), win = dom.window
  const globals = { window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() { this.callback([{ contentRect: { width: 800, height: 600 } }]) } disconnect() {} constructor(callback) { this.callback = callback } } }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  const h = React.createElement, empty = () => null, pass = ({ children }) => h(React.Fragment, null, children)
  const ui = new Proxy({ Button: React.forwardRef(({ children, ...props },ref) => h('button', {...props,ref}, children)), Menu: ({ anchor, open, items, onSelect }) => h(React.Fragment,null,anchor,open && h('div',{role:'menu'},items.map(item=>h('button',{key:item.id,role:'menuitem',onClick:()=>onSelect(item.id)},item.label)))), Tooltip: pass, Modal: ({ children, title, onClose, closeLabel }) => h('section', { role: 'dialog', 'aria-label': title }, h('button', { onClick: onClose }, closeLabel), children), ZoomControls: ({ zoom, labels, onZoom }) => h('button', { 'aria-label': labels.into, onClick: () => onZoom(zoom * 1.25) }, '+'), Checkbox: ({ label, checked, onChange }) => h('label', null, h('input', { type: 'checkbox', checked, onChange: event => onChange(event.target.checked) }), label) }, { get: (target, key) => target[key] ?? empty })
  const Viewer = module.exports.createWallpaperImageViewer(React, ui), { createRoot } = require('react-dom/client'), node = createRoot(win.document.getElementById('root'))
  let closes = 0
  const paint = async task => act(async () => { task(); await setImmediate(); await setImmediate() })
  try {
    await paint(() => node.render(h(Viewer, { src: 'https://owner.example/final.png', label: 'Final output', dimensions: { width: 1845, height: 3280 }, t: key => zh[key], onClose: () => closes++, onSave() {} }, h('svg', null, h('rect', { 'data-review-guide': 'safe' })))))
    const doc = win.document, image = doc.querySelector('img')
    Object.defineProperties(image, { naturalWidth: { value: 1845 }, naturalHeight: { value: 3280 } })
    await paint(() => image.dispatchEvent(new win.Event('load')))
    assert.equal(doc.querySelector('output').textContent, '17%')
    const button = label => [...doc.querySelectorAll('button')].find(button => (button.getAttribute('aria-label') ?? button.textContent) === label)
    await paint(() => button(zh.wallpaperInspectorActual).click())
    assert.equal(doc.querySelector('output').textContent, '100%')
    assert(doc.querySelector('.vc-image-inspector-document').style.transform.endsWith('scale(1)'))
    const frame = doc.querySelector('.vc-image-inspector-stage'); frame.setPointerCapture = () => {}; frame.releasePointerCapture = () => {}
    const pointer = (type, x, y) => { const event = new win.MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }); Object.defineProperty(event, 'pointerId', { value: 1 }); return event }
    await paint(() => frame.dispatchEvent(pointer('pointerdown', 100, 100)))
    await paint(() => frame.dispatchEvent(pointer('pointermove', 140, 150)))
    assert(doc.querySelector('.vc-image-inspector-document').style.transform.includes('translate(40px, 50px)'))
    await paint(() => frame.dispatchEvent(pointer('pointerup', 140, 150)))
    await paint(() => frame.dispatchEvent(new win.WheelEvent('wheel', { deltaY: -100, clientX: 400, clientY: 300, bubbles: true, cancelable: true })))
    assert.equal(doc.querySelector('output').textContent, '122%')
    assert.equal(doc.querySelector('.vc-image-inspector-document').dataset.safe, 'false')
    await paint(() => doc.querySelector('input').click())
    assert.equal(doc.querySelector('.vc-image-inspector-document').dataset.safe, 'true')
    assert(doc.querySelector('.vc-image-inspector-document [data-review-guide]'))
    await paint(() => button(zh.wallpaperInspectorFit).click())
    assert.equal(doc.querySelector('output').textContent, '17%')
    const modal = doc.querySelector('[role="dialog"]')
    const guides={width:1845,height:3280,safe:{x:258/1845,y:1032/3280,width:1329/1845,height:1686/3280},regions:[{id:'solar-wing',name:'Solar wing',layer:'regions',role:'subject',rect:{x:.1,y:.2,width:.3,height:.4}}]}
    const renderVersion = annotated => node.render(h(Viewer, { src: 'https://owner.example/native.png', label: annotated ? 'Annotated native' : 'Clean native', annotated, guides, dimensions: { width: 941, height: 1672 }, t: key => zh[key], onClose: () => closes++, onSave() {} }, h('svg', null, h('rect', { 'data-review-guide': 'safe' }), h('rect', { 'data-review-region': 'subject' }))))
    await paint(() => renderVersion(true))
    assert.equal(doc.querySelector('[role="dialog"]'), modal, 'Switching only replaces image state, never the modal or its material')
    assert.equal(doc.querySelector('.vc-image-inspector-document').dataset.loaded, undefined, 'A new image cannot reuse the previous decoded pixels')
    assert([...doc.querySelectorAll('input')].every(input => input.checked), 'Annotated views open with all their layers visible')
    assert.equal(doc.querySelector('output').textContent, '29%')
    assert.equal(Number(doc.querySelector('.vc-image-inspector-document').style.getPropertyValue('--vc-inspector-scale')), 488 / 1672)
    assert.equal(doc.activeElement, doc.querySelector('.vc-image-inspector-stage'))
    const nativeImage = doc.querySelector('img')
    Object.defineProperties(nativeImage, { naturalWidth: { value: 941 }, naturalHeight: { value: 1672 } })
    await paint(() => nativeImage.dispatchEvent(new win.Event('load')))
    assert.equal(doc.querySelector('.vc-inspector-coordinate-panel'), null)
    assert.equal(doc.querySelectorAll('.vc-inspector-ruler').length, 2)
    const coordinates = () => [...doc.querySelectorAll('[data-coordinate]')].map(e => e.textContent)
    assert.deepEqual(coordinates(), ['X 131.59 · Y 526.07 px', 'W 677.83 px', 'H 859.45 px', 'X₂ 809.41 · Y₂ 1385.52 px'])
    const nativeFrame = doc.querySelector('.vc-image-inspector-stage')
    await paint(() => nativeFrame.dispatchEvent(pointer('pointermove', 400, 300)))
    assert.equal(doc.querySelector('.vc-inspector-crosshair text').textContent, 'X 470.5 · Y 836 px')
    assert.equal(doc.querySelector('.vc-inspector-crosshair path').getAttribute('d'), 'M400 0V600M0 300H800')
    assert.equal(doc.querySelectorAll('.vc-ruler-cursor').length, 2)
    const nativeDimensionPath = doc.querySelector('.vc-inspector-dimension-lines path').getAttribute('d')
    await paint(() => button(zh.wallpaperCoordinateTemplate).click())
    assert.equal(doc.querySelector('.vc-inspector-crosshair text').textContent, 'X 922.5 · Y 1640 px')
    assert.deepEqual(coordinates(), ['X 258 · Y 1032 px', 'W 1329 px', 'H 1686 px', 'X₂ 1587 · Y₂ 2718 px'])
    assert.equal(doc.querySelector('.vc-inspector-dimension-lines path').getAttribute('d'), nativeDimensionPath, 'Changing coordinate units cannot move the image or measurement geometry')
    await paint(() => nativeFrame.dispatchEvent(pointer('pointermove', 10, 10)))
    assert.equal(doc.querySelector('.vc-inspector-crosshair'), null, 'Blank canvas margins do not produce image coordinates')
    await paint(() => nativeFrame.dispatchEvent(pointer('pointermove', 400, 300)))
    await paint(() => nativeFrame.dispatchEvent(new win.MouseEvent('pointerout', { bubbles: true, relatedTarget: null })))
    assert.equal(doc.querySelector('.vc-inspector-crosshair'), null, 'Leaving the image removes both guide lines')
    await paint(() => button(zh.wallpaperCoordinateImage).click())
    await paint(() => button(zh.wallpaperCoordinateRegion).click())
    await paint(() => [...doc.querySelectorAll('[role=menuitem]')].find(e => e.textContent === 'Solar wing').click())
    assert.equal(doc.querySelector('.vc-inspector-selection rect').getAttribute('x'), '184.5')
    assert.deepEqual(coordinates(), ['X 94.1 · Y 334.4 px', 'W 282.3 px', 'H 668.8 px', 'X₂ 376.4 · Y₂ 1003.2 px'])
    assert(doc.querySelector('.vc-image-inspector-document').style.transform.includes('translate(0px, 0px)'), 'Fit retains the complete image when choosing a region')
    await paint(() => button(zh.wallpaperInspectorActual).click())
    const rulerZero = () => doc.querySelector('.vc-inspector-ruler-x [data-value="100"]').getAttribute('transform')
    assert.equal(rulerZero(), 'translate(29.5,0)')
    await paint(() => doc.querySelector('.vc-image-inspector-stage').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    assert.equal(rulerZero(), 'translate(13.5,0)', 'Ruler origin follows panning without changing document coordinates')
    assert.equal(doc.querySelector('[data-coordinate="width"]').textContent, 'W 282.3 px')
    await paint(() => doc.querySelectorAll('input')[1].click())
    assert.equal(doc.querySelector('.vc-inspector-measurements'), null, 'Hiding the selected layer also hides its measurement')
    await paint(() => button(zh.wallpaperCoordinates).click())
    assert.equal(doc.querySelector('.vc-inspector-ruler'), null)
    await paint(() => renderVersion(false))
    assert.equal(doc.querySelector('[role="dialog"]'), modal)
    assert([...doc.querySelectorAll('input')].every(input => !input.checked), 'Clean views do not inherit annotations from the preceding slide')
    await paint(() => button(zh.close).click()); assert.equal(closes, 1)
  } finally {
    await act(async () => node.unmount()); dom.window.close()
    for (const [key, value] of Object.entries(previous)) if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]
  }
})
