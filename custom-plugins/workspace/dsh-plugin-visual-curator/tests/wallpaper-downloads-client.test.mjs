/** Real primitives render replayed download views; the flow stub observes the controlled dimensions passed to its child. */
import test from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url),React=require('react'),{act}=React,{createRoot}=require('react-dom/client')
const expected=JSON.parse(await readFile(new URL('./fixtures/wallpaper-downloads.expected.json',import.meta.url),'utf8'))
const names=['Modal','Button','Input','Tag','StateDot','Menu','Checkbox','Tooltip']
const contents=names.map(name=>'import {'+name+"} from '../../../packages/client/ui-primitives/src/"+name+".tsx'").join('\n')+"\nexport const ui={"+names.join(',')+"}; export {createWallpaperCanvas} from './src/client/wallpaper-canvas.tsx';export {createDirectCropCanvas} from './src/client/direct-crop-canvas.tsx';export {wallpaperSettingsSchema} from './src/shared/wallpaper.ts';export {zh} from './src/client/workbench-locale.ts';export {flowCapture} from '@xyflow/react'"
const flow="import * as React from 'react';export const flowCapture={nodes:[]};export const Position={Left:'left',Right:'right',Top:'top'};export const MarkerType={ArrowClosed:'arrowclosed'};export const BaseEdge=()=>null;export const getBezierPath=()=>['',0,0];export const Background=()=>null,MiniMap=()=>null,Handle=()=>null,Panel=({children})=>React.createElement('div',null,children);export function ReactFlow(props){flowCapture.nodes=props.nodes;React.useLayoutEffect(()=>{props.onNodesChange(props.nodes.map(node=>({type:'dimensions',id:node.id,dimensions:{width:380,height:430}})))},[props.nodes.map(node=>node.id).join(':')]);return React.createElement('div',null,props.nodes.map(node=>React.createElement(props.nodeTypes[node.type],{key:node.id,data:node.data})))}"
const compiled=await build({stdin:{contents,resolveDir:root,loader:'ts'},outfile:resolve(root,'tests/download-memory.cjs'),bundle:true,write:false,external:['react','react/*','react-dom','react-dom/*'],platform:'node',format:'cjs',loader:{'.css':'empty','.webp':'empty'},logLevel:'silent',plugins:[{name:'controlled-flow-child',setup(build){build.onResolve({filter:/^@xyflow[/]react$/},()=>({path:'flow',namespace:'flow'}));build.onLoad({filter:/.*/,namespace:'flow'},()=>({contents:flow,loader:'js'}))}}]})
const filename=resolve(root,'tests/download-memory.cjs'),capsule=new Module(filename);capsule.filename=filename;capsule.paths=Module._nodeModulePaths(dirname(filename));capsule._compile(compiled.outputFiles.find(f=>f.path.endsWith('.cjs')).text,filename)
const {ui:primitives,createWallpaperCanvas,createDirectCropCanvas,wallpaperSettingsSchema,zh,flowCapture}=capsule.exports
const ui=new Proxy(primitives,{get(target,key){return target[key]??(()=>React.createElement('span',{'aria-hidden':true}))}})

