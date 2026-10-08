import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createAfpDownloadDialog } from '../src/client/afp-download-dialog.js'
import { downloadFilenameBase } from '../src/shared/afp-download-filenames.js'
import zh from '../src/client/locales/zh.json' with { type: 'json' }

function element(type, props, ...children) { return { type, props: { ...props, children } } }
function nodes(tree, match) {
  if (Array.isArray(tree)) return tree.flatMap(item => nodes(item, match))
  if (!tree || typeof tree !== 'object') return []
  return [...(match(tree) ? [tree] : []), ...nodes(tree.props?.children, match)]
}
function copy(tree) {
  if (Array.isArray(tree)) return tree.map(copy).join(' ')
  return tree && typeof tree === 'object' ? copy(tree.props?.children) : String(tree ?? '')
}
const UI = Object.fromEntries(['Modal', 'Button', 'Input', 'Tag', 'Checkbox', 'Menu', 'StateDot', 'Tooltip'].map(name => [name, Symbol(name)]))
const free = { id: 'Mockup', quality: 'Mockup', available: true, purchaseCost: 0, width: 800, height: 600 }
const paid = { id: 'HighRes', quality: 'HighRes', available: true, purchaseCost: 2, width: 6000, height: 4000 }
function harness(overrides = {}) {
  const state = { collectionAction: 'download', selectedPhotos: { p1: { id: 'p1', title: 'Photo' } },
    downloadOptions: { photos: [{ id: 'p1', guid: 'newsml.afp.123', renditions: [free, paid] }], creditBalance: 10 },
    downloadSelected: { p1: free.id }, downloadDirectory: { id: 'directory', label: 'Pictures' }, status: { features: ['write'] }, ...overrides }
  const calls = [], slots = []
  let cursor = 0
  const React = { createElement: element, useEffect() {}, useRef: initial => ({ current: initial }), useState(initial) {
    const index = cursor++
    if (!(index in slots)) slots[index] = initial
    return [slots[index], value => { slots[index] = value }]
  } }
  const store = { set: update => { Object.assign(state, update) }, loadDownloadOptions: args => calls.push(['options', args]),
    prepareDownload: args => calls.push(['prepare', args]), confirmDownload: () => calls.push(['confirm']),
    applyDownloadQuality: preference => calls.push(['quality', preference]) }
  const Dialog = createAfpDownloadDialog(React, UI, {}, key => zh[key] ?? key, store, () => null)
  return { state, calls, render() { cursor = 0; return Dialog({ state }) } }
}

test('failed options offer retry and show an unknown total rather than zero', () => {
  const { render, calls } = harness({ downloadOptions: null, downloadSelected: {}, downloadError: 'invalid-request', downloadErrorStage: 'options' })
  const tree = render()
  assert.ok(copy(tree).includes(zh.downloadServiceOutdated))
  assert.equal(copy(tree).includes('invalid-request'), false)
  assert.ok(copy(nodes(tree, node => node.props?.className === 'afp-wb-download-total')).includes('—'))
  const retry = nodes(tree, node => node.type === UI.Button && copy(node) === zh.retry)[0]
  retry.props.onClick()
  assert.deepEqual(calls, [['options', undefined]])
  assert.equal(nodes(tree, node => node.type === UI.Button && copy(node) === zh.previewDownload)[0].props.disabled, true)
})

test('paid formats require the write feature and explicit spend consent after review', () => {
  const blocked = harness({ status: { features: ['read'] } })
  const selector = nodes(blocked.render(), node => node.type?.name === 'AfpSelector')[0]
  assert.equal(selector.props.options.find(option => option.value === paid.id).disabled, true)
  const { render, calls } = harness({ downloadSelected: { p1: paid.id }, downloadPlan: { confirmation: 'receipt', items: [{}], totalCost: 2 } })
  const action = tree => nodes(tree, node => node.type === UI.Button && copy(node) === zh.downloadStartBackground)[0]
  assert.equal(action(render()).props.disabled, true)
  nodes(render(), node => node.type === UI.Checkbox)[0].props.onChange(true)
  assert.equal(action(render()).props.disabled, false)
  action(render()).props.onClick()
  assert.deepEqual(calls, [['confirm']])
})

test('filename customization invalidates review and previews the full dotted identifier', () => {
  const { render, calls, state } = harness({ downloadPlan: { confirmation: 'receipt', items: [{}], totalCost: 0 } })
  const fields = nodes(render(), node => node.type === UI.Input)
  assert.deepEqual(fields.map(node => node.props.maxLength), [80, 80])
  fields[0].props.onChange({ target: { value: 'batch_' } })
  fields[1].props.onChange({ target: { value: '_final' } })
  assert.equal(state.downloadPlan, null)
  assert.ok(copy(render()).includes('batch_newsml.afp.123_final'))
  nodes(render(), node => node.type === UI.Button && copy(node) === zh.previewDownload)[0].props.onClick()
  assert.deepEqual(calls, [['prepare', { prefix: 'batch_', suffix: '_final' }]])
  assert.equal(nodes(render(), node => node.type === 'details')[0].props.open, undefined)
})

test('unavailable photos do not display a zero-credit quote or enable review', () => {
  const { render } = harness({ downloadOptions: { photos: [{ id: 'p1', errorCode: 'download-photo-unavailable', renditions: [] }], creditBalance: null }, downloadSelected: {} })
  assert.ok(copy(render()).includes(zh.downloadPhotoFailed))
  assert.ok(copy(nodes(render(), node => node.props?.className === 'afp-wb-download-total')).includes('—'))
  assert.equal(nodes(render(), node => node.type === UI.Button && copy(node) === zh.previewDownload)[0].props.disabled, true)
})

