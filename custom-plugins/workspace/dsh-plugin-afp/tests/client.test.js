import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createAfpClientStore } from '../src/client/afp-client-store.js'
import { createConfigurationForm } from '../src/client/afp-configuration-form.js'
import { registerAgentTools } from '../src/host/afp-agent-tools.js'
import { runAfpTask } from '../cli/afp-task.js'

function element(type, props, ...children) { return { type, props: { ...props, children } } }
function findElement(node, match) {
  if (Array.isArray(node)) return node.map(item => findElement(item, match)).find(Boolean)
  if (!node || typeof node !== 'object') return undefined
  if (match(node)) return node
  return findElement(node.props?.children ?? [], match)
}

function visibleElements(node, match) {
  if (Array.isArray(node)) return node.flatMap(item => visibleElements(item, match))
  if (!node || typeof node !== 'object' || node.props?.hidden) return []
  const children = node.type === 'details' && !node.props.open ? node.props.children[0] : node.props?.children ?? []
  return [...(match(node) ? [node] : []), ...visibleElements(children, match)]
}

test('account sections keep unsaved credential and model values while exposing only the selected fields', () => {
  const Input = Symbol('Input'), Button = Symbol('Button')
  const config = { usernameRef: 'AFP_USERNAME', passwordRef: 'AFP_PASSWORD', visionModel: 'original', targetPerCategory: 70 }
  const states = [{ config }, JSON.stringify(config), {}, '', false, false, config]
  let cursor = 0
  const React = { createElement: element, useEffect() {}, useId: () => 'form-test', useState(initial) {
    const index = cursor++
    if (states[index] === undefined) states[index] = initial
    return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
  } }
  const Form = createConfigurationForm(React, { Input, Button }, {}, key => key)
  const render = section => { cursor = 0; return Form({ view: 'page', section, sectionId: 'settings' }) }
  const input = (tree, label) => findElement(tree, node => node.type === Input && node.props['aria-label'] === label)
  let tree = render('credentials')
  input(tree, 'passwordRef').props.onChange({ target: { value: 'unsaved-password' } })
  tree = render('vision')
  input(tree, 'visionModel').props.onChange({ target: { value: 'edited-model' } })
  assert.equal(render('features').props.hidden, true)
  assert.equal(input(render('credentials'), 'passwordRef').props.value, 'unsaved-password')
  assert.equal(input(render('vision'), 'visionModel').props.value, 'edited-model')
  assert.equal(JSON.parse(states[1]).targetPerCategory, 70, 'Editing the model preserves other deployment values')
  const output = Object.fromEntries(['credentials', 'vision', 'features'].map(section => {
    const form = render(section)
    const panel = findElement(form, node => node.props?.role === 'tabpanel' && !node.props.hidden)
    return [section, { formHidden: form.props.hidden,
      panel: panel?.props['aria-labelledby'] ?? null,
      fields: form.props.hidden ? [] : panel ? visibleElements(panel, node => node.type === Input).map(node => node.props['aria-label']) : [],
      collapsedGroups: visibleElements(form, node => node.type === 'details').map(node => node.props.children[0].props.children[0]),
      advanced: visibleElements(form, node => node.props?.className === 'afp-advanced-toggle').map(node => ({ expanded: node.props['aria-expanded'] }))[0] ?? null,
    }]
  }))
  assert.deepEqual(output, JSON.parse(readFileSync(new URL('./fixtures/account-sections.json', import.meta.url), 'utf8')))
})

