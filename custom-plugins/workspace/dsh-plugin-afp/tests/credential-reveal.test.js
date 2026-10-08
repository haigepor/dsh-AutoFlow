import test from 'node:test'
import assert from 'node:assert/strict'
import { createConfigurationForm } from '../src/client/afp-configuration-form.js'

function find(node, predicate) {
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean)
  if (!node || typeof node !== 'object') return undefined
  return predicate(node) ? node : find(node.props?.children, predicate)
}

function fixture(acquireError) {
  const Input = Symbol('Input'), Button = Symbol('Button'), states = [], effects = [], refs = []
  const config = { usernameRef: 'AFP_USERNAME', passwordRef: 'AFP_PASSWORD', accessTokenRef: 'AFP_ACCESS_TOKEN', visionKeyRef: 'VISION_API_KEY' }
  const metadata = { config, revision: 'current', credentials: Object.fromEntries(Object.keys(config).map(key => [key, { configured: true, writable: true }])) }
  const calls = [], writes = []
  let cursor = 0, refCursor = 0, release, failing = false
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useId: () => 'reveal',
    useState(initial) {
      const index = cursor++
      if (!(index in states)) states[index] = initial
      return [states[index], update => { states[index] = typeof update === 'function' ? update(states[index]) : update }]
    },
    useRef(initial) { return refs[refCursor++] ??= { current: initial } },
    useEffect(callback) { effects.push(callback) },
  }
  const ctx = { remote: {
    credentials: { async set(ref, value) { writes.push({ ref, value }); return { ok: true } } },
    pluginManager: { async invokeAction(_plugin, _action, input) {
      calls.push(input)
      if (input.operation === 'acquire-token' && acquireError) return { ok: true, value: { output: JSON.stringify({ acquired: false, error: { code: acquireError } }) } }
      if (input.operation === 'reveal-credential') return new Promise(resolve => { release = () => resolve(failing ? { ok: false } : { ok: true, value: { output: JSON.stringify({ value: `fixture-${input.key}` }) } }) })
      return { ok: true, value: { output: JSON.stringify(metadata) } }
    } },
  } }
  const Form = createConfigurationForm(React, { Input, Button }, ctx, key => key)
  const render = () => { cursor = 0; refCursor = 0; return Form({ view: 'page' }) }
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const input = key => find(render(), node => node.type === Input && node.props['aria-label'] === key)
  const toggle = key => find(render(), node => node.type === Button && node.props['aria-controls'] === input(key).props.id)
  const click = key => toggle(key).props.onClick({ currentTarget: { closest: () => null } })
  return { render, input, toggle, click, tick, calls, writes, effects, release: () => release(), fail: () => { failing = true } }
}

test('stored password, token and key reveal on demand without becoming credential edits', async () => {
  const f = fixture()
  f.render(); f.effects[0]()
  await f.tick()
  for (const key of ['passwordRef', 'accessTokenRef', 'visionKeyRef']) {
    assert.ok(f.input(key).props.className.includes('afp-secret-masked'))
    assert.equal(f.input(key).props.value, '')
    assert.equal(f.input(key).props.placeholder, 'maskedCredential')
    assert.equal(f.toggle(key).props.disabled, false)
    f.click(key)
    assert.equal(f.toggle(key).props['aria-busy'], true)
    f.release(); await f.tick()
    assert.equal(f.input(key).props.className.includes('afp-secret-masked'), false)
    assert.equal(f.input(key).props.value, `fixture-${key}`)
    f.click(key)
    assert.equal(f.input(key).props.value, '')
    assert.ok(f.input(key).props.className.includes('afp-secret-masked'))
  }
  f.render().props.onSubmit({ preventDefault() {} }); await f.tick()
  assert.deepEqual(f.writes, [])
  assert.deepEqual(f.calls.filter(call => call.operation === 'reveal-credential').map(call => call.key), ['passwordRef', 'accessTokenRef', 'visionKeyRef'])
  f.input('passwordRef').props.onChange({ target: { value: '' } })
  f.click('passwordRef'); f.release(); await f.tick()
  assert.equal(f.input('passwordRef').props.value, 'fixture-passwordRef', 'An empty draft still allows revealing the saved value')
})

test('credential edits and closing the form suppress late reveal results', async () => {
  const f = fixture()
  f.render(); const close = f.effects[0](); await f.tick()
  f.click('passwordRef')
  f.input('passwordRef').props.onChange({ target: { value: 'replacement' } })
  f.release(); await f.tick()
  assert.equal(f.input('passwordRef').props.value, 'replacement')
  assert.ok(f.input('passwordRef').props.className.includes('afp-secret-masked'))
  f.click('accessTokenRef')
  close(); f.release(); await f.tick()
  assert.equal(f.input('accessTokenRef').props.value, '')
  assert.ok(f.input('accessTokenRef').props.className.includes('afp-secret-masked'))
})

test('failed credential reveals keep the mask, report a safe error and allow retry', async () => {
  const f = fixture()
  f.render(); f.effects[0](); await f.tick()
  f.fail(); f.click('passwordRef'); f.release(); await f.tick()
  assert.equal(f.input('passwordRef').props.value, '')
  assert.equal(f.toggle('passwordRef').props.disabled, false)
  assert.equal(find(f.render(), node => node.props?.role === 'alert').props.children[0], 'credentialRevealFailed')
})

test('a structured token authentication failure stays a failure and leaves credential drafts unchanged', async () => {
  const f = fixture('authentication-failed')
  f.render(); f.effects[0](); await f.tick()
  find(f.render(), node => node.props?.children?.[0] === 'acquireToken').props.onClick()
  await f.tick()
  assert.equal(find(f.render(), node => node.props?.role === 'alert').props.children[0], 'tokenAuthenticationFailed')
  assert.equal(f.calls.filter(call => call.operation === 'read').length, 1, 'Failure does not display a successful refresh')
  assert.deepEqual(f.writes, [])
  assert.equal(f.input('passwordRef').props.value, '')
})
