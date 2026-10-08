import test from 'node:test'
import assert from 'node:assert/strict'
import { createAfpDownloadOverlay } from '../src/client/afp-download-overlay.js'

function element(type, props, ...children) { return { type, props: { ...props, children } } }
function nodes(tree, match) {
  if (Array.isArray(tree)) return tree.flatMap(item => nodes(item, match))
  if (!tree || typeof tree !== 'object') return []
  return [...(match(tree) ? [tree] : []), ...nodes(tree.props?.children, match)]
}
const UI = Object.fromEntries(['Button', 'Tag', 'Toast', 'StateDot', 'Tooltip', 'Menu'].map(name => [name, Symbol(name)]))
UI.useDismissOnOutsidePointer = () => {}
function harness(overrides = {}) {
  const state = { status: { downloads: [], tasks: [] }, downloadDockOpen: false, downloadNotice: null, ...overrides }
  const calls = []
  const store = { subscribe() {}, getSnapshot: () => state, set: update => Object.assign(state, update),
    dismissDownloadNotice(id) { calls.push(['dismiss', id]); if (state.downloadNotice?.id === id) state.downloadNotice = null },
    cancelDownload(id) { calls.push(['cancel', id]) }, selectTab(tab) { calls.push(['tab', tab]) } }
  let cursor = 0
  const hooks = []
  const React = { createElement: element, Fragment: Symbol('Fragment'), useEffect() {}, useId: () => 'download-dock',
    useRef: () => ({ current: null }), useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = initial; return [hooks[index], value => { hooks[index] = value }] } }
  const Overlay = createAfpDownloadOverlay(React, UI, {}, key => key, store)
  return { state, calls, render: () => { cursor = 0; return Overlay() } }
}

test('download notification opens a dock that starts collapsed and survives workbench navigation', () => {
  const { render, state, calls } = harness({ downloadNotice: { id: 'batch', kind: 'started', total: 2 },
    downloadResult: { downloadId: 'batch', taskId: 'task', total: 2 } })
  const initial = render(), panel = nodes(initial, node => node.type === 'aside')[0]
  assert.equal(panel.props.inert, '')
  assert.equal(panel.props['aria-hidden'], true)
  const toast = nodes(initial, node => node.type === UI.Toast)[0]
  assert.equal(toast.props.tone, 'success')
  toast.props.actions[0].onClick()
  state.tab = 'account'
  assert.equal(nodes(render(), node => node.type === 'aside')[0].props.inert, undefined)
  toast.props.onDone()
  assert.deepEqual(calls, [['dismiss', 'batch']])
  assert.equal(state.downloadDockOpen, true)
  const event = { key: 'Escape', stopPropagation() {}, preventDefault() {} }
  nodes(render(), node => node.props?.className?.startsWith('afp-download-overlay'))[0].props.onKeyDown(event)
  assert.equal(state.downloadDockOpen, false)
})

test('dock prioritizes active batches, counts processed items and cancels only live tasks', () => {
  const { render, calls } = harness({ downloadDockOpen: true, status: { tasks: [{ taskId: 'task' }], downloads: [
    { id: 'old', status: 'completed', total: 1, completed: 1, updatedAt: 10, items: [] },
    { id: 'active', taskId: 'task', status: 'running', total: 5, completed: 2, failed: 1, pending: 0, updatedAt: 9, items: [] },
  ] } })
  const tree = render(), rows = nodes(tree, node => node.type === 'article')
  assert.deepEqual(rows.map(node => node.props.key), ['active', 'old'])
  const progress = nodes(rows[0], node => node.type === 'progress')[0]
  assert.equal(progress.props.max, 5)
  assert.equal(progress.props.value, 3)
  const cancel = nodes(tree, node => node.type === UI.Button && node.props['data-download-cancel'])[0]
  cancel.props.onClick()
  assert.deepEqual(calls, [['cancel', 'task']])
  assert.equal(nodes(rows[1], node => node.props?.['data-download-cancel']).length, 0)
})

test('empty history leaves no edge control and cancellation failure uses safe copy', () => {
  assert.equal(harness().render(), null)
  const { render } = harness({ downloadNotice: { id: 'failed', kind: 'cancelFailed' } })
  const toast = nodes(render(), node => node.type === UI.Toast)[0]
  assert.equal(toast.props.text, 'downloadCancelFailed')
  assert.equal(toast.props.tone, undefined)
})

test('hiding the download entry preserves active records and notifications can reopen it', () => {
  const records = [{ id: 'batch', taskId: 'task', status: 'running', total: 2, updatedAt: 1 }]
  const h = harness({ status: { downloads: records }, downloadDockOpen: true })
  nodes(h.render(), node => node.type === UI.Menu)[0].props.onSelect('hide')
  assert.equal(h.state.downloadDockHidden, true)
  assert.equal(h.state.downloadDockOpen, false)
  assert.equal(nodes(h.render(), node => node.type === UI.Menu).length, 0)
  assert.equal(h.state.status.downloads, records)
  assert.deepEqual(h.calls, [])
  h.state.tab = 'account'
  assert.equal(nodes(h.render(), node => node.type === UI.Button && node.props.className === 'afp-download-edge').length, 0)
  h.state.downloadNotice = { id: 'notice', kind: 'started', total: 2 }
  nodes(h.render(), node => node.type === UI.Toast)[0].props.actions[0].onClick()
  assert.equal(h.state.downloadDockHidden, false)
  assert.equal(h.state.downloadDockOpen, true)
  assert.equal(nodes(h.render(), node => node.type === UI.Menu).length, 1)
})

test('download edge uses an SVG and its context menu opens progress or the task page', () => {
  const h = harness({ status: { features: ['ui-panel'], downloads: [{ id: 'batch', status: 'running', total: 2, updatedAt: 1 }] } })
  const menu = nodes(h.render(), node => node.type === UI.Menu)[0]
  assert.equal(menu.props.open, false)
  const edge = menu.props.anchor
  assert.equal(nodes(edge, node => node.type === 'svg').length, 1)
  let prevented = false
  edge.props.onContextMenu({ preventDefault() { prevented = true }, stopPropagation() {} })
  assert.equal(prevented, true)
  const opened = nodes(h.render(), node => node.type === UI.Menu)[0]
  assert.equal(opened.props.open, true)
  assert.equal(opened.props.portal, true)
  assert.equal(opened.props.autoFocus, true)
  assert.equal(opened.props.anchor.props['aria-expanded'], true)
  opened.props.onSelect('progress')
  assert.equal(h.state.downloadDockOpen, true)
  assert.equal(nodes(h.render(), node => node.type === UI.Menu)[0].props.open, false)
  edge.props.onKeyDown({ key: 'F10', shiftKey: true, preventDefault() {}, stopPropagation() {} })
  nodes(h.render(), node => node.type === UI.Menu)[0].props.onSelect('tasks')
  assert.deepEqual(h.calls, [['tab', 'tasks']])
  assert.equal(h.state.downloadDockOpen, false)
})
