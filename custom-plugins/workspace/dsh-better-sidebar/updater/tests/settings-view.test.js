import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { readFile } from 'node:fs/promises'
import { buildClient } from '../scripts/build-client.mjs'

const require = createRequire(new URL('../../package.json', import.meta.url))
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const en = JSON.parse(await readFile(new URL('../locale/en.json', import.meta.url), 'utf8'))
const compiled = await buildClient()

test('renders dynamic extensions with independent switches and keeps disabled feature settings discoverable', () => {
  let module, component
  const prefs = { tabsEnabled: { extension: false }, viewersEnabled: {}, pluginSettings: {}, customCss: '', agentOpenTools: false, mobileNoAutoOpen: true, mobileDefaultTree: true }
  const store = { getPrefs: () => prefs }
  const service = { version: '0.25.0', getTabs: () => [
    { id: 'git', title: 'File changes', order: 20 },
    { id: 'diff', title: 'File changes', hidden: true },
    { id: 'extension', title: 'External tool', order: 30, description: 'Registered at runtime', settings: { toggles: [{ key: 'external', title: 'External setting' }] } },
  ], getFileViewers: () => [{ id: 'new-preview', title: 'External preview', exts: ['abc'] }] }
  const original = { options: { id: 'better-sidebar' }, component: () => null, inject: () => ({ store, service }) }
  const disposers = []
  const ctx = {
    effect: effect => { const remove = effect(); if (remove) disposers.push(remove) },
    locale: { register: () => () => {}, getSnapshot: () => ({ active: 'en' }) },
    slots: { entries: () => [original], subscribe: () => () => {}, inject: (_name, register) => register(), register: (options, value) => { if (options.name === 'settings.section') component = value; return () => {} } },
    remote: { $on: () => () => {} },
  }
  runInNewContext(compiled, { window: { __ModuleLoader__: { load: value => { module = value } } }, document: { documentElement: { style: {} }, createElement: () => ({ remove() {} }), head: { append() {} } } })
  const primitives = {
    Button: ({ children, variant, size, ...props }) => React.createElement('button', props, children),
    Switch: ({ label, checked, disabled }) => React.createElement('button', { role: 'switch', 'aria-label': label, 'aria-checked': checked, disabled }),
    IconChevronRightOutlineRegular: () => React.createElement('svg'),
  }
  module.factory(id => id === 'react' ? React : id === 'react/jsx-runtime' ? require(id) : primitives).apply(ctx)
  const html = renderToStaticMarkup(React.createElement(component, { store, service, t: key => en[key] ?? key }))
  assert.match(html, /Registered at runtime/)
  assert.match(html, /External preview/)
  assert.match(html, /aria-label="External tool Settings"/)
  assert.doesNotMatch(html, /aria-pressed=/)
  const headings = [...html.matchAll(/<h[12][^>]*>([^<]+)/g)].map(match => match[1].trim())
  const switches = [...html.matchAll(/role="switch" aria-label="([^"]+)" aria-checked="([^"]+)"/g)].map(match => ({ label: match[1].replaceAll('&#x27;', "'"), checked: match[2] === 'true' }))
  assert.deepEqual({ headings, switches, advancedFolded: /<details class="bs-settings-advanced">/.test(html) }, {
    headings: ['Sidebar settings', 'Sidebar content', 'File previews', 'Opening behavior'],
    switches: [
      { label: 'File changes', checked: true }, { label: 'External tool', checked: false }, { label: 'Diff preview', checked: true },
      { label: 'External preview', checked: true }, { label: 'Allow the model to open the sidebar', checked: false },
      { label: "Don't auto-open on narrow screens", checked: true }, { label: 'Default the Tasks page to the tree', checked: true },
    ], advancedFolded: true,
  })
  for (const remove of disposers.reverse()) remove()
})
