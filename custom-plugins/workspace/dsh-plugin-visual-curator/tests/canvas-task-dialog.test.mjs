/** Dialog reads cannot show a previous task; capsule controls change presentation only. */
import assert from 'node:assert/strict'
import test from 'node:test'
import Module, { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url),React=require('react'),{act}=React,{createRoot}=require('react-dom/client')
const compiled=await build({stdin:{contents:"export {createTaskHistory} from './src/client/task-history.tsx'; export {createCanvasTaskDialog} from './src/client/canvas-task-dialog.tsx'; export {createConversationTaskDock} from './src/client/conversation-task-dock.tsx'; export {conversationRunSchema} from './src/client/conversation-feedback.ts'; export {createWallpaperPlanEditor} from './src/client/wallpaper-plan-editor.tsx'; export {createWallpaperCanvas} from './src/client/wallpaper-canvas.tsx'; export {wallpaperSettingsSchema} from './src/shared/wallpaper.ts'; export {zh} from './src/client/workbench-locale.ts';",resolveDir:root,loader:'ts'},bundle:true,write:false,packages:'external',platform:'node',format:'cjs',logLevel:'silent'})
const filename=resolve(root,'tests/task-dialog-memory.cjs'),capsule=new Module(filename);capsule.filename=filename;capsule.paths=Module._nodeModulePaths(dirname(filename));capsule._compile(compiled.outputFiles[0].text,filename)
const {createCanvasTaskDialog,createConversationTaskDock,conversationRunSchema,zh}=capsule.exports,h=React.createElement,t=key=>zh[key]
const ui=new Proxy({
 Modal:({open,title,children,className,footer})=>open?h('div',{role:'dialog',className},h('h2',null,title),children,footer):null,
 Button:React.forwardRef(({children,size,variant,...props},ref)=>h('button',{...props,ref},children)),
 Menu:({anchor})=>anchor,Tooltip:({children})=>children,Tag:({children})=>h('span',null,children),StateDot:({state})=>h('i',{'data-state':state}),
 AnimatedCollapse:({open,children,...props})=>h('div',{hidden:!open,id:props.id},children),
 ImageGenerationSkeleton:({active})=>h('canvas',{'data-image-generation-skeleton':'','data-active':active}),
},{get:(target,key)=>target[key]??(()=>null)})
async function environment(work){
 const previous=Object.fromEntries(['window','document','navigator','HTMLElement','Node','getComputedStyle','IS_REACT_ACT_ENVIRONMENT'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)])),dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.invalid'})
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),IS_REACT_ACT_ENVIRONMENT:true}))Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v})
 const rootNode=createRoot(document.getElementById('root'))
 try{await work({paint:async element=>act(async()=>{rootNode.render(element);await Promise.resolve()}),doc:document})}finally{await act(async()=>rootNode.unmount());dom.window.close();for(const[k,v]of Object.entries(previous))if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k]}
}

test('task details group the core metrics and hide the previous task while another read is pending',()=>environment(async({paint,doc})=>{
 const Dialog=createCanvasTaskDialog(React,ui),first={runId:'first',kind:'search',status:'completed',stage:'reviewing',taskBrief:'First task',createdAt:'2026-11-09T00:00:00Z',counts:{candidates:50,deepReviewed:10,qualified:5,distinct:50,technicalFailed:0},requests:75,warnings:[]}
 let finish
 const read=async id=>id==='first'?first:new Promise(resolve=>{finish=resolve})
 const props={open:true,runId:'first',read,pollMs:60000,t,onClose(){}}
 await paint(h(Dialog,props))
 assert.equal(doc.querySelectorAll('.vc-canvas-task-primary > div').length,3)
 assert.deepEqual([...doc.querySelectorAll('.vc-canvas-task-section h3')].map(e=>e.textContent),[zh.workflowTaskRequirements,zh.workflowTaskProgress,zh.workflowTaskDiagnostics])
 assert.equal(doc.querySelector('.vc-canvas-task-record').open,false)
 await paint(h(Dialog,{...props,runId:'second'}))
 assert(!doc.body.textContent.includes('First task'));assert(doc.body.textContent.includes(zh.busy))
 await act(async()=>finish({...first,runId:'second',taskBrief:'Second task'}))
 assert(doc.body.textContent.includes('Second task'));assert(!doc.body.textContent.includes('First task'))
}))

