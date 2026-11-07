/** Production canvas projection and editor routing; ReactFlow geometry is tested separately and in Desktop. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import Module,{createRequire} from 'node:module'
import {readFile} from 'node:fs/promises'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {setImmediate} from 'node:timers/promises'
import {build} from 'esbuild'
import {JSDOM} from 'jsdom'
import {wallpaperPlanSchema,wallpaperSettingsSchema} from '../src/shared/wallpaper.ts'
import {zh} from '../src/client/workbench-locale.ts'

const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url),React=require('react'),{act}=React
const graphModule=`import React from 'react';
const flow={getViewport:()=>({x:0,y:0,zoom:1}),fitView:async()=>{},zoomTo:async()=>{}};
export function ReactFlow(props){globalThis.__vcPlanningProjection=props;React.useEffect(()=>{props.onInit(flow)},[props.onInit]);return React.createElement('div',null,props.nodes.map(node=>React.createElement(props.nodeTypes[node.type],{key:node.id,data:node.data,selected:node.selected})),props.children)}
export const Background=()=>null,MiniMap=()=>null,NodeResizer=()=>null,Handle=()=>null,BaseEdge=()=>null;
export const getBezierPath=()=>['M0,0',0,0];
export function Panel({children}){return React.createElement('div',null,children)}
export const Position={Left:'left',Right:'right'},MarkerType={ArrowClosed:'arrow'},SelectionMode={Partial:'partial'};
export const useViewport=()=>({zoom:1}),useReactFlow=()=>flow;`
const compiled=await build({entryPoints:[resolve(root,'src/client/workflow-canvas.tsx')],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',loader:{'.webp':'dataurl'},logLevel:'silent',plugins:[{name:'projection-only-graph',setup(api){api.onResolve({filter:/^@xyflow\/react$/},()=>({path:'graph',namespace:'fixture'}));api.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:graphModule,loader:'js',resolveDir:root}))}}]})
const capsule=new Module(resolve(root,'tests/workflow-projection-memory.cjs'));capsule.filename=resolve(root,'tests/workflow-projection-memory.cjs');capsule.paths=Module._nodeModulePaths(dirname(capsule.filename));capsule._compile(compiled.outputFiles[0].text,capsule.filename)
const {createAutomaticWorkflowCanvas}=capsule.exports

test('the production canvas reuses six mounted workflow slots across one hundred images without moving or mixing content',async()=>{
  const dom=new JSDOM('<div id="root"></div>',{url:'https://owner.example/',pretendToBeVisual:true}),win=dom.window
  const globals={window:win,document:win.document,navigator:win.navigator,HTMLElement:win.HTMLElement,Element:win.Element,getComputedStyle:win.getComputedStyle.bind(win),requestAnimationFrame:win.requestAnimationFrame.bind(win),cancelAnimationFrame:win.cancelAnimationFrame.bind(win),IS_REACT_ACT_ENVIRONMENT:true}
  win.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}})
  const previous=Object.fromEntries(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]))
  for(const[key,value]of Object.entries(globals))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})
  const {createRoot}=require('react-dom/client'),h=React.createElement,empty=()=>null,pass=({children})=>h('div',null,children)
  const Button=React.forwardRef(({children,onClick,onPointerDown,disabled,className,...props},ref)=>h('button',{ref,onClick,onPointerDown,disabled,className,'aria-label':props['aria-label'],'aria-expanded':props['aria-expanded']},children))
  const ui=new Proxy({Button,DisclosureRow:pass,Tag:pass,StateDot:empty,Tooltip:pass,ZoomControls:empty,AnimatedCollapse:({open,children})=>open?h('div',null,children):null,Modal:({open,title,children})=>open?h('section',{role:'dialog','aria-label':title},children):null,TextArea:props=>h('textarea',{value:props.value,onChange:props.onChange}),Menu:({open,anchor,items=[],onSelect,listClassName})=>h('div',null,anchor,open&&h('div',{role:'menu',className:listClassName},items.filter(item=>!item.type).map(item=>h('button',{key:item.id,role:'menuitem',onClick:()=>onSelect(item.id)},item.label))))},{get:(target,key)=>target[key]??empty})
  const items=Array.from({length:100},(_,index)=>{
    const imageVersionId=`source-${index}`,plan=wallpaperPlanSchema.parse({version:1,imageVersionId,mode:'single',subject:`汽车 ${index+1}`,evidence:'Actual fixture source',priorities:[],anchors:[],truncations:[],uncertainties:[],regions:['subject','critical'].map(role=>({name:role,role,rect:{x:0.2,y:0.2,width:0.3,height:0.3}})),placement:{scale:1,left:400,top:1100},reason:'Saved valid source geometry'})
    return {imageVersionId,originalId:imageVersionId,familyId:imageVersionId,status:'passed',edits:0,attempts:[{revision:1,plan,checks:[],needsOutpaint:true,analysisId:`analysis-${index}`} ]}
  })
  const counts={downloaded:100,planned:100,rendered:100,reviewed:100,passed:100},calls=[],waiting=[];let hold=false
  const batch={runId:'fixture-search',kind:'search',createdAt:'2026-11-07T00:00:00.000Z',status:'completed',outcome:'target-met',matched:100,targetCount:100,images:[],wallpaperRequested:true,workflowSource:{modelProfileId:'profile',references:1,positive:1,negative:0,revision:1},wallpaper:{runId:'fixture-wallpaper',status:'completed',total:100,passed:100,planned:100,rendered:100,reviewed:100,attention:0,counts,complete:true}}
  const state={styleId:'fixture-style',page:{batches:[batch]},loading:false,opening:false,deleting:[]},datasets={entries:[],submissions:[]},launches={entries:[],submission:null},noop=()=>{},actions={watch:()=>noop,select:noop,refresh:noop,more:noop,moreImages:noop,remove:noop,removeWorkflow:noop}
  const workflow={style:{styleId:'fixture-style',name:'100 张隔离验证',referenceIds:[]},referenceImages:[],busy:false,canSearch:true,useDatasets:select=>select(datasets),useLaunches:select=>select(launches),launches:{openSession:noop},profileActions:{execute:noop,reconcileProfile:noop},onReferences:noop,onAnalyze:noop,onAnalysis:noop,onDatasets:noop,onRefreshDatasets:noop,onGenerateDataset:noop,onOrganize:noop,onSearch:noop,onCrop:async()=>{},onProfile:noop,wallpaper:async(operation,args)=>{
    assert.equal(operation,'wallpaper-read');calls.push([args.offset,args.limit]);if(hold&&args.offset===99)await new Promise(resolve=>waiting.push(resolve))
    const page=items.slice(args.offset,args.offset+args.limit),resources={},previewResources={},sourceImages={}
    for(const item of page){const id=item.attempts[0].analysisId;resources[id]=`/api/visual-curator/resource?imageVersionId=${id}`;previewResources[id]=`/api/visual-curator/resource?imageVersionId=${id}-preview`;sourceImages[item.originalId]={width:1000,height:2000,previewPath:`/api/visual-curator/resource?imageVersionId=${item.originalId}-preview`}}
    return {runId:'fixture-wallpaper',sourceRunId:batch.runId,status:'completed',settings:wallpaperSettingsSchema.parse({}),state:{version:1,sourceRunId:batch.runId,skillVersion:'fixture',items:page,budgetStopped:false},itemIndex:items.map(i=>({imageVersionId:i.imageVersionId,status:i.status,planned:true,previewPath:`/api/visual-curator/resource?imageVersionId=${i.imageVersionId}-preview`})),resources,previewResources,sourceImages,total:100,offset:args.offset,counts,warnings:[]}
  }}
  const Canvas=createAutomaticWorkflowCanvas(React,ui),rootNode=createRoot(win.document.getElementById('root')),expected=JSON.parse(await readFile(new URL('./fixtures/workflow-image-branches.expected.json',import.meta.url),'utf8'))
  const flush=async()=>{await setImmediate();await setImmediate()}
  const assertImageFlow=(source)=>{
    const {nodes,edges}=globalThis.__vcPlanningProjection
    assert.equal(nodes.length,expected.imageNodes)
    assert.deepEqual(nodes.map(n=>n.data.kind),expected.steps)
    assert(nodes.every(n=>n.data.image.id===source))
    assert.equal(edges.length,expected.imageNodes-1)
    for(let index=1;index<nodes.length;index++)assert(edges.some(edge=>edge.source===nodes[index-1].id&&edge.target===nodes[index].id))
    assert(win.document.querySelectorAll('.vc-image-thumbnail').length<=expected.thumbnailLimit)
    assert(win.document.querySelectorAll('img').length<=expected.thumbnailLimit+expected.imageNodes)
    return nodes
  }
  const click=async button=>{assert(button);await act(async()=>{button.click();await flush()})}
  const jump=async index=>{
    const trigger=[...win.document.querySelectorAll('button')].find(button=>button.getAttribute('aria-label')===zh.wallpaperJumpImage)
    await click(trigger)
    const options=[...win.document.querySelectorAll('[role=menuitem]')]
    assert.equal(options.length,100)
    await click(options[index])
  }
  try{
    await act(async()=>{rootNode.render(h(Canvas,{styleId:state.styleId,t:key=>zh[key],workflow,useBatches:select=>select(state),actions,onOpen:async()=>{}}));await flush()})
    assert.equal(globalThis.__vcPlanningProjection.nodes.length,expected.overviewNodes)
    assert.equal(win.document.querySelectorAll('[data-image-id]').length,0)
    assert.equal(win.document.querySelectorAll('.vc-image-thumbnail').length,0)
    await click([...win.document.querySelectorAll('button')].find(button=>button.textContent===zh.wallpaperOpenImageFlow))
    const first=assertImageFlow('source-0').map(n=>n.id),firstCard=win.document.querySelector('[data-image-stage=original]')
    await jump(99)
    const last=assertImageFlow('source-99')
    assert.deepEqual(last.map(node=>node.id),first);assert.equal(win.document.querySelector('[data-image-stage=original]'),firstCard)
    await act(async()=>{globalThis.__vcPlanningProjection.onNodesChange([{type:'position',id:last[1].id,position:{x:500,y:60}}]);await flush()})
    await act(async()=>{globalThis.__vcPlanningProjection.onMoveEnd({}, {x:10,y:20,zoom:1});await flush()})
    await act(async()=>{globalThis.__vcPlanningProjection.nodes[2].data.collapse();await flush()})
    await jump(0);const zero=assertImageFlow('source-0');assert.deepEqual(zero[1].position,{x:500,y:60});assert.equal(zero[2].data.collapsed,true)
    assert.equal(win.document.querySelector('[data-image-stage=original]'),firstCard)
    await jump(99);const reopened=assertImageFlow('source-99')
    assert.deepEqual(reopened[1].position,{x:500,y:60})
    assert.equal(reopened[2].data.collapsed,true);assert.deepEqual(calls,expected.requests)
    const saved=JSON.parse(win.localStorage.getItem('visual-curator:workflow-canvas:v7:fixture-style:fixed-image-flow:fixture-search'));assert.deepEqual(saved.viewport,{x:10,y:20,zoom:1})
    const card=win.document.querySelector('[data-image-id="source-99"][data-kind="planning"]')
    await click([...card.querySelectorAll('button')].find(button=>button.textContent===zh.wallpaperEditPlan))
    const dialog=win.document.querySelector('[role=dialog]'),json=dialog?.querySelector('textarea')
    assert(json);assert.equal(JSON.parse(json.value).imageVersionId,expected.editedSource)
    await click([...dialog.querySelectorAll('button')].find(button=>button.textContent===zh.close))
    await jump(0);hold=true;await jump(99)
    assert.equal(win.document.querySelectorAll('.vc-image-step-card[aria-busy=true]').length,5)
    assert.equal(win.document.querySelectorAll('.vc-image-step-card button').length,0)
    await jump(0);assertImageFlow('source-0')
    await act(async()=>{for(const finish of waiting)finish();await flush()})
    assertImageFlow('source-0');assert.equal(win.document.querySelector('[data-image-stage=original]'),firstCard)
    assert(!win.document.querySelector('[data-image-id=\"source-99\"]'))
    await click([...win.document.querySelectorAll('button')].find(button=>button.textContent===zh.wallpaperBatchOverview))
    assert.equal(globalThis.__vcPlanningProjection.nodes.length,expected.overviewNodes)
    assert.equal(win.document.querySelectorAll('[data-image-id]').length,0)
  }finally{await act(async()=>rootNode.unmount());dom.window.close();delete globalThis.__vcPlanningProjection;for(const[key,descriptor]of Object.entries(previous)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}}
})
