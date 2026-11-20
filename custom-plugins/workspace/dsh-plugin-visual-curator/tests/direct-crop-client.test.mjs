/** Isolated UI checks use shipped form primitives; native canvas acceptance is recorded separately. */
import test from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { wallpaperSettingsSchema } from '../src/shared/wallpaper.ts'

const expected = JSON.parse(await readFile(new URL('./fixtures/direct-crop-import.expected.json', import.meta.url), 'utf8'))
const root = fileURLToPath(new URL('../', import.meta.url)), require = createRequire(import.meta.url)
const React = require('react'), { act } = React, { createRoot } = require('react-dom/client')
const names = ['SegmentedTabs', 'Modal', 'Button', 'Input', 'Tag', 'StateDot', 'Menu', 'Checkbox', 'Tooltip', 'TextArea']
const contents = names.map(name => `import {${name}} from '../../../packages/client/ui-primitives/src/${name}.tsx'`).join('\n') + `\nexport const ui={${names.join(',')}}; export {createDirectCropPage,directCropVisible,directCropWorkspaceKey} from './src/client/direct-crop.tsx'; export {createServerQueue} from './src/client/server-queue.tsx'; export {zh} from './src/client/workbench-locale.ts'`
const compiled = await build({ stdin: { contents, resolveDir: root, loader: 'ts' }, outfile: resolve(root, 'tests/direct-crop-memory.cjs'), bundle: true, write: false, external: ['react', 'react/*', 'react-dom', 'react-dom/*'], platform: 'node', format: 'cjs', loader: { '.css': 'empty', '.webp': 'empty' }, logLevel: 'silent' })
const filename = resolve(root, 'tests/direct-crop-memory.cjs'), capsule = new Module(filename)
capsule.filename = filename; capsule.paths = Module._nodeModulePaths(dirname(filename)); capsule._compile(compiled.outputFiles.find(file => file.path.endsWith('.cjs')).text, filename)
const { ui: primitives, createDirectCropPage, directCropVisible, directCropWorkspaceKey, createServerQueue, zh } = capsule.exports
const imageConfig = { wallpaperImage: { imageProvider: 'autoflow-codex', imageSourceId: '', imageModel: '' }, imageSources: { apiKeys: [] } }
const imageOptions = { settings: wallpaperSettingsSchema.parse({}), models: [{ id: 'gpt-image-1.5', name: 'GPT Image' }], providers: [{ id: 'autoflow-codex', name: 'Codex', models: [{ id: 'gpt-image-1.5', name: 'GPT Image' }], sources: [] }, { id: 'visual-curator-openai', name: 'OpenAI API', models: [{ id: 'gpt-image-2', name: 'GPT Image 2' }], sources: [{ id: 'key-one', name: 'Personal key', available: true, models: [{ id: 'gpt-image-2', name: 'GPT Image 2' }] }] }] }
// Decorative icons do not own form semantics in this isolated DOM check.
const ui = { ...primitives, ...Object.fromEntries(['IconPlusOutlineRegular', 'IconFolderOpenOutlineRegular', 'IconChevronLeftOutlineRegular', 'IconChevronRightOutlineRegular', 'IconChevronDownOutlineRegular', 'IconRefreshOutlineRegular', 'IconBrowseOutlineRegular', 'IconTrashOutlineRegular', 'IconSearchOutlineRegular', 'IconPinOutlineRegular', 'IconInfoOutlineRegular', 'IconCloseOutlineRegular'].map(name => [name, () => React.createElement('span', { 'aria-hidden': true })])) }

test('image catalogs preload, survive dialog reopening and ignore late replies after switching sources', async () => {
  const keys = ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'MutationObserver', 'Element', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT'], old = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://isolated.example/', pretendToBeVisual: true })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement, MutationObserver: dom.window.MutationObserver, Element: dom.window.Element, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })
  const rendered = createRoot(document.getElementById('root')), Page = createDirectCropPage(React, ui), calls = [], codex = Promise.withResolvers(), api = Promise.withResolvers()
  const configuration = { ...imageConfig, revision: 'first-config', visionConfigured: true, limits: { pageSize: 20, maxImportFiles: 30, maxImportBytes: 20 * 1024 * 1024, pollIntervalMs: 60000 }, source: { unsplash: { accounts: [] } } }
  const actions = { directScope: () => 'catalog-prefetch', pickLocalReferences: async () => ({ files: [{ path: 'C:/isolated/source.png', name: 'source.png', size: 1024, readable: true }] }), directCrop: async (operation, args, signal) => {
    if (operation === 'direct-crop-list') return { batches: [], total: 0 }
    if (operation === 'wallpaper-options') { calls.push({ args, signal }); if (calls.length === 1) return codex.promise; if (calls.length === 2) return api.promise; if (calls.length === 3) throw new Error('Isolated catalog failure'); return imageOptions }
    throw new Error('Unexpected operation')
  } }
  const button = label => [...document.querySelectorAll('button')].find(element => element.textContent === label)
  const chooseProvider = async label => {
    await act(async () => document.querySelector('button[aria-label="' + zh.imageGenerationSource + '"]').click())
    await act(async () => [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === label).click())
  }
  const openImport = async () => {
    await act(async () => button(zh.directCropAddImages).click())
    await act(async () => [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === zh.directCropLocal).click())
  }
  const props = config => React.createElement(Page, { configuration: config, actions, t: key => zh[key], onBack() {} })
  try {
    await act(async () => rendered.render(props(configuration)))
    assert.equal(calls.length, 1, 'The selected catalog starts before opening the import dialog')
    await openImport()
    assert(document.querySelector('[role="dialog"]').textContent.includes(expected.imageCatalog.loading))
    await act(async () => codex.resolve(imageOptions))
    assert.equal(document.querySelector('button[aria-label="' + zh.wallpaperImageModel + '"]').disabled, false)
    await act(async () => button(zh.cancel).click())
    await openImport()
    assert.equal(calls.length, 1, 'Reopening the same route reuses its validated catalog')
    assert.equal(button(zh.directCropStart).disabled, false)
    await chooseProvider('OpenAI API')
    assert.equal(calls.length, 2)
    assert.equal(document.querySelector('button[aria-label="' + zh.imageGenerationAccount + '"]').disabled, true)
    await chooseProvider('Codex')
    assert.equal(calls.length, 2, 'Returning to the retained Codex catalog does not wait for the API request')
    assert.equal(calls[1].signal.aborted, true)
    await act(async () => api.resolve({ ...imageOptions, providers: imageOptions.providers.map(provider => provider.id === 'autoflow-codex' ? { ...provider, models: [] } : provider) }))
    assert.equal(button(zh.directCropStart).disabled, false, 'A late result cannot erase the active catalog')
    await act(async () => rendered.render(props({ ...configuration, revision: 'updated-config' })))
    assert.equal(document.querySelector('[role="alert"]').textContent.replace(zh.retry, '').trim(), zh.imageGenerationLoadError)
    assert.equal(button(zh.directCropStart).disabled, true, 'A changed configuration cannot use the old catalog')
    await act(async () => button(zh.retry).click())
    assert.equal(button(zh.directCropStart).disabled, false)
    assert.deepEqual(calls.map(call => call.args.provider), expected.imageCatalog.requestedProviders)
  } finally {
    codex.resolve(imageOptions); api.resolve(imageOptions)
    await act(async () => rendered.unmount()); dom.window.close()
    for (const key of keys) { const descriptor = old.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
  }
})