test('minimizing and restoring the task card preserves progress and does not operate on its task',()=>environment(async({paint,doc})=>{
 const Dock=createConversationTaskDock(React,ui),calls=[]
 const state={tasks:{items:[{runId:'run',kind:'search',status:'running',revision:1,taskBrief:'Search task'}]},selectedRunId:'run',runs:{run:{freshness:'current',run:{status:'running',revision:1,outputKind:'preview',counts:{},results:[],resultSummary:{selected:5,target:10,candidates:50,needsReview:0}}}}}
 const noop=()=>calls.push('unexpected operation')
 await paint(h(Dock,{sessionId:'session',t,useFeedback:select=>select(state),selectTask:noop,refreshTask:noop,openTask:noop,stopTask:noop,filterTask:noop,loadMoreTask:noop}))
 await act(async()=>doc.querySelector('button[aria-label="'+zh.taskMinimize+'"]').click())
 const compact=doc.querySelector('[data-capsule]');assert(compact);assert(compact.textContent.includes('5 / 10'));assert(!compact.textContent.includes(zh.taskStopBackground))
 await act(async()=>doc.querySelector('button[aria-label="'+zh.taskRestore+'"]').click())
 assert(!doc.querySelector('[data-capsule]'));assert(doc.querySelector('.vc-conversation-task-metrics'));assert.deepEqual(calls,[])
}))

test('a failed launch retains its error state when minimized before any search Run exists',()=>environment(async({paint,doc})=>{
 const Dock=createConversationTaskDock(React,ui),calls=[]
 const state={tasks:{items:[],launch:{id:'launch',status:'failed',stage:'accepted',input:{taskBrief:'Retained search requirements',targetCount:1},error:{safeMessage:'The conversation failed.'}}},runs:{}}
 const noop=()=>calls.push('unexpected operation')
 await paint(h(Dock,{sessionId:'session',t,useFeedback:select=>select(state),selectTask:noop,refreshTask:noop,openTask:noop,stopTask:noop,filterTask:noop,loadMoreTask:noop}))
 assert(doc.body.textContent.includes('The conversation failed.'))
 await act(async()=>doc.querySelector('button[aria-label="'+zh.taskMinimize+'"]').click())
 const compact=doc.querySelector('[data-capsule]');assert(compact);assert(compact.textContent.includes(zh.failed))
 assert.equal(compact.querySelector('[data-state]').getAttribute('data-state'),'error')
 assert.deepEqual(calls,[])
}))

test('wallpaper goals follow the child production and final review instead of completed source search',()=>environment(async({paint,doc})=>{
 const Dock=createConversationTaskDock(React,ui),actual=[],calls=[]
 const cases=[{status:'running',passed:0,complete:false},{status:'paused',passed:0,complete:false},{status:'completed',passed:0,complete:false},{status:'completed',passed:1,complete:false},{status:'completed',passed:2,complete:true}]
 for(const value of cases){
  const run=conversationRunSchema.parse({runId:'run',owner:{kind:'session',sessionId:'session'},launchId:'949d1789-e443-4ba7-b3d0-9f34f7a3392e',kind:'search',status:'completed',outputKind:'preview',counts:{qualified:2},warnings:[],results:[],resultSummary:{selected:2,target:2,candidates:50,needsReview:0},wallpaperRequired:true,workflowComplete:value.complete,wallpaper:{runId:'wallpaper',sourceRunId:'run',status:value.status,total:2,passed:value.passed,complete:value.complete,attentionTotal:value.status==='completed'&&!value.complete?2-value.passed:0}})
  const state={tasks:{items:[{runId:'run',kind:'search',status:'completed',taskBrief:'Wallpaper goal'}]},selectedRunId:'run',runs:{run:{freshness:'current',run}}}
  await paint(h(Dock,{key:JSON.stringify(value),sessionId:'session',t,useFeedback:select=>select(state),selectTask(){},refreshTask(){},openTask:async id=>{calls.push(id)},stopTask(){},filterTask(){calls.push('source-filter')},loadMoreTask(){}}))
  const header=doc.querySelector('.vc-conversation-task-header'),metric=doc.querySelector('[data-result="selected"]')
  actual.push({status:value.status,passed:value.passed,label:header.textContent.replace(zh.searchKind,''),state:header.querySelector('[data-state]').getAttribute('data-state'),metric:metric.textContent})
  await act(async()=>metric.click())
  await act(async()=>doc.querySelector('button[aria-label="'+zh.taskMinimize+'"]').click())
  const compact=doc.querySelector('[data-capsule]')
  assert(compact.textContent.includes(value.passed+' / 2'))
  assert.equal(compact.querySelector('[data-state]').getAttribute('data-state'),actual.at(-1).state)
 }
 assert.deepEqual(actual,JSON.parse(await readFile(new URL('./fixtures/conversation-wallpaper-progress.expected.json',import.meta.url),'utf8')))
 assert.deepEqual(calls,['run','run','run','run','run'], 'the entry refreshes the source before resolving its latest wallpaper child')
}))

