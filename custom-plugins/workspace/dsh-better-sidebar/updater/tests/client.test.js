import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { runInNewContext } from 'node:vm'
import { buildClient } from '../scripts/build-client.mjs'
const compiled = await buildClient()

function fixture(answer, context) {
  let component, module, hook = 0
  const effects = [], states = [], disposers = [], calls = [], timers = [], slots = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useSyncExternalStore: (_subscribe, read) => read(),
    useState: initial => { const index = hook++; states[index] ??= initial; return [states[index], value => { states[index] = value }] },
    useEffect: (effect, dependencies) => {
      const index = hook++
      if (effects[index]?.every((value, at) => value === dependencies[at])) return
      effects[index] = dependencies
      const dispose = effect()
      if (dispose) disposers.push(dispose)
    },
  }
  const ctx = {
    get: () => context,
    effect: effect => { const dispose = effect(); if (dispose) disposers.push(dispose) },
    locale: { register: () => () => {} },
    slots: { entries: () => [], subscribe: () => () => {}, inject: (_name, register) => register(), register: (options, value) => { slots.push(options.name); component = value; return () => {} } },
    remote: { $on: () => () => {}, pluginManager: { invokeAction: async (_package, _action, input) => {
      calls.push(input.operation)
      return typeof answer === 'function' ? answer(input.operation) : answer
    } } },
  }
  const document = { documentElement: { style: {} }, createElement: () => ({ remove() {} }), head: { append() {} } }
  runInNewContext(compiled, {
    window: { __ModuleLoader__: { load: value => { module = value } } }, document,
    setTimeout: run => { const timer = { run, cancelled: false }; timers.push(timer); return timer },
    clearTimeout: timer => { if (timer) timer.cancelled = true },
  })
  module.factory(id => id === 'react' ? react : id === 'react/jsx-runtime' ? {} : { Button: 'button', StateDot: 'state-dot', IconChevronRightOutlineRegular: 'svg' }).apply(ctx)
  return {
    calls,
    slots,
    poll: async () => { const timer = timers.shift(); if (timer && !timer.cancelled) await timer.run() },
    render: (subject = { kind: 'bundle', pkg: { name: 'dsh-better-sidebar' } }) => {
      hook = 0
      return component({ subject, t: (key, params) => params ? key + params.version : key })
    },
    dispose: () => { for (const dispose of disposers.reverse()) dispose() },
  }
}

function nodes(node) {
  return node && typeof node === 'object' ? [node, ...node.children.flatMap(nodes)] : []
}

test('reads the Remote result envelope and enables install only after an available-version response', async t => {
  const page = fixture(operation => ({ ok: true, value: { output: JSON.stringify({
    status: operation === 'check' ? 'available' : 'unchecked', installedVersion: '0.25.0', latestVersion: '0.26.0',
  }) } }))
  t.after(page.dispose)
  page.render()
  await setImmediate()
  let view = page.render()
  assert.ok(nodes(view).some(node => node.children.includes('installedSummary0.25.0')))
  assert.equal(nodes(view).find(node => node.children.includes('install')), undefined)
  nodes(view).find(node => node.children.includes('check')).props.onClick()
  await setImmediate()
  view = page.render()
  assert.equal(nodes(view).find(node => node.children.includes('install')).props.disabled, false)
  assert.deepEqual(page.calls, ['read', 'check'])
})

test('opens the shared restart dialog instead of treating a Remote envelope as a restart acceptance', async t => {
  const restarts = []
  const page = fixture({ ok: true, value: { output: JSON.stringify({ status: 'restart-required', restartRequired: true }) } },
    { showUpdateRestart: name => restarts.push(name) })
  t.after(page.dispose)
  page.render()
  await setImmediate()
  nodes(page.render()).find(node => node.children.includes('restart')).props.onClick()
  assert.deepEqual(restarts, ['dsh-better-sidebar'])
})

test('shows a recoverable error for a rejected Remote action', async t => {
  const page = fixture({ ok: false, error: { message: 'action unavailable' } })
  t.after(page.dispose)
  page.render()
  await setImmediate()
  const view = page.render()
  assert.match(JSON.stringify(view), /status_error/)
  assert.equal(nodes(view).find(node => node.children.includes('install')), undefined)
})

