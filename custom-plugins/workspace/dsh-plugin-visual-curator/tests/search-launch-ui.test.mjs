import test from 'node:test'
import assert from 'node:assert/strict'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createSearchLaunchUI } from '../src/client/search-launch-dialog.tsx'
import { en } from '../src/client/workbench-locale.ts'

const field = tag => ({ children, name, value, onChange, disabled, required, type, min, max, step, rows, maxLength }) => React.createElement(tag, { name, value, onChange, disabled, required, type, min, max, step, rows, maxLength }, children)
const ui = new Proxy({
  Button: ({ children, disabled, type, form }) => React.createElement('button', { disabled, type, form }, children),
  Modal: ({ title, children, footer }) => React.createElement('section', null, title, children, footer),
  Menu: ({ anchor, children }) => React.createElement('div', null, anchor, children),
  Input: field('input'), TextArea: field('textarea'),
  DisclosureRow: ({ title, children }) => React.createElement('section', null, title, children),
  Tag: ({ children }) => React.createElement('span', null, children),
}, { get(target, key) { return target[key] ?? (() => null) } })
const { Dialog, Background } = createSearchLaunchUI(React, ui)
const actions = { loadOptions() {}, refresh() {}, loadDatasets() {}, openSession() {}, start() {}, retry() {}, stop() {} }
const t = key => en[key]
const input = { operationId: '00000000-0000-4000-8000-000000000001', workspaceId: 'missing', modelProfileId: 'profile', taskBrief: 'Find quiet landscapes', targetCount: 2, output: { kind: 'preview' }, executionMode: 'conversation' }
const entry = { id: input.operationId, input, sessionId: 'session', sessionReady: true, stage: 'accepted', status: 'failed', runIds: [], qualified: 0, error: { code: 'reference-unavailable', stage: 'search-launch', safeMessage: 'Workspace unavailable' } }
const state = entries => ({ entries, submission: null, optionsLoading: false, loading: false, options: { workspaces: [], visionModels: [], usages: [], maxTargetCount: 10, datasetSelection: 'required', previewSearch: true, conversationModelSelection: true, automaticDatasetPreparation: true, negativeReferenceDatasets: true }, datasetOptions: { modelProfileId: 'profile', loading: false, entries: [], total: 0 } })
const style = { styleId: 'style', name: 'Landscape', modelProfile: { id: 'profile', revision: 1, stale: false } }
const snapshot = { configuration: { visionConfigured: true, vision: { model: 'vision' }, limits: { maxCandidates: 10 } }, usages: [] }
const dialog = value => renderToStaticMarkup(React.createElement(Dialog, { open: true, onClose() {}, style, snapshot, actions, t, useLaunches: select => select(value) }))

test('new search defaults to preview finding and presents wallpaper as an explicit output choice', () => {
  const html = dialog(state([]))
  assert.match(html, /Find images only \(preview links\)/)
  assert.match(html, /value="preview" selected=""/)
  assert.match(html, /Make wallpapers/)
  assert.match(html, /Start image search/)
})
test('a missing saved Workspace offers a new Workspace selection without a terminal stop action', () => {
  const html = dialog(state([entry]))
  assert.ok(html.includes(en.searchLaunchWorkspaceUnavailable))
  assert.ok(html.includes(en.searchLaunchChooseWorkspace))
  assert.ok(!html.includes(en.searchLaunchStop))
})
test('stop follows actual active search or wallpaper work rather than a failed admission label', () => {
  const summary = value => renderToStaticMarkup(React.createElement(Background, { actions, t, useLaunches: select => select(state([value])) }))
  assert.ok(!summary({ ...entry, runIds: ['run'], runStatus: 'failed' }).includes(en.searchLaunchStop))
  assert.ok(summary({ ...entry, runIds: ['run'], runStatus: 'running', wallpaper: { status: 'failed', total: 2, passed: 0 } }).includes(en.searchLaunchStop))
})

test('the configured native model is pinned to its conversation without changing the global default', () => {
 let submit, launched
 const runtime = { ...React, createElement(type, props, ...children) { if (type === 'form') submit = props.onSubmit; return React.createElement(type, props, ...children) } }
 const { Dialog: CapturedDialog } = createSearchLaunchUI(runtime, ui)
 const configured = { ...snapshot, configuration: { ...snapshot.configuration, vision: { backend: 'native', provider: 'selected-provider', model: 'selected-model' } } }
 renderToStaticMarkup(React.createElement(CapturedDialog, { open: true, fresh: true, onClose() {}, style, snapshot: configured, actions: { ...actions, start(input) { launched = input } }, t, useLaunches: select => select(state([])) }))
 submit({ preventDefault() {} })
 assert.deepEqual(launched.conversationModel, { provider: 'selected-provider', model: 'selected-model' })
 assert.equal(launched.executionMode, 'conversation')
 assert.equal(launched.wallpaper, undefined)
})