test('plan editor explains every guide and protection role without changing saved evidence',()=>environment(async({paint,doc})=>{
 const Editor=capsule.exports.createWallpaperPlanEditor(React,ui),changes=[]
 const plan={version:1,imageVersionId:'original',mode:'single',subject:'Visible car',evidence:'Saved observation',priorities:['Preserve wheels'],anchors:[],truncations:[],uncertainties:['Unresolved observation'],regions:[{name:'Whole car',role:'subject',rect:{x:0.1,y:0.7,width:0.8,height:0.2}}],placement:{left:105,top:395,scale:0.43},reason:'Saved reason'}
 await paint(h(Editor,{plan,settings:capsule.exports.wallpaperSettingsSchema.parse({}),source:{width:3843,height:5764,previewPath:'https://fixture.invalid/original.png'},onChange:next=>changes.push(next),t}))
 const legends=[...doc.querySelectorAll('.vc-plan-editor-legend-item')].map(row=>({kind:row.querySelector('[data-kind]').dataset.kind,label:row.querySelector('strong').textContent,meaning:row.querySelector('small').textContent}))
 assert.deepEqual(legends,JSON.parse(await readFile(new URL('./fixtures/wallpaper-plan-editor.expected.json',import.meta.url),'utf8')))
 assert(doc.querySelector('.vc-plan-editor-key').open)
 assert(doc.querySelector('.vc-plan-editor-controls').textContent.includes(zh.wallpaperEditorUncertainties))
 assert(doc.querySelector('svg[viewBox="0 0 1845 3280"]'))
 await act(async()=>[...doc.querySelectorAll('button')].find(e=>e.textContent===zh.wallpaperEditorAddRegion).click())
 assert.equal(changes.length,1)
 assert.deepEqual(changes[0].uncertainties,plan.uncertainties)
 assert.deepEqual(changes[0].regions[0],plan.regions[0])
}))