test('workbench advanced editing shares the model draft and survives collapsing and switching sections', async () => {
  const Input = Symbol('Input'), Button = Symbol('Button'), StateDot = Symbol('StateDot')
  const config = { visionModel: 'original', visionBaseUrl: 'https://vision.test', targetPerCategory: 70 }
  const states = [{ config, revision: 'current' }, JSON.stringify(config), {}]
  let cursor = 0, releaseSave, saved = 0
  const calls = []
  const React = { createElement: element, useEffect() {}, useId: () => 'advanced-test', useState(initial) {
    const index = cursor++
    if (states[index] === undefined) states[index] = initial
    return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
  } }
  const ctx = { remote: { pluginManager: { async invokeAction(_plugin, _action, input) {
    calls.push(input)
    if (input.operation === 'save') {
      await new Promise(resolve => { releaseSave = resolve })
      return { ok: true }
    }
    return { ok: true, value: { output: JSON.stringify({ config: JSON.parse(states[1]), revision: 'next' }) } }
  } } } }
  const Form = createConfigurationForm(React, { Input, Button, StateDot }, ctx, key => key)
  const render = (section = 'vision') => { cursor = 0; return Form({ view: 'page', section, sectionId: 'settings', className: 'afp-wb-config-form', onSaved: () => { saved++ } }) }
  const editor = tree => findElement(tree, node => node.type === 'textarea')
  const toggle = tree => findElement(tree, node => node.props?.className === 'afp-advanced-toggle')
  const field = tree => findElement(tree, node => node.type === Input && node.props['aria-label'] === 'visionModel')
  const tick = () => new Promise(resolve => setImmediate(resolve))
  let tree = render()
  const primary = findElement(tree, node => node.props?.className === 'afp-config-primary')
  assert.equal(visibleElements(primary, node => node.type === Button && node.props.type === 'submit').length, 1)
  assert.equal(visibleElements(tree, node => node.type === Button && node.props.type === 'submit').length, 1)
  assert.equal(toggle(tree).props['aria-expanded'], true)
  assert.equal(toggle(tree).props['aria-controls'], 'advanced-test-advanced-content')
  editor(tree).props.onChange({ target: { value: JSON.stringify({ ...config, visionModel: 'from-json' }) } })
  assert.equal(field(render()).props.value, 'from-json')
  toggle(render()).props.onClick()
  tree = render()
  assert.equal(toggle(tree).props['aria-expanded'], false)
  assert.equal(visibleElements(tree, node => node.type === 'textarea').length, 0)
  assert.equal(JSON.parse(editor(tree).props.value).visionModel, 'from-json')
  render('credentials')
  render('features')
  tree = render()
  assert.equal(toggle(tree).props['aria-expanded'], false)
  toggle(tree).props.onClick()
  field(render()).props.onChange({ target: { value: 'from-field' } })
  assert.equal(JSON.parse(editor(render()).props.value).visionModel, 'from-field')
  assert.equal(JSON.parse(editor(render()).props.value).targetPerCategory, 70)
  editor(render()).props.onChange({ target: { value: '{unfinished' } })
  render().props.onSubmit({ preventDefault() {} })
  await tick()
  assert.equal(calls.length, 0, 'Invalid JSON never reaches the Host')
  assert.equal(findElement(render(), node => node.props?.role === 'alert').props.children[0], 'configFailed')
  editor(render()).props.onChange({ target: { value: JSON.stringify({ ...config, visionModel: 'saved-model' }) } })
  render().props.onSubmit({ preventDefault() {} })
  await tick()
  const pending = findElement(render(), node => node.type === Button && node.props.type === 'submit')
  assert.equal(pending.props.disabled, true)
  assert.equal(pending.props['aria-busy'], true)
  assert.equal(pending.props.icon.type, StateDot)
  assert.equal(editor(render()).props.disabled, true)
  releaseSave()
  await tick()
  assert.deepEqual(calls.map(input => input.operation), ['save', 'read'])
  assert.equal(JSON.parse(calls[0].config).visionModel, 'saved-model')
  assert.equal(calls[0].revision, 'current')
  assert.equal(saved, 1)
  assert.equal(findElement(render(), node => node.type === Button && node.props.type === 'submit').props.disabled, false)
})

