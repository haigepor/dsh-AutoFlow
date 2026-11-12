/** Isolated UI checks use shipped form primitives; native canvas acceptance is recorded separately. */
import test from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const expected = JSON.parse(await readFile(new URL('./fixtures/direct-crop-import.expected.json', import.meta.url), 'utf8'))
const root = fileURLToPath(new URL('../', import.meta.url)), require = createRequire(import.meta.url)
const React = require('react'), { act } = React, { createRoot } = require('react-dom/client')
const names = ['SegmentedTabs', 'Modal', 'Button', 'Input', 'Tag', 'StateDot', 'Menu', 'Checkbox', 'Tooltip', 'TextArea']
const contents = names.map(name => `import {${name}} from '../../../packages/client/ui-primitives/src/${name}.tsx'`).join('\n') + `\nexport const ui={${names.join(',')}}; export {createDirectCropPage,directCropVisible,directCropWorkspaceKey} from './src/client/direct-crop.tsx'; export {createServerQueue} from './src/client/server-queue.tsx'; export {zh} from './src/client/workbench-locale.ts'`
const compiled = await build({ stdin: { contents, resolveDir: root, loader: 'ts' }, outfile: resolve(root, 'tests/direct-crop-memory.cjs'), bundle: true, write: false, external: ['react', 'react/*', 'react-dom', 'react-dom/*'], platform: 'node', format: 'cjs', loader: { '.css': 'empty', '.webp': 'empty' }, logLevel: 'silent' })
const filename = resolve(root, 'tests/direct-crop-memory.cjs'), capsule = new Module(filename)
capsule.filename = filename; capsule.paths = Module._nodeModulePaths(dirname(filename)); capsule._compile(compiled.outputFiles.find(file => file.path.endsWith('.cjs')).text, filename)
const { ui: primitives, createDirectCropPage, directCropVisible, directCropWorkspaceKey, createServerQueue, zh } = capsule.exports
// Decorative icons do not own form semantics in this isolated DOM check.
const ui = { ...primitives, ...Object.fromEntries(['IconPlusOutlineRegular', 'IconFolderOpenOutlineRegular', 'IconChevronLeftOutlineRegular', 'IconChevronRightOutlineRegular', 'IconChevronDownOutlineRegular', 'IconRefreshOutlineRegular', 'IconBrowseOutlineRegular', 'IconTrashOutlineRegular', 'IconSearchOutlineRegular', 'IconPinOutlineRegular', 'IconInfoOutlineRegular'].map(name => [name, () => React.createElement('span', { 'aria-hidden': true })])) }

