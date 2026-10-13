import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPreferences } from '../src/client/preferences.js'
import { installSettingsPage } from '../src/client/settings-slot.js'

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
