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
export const Position={Left:'left',Right:'right',Top:'top',Bottom:'bottom'},MarkerType={ArrowClosed:'arrow'},SelectionMode={Partial:'partial'};
export const useViewport=()=>({zoom:1}),useReactFlow=()=>flow,useUpdateNodeInternals=()=>()=>{};`
const compiled=await build({stdin:{contents:"export {createAutomaticWorkflowCanvas} from './src/client/workflow-canvas.tsx'; export {createDirectCropCanvas} from './src/client/direct-crop-canvas.tsx'",resolveDir:root,loader:'ts'},bundle:true,write:false,platform:'node',format:'cjs',packages:'external',loader:{'.webp':'dataurl'},logLevel:'silent',plugins:[{name:'projection-only-graph',setup(api){api.onResolve({filter:/^@xyflow\/react$/},()=>({path:'graph',namespace:'fixture'}));api.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:graphModule,loader:'js',resolveDir:root}))}}]})
const capsule=new Module(resolve(root,'tests/workflow-projection-memory.cjs'));capsule.filename=resolve(root,'tests/workflow-projection-memory.cjs');capsule.paths=Module._nodeModulePaths(dirname(capsule.filename));capsule._compile(compiled.outputFiles[0].text,capsule.filename)
const {createAutomaticWorkflowCanvas,createDirectCropCanvas}=capsule.exports

test('the production canvas reuses seven mounted workflow slots across one hundred images without moving or mixing content',async()=>{
  const dom=new JSDOM('<div id="root"></div>',{url:'https://owner.example/',pretendToBeVisual:true}),win=dom.window
  const globals={window:win,document:win.document,navigator:win.navigator,HTMLElement:win.HTMLElement,Element:win.Element,getComputedStyle:win.getComputedStyle.bind(win),requestAnimationFrame:win.requestAnimationFrame.bind(win),cancelAnimationFrame:win.cancelAnimationFrame.bind(win),IS_REACT_ACT_ENVIRONMENT:true}
  win.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}})
  const previous=Object.fromEntries(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]))
  for(const[key,value]of Object.entries(globals))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})
  const {createRoot}=require('react-dom/client'),h=React.createElement,empty=()=>null,pass=({children})=>h('div',null,children)
  const Button=React.forwardRef(({children,onClick,onPointerDown,disabled,className,...props},ref)=>h('button',{ref,onClick,onPointerDown,disabled,className,'aria-label':props['aria-label'],'aria-expanded':props['aria-expanded']},children))
  const ui=new Proxy({Button,DisclosureRow:pass,Tag:pass,StateDot:empty,Tooltip:pass,ZoomControls:empty,AnimatedCollapse:({open,children})=>open?h('div',null,children):null,Modal:({open,title,children,footer})=>open?h('section',{role:'dialog','aria-label':title},children,footer):null,TextArea:props=>h('textarea',{value:props.value,onChange:props.onChange}),Menu:({open,anchor,items=[],onSelect,listClassName})=>h('div',null,anchor,open&&h('div',{role:'menu',className:listClassName},items.filter(item=>!item.type).map(item=>h('button',{key:item.id,role:'menuitem',disabled:item.disabled,onClick:()=>onSelect(item.id)},item.label))))},{get:(target,key)=>target[key]??empty})
  const items=Array.from({length:100},(_,index)=>{
    const imageVersionId=`source-${index}`,plan=wallpaperPlanSchema.parse({version:1,imageVersionId,mode:'single',subject:`汽车 ${index+1}`,evidence:'Actual fixture source',priorities:[],anchors:[],truncations:[],uncertainties:[],regions:['subject','critical'].map(role=>({name:role,role,rect:{x:0.2,y:0.2,width:0.3,height:0.3}})),placement:{scale:1,left:400,top:1100},reason:'Saved valid source geometry'})
    return {imageVersionId,originalId:imageVersionId,familyId:imageVersionId,status:'passed',edits:0,attempts:[{revision:1,plan,checks:[],needsOutpaint:true,canvasId:`canvas-${index}`,layoutAnalysisId:`layout-${index}`,outputId:`output-${index}`,simulationId:`simulation-${index}`,analysisId:`analysis-${index}`,clarity:{status:'not-needed',reason:'Recorded sufficient source resolution'},review:{subject:`Car ${index+1}`,checks:Object.fromEntries(['subject','protection','clock','readability','composition','background','style'].map(key=>[key,{result:'satisfied',reason:'Recorded fixture review'}])),issues:[]}} ]}
  })
  const counts={downloaded:100,planned:100,rendered:100,reviewed:100,passed:100},calls=[],mutations=[],waiting=[];let hold=false,workflowStatus='completed',decisionPolicy
  const batch={runId:'fixture-search',kind:'search',createdAt:'2026-11-07T00:00:00.000Z',status:'completed',outcome:'target-met',matched:100,targetCount:100,images:[],wallpaperRequested:true,workflowSource:{modelProfileId:'profile',references:1,positive:1,negative:0,revision:1},wallpaper:{runId:'fixture-wallpaper',status:'completed',total:100,passed:100,planned:100,rendered:100,reviewed:100,attention:0,counts,complete:true}}
  const state={styleId:'fixture-style',page:{batches:[batch]},loading:false,opening:false,deleting:[]},datasets={entries:[],submissions:[]},launches={entries:[],submission:null},noop=()=>{},actions={watch:()=>noop,select:noop,refresh:noop,more:noop,moreImages:noop,remove:noop,removeWorkflow:noop}
  const workflow={style:{styleId:'fixture-style',name:'100 张隔离验证',referenceIds:[]},referenceImages:[],busy:false,canSearch:true,useDatasets:select=>select(datasets),useLaunches:select=>select(launches),launches:{openSession:noop},profileActions:{execute:noop,reconcileProfile:noop},onReferences:noop,onAnalyze:noop,onAnalysis:noop,onDatasets:noop,onRefreshDatasets:noop,onGenerateDataset:noop,onOrganize:noop,onSearch:noop,onCrop:async()=>{},onProfile:noop,wallpaper:async(operation,args)=>{
    if(operation==='wallpaper-continue'||operation==='wallpaper-control'){mutations.push({operation,args});return {runId:'fixture-wallpaper'}}
    assert.equal(operation,'wallpaper-read');calls.push([args.offset,args.limit]);if(args.runId)assert.equal(args.runId,'fixture-wallpaper');if(hold&&args.offset===99)await new Promise(resolve=>waiting.push(resolve))
    const page=items.slice(args.offset,args.offset+args.limit),resources={},previewResources={},sourceImages={}
    for(const item of page){const id=item.attempts[0].analysisId;resources[id]=`/api/visual-curator/resource?imageVersionId=${id}`;previewResources[id]=`/api/visual-curator/resource?imageVersionId=${id}-preview`;sourceImages[item.originalId]={width:1000,height:2000,previewPath:`/api/visual-curator/resource?imageVersionId=${item.originalId}-preview`}}
    return {runId:'fixture-wallpaper',sourceRunId:batch.runId,status:workflowStatus,settings:wallpaperSettingsSchema.parse(decisionPolicy?{decision:decisionPolicy}:{}),state:{version:1,sourceRunId:batch.runId,skillVersion:'fixture',items:page,budgetStopped:false},itemIndex:items.map(i=>({imageVersionId:i.imageVersionId,status:i.status,planned:true,previewPath:`/api/visual-curator/resource?imageVersionId=${i.imageVersionId}-preview`})),resources,previewResources,sourceImages,total:100,offset:args.offset,counts,warnings:[]}
  }}
  const Canvas=createAutomaticWorkflowCanvas(React,ui),rootNode=createRoot(win.document.getElementById('root')),expected=JSON.parse(await readFile(new URL('./fixtures/workflow-image-branches.expected.json',import.meta.url),'utf8'))
  const flush=async()=>{await setImmediate();await setImmediate()}
  const assertImageFlow=(source)=>{
    const {nodes,edges}=globalThis.__vcPlanningProjection
    assert.equal(nodes.length,expected.imageNodes)
    assert.deepEqual(nodes.map(n=>n.data.kind),expected.steps)
    assert(nodes.every(n=>n.data.image.id===source))
    assert.equal(edges.length,expected.imageNodes-1+Number(edges.some(edge=>edge.data.rework)))
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
    const readsBeforeMetadataRefresh=calls.length
    state.page={batches:[{...batch,wallpaper:{...batch.wallpaper}}]}
    await act(async()=>{rootNode.render(h(Canvas,{styleId:state.styleId,t:key=>zh[key],workflow,useBatches:select=>select(state),actions,onOpen:async()=>{}}));await flush()})
    assert.equal(calls.length,readsBeforeMetadataRefresh)
    assert.equal(globalThis.__vcPlanningProjection.nodes.length,expected.overviewNodes)
    assert.equal(win.document.querySelectorAll('[data-image-id]').length,0)
    assert.equal(win.document.querySelectorAll('.vc-image-thumbnail').length,0)
    await click([...win.document.querySelectorAll('button')].find(button=>button.textContent===zh.wallpaperOpenImageFlow))
    assert.deepEqual(assertImageFlow('source-0').map(node=>node.position),expected.initialPositions)
    const first=assertImageFlow('source-0').map(n=>n.id),firstCard=win.document.querySelector('[data-image-stage=original]')
    await jump(99)
    const last=assertImageFlow('source-99')
    assert.deepEqual(last.map(node=>node.id),first);assert.ok(win.document.querySelector('[data-image-stage=original]') === firstCard, 'The original node must stay mounted across image selections')
    await act(async()=>{globalThis.__vcPlanningProjection.onNodesChange([{type:'position',id:last[1].id,position:{x:500,y:60}}]);await flush()})
    await act(async()=>{globalThis.__vcPlanningProjection.onMoveEnd({}, {x:10,y:20,zoom:1});await flush()})
    await act(async()=>{globalThis.__vcPlanningProjection.nodes[2].data.collapse();await flush()})
    await jump(0);const zero=assertImageFlow('source-0');assert.deepEqual(zero[1].position,{x:500,y:60});assert.equal(zero[2].data.collapsed,true)
    assert.ok(win.document.querySelector('[data-image-stage=original]') === firstCard, 'The original node must stay mounted across image selections')
    await jump(99);const reopened=assertImageFlow('source-99')
    assert.deepEqual(reopened[1].position,{x:500,y:60})
    assert.equal(reopened[2].data.collapsed,true);assert.deepEqual(calls,expected.requests)
    const saved=JSON.parse(win.localStorage.getItem('visual-curator:workflow-canvas:v7:fixture-style:fixed-image-flow:fixture-search:progressive-v2'));assert.deepEqual(saved.viewport,{x:10,y:20,zoom:1})
    const card=win.document.querySelector('[data-image-id="source-99"][data-kind="planning"]')
    await click([...card.querySelectorAll('button')].find(button=>button.textContent===zh.wallpaperEditPlan))
    const dialog=win.document.querySelector('[role=dialog]'),json=dialog?.querySelector('textarea')
    assert(json);assert.equal(JSON.parse(json.value).imageVersionId,expected.editedSource)
    await click([...dialog.querySelectorAll('button')].find(button=>button.textContent===zh.close))
    await jump(0);hold=true;await jump(99)
    assert.equal(win.document.querySelectorAll('.vc-image-step-card[aria-busy=true]').length,1)
    assert.equal(win.document.querySelectorAll('.vc-image-step-card button').length,0)
    await jump(0);assertImageFlow('source-0')
    await act(async()=>{for(const finish of waiting)finish();await flush()})
    assertImageFlow('source-0');assert.ok(win.document.querySelector('[data-image-stage=original]') === firstCard, 'The original node must stay mounted across image selections')
    assert(!win.document.querySelector('[data-image-id=\"source-99\"]'))
    hold=false
    const reviewed=items[99],reviewedAttempt=reviewed.attempts[0],reviewChecks=Object.fromEntries(['subject','protection','clock','readability','composition','background','style'].map(key=>[key,{result:'satisfied',reason:'Observed output'}]))
    reviewed.status='needs-review';reviewedAttempt.outputId='output-99';reviewedAttempt.simulationId='simulation-99';reviewedAttempt.review={subject:'Car 100',checks:{...reviewChecks,background:{result:'violated',reason:'Visible seam'}},issues:[{kind:'background',reason:'Visible seam'}]}
    await jump(99)
    const feedback=globalThis.__vcPlanningProjection.edges.find(edge=>edge.data.rework)
    assert(feedback);assert(feedback.source.endsWith(':image-step:reviewing:reviewing'));assert(feedback.target.endsWith(':image-step:rendering:rendering'))
    assert.equal(feedback.data.phase,'attention');assert.equal(feedback.markerEnd.type,'arrow');assert.equal(feedback.data.flowing,false)
    assert.equal(feedback.label,zh.wallpaperReviewReturn);assert.equal(feedback.ariaLabel,zh.wallpaperReviewReturn)
    const current={...reviewedAttempt,revision:2,retryFrom:'reviewing',retryTarget:'rendering'}
    for(const key of ['review','outputId','simulationId','analysisId','clarity'])delete current[key]
    reviewed.attempts.push(current);reviewed.status='rendering';workflowStatus='running'
    await jump(0);await jump(99)
    const reviewing=()=>globalThis.__vcPlanningProjection.nodes.find(node=>node.data.image.stage==='reviewing')
    const returning=()=>globalThis.__vcPlanningProjection.edges.find(edge=>edge.data.rework)
    assert.equal(reviewing().data.wallpaper.attempt.revision,2,'The review node must follow the version being repaired instead of the previous rejection')
    assert.equal(returning().data.reworkStage,'rendering')
    current.outputId='new-output';current.simulationId='new-simulation';reviewed.status='reviewing'
    await jump(0);await jump(99)
    assert.equal(reviewing().data.phase,'running');assert.equal(reviewing().data.wallpaper.attempt.revision,2)
    assert.equal(returning().data.reworkStage,'reviewing')
    reviewed.status='technical-failed';reviewed.failedStep='reviewing';reviewed.errorCode='vision-invalid-output';reviewed.reason='Old seam feedback';workflowStatus='completed'
    await jump(0);await jump(99)
    assert.equal(reviewing().data.phase,'failed');assert.equal(reviewing().data.wallpaper.attempt.review,undefined)
    assert.equal(returning().data.reworkStage,'reviewing')
    delete reviewed.failedStep;delete reviewed.errorCode;delete reviewed.reason
    reviewed.status='passed';current.clarity={status:'not-needed',reason:'Current output has sufficient detail'};current.review={...reviewedAttempt.review,checks:reviewChecks,issues:[]}
    await jump(0);await jump(99)
    assert.equal(returning().data.reworkStage,'passed');assert.equal(returning().data.phase,'completed')
    assert.equal(reviewing().data.wallpaper.attempt.revision,2)
    assert.equal(reviewedAttempt.review.checks.background.result,'violated','The preceding rejection remains in immutable history')
    await click([...win.document.querySelectorAll('button')].find(button=>button.textContent===zh.wallpaperBatchOverview))
    assert.equal(globalThis.__vcPlanningProjection.nodes.length,expected.overviewNodes)
    assert.equal(win.document.querySelectorAll('[data-image-id]').length,0)
    const routes=[],locations=[]
    await act(async()=>{rootNode.render(h(Canvas,{styleId:'fixture-style',workflow,t:key=>zh[key],useBatches:select=>select(state),actions,onOpen:async()=>{},navigation:{view:'image',sourceRunId:batch.runId,runId:'fixture-wallpaper',imageVersionId:'source-99',serial:1},onNavigate:value=>routes.push(value),onLocation:value=>locations.push(value)}));await flush()})
    assertImageFlow('source-99');assert.equal(locations.at(-1).imageVersionId,'source-99')
    await act(async()=>{rootNode.render(h(Canvas,{styleId:'fixture-style',workflow,t:key=>zh[key],useBatches:select=>select(state),actions,onOpen:async()=>{},navigation:{view:'image',sourceRunId:batch.runId,runId:'fixture-wallpaper',imageVersionId:'foreign-image',serial:2},onNavigate:value=>routes.push(value),onLocation:value=>locations.push(value)}));await flush()})
    assert(win.document.querySelector('[data-route-pending]'))
    assert(win.document.body.textContent.includes(zh.workflowImageUnavailable))
    assert(!routes.some(route=>route.imageVersionId==='foreign-image'))
    const DirectCanvas=createDirectCropCanvas(React,ui),directBatch={...batch,directCrop:true,removable:true,name:'Current version repair',origin:'local'}
    const directReview=()=>globalThis.__vcPlanningProjection.nodes.find(node=>node.data.stage==='reviewing')
    const directReturn=()=>globalThis.__vcPlanningProjection.edges.find(edge=>edge.data.rework)
    const directRender=async refreshKey=>{await act(async()=>{rootNode.render(h(DirectCanvas,{batch:directBatch,invoke:workflow.wallpaper,t:key=>zh[key],pollMs:1000000,pageSize:12,scope:'isolated-rework',imageVersionId:'source-99',onImage:noop,onTask:noop,refreshKey}));await flush()})}
    for(const key of ['review','outputId','simulationId','clarity'])delete current[key]
    reviewed.status='rendering';workflowStatus='running'
    await directRender(0)
    assert.equal(directReview().data.control.attempt.revision,2)
    assert.equal(directReturn().data.reworkStage,'rendering');assert.equal(directReturn().markerEnd.color,'var(--dsw-alias-state-error-primary)')
    current.outputId='second-output';current.simulationId='second-simulation';reviewed.status='reviewing'
    await directRender(1)
    assert.equal(directReview().data.phase,'running');assert.equal(directReturn().data.reworkStage,'reviewing')
    assert.equal(directReturn().markerEnd.color,'var(--dsw-alias-state-warn-primary)')
    reviewed.status='technical-failed';reviewed.failedStep='reviewing';reviewed.errorCode='vision-invalid-output';workflowStatus='completed'
    await directRender(2)
    assert.equal(directReview().data.phase,'failed');assert.equal(directReturn().data.reworkStage,'reviewing')
    assert.equal(directReturn().markerEnd.color,'var(--dsw-alias-state-warn-primary)')
    delete reviewed.failedStep;delete reviewed.errorCode;current.review={...reviewedAttempt.review,checks:reviewChecks,issues:[]};reviewed.status='passed'
    await directRender(3)
    assert.equal(directReview().data.phase,'completed');assert.equal(directReturn().data.reworkStage,'passed')
    assert.equal(directReturn().markerEnd.color,'var(--dsw-alias-state-success-primary)')
    assert.equal(reviewedAttempt.review.checks.background.result,'violated')
    for(const key of ['review','outputId','simulationId'])delete current[key]
    reviewed.status='needs-review';workflowStatus='completed'
    await directRender(4)
    const decisionNode=()=>globalThis.__vcPlanningProjection.nodes.find(node=>node.data.stage==='decision')
    assert(decisionNode());assert.equal(decisionNode().data.kind,'decision');assert.equal(decisionNode().data.phase,'attention')
    const decisionButton=()=>[...win.document.querySelectorAll('.vc-decision-card button')].find(button=>button.textContent===zh.wallpaperDecisionStart)
    assert(decisionButton());await click(decisionButton())
    assert.equal(mutations.length,1);assert.equal(mutations[0].operation,'wallpaper-continue')
    assert.equal(mutations[0].args.runId,'fixture-wallpaper');assert.deepEqual(mutations[0].args.decision,{imageVersionId:'source-99'})
    assert.equal('retryImage' in mutations[0].args,false);assert.equal('review' in mutations[0].args,false)
    workflowStatus='running';await directRender(5)
    assert.equal(decisionButton().disabled,true)
    await click([...win.document.querySelectorAll('.vc-decision-card button')].find(button=>button.textContent===zh.wallpaperPause))
    assert.deepEqual(mutations[1],{operation:'wallpaper-control',args:{runId:'fixture-wallpaper',command:'pause'}})
    reviewed.status='planning'
    reviewed.decisions=[{id:'decision-1',version:'wallpaper-decision-v1',inputDigest:'a'.repeat(64),evidenceDigest:'b'.repeat(64),planRevision:2,round:1,status:'running',reason:'Checking the supplied whole source and native evidence.'}]
    await directRender(6)
    assert.deepEqual(globalThis.__vcPlanningProjection.nodes.filter(node=>node.data.phase==='running').map(node=>node.data.stage),['decision'])
    assert.equal(decisionNode().data.phase,'running');assert.equal(win.document.querySelector('.vc-decision-card').getAttribute('aria-busy'),'true')
    assert(win.document.querySelector('.vc-decision-card').textContent.includes(zh.wallpaperDecisionRunning));assert.equal(decisionButton(),undefined)
    const decision=reviewed.decisions[0]
    workflowStatus='completed';decisionPolicy={version:'wallpaper-decision-v1',enabled:true,maxRoundsPerImage:1,maxDetailRequests:1}
    await directRender('interrupted-decision')
    assert.equal(decisionNode().data.phase,'attention')
    const stoppedCard=win.document.querySelector('.vc-decision-card')
    assert.equal(stoppedCard.getAttribute('aria-busy'),'false');assert(stoppedCard.textContent.includes(zh.wallpaperDecisionPaused))
    assert(!stoppedCard.textContent.includes(zh.wallpaperDecisionNext))
    const resumeDecision=[...stoppedCard.querySelectorAll('button')].find(button=>button.textContent===zh.wallpaperDecisionResume)
    assert(resumeDecision);assert.equal(resumeDecision.disabled,false)
    await click(resumeDecision)
    assert.deepEqual(mutations.at(-1).args.decision,{imageVersionId:'source-99'})
    assert.equal(decision.round,1);assert.equal(decision.status,'running')
    const batchMenuButton=()=>[...win.document.querySelectorAll('button')].find(button=>button.textContent.includes(zh.wallpaperBatchActions))
    const batchCancel=()=>[...win.document.querySelectorAll('[role=menuitem]')].find(button=>button.textContent===zh.wallpaperCancel)
    await click(batchMenuButton());assert.equal(batchCancel().disabled,true,'A fully passed completed batch has no pending processing to cancel')
    await click(batchMenuButton())
    counts.passed=99;counts.attention=1;await directRender('pending-batch-cancel')
    await click(batchMenuButton());assert.equal(batchCancel().disabled,false)
    await click(batchCancel())
    assert.deepEqual(mutations.at(-1),{operation:'wallpaper-control',args:{runId:'fixture-wallpaper',command:'cancel'}})
    workflowStatus='cancelled';await directRender('cancelled-batch')
    assert.equal(win.document.querySelector('.vc-direct-task-status').getAttribute('data-phase'),'cancelled')
    assert.equal(decisionNode().data.phase,'cancelled')
    const cancelledCard=win.document.querySelector('.vc-decision-card')
    assert.equal(cancelledCard.getAttribute('aria-busy'),'false')
    assert(cancelledCard.textContent.includes(zh.wallpaperCancelledHint))
    assert(!cancelledCard.textContent.includes(zh.wallpaperDecisionResume))
    assert(win.document.querySelector('.vc-direct-task-status').textContent.includes(zh.wallpaperBatchUnfinished.replace('{count}','1')))
    assert(!win.document.querySelector('.vc-direct-task-status').textContent.includes(zh.wallpaperBatchAttention.replace('{count}','1')))
    assert.equal(win.document.querySelector('[data-image-index="99"]').getAttribute('data-status'),'cancelled')
    await click(batchMenuButton());assert.equal(batchCancel().disabled,true)
    await click(batchMenuButton())
    workflowStatus='running';decisionPolicy=undefined
    decision.status='applied';decision.targetStage='rendering';decision.targetRevision=2
    decision.response={version:'wallpaper-decision-v1',imageVersionId:'source-99',planRevision:2,sourceExtent:{extent:'complete',reason:'The source frame is complete.'},action:{kind:'continue_current_plan'},reason:'Continue processing the existing evidence.',findings:[{concernId:'occlusion',scope:'subject',classification:'normal-occlusion',blocking:false,reason:'Preserve the observed self-occlusion without inventing hidden structure.',evidenceImageVersionIds:['source-99']}]}
    reviewed.status='rendering';await directRender(7)
    assert.equal(decisionNode().data.phase,'completed')
    const routed=globalThis.__vcPlanningProjection.edges.find(edge=>edge.id==='direct-decision-output')
    assert(routed);assert.equal(routed.source,decisionNode().id);assert(routed.target.endsWith(':image-step:rendering:rendering'))
    const directStages=globalThis.__vcPlanningProjection.nodes
    for(let index=1;index<directStages.length;index++)assert(directStages[index].position.x>=directStages[index-1].position.x+directStages[index-1].style.width+100,'direct steps keep clear columns in displayed order')
    assert.equal(globalThis.__vcPlanningProjection.edges.some(edge=>edge.source.endsWith(':image-step:geometry:planning')&&edge.target.endsWith(':image-step:rendering:rendering')),false)
    assert.equal(current.review,undefined);assert(!win.document.querySelector('.vc-decision-card').textContent.includes(zh.wallpaperPassed))
    await click([...win.document.querySelectorAll('.vc-decision-card button')].find(button=>button.textContent===zh.wallpaperStepDetails))
    assert(win.document.querySelector('[role=dialog]').textContent.includes(decision.response.findings[0].reason))
    await click([...win.document.querySelectorAll('[role=dialog] button')].find(button=>button.textContent===zh.close))
    decisionPolicy={version:'wallpaper-decision-v1',enabled:true,maxRoundsPerImage:1,maxDetailRequests:1}
    reviewed.status='needs-review';workflowStatus='completed';decision.status='manual'
    await directRender(8)
    assert.equal(decisionButton().disabled,true);assert(win.document.querySelector('.vc-decision-card').textContent.includes(zh.wallpaperDecisionLimit))
    const mutationCount=mutations.length;await click(decisionButton());assert.equal(mutations.length,mutationCount)
    decision.status='applied';reviewed.reason='decision-round-limit'
    await directRender(9)
    assert.equal(decisionNode().data.phase,'attention');assert.equal(decision.status,'applied')
    assert.equal(globalThis.__vcPlanningProjection.edges.some(edge=>edge.id==='direct-decision-output'),false)
    assert(win.document.querySelector('.vc-decision-card').textContent.includes(zh.wallpaperDecisionLimitHint))
    delete reviewed.reason;reviewed.status='rendering';workflowStatus='running'
    await act(async()=>{rootNode.render(h(Canvas,{styleId:'fixture-style',workflow,t:key=>zh[key],useBatches:select=>select(state),actions,onOpen:async()=>{},navigation:{view:'image',sourceRunId:batch.runId,runId:'fixture-wallpaper',imageVersionId:'source-99',serial:3}}));await flush()})
    const automaticDecision=globalThis.__vcPlanningProjection.nodes.find(node=>node.data.kind==='decision')
    assert(automaticDecision);assert.equal(automaticDecision.data.phase,'completed')
    assert(globalThis.__vcPlanningProjection.edges.some(edge=>edge.source===automaticDecision.id&&edge.target.endsWith(':image-step:rendering:rendering')))
    const automaticStages=globalThis.__vcPlanningProjection.nodes
    for(let index=1;index<automaticStages.length;index++)assert(automaticStages[index].position.x>=automaticStages[index-1].position.x+automaticStages[index-1].style.width+100,'automatic steps keep clear columns in displayed order')
    assert.equal(globalThis.__vcPlanningProjection.edges.some(edge=>edge.source.endsWith(':image-step:geometry:planning')&&edge.target.endsWith(':image-step:rendering:rendering')),false)
  }finally{await act(async()=>rootNode.unmount());dom.window.close();delete globalThis.__vcPlanningProjection;for(const[key,descriptor]of Object.entries(previous)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}}
})
