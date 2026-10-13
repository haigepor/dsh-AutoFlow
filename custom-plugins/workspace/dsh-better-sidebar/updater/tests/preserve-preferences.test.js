import { test } from 'node:test'
import assert from 'node:assert/strict'
import { preservePreferences } from '../src/host/preserve-preferences.js'

test('retains renamed disabled sidebar rows without reading active settings', async () => {
  const entry = { options: { id: 'renamed-sidebar', name: 'dsh-better-sidebar', config: { customCss: '.local {}', pluginSettings: { editor: { openWith: { sshHost: 'my-host' } } } } } }
  let saved
  await preservePreferences({
    pluginManager: { listBundles: async () => [{ name: 'dsh-better-sidebar', enabled: true, rows: [{ rowId: 'renamed-sidebar', moduleName: 'dsh-better-sidebar' }] }] },
    configEditor: { entries: () => [entry], edit: async (target, change, options) => { assert.equal(target, entry); assert.deepEqual(options, { retainOverride: true }); saved = change(entry.options.config) } },
  })
  assert.deepEqual(saved, entry.options.config)
})

test('retains a deselected bundle through offline composition and rejects an unavailable owner', async () => {
  let retained
  await preservePreferences({ pluginManager: { listBundles: async () => [{ name: 'dsh-better-sidebar', enabled: false }] }, configEditor: { retainDisabledBundle: async name => { retained = name } } })
  assert.equal(retained, 'dsh-better-sidebar')
  await assert.rejects(preservePreferences({ pluginManager: { listBundles: async () => [] }, configEditor: { entries: () => [] } }), /configuration is unavailable/)
})
