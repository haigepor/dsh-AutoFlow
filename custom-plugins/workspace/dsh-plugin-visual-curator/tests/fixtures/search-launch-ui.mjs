/** Native production components with saved package data and controlled, keyless task replies. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Button } from '../../../../../packages/client/ui-primitives/src/Button.tsx'
import { Checkbox } from '../../../../../packages/client/ui-primitives/src/Checkbox.tsx'
import { Input } from '../../../../../packages/client/ui-primitives/src/Input.tsx'
import { TextArea } from '../../../../../packages/client/ui-primitives/src/TextArea.tsx'
import { Modal } from '../../../../../packages/client/ui-primitives/src/Modal.tsx'
import { Tag } from '../../../../../packages/client/ui-primitives/src/Tag.tsx'
import { StateDot } from '../../../../../packages/client/ui-primitives/src/StateDot.tsx'
import { Menu } from '../../../../../packages/client/ui-primitives/src/Menu.tsx'
import { SegmentedTabs } from '../../../../../packages/client/ui-primitives/src/SegmentedTabs.tsx'
import { DisclosureRow } from '../../../../../packages/client/ui-primitives/src/DisclosureRow.tsx'
import * as icons from '../../../../../packages/client/ui-primitives/src/icons/index.tsx'

import { createSearchLaunchStore } from '../../src/client/search-launch-store.ts'
import { createSearchLaunchUI } from '../../src/client/search-launch-dialog.tsx'
import { zh } from '../../src/client/workbench-locale.ts'
import pluginCss from '../../src/client/entry.css'
import '../../../../../packages/client/ui-theme/src/styles/base.css'
import '../../../../../packages/client/ui-theme/src/styles/corner-shape.css'
import '../../../../../packages/client/ui-theme/src/styles/design-platform.css'
import '../../../../../packages/client/ui-theme/src/styles/personalization.css'
import '../../../../../packages/client/ui-theme/src/styles/focus.css'
const ui = { Button, Checkbox, Input, TextArea, Modal, Tag, StateDot, Menu, SegmentedTabs, DisclosureRow, ...icons }
const h = React.createElement, t = key => zh[key], { style, snapshot, usageOptions } = window.datasetFixtureData
const sheet = document.createElement('style'); sheet.textContent = pluginCss; document.head.append(sheet)
let entry = null, calls = [], opened = [], fail = false
const store = createSearchLaunchStore({ context: () => ({ scope: 1, styleId: style.styleId, pollMs: 1000 }), openSession: id => opened.push(id), invoke: async (operation, args) => {
  if (operation === 'search-launch-options') return { workspaces: [{ id: 'photos', title: 'CodexMcp', path: 'D:/project/CodexMcp' }, { id: 'archive', title: '素材归档', path: 'D:/素材归档' }], usages: usageOptions, defaultTargetCount: 10, maxTargetCount: 200 }
  if (operation === 'search-launch-list') return entry ? [entry] : []
  if (operation === 'search-launch-start') {
    calls.push(args)
    entry = { id: args.operationId, input: args, sessionId: 'fixture-native-session', status: 'working', stage: 'preparing', createdAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T00:00:00Z', runIds: [], qualified: 0 }
    if (fail) { fail = false; throw new Error('Lost acknowledgement') }
    return entry
  }
  if (operation === 'search-launch-stop') { entry = { ...entry, status: 'stopped', stage: 'stopped' }; return entry }
  throw new Error(operation)
} })
store.sync()
const Launch = createSearchLaunchUI(React, ui)
function App() {
  const [open, setOpen] = React.useState(false), [serial, setSerial] = React.useState(0)
  const useLaunches = select => select(React.useSyncExternalStore(store.subscribe, store.getSnapshot))
  return h('div', { className: 'vc-workbench' }, h('h2', null, style.name), h(Button, { onClick: () => { setSerial(value => value + 1); setOpen(true) } }, t('searchLaunchTitle')), h(Launch.Background, { useLaunches, actions: store, t }), open && h(Launch.Dialog, { key: serial, open, onClose: () => setOpen(false), style, snapshot, useLaunches, actions: store, t }))
}
createRoot(document.getElementById('root')).render(h(App))
window.searchFixture = { calls, opened, failNext() { fail = true }, async accept() { entry = { ...entry, status: 'accepted', stage: 'accepted' }; await store.refresh() }, async running() { entry = { ...entry, runIds: ['real-run'], runStatus: 'running', qualified: 2 }; await store.refresh() }, async failed() { entry = { ...entry, status: 'failed', stage: 'attaching', error: { code: 'reference-unavailable', safeMessage: 'Fixture attachment error', suggestedAction: 'Continue' } }; await store.refresh() }, state: store.getSnapshot, theme(value) { if (value === 'dark') document.body.setAttribute('data-ds-dark-theme', ''); else document.body.removeAttribute('data-ds-dark-theme') } }
