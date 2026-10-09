import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createWorkbench } from '../src/client/afp-workbench.js'
import { createAfpGallery } from '../src/client/afp-workbench-gallery.js'
import { createAfpClientStore } from '../src/client/afp-client-store.js'

function element(type, props, ...children) { return { type, props: { ...props, children } } }
function nodes(tree, match) {
  if (Array.isArray(tree)) return tree.flatMap(item => nodes(item, match))
  if (!tree || typeof tree !== 'object') return []
  return [...(match(tree) ? [tree] : []), ...nodes(tree.props?.children, match)]
}
const UI = Object.fromEntries(['Button', 'Input', 'Tag', 'Checkbox', 'GlideHighlight', 'Tooltip'].map(name => [name, Symbol(name)]))
const region = data => ({ data, loading: false, error: '' })

test('gallery placeholders append inside the same responsive grid and retain photo keys', async () => {
  const React = { createElement: element }
  const gallery = createAfpGallery(React, UI, {}, key => key, {})
  const describe = (items, loading) => {
    const tree = gallery.PhotoGrid({ items, loading })
    return { grid: tree.props.className, photoKeys: nodes(tree, node => node.type === 'article').map(row => row.props.key),
      placeholders: nodes(tree, node => node.type?.name === 'PhotoSkeleton').length }
  }
  const expected = JSON.parse(await readFile(new URL('./fixtures/gallery-pagination.json', import.meta.url), 'utf8'))
  assert.deepEqual([describe([], true), describe([{ id: 'first', title: 'First' }], true), describe([{ id: 'first', title: 'First' }, { id: 'second', title: 'Second' }], false)], expected)
  const placeholder = gallery.PhotoSkeleton()
  assert.equal(placeholder.props['aria-hidden'], true)
  assert.equal(nodes(placeholder, node => node.type === 'span').length, 3)
})

test('collection pagination retry keeps its scroll content and calls load-more', () => {
  const store = createAfpClientStore({}), calls = []
  store.openCollection = id => calls.push(['first', id])
  store.loadMoreCollection = () => calls.push(['more'])
  const state = { ...store.getSnapshot(), collectionId: 'a', regions: { ...store.getSnapshot().regions,
    collection: { data: { items: [{ id: '1' }], total: 2, hasMore: true }, loading: false, loadMode: 'more', error: 'failure' } } }
  const React = { createElement: element, useSyncExternalStore: (_subscribe, snapshot) => snapshot(), useId: () => 'sidebar',
    useEffect() {}, useRef: () => ({ current: null }), useState: initial => [initial, () => {}] }
  const workbench = createWorkbench(React, UI, {}, key => key, store, () => null)
  const panel = nodes(workbench(), node => node.type?.name === 'CollectionsPanel')[0].type({ state })
  const retry = nodes(panel, node => node.type === UI.Button && node.props.children[0] === 'retry')[0]
  retry.props.onClick()
  assert.deepEqual(calls, [['more']])
  assert.equal(nodes(panel, node => node.type?.name === 'PhotoGrid').length, 1)
  store.dispose()
})

