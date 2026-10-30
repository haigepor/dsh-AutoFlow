import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createPreferences } from '../src/client/preferences.js'
import { installSettingsPage } from '../src/client/settings-slot.js'

test('keeps task-folding preferences through acknowledged loads and later saves', async t => {
  const result = await build({ entryPoints: [fileURLToPath(new URL('../../src/client/prefs.ts', import.meta.url))], outfile: 'prefs.js', bundle: true, write: false, format: 'cjs', platform: 'node' })
  const module = { exports: {} }
  runInNewContext(result.outputFiles.find(file => file.path.endsWith('.js')).text, { module, exports: module.exports })
  const { parsePrefs } = module.exports
  const expected = { tasksAutoFoldSettled: true, tasksAutoFoldBranches: false, tasksAutoFoldIdle: true, jobsAutoCollapse: false }
  let saved = { ...expected, customCss: '' }, revision = 1, stored, view
  const controller = createPreferences({
    settingsGet: async () => ({ value: saved, revision }),
    settingsUpdate: async patch => { saved = { ...saved, ...patch }; revision++; return { value: saved, revision } },
  }, {
    getPrefs: () => parsePrefs(saved),
    setPrefs: value => { stored = value },
  }, parsePrefs, next => { view = next })
  t.after(() => controller.dispose())
  const check = () => {
    for (const prefs of [stored, view.prefs]) {
      assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, prefs[key]])), expected)
    }
  }

  await controller.load()
  check()
  assert.equal(await controller.write(() => ({ tasksAutoFoldSettled: false })), true)
  expected.tasksAutoFoldSettled = false
  check()
  const customCss = '.sidebar { color: var(--dsw-alias-label-primary); }'
  assert.equal(await controller.write(() => ({ customCss })), true)
  check()
  assert.equal(stored.customCss, customCss)
})

test('queued toggles merge acknowledged maps and do not carry a rejected change into the next save', async () => {
  let saved = { tabsEnabled: { git: true, diff: true } }, revision = 1, release
  const calls = []
  const api = {
    settingsGet: async () => ({ value: saved, revision }),
    settingsUpdate: async (patch, rev) => {
      calls.push({ patch, rev })
      if (calls.length === 1) { await new Promise(resolve => { release = resolve }); throw new Error('conflict') }
      saved = { ...saved, ...patch }; revision++
      return { value: saved, revision }
    },
  }
  let view
  const controller = createPreferences(api, { getPrefs: () => saved, setPrefs() {} }, value => value, next => { view = next })
  await controller.load()
  const a = controller.write(prefs => ({ tabsEnabled: { ...prefs.tabsEnabled, git: false } }))
  const b = controller.write(prefs => ({ tabsEnabled: { ...prefs.tabsEnabled, diff: false } }))
  assert.deepEqual(view.prefs.tabsEnabled, { git: false, diff: false })
  release()
  assert.equal(await a, false)
  assert.equal(await b, true)
  assert.deepEqual(saved.tabsEnabled, { git: true, diff: false })
  assert.equal(calls[1].rev, 1)
})

test('leaving the page suppresses notifications while acknowledged writes still update the live store', async () => {
  let release, notifications = 0, stored
  const controller = createPreferences({ settingsGet: async () => ({ value: {}, revision: 1 }), settingsUpdate: async () => { await new Promise(resolve => { release = resolve }); return { value: { customCss: 'saved' }, revision: 2 } } },
    { getPrefs: () => ({}), setPrefs: value => { stored = value } }, value => value, () => notifications++)
  await controller.load()
  const result = controller.write(() => ({ customCss: 'saved' }))
  controller.dispose()
  const count = notifications
  release()
  assert.equal(await result, true)
  assert.equal(notifications, count)
  assert.equal(stored.customCss, 'saved')
})

test('local settings survive upstream entry replacement and restore the official entry when disposed', () => {
  let rows = [], listeners = new Set()
  const emit = () => { for (const listener of listeners) listener() }
  const slots = { entries: () => rows, subscribe: (_key, listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    register: (options, component) => { const entry = { options, component, inject: options.inject }; rows.push(entry); emit(); return () => { rows = rows.filter(row => row !== entry); emit() } } }
  const local = () => null, old = () => null, successor = () => null
  const stop = installSettingsPage(slots, local, 'local-copy')
  const remove = slots.register({ id: 'better-sidebar', priority: 0, inject: () => ({ version: 1 }) }, old)
  assert.equal(rows.find(row => row.component === local).inject().version, 1)
  remove()
  assert.equal(rows.length, 0)
  slots.register({ id: 'better-sidebar', priority: 0, inject: () => ({ version: 2 }) }, successor)
  assert.equal(rows.find(row => row.component === local).inject().version, 2)
  assert.equal(rows.find(row => row.component === local).options.priority, -1)
  stop()
  assert.deepEqual(rows.map(row => row.component), [successor])
  assert.equal(listeners.size, 0)
})