test('direct import requires no collection, retains selection after failure and reuses the same request identity', async () => {
  const keys = ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'MutationObserver', 'Element', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT'], old = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://isolated.example/', pretendToBeVisual: true })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement, MutationObserver: dom.window.MutationObserver, Element: dom.window.Element, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })
  const rendered = createRoot(document.getElementById('root')), Page = createDirectCropPage(React, ui), calls = []
  const accepted = Promise.withResolvers()
  let fail = true, pendingGallery, pickedCalls = 0
  const configuration = { ...imageConfig, visionConfigured: true, limits: { pageSize: 20, maxImportFiles: 30, maxImportBytes: 20 * 1024 * 1024, maxClientRequestBytes: 64 * 1024, pollIntervalMs: 2000, deadlineMs: 60000, requestTimeoutMs: 10000, maxGalleryReferenceFiles: 1000 }, source: { unsplash: { accounts: [{ id: 'account', label: 'Gallery account' }], defaultAccountId: 'account' } } }
  const actions = { directScope: () => 'profile-a', directCrop: async (operation, args, signal) => { signal?.throwIfAborted(); calls.push({ operation, args, signal }); if (operation === 'direct-crop-list') return { batches: [], total: 0 }; if (operation === 'wallpaper-options') return imageOptions; if (operation === 'direct-crop-start') { if (fail) throw new Error('Isolated network interruption'); return accepted.promise } throw new Error('Unexpected operation') }, pickLocalReferences: async (_kind, signal, title) => {
    signal.throwIfAborted(); assert.equal(title, zh.directCropChoosePhotos)
    if (++pickedCalls === 1) throw { code: 'capability-unavailable', stage: 'local-reference' }
    return { files: [
      { path: 'C:/isolated/source.png', name: 'source.png', size: 2_822_163, readable: true },
      { path: 'C:/isolated/large.png', name: 'large.png', size: 36_746_496, readable: true },
      { path: 'C:/isolated/empty.png', name: 'empty.png', size: 0, readable: true },
      { path: 'C:/isolated/missing.png', name: 'missing.png', size: 12, readable: false },
    ], cancelled: false }
  }, galleryRead: async (_operation, _args, signal) => new Promise((_resolve, reject) => { pendingGallery = signal; signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }) }) }
  const button = label => [...document.querySelectorAll('button')].find(element => element.textContent === label)
  const menuItem = label => [...document.querySelectorAll('[role="menuitem"]')].find(element => element.textContent === label)
  try {
    assert.equal(directCropVisible('profile-a'), false)
    window.localStorage.setItem(directCropWorkspaceKey('profile-a'), 'direct')
    assert.equal(directCropVisible('profile-a'), true); assert.equal(directCropVisible('profile-b'), false)
    await act(async () => rendered.render(React.createElement(React.StrictMode, null, React.createElement(Page, { configuration, actions, t: key => zh[key], onBack() {} }))))
    assert(document.body.textContent.includes(zh.directCropEmpty))
    await act(async () => button(zh.directCropAddImages).click())
    assert.deepEqual([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent), [zh.directCropLocal, zh.directCropLocalFolders, zh.directCropGallery, zh.serverQueue])
    await act(async () => menuItem(zh.directCropLocal).click())
    assert.equal(document.querySelector('[role="alert"]').textContent.replace(zh.retry, ''), expected.pickerError)
    await act(async () => button(zh.retry).click())
    assert.equal(pickedCalls, 2, 'Retry reopens the failed picker instead of refreshing the batch list')
    assert(document.querySelector('[role="dialog"]').textContent.includes('source.png'))
    assert(document.querySelector('[role="dialog"]').textContent.includes(zh.directCropTooLarge.replace('{limit}', '20 MiB')))
    assert(document.querySelector('[role="dialog"]').textContent.includes(zh.directCropEmptyFile))
    assert(document.querySelector('[role="dialog"]').textContent.includes(zh.directCropUnreadable))
    const largeRow = [...document.querySelectorAll('.vc-direct-file')].find(row => row.querySelector('span').textContent === 'large.png')
    assert.deepEqual({name:largeRow.querySelector('span').textContent,size:largeRow.querySelector('small').textContent,reason:largeRow.querySelector('p').textContent,startDisabled:button(zh.directCropStart).disabled}, expected.oversized)
    assert.equal(calls.filter(call => call.operation === 'direct-crop-start').length, 0)
    for (const name of ['large.png', 'empty.png', 'missing.png']) await act(async () => document.querySelector('button[aria-label="' + zh.directCropRemove + ' ' + name + '"]').click())
    await act(async () => document.querySelector('button[aria-label="' + zh.imageGenerationSource + '"]').click())
    await act(async () => menuItem('OpenAI API').click())
    await act(async () => document.querySelector('button[aria-label="' + zh.imageGenerationAccount + '"]').click())
    await act(async () => menuItem('Personal key').click())
    assert.equal(button(zh.directCropStart).disabled, false)
    await act(async () => button(zh.directCropStart).click())
    assert.equal(document.querySelector('[role="dialog"]'), null, 'A failed admission stays in the table instead of reopening its dialog')
    assert.equal(document.querySelectorAll('[role="alert"]').length, 1, 'The import error is displayed once in its table row')
    assert.equal(document.querySelector('.vc-direct-admission-message').textContent, expected.startError)
    await act(async () => button(zh.refresh).click())
    assert(document.querySelector('[role="alert"]').textContent.includes(zh.directCropStartError), 'Successful background reads cannot erase admission errors')
    fail = false
    await act(async () => button(zh.retry).click())
    assert.deepEqual({ dialogOpen: !!document.querySelector('[role="dialog"]'), label: document.querySelector('[data-import-admission] [role="status"]').textContent, selectedCountVisible: document.querySelector('[data-import-admission]').textContent.includes(zh.directCropSelected + ' 1'), inTable: !!document.querySelector('.vc-direct-batch-table [data-import-admission]'), separateCard: !!document.querySelector('.vc-direct-import-progress') }, expected.importing)
    assert.equal(calls.filter(call => call.operation === 'direct-crop-start').at(-1).signal?.aborted ?? false, false, 'Closing the confirmation must not cancel original acquisition')
    await act(async () => accepted.resolve({ runId: 'accepted' }))
    const starts = calls.filter(call => call.operation === 'direct-crop-start')
    assert.equal(starts.length, 2); assert.equal(starts[0].args.operationId, starts[1].args.operationId)
    assert.deepEqual(starts[1].args.source, { kind: 'local', files: [{ path: 'C:/isolated/source.png', name: 'source.png' }] })
    assert.deepEqual(starts[1].args.imageRoute, { imageProvider: 'visual-curator-openai', imageSourceId: 'key-one', imageModel: 'gpt-image-2' })
    assert.equal('styleId' in starts[1].args, false); assert.equal('sourceRunId' in starts[1].args, false)
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert(button(zh.directCropAddImages), 'The empty batch projection keeps the import entry reachable')
    await act(async () => button(zh.directCropAddImages).click())
    await act(async () => menuItem(zh.directCropGallery).click())
    assert(pendingGallery && !pendingGallery.aborted)
    await act(async () => button(zh.close).click())
    assert.equal(pendingGallery.aborted, true)
    assert(calls.every(call => call.operation.startsWith('direct-crop-') || call.operation === 'wallpaper-options'))
    const chooserExpected=JSON.parse(await readFile(new URL('./fixtures/direct-crop-dialog-controls.expected.json',import.meta.url),'utf8')).gallery
    configuration.limits.maxImportFiles=2
    actions.referenceState=async()=>{throw new Error('Direct selection must not request training membership')}
    actions.startGalleryReferences=async()=>{throw new Error('Direct selection must not import training references')}
    actions.galleryRead=async operation=>operation==='gallery-collections'?{items:[{id:'collection',title:'Test originals',totalPhotos:3}],nextCursor:null}:{items:[1,2,3].map(n=>({id:'photo-'+n,title:'Original '+n,width:1000,height:1500,referenceUrl:'https://unsplash.com/photos/photo-'+n,thumbnailUrl:'https://images.unsplash.com/photo-'+n,photographer:'Fixture'})),nextCursor:null}
    await act(async()=>button(zh.directCropAddImages).click())
    await act(async()=>menuItem(zh.directCropGallery).click())
    assert(document.querySelector('.vc-gallery-reference-modal'))
    await act(async()=>[...document.querySelectorAll('.vc-gallery-folder')].find(e=>e.textContent.includes('Test originals')).click())
    const inputs=()=>[...document.querySelectorAll('.vc-gallery-photos figcaption input[type="checkbox"]')]
    assert.equal(inputs().length,3)
    const all=document.querySelector('.vc-gallery-selection-actions input[type="checkbox"]')
    await act(async()=>all.click());assert.equal(all.checked,true);assert.equal(inputs()[0].checked,true);assert.equal(inputs()[1].checked,true)
    assert.equal(inputs()[2].disabled,true)
    await act(async()=>inputs()[0].click());await act(async()=>inputs()[2].click())
    const chosenButton=()=>[...document.querySelectorAll(".vc-gallery-reference-footer button")].find(e=>e.textContent.startsWith(zh.directCropChooseOriginals))
    assert.equal(chosenButton().disabled,false)
    await act(async()=>chosenButton().click())
    assert.equal(document.querySelector('.vc-gallery-reference-modal'),null)
    assert.deepEqual([...document.querySelectorAll('.vc-direct-file > span')].map(e=>e.textContent),chooserExpected.selectedTitles)
    assert.equal(calls.filter(call=>call.operation==='direct-crop-start').length,2)
    await act(async()=>button(zh.cancel).click())
  } finally {
    await act(async () => rendered.unmount()); dom.window.close()
    for (const key of keys) { const descriptor = old.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
  }
})

