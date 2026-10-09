import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createWorkbench } from '../src/client/afp-workbench.js'
import { createAfpTaskPanels } from '../src/client/afp-workbench-tasks.js'
import { createAfpClientStore } from '../src/client/afp-client-store.js'
import { createAfpGallery } from '../src/client/afp-workbench-gallery.js'

function element(type, props, ...children) { return { type, props: { ...props, children } } }
function nodes(tree, match) {
  if (Array.isArray(tree)) return tree.flatMap(item => nodes(item, match))
  if (!tree || typeof tree !== 'object') return []
  return [...(match(tree) ? [tree] : []), ...nodes(tree.props?.children, match)]
}
const UI = Object.fromEntries(['Button', 'Input', 'Tag', 'Checkbox', 'StateDot', 'Tooltip'].map(name => [name, Symbol(name)]))
const React = { createElement: element, useId: () => 'tabs', useRef: () => ({ current: null }), useState: value => [value, () => {}], useSyncExternalStore: (_subscribe, snapshot) => snapshot() }
const t = key => key

function search(state, store) {
  const Workbench = createWorkbench(React, UI, {}, t, store, () => null)
  return nodes(Workbench(), node => node.type?.name === 'SearchPanel')[0].type({ state })
}
function refresh(state, store) {
  const Panels = createAfpTaskPanels(React, UI, t, store, {}, () => null)
  const tree = Panels.TasksPanel({ state })
  return nodes(tree, node => node.type?.name === 'RefreshForm')[0].type({ state })
}
function readyState(store) {
  return { ...store.getSnapshot(), status: { features: ['read', 'refresh', 'write'], tasks: [] },
    account: { visionConfigured: true, credentials: { accessTokenRef: { configured: true }, visionKeyRef: { configured: true } } },
    selected: ['animals'], targetPerCategory: 100, threshold: .8 }
}

test('screening controls reject out-of-range values before submitting a task', () => {
  const store = createAfpClientStore({}), calls = []
  store.invoke = (...args) => calls.push(args)
  const initial = readyState(store)
  for (const values of [{ targetPerCategory: 0 }, { targetPerCategory: 1001 }, { targetPerCategory: 1.5 }, { threshold: .79 }, { threshold: NaN }, { threshold: 1.01 }]) {
    const tree = refresh({ ...initial, ...values }, store)
    assert.equal(nodes(tree, node => node.type === UI.Button && node.props.type === 'submit')[0].props.disabled, true)
    nodes(tree, node => node.type === 'form')[0].props.onSubmit({ preventDefault() {} })
  }
  assert.equal(calls.length, 0)
  for (const [targetPerCategory, threshold] of [[1, .8], [1000, 1]]) {
    const tree = refresh({ ...initial, targetPerCategory, threshold }, store)
    assert.equal(nodes(tree, node => node.type === UI.Button && node.props.type === 'submit')[0].props.disabled, false)
    nodes(tree, node => node.type === 'form')[0].props.onSubmit({ preventDefault() {} })
  }
  assert.equal(calls.length, 2)
  store.dispose()
})

test('search distinguishes empty results from an initial prompt and exposes busy controls', async () => {
  const store = createAfpClientStore({}), state = readyState(store)
  const describe = tree => ({
    empty: nodes(tree, node => node.props?.className === 'afp-wb-empty-block').map(node => nodes(node, row => row.type === 'p')[0]?.props.children[0]),
    busy: nodes(tree, node => node.type === UI.Button && node.props.type === 'submit')[0].props['aria-busy'] ?? false,
    spinners: nodes(tree, node => node.type === UI.Button && node.props.icon?.type === UI.StateDot).length,
  })
  const empty = { ...state, regions: { ...state.regions, search: { data: { items: [], hasMore: false }, loading: false, error: '' } } }
  const busy = { ...state, regions: { ...state.regions, search: { data: null, loading: true, error: '' } } }
  const output = [describe(search(state, store)), describe(search(empty, store)), describe(search(busy, store))]
  const expected = JSON.parse(await readFile(new URL('./fixtures/tab-presentation.json', import.meta.url), 'utf8'))
  assert.deepEqual(output, expected)
  store.dispose()
})