test('review cards show the actual output annotations before approval and both views after approval',()=>environment(async({paint,doc})=>{
 const {ImageStepCard}=capsule.exports.createWallpaperCanvas(React,ui),checks=Object.fromEntries(['subject','protection','clock','readability','composition','background','style'].map(key=>[key,{result:'satisfied',reason:'Actual output pixels'}]))
 const attempt={revision:1,plan:{placement:{scale:0.4,left:0,top:0}},checks:[],needsOutpaint:true,outputId:'clean',analysisId:'annotated-output',simulationId:'clock-output',review:{issues:[],checks:{...checks,background:{result:'violated',reason:'Visible seam'}}}}
 const item={imageVersionId:'source',status:'needs-review',edits:1,attempts:[attempt]},value={status:'completed',state:{version:2},settings:capsule.exports.wallpaperSettingsSchema.parse({}),sourceImages:{},resources:{clean:'/api/visual-curator/resource?imageVersionId=clean', 'annotated-output':'/api/visual-curator/resource?imageVersionId=annotated', 'clock-output':'/api/visual-curator/resource?imageVersionId=clock'},previewResources:{clean:'/api/visual-curator/resource?imageVersionId=clean-preview','annotated-output':'/api/visual-curator/resource?imageVersionId=annotated-preview','clock-output':'/api/visual-curator/resource?imageVersionId=clock-preview'}}
 const history=[],control={item,attempt,value,setPreview(){},setDetails(){},setHistoryOpen(open){history.push(open)}},actual=[]
 await paint(h(ImageStepCard,{kind:'reviewing',stage:'reviewing',control,t}))
 actual.push({state:'rejected',labels:[...doc.querySelectorAll('.vc-image-review-previews button')].map(e=>e.getAttribute('aria-label')),images:[...doc.querySelectorAll('.vc-image-review-previews img')].map(e=>e.getAttribute('src'))})
 attempt.review.checks=checks;item.status='passed'
 await paint(h(ImageStepCard,{kind:'reviewing',stage:'reviewing',control,t}))
 actual.push({state:'passed',labels:[...doc.querySelectorAll('.vc-image-review-previews button')].map(e=>e.getAttribute('aria-label')),images:[...doc.querySelectorAll('.vc-image-review-previews img')].map(e=>e.getAttribute('src'))})
 assert.deepEqual(actual,JSON.parse(await readFile(new URL('./fixtures/wallpaper-review-node.expected.json',import.meta.url),'utf8')))
 assert.equal(doc.querySelectorAll('[data-image-generation-skeleton]').length,0)
 assert.equal(doc.querySelectorAll('.vc-image-preview-skeleton').length,2)
 await act(async()=>doc.querySelector('.vc-image-review-previews img').dispatchEvent(new window.Event('error')))
 const retry=doc.querySelector('button[aria-label="'+zh.wallpaperEditorRetryImage+'"]');assert(retry)
 await act(async()=>retry.click())
 assert.equal(doc.querySelectorAll('.vc-image-review-previews img').length,2)
 delete attempt.outputId;item.status='rendering';value.status='running'
 attempt.generation={id:'operation',taskId:'image-task',provider:'codex',model:'image-model'}
 await paint(h(ImageStepCard,{kind:'rendering',stage:'rendering',control,t}))
 assert.equal(doc.querySelector('[data-image-generation-skeleton]').dataset.active,'true')
 await act(async()=>[...doc.querySelectorAll('button')].find(button=>button.textContent===zh.wallpaperHistoryTitle).click())
 assert.deepEqual(history,[true])
 value.status='paused';await paint(h(ImageStepCard,{kind:'rendering',stage:'rendering',control,t}))
 assert.equal(doc.querySelector('[data-image-generation-skeleton]').dataset.active,'false')
}))