test('appending folders keeps the import draft and accepts more originals than one processing batch', async () => {
  const keys = ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'MutationObserver', 'Element', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT'], old = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://isolated.example/', pretendToBeVisual: true })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement, MutationObserver: dom.window.MutationObserver, Element: dom.window.Element, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })
  const rendered = createRoot(document.getElementById('root')), Page = createDirectCropPage(React, ui)
  const configuration = { ...imageConfig, revision: 'folder-test', visionConfigured: true, limits: { pageSize: 20, maxImportFiles: 4, maxImportBytes: 20 * 1024 * 1024, pollIntervalMs: 60000 }, source: { unsplash: { accounts: [] } } }
  const file = name => ({ path: 'C:/isolated/' + name, name, size: 1024, readable: true })
  const late = Promise.withResolvers(), requests = []
  const replies = [
    { files: [file('one.png'), file('two.jpg')] },
    { files: [file('one.png'), file('three.webp')] },
    { files: [file('four.png'), file('five.png')] },
    { files: [file('four.png')] },
    { files: [], cancelled: true },
    late.promise,
  ]
  const actions = {
    directScope: () => 'folder-test',
    directCrop: async operation => operation === 'direct-crop-list' ? { batches: [], total: 0 } : imageOptions,
    pickLocalReferences: async (kind, signal) => { requests.push({ kind, signal }); return replies.shift() },
  }
  const click = async (label, selector = 'button') => act(async () => [...document.querySelectorAll(selector)].find(element => element.textContent === label).click())
  const selectedNames = () => [...document.querySelectorAll('.vc-direct-file > span')].map(element => element.textContent)
  try {
    await act(async () => rendered.render(React.createElement(Page, { configuration, actions, t: key => zh[key], onBack() {} })))
    await click(zh.directCropAddImages)
    await click(zh.directCropLocalFolders, '[role="menuitem"]')
    assert.deepEqual(selectedNames(), ['one.png', 'two.jpg'])
    const name = document.querySelector('.vc-direct-name input').value
    await click(zh.directCropAddLocalFolders)
    await click(zh.directCropAddLocalFolders)
    assert.deepEqual(selectedNames(), ['one.png', 'two.jpg', 'three.webp', 'four.png', 'five.png'])
    assert(document.querySelector('[role="dialog"]').textContent.includes(zh.directCropQueueHint))
    await click(zh.directCropAddLocalFiles)
    await click(zh.directCropAddLocalFiles)
    assert.deepEqual(selectedNames(), ['one.png', 'two.jpg', 'three.webp', 'four.png', 'five.png'])
    assert.equal(document.querySelector('.vc-direct-name input').value, name)
    await click(zh.directCropAddLocalFolders)
    assert(document.querySelector('[role="dialog"] [role="status"]').textContent.includes(zh.directCropReadingLocal))
    await click(zh.cancel)
    assert.equal(requests.at(-1).signal.aborted, true)
    await act(async () => late.resolve({ files: [file('late.png')] }))
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.deepEqual(requests.map(({ kind }) => kind), ['folders', 'folders', 'folders', 'file', 'file', 'folders'])
  } finally {
    await act(async () => rendered.unmount()); dom.window.close()
    for (const key of keys) { const descriptor = old.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
  }
})

test('67 local originals enter bounded requests in order and a failed request leaves the following groups queued', async () => {
  const keys = ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'MutationObserver', 'Element', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT'], old = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://isolated.example/', pretendToBeVisual: true })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement, MutationObserver: dom.window.MutationObserver, Element: dom.window.Element, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })
  const rendered = createRoot(document.getElementById('root')), Page = createDirectCropPage(React, ui)
  const configuration = { ...imageConfig, revision: 'bulk-import-test', visionConfigured: true, limits: { pageSize: 20, maxImportFiles: 30, maxImportBytes: 20 * 1024 * 1024, maxClientRequestBytes: 4096, pollIntervalMs: 60000 }, source: { unsplash: { accounts: [] } } }
  const originals = Array.from({ length: 67 }, (_, index) => ({
    path: 'C:/isolated/' + (index < 30 ? '' : '测试目录/'.repeat(30)) + index + '.png',
    name: index + '.png',
  }))
  const starts = [], first = Promise.withResolvers()
  const actions = {
    directScope: () => 'bulk-import-test',
    pickLocalReferences: async () => ({ files: originals }),
    directCrop: async (operation, args) => {
      if (operation === 'direct-crop-list') return { batches: [], total: 0 }
      if (operation === 'wallpaper-options') return imageOptions
      assert.equal(operation, 'direct-crop-start')
      starts.push(args)
      if (starts.length === 1) await first.promise
      if (starts.length === 2) throw new Error('One isolated group failed to import')
      return { runId: 'accepted-' + starts.length }
    },
  }
  const click = async label => act(async () => [...document.querySelectorAll('button')].find(element => element.textContent === label).click())
  try {
    await act(async () => rendered.render(React.createElement(Page, { configuration, actions, t: key => zh[key], onBack() {} })))
    await click(zh.directCropLocalFolders)
    assert.equal(document.querySelectorAll('.vc-direct-file').length, 67)
    await click(zh.directCropStart)
    assert.equal(starts.length, 1)
    assert(document.querySelector('[data-admission-state="queued"]').textContent.includes(zh.directCropQueued))
    await act(async () => first.resolve())
    assert.equal(starts[0].source.files.length, 30)
    assert(starts.length > 3, 'Long Unicode paths reach the request byte limit before the per-group image count')
    assert.deepEqual(starts.flatMap(args => args.source.files), originals)
    for (const [index, args] of starts.entries()) {
      assert(args.source.files.length <= configuration.limits.maxImportFiles)
      assert(Buffer.byteLength(JSON.stringify({ operation: 'direct-crop-start', args })) <= configuration.limits.maxClientRequestBytes)
      assert(args.name.endsWith(`(${index + 1}/${starts.length})`))
    }
    const failedOperation = starts[1].operationId
    await click(zh.retry)
    assert.equal(starts.at(-1).operationId, failedOperation)
    assert.deepEqual(starts.at(-1).source, starts[1].source)
  } finally {
    first.resolve()
    await act(async () => rendered.unmount()); dom.window.close()
    for (const key of keys) { const descriptor = old.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
  }
})

test('server selection confirms generation settings before admission and shows page progress through retry', async () => {
  const keys = ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'MutationObserver', 'Element', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT'], old = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://isolated.example/', pretendToBeVisual: true })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement, MutationObserver: dom.window.MutationObserver, Element: dom.window.Element, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })
  const rendered = createRoot(document.getElementById('root')), Page = createDirectCropPage(React, ui), calls = []
  const first = Promise.withResolvers(), retry = Promise.withResolvers()
  let accepted = false
  const options = { ...imageOptions, providers: imageOptions.providers.map(provider => provider.id === 'autoflow-codex' ? { ...provider, sources: [{ id: 'fixture-account', name: 'Fixture account', available: true }] } : provider) }
  const configuration = { ...imageConfig, visionConfigured: true, limits: { pageSize: 20, maxImportFiles: 20, maxImportBytes: 20 * 1024 * 1024, pollIntervalMs: 60000 }, source: { unsplash: { accounts: [] } } }
  const actions = { directScope: () => 'server-confirmation', saveCredential: async () => {}, directCrop: async (operation, args, signal) => {
    calls.push({ operation, args, signal })
    if (operation === 'wallpaper-options') return options
    if (operation === 'direct-crop-list') return { batches: [], total: 0, imports: accepted ? [{ runId: 'server-admission', name: args.name || 'Server originals', status: 'importing', saved: 0, total: 1, receivedBytes: 1024 }] : [] }
    if (operation === 'server-queue-read') return { settings: { baseUrl: 'https://api.example', allowedMediaOrigins: ['https://images.example'] }, snapshotId: 'server-snapshot', pendingKnown: true, total: 1, items: [{ id: '69671', name: 'server-original.png', serverPending: true, imported: false, phase: 'waiting' }] }
    if (operation === 'server-queue-start') return calls.filter(call => call.operation === operation).length === 1 ? first.promise : retry.promise
    throw Error('Unexpected operation: ' + operation)
  } }
  const button = label => [...document.querySelectorAll('button')].find(element => element.textContent === label)
  const menuItem = label => [...document.querySelectorAll('[role="menuitem"]')].find(element => element.textContent === label)
  try {
    await act(async () => rendered.render(React.createElement(Page, { configuration, actions, t: key => zh[key], onBack() {} })))
    await act(async () => button(zh.directCropAddImages).click())
    await act(async () => menuItem(zh.serverQueue).click())
    await act(async () => document.querySelector('.vc-server-table tbody input[type="checkbox"]').click())
    await act(async () => button(zh.directCropChooseOriginals).click())
    assert.equal(document.querySelector('.vc-server-modal'), null)
    assert(document.querySelector('.vc-direct-import-modal'))
    assert.deepEqual([...document.querySelectorAll('.vc-direct-file > span')].map(item => item.textContent), expected.serverConfirmation.selectedNames)
    assert.equal(calls.filter(call => call.operation === 'server-queue-start').length, 0)
    await act(async () => document.querySelector('button[aria-label="' + zh.imageGenerationAccount + '"]').click())
    await act(async () => menuItem('Fixture account').click())
    await act(async () => document.querySelector('button[aria-label="' + zh.wallpaperImageModel + '"]').click())
    await act(async () => menuItem('GPT Image').click())
    await act(async () => button(zh.serverStart).click())
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert(document.querySelector('.vc-direct-batch-table [data-import-admission]')); assert.equal(document.querySelector('.vc-direct-import-progress'), null)
    const request = calls.find(call => call.operation === 'server-queue-start')
    assert.deepEqual(request.args.ids, expected.serverConfirmation.ids)
    assert.deepEqual(request.args.imageRoute, expected.serverConfirmation.imageRoute)
    assert.equal(request.args.snapshotId, 'server-snapshot')
    assert.equal(request.signal.aborted, false)
    await act(async () => first.reject(new Error('Isolated admission failure')))
    assert.equal(document.querySelector('.vc-direct-import-modal'), null)
    assert.equal(document.querySelector('.vc-direct-admission-message').textContent, expected.startError)
    await act(async () => button(zh.directCropEditImport).click())
    assert(document.querySelector('.vc-direct-import-modal'))
    await act(async () => document.querySelector('.vc-direct-import-modal button[aria-label="' + zh.close + '"]').click())
    assert.equal(document.querySelector('.vc-direct-import-modal'), null, 'The explicit close button always dismisses the failed confirmation')
    await act(async () => button(zh.directCropEditImport).click())
    await act(async () => button(zh.cancel).click())
    assert.equal(document.querySelector('.vc-direct-import-modal'), null, 'Cancel also dismisses an edited failed admission')
    await act(async () => button(zh.refresh).click())
    assert.equal(document.querySelector('.vc-direct-import-modal'), null)
    await act(async () => button(zh.retry).click())
    assert.equal(document.querySelector('[role="dialog"]'), null)
    const retried = calls.filter(call => call.operation === 'server-queue-start').at(-1)
    assert.deepEqual(retried.args, request.args)
    accepted = true
    await act(async () => retry.resolve({ runId: 'server-admission' }))
    assert(document.querySelector('[data-server-import="server-admission"]')); assert.equal(document.querySelector('[data-import-admission]'), null, 'The saved row replaces its temporary admission row')
    assert.equal(document.querySelector('.vc-direct-header-progress'), null)
    assert.equal(document.querySelector('.vc-direct-import-progress'), null)
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.equal(calls.some(call => call.operation === 'direct-crop-start'), false)
  } finally {
    await act(async () => rendered.unmount()); dom.window.close()
    for (const key of keys) { const descriptor = old.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
  }
})