test('filename affixes survive long identifiers and reserved names are escaped', () => {
  assert.equal(downloadFilenameBase({ fileName: 'CON.jpg' }), '_CON')
  assert.equal(downloadFilenameBase({ fileName: 'a:b?.jpg' }, '../', '_tail'), '.._a_b__tail')
  const name = downloadFilenameBase({ guid: 'g'.repeat(230) }, 'pre_', '_tail')
  assert.equal(name.length, 200)
  assert.ok(name.startsWith('pre_') && name.endsWith('_tail'))
})

test('directory selection and confirmation mark only their own button as loading', () => {
  for (const stage of ['directory', 'prepare', 'confirm']) {
    const { render } = harness({ downloadBusy: true, downloadBusyStage: stage })
    const tree = render(), loading = nodes(tree, node => node.type === UI.Button && node.props['aria-busy'])
    assert.equal(loading.length, 1)
    assert.equal(loading[0].props.disabled, true)
    assert.equal(loading[0].props.icon.type, UI.StateDot)
    assert.equal(loading[0].props.icon.props.state, 'ongoing')
    assert.ok(copy(loading[0]).includes(zh[stage === 'directory' ? 'choosingDirectory' : stage === 'prepare' ? 'checkingDownload' : 'submittingDownload']))
    assert.ok(copy(tree).includes(zh.cancelDownloadSetup))
  }
})

test('quote loading retains the same keyed rows and preview consumers across success and refresh', async () => {
  const h = harness({ downloadOptions: null, downloadOptionsLoading: true })
  const project = tree => {
    const list = nodes(tree, node => node.props?.className === 'afp-wb-download-items')[0]
    return { role: list.props.role, busy: list.props['aria-busy'], rows: nodes(list, node => node.props?.role === 'listitem').map(row => ({
      key: row.props.key, pending: row.props['data-loading'],
      title: copy(nodes(row, node => node.props?.className === 'afp-wb-download-item-title')[0]),
      previewContainers: nodes(row, node => node.props?.className === 'afp-wb-download-thumbnail').length,
      choiceDisabled: nodes(row, node => node.type?.name === 'AfpSelector')[0].props.disabled,
    })) }
  }
  const initial = h.render(), snapshots = [project(initial)]
  assert.equal(nodes(initial, node => node.props?.className === 'afp-wb-download-quality-content')[0].props.inert, '')
  h.state.downloadOptionsLoading = false
  h.state.downloadOptions = { photos: [{ id: 'p1', renditions: [free] }] }
  const loaded = h.render()
  snapshots.push(project(loaded))
  assert.equal(nodes(loaded, node => node.props?.className === 'afp-wb-download-quality-content')[0].props.inert, undefined)
  h.state.downloadOptionsLoading = true
  const refresh = h.render()
  snapshots.push(project(refresh))
  assert.equal(nodes(refresh, node => node.type === UI.Button && node.props['aria-busy']).length, 1)
  assert.deepEqual(snapshots, JSON.parse(await readFile(new URL('./fixtures/download-loading.json', import.meta.url), 'utf8')))
})

test('the batch icon opens a dismissible project menu and choosing quality never submits a download', () => {
  const { render, calls } = harness()
  const menu = () => nodes(render(), node => node.type === UI.Menu)[0]
  const anchor = nodes(menu().props.anchor, node => node.type === UI.Button)[0]
  assert.equal(anchor.props['aria-label'], zh.bulkQualityTitle)
  assert.equal(anchor.props['aria-haspopup'], 'menu')
  anchor.props.onClick()
  assert.equal(menu().props.open, true)
  assert.equal(menu().props.portal, true)
  menu().props.onClose()
  assert.equal(menu().props.open, false)
  anchor.props.onClick()
  menu().props.onSelect('highest')
  assert.deepEqual(calls, [['quality', { kind: 'highest' }]])
  assert.equal(menu().props.open, false)
  assert.ok(copy(menu().props.items[0].label).includes(zh.bulkQualityFree))
  assert.equal(nodes(render(), node => node.props?.className === 'afp-wb-download-items')[0].props.role, 'list')
})

test('batch paid and unavailable choices cannot be applied while disabled', () => {
  const { render, calls, state } = harness({ status: { features: ['read'] } })
  const menu = () => nodes(render(), node => node.type === UI.Menu)[0]
  const high = menu().props.items.find(item => copy(item.label).includes('HighRes'))
  assert.equal(high.disabled, true)
  menu().props.onSelect(high.id)
  assert.deepEqual(calls, [])
  state.downloadOptionsLoading = true
  assert.equal(nodes(menu().props.anchor, node => node.type === UI.Button)[0].props.disabled, true)
  menu().props.onSelect('free')
  assert.deepEqual(calls, [])
})

test('compact quality triggers keep full quote details in the menu and summarize partial matches', () => {
  const { render } = harness({ downloadBulkResult: { matched: 1, total: 2 } })
  const selector = nodes(render(), node => node.type?.name === 'AfpSelector')[0]
  assert.equal(selector.props.displayValue, free.quality)
  assert.ok(selector.props.options[1].label.includes('800×600'))
  assert.ok(selector.props.options[2].label.includes('6000×4000') && selector.props.options[2].label.includes('2'))
  const qualityMenu = selector.type(selector.props).props.children[0]
  assert.equal(copy(qualityMenu.props.anchor).trim(), free.quality)
  assert.equal(qualityMenu.props.items[2].label, selector.props.options[2].label)
  const summary = nodes(render(), node => node.props?.className === 'afp-wb-download-bulk-result')[0]
  assert.equal(summary.props.role, 'status')
  assert.ok(copy(summary).includes('1/2'))
  assert.equal(nodes(summary, node => node.type === UI.Tag)[0].props.tone, 'warning')
})
