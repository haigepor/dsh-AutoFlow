/** The reference dialog uses shipped primitives; isolated DOM checks complement native visual acceptance. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import Module, { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const root = fileURLToPath(new URL('../', import.meta.url)), require = createRequire(import.meta.url)
const React = require('react'), { act } = React, { createRoot } = require('react-dom/client')
const names = ['Modal', 'SegmentedControl', 'Checkbox', 'TextArea', 'Button', 'StateDot', 'Tag']
const contents = names.map(name => `import {${name}} from '../../../packages/client/ui-primitives/src/${name}.tsx'`).join('\n') + `\nexport const ui={${names.join(',')}}; export {createReferenceEditor} from './src/client/reference-edit.tsx'; export {zh} from './src/client/workbench-locale.ts'`
const compiled = await build({ stdin: { contents, resolveDir: root, loader: 'ts' }, outfile: resolve(root, 'tests/reference-editor-memory.cjs'), bundle: true, write: false, external: ['react', 'react/*', 'react-dom', 'react-dom/*'], platform: 'node', format: 'cjs', loader: { '.css': 'empty' }, logLevel: 'silent' })
const filename = resolve(root, 'tests/reference-editor-memory.cjs'), capsule = new Module(filename)
capsule.filename = filename; capsule.paths = Module._nodeModulePaths(dirname(filename)); capsule._compile(compiled.outputFiles.find(file => file.path.endsWith('.cjs')).text, filename)
const { ui, createReferenceEditor, zh } = capsule.exports
const expected = JSON.parse(await readFile(new URL('./fixtures/reference-editor.expected.json', import.meta.url), 'utf8'))

test('native form primitives retain scoped selection, keyboard navigation, busy state and one committed reference revision', async () => {
  const keys = ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'], old = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://fixture.invalid/' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  const rendered = createRoot(document.getElementById('root')), Editor = createReferenceEditor(React, ui), calls = []
  let closed = 0, settle
  const pending = new Promise(resolve => { settle = resolve })
  const props = { image: { name: 'folder/reference.png', referenceId: 'reference', width: 320, height: 320, role: 'positive', intent: 'overall' }, style: { styleId: 'style', revision: 4 }, actions: { execute: async (operation, args) => { calls.push({ operation, args }); await pending } }, t: key => zh[key], onClose: () => { closed++ } }
  const tab = text => [...document.querySelectorAll('[role="tab"]')].find(element => element.textContent === text)
  const save = () => [...document.querySelectorAll('button')].find(element => element.textContent.includes(zh.saveAdjustment))
  try {
    await act(async () => rendered.render(React.createElement(Editor, props)))
    assert.equal(document.querySelector('.vc-reference-editor-file p').textContent, expected.fileName)
    assert.equal(document.querySelector('[role="dialog"]').getAttribute('aria-label'), zh.referenceEditTitle)
    await act(async () => tab(zh.referenceEditDimensions).click())
    assert.equal(save().disabled, true)
    assert(document.querySelector('.vc-reference-editor-required'))
    await act(async () => tab(zh.positive).dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    assert.equal(tab(zh.undecided).getAttribute('aria-selected'), 'true')
    const texture = [...document.querySelectorAll('label')].find(label => label.textContent === zh.texture).querySelector('input')
    await act(async () => texture.click())
    assert.equal(save().disabled, false)
    await act(async () => save().click())
    assert.equal(document.querySelectorAll('[role="tab"]:disabled').length, 5)
    assert.equal(document.querySelector('textarea').disabled, true)
    assert.equal(closed, 0)
    await act(async () => { settle(); await pending })
    assert.equal(calls.length, expected.requestCount)
    assert.equal(calls[0].operation, 'reference-edit')
    assert.equal(calls[0].args.role, expected.role)
    assert.deepEqual(calls[0].args.intent, expected.intent)
    assert.equal(calls[0].args.expectedRevision, 4)
    assert.equal(closed, expected.closedAfterCommit)
  } finally {
    await act(async () => rendered.unmount()); dom.window.close()
    for (const key of keys) { const descriptor = old.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
  }
})