test('batch table confirms removal, retains unknown outcomes for retry and ignores late list replies',async()=>{
 const keys=['window','document','HTMLElement', 'HTMLButtonElement', 'MutationObserver','IS_REACT_ACT_ENVIRONMENT'],old=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)])),dom=new JSDOM('<div id="root"></div>',{url:'https://isolated.example/',pretendToBeVisual:true})
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement, MutationObserver: dom.window.MutationObserver,IS_REACT_ACT_ENVIRONMENT:true})
 const rendered=createRoot(document.getElementById('root')),Page=createDirectCropPage(React,ui),expected=JSON.parse(await readFile(new URL('./fixtures/direct-crop-batches.expected.json',import.meta.url),'utf8'))
 const rows=expected.batches.map((row,index)=>({...row,directCrop:true,removable:['completed','failed','cancelled'].includes(row.status),kind:'crop',origin:'local',createdAt:'2026-11-10T00:00:00Z',taskBrief:row.name,matched:2,unavailable:false,images:[],wallpaper:{runId:row.runId+'-latest',status:row.status,total:2,planned:2,rendered:1,reviewed:1,passed:1,attention:index===1?0:1,budgetStopped:false,counts:{passed:1}}}))
 const calls=[],hidden=new Set();let hold=false,late,loseReply=true
 const configuration={...imageConfig,visionConfigured:true,limits:{pageSize:20,maxImportFiles:30,maxImportBytes:20*1024*1024,pollIntervalMs:60000,deadlineMs:10000},source:{unsplash:{accounts:[]}}}
 const actions={directScope:()=> 'batch-table-fixture',directCrop:async(operation,args)=>{calls.push({operation,args});if(operation==='direct-crop-list'){if(hold){hold=false;return new Promise(resolve=>{late=resolve})}const batches=rows.filter(row=>!hidden.has(row.runId));return {batches,total:batches.length}}if(operation==='direct-crop-delete'){hidden.add(args.runId);if(loseReply){loseReply=false;throw new Error('Isolated receipt loss after commit')}return {runId:args.runId,deleted:true}}throw new Error('Unexpected operation: '+operation)}}
 const button=text=>[...document.querySelectorAll('button')].find(e=>e.textContent===text),remove=row=>document.querySelector('button[aria-label="'+zh.directCropDelete+' '+row.name+'"]')
 try{
  await act(async()=>rendered.render(React.createElement(Page,{configuration,actions,t:key=>zh[key],onBack(){},onManageAccounts(){}})))
  assert.equal(document.querySelectorAll('.vc-direct-batch-table tbody tr[data-run-id]').length,3)
  assert.deepEqual([...document.querySelectorAll('.vc-direct-batch-table th')].map(e=>e.textContent),expected.columns)
  assert.equal(document.querySelector('.vc-direct-batch-delete').closest('.vc-direct-batch-open'),null)
  assert.equal(remove(rows[1]).disabled,true);assert.equal(remove(rows[2]).disabled,true)
  assert.equal(document.querySelectorAll('.vc-direct-batch')[2].querySelector('.vc-direct-batch-state').textContent,zh.paused)
  await act(async()=>remove(rows[0]).click())
  assert(document.querySelector('[role="dialog"]').textContent.includes(zh.directCropDeleteHint));assert(!document.querySelector('.vc-direct-flow'))
  assert.equal(calls.filter(c=>c.operation==='direct-crop-delete').length,0)
  await act(async()=>button(zh.cancel).click());assert.equal(document.querySelector('[role="dialog"]'),null)
  hold=true;await act(async()=>button(zh.refresh).click());assert(late)
  await act(async()=>remove(rows[0]).click());await act(async()=>button(zh.directCropDeleteConfirm).click())
  assert(document.querySelector('[role="alert"]').textContent.includes(zh.directCropDeleteError));assert.equal(button(zh.directCropDeleteConfirm).disabled,false)
  await act(async()=>button(zh.directCropDeleteConfirm).click())
  const deletions=calls.filter(c=>c.operation==='direct-crop-delete');assert.equal(deletions.length,2);assert.equal(deletions[0].args.operationId,deletions[1].args.operationId)
  assert.equal(document.querySelector('[role="dialog"]'),null)
  await act(async()=>late({batches:rows,total:rows.length}));await act(async()=>button(zh.refresh).click())
  assert.deepEqual([...document.querySelectorAll('.vc-direct-batch-name')].map(e=>e.textContent),expected.remainingNames)
  assert.equal(calls.filter(c=>c.operation==='direct-crop-start').length,0)
 }finally{await act(async()=>rendered.unmount());dom.window.close();for(const key of keys){const descriptor=old.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}}
})


test('bulk table removal confirms all pages, excludes later batches and retries an unknown receipt without repeating other deletions',async()=>{
 const keys=['window','document','HTMLElement', 'HTMLButtonElement', 'MutationObserver','IS_REACT_ACT_ENVIRONMENT'],old=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)])),dom=new JSDOM('<div id="root"></div>',{url:'https://isolated.example/',pretendToBeVisual:true})
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement, MutationObserver: dom.window.MutationObserver,IS_REACT_ACT_ENVIRONMENT:true})
 const rendered=createRoot(document.getElementById('root')),Page=createDirectCropPage(React,ui),expected=JSON.parse(await readFile(new URL('./fixtures/direct-crop-batches.expected.json',import.meta.url),'utf8')).bulk
 const row=(id,status='completed')=>({runId:'batch-'+id,name:'Batch '+id.toUpperCase(),directCrop:true,removable:['completed','failed','cancelled'].includes(status),kind:'crop',origin:'local',status,createdAt:'2026-11-10T00:00:00Z',taskBrief:'Batch '+id,matched:1,unavailable:false,images:[],wallpaper:{runId:'wallpaper-'+id,status,total:1,planned:1,rendered:1,reviewed:1,passed:status==='completed'?1:0,attention:status==='completed'?0:1,budgetStopped:false,counts:{passed:status==='completed'?1:0}}})
 const rows=[row('a'),{...row('b','cancelled'),removable:false},row('c'),row('d','paused'),row('e')],hidden=new Set(),calls=[]
 let loseReply=true,listChanged=false
 const configuration={...imageConfig,visionConfigured:true,limits:{pageSize:2,maxImportFiles:30,maxImportBytes:20*1024*1024,pollIntervalMs:60000,deadlineMs:10000},source:{unsplash:{accounts:[]}}}
 const actions={directScope:()=> 'bulk-table-fixture',directCrop:async(operation,args,signal)=>{
  signal?.throwIfAborted();calls.push({operation,args})
  if(operation==='direct-crop-list'){
   const available=rows.filter(row=>!hidden.has(row.runId)),offset=args.offset??0
   return {batches:available.slice(offset,offset+2),total:available.length+(listChanged&&offset===2?1:0),...(offset+2<available.length?{nextOffset:offset+2}:{})}
  }
  if(operation==='direct-crop-delete'){
   assert(!['batch-b','batch-d','batch-f'].includes(args.runId),'Running, paused and later batches must not be submitted for deletion')
   hidden.add(args.runId)
   if(args.runId==='batch-c'&&loseReply){loseReply=false;throw new Error('Isolated receipt lost after commit')}
   return {runId:args.runId,deleted:true}
  }
  throw new Error('Unexpected operation '+operation)
 }}
 const button=text=>[...document.querySelectorAll('button')].find(e=>e.textContent===text)
 const checkbox=()=>document.querySelector('.vc-direct-table-toolbar input[type="checkbox"]')
 const summary=()=>[...document.querySelectorAll('.vc-direct-delete-summary strong')].map(e=>Number(e.textContent))
 try{
  await act(async()=>rendered.render(React.createElement(Page,{configuration,actions,t:key=>zh[key],onBack(){},onManageAccounts(){}})))
  assert.equal(document.querySelectorAll('.vc-direct-batch-table tbody tr').length,2)
  await act(async()=>checkbox().click())
  assert.equal(document.querySelectorAll('.vc-direct-batch-table tbody input:checked').length,2)
  await act(async()=>button(zh.directCropDeleteSelected).click());assert.deepEqual(summary(),[2,1,1])
  await act(async()=>button(zh.cancel).click())
  assert.equal(calls.filter(c=>c.operation==='direct-crop-delete').length,0)
  listChanged=true
  await act(async()=>button(zh.directCropDeleteAll).click())
  assert.equal(document.querySelector('[role="dialog"]'),null)
  assert.equal(document.querySelector('[role="alert"]').textContent,zh.directCropListChanged)
  assert.equal(calls.filter(c=>c.operation==='direct-crop-delete').length,0)
  listChanged=false
  const from=calls.length
  await act(async()=>button(zh.directCropDeleteAll).click())
  assert.deepEqual(calls.slice(from).map(c=>c.args.offset),[0,2,4,0])
  assert.deepEqual(summary(),[5,3,2]);assert(document.querySelector('[role="dialog"]').textContent.includes(zh.directCropDeleteAllHint))
  assert(document.querySelector('.vc-direct-delete-explanation').textContent.includes(zh.directCropDeleteHint))
  assert.equal(document.querySelector('.vc-direct-delete-records h3').textContent,zh.directCropDeleteListTitle)
  assert.equal(document.querySelectorAll('.vc-direct-delete-list li').length,2)
  assert.equal(document.querySelectorAll('.vc-direct-delete-list li[data-retained]').length,1)
  assert.equal(calls.filter(c=>c.operation==='direct-crop-delete').length,0)
  rows.push(row('f'))
  await act(async()=>button(zh.directCropDeleteConfirm).click())
  assert.deepEqual(calls.filter(c=>c.operation==='direct-crop-delete').map(c=>c.args.runId),['batch-a','batch-c'])
  assert(document.querySelector('[role="dialog"]'));assert(document.querySelector('[role="alert"]').textContent.includes(zh.directCropDeleteError))
  assert.equal(button(zh.directCropDeleteConfirm).disabled,false)
  await act(async()=>button(zh.directCropDeleteConfirm).click())
  const deletions=calls.filter(c=>c.operation==='direct-crop-delete')
  assert.deepEqual(deletions.map(c=>c.args.runId),expected.deletionIds)
  assert.equal(deletions[1].args.operationId,deletions[2].args.operationId)
  assert.equal(document.querySelector('[role="dialog"]'),null)
  assert.equal(document.querySelector('.vc-direct-delete-notice').textContent,expected.summary)
  assert.deepEqual(rows.filter(row=>!hidden.has(row.runId)).map(row=>row.runId),expected.retainedIds)
  await act(async()=>button(zh.directCropLoadMore).click())
  assert.deepEqual([...document.querySelectorAll('.vc-direct-batch-table tbody tr')].map(e=>e.dataset.runId),expected.retainedIds)
 }finally{await act(async()=>rendered.unmount());dom.window.close();for(const key of keys){const descriptor=old.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}}
})

