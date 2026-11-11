/** List, canvas and image navigation retain the exact task and source identity without mutating work. */
import test from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { createCuratorStore } from '../src/client/store.ts'
import { resolveCurrentConfig } from '../src/host/config.ts'

const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url),React=require('react'),{act}=React,{createRoot}=require('react-dom/client'),h=React.createElement
const compiled=await build({stdin:{contents:"export {createWorkbench} from './src/client/workbench.tsx'; export {zh} from './src/client/workbench-locale.ts'",resolveDir:root,loader:'ts'},bundle:true,write:false,packages:'external',platform:'node',format:'cjs',loader:{'.webp':'dataurl'},logLevel:'silent',plugins:[{name:'navigation-surface',setup(build){build.onLoad({filter:/search-batch-results\.tsx$/},()=>({loader:'js',contents:`export function createSearchBatchSkeleton(){return ()=>null}
export function createSearchBatchResults(React){return function Canvas(props){React.useEffect(()=>{props.onLocation({sourceRunId:props.navigation.sourceRunId||'source-a',runId:props.navigation.runId||'saved-a',imageVersionId:props.navigation.imageVersionId||'source-image-a',imageIndex:0,imageCount:1})},[props.navigation.serial,props.onLocation]);return React.createElement('section',{'data-navigation-canvas':'','data-view':props.navigation.view,'data-source':props.navigation.sourceRunId,'data-run':props.navigation.runId,'data-image':props.navigation.imageVersionId},'Canvas')}}`}))}}]})
const filename=resolve(root,'tests/workbench-navigation-memory.cjs'),capsule=new Module(filename);capsule.filename=filename;capsule.paths=Module._nodeModulePaths(dirname(filename));capsule._compile(compiled.outputFiles[0].text,filename)
const {createWorkbench,zh}=capsule.exports
const ui=new Proxy({
 Button:React.forwardRef(({children,variant,size,...props},ref)=>h('button',{...props,ref},children)),
 SegmentedTabs:({items,value,onChange,label})=>h('div',{role:'tablist','aria-label':label},items.map(item=>h('button',{key:item.value,role:'tab',disabled:item.disabled,'aria-selected':item.value===value,onClick:()=>onChange(item.value)},item.label))),
 Tag:({children})=>h('span',null,children),Menu:({anchor})=>anchor,Modal:()=>null,
},{get:(target,key)=>target[key]??(()=>null)})

test('opening a conversation task reads its latest wallpaper child while explicit history stays pinned', async () => {
 const calls=[], child={runId:'review-new',kind:'crop',wallpaperTask:true,status:'completed',counts:{finalPassed:1},warnings:[],results:[]}
 const old={...child,runId:'review-old'}, source={runId:'search-source',kind:'search',status:'completed',counts:{qualified:1},warnings:[],results:[],wallpaper:{runId:child.runId,sourceRunId:'search-source',total:1,outputs:[]}}
 const snapshot={configuration:{...resolveCurrentConfig({}),visionConfigured:true},styles:[],images:[],runs:[{...source,wallpaper:{...source.wallpaper,runId:old.runId}},old,child],usages:[],splits:[],evaluations:[],exports:[],suggestions:[]}
 const store=createCuratorStore({invoke:async(operation,args)=>{calls.push({operation,args});if(operation==='session-open')return{sessionToken:'fixture'};if(operation==='snapshot')return snapshot;if(operation==='run-get')return args.runId===source.runId&&args.followLatestWallpaper?{...child,resolvedFromRunId:source.runId}:args.runId===source.runId?source:args.runId===old.runId?old:child;throw new Error(operation)}})
 try {
  await store.openTask(source.runId,'session-a',true)
  assert.equal(store.getSnapshot().taskTarget.runId,child.runId)
  assert.deepEqual(calls.filter(call=>call.operation==='run-get').map(call=>call.args.runId),[source.runId])
  assert.equal(calls.find(call=>call.operation==='run-get').args.followLatestWallpaper,true)
  await store.openTask(old.runId,'session-a')
  assert.equal(store.getSnapshot().taskTarget.runId,old.runId)
  assert.ok(calls.every(call=>['session-open','snapshot','run-get'].includes(call.operation)))
 } finally {store.dispose()}
})