test('queued feature switches preserve unrelated selections and distinguish actual runtime state', async () => {
  const choices = { read: true, refresh: true, 'ui-panel': true, 'ui-settings': false }
  const saved = []
  const remote = {
    invokeAction: async () => ({ ok: true, value: { output: JSON.stringify({ features: ['read', 'ui-panel'], scope: 'profile' }) } }),
    listBundles: async () => ({ ok: true, value: [{ name: 'dsh-plugin-afp', features: Object.entries(choices).map(([id, enabled]) => ({ id, rowId: `afp-${id}`, enabled })) }] }),
    listPlugins: async () => ({ ok: true, value: [{ patchId: 'afp-read', enabled: true, fiberPhase: 'active' }, { patchId: 'afp-refresh', enabled: true, fiberPhase: 'pending' }] }),
    setBundleFeatures: async (_name, ids) => { for (const id of Object.keys(choices)) choices[id] = ids.includes(id); saved.push({ ...choices }); return { ok: true, value: { application: 'applied' } } },
  }
  const store = createAfpClientStore({ remote: { pluginManager: remote } })
  await store.reload()
  assert.equal(store.getSnapshot().features.find(f => f.id === 'read').running, true)
  assert.equal(store.getSnapshot().features.find(f => f.id === 'refresh').running, false)
  const writes = [store.toggle('ui-settings', true), store.toggle('refresh', false)]
  assert.deepEqual(store.getSnapshot().pendingTargets, { 'ui-settings': true, refresh: false })
  await Promise.all(writes)
  assert.deepEqual(store.getSnapshot().pendingTargets, {})
  assert.deepEqual(choices, { read: true, refresh: false, 'ui-panel': true, 'ui-settings': true })
  assert.equal(saved.length, 2); assert.equal(store.getSnapshot().saving.length, 0)
  const before = { ...choices }
  remote.setBundleFeatures = async () => ({ ok: true, value: { application: 'failed', error: { diagnostic: 'activation failed' } } })
  await store.toggle('read', false)
  assert.deepEqual(choices, before); assert.match(store.getSnapshot().error, /activation failed/)
  store.dispose()
})

test('Agent search tool and CLI/page adapter call the same shared operation and disposal removes the tool', async () => {
  const tools = new Map(), effects = []
  const service = { require: () => {}, search: query => ({ query, operation: 'offline-plan' }), pageAction: async input => service.search(JSON.parse(input.args).query) }
  const ctx = { effect(register) { effects.push(register()) }, tools: { register(value) { tools.set(value.name, value); return () => tools.delete(value.name) } } }
  registerAgentTools(ctx, service, 'read')
  const signal = new AbortController().signal
  const agent = JSON.parse(await tools.get('afp_search_plan').execute({ query: 'food' }, { signal, agent: { id: 'session-1' } }))
  const page = await runAfpTask(service, { operation: 'search', args: JSON.stringify({ query: 'food' }) }, signal)
  assert.deepEqual(agent, page)
  for (const dispose of effects.reverse()) dispose()
  assert.equal(tools.size, 0)
})