test('server connection opens separately and pending-list loads retain receipts after failure', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/server-queue-client.expected.json', import.meta.url), 'utf8'))
  const keys = ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'MutationObserver', 'Element', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT'], old = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://isolated.example/', pretendToBeVisual: true })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement, MutationObserver: dom.window.MutationObserver, Element: dom.window.Element, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true })
  // React DOM loads before JSDOM in this file, so its legacy input observer needs DOM event aliases.
  dom.window.HTMLElement.prototype.attachEvent = function (name, listener) { this.addEventListener(name.slice(2), listener) }
  dom.window.HTMLElement.prototype.detachEvent = function (name, listener) { this.removeEventListener(name.slice(2), listener) }
  const rendered = createRoot(document.getElementById('root')), Queue = createServerQueue(React, ui), calls = [], selections = []
  let resolvePull, rejectPull, failConfiguration = true
  const view = { settings: { baseUrl: 'https://api.example', auth: { kind: 'credential', ref: 'EXISTING_TOKEN' }, allowedMediaOrigins: ['https://images.example'] }, snapshotId: 'saved-list', total: 6, items: [{ id: '69670', name: 'first.jpg', imported: true, runId: 'first', phase: 'approved', transfer: { status: 'unknown' } }, { id: '69674', name: 'second.jpg', imported: true, runId: 'second', phase: 'approved', transfer: { status: 'uploaded', current: true } }] }
  const invoke = async (operation, args) => {
    calls.push({ operation, args })
    if (operation === 'server-queue-read') return view
    if (operation === 'server-queue-pull') return new Promise((resolve, reject) => { resolvePull = resolve; rejectPull = reject })
    if (operation === 'server-queue-configure') { if (failConfiguration) throw { code: 'source-protocol-error' }; return { ...view, settings: args } }
    throw Error('Unexpected isolated operation: ' + operation)
  }
  const button = (text, root = document) => [...root.querySelectorAll('button')].find(element => element.textContent === text)
  const dialogs = () => [...document.querySelectorAll('[role="dialog"]')]
  try {
    await act(async () => rendered.render(React.createElement(React.StrictMode, null, React.createElement(Queue, { ready: true, invoke, t: key => zh[key], pollMs: 60000, limit: 20, onClose() {}, onStarted() { throw Error('Must not start image work') }, onSelected(value) { selections.push(value) } }))))
    assert.equal(dialogs().length, 1)
    await act(async () => [...document.querySelectorAll('button[aria-pressed]')].find(element => element.textContent.trim().startsWith(zh.serverFilterAll)).click())
    await act(async () => button(zh.serverSettings).click())
    assert.deepEqual(dialogs().map(dialog => dialog.getAttribute('aria-label')), fixture.dialogs)
    assert.equal(document.querySelector('.vc-server-modal .vc-server-settings'), null)
    assert(document.querySelector('.vc-server-settings-modal textarea'))
    await act(async () => document.querySelector('button[aria-label="' + zh.serverAuth + '"]').click())
    assert.deepEqual([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent), fixture.authenticationChoices)
    await act(async () => [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === zh.serverPostman).click())
    assert(document.querySelector('.vc-server-settings-modal').textContent.includes(zh.serverAuthPath))
    await act(async () => button(zh.cancel, dialogs().at(-1)).click())
    assert.equal(dialogs().length, 1)
    await act(async () => button(zh.serverSettings).click())
    assert.equal(document.querySelector('button[aria-label="' + zh.serverAuth + '"]').textContent, zh.serverCredential)
    await act(async () => button(zh.serverSave, dialogs().at(-1)).click())
    assert.equal(dialogs().length, 2)
    assert.equal(dialogs().at(-1).querySelector('[role="alert"]').textContent, zh.serverProtocolError)
    failConfiguration = false
    await act(async () => button(zh.serverSave, dialogs().at(-1)).click())
    assert.equal(dialogs().length, 1)
    assert.deepEqual(calls.filter(call => call.operation === 'server-queue-configure').map(call => call.args.auth), [{ kind: 'credential', ref: 'EXISTING_TOKEN' }, { kind: 'credential', ref: 'EXISTING_TOKEN' }])
    await act(async () => button(zh.serverPull).click())
    assert.equal(document.querySelector('.vc-server-table').getAttribute('aria-busy'), 'true')
    assert(document.querySelector('.vc-server-table .vc-skeleton-fill'))
    assert.equal(button(zh.serverPull).disabled, true)
    await act(async () => rejectPull({ code: 'source-protocol-error' }))
    assert.equal(document.querySelector('.vc-server-table').getAttribute('aria-busy'), null)
    assert.equal(document.querySelector('.vc-server-table .vc-skeleton-fill'), null)
    const receipts = () => [...document.querySelectorAll('.vc-server-table tbody tr')].map(row => ({ id: row.querySelector('.vc-server-file small').textContent, upload: row.cells[3].textContent, completed: row.cells[2].textContent === zh.serverCompleted, selectable: !row.querySelector('input').disabled, actions: [...row.querySelectorAll('button')].map(button => button.textContent) }))
    assert.deepEqual(receipts(), fixture.retainedReceipts)
    await act(async () => button(zh.serverPull).click())
    assert.equal(document.querySelector('.vc-server-table').getAttribute('aria-busy'), 'true')
    await act(async () => resolvePull(view))
    assert.deepEqual(receipts(), fixture.retainedReceipts)
    assert.equal(document.querySelector('[role="alert"]'), null)
    assert(calls.every(call => ['server-queue-read', 'server-queue-pull', 'server-queue-configure'].includes(call.operation)))
    view.items = fixture.selectionStates.map(({ completed, ...row }) => ({ ...row, name: row.id + '.png', imported: true, serverPending: false }))
    await act(async () => button(zh.serverPull).click())
    await act(async () => resolvePull(view))
    const rows = [...document.querySelectorAll('.vc-server-table tbody tr')]
    assert.deepEqual(rows.map(row => row.querySelector('input').disabled), [false, false, false, false, false, false, false, false, false, false, true])
    assert.deepEqual(rows.map(row => row.cells[2].textContent === zh.serverCompleted), [false, false, false, false, false, false, false, false, false, false, true])
    await act(async () => document.querySelector('.vc-server-table thead input').click())
    await act(async () => button(zh.directCropChooseOriginals).click())
    assert.deepEqual(selections[0].photos.map(photo => photo.id), ['81', '82', '83', '84', '85', '86', '87', '88', '89', '90'])
  } finally {
    await act(async () => rendered.unmount()); dom.window.close()
    for (const key of keys) { const descriptor = old.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
  }
})