test('image history dialog shows saved milestones and selects the requested revision',()=>environment(async({paint,doc})=>{
 const {Dialogs}=capsule.exports.createWallpaperCanvas(React,ui),selected=[],closed=[]
 const checks=Object.fromEntries(['subject','protection','clock','readability','composition','background','style'].map(key=>[key,{result:'satisfied',reason:''}]))
 const attempt={revision:1,createdAt:'2026-11-12T01:01:00.000Z',plan:{subject:'Fox in a forest'},generatedImageId:'native',preResolutionReview:{nativeId:'native'},review:{checks,issues:[]},reviewedAt:'2026-11-12T01:03:00.000Z',outputId:'native'}
 const item={imageVersionId:'source',originalId:'original',status:'needs-review',attempts:[attempt]}
 const value={runId:'run',status:'completed',state:{items:[item],version:2},resources:{original:'/api/visual-curator/resource?imageVersionId=original',native:'/api/visual-curator/resource?imageVersionId=native'},previewResources:{},artifactTimes:{original:'2026-11-12T01:00:00.000Z',native:'2026-11-12T01:02:00.000Z'},sourceImages:{}}
 const control={sourceId:'batch',offset:0,pageSize:10,details:null,historyOpen:true,item,attempt,detailAttempt:attempt,value,settings:capsule.exports.wallpaperSettingsSchema.parse({}),models:[],settingsOpen:false,planText:null,experienceOpen:false,experience:null,sample:null,setRevision(value){selected.push(value)},setDetailRevision(){throw Error('History selected the details revision')},setHistoryOpen(open){closed.push(open)},setDetails(){}}
 await paint(h(Dialogs,{control,t}))
 const milestones=[...doc.querySelectorAll('.vc-image-history > li')].map(row=>({kind:row.dataset.kind,label:row.querySelector('.vc-image-history-heading strong').textContent,time:row.querySelector('time').dateTime}))
 assert.deepEqual({milestones},JSON.parse(await readFile(new URL('./fixtures/wallpaper-history.expected.json',import.meta.url),'utf8')))
 await act(async()=>[...doc.querySelectorAll('.vc-image-history button')].find(button=>button.textContent===zh.wallpaperHistoryViewRevision).click())
 assert.deepEqual(selected,[{image:'source',revision:1}]);assert.deepEqual(closed,[false])
}))
test('saved wallpaper results start one current-policy review and retain ordinary crop actions',()=>environment(async({paint,doc})=>{
 const History=capsule.exports.createTaskHistory(React,ui),calls=[],selectedIds=[]
 let finish
 const image={imageVersionId:'final-image',name:'Existing wallpaper',previewPath:'/api/visual-curator/resource?imageVersionId=final-image',width:1845,height:3280,selection:{kind:'selected',warnings:[]},verdict:'pass'}
 const run={runId:'old-wallpaper',kind:'crop',taskBrief:'Existing wallpaper',createdAt:'2026-11-09T00:00:00Z',status:'completed',revision:2,counts:{},warnings:[],results:[image],wallpaperTask:true}
 const props={runs:[run],selected:run,snapshot:{styles:[]},t,loading:false,actions:{execute:async(...args)=>{calls.push(args);return new Promise(resolve=>{finish=resolve})},loadRun:async()=>{},openAnalysis(){}},onSelect:id=>selectedIds.push(id),report:work=>{void work()}}
 await paint(h(History,props))
 await act(async()=>[...doc.querySelectorAll('button')].find(e=>e.textContent===zh.taskImageDetails).click())
 const button=[...doc.querySelectorAll('button')].find(e=>e.textContent===zh.wallpaperReviewCurrent)
 assert(button);assert(doc.body.textContent.includes(zh.wallpaperReviewCurrentHint))
 await act(async()=>{button.click();button.click()})
 assert.equal(calls.length,1);assert.equal(calls[0][0],'wallpaper-continue');assert.equal(calls[0][1].runId,'old-wallpaper');assert.deepEqual(calls[0][1].review,{outputId:'final-image'});assert(calls[0][1].operationId)
 await act(async()=>finish({runId:'new-review'}))
 assert.deepEqual(selectedIds,['new-review']);assert(!doc.querySelector('[role="dialog"]'))
 await paint(h(History,{...props,selected:{...run,wallpaperTask:false}}))
 await act(async()=>[...doc.querySelectorAll('button')].find(e=>e.textContent===zh.taskImageDetails).click())
 assert(![...doc.querySelectorAll('button')].some(e=>e.textContent===zh.wallpaperReviewCurrent))
}))
test('task inspection offers an explicit results route without starting work',()=>environment(async({paint,doc})=>{
 const Dialog=createCanvasTaskDialog(React,ui),opened=[]
 const task={runId:'saved-source',kind:'search',status:'completed',taskBrief:'Saved source',createdAt:'2026-11-09T00:00:00Z',counts:{},requests:0,warnings:[]}
 await paint(h(Dialog,{open:true,runId:task.runId,read:async()=>task,pollMs:60000,t,onClose(){},onOpenResults:()=>opened.push(task.runId)}))
 const button=[...doc.querySelectorAll('button')].find(button=>button.textContent===zh.workflowTaskResults)
 assert(button);assert.equal(button.disabled,false)
 await act(async()=>button.click());assert.deepEqual(opened,['saved-source'])
}))