test('collection directory keeps named entries actionable while folded and preserves filter and selection', async () => {
  const store = createAfpClientStore({})
  const opened = []
  store.openCollection = id => { opened.push(id); store.set({ collectionId: id }) }
  store.set({ tab: 'collections', collectionId: 'travel', regions: { ...store.getSnapshot().regions,
    collections: region({ items: [{ id: 'unfiled', name: '' }, { id: 'whitespace', name: '  ' },
      { id: 'travel', name: '旅游', readOnly: true, count: 0 }, { id: 'private', name: '私人', isPrivate: true, count: 5 }] }),
  } })
  let collapsed = false
  const React = { createElement: element, useSyncExternalStore: (_subscribe, snapshot) => snapshot(), useId: () => 'sidebar', useEffect() {},
    useRef: () => ({ current: null }), useState: initial => [initial === false ? collapsed : initial, value => { collapsed = typeof value === 'function' ? value(collapsed) : value }] }
  const Workbench = createWorkbench(React, UI, {}, key => key, store, () => null)
  const panel = nodes(Workbench(), node => node.type?.name === 'CollectionsPanel')[0]
  const render = () => panel.type({ state: store.getSnapshot() })
  const projection = tree => ({ expanded: nodes(tree, node => node.props?.['aria-controls'] === 'sidebar')[0].props['aria-expanded'],
    filterInert: nodes(tree, node => node.props?.className === 'afp-wb-collection-filter-slot')[0].props.inert === '',
    sidebarInteractive: nodes(tree, node => node.type === 'aside')[0].props.inert === undefined,
    rows: nodes(tree, node => node.type === UI.Button && node.props.className?.startsWith('afp-wb-collection-item')).map(row => ({
      id: row.props.key, pressed: row.props['aria-pressed'], label: row.props['aria-label'],
      mark: nodes(row, node => node.props?.className === 'afp-wb-collection-mark')[0].props.children[0],
    })) })
  const initial = render()
  const snapshots = [projection(initial)]
  const rows = nodes(initial, node => node.type === UI.Button && node.props.className?.startsWith('afp-wb-collection-item'))
  assert.deepEqual(rows.map(node => node.props.key), ['travel', 'private'])
  assert.equal(nodes(rows[0], node => node.type === UI.Tag).at(-1).props.children[0], '0')
  assert.equal(nodes(rows[0], node => node.type === UI.Tag)[0].props.children[0], 'sharedReadOnly')
  assert.equal(nodes(rows[1], node => node.type === UI.Tag).length, 1)
  assert.ok(rows[1].props['aria-label'].includes('private'))
  assert.equal(nodes(initial, node => node.type === UI.GlideHighlight).length, 1)
  const controls = nodes(initial, node => node.props?.className === 'afp-wb-collection-controls')[0]
  assert.equal(nodes(controls, node => node.type === UI.Input).length, 1)
  const toggle = nodes(controls, node => node.type === UI.Button)[0]
  toggle.props.onClick()
  const folded = render(), aside = nodes(folded, node => node.type === 'aside')[0]
  snapshots.push(projection(folded))
  assert.equal(aside.props.inert, undefined)
  assert.equal(aside.props['aria-hidden'], undefined)
  assert.equal(nodes(aside, node => node.type === UI.Button && node.props['aria-controls'] === 'sidebar').length, 0)
  const privateRow = nodes(aside, node => node.type === UI.Button && node.props.key === 'private')[0]
  privateRow.props.onClick()
  assert.deepEqual(opened, ['private'])
  assert.equal(store.getSnapshot().collectionId, 'private')
  snapshots.push(projection(render()))
  const reopen = nodes(folded, node => node.props?.['aria-controls'] === 'sidebar')[0]
  assert.equal(reopen.props['aria-expanded'], false)
  reopen.props.onClick()
  assert.equal(nodes(render(), node => node.type === 'aside')[0].props.inert, undefined)
  store.set({ collectionFilter: '旅游' })
  assert.equal(nodes(render(), node => node.type === UI.Button && node.props.key === 'private').length, 0)
  reopen.props.onClick()
  assert.equal(store.getSnapshot().collectionFilter, '旅游')
  assert.equal(store.getSnapshot().collectionId, 'private')
  snapshots.push(projection(render()))
  assert.deepEqual(snapshots, JSON.parse(await readFile(new URL('./fixtures/collection-sidebar.json', import.meta.url), 'utf8')))
  store.dispose()
})

test('first collection load skips unnamed entries and does not open an empty directory', async () => {
  for (const named of [true, false]) {
    const calls = []
    const store = createAfpClientStore({}, { baseURI: 'https://fixture.test/', fetchImpl: async (_url, init) => {
      const input = JSON.parse(init.body); calls.push(input)
      return Response.json({ ok: true, value: input.operation === 'collection-list'
        ? { items: [{ id: 'unfiled', name: '' }, ...(named ? [{ id: 'travel', name: '旅游' }] : [])] }
        : { collection: { id: 'travel', name: '旅游' }, items: [] } })
    } })
    const React = { createElement: element, useSyncExternalStore: (_subscribe, snapshot) => snapshot(), useId: () => 'workbench' }
    const Workbench = createWorkbench(React, UI, {}, key => key, store, () => null)
    nodes(Workbench(), node => node.props?.id === 'workbench-tab-collections')[0].props.onClick()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(store.getSnapshot().collectionId, named ? 'travel' : '')
    assert.equal(calls.length, named ? 2 : 1)
    store.dispose()
  }
})