test('polls installation state while the install Remote response is still pending', async t => {
  let settle
  const page = fixture(operation => operation === 'install' ? new Promise(resolve => { settle = resolve }) : {
    ok: true, value: { output: JSON.stringify({ status: operation === 'check' ? 'available' : 'unchecked', installedVersion: '0.25.0', pollIntervalMs: 1000 }) },
  })
  t.after(page.dispose)
  page.render()
  await setImmediate()
  nodes(page.render()).find(node => node.children.includes('check')).props.onClick()
  await setImmediate()
  nodes(page.render()).find(node => node.children.includes('install')).props.onClick()
  page.render()
  await page.poll()
  assert.deepEqual(page.calls, ['read', 'check', 'install', 'read'])
  settle({ ok: true, value: { output: JSON.stringify({ status: 'restart-required', restartRequired: true }) } })
  await setImmediate()
  assert.match(JSON.stringify(page.render()), /status_restart-required/)
})

test('registers a folded update card with one live status and expands it without an automatic-install control', async t => {
  const page = fixture({ ok: true, value: { output: JSON.stringify({ status: 'current', installedVersion: '0.25.0' }) } })
  t.after(page.dispose)
  page.render()
  await setImmediate()
  let view = page.render()
  assert.deepEqual(page.slots, ['plugins.detail.updates'])
  assert.equal(view.type, 'details')
  assert.equal(view.props.open, false)
  assert.equal(nodes(view).filter(node => node.props?.role === 'status').length, 1)
  assert.ok(nodes(view).find(node => node.props?.['data-update-summary'] === ''))
  view.props.onToggle({ currentTarget: { open: true } })
  view = page.render()
  assert.equal(view.props.open, true)
  assert.equal(nodes(view).filter(node => node.props?.role === 'status').length, 1)
  assert.ok(nodes(view).find(node => node.props?.['data-update-status'] === ''))
  assert.equal(nodes(view).find(node => node.type === 'input' || node.props?.role === 'switch'), undefined)
})

test('keeps update actions visible by default on the combined management page', t => {
  const page = fixture({ ok: true, value: { output: JSON.stringify({ status: 'current' }) } })
  t.after(page.dispose)
  const view = page.render({ kind: 'bundle', pkg: { name: 'dsh-better-sidebar', updateManager: 'dsh-plugin-better-sidebar-updater' } })
  assert.equal(view.props.open, true)
  assert.ok(nodes(view).find(node => node.children.includes('check')))
})

test('animates a pending check without a completion percentage and removes feedback when the check settles', async t => {
  let settle
  const page = fixture(operation => operation === 'check' ? new Promise(resolve => { settle = resolve }) : {
    ok: true, value: { output: JSON.stringify({ status: 'unchecked', installedVersion: '0.25.0' }) },
  })
  t.after(page.dispose)
  const subject = { kind: 'bundle', pkg: { name: 'dsh-better-sidebar', updateManager: 'dsh-plugin-better-sidebar-updater' } }
  page.render(subject)
  await setImmediate()
  nodes(page.render(subject)).find(node => node.children.includes('check')).props.onClick()
  let view = page.render(subject)
  const track = nodes(view).find(node => node.props?.role === 'progressbar')
  assert.equal(track.props['aria-label'], 'status_checking')
  assert.equal(track.props['aria-valuenow'], undefined)
  assert.ok(nodes(view).some(node => node.type === 'state-dot' && node.props.state === 'ongoing'))
  assert.equal(nodes(view).filter(node => node.props?.role === 'status').length, 1)
  view.props.onToggle({ currentTarget: { open: false } })
  view = page.render(subject)
  assert.equal(nodes(view).find(node => node.props?.role === 'progressbar'), undefined)
  assert.ok(nodes(view).some(node => node.type === 'state-dot' && node.props.state === 'ongoing'))
  settle({ ok: true, value: { output: JSON.stringify({ status: 'current', installedVersion: '0.25.0' }) } })
  await setImmediate()
  view = page.render(subject)
  assert.equal(nodes(view).find(node => node.props?.['data-update-activity'] === ''), undefined)
})
