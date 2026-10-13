import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const result = await build({ entryPoints: [fileURLToPath(new URL('../src/client/settings-fields.tsx', import.meta.url))], outfile: 'fields.js', bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'], loader: { '.module.css': 'local-css' } })
const script = result.outputFiles.find(file => file.path.endsWith('.js')).text

function fixture() {
  const menus = [], inputs = []
  const primitives = {
    Button: ({ children, variant, size, ...props }) => React.createElement('button', props, children),
    Input: props => { inputs.push(props); return React.createElement('input', { ...props, 'data-shared-input': true }) },
    Menu: props => { menus.push(props); return props.anchor },
    Switch: ({ label, checked }) => React.createElement('button', { role: 'switch', 'aria-label': label, 'aria-checked': checked }),
    Tooltip: ({ children }) => children,
    IconChevronDownOutlineRegular: () => React.createElement('svg'),
    IconCloseOutlineRegular: () => React.createElement('svg'),
  }
  const module = { exports: {} }
  runInNewContext(script, { module, exports: module.exports, require: id => id === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : require(id) })
  return { ...module.exports, menus, inputs }
}

test('portaled selections use standard icon slots, menu semantics and ordered multi-select values', () => {
  const { SettingsSelect, menus } = fixture()
  let selected
  const options = [{ value: true, title: 'Merged', desc: 'A long explanation', icon: size => React.createElement('svg', { width: size }) }, { value: false, title: 'Separate', desc: 'Another explanation' }]
  const html = renderToStaticMarkup(React.createElement(SettingsSelect, { toggle: { key: 'editorExplorer', title: 'Layout', type: 'select', options }, value: false, onChange: value => { selected = value } }))
  assert.match(html, /aria-haspopup="menu"/)
  assert.equal(menus[0].portal, true)
  assert.ok(menus[0].listClassName)
  assert.equal(menus[0].items[0].icon.props.width, 14)
  assert.match(renderToStaticMarkup(menus[0].items[0].label), /A long explanation/)
  menus[0].onSelect('0')
  assert.equal(selected, true)
  renderToStaticMarkup(React.createElement(SettingsSelect, { toggle: { key: 'multi', title: 'Modes', type: 'select', multi: true, options }, value: [false], onChange: value => { selected = value } }))
  menus[1].onSelect('0')
  assert.deepEqual(Array.from(selected), [true, false])
})

test('built-in editor uses labeled shared inputs and external renderers remain available', () => {
  const { SettingsBody, inputs } = fixture()
  const writes = []
  const prefs = { pluginSettings: { editor: { openWith: { sshHost: 'saved-host', customEditors: [], pinned: [] } } } }
  const props = { prefs, feature: { id: 'editor', settings: { render: () => React.createElement('span', null, 'Official unstyled form') } }, editor: true, onPluginWrite: (key, value) => writes.push([key, value]) }
  const html = renderToStaticMarkup(React.createElement(SettingsBody, props))
  assert.match(html, /data-shared-input="true"/)
  assert.doesNotMatch(html, /Official unstyled form/)
  assert.ok(inputs[0]['aria-label'])
  inputs[0].onChange({ currentTarget: { value: 'new-host' } })
  assert.equal(writes[0][0], 'openWith')
  assert.equal(writes[0][1].sshHost, 'new-host')
  const external = renderToStaticMarkup(React.createElement(SettingsBody, { ...props, editor: false, feature: { id: 'extension', settings: { render: () => React.createElement('span', null, 'External custom form') } } }))
  assert.match(external, /External custom form/)
})