test('node and navigator share byte progress, unknown totals have no percentage, and restricted images remain inspectable with measured nodes',async()=>{
 const keys=['window','document','HTMLElement','IS_REACT_ACT_ENVIRONMENT'],old=new Map(keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)])),dom=new JSDOM('<div id="root"></div>',{url:'https://isolated.example/',pretendToBeVisual:true})
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})
 const rendered=createRoot(document.getElementById('root')),wallpaper=createWallpaperCanvas(React,ui),Canvas=createDirectCropCanvas(React,ui),settings=wallpaperSettingsSchema.parse({})
 const batch={runId:'batch',name:'Isolated download flow',directCrop:true,removable:false,kind:'crop',origin:'gallery',status:'running',matched:2,wallpaper:{runId:'batch',status:'running',attention:1}}
 let phase='downloading',known=true,receivedBytes=3_200_000,canvas=false,calls=0
 const response=offset=>{const saved=phase==='saved',items=[{imageVersionId:'source-a',...(saved?{originalId:'original-a'}:{}),familyId:'family-a',status:saved?'planning':'downloading',edits:0,attempts:[]},{imageVersionId:'source-b',familyId:'family-b',status:'technical-failed',failedStep:'downloading',errorCode:'original-source-restricted',edits:0,attempts:[]}];return {runId:'batch',sourceRunId:'batch',status:'running',settings,state:{version:2,sourceRunId:'batch',skillVersion:'fixture',items:[items[offset]],budgetStopped:false},resources:saved?{'original-a':'/api/visual-curator/resource?imageVersionId=original-a'}:{},sourceImages:saved?{'original-a':{width:3000,height:5000,previewPath:'/api/visual-curator/resource?imageVersionId=original-a-preview'}}:{},itemIndex:items.map(item=>({imageVersionId:item.imageVersionId,status:item.status,planned:false,previewPath:'/api/visual-curator/resource?imageVersionId='+item.imageVersionId})),downloads:{'source-a':{phase,attempt:1,receivedBytes,...(known?{totalBytes:7_600_000}:{})},'source-b':{phase:'restricted',attempt:1,receivedBytes:0}},total:2,offset,counts:{downloading:saved?0:1,downloaded:saved?1:0},warnings:[]}}
 const invoke=async(operation,args,signal)=>{signal?.throwIfAborted();assert.equal(operation,'wallpaper-read');calls++;return response(args.offset)}
 function App(){return canvas?React.createElement(Canvas,{batch,invoke,t:k=>zh[k],pollMs:60000,pageSize:20,scope:'isolated-progress',onImage(){},onTask(){}}):React.createElement(Observed)}
 function Observed(){const control=wallpaper.useWallpaper(batch,invoke,60000,20);return React.createElement(React.Fragment,null,React.createElement(wallpaper.ImageNavigator,{control,t:k=>zh[k],onSelect(){}}),React.createElement(wallpaper.ImageStepCard,{kind:'downloading',stage:'original',control,t:k=>zh[k]}))}
 const refresh=async()=>act(async()=>document.dispatchEvent(new dom.window.Event('visibilitychange')))
 try{
  await act(async()=>rendered.render(React.createElement(App)))
  assert.equal(document.querySelector('.vc-original-progress [role=progressbar]').getAttribute('aria-valuenow'),String(expected.known.percent))
  assert.equal(document.querySelector('.vc-original-progress small').textContent,expected.known.caption)
  assert.equal(document.querySelector('.vc-image-thumbnail small').textContent,expected.known.thumbnail)
  assert.equal(calls,1,'The navigator does not start a request for each thumbnail')
  known=false;receivedBytes=2_500_000;await refresh()
  assert.equal(document.querySelector('.vc-original-progress [role=progressbar]').getAttribute('aria-valuenow'),null)
  assert.equal(document.querySelector('.vc-original-progress small').textContent,expected.unknown.caption)
  assert.equal(document.querySelector('.vc-image-thumbnail small').textContent,expected.unknown.thumbnail)
  phase='saving';receivedBytes=7_600_000;known=true;await refresh()
  assert.equal(document.querySelector('.vc-original-progress > div > span').textContent,expected.saving)
  assert.equal(document.querySelector('.vc-original-batch-progress'),null,'The batch count has one home in the task bar')
  phase='saved';await refresh();assert.equal(document.querySelector('.vc-image-thumbnail small').textContent,expected.saved)
  await act(async()=>document.querySelectorAll('.vc-image-thumbnail')[1].click())
  assert.equal(document.querySelector('.vc-original-progress').dataset.downloadPhase,'restricted')
  assert.equal(document.querySelector('.vc-image-thumbnail[aria-current=true]').dataset.imageIndex,'1')
  assert.equal(document.querySelector('.vc-original-progress > div > span').textContent,expected.restricted)
  canvas=true;await act(async()=>rendered.render(React.createElement(App)))
  assert.deepEqual(flowCapture.nodes.map(node=>node.data.stage),expected.savedSteps);assert(flowCapture.nodes.every(n=>JSON.stringify(n.measured)===JSON.stringify(expected.measured)))
  for(const index of [1,0,1])await act(async()=>document.querySelectorAll('.vc-image-thumbnail')[index].click())
  assert.equal(flowCapture.nodes[0].data.phase,'failed');assert.deepEqual(flowCapture.nodes.map(node=>node.data.stage),expected.waitingSteps)
  assert(flowCapture.nodes.every(n=>JSON.stringify(n.measured)===JSON.stringify(expected.measured)),'Controlled replacements retain measured rectangles after source failure and image switching')
 }finally{await act(async()=>rendered.unmount());dom.window.close();for(const key of keys){const descriptor=old.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}}
})