test('photo clicks toggle selection with source collections; context click opens details', async () => {
  const store = createAfpClientStore({}), photo = { id: 'p1', title: 'Sample' }
  function CheckIcon() { return element('svg', { viewBox: '0 0 24 24' }) }
  const Gallery = createAfpGallery({ createElement: element }, UI, { IconCheckOutlineRegular: CheckIcon }, key => key, store)
  const render = () => Gallery.PhotoGrid({ items: [photo], selectedPhotos: store.getSnapshot().selectedPhotos, sourceCollectionId: 'favorites-1' })
  const tile = tree => nodes(tree, node => node.type === 'article')[0]
  const first = tile(render()), frame = nodes(first, node => node.props.className === 'afp-wb-photo-frame')[0]
  const presentation = tree => {
    const button = nodes(tree, node => node.type === UI.Button && typeof node.props['aria-pressed'] === 'boolean')[0]
    return { pressed: button.props['aria-pressed'], label: button.props['aria-label'], variant: button.props.variant,
      iconSize: nodes(button, node => node.type === CheckIcon)[0].props.size }
  }
  const snapshots = [presentation(first)]
  frame.props.onClick()
  assert.deepEqual(store.getSnapshot().photoSources.p1, ['favorites-1'])
  const selected = tile(render())
  snapshots.push(presentation(selected))
  assert.deepEqual(snapshots, JSON.parse(await readFile(new URL('./fixtures/photo-selection.json', import.meta.url), 'utf8')))
  assert.equal(nodes(selected, node => node.props.className === 'afp-wb-photo-selected-icon').length, 1)
  assert.equal(nodes(selected, node => node.type === CheckIcon).length, 1)
  const tip = nodes(selected, node => node.type === UI.Tooltip)[0]
  assert.equal(tip.props.label, 'removeFromSelection')
  assert.equal(tip.props.maxWidth, 180)
  const selectButton = nodes(selected, node => node.type === UI.Button && node.props['aria-pressed'] === true)[0]
  assert.ok(selectButton.props['aria-label'].includes('Sample'))
  let stopped = false
  selectButton.props.onClick({ stopPropagation() { stopped = true } })
  assert.equal(stopped, true)
  assert.deepEqual(store.getSnapshot().selectedPhotos, {})
  const restoreButton = nodes(tile(render()), node => node.type === UI.Button && node.props['aria-pressed'] === false)[0]
  restoreButton.props.onClick({ stopPropagation() {} })
  assert.deepEqual(store.getSnapshot().photoSources.p1, ['favorites-1'])
  const openButton = nodes(selected, node => node.type === 'button' && node.props.className === 'afp-wb-photo-open')[0]
  assert.ok(openButton.props['aria-label'])
  const context = { prevented: false, preventDefault() { this.prevented = true } }
  nodes(selected, node => node.props.className === 'afp-wb-photo-frame')[0].props.onContextMenu(context)
  assert.equal(context.prevented, true)
  assert.equal(store.getSnapshot().detail.id, photo.id)
  nodes(tile(render()), node => node.props.className === 'afp-wb-photo-frame')[0].props.onClick()
  assert.deepEqual(store.getSnapshot().selectedPhotos, {})
  assert.equal(nodes(Gallery.PhotoGrid({ items: [photo], report: true }), node => node.props.className === 'afp-wb-photo-selected-icon').length, 0)
  store.dispose()
})