test('direct import requires no collection, retains selection after failure and reuses the same request identity', async () => {
  const keys = ['window', 'document', 'HTMLElement', 'Element', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT'], old = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://isolated.example/', pretendToBeVisual: true })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })
  const rendered = createRoot(document.getElementById('root')), Page = createDirectCropPage(React, ui), calls = []
  let fail = true, pendingGallery, pickedCalls = 0
  const configuration = { visionConfigured: true, limits: { pageSize: 20, maxImportFiles: 30, maxImportBytes: 20 * 1024 * 1024, pollIntervalMs: 2000, deadlineMs: 60000, requestTimeoutMs: 10000, maxGalleryReferenceFiles: 1000 }, source: { unsplash: { accounts: [{ id: 'account', label: 'Gallery account' }], defaultAccountId: 'account' } } }
  const actions = { directScope: () => 'profile-a', directCrop: async (operation, args, signal) => { signal?.throwIfAborted(); calls.push({ operation, args, signal }); if (operation === 'direct-crop-list') return { batches: [], total: 0 }; if (operation === 'direct-crop-start') { if (fail) throw new Error('Isolated network interruption'); return { runId: 'accepted' } } throw new Error('Unexpected operation') }, pickLocalReferences: async (_kind, signal, title) => {
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
    assert.deepEqual([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent), [zh.directCropLocal, zh.directCropGallery, zh.serverQueue])
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
    assert.equal(button(zh.directCropStart).disabled, false)
    await act(async () => button(zh.directCropStart).click())
    assert(document.querySelector('[role="dialog"]'), 'Failed admission keeps its original selection')
    assert.equal(document.querySelectorAll('[role="alert"]').length, 1, 'The import error is displayed once inside its dialog')
    assert.equal(document.querySelector('[role="alert"]').textContent, expected.startError)
    await act(async () => button(zh.refresh).click())
    assert(document.querySelector('[role="alert"]').textContent.includes(zh.directCropStartError), 'Successful background reads cannot erase admission errors')
    fail = false
    await act(async () => button(zh.directCropStart).click())
    const starts = calls.filter(call => call.operation === 'direct-crop-start')
    assert.equal(starts.length, 2); assert.equal(starts[0].args.operationId, starts[1].args.operationId)
    assert.deepEqual(starts[1].args.source, { kind: 'local', files: [{ path: 'C:/isolated/source.png', name: 'source.png' }] })
    assert.equal('styleId' in starts[1].args, false); assert.equal('sourceRunId' in starts[1].args, false)
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert(button(zh.directCropAddImages), 'The empty batch projection keeps the import entry reachable')
    await act(async () => button(zh.directCropAddImages).click())
    await act(async () => menuItem(zh.directCropGallery).click())
    assert(pendingGallery && !pendingGallery.aborted)
    await act(async () => button(zh.close).click())
    assert.equal(pendingGallery.aborted, true)
    assert(calls.every(call => call.operation.startsWith('direct-crop-')))
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

test('batch table confirms removal, retains unknown outcomes for retry and ignores late list replies',async()=>{
 const keys=['window','document','HTMLElement','IS_REACT_ACT_ENVIRONMENT'],old=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)])),dom=new JSDOM('<div id="root"></div>',{url:'https://isolated.example/',pretendToBeVisual:true})
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})
 const rendered=createRoot(document.getElementById('root')),Page=createDirectCropPage(React,ui),expected=JSON.parse(await readFile(new URL('./fixtures/direct-crop-batches.expected.json',import.meta.url),'utf8'))
 const rows=expected.batches.map((row,index)=>({...row,directCrop:true,removable:['completed','failed','cancelled'].includes(row.status),kind:'crop',origin:'local',createdAt:'2026-11-10T00:00:00Z',taskBrief:row.name,matched:2,unavailable:false,images:[],wallpaper:{runId:row.runId+'-latest',status:row.status,total:2,planned:2,rendered:1,reviewed:1,passed:1,attention:index===1?0:1,budgetStopped:false,counts:{passed:1}}}))
 const calls=[],hidden=new Set();let hold=false,late,loseReply=true
 const configuration={visionConfigured:true,limits:{pageSize:20,maxImportFiles:30,maxImportBytes:20*1024*1024,pollIntervalMs:60000,deadlineMs:10000},source:{unsplash:{accounts:[]}}}
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
 const keys=['window','document','HTMLElement','IS_REACT_ACT_ENVIRONMENT'],old=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)])),dom=new JSDOM('<div id="root"></div>',{url:'https://isolated.example/',pretendToBeVisual:true})
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})
 const rendered=createRoot(document.getElementById('root')),Page=createDirectCropPage(React,ui),expected=JSON.parse(await readFile(new URL('./fixtures/direct-crop-batches.expected.json',import.meta.url),'utf8')).bulk
 const row=(id,status='completed')=>({runId:'batch-'+id,name:'Batch '+id.toUpperCase(),directCrop:true,removable:['completed','failed','cancelled'].includes(status),kind:'crop',origin:'local',status,createdAt:'2026-11-10T00:00:00Z',taskBrief:'Batch '+id,matched:1,unavailable:false,images:[],wallpaper:{runId:'wallpaper-'+id,status,total:1,planned:1,rendered:1,reviewed:1,passed:status==='completed'?1:0,attention:status==='completed'?0:1,budgetStopped:false,counts:{passed:status==='completed'?1:0}}})
 const rows=[row('a'),{...row('b','cancelled'),removable:false},row('c'),row('d','paused'),row('e')],hidden=new Set(),calls=[]
 let loseReply=true,listChanged=false
 const configuration={visionConfigured:true,limits:{pageSize:2,maxImportFiles:30,maxImportBytes:20*1024*1024,pollIntervalMs:60000,deadlineMs:10000},source:{unsplash:{accounts:[]}}}
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
  const keys = ['window', 'document', 'HTMLElement', 'Element', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT'], old = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://isolated.example/', pretendToBeVisual: true })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true })
  // React DOM loads before JSDOM in this file, so its legacy input observer needs DOM event aliases.
  dom.window.HTMLElement.prototype.attachEvent = function (name, listener) { this.addEventListener(name.slice(2), listener) }
  dom.window.HTMLElement.prototype.detachEvent = function (name, listener) { this.removeEventListener(name.slice(2), listener) }
  const rendered = createRoot(document.getElementById('root')), Queue = createServerQueue(React, ui), calls = []
  let resolvePull, rejectPull, failConfiguration = true
  const view = { settings: { baseUrl: 'https://api.example', auth: { kind: 'credential', ref: 'EXISTING_TOKEN' }, allowedMediaOrigins: ['https://images.example'] }, snapshotId: 'saved-list', total: 6, items: [{ id: '69670', name: 'first.jpg', imported: true, runId: 'first', phase: 'approved', transfer: { status: 'unknown' } }, { id: '69674', name: 'second.jpg', imported: true, runId: 'second', phase: 'approved', transfer: { status: 'uploaded' } }] }
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
    await act(async () => rendered.render(React.createElement(React.StrictMode, null, React.createElement(Queue, { ready: true, invoke, t: key => zh[key], pollMs: 60000, limit: 20, onClose() {}, onStarted() { throw Error('Must not start image work') } }))))
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
    const receipts = () => [...document.querySelectorAll('.vc-server-table tbody tr')].map(row => ({ id: row.querySelector('.vc-server-file small').textContent, upload: row.cells[3].textContent, actions: [...row.querySelectorAll('button')].map(button => button.textContent) }))
    assert.deepEqual(receipts(), fixture.retainedReceipts)
    await act(async () => button(zh.serverPull).click())
    assert.equal(document.querySelector('.vc-server-table').getAttribute('aria-busy'), 'true')
    await act(async () => resolvePull(view))
    assert.deepEqual(receipts(), fixture.retainedReceipts)
    assert.equal(document.querySelector('[role="alert"]'), null)
    assert(calls.every(call => ['server-queue-read', 'server-queue-pull', 'server-queue-configure'].includes(call.operation)))
  } finally {
    await act(async () => rendered.unmount()); dom.window.close()
    for (const key of keys) { const descriptor = old.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
  }
})