test('Ctrl wheel changes only preview framing and fit restores the saved crop coordinates',()=>environment(async({paint,doc})=>{
 const Editor=capsule.exports.createWallpaperPlanEditor(React,ui),changes=[]
 const plan={version:1,imageVersionId:'original',mode:'single',subject:'Visible car',evidence:'Saved observation',priorities:[],anchors:[],truncations:[],uncertainties:[],regions:[{name:'Whole car',role:'subject',rect:{x:0.1,y:0.7,width:0.8,height:0.2}}],placement:{left:105,top:395,scale:0.43},reason:'Saved reason'}
 const props={plan,settings:capsule.exports.wallpaperSettingsSchema.parse({}),source:{width:3843,height:5764,previewPath:'https://fixture.invalid/original.png'},onChange:next=>changes.push(next),t}
 await paint(h(Editor,props))
 const svg=doc.querySelector('svg[viewBox]'),image=svg.querySelector('image'),before=image.outerHTML
 svg.getScreenCTM=()=>({inverse:()=>({a:1,b:0,c:0,d:1})})
 svg.createSVGPoint=()=>({x:0,y:0,matrixTransform(){return {x:this.x,y:this.y}}})
 const normal=new window.WheelEvent('wheel',{deltaY:-120,bubbles:true,cancelable:true})
 await act(async()=>svg.dispatchEvent(normal));assert.equal(normal.defaultPrevented,false);assert.equal(svg.getAttribute('data-preview-zoom'),'1')
 const wheel=new window.WheelEvent('wheel',{ctrlKey:true,deltaY:-120,clientX:100,clientY:100,bubbles:true,cancelable:true})
 await act(async()=>svg.dispatchEvent(wheel));assert.equal(wheel.defaultPrevented,true);assert(Number(svg.getAttribute('data-preview-zoom'))>1)
 assert.equal(image.outerHTML,before);assert.deepEqual(changes,[]);assert.equal(plan.placement.scale,0.43)
 await act(async()=>[...doc.querySelectorAll('button')].find(e=>e.textContent===zh.wallpaperEditorFitPreview).click())
 assert.equal(svg.getAttribute('viewBox'),'0 0 1845 3280')
 await act(async()=>doc.querySelector('button[aria-label="'+zh.wallpaperEditorZoomIn+'"]').click())
 assert.equal(svg.getAttribute('data-preview-zoom'),'1.25')
 await paint(h(Editor,{...props,plan:{...plan,imageVersionId:'different'}}))
 assert.equal(svg.getAttribute('viewBox'),'0 0 1845 3280');assert.deepEqual(changes,[])
}))

test('planning reasons precede the preview and task controls share one modal footer',()=>environment(async({paint,doc})=>{
 const Dialogs=capsule.exports.createWallpaperCanvas(React,ui).Dialogs,events=[]
 const plan={version:1,imageVersionId:'source',mode:'single',subject:'A cut-off car',evidence:'The source frame ends at the rear body.',priorities:[],anchors:[],truncations:['Rear body cut off'],uncertainties:[],regions:[],placement:{left:0,top:0,scale:0.5},reason:'Keep visible pixels'}
 const attempt={revision:1,plan,checks:[],needsOutpaint:false,detailAnalysis:{outcome:'violated'}},item={imageVersionId:'source',originalId:'source',status:'rejected',edits:0,attempts:[attempt],reason:'Original subject is cut off.'}
 const settings=capsule.exports.wallpaperSettingsSchema.parse({}),control={sourceId:'batch',offset:0,pageSize:10,details:'planning',busy:false,value:{runId:'run',status:'completed',warnings:[],total:1,state:{items:[item],version:2},settings,counts:{rejected:1},resources:{},sourceImages:{}},item,attempt,detailAttempt:attempt,settings,models:[],settingsOpen:false,planText:null,experienceOpen:false,experience:null,sample:null,setDetails(){},showExperience:()=>events.push('experience'),editPlan:()=>events.push('edit'),control:action=>events.push(action),continue:()=>events.push('continue')}
 await paint(h(Dialogs,{control,t}))
 const expected=JSON.parse(await readFile(new URL('./fixtures/direct-crop-dialog-controls.expected.json',import.meta.url),'utf8')).details
 assert.equal(doc.querySelector('.vc-image-detail-reason p').textContent,'Original subject is cut off.')
 assert.deepEqual([...doc.querySelectorAll('.vc-image-details-footer button')].map(b=>b.textContent),expected.settledButtons)
 assert.equal(doc.querySelector('.vc-image-planning-details button')?.textContent===zh.wallpaperEditPlan,false)
 await act(async()=>[...doc.querySelectorAll('.vc-image-details-footer button')].find(b=>b.textContent===zh.wallpaperEditPlan).click());assert.deepEqual(events,['edit'])
 control.value.status='running';await paint(h(Dialogs,{control,t}))
 const edit=[...doc.querySelectorAll('.vc-image-details-footer button')].find(b=>b.textContent===zh.wallpaperEditPlan);assert.equal(edit,undefined)
 assert.deepEqual([...doc.querySelectorAll('.vc-image-details-primary button')].map(b=>b.textContent),expected.runningButtons)
}))