test('report clicks review photos while context clicks open details without changing decisions', () => {
  const store = createAfpClientStore({}), opened = [], reviewed = []
  store.openPhoto = photo => opened.push(photo.id)
  const photo = { id: 'photo', category: 'food', title: 'Sample', keep: true }
  const Gallery = createAfpGallery({ createElement: element }, UI, {}, key => key, store)
  const tree = Gallery.PhotoGrid({ items: [photo], report: true, onReview: item => reviewed.push(item.id) })
  nodes(tree, node => node.type?.name === 'ImagePreview')[0].props.open()
  nodes(tree, node => node.props.className === 'afp-wb-photo-open')[0].props.onClick()
  assert.deepEqual(reviewed, ['photo', 'photo'])
  assert.deepEqual(opened, [])
  let prevented = false
  nodes(tree, node => node.props.className === 'afp-wb-photo-frame')[0].props.onContextMenu({ preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  assert.deepEqual(opened, ['photo'])
  assert.equal(photo.keep, true)
  store.dispose()
})

test('review navigation respects category identity and keeps failed or rejected results out of selection', () => {
  const store = createAfpClientStore({}), moved = [], opened = []
  store.openPhoto = photo => opened.push(photo.id)
  const items = [
    { id: 'same', category: 'food', keep: true }, { id: 'same', category: 'animals', keep: false },
    { id: 'failed', category: 'food', keep: false, requestFailed: true }, { id: 'pending', category: 'food', keep: null },
  ]
  const original = JSON.stringify(items)
  const React = { createElement: element, useSyncExternalStore: (_subscribe, snapshot) => snapshot() }
  const Gallery = createAfpGallery(React, { ...UI, Modal: Symbol('Modal') }, {}, key => key, store)
  const render = photo => Gallery.ReviewModal({ photo, items, onChange: next => moved.push(next.category), onClose() {} })
  const button = (tree, label) => nodes(tree, node => node.type === UI.Button && node.props.children[0] === label)[0]
  const first = render(items[0])
  assert.equal(button(first, 'reviewPrevious').props.disabled, true)
  assert.equal(button(first, 'selectPhoto').props.disabled, false)
  button(first, 'selectPhoto').props.onClick()
  assert.equal(store.getSnapshot().selectedPhotos.same.id, 'same')
  button(render(items[0]), 'removeFromSelection').props.onClick()
  button(first, 'reviewNext').props.onClick()
  assert.deepEqual(moved, ['animals'])
  assert.equal(nodes(render(items[1]), node => node.props.className === 'afp-wb-review-position')[0].props.children[0], '2 / 4')
  for (const item of items.slice(1)) assert.equal(button(render(item), 'selectPhoto').props.disabled, true)
  assert.equal(button(render(items.at(-1)), 'reviewNext').props.disabled, true)
  const modal = render(items[1])
  let prevented = false
  modal.props.onKeyDownCapture({ key: 'ArrowLeft', target: {}, preventDefault() { prevented = true }, stopPropagation() {} })
  assert.equal(prevented, true)
  assert.deepEqual(moved, ['animals', 'food'])
  nodes(modal, node => node.props.className === 'afp-wb-review-image')[0].props.onContextMenu({ preventDefault() {} })
  assert.deepEqual(opened, ['same'])
  assert.equal(JSON.stringify(items), original)
  store.dispose()
})

test('selection summary combines thumbnails, overflow and count in one drawer toggle', () => {
  const store = createAfpClientStore({})
  for (let index = 0; index < 6; index++) store.selectPhoto({ id: `p${index}`, title: `Photo ${index}` }, 'travel')
  const React = { createElement: element, useSyncExternalStore: (_subscribe, snapshot) => snapshot(), useId: () => 'workbench' }
  const Workbench = createWorkbench(React, UI, {}, key => key === 'selectedPhotoCount' ? 'Selected {count}' : key, store, () => null)
  store.set({ tab: 'collections' })
  const panel = nodes(Workbench(), node => node.type?.name === 'CollectionsPanel')[0]
  const panelReact = { ...React, useEffect() {}, useState: value => [value, () => {}], useRef: () => ({ current: null }) }
  Object.assign(React, panelReact)
  const action = nodes(panel.type({ state: store.getSnapshot() }), node => node.type?.name === 'CollectionSelectionActions')[0]
  const render = () => action.type({ state: store.getSnapshot() })
  const summary = nodes(render(), node => node.type === UI.Button && node.props.className === 'afp-wb-selection-summary')[0]
  assert.equal(summary.props['aria-expanded'], false)
  assert.ok(summary.props['aria-label'].includes('Selected 6'))
  assert.equal(nodes(summary, node => node.props.className === 'afp-wb-selection-thumbnail').length, 3)
  assert.deepEqual(nodes(summary, node => node.props.className === 'afp-wb-selection-overflow')[0].props.children, ['+3'])
  assert.deepEqual(nodes(summary, node => node.type === UI.Tag)[0].props.children, ['6'])
  summary.props.onClick()
  assert.equal(store.getSnapshot().selectionOpen, true)
  nodes(render(), node => node.props.className === 'afp-wb-selection-summary')[0].props.onClick()
  assert.equal(store.getSnapshot().selectionOpen, false)
  assert.equal(Object.keys(store.getSnapshot().selectedPhotos).length, 6)
  store.dispose()
})

test('selection pane omits its close button and keeps detail and single-photo removal independent', async () => {
  const store = createAfpClientStore({})
  const photos = [{ id: 'p1', title: 'One' }, { id: 'p2', title: 'Two' }]
  photos.forEach(photo => store.selectPhoto(photo, 'travel'))
  store.set({ selectionOpen: true })
  let opened
  const Gallery = createAfpGallery({ createElement: element }, UI, {}, key => key, store)
  const render = () => Gallery.SelectionPane({ photos: Object.values(store.getSnapshot().selectedPhotos),
    onOpen: photo => { opened = photo.id } })
  const initial = render()
  const closeButtons = nodes(initial, node => node.props['aria-label'] === 'closeSelection')
  assert.equal(closeButtons.length, 0)
  const tips = nodes(initial, node => node.type === UI.Tooltip)
  assert.equal(tips[0].props.maxWidth, 180)
  assert.equal(tips[0].props.align, 'end')
  const presentation = { closeButtons: closeButtons.length, tooltipLabels: tips.map(node => node.props.label), removeLabels:
    nodes(initial, node => node.props.className === 'afp-wb-selection-remove').map(node => node.props['aria-label']) }
  assert.deepEqual(presentation, JSON.parse(await readFile(new URL('./fixtures/selection-pane.json', import.meta.url), 'utf8')))
  assert.equal(Object.keys(store.getSnapshot().selectedPhotos).length, 2)
  const first = nodes(render(), node => node.props.className === 'afp-wb-selection-item')[0]
  nodes(first, node => node.props.className === 'afp-wb-selection-open')[0].props.onClick()
  assert.equal(opened, 'p1')
  const remove = nodes(first, node => node.props.className === 'afp-wb-selection-remove')[0]
  assert.equal(remove.props['aria-label'], 'removePhoto One')
  remove.props.onClick()
  assert.deepEqual(Object.keys(store.getSnapshot().selectedPhotos), ['p2'])
  store.dispose()
})