test('load-more uses gallery-sized skeletons and keeps its loading state off the search button', () => {
  const store = createAfpClientStore({}), state = readyState(store)
  const more = { ...state, regions: { ...state.regions, search: { data: { items: [{ id: '1' }], hasMore: true }, loading: true, loadMode: 'more', error: '' } } }
  const tree = search(more, store)
  const searchButton = nodes(tree, node => node.type === UI.Button && node.props.type === 'submit')[0]
  assert.equal(searchButton.props['aria-busy'], false)
  const gallery = nodes(tree, node => node.type?.name === 'PhotoGrid')[0]
  assert.equal(gallery.props.loading, true)
  assert.equal(nodes(tree, node => node.props?.className === 'afp-wb-more-skeleton').length, 0)
  store.dispose()
})

test('pagination failure retries the retained page rather than restarting search', () => {
  const store = createAfpClientStore({}), state = readyState(store), calls = []
  store.searchPhotos = args => calls.push(args)
  const failed = { ...state, regions: { ...state.regions, search: { data: { items: [{ id: '1' }], hasMore: true }, loading: false, loadMode: 'more', error: 'failure' } } }
  const tree = search(failed, store)
  nodes(tree, node => node.type === UI.Button && node.props.children[0] === 'retry')[0].props.onClick()
  assert.deepEqual(calls, [{ more: true }])
  store.dispose()
})

test('opening a report shows its loading or retry state without substituting history', () => {
  const store = createAfpClientStore({}), state = readyState(store), calls = []
  store.openRun = (...args) => calls.push(args)
  const Panels = createAfpTaskPanels(React, UI, t, store, {}, () => null)
  const render = region => Panels.TasksPanel({ state: { ...state, runId: 'report-id', regions: { ...state.regions, run: region } } })
  const loading = render({ data: null, loading: true, error: '' })
  assert.equal(nodes(loading, node => node.type?.name === 'HistorySkeleton').length, 1)
  assert.equal(nodes(loading, node => node.type?.name === 'RunHistory').length, 0)
  const failed = render({ data: null, loading: false, error: 'unavailable' })
  assert.equal(nodes(failed, node => node.props?.role === 'alert').length, 1)
  const retry = nodes(failed, node => node.type === UI.Button && node.props.children[0] === 'retry')[0]
  retry.props.onClick()
  assert.deepEqual(calls, [['report-id', { category: '', decision: 'all' }]])
  store.dispose()
})

test('change setup still previews first and requires explicit confirmation before writing', () => {
  const store = createAfpClientStore({}), state = readyState(store), calls = []
  store.previewPlan = () => calls.push('preview')
  store.confirmPlan = () => calls.push('confirm')
  const Panels = createAfpTaskPanels(React, UI, t, store, {}, () => null)
  const render = patch => Panels.ChangesPanel({ state: { ...state, ...patch } })
  const action = tree => nodes(tree, node => node.type === UI.Button && node.props.children[0] === 'previewWrite')[0]
  assert.equal(action(render({ operation: 'append', runId: '' })).props.disabled, true)
  action(render({ operation: 'clear' })).props.onClick()
  assert.deepEqual(calls, ['preview'])
  const plan = { expiresAt: Date.now() + 60000, categories: [{ category: 'animals', selectionName: 'Target', existing: 4, remove: 4, add: 0 }] }
  const card = patch => {
    const tree = render({ plan, operation: 'clear', ...patch })
    return nodes(tree, node => node.type?.name === 'PlanCard')[0].type({ state: { ...state, plan, ...patch } })
  }
  const confirm = tree => nodes(tree, node => node.type === UI.Button && node.props.children[0] === 'confirm')[0]
  assert.equal(confirm(card({ confirmChecked: false })).props.disabled, true)
  assert.equal(confirm(card({ confirmChecked: true })).props.disabled, false)
  assert.equal(confirm(card({ confirmChecked: true, plan: { ...plan, expiresAt: 0 } })).props.disabled, true)
  assert.equal(nodes(card({}), node => node.props?.className === 'afp-wb-warning').length, 1)
  store.dispose()
})