test('archived task results link to the exact batch and source image and return without dropping scope',async()=>{
 const previous=Object.fromEntries(['window','document','IS_REACT_ACT_ENVIRONMENT'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)])),dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.invalid/'})
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true})
 const rendered=createRoot(document.getElementById('root')),calls=[]
 const style={styleId:'archived',name:'Archived cars',archived:true,revision:1,draftId:'draft',draftRevision:1,rules:[],conflicts:[],referenceIds:[],releases:[],candidates:[]}
 const image={workflowImageVersionId:'source-image-a',imageVersionId:'output-a',parentImageVersionId:'different-normalized-original',name:'Saved image',width:1845,height:3280,kind:'composition',previewPath:'/api/visual-curator/resource?imageVersionId=output-a',selection:{kind:'selected',warnings:[]},verdict:'pass'}
 const run={runId:'saved-a',wallpaper:{runId:'saved-a',sourceRunId:'source-a',total:1,outputs:[{imageVersionId:'output-a',sourceImageVersionId:'source-image-a'}]},wallpaperTask:true,styleId:style.styleId,kind:'crop',status:'completed',taskBrief:'Saved task',counts:{finalPassed:1},resultSummary:{selected:1,needsReview:0,candidates:1,target:1,rejected:0},warnings:[],results:[image]}
 const second={...run,runId:'saved-b',wallpaper:{runId:'saved-b',sourceRunId:'source-b',total:1,outputs:[{imageVersionId:'output-b',sourceImageVersionId:'source-image-b'}]},results:[{...image,imageVersionId:'output-b',workflowImageVersionId:'source-image-b',name:'Another saved image'}]}
 const sourceRun={...run,runId:'source-a',kind:'search',wallpaperTask:false,results:[{...image,workflowImageVersionId:undefined,imageVersionId:'source-image-a',name:'Source image'}]}
 const snapshot={configuration:{...resolveCurrentConfig({}),visionConfigured:true},styles:[style],images:[],runs:[run,second,sourceRun].map(({wallpaper,results,...metadata})=>({...metadata,results:[]})),usages:[],splits:[],evaluations:[],exports:[],suggestions:[]}
 const store=createCuratorStore({invoke:async(operation,args)=>{calls.push({operation,args});return operation==='session-open'?{sessionToken:'fixture'}:operation==='snapshot'?snapshot:operation==='run-get'?(args.runId===second.runId?second:args.runId===sourceRun.runId?sourceRun:run):Promise.reject(new Error(operation))}})
 const Workbench=createWorkbench(React,ui),batches={watch(){return()=>{}},select(){},refresh(){},more:async()=>{},moreImages:async()=>{},remove:async()=>{},removeWorkflow:async()=>{}}
 const useWorkbench=select=>select(React.useSyncExternalStore(store.subscribe,store.getSnapshot)),props={useWorkbench,useVisionModels:select=>select({status:'idle'}),useDatasets:select=>select({entries:[]}),useLaunches:select=>select({entries:[]}),useSearchBatches:select=>select({styleId:style.styleId,batchId:'source-a',page:null}),actions:{...store,batches,datasets:{},launches:{}},t:key=>zh[key]}
 const tab=name=>[...document.querySelectorAll('[role="tablist"][aria-label="'+zh.workflowNavigation+'"] [role="tab"]')].find(item=>item.textContent===name)
 try{
  await store.openTask(run.runId,'original-session')
  await act(async()=>rendered.render(h(Workbench,props)))
  assert.equal(tab(zh.workflowTaskResults).getAttribute('aria-selected'),'true')
  assert(document.querySelector('[aria-label="'+zh.workflowBreadcrumb+'"] ol'))
  assert.equal(document.querySelector('.vc-run-rail-toggle'),null)
  assert.equal(document.querySelector('.vc-task-resizable').dataset.resizable,'false')
  assert.equal(document.querySelector('.vc-task-title-row h3'),null)
  assert.equal([...document.querySelectorAll('button')].filter(button=>button.textContent===zh.taskLibrary).length,0)
  assert.equal(document.querySelector('.vc-task-detail-header .vc-task-filters button').textContent,zh.taskAll + String.fromCharCode(32) + 1)
  assert(document.querySelector('.vc-task-actions button[title]'))
  await act(async()=>store.reload(true,true))
  assert.equal(store.getSnapshot().snapshot.runs.find(item=>item.runId===run.runId).wallpaper?.sourceRunId,'source-a')
  await act(async()=>[...document.querySelectorAll('.vc-result-actions button')].find(item=>item.textContent===zh.wallpaperImageFlow).click())
  let canvas=document.querySelector('[data-navigation-canvas]')
  assert.equal(canvas.dataset.view,'image');assert.equal(canvas.dataset.source,'source-a');assert.equal(canvas.dataset.run,'saved-a');assert.equal(canvas.dataset.image,'source-image-a')
  assert.notEqual(canvas.dataset.image,image.parentImageVersionId)
  await act(async()=>tab(zh.workflowTaskResults).click())
  assert(document.querySelector('.vc-result-card'));assert(!document.querySelector('[data-navigation-canvas]'))
  await act(async()=>tab(zh.workflowBatchCanvas).click())
  canvas=document.querySelector('[data-navigation-canvas]');assert.equal(canvas.dataset.view,'canvas');assert.equal(canvas.dataset.source,'source-a');assert.equal(canvas.dataset.run,'saved-a')
  assert(!calls.some(row=>['wallpaper-start','wallpaper-continue','wallpaper-plan-update','search-launch-start'].includes(row.operation)))
  assert.equal(store.getSnapshot().taskTarget.runId,'saved-a')
  assert.equal(store.getSnapshot().scopeSessionId,'original-session')
  assert.equal(store.getSnapshot().snapshot.styles[0].archived,true)
  await act(async()=>store.openTask(second.runId,'original-session'))
  assert.equal(tab(zh.workflowTaskResults).getAttribute('aria-selected'),'true')
  assert(!document.querySelector('[data-navigation-canvas]'));assert.equal(document.querySelector('.vc-result-preview img').alt,'Another saved image')
  await act(async()=>[...document.querySelectorAll('.vc-result-actions button')].find(item=>item.textContent===zh.wallpaperImageFlow).click())
  canvas=document.querySelector('[data-navigation-canvas]');assert.equal(canvas.dataset.source,'source-b');assert.equal(canvas.dataset.image,'source-image-b');assert.equal(canvas.dataset.run,'saved-b')
  await act(async()=>store.openTask(sourceRun.runId,'original-session'))
  assert.equal(tab(zh.wallpaperImageFlow).disabled,false)
  await act(async()=>[...document.querySelectorAll('.vc-result-actions button')].find(item=>item.textContent===zh.wallpaperImageFlow).click())
  canvas=document.querySelector('[data-navigation-canvas]');assert.equal(canvas.dataset.source,'source-a');assert.equal(canvas.dataset.image,'source-image-a');assert.equal(canvas.dataset.run,undefined)
  assert(!calls.some(row=>['wallpaper-start','wallpaper-continue','wallpaper-plan-update','search-launch-start'].includes(row.operation)))
 }finally{await act(async()=>rendered.unmount());store.dispose();dom.window.close();for(const[key,value]of Object.entries(previous))if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key]}
})