test('server scrolling appends once and select all finishes pagination before selecting, retaining rows after a failed page', async () => {
  const expected = JSON.parse(await readFile(new URL('./fixtures/server-queue-client.expected.json', import.meta.url), 'utf8')).pagination
  const keys = ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'MutationObserver', 'Element', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT'], old = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://isolated.example/', pretendToBeVisual: true })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement, MutationObserver: dom.window.MutationObserver, Element: dom.window.Element, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true })
  const rendered = createRoot(document.getElementById('root')), Queue = createServerQueue(React, ui), requests = [], calls = [], selections = [], rowCounts = []
  const page = loaded => ({ settings: { baseUrl: 'https://api.example', auth: { kind: 'credential', ref: 'EXISTING' }, allowedMediaOrigins: ['https://images.example'] }, pendingKnown: true, snapshotId: 'page-' + loaded, total: 65, pagination: { loaded, hasMore: loaded < 65 }, items: Array.from({ length: loaded }, (_, index) => ({ id: String(index + 1), name: 'image-' + (index + 1), imported: false, serverPending: true, phase: 'waiting' })) })
  let view = page(20)
  const invoke = async (operation, args) => {
    calls.push({ operation, args })
    if (operation === 'server-queue-read') return view
    if (operation === 'server-queue-pull') return new Promise((resolve, reject) => requests.push({ resolve, reject }))
    throw Error('Unexpected pagination operation')
  }
  const props = { ready: true, invoke, t: key => zh[key], pollMs: 60000, limit: 30, onClose() {}, onStarted() { throw Error('Must not start image work') }, onSelected(value) { selections.push(value) } }
  const rows = () => [...document.querySelectorAll('.vc-server-table tbody tr')]
  const all = () => document.querySelector('.vc-server-table thead input')
  try {
    await act(async () => rendered.render(React.createElement(Queue, props)))
    rowCounts.push(rows().length)
    await act(async () => rows()[0].querySelector('input').click())
    const scroller = document.querySelector('.vc-server-table-scroll')
    for (const [key, value] of Object.entries({ clientHeight: 500, scrollHeight: 1500, scrollTop: 1200 })) Object.defineProperty(scroller, key, { value, configurable: true })
    await act(async () => { for (let count = 0; count < 5; count++) scroller.dispatchEvent(new dom.window.Event('scroll')) })
    assert.equal(requests.length, 1, 'Repeated bottom events share the active page request')
    assert.equal(rows().length, 20)
    assert.equal(document.querySelector('.vc-server-table .vc-skeleton-fill'), null)
    await act(async () => requests.shift().resolve(view = page(40)))
    rowCounts.push(rows().length)
    assert.equal(rows()[0].querySelector('input').checked, true)
    await act(async () => all().click())
    await act(async () => requests.shift().resolve(view = page(60)))
    assert(document.body.textContent.includes(zh.serverSelectingAll.replace('{loaded}', '60').replace('{total}', '65')))
    await act(async () => requests.shift().reject({ code: 'remote-timeout' }))
    rowCounts.push(rows().length)
    assert.equal(rows().filter(row => row.querySelector('input').checked).length, 1, 'A failed full load keeps the earlier explicit selection')
    assert(document.querySelector('[role="alert"]'))
    await act(async () => all().click())
    await act(async () => requests.shift().resolve(view = page(65)))
    rowCounts.push(rows().length)
    assert.equal(all().checked, true)
    assert.equal(rows().filter(row => row.querySelector('input').checked).length, expected.selected)
    assert(document.body.textContent.includes(zh.serverNeedSelection.replace('{count}', '30')))
    assert.equal([...document.querySelectorAll('button')].find(button => button.textContent === zh.directCropChooseOriginals).disabled, true)
    await act(async () => rendered.render(React.createElement(Queue, { ...props, limit: 100 })))
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === zh.directCropChooseOriginals).click())
    assert.equal(selections[0].photos.length, expected.selected)
    assert.deepEqual(rowCounts, expected.loadedRows)
    assert.equal(calls.filter(call => call.operation === 'server-queue-pull').length, expected.pageRequests)
    assert(calls.filter(call => call.operation === 'server-queue-pull').every(call => call.args.next === true))
  } finally {
    await act(async () => rendered.unmount()); dom.window.close()
    for (const key of keys) { const descriptor = old.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
  }
})

test('All loads 376 server rows without selecting them and can continue an active scroll request', async () => {
  const keys = ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'MutationObserver', 'Element', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT']
  const old = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://isolated.example/', pretendToBeVisual: true })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement, MutationObserver: dom.window.MutationObserver, Element: dom.window.Element, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true })
  const rendered = createRoot(document.getElementById('root'))
  const Queue = createServerQueue(React, ui)
  const requests = []
  const records = Array.from({ length: 376 }, (_, index) => ({
    id: String(index + 1), name: 'image-' + (index + 1), imported: false, serverPending: true,
    ...(index === 375 ? { phase: 'approved', transfer: { status: 'uploaded', current: true } } : { phase: 'waiting' }),
  }))
  const page = loaded => ({
    settings: { baseUrl: 'https://api.example', auth: { kind: 'credential', ref: 'EXISTING' }, allowedMediaOrigins: ['https://images.example'] },
    snapshotId: 'same-list', pendingKnown: true, total: 376, pagination: { loaded, hasMore: loaded < 376 }, items: records.slice(0, loaded),
  })
  const view = page(80)
  const invoke = async (operation, args) => {
    if (operation === 'server-queue-read') return view
    assert.equal(operation, 'server-queue-pull')
    assert.deepEqual(args, { next: true })
    return new Promise((resolve, reject) => requests.push({ resolve, reject }))
  }
  const rows = () => [...document.querySelectorAll('.vc-server-table tbody tr')]
  const allTab = () => [...document.querySelectorAll('.vc-server-filters button')].find(button => button.textContent.startsWith(zh.serverFilterAll))
  const checked = () => document.querySelectorAll('.vc-server-table tbody input:checked').length
  try {
    await act(async () => rendered.render(React.createElement(Queue, {
      ready: true, invoke, t: key => zh[key], pollMs: 60000, limit: 400,
      onClose() {}, onStarted() { assert.fail('Must not start image work') }, onSelected() { assert.fail('Must not import images') },
    })))
    assert.equal(rows().length, 80)
    await act(async () => allTab().click())
    assert.equal(requests.length, 1, 'Clicking All starts loading the remaining pages immediately')
    await act(async () => requests.shift().resolve(page(100)))
    assert(document.body.textContent.includes(zh.serverSelectingAll.replace('{loaded}', '100').replace('{total}', '376')))
    await act(async () => requests.shift().reject({ code: 'remote-timeout' }))
    assert.equal(rows().length, 100, 'An interrupted full load keeps the pages it received')
    assert(document.querySelector('[role="alert"]'))

    const scroller = document.querySelector('.vc-server-table-scroll')
    for (const [key, value] of Object.entries({ clientHeight: 500, scrollHeight: 1500, scrollTop: 1200 })) Object.defineProperty(scroller, key, { value, configurable: true })
    await act(async () => scroller.dispatchEvent(new dom.window.Event('scroll')))
    assert.equal(requests.length, 1)
    assert.equal(allTab().disabled, false)
    await act(async () => allTab().click())
    assert.equal(requests.length, 1, 'Clicking All continues the active page instead of issuing a duplicate')
    for (let loaded = 120; loaded <= 380; loaded += 20) {
      assert.equal(requests.length, 1)
      await act(async () => requests.shift().resolve(page(Math.min(loaded, 376))))
    }
    assert.equal(requests.length, 0)
    assert.equal(rows().length, 376)
    assert.equal(checked(), 0)
    await act(async () => document.querySelector('.vc-server-table thead input').click())
    assert.equal(checked(), 375)
    assert.equal(rows().at(-1).querySelector('input').disabled, true)
    assert.equal(requests.length, 0)
  } finally {
    await act(async () => rendered.unmount())
    dom.window.close()
    for (const [key, descriptor] of old) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
  }
})

