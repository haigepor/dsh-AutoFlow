import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createAfpClientStore } from '../src/client/afp-client-store.js'
import { createAfpAddFavoritesDialog } from '../src/client/afp-add-favorites-dialog.js'
import { createWorkbench } from '../src/client/afp-workbench.js'
import zh from '../src/client/locales/zh.json' with { type: 'json' }

const collections = [{ id: 'target', name: '旅游', readOnly: false, count: 4 }, { id: 'shared', name: '共享', readOnly: true }, { id: 'unnamed', name: '', readOnly: false }]
const region = data => ({ data, loading: false, error: '' })
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function harness() {
  const calls = [], writes = []
  const store = createAfpClientStore({ remote: { pluginManager: { invokeAction: async (_name, _action, args) => {
    const wait = deferred(); writes.push({ ...args, args: JSON.parse(args.args), wait }); return wait.promise
  } } } }, { baseURI: 'https://local/', fetchImpl: async (_url, args) => {
    const wait = deferred(); calls.push({ ...JSON.parse(args.body), wait }); return wait.promise
  } })
  store.set({ status: { features: ['read', 'write'] }, regions: { ...store.getSnapshot().regions, collections: region({ items: collections }) } })
  return { store, calls, writes, reply(index, value = { items: collections }) { calls[index].wait.resolve({ ok: true, json: async () => ({ ok: true, value }) }) },
    result(index, result) { writes[index].wait.resolve({ ok: true, value: { output: JSON.stringify(result) } }) } }
}

test('addition snapshots selected photos, waits for target refresh and preserves live selection and other memberships', async () => {
  const h = harness(), store = h.store
  store.selectPhoto({ id: 'first' }, 'source')
  assert.equal(store.openAddFavorites(), true)
  assert.equal(h.writes.length, 0)
  assert.equal(await store.addFavorites('target'), false)
  h.reply(0); await new Promise(resolve => setImmediate(resolve))
  store.selectPhoto({ id: 'second' }, 'other')
  store.selectPhoto({ id: 'first' }, 'another')
  const pending = store.addFavorites('target')
  assert.deepEqual(h.writes[0].args, { action: 'copy', photoIds: ['first'], photoSources: { first: ['source'] }, targetCollectionId: 'target' })
  assert.equal(await store.addFavorites('target'), false)
  store.closeAddFavorites()
  assert.ok(store.getSnapshot().favoritesRequest)
  h.result(0, { completed: 1, failed: 0, pending: 0, items: [{ photoId: 'first', status: 'completed', membershipChange: 'added' }] })
  await new Promise(resolve => setImmediate(resolve))
  h.calls[1].wait.reject(new Error('refresh unavailable'))
  assert.equal(await pending, true)
  assert.equal(store.getSnapshot().favoritesResult.completed, 1)
  assert.deepEqual(store.getSnapshot().photoSources.first, ['source', 'another', 'target'])
  assert.deepEqual(Object.keys(store.getSnapshot().selectedPhotos), ['first', 'second'])
  assert.equal(await store.addFavorites('target'), false)
  assert.equal(h.writes.length, 1)
  store.closeAddFavorites(); assert.equal(store.getSnapshot().favoritesRequest, null)
  await store.dispose()
})

test('read-only targets, missing write access and oversized batches never submit', async () => {
  const h = harness(), store = h.store
  assert.equal(store.openAddFavorites(), false)
  store.selectPhoto({ id: 'photo' })
  store.set({ status: { features: ['read'] } }); assert.equal(store.openAddFavorites(), false)
  store.set({ status: { features: ['read', 'write'] } })
  store.openAddFavorites(); h.reply(0); await new Promise(resolve => setImmediate(resolve))
  for (const id of ['shared', 'unnamed', 'missing']) assert.equal(await store.addFavorites(id), false)
  store.set({ status: { features: ['read'] } }); assert.equal(await store.addFavorites('target'), false)
  store.closeAddFavorites(); store.set({ status: { features: ['read', 'write'] } })
  for (let index = 0; index < 120; index++) store.selectPhoto({ id: `extra-${index}` })
  assert.equal(store.openAddFavorites(), false)
  assert.equal(h.writes.length, 0)
  await store.dispose()
})

test('ambiguous write results are not retried and account resets discard late responses', async () => {
  for (const mode of ['error', 'reset']) {
    const h = harness(), store = h.store
    store.selectPhoto({ id: 'photo' }); store.openAddFavorites(); h.reply(0); await new Promise(resolve => setImmediate(resolve))
    const pending = store.addFavorites('target')
    if (mode === 'error') h.writes[0].wait.reject(new Error('ambiguous response'))
    else { store.resetData(); h.result(0, { completed: 1, items: [{ photoId: 'photo', status: 'completed' }] }) }
    assert.equal(await pending, false)
    assert.equal(h.writes.length, 1)
    assert.equal(store.getSnapshot().favoritesResult, null)
    assert.equal(Boolean(store.getSnapshot().favoritesError), mode === 'error')
    assert.equal(store.getSnapshot().favoritesBusy, false)
    await store.dispose()
  }
})

