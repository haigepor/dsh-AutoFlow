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
const originalProfileSamples = style.modelProfile.samples
const originalAnalysisSamples = style.analysis?.samples
const styleNode = document.createElement('style'); styleNode.textContent = pluginCss; document.head.append(styleNode)
let synthetic, acknowledge, rejectLists = false, starts = 0, profileHold = false, loseProfileAck = false, profileRevision = 0, paging = false, failSamplePage = false, readHold = false
const profileWaiters = [], profileCalls = [], profileReceipts = new Map(), sampleReads = [], exportedProfiles = [], exportedScopes = [], readWaiters = []
const acknowledgement = new Promise(resolve => { acknowledge = resolve })
const store = createDatasetStore({ context: () => ({ scope: 1, styleId: style.styleId }), invoke: async (operation, args) => {
  if (operation === 'export-start') { starts++; exportedProfiles.push(args.releaseId); exportedScopes.push(args.sampleScope); await acknowledgement; return { runId: 'qa-dataset-run' } }
  if (operation === 'datasets-list') {
    if (rejectLists) throw new Error('Fixture metadata unavailable')
    let entries = synthetic ? [synthetic, ...list.entries] : list.entries, allTotal = entries.length
    if (args.query) entries = entries.filter(row => `${row.name} ${row.model} ${row.id}`.includes(args.query))
    if (args.status === 'completed') entries = entries.filter(row => row.status === 'completed')
    if (args.status === 'active') entries = entries.filter(row => datasetActive(row.status))
    if (args.status === 'failed') entries = entries.filter(row => ['failed', 'cancelled', 'interrupted'].includes(row.status))
    return { styleId: style.styleId, entries, total: entries.length, allTotal }
  }
  if (operation === 'dataset-get') {
    if (data.samplePages) {
      sampleReads.push({ role: args.sampleRole, cursor: args.pageToken ?? 'first' })
      return data.samplePages[args.id][args.sampleRole ?? 'all'][args.pageToken ?? 'first']
    }
    if (!paging) return { ...detail, entry: args.id === synthetic?.id ? synthetic : original }
    sampleReads.push(args.pageToken ?? 'first')
    if (args.pageToken && failSamplePage) throw new Error('Sample page unavailable')
    const offset = Number(args.pageToken ?? 0), count = 13
    const samples = Array.from({ length: Math.min(5, count - offset) }, (_, index) => ({ ...detail.samples[0], referenceId: `qa-sample-${offset + index}`, imageVersionId: `qa-image-${offset + index}`, previewPath: undefined, previewSize: undefined }))
    return { ...detail, entry: { ...original, counts: { ...original.counts, references: count } }, samples, sampleTotal: count, ...(offset + samples.length < count ? { nextSamplePageToken: String(offset + samples.length) } : { nextSamplePageToken: undefined }) }
  }
  throw new Error(`Unexpected fixture operation: ${operation}`)
} })
const actions = { datasets: store, reconcileProfile: async () => {
  if (readHold) await new Promise(resolve => readWaiters.push(resolve))
  if (style.evidenceLoaded === false) {
    style.modelProfile = { ...style.modelProfile, samples: originalProfileSamples }
    if (style.analysis) style.analysis = { ...style.analysis, samples: originalAnalysisSamples }
    delete style.evidenceLoaded; root.render(h(App))
  }
}, execute: async (operation, args) => {
  if (operation !== 'profile-save') throw new Error('Unexpected fixture edit')
  profileCalls.push(args)
  if (profileHold) await new Promise(resolve => profileWaiters.push(resolve))
  if (profileReceipts.has(args.operationId)) return profileReceipts.get(args.operationId)
  if (args.expectedProfileId !== style.modelProfile.id) throw { code: 'revision-conflict' }
  const profile = style.modelProfile
  style.modelProfile = { ...profile, id: `qa-profile-${++profileRevision}`, options: profile.options.map(option => { const change = args.changes.find(row => row.ruleId === option.rule.ruleId); return change ? { ...option, enabled: change.enabled, rule: { ...option.rule, statement: change.statement ?? option.rule.statement }, selectionSource: 'user', reason: 'user-choice' } : option }) }
  const receipt = { id: style.modelProfile.id, revision: profileRevision }
  profileReceipts.set(args.operationId, receipt); root.render(h(App))
  if (loseProfileAck) { loseProfileAck = false; throw new Error('Profile acknowledgement unavailable') }
  return receipt
} }
const Datasets = createDatasetWorkspace(React, ui), Dialog = createStyleProfileDialog(React, ui), Progress = createDatasetProgress(React, ui)
function useDatasets(select) { return select(React.useSyncExternalStore(store.subscribe, store.getSnapshot)) }
function App() {
  const [view, setView] = React.useState('references'), [open, setOpen] = React.useState(false)
  const state = useDatasets(value => value), notice = datasetNotice(state, style.styleId)
  return h('div', { className: 'vc-page-frame' }, h('section', { className: 'vc-workbench' }, h('div', { className: 'vc-image-workspace', 'data-view': view },
    h('div', { className: 'vc-execution-nav' }, h(SegmentedTabs, { variant: 'underline', label: t('workbench'), value: view, onChange: setView, items: [{ value: 'references', label: t('referencesView'), id: 'references-tab', panelId: 'references' }, { value: 'datasets', label: t('datasets'), id: 'datasets-tab', panelId: 'datasets' }] })),
    view === 'datasets' ? h('div', { className: 'vc-datasets-panel' }, h(Datasets, { useDatasets, actions, t, currentProfile: style.modelProfile, canGenerate: true, onGenerate: () => setOpen(true) })) : h('div', { className: 'vc-reference-panel' }, h('div', { className: 'vc-library-pane' },
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
  holdProfile(value) { profileHold = value },
  releaseProfile() { profileHold = false; for (const resolve of profileWaiters.splice(0)) resolve() },
  loseProfileAck() { loseProfileAck = true },
  profileCalls: () => profileCalls,
  profile: () => style.modelProfile,
  exportedProfiles: () => exportedProfiles,
  exportedScopes: () => exportedScopes,
  previewSamples(role) { return style.modelProfile.samples.filter(sample => sample.role === role).map(sample => sample.image?.name ?? sample.referenceId) },
  markRoleObservations() { style.modelProfile = { ...style.modelProfile, samples: originalProfileSamples.map(sample => ({ ...sample, observations: [...sample.observations, { dimension: 'subject', description: `${sample.role} reference observation`, uncertain: false, requestId: 'role-preview-request' }] })) }; root.render(h(App)) },
  previewCount(count) { const negative = originalProfileSamples.filter(sample => sample.role === 'negative'); style.modelProfile = { ...style.modelProfile, samples: count ? [...originalProfileSamples.filter(sample => sample.role !== 'negative'), ...Array.from({ length: count }, (_, index) => ({ ...negative[index % negative.length], referenceId: `preview-negative-${index}`, image: { ...negative[index % negative.length].image, name: `negative-preview-${index}.png` } }))] : originalProfileSamples }; root.render(h(App)) },
  holdRead(value) { readHold = value },
  deferEvidence(newAnalysis = false) { style.evidenceLoaded = false; style.modelProfile = { ...style.modelProfile, ...(newAnalysis ? { analysisRunId: 'qa-refreshed-analysis' } : {}), samples: [] }; if (style.analysis) style.analysis = { ...style.analysis, ...(newAnalysis ? { runId: 'qa-refreshed-analysis' } : {}), samples: [] }; readHold = true; root.render(h(App)) },
  releaseRead() { readHold = false; readWaiters.splice(0).forEach(resolve => resolve()) },
  negativeOnly() { style.modelProfile = { ...style.modelProfile, samples: style.modelProfile.samples.filter(sample => sample.role === 'negative'), options: style.modelProfile.options.map(option => ({ ...option, enabled: false })) }; root.render(h(App)) },
  enablePaging() { paging = true },
  sampleReads: () => sampleReads,
  failSamplePage(value) { failSamplePage = value },
}
