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
import { createDatasetStore, datasetActive } from '../../src/client/dataset-store.ts'
import { createDatasetWorkspace } from '../../src/client/dataset-workspace.tsx'
import { createStyleProfileDialog } from '../../src/client/style-profile-dialog.tsx'
import { createDatasetProgress, datasetNotice } from '../../src/client/dataset-progress.tsx'
import { zh } from '../../src/client/workbench-locale.ts'
import pluginCss from '../../src/client/entry.css'
import '../../../../../packages/client/ui-theme/src/styles/base.css'
import '../../../../../packages/client/ui-theme/src/styles/corner-shape.css'
import '../../../../../packages/client/ui-theme/src/styles/design-platform.css'
import '../../../../../packages/client/ui-theme/src/styles/personalization.css'
import '../../../../../packages/client/ui-theme/src/styles/focus.css'

const ui = { Button, Checkbox, Input, TextArea, Modal, Tag, StateDot, Menu, SegmentedTabs, DisclosureRow, ...icons }
const h = React.createElement, t = key => zh[key], data = window.datasetFixtureData
const { style, snapshot, list, detail } = data, original = list.entries[0]
const styleNode = document.createElement('style'); styleNode.textContent = pluginCss; document.head.append(styleNode)
let synthetic, acknowledge, rejectLists = false, starts = 0
const acknowledgement = new Promise(resolve => { acknowledge = resolve })
const store = createDatasetStore({ context: () => ({ scope: 1, styleId: style.styleId }), invoke: async (operation, args) => {
  if (operation === 'export-start') { starts++; await acknowledgement; return { runId: 'qa-dataset-run' } }
  if (operation === 'datasets-list') {
    if (rejectLists) throw new Error('Fixture metadata unavailable')
    let entries = synthetic ? [synthetic, ...list.entries] : list.entries, allTotal = entries.length
    if (args.query) entries = entries.filter(row => `${row.name} ${row.model} ${row.id}`.includes(args.query))
    if (args.status === 'completed') entries = entries.filter(row => row.status === 'completed')
    if (args.status === 'active') entries = entries.filter(row => datasetActive(row.status))
    if (args.status === 'failed') entries = entries.filter(row => ['failed', 'cancelled', 'interrupted'].includes(row.status))
    return { styleId: style.styleId, entries, total: entries.length, allTotal }
  }
  if (operation === 'dataset-get') return { ...detail, entry: args.id === synthetic?.id ? synthetic : original }
  throw new Error(`Unexpected fixture operation: ${operation}`)
} })
const actions = { datasets: store, execute: async () => { throw new Error('Fixture edits are disabled') } }
const Datasets = createDatasetWorkspace(React, ui), Dialog = createStyleProfileDialog(React, ui), Progress = createDatasetProgress(React, ui)
function useDatasets(select) { return select(React.useSyncExternalStore(store.subscribe, store.getSnapshot)) }
function App() {
  const [view, setView] = React.useState('references'), [open, setOpen] = React.useState(false)
  const state = useDatasets(value => value), notice = datasetNotice(state, style.styleId)
  return h('div', { className: 'vc-page-frame' }, h('section', { className: 'vc-workbench' }, h('div', { className: 'vc-image-workspace', 'data-view': view },
    h('div', { className: 'vc-execution-nav' }, h(SegmentedTabs, { variant: 'underline', label: t('workbench'), value: view, onChange: setView, items: [{ value: 'references', label: t('referencesView'), id: 'references-tab', panelId: 'references' }, { value: 'datasets', label: t('datasets'), id: 'datasets-tab', panelId: 'datasets' }] })),
    view === 'datasets' ? h('div', { className: 'vc-datasets-panel' }, h(Datasets, { useDatasets, actions, t, canGenerate: true, onGenerate: () => setOpen(true) })) : h('div', { className: 'vc-reference-panel' }, h('div', { className: 'vc-library-pane' },
      h(Progress, { ...notice, t, readError: state.error, onOpen: () => setOpen(true), onView: () => setView('datasets'), onRetry: () => store.start({ id: style.modelProfile.id, styleId: style.styleId }) }), h('div', { className: 'vc-profile-dock' }, h(Button, { onClick: () => setOpen(true) }, t('openProfile'))))),
    h(Dialog, { open, onClose: () => setOpen(false), onAnalyze: () => {}, canAnalyze: false, style, snapshot, actions, t, busy: false, useDatasets }))))
}
store.sync()
const root = createRoot(document.getElementById('root')); root.render(h(App))
const timer = setInterval(() => { if (store.needsPoll()) void store.poll() }, snapshot.configuration.limits.processPollIntervalMs)
window.addEventListener('beforeunload', () => { clearInterval(timer); store.dispose(); root.unmount() }, { once: true })
window.datasetQa = {
  progress(status, phase, completed, total) {
    const { exportId, downloadPath, byteLength, ...base } = original
    synthetic = status === 'completed' ? { ...original, id: 'qa-dataset-run', runId: 'qa-dataset-run', createdAt: '2026-10-29T00:00:00Z' } : { ...base, id: 'qa-dataset-run', runId: 'qa-dataset-run', createdAt: '2026-10-29T00:00:00Z', status, counts: { ...base.counts, files: 0 }, progress: { phase, completed, total, unit: phase === 'files' ? 'files' : 'samples' } }
    return store.poll()
  },
  acknowledge: () => acknowledge(),
  failReads(value) { rejectLists = value },
  starts: () => starts,
}