function element(type, props, ...children) { return { type, props: { ...props, children } } }
function nodes(tree, match) {
  if (Array.isArray(tree)) return tree.flatMap(item => nodes(item, match))
  if (!tree || typeof tree !== 'object') return []
  return [...(match(tree) ? [tree] : []), ...nodes(tree.props?.children, match)]
}
function copy(tree) { return Array.isArray(tree) ? tree.map(copy).join(' ') : tree && typeof tree === 'object' ? copy(tree.props?.children) : String(tree ?? '') }
const UI = Object.fromEntries(['Modal', 'Input', 'Button', 'Tag', 'StateDot', 'Tooltip'].map(name => [name, Symbol(name)]))
const t = key => zh[key] ?? key

test('confirmation uses writable named targets and displays new, existing, failed and uncertain results with legacy fallback', () => {
  const store = createAfpClientStore({}), calls = [], slots = []
  store.addFavorites = id => calls.push(id)
  const state = { ...store.getSnapshot(), status: { features: ['read', 'write'] }, favoritesRequest: { photos: [{ id: 'photo', title: 'Title' }] },
    regions: { ...store.getSnapshot().regions, collections: region({ items: collections }) } }
  let cursor = 0
  const React = { createElement: element, Fragment: Symbol('Fragment'), useEffect() {}, useState(initial) {
    const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], value => { slots[index] = value }]
  } }
  const Dialog = createAfpAddFavoritesDialog(React, UI, {}, t, store, () => null)
  const render = () => { cursor = 0; return Dialog({ state }) }
  const action = tree => nodes(tree.props.footer, node => node.type === UI.Button && copy(node) === zh.confirmAddFavorites)[0]
  assert.equal(action(render()).props.disabled, true)
  const targets = nodes(render(), node => node.type === UI.Button && node.props['aria-pressed'] !== undefined)
  assert.equal(targets.length, 1)
  targets[0].props.onClick()
  assert.equal(action(render()).props.disabled, false)
  action(render()).props.onClick(); assert.deepEqual(calls, ['target'])
  state.favoritesBusy = true
  const busy = nodes(render().props.footer, node => node.props?.['aria-busy'])[0]
  assert.equal(busy.props.disabled, true)
  assert.equal(busy.props.icon.type, UI.StateDot)
  state.favoritesBusy = false
  state.favoritesResult = { completed: 2, failed: 1, pending: 1, items: [
    { photoId: 'new', status: 'completed', membershipChange: 'added' }, { photoId: 'old', status: 'completed', membershipChange: 'already-present' },
    { photoId: 'missing', status: 'failed' }, { photoId: 'uncertain', status: 'pending' }] }
  const text = copy(render())
  for (const label of ['新加入 1 张', '已存在 1 张', '失败 1 张', '待核实 1 张']) assert.ok(text.includes(label))
  state.favoritesResult = { completed: 1, items: [{ photoId: 'photo', status: 'completed' }] }
  assert.ok(copy(render()).includes('已完成 1 张'))
  assert.equal(copy(render()).includes('新加入'), false)
  store.dispose()
})

test('search toolbar action states follow the selected batch and feature permissions', async () => {
  const store = createAfpClientStore({})
  const React = { createElement: element, useId: () => 'search', useSyncExternalStore: (_subscribe, snapshot) => snapshot() }
  const Workbench = createWorkbench(React, UI, {}, t, store, () => null)
  const panel = nodes(Workbench(), node => node.type?.name === 'SearchPanel')[0].type
  const describe = (count, features, busy = false) => {
    const state = { ...store.getSnapshot(), status: { features }, busy,
      selectedPhotos: Object.fromEntries(Array.from({ length: count }, (_, index) => [index, { id: String(index) }])),
      regions: { ...store.getSnapshot().regions, search: region({ items: [], hasMore: false }) } }
    const button = nodes(panel({ state }), node => node.type === UI.Button && node.props['aria-label'] === zh.addFavorites)[0]
    return { count, features, busy, disabled: button.props.disabled }
  }
  const output = [describe(0, ['read', 'write']), describe(1, ['read']), describe(1, ['read', 'write']), describe(121, ['read', 'write']), describe(1, ['read', 'write'], true)]
  const expected = JSON.parse(await readFile(new URL('./fixtures/search-favorites.json', import.meta.url), 'utf8'))
  assert.deepEqual(output, expected)
  store.dispose()
})

test('collection select-all still renders its loading icon alongside the new addition flow', () => {
  const store = createAfpClientStore({})
  const React = { createElement: element, useId: () => 'select', useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useEffect() {}, useRef: () => ({ current: null }), useState: initial => [initial, () => {}] }
  const Workbench = createWorkbench(React, UI, {}, t, store, () => null)
  const state = { ...store.getSnapshot(), collectionSelecting: true, status: { features: ['read', 'write'] } }
  const panel = nodes(Workbench(), node => node.type?.name === 'CollectionsPanel')[0].type({ state })
  const component = nodes(panel, node => node.type?.name === 'CollectionSelectionActions')[0]
  const action = nodes(component.type({ state }), node => node.props?.['aria-busy'])[0]
  assert.equal(action.props.icon.type, UI.StateDot)
  store.dispose()
})