test('token acquisition locks the form and refreshes credential metadata after saving', async () => {
  const Button = Symbol('Button'), Input = Symbol('Input'), StateDot = Symbol('StateDot')
  const states = [{ config: { accessTokenRef: 'AFP_ACCESS_TOKEN', usernameRef: 'AFP_USERNAME', passwordRef: 'AFP_PASSWORD', visionKeyRef: 'VISION_API_KEY' } }, '', {}, '', false, false, {}]
  let cursor = 0
  const React = {
    createElement: element,
    useId: () => 'form-test',
    useState(initial) {
      const index = cursor++
      if (states[index] === undefined) states[index] = initial
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
    },
    useEffect() {},
  }
  let releaseCredential
  const credentialSaved = new Promise(resolve => { releaseCredential = resolve })
  const calls = []
  const ctx = { remote: {
    credentials: { set: async (...args) => { calls.push(['credential', args]); await credentialSaved; return { ok: true } } },
    pluginManager: { invokeAction: async (...args) => { calls.push(['action', args]); return { ok: true, value: { output: JSON.stringify(states[0]) } } } },
  } }
  const Form = createConfigurationForm(React, { Input, Button, StateDot }, ctx, key => ({ accessTokenRef: 'AFP access token', usernameRef: 'AFP username', passwordRef: 'AFP password', visionKeyRef: 'Vision API key', acquireToken: 'Get token', acquiringToken: 'Getting token', tokenAcquiring: 'Getting access token', tokenCredentialsRequired: 'Account required', tokenAcquired: 'Saved', tokenAcquireFailed: 'Failed', saveCredential: 'Save' }[key] ?? key))
  const render = () => { cursor = 0; return Form({ view: 'page' }) }
  const tokenButton = tree => findElement(tree, item => item.type === Button && Object.hasOwn(item.props, 'aria-busy'))
  const input = (tree, label) => findElement(tree, item => item.type === Input && item.props['aria-label'] === label)

  let tree = render()
  assert.equal(tokenButton(tree).props.disabled, true)
  input(tree, 'AFP username').props.onChange({ target: { value: 'account' } })
  tree = render()
  assert.equal(tokenButton(tree).props.disabled, true)
  input(tree, 'AFP password').props.onChange({ target: { value: 'password' } })
  tree = render()
  tokenButton(tree).props.onClick()
  tree = render()
  const loading = tokenButton(tree)
  assert.equal(loading.props.disabled, true)
  assert.equal(loading.props['aria-busy'], true)
  assert.equal(loading.props.children[0], 'Getting token')
  assert.equal(loading.props.icon.type, StateDot)
  assert.equal(loading.props.icon.props.state, 'ongoing')
  assert.equal(states[3], '')
  releaseCredential()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [
    ['credential', ['AFP_USERNAME', 'account']],
    ['credential', ['AFP_PASSWORD', 'password']],
    ['action', ['dsh-plugin-afp', 'configuration', { operation: 'acquire-token' }]],
    ['action', ['dsh-plugin-afp', 'configuration', { operation: 'read' }]],
  ])
  assert.equal(states[2].usernameRef, undefined)
  assert.equal(states[2].passwordRef, '')
  states[0] = { ...states[0], credentials: { usernameRef: { configured: true }, passwordRef: { configured: true } } }
  assert.equal(tokenButton(render()).props.disabled, false)
})

test('configuration starts with form-sized skeleton columns and replaces them with fields after reading', async () => {
  const Input = Symbol('Input'), Button = Symbol('Button'), states = []
  let cursor = 0, effect, resolveRead
  const React = {
    createElement: element,
    useId: () => 'form-test',
    useState(initial) {
      const index = cursor++
      if (states[index] === undefined) states[index] = initial
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
    },
    useEffect(callback) { effect ??= callback },
  }
  const ctx = { remote: { pluginManager: { invokeAction: () => new Promise(resolve => { resolveRead = resolve }) } } }
  const Form = createConfigurationForm(React, { Input, Button }, ctx, key => key)
  const render = () => { cursor = 0; return Form({ view: 'page', featureId: 'refresh' }) }
  const pending = render()
  const dispose = effect()
  assert.equal(pending.props['data-vision'], true)
  assert.equal(pending.props['aria-busy'], true)
  assert.equal(findElement(pending, node => node.props?.role === 'status').props['aria-label'], 'loading')
  assert.equal(findElement(pending, node => node.type === Input), undefined)
  assert.ok(findElement(pending, node => node.props?.className === 'afp-skeleton afp-skeleton-input'))
  resolveRead({ ok: true, value: { output: JSON.stringify({ config: { visionBaseUrl: 'https://vision.test', threshold: .8 } }) } })
  await new Promise(resolve => setImmediate(resolve))
  const ready = render()
  assert.equal(ready.props['data-vision'], pending.props['data-vision'])
  assert.equal(ready.props.className, pending.props.className)
  assert.equal(ready.props['aria-busy'], false)
  assert.equal(findElement(ready, node => node.props?.className === 'afp-config-advanced-card'), undefined, 'Standalone configuration keeps its original disclosure')
  assert.equal(findElement(ready, node => node.type === 'details' && node.props.className === 'afp-advanced').props.open, undefined)
  assert.equal(findElement(ready, node => node.props?.role === 'status'), undefined)
  assert.ok(findElement(ready, node => node.type === Input && node.props['aria-label'] === 'visionBaseUrl'))
  assert.equal(findElement(ready, node => node.type === Button && node.props.type === 'submit').props.disabled, false)
  dispose()
})