test('manual server token uses credential storage, never enters connection data, and preserves the local Postman option', async () => {
  const keys = ['window', 'document', 'HTMLElement', 'Element', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT'], old = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://isolated.example/', pretendToBeVisual: true })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true })
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
  const keys = ['window', 'document', 'HTMLElement', 'Element', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT'], old = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://isolated.example/', pretendToBeVisual: true })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true })
  let rendered = createRoot(document.getElementById('root')), reads = 0
  const Page = createDirectCropPage(React, ui), polled = Promise.withResolvers(), calls = []
  let entry = { runId: 'background-batch', name: 'Queued originals', status: 'importing', saved: 0, total: 2, receivedBytes: 1024 }
  const configuration = { visionConfigured: true, limits: { pageSize: 20, maxImportFiles: 20, pollIntervalMs: 20 }, source: { unsplash: { accounts: [] } } }
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
    assert(document.querySelector('.vc-direct-header-progress'))
    assert.equal(document.querySelector('[data-server-import] progress'), null)
    await act(async () => { await polled.promise })
    assert(reads >= 2, 'The empty batch list must continue polling its pending import')
    await act(async () => button(zh.directCropAddImages).click())
    await act(async () => [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === zh.serverQueue).click())
    assert(document.querySelector('[role="dialog"]'))
    await act(async () => button(zh.close).click())
    assert.equal(document.querySelector('[role="dialog"]'), null); assert(document.querySelector('[data-server-import="background-batch"]'))
    entry = { ...entry, status: 'interrupted', saved: 1, receivedBytes: 0 }
    await act(async () => button(zh.refresh).click())
    assert.equal(document.querySelector('.vc-direct-header-progress progress').value, 1)
    assert(document.querySelector('[data-server-import]').textContent.includes(zh.serverImportInterrupted))
    await act(async () => rendered.unmount()); rendered = createRoot(document.getElementById('root'))
    await act(async () => rendered.render(React.createElement(Page, props)))
    assert.equal(document.querySelector('.vc-direct-header-progress progress').value, 1)
    await act(async () => button(zh.serverImportResume).click())
    assert(calls.some(call => call.operation === 'server-queue-import-retry' && call.args.runId === 'background-batch'))
    assert(document.querySelector('[data-server-import]').textContent.includes(zh.serverImportPhaseRunning))
    assert.equal(calls.some(call => call.operation === 'server-queue-start'), false)
    entry = { ...entry, status: 'failed', errorCode: 'source-protocol-error' }
    await act(async () => button(zh.refresh).click())
    assert(document.querySelector('[data-server-import]').textContent.includes(zh.serverImportChanged))
  } finally { await act(async () => rendered.unmount()); dom.window.close(); for (const key of keys) { const descriptor = old.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } }
})