test('manual server token uses credential storage, never enters connection data, and preserves the local Postman option', async () => {
  const keys = ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'MutationObserver', 'Element', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT'], old = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://isolated.example/', pretendToBeVisual: true })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement, MutationObserver: dom.window.MutationObserver, Element: dom.window.Element, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true })
  dom.window.HTMLElement.prototype.attachEvent = function (name, listener) { this.addEventListener(name.slice(2), listener) }
  dom.window.HTMLElement.prototype.detachEvent = function (name, listener) { this.removeEventListener(name.slice(2), listener) }
  const rendered = createRoot(document.getElementById('root')), Queue = createServerQueue(React, ui), writes = [], calls = [], token = 'isolated-manual-token'
  let failWrite = true, view = { settings: { baseUrl: 'https://api.example/api/', auth: { kind: 'postman', path: 'D:/isolated/postman.json' }, allowedMediaOrigins: ['https://images.example'] }, snapshotId: '', total: 0, items: [] }
  const invoke = async (operation, args) => { calls.push({ operation, args }); if (operation === 'server-queue-read') return view; if (operation === 'server-queue-configure') return view = { ...view, settings: args }; throw Error('Unexpected operation') }
  const saveCredential = async (ref, value) => { if (failWrite) throw Error('Isolated credential storage failure'); writes.push({ ref, value }) }
  const button = text => [...document.querySelectorAll('button')].find(element => element.textContent === text)
  const choose = async text => { await act(async () => document.querySelector('button[aria-label="' + zh.serverAuth + '"]').click()); await act(async () => [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === text).click()) }
  const { Simulate } = require('react-dom/test-utils')
  try {
    await act(async () => rendered.render(React.createElement(Queue, { ready: true, invoke, saveCredential, t: key => zh[key], pollMs: 60000, limit: 20, onClose() {}, onStarted() {} })))
    await act(async () => button(zh.serverSettings).click())
    assert.equal(document.querySelector('.vc-server-settings-modal input[id$="-auth-value"]').value, 'D:/isolated/postman.json')
    await choose(zh.serverManualToken)
    let input = document.querySelector('input[type="password"]'); assert(input); assert.equal(input.value, '')
    await act(async () => button(zh.serverSave).click())
    assert.equal(document.querySelector('[role="alert"]').textContent, zh.serverTokenRequired)
    await act(async () => { input.value = token; Simulate.change(input) })
    await act(async () => button(zh.serverSave).click())
    assert.equal(document.querySelector('[role="alert"]').textContent, zh.serverTokenSaveError)
    assert.equal(calls.filter(call => call.operation === 'server-queue-configure').length, 0)
    assert.equal(input.value, token)
    failWrite = false
    await act(async () => button(zh.serverSave).click())
    assert.equal(writes.length, 1); assert.equal(writes[0].value, token); assert.match(writes[0].ref, /^VISUAL_CURATOR_SERVER_MANUAL_/)
    assert.equal(JSON.stringify(calls).includes(token), false)
    assert.equal(view.settings.baseUrl, 'https://api.example/api')
    assert.deepEqual(view.settings.auth, { kind: 'credential', ref: writes[0].ref })
    await act(async () => button(zh.serverSettings).click())
    input = document.querySelector('input[type="password"]'); assert.equal(input.value, ''); assert.equal(input.placeholder, zh.serverTokenKeep)
    await act(async () => button(zh.serverSave).click()); assert.equal(writes.length, 1)
    await act(async () => button(zh.serverSettings).click()); await choose(zh.serverPostman)
    assert.equal(document.querySelector('input[id$="-auth-value"]').value, 'D:/isolated/postman.json')
    await act(async () => button(zh.serverSave).click()); assert.deepEqual(view.settings.auth, { kind: 'postman', path: 'D:/isolated/postman.json' })
    assert.equal(JSON.stringify(calls).includes(token), false)
  } finally { await act(async () => rendered.unmount()); dom.window.close(); for (const key of keys) { const descriptor = old.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } }
})

test('direct page shows and polls a background import with no batches, preserves it when the modal closes, and restores it on reopening', { timeout: 10000 }, async () => {
  const keys = ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'MutationObserver', 'Element', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT'], old = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://isolated.example/', pretendToBeVisual: true })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement, MutationObserver: dom.window.MutationObserver, Element: dom.window.Element, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true })
  let rendered = createRoot(document.getElementById('root')), reads = 0
  const Page = createDirectCropPage(React, ui), polled = Promise.withResolvers(), calls = []
  let entry = { runId: 'background-batch', name: 'Queued originals', status: 'importing', saved: 0, total: 2, receivedBytes: 1024 }
  const configuration = { ...imageConfig, visionConfigured: true, limits: { pageSize: 20, maxImportFiles: 20, pollIntervalMs: 20 }, source: { unsplash: { accounts: [] } } }
  const actions = { directScope: () => 'background-profile', saveCredential: async () => {}, directCrop: async (operation, args) => {
    calls.push({ operation, args })
    if (operation === 'direct-crop-list') { if (++reads >= 2) polled.resolve(); return { batches: [], total: 0, imports: [entry] } }
    if (operation === 'server-queue-read') return { settings: { baseUrl: 'https://api.example', auth: { kind: 'credential', ref: 'EXISTING' }, allowedMediaOrigins: ['https://images.example'] }, snapshotId: 'saved', total: 0, items: [] }
    if (operation === 'server-queue-import-retry') { entry = { ...entry, status: 'importing' }; return { runId: entry.runId } }
    throw Error('Unexpected operation')
  } }
  const props = { configuration, actions, t: key => zh[key], onBack() {}, onManageAccounts() {} }
  window.localStorage.setItem('visual-curator:direct-route:background-profile', JSON.stringify({runId:'background-batch'}))
  const button = text => [...document.querySelectorAll('button')].find(element => element.textContent === text)
  try {
    await act(async () => rendered.render(React.createElement(Page, props)))
    assert(document.querySelector('[data-server-import="background-batch"]')); assert.equal(document.querySelector('.vc-direct-empty'), null)
    assert.equal(document.querySelector('.vc-direct-import-pending'), null)
    assert(document.querySelector('.vc-direct-batch-table tbody tr[data-server-import]'))
    assert.equal(document.querySelector('.vc-direct-header-progress'), null)
    assert.equal(document.querySelector('[data-server-import] progress').value, 0)
    await act(async () => { await polled.promise })
    assert(reads >= 2, 'The empty batch list must continue polling its pending import')
    await act(async () => button(zh.directCropAddImages).click())
    await act(async () => [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === zh.serverQueue).click())
    assert(document.querySelector('[role="dialog"]'))
    await act(async () => button(zh.close).click())
    assert.equal(document.querySelector('[role="dialog"]'), null); assert(document.querySelector('[data-server-import="background-batch"]'))
    entry = { ...entry, status: 'interrupted', saved: 1, receivedBytes: 0 }
    await act(async () => button(zh.refresh).click())
    assert.equal(document.querySelector('[data-server-import] progress').value, 1)
    assert(document.querySelector('[data-server-import]').textContent.includes(zh.serverImportInterrupted))
    await act(async () => rendered.unmount()); rendered = createRoot(document.getElementById('root'))
    await act(async () => rendered.render(React.createElement(Page, props)))
    assert.equal(document.querySelector('[data-server-import] progress').value, 1)
    await act(async () => button(zh.serverImportResume).click())
    assert(calls.some(call => call.operation === 'server-queue-import-retry' && call.args.runId === 'background-batch'))
    assert(document.querySelector('[data-server-import]').textContent.includes(zh.serverImportPhaseRunning))
    assert.equal(calls.some(call => call.operation === 'server-queue-start'), false)
    entry = { ...entry, status: 'failed', errorCode: 'source-protocol-error' }
    await act(async () => button(zh.refresh).click())
    assert(document.querySelector('[data-server-import]').textContent.includes(zh.serverImportChanged))
  } finally { await act(async () => rendered.unmount()); dom.window.close(); for (const key of keys) { const descriptor = old.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } }
})


test('import image choices persist across openings, source changes and remounts without switching a missing account', async () => {
  const keys = ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'MutationObserver', 'Element', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT'], previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://isolated.example/', pretendToBeVisual: true })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement, MutationObserver: dom.window.MutationObserver, Element: dom.window.Element, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })
  const rendered = createRoot(document.getElementById('root')), Page = createDirectCropPage(React, ui), requests = []
  const configuration = { ...imageConfig, wallpaperImage: { imageProvider: 'visual-curator-openai', imageSourceId: 'key-one', imageModel: 'gpt-image-2' }, revision: 'preferences-test', visionConfigured: true, limits: { maxImportFiles: 20, maxImportBytes: 20 * 1024 * 1024, pollIntervalMs: 60000 }, source: { unsplash: { accounts: [] } } }
  let accountAvailable = true
  const actions = { directScope: () => 'remembered-profile', pickLocalReferences: async () => ({ files: [{ path: 'C:/isolated/source.png', name: 'source.png', size: 1024, readable: true }] }), directCrop: async (operation, args) => {
    if (operation === 'direct-crop-list') return { batches: [], total: 0 }
    if (operation === 'wallpaper-options') return { ...imageOptions, providers: imageOptions.providers.map(provider => provider.id === 'autoflow-codex' ? { ...provider, models: [...provider.models, { id: 'gpt-image-2', name: 'GPT Image 2' }], sources: accountAvailable ? [{ id: 'chosen-account', name: 'Chosen subscription', available: true }] : [] } : provider) }
    if (operation === 'direct-crop-start') { requests.push(args); throw { code: 'budget-exhausted', stage: 'media' } }
    throw new Error('Unexpected operation')
  } }
  const button = label => [...document.querySelectorAll('button')].find(element => element.textContent === label)
  const field = label => document.querySelector('button[aria-label="' + label + '"]')
  const select = async (label, option) => {
    await act(async () => field(label).click())
    await act(async () => [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === option).click())
  }
  const open = async () => {
    await act(async () => button(zh.directCropAddImages).click())
    await act(async () => [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === zh.directCropLocal).click())
  }
  const paint = (key, scopedActions = actions) => act(async () => rendered.render(React.createElement(Page, { key, configuration, actions: scopedActions, t: key => zh[key], onBack() {} })))
  try {
    await paint('initial')
    await open()
    await select(zh.imageGenerationSource, 'Codex')
    await select(zh.imageGenerationAccount, 'Chosen subscription')
    await select(zh.wallpaperImageModel, 'GPT Image 2')
    await act(async () => button(zh.cancel).click())
    await open()
    assert.equal(field(zh.imageGenerationSource).textContent, 'Codex')
    assert.equal(field(zh.imageGenerationAccount).textContent, 'Chosen subscription')
    assert.equal(field(zh.wallpaperImageModel).textContent, 'GPT Image 2')
    await select(zh.imageGenerationSource, 'OpenAI API')
    assert.equal(field(zh.imageGenerationAccount).textContent, 'Personal key')
    await select(zh.imageGenerationSource, 'Codex')
    assert.equal(field(zh.imageGenerationAccount).textContent, 'Chosen subscription')
    assert.equal(field(zh.wallpaperImageModel).textContent, 'GPT Image 2')
    await paint('remounted')
    await open()
    assert.equal(field(zh.imageGenerationSource).textContent, 'Codex')
    assert.equal(field(zh.imageGenerationAccount).textContent, 'Chosen subscription')
    await act(async () => button(zh.directCropStart).click())
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.deepEqual(requests[0].imageRoute, expected.imagePreferences.submittedRoute)
    const notice = document.querySelector('.vc-direct-admission-notice [role="alert"]')
    assert.equal(notice.querySelector('.vc-direct-admission-message').textContent, expected.imagePreferences.storageLimitError)
    assert.equal(notice.closest('td').colSpan, 8)
    assert.equal(document.querySelector('[data-import-admission] [aria-label^="' + zh.directCropDismissImport + '"]').classList.contains('vc-direct-batch-delete'), true)
    accountAvailable = false
    await paint('missing-account')
    await open()
    assert.equal(field(zh.imageGenerationSource).textContent, 'Codex')
    assert.equal(button(zh.directCropStart).disabled, true)
    assert.equal(requests.length, 1, 'A missing saved account cannot silently dispatch through automatic selection')
    await paint('another-profile', { ...actions, directScope: () => 'other-profile' })
    await open()
    assert.equal(field(zh.imageGenerationSource).textContent, 'OpenAI API')
    assert.equal(field(zh.imageGenerationAccount).textContent, 'Personal key')
  } finally {
    await act(async () => rendered.unmount()); dom.window.close()
    for (const key of keys) { const descriptor = previous.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
  }
})


