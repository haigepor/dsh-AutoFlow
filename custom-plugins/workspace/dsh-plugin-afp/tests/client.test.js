import test from 'node:test'
import assert from 'node:assert/strict'
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
  await Promise.all([store.toggle('ui-settings', true), store.toggle('refresh', false)])
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

test('token button requires both account fields and shows the shared loading ring while credentials are saved', async () => {
  const Button = Symbol('Button'), Input = Symbol('Input'), StateDot = Symbol('StateDot')
  const states = [{ config: { accessTokenRef: 'AFP_ACCESS_TOKEN', usernameRef: 'AFP_USERNAME', passwordRef: 'AFP_PASSWORD', visionKeyRef: 'VISION_API_KEY' } }, '', {}, '', false, {}, false]
  let cursor = 0
  const React = {
    createElement: element,
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
    pluginManager: { invokeAction: async (...args) => { calls.push(['action', args]); return { ok: true } } },
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
  assert.equal(states[3], 'Getting access token')
  releaseCredential()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [
    ['credential', ['AFP_USERNAME', 'account']],
    ['credential', ['AFP_PASSWORD', 'password']],
    ['action', ['dsh-plugin-afp', 'configuration', { operation: 'acquire-token' }]],
  ])
})