test('credential fields show saved usernames, toggle independent drafts and hide secrets again after saving', async () => {
  const Input = Symbol('Input'), Button = Symbol('Button')
  const config = { usernameRef: 'AFP_USERNAME', passwordRef: 'AFP_PASSWORD', accessTokenRef: 'AFP_ACCESS_TOKEN', visionKeyRef: 'VISION_API_KEY' }
  const metadata = { config, username: 'saved-account', credentials: { passwordRef: { configured: true } } }
  const states = [metadata, JSON.stringify(config), {}]
  let cursor = 0
  const React = { createElement: element, useEffect() {}, useId: () => 'credential-test', useState(initial) {
    const index = cursor++
    if (states[index] === undefined) states[index] = initial
    return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
  } }
  const writes = []
  const ctx = { remote: {
    credentials: { set: async (ref, value) => { writes.push({ ref, value }); return { ok: true } } },
    pluginManager: { invokeAction: async () => ({ ok: true, value: { output: JSON.stringify(metadata) } }) },
  } }
  const Form = createConfigurationForm(React, { Input, Button }, ctx, key => key)
  const render = () => { cursor = 0; return Form({ view: 'page' }) }
  const input = (tree, key) => findElement(tree, node => node.type === Input && node.props['aria-label'] === key)
  const toggle = (tree, key) => findElement(tree, node => node.type === Button && node.props['aria-controls'] === input(tree, key).props.id)
  const initial = render()
  const snapshot = Object.fromEntries(['usernameRef', 'passwordRef', 'accessTokenRef', 'visionKeyRef'].map(key => {
    const field = input(initial, key)
    return [key, { type: field.props.type, value: field.props.value, visible: key === 'usernameRef' || toggle(initial, key).props['aria-pressed'] }]
  }))
  assert.deepEqual(snapshot, JSON.parse(readFileSync(new URL('./fixtures/credential-fields.json', import.meta.url), 'utf8')))
  for (const key of ['passwordRef', 'accessTokenRef', 'visionKeyRef']) {
    const tree = render()
    assert.equal(toggle(tree, key).props.disabled, true)
    input(tree, key).props.onChange({ target: { value: `draft-${key}` } })
    toggle(render(), key).props.onClick({ currentTarget: { closest: () => null } })
    assert.equal(input(render(), key).props.type, 'text')
    assert.equal(toggle(render(), key).props['aria-pressed'], true)
  }
  toggle(render(), 'passwordRef').props.onClick({ currentTarget: { closest: () => null } })
  assert.equal(input(render(), 'passwordRef').props.type, 'password')
  assert.equal(input(render(), 'accessTokenRef').props.type, 'text')
  toggle(render(), 'passwordRef').props.onClick({ currentTarget: { closest: () => null } })
  render().props.onSubmit({ preventDefault() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(writes.length, 3, 'Unchanged displayed username is not rewritten')
  assert.equal(input(render(), 'usernameRef').props.value, 'saved-account')
  for (const key of ['passwordRef', 'accessTokenRef', 'visionKeyRef']) {
    assert.equal(input(render(), key).props.value, '')
    assert.equal(input(render(), key).props.type, 'password')
  }
})