test('image storage opens from the page and requires an explicit second confirmation before cleanup', async () => {
  const keys = ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'MutationObserver', 'Element', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT'], previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://isolated.example/', pretendToBeVisual: true })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement, MutationObserver: dom.window.MutationObserver, Element: dom.window.Element, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })
  const rendered = createRoot(document.getElementById('root')), Page = createDirectCropPage(React, ui), cleanRequests = [], moveRequests = [], resumeRequests = []
  let storage = { directory: 'C:/isolated-profile/visual-curator', revision: 'preview-before', usedBytes: 4 * 1024 ** 3 - 1000, limitBytes: 4 * 1024 ** 3, retainedBytes: 4 * 1024 ** 3 - 1000 - 1024 ** 2, reclaimableBytes: 1024 ** 2, reclaimableFiles: 2, cleanupAllowed: true }
  const configuration = { ...imageConfig, revision: 'storage-config', visionConfigured: true, limits: { maxImportFiles: 20, maxImportBytes: 20 * 1024 * 1024, pollIntervalMs: 60000 }, source: { unsplash: { accounts: [] } } }
  const actions = { directScope: () => 'storage-profile', directCrop: async (operation, args) => {
    if (operation === 'direct-crop-list') return { batches: [], total: 0 }
    if (operation === 'wallpaper-options') return imageOptions
    if (operation === 'image-storage-read') return storage
    if (operation === 'image-storage-directory-pick') return { directory: 'D:/new-library' }
    if (operation === 'image-storage-migrate') { moveRequests.push(args); storage = { ...storage, cleanupAllowed: false, migration: { id: args.operationId, status: 'running', phase: 'copying', sourceDirectory: storage.directory, targetDirectory: args.directory, totalBytes: 100, totalFiles: 2, copiedBytes: 50, copiedFiles: 1, verifiedBytes: 0, verifiedFiles: 0, removedBytes: 0, removedFiles: 0 } }; return { directory: storage.directory, migration: storage.migration } }
    if (operation === 'image-storage-migration-resume') { resumeRequests.push(args); storage = { ...storage, cleanupAllowed: false, migration: { ...storage.migration, status: 'running', phase: 'preparing' } }; return { directory: storage.directory, migration: storage.migration } }
    if (operation === 'image-storage-clean') { cleanRequests.push(args); storage = { ...storage, revision: 'preview-after', usedBytes: storage.retainedBytes, reclaimableBytes: 0, reclaimableFiles: 0, freedBytes: 1024 ** 2, freedFiles: 2 }; return storage }
    throw new Error('Unexpected operation')
  } }
  const button = label => [...document.querySelectorAll('button')].find(element => element.textContent === label)
  try {
    await act(async () => rendered.render(React.createElement(Page, { configuration, actions, t: key => zh[key], onBack() {} })))
    await act(async () => button(zh.imageStorageTitle).click())
    assert(document.querySelector('.vc-image-storage-modal'))
    assert(document.querySelector('.vc-image-storage-modal').textContent.includes(zh.imageStorageHint))
    assert.equal(cleanRequests.length, 0)
    assert.equal(button(zh.imageStorageSaveLimit).disabled, true)
    await act(async () => button(zh.imageStorageClean).click())
    assert.equal(cleanRequests.length, 0, 'The first click only presents the deletion scope')
    assert(document.querySelector('[role="alert"]').textContent.includes('1.00 MiB'))
    await act(async () => button(zh.cancel).click())
    assert(document.querySelector('.vc-image-storage-modal'))
    assert.equal(cleanRequests.length, 0)
    await act(async () => button(zh.imageStorageClean).click())
    await act(async () => button(zh.imageStorageConfirmClean).click())
    assert.deepEqual(cleanRequests, [{ revision: 'preview-before', confirm: true }])
    assert(document.querySelector('.vc-image-storage-result').textContent.includes('1.00 MiB'))
    assert.equal(button(zh.imageStorageClean).disabled, true)
    await act(async () => button(zh.close).click())
    assert.equal(document.querySelector('[role="dialog"]'), null)
    storage = { ...storage, cleanupAllowed: false, reclaimableFiles: 2, reclaimableBytes: 1024 ** 2 }
    await act(async () => button(zh.imageStorageTitle).click())
    assert.equal(button(zh.imageStorageClean).disabled, true, 'Active work prevents cleanup while preserving the preview')
    assert(document.querySelector('.vc-image-storage-modal').textContent.includes(zh.imageStorageBusy))
    await act(async () => button(zh.close).click())
    assert.equal(document.querySelector('[role="dialog"]'), null)
    storage = { ...storage, cleanupAllowed: true }
    await act(async () => button(zh.imageStorageTitle).click())
    await act(async () => button(zh.imageStorageChooseDirectory).click())
    assert.equal(moveRequests.length, 0, 'Picking a directory does not move files before confirmation')
    assert(document.querySelector('.vc-image-storage-confirm').textContent.includes('D:/new-library'))
    await act(async () => button(zh.imageStorageStartMove).click())
    assert.equal(moveRequests.length, 1)
    assert.equal(moveRequests[0].sourceDirectory, 'C:/isolated-profile/visual-curator')
    assert.equal(moveRequests[0].confirm, true)
    assert.equal(button(zh.imageStorageChooseDirectory).disabled, true)
    const progress = document.querySelector('.vc-image-storage-transfer')
    assert.deepEqual({ label: progress.querySelector('strong').textContent, background: progress.textContent.includes(zh.imageStorageMoveBackground), closeEnabled: !button(zh.close).disabled }, expected.storageMigration)
    await act(async () => button(zh.close).click())
    assert.equal(document.querySelector('[role="dialog"]'), null)
    await act(async () => button(zh.imageStorageTitle).click())
    assert(document.querySelector('.vc-image-storage-transfer').textContent.includes(zh.imageStorageMoveCopying))
    assert.equal(moveRequests.length, 1, 'Reopening reads progress without starting a second transfer')
    await act(async () => button(zh.close).click())
    storage = { ...storage, cleanupAllowed: true, migration: { ...storage.migration, status: 'failed', phase: 'preparing', totalBytes: 0, totalFiles: 0, copiedBytes: 0, copiedFiles: 0, errorCode: 'reference-unavailable' } }
    await act(async () => button(zh.imageStorageTitle).click())
    const failure = document.querySelector('.vc-image-storage-transfer')
    assert.deepEqual({ label: failure.querySelector('strong').textContent, progressVisible: !!failure.querySelector('progress'), zeroCountsVisible: failure.textContent.includes('0 / 0'), backgroundContinuing: failure.textContent.includes(zh.imageStorageMoveBackground), recoveryInFooter: button(zh.imageStorageResumeMove).closest('.vc-image-storage-actions') !== null, quotaCollapsed: !document.querySelector('.vc-image-storage-limit').open }, expected.storageMigrationStates.failed)
    await act(async () => button(zh.imageStorageResumeMove).click())
    assert.deepEqual(resumeRequests, [{ id: moveRequests[0].operationId }])
    assert.deepEqual({ indeterminate: !document.querySelector('.vc-image-storage-transfer progress').hasAttribute('value'), zeroCountsVisible: document.querySelector('.vc-image-storage-transfer').textContent.includes('0 / 0') }, expected.storageMigrationStates.preparing)
    await act(async () => button(zh.close).click())
    storage = { ...storage, cleanupAllowed: true, migration: { ...storage.migration, status: 'completed', totalFiles: 2, totalBytes: 100, missingFiles: 1356 } }
    await act(async () => button(zh.imageStorageTitle).click())
    assert.equal(document.querySelector('.vc-image-storage-transfer-warning').textContent, expected.storageMigrationStates.missing)
    await act(async () => button(zh.close).click())
  } finally {
    await act(async () => rendered.unmount()); dom.window.close()
    for (const key of keys) { const descriptor = previous.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
  }
})