test('task setup collapses without losing the draft, report, filters or selected photos', () => {
  const store = createAfpClientStore({})
  store.set({ ...readyState(store), runId: 'saved-run', reportFilter: 'kept', selectedPhotos: { one: { id: 'one' } } })
  const Panels = createAfpTaskPanels(React, UI, t, store, {}, () => null)
  const render = () => Panels.TasksPanel({ state: store.getSnapshot() })
  const toggle = tree => nodes(tree, node => node.props?.['aria-controls'] === 'tabs')[0]
  const before = store.getSnapshot()
  assert.equal(toggle(render()).props['aria-expanded'], true)
  toggle(render()).props.onClick()
  const collapsed = render()
  assert.equal(toggle(collapsed).props['aria-expanded'], false)
  assert.equal(nodes(collapsed, node => node.props?.className === 'afp-wb-task-sidebar-content')[0].props.inert, '')
  assert.equal(nodes(collapsed, node => node.props?.className === 'afp-wb-task-sidebar-content')[0].props['aria-hidden'], true)
  assert.equal(nodes(collapsed, node => node.type?.name === 'RefreshForm').length, 1)
  assert.equal(store.getSnapshot().selected, before.selected)
  assert.equal(store.getSnapshot().selectedPhotos, before.selectedPhotos)
  assert.equal(store.getSnapshot().runId, before.runId)
  assert.equal(store.getSnapshot().reportFilter, 'kept')
  toggle(collapsed).props.onClick()
  assert.equal(nodes(render(), node => node.props?.className === 'afp-wb-task-sidebar-content')[0].props.inert, undefined)
  store.dispose()
})

test('report card icon actions inspect any photo but only select completed passes', () => {
  const calls = [], store = { openPhoto: photo => calls.push(['details', photo.id]),
    selectPhoto: photo => calls.push(['select', photo.id]), removePhoto: id => calls.push(['remove', id]) }
  const gallery = createAfpGallery(React, UI, { IconFlatListOutlineRegular: Symbol('details'), IconCheckOutlineRegular: Symbol('select') }, t, store)
  const items = [{ id: 'passed', category: 'food', keep: true }, { id: 'rejected', keep: false },
    { id: 'failed', keep: true, requestFailed: true }, { id: 'pending' }]
  const render = selectedPhotos => gallery.PhotoGrid({ items, report: true, selectedPhotos })
  const cards = nodes(render({}), node => node.type === 'article')
  cards.forEach((card, index) => {
    const actions = nodes(card, node => node.props?.className === 'afp-wb-photo-review-actions')[0]
    const buttons = nodes(nodes(actions, node => node.type?.name === 'ReviewAction').map(node => node.type(node.props)), node => node.type === UI.Button)
    assert.equal(buttons.length, 2)
    assert.equal(buttons[0].props['aria-label'], 'photoDetails')
    assert.equal(buttons[1].props['aria-label'], 'selectPhoto')
    assert.equal(buttons[1].props.disabled, index !== 0)
    buttons[0].props.onClick()
  })
  const selectedAction = nodes(render({ passed: items[0] }), node => node.type?.name === 'ReviewAction' && node.props.label === 'removeFromSelection')[0]
  const selected = selectedAction.type(selectedAction.props)
  nodes(selected, node => node.type === UI.Button)[0].props.onClick()
  assert.deepEqual(calls, [['details', 'passed'], ['details', 'rejected'], ['details', 'failed'], ['details', 'pending'], ['remove', 'passed']])
})
