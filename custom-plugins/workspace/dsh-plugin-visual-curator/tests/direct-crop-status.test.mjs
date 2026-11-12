/** Settled execution must expose the image's unresolved evidence without approving or rerunning it. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import Module from 'node:module'
import {dirname,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {build} from 'esbuild'
import {JSDOM} from 'jsdom'
const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url),React=require('react'),{act}=React,{createRoot}=require('react-dom/client')
const contents="export {imageWorkflowWindow} from './src/client/workflow-image-branches.ts';export {createWallpaperCanvas} from './src/client/wallpaper-canvas.tsx';export {wallpaperPlanSchema,wallpaperSettingsSchema} from './src/shared/wallpaper.ts';export {zh} from './src/client/workbench-locale.ts';"+['Button','Tag','StateDot','Menu'].map(name=>"export {"+name+"} from '../../../packages/client/ui-primitives/src/"+name+".tsx';").join('')
const compiled=await build({stdin:{contents,resolveDir:root,loader:'ts'},outfile:resolve(root,'tests/direct-crop-status-memory.cjs'),bundle:true,write:false,platform:'node',format:'cjs',external:['react','react/*','react-dom','react-dom/*'],loader:{'.css':'empty','.webp':'empty'},logLevel:'silent'})
const filename=resolve(root,'tests/direct-crop-status-memory.cjs'),capsule=new Module(filename);capsule.filename=filename;capsule.paths=Module._nodeModulePaths(dirname(filename));capsule._compile(compiled.outputFiles.find(file=>file.path.endsWith('.cjs')).text,filename)
const {createWallpaperCanvas,wallpaperPlanSchema,wallpaperSettingsSchema,zh,Button,Tag,StateDot,Menu}=capsule.exports,ui={Button,Tag,StateDot,Menu,IconBrowseOutlineRegular:()=>null,IconChevronDownOutlineRegular:()=>null}
const expected=JSON.parse(await readFile(new URL('./fixtures/direct-crop-status.expected.json',import.meta.url),'utf8'))
async function fixture(work){const keys=['window','document','HTMLElement','Element','Node','getComputedStyle','IS_REACT_ACT_ENVIRONMENT'],previous=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)])),dom=new JSDOM('<div id="root"></div>',{url:'https://isolated.example/',pretendToBeVisual:true});Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Element:dom.window.Element,Node:dom.window.Node,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),IS_REACT_ACT_ENVIRONMENT:true});const rendered=createRoot(document.getElementById('root'));try{await work(rendered)}finally{await act(async()=>rendered.unmount());dom.window.close();for(const key of keys){const descriptor=previous.get(key);if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}}}
function controller(){const plan=wallpaperPlanSchema.parse({version:1,imageVersionId:'source',mode:'scene',subject:'林间道路上的轿车',evidence:'暗部车轮轮廓仍不清晰',priorities:[],anchors:[],truncations:[],uncertainties:[expected.reason],regions:[{name:'轿车',role:'subject',rect:{x:0.39,y:0.44,width:0.24,height:0.17}}],placement:{scale:0.656,left:-170,top:0},reason:'保留主体'}),attempt={revision:1,plan,checks:['uncertain-subject'],needsOutpaint:false},item={imageVersionId:'source',originalId:'source',familyId:'family',status:'needs-review',edits:0,attempts:[attempt],reason:expected.reason},events=[];return {events,attempt,item,downloads:{},busy:false,value:{runId:'run',sourceRunId:'source-run',status:'completed',settings:wallpaperSettingsSchema.parse({}),total:1,offset:0,state:{version:2,sourceRunId:'source-run',skillVersion:'fixture',items:[item],budgetStopped:false},counts:{passed:0,'needs-review':1},resources:{},previewResources:{},sourceImages:{},warnings:[]},setDetails:step=>events.push({details:step}),editPlan:()=>events.push({edit:true}),reinspect:()=>events.push({detail:true}),control:command=>events.push({command}),continue:()=>events.push({continue:true})}}
test('the planning card shows the unresolved evidence instead of only a generic pending label',async()=>fixture(async rendered=>{const control=controller(),components=createWallpaperCanvas(React,ui);await act(async()=>rendered.render(React.createElement(components.ImageStepCard,{kind:'planning',stage:'planning',control,t:key=>zh[key]})));assert(document.querySelector('[role="alert"]')?.textContent.includes(expected.reason),'The card must expose the reason that stopped this image');assert.equal(control.events.length,0)}))

test('a failed rendering card keeps retry visible while another image is running and never dispatches before pause',async()=>fixture(async rendered=>{
 const control=controller(),components=createWallpaperCanvas(React,ui)
 control.item.status='technical-failed';control.item.failedStep='rendering';control.item.errorCode='capability-unavailable'
 control.attempt.checks=[];control.attempt.plan.uncertainties=[];control.attempt.plan.truncations=['正常自遮挡，不是主体截断']
 control.attempt.detailAnalysis={version:'wallpaper-plan-detail-v2',requestId:'saved-detail',outcome:'resolved'}
 control.retryImage=step=>control.events.push({retry:step});control.value.status='running'
 const paint=()=>act(async()=>rendered.render(React.createElement(components.ImageStepCard,{kind:'rendering',stage:'rendering',control,t:key=>zh[key]})))
 await paint()
 const buttons=()=>[...document.querySelectorAll('.vc-flow-node-actions button')]
 let retry=buttons().find(button=>button.textContent===expected.recovery.retry)
 assert.ok(retry);assert.equal(retry.disabled,true);assert.equal(retry.title,zh.wallpaperRecoveryPauseFirst)
 assert(document.querySelector('.vc-recovery-pause-hint')?.textContent.includes(zh.wallpaperRecoveryPauseFirst))
 assert.deepEqual(control.events,[])
 await act(async()=>buttons().find(button=>button.textContent===zh.wallpaperPause).click())
 assert.deepEqual(control.events,[{command:'pause'}])
 control.value.status='paused';await paint()
 retry=buttons().find(button=>button.textContent===expected.recovery.retry)
 assert.equal(retry.disabled,false)
 await act(async()=>retry.click())
 assert.deepEqual(control.events,[{command:'pause'},{retry:'rendering'}])
}))

test('a pending planning card exposes detail inspection and plan editing as explicit separate actions',async()=>fixture(async rendered=>{
 const control=controller(),components=createWallpaperCanvas(React,ui)
 control.attempt.detailAnalysis={version:'wallpaper-plan-detail-v2',requestId:'saved-detail',outcome:'unresolved'}
 await act(async()=>rendered.render(React.createElement(components.ImageStepCard,{kind:'planning',stage:'planning',control,t:key=>zh[key]})))
 const buttons=[...document.querySelectorAll('.vc-flow-node-actions button')]
 const inspect=buttons.find(button=>button.textContent===expected.recovery.inspect),edit=buttons.find(button=>button.textContent===expected.recovery.edit)
 assert.ok(inspect);assert.ok(edit);assert.equal(inspect.disabled,false);assert.equal(edit.disabled,false);assert.deepEqual(control.events,[])
 await act(async()=>inspect.click());await act(async()=>edit.click())
 assert.deepEqual(control.events,[{detail:true},{edit:true}])
}))

test('an exhausted legacy extent decision offers reinspection of the saved original', async () => fixture(async rendered => {
  const control = controller()
  control.attempt.detailAnalysis = { version: 'wallpaper-plan-detail-v2', requestId: 'old-detail', outcome: 'violated' }
  control.item.reason = 'decision-round-limit'
  const { DecisionCard } = createWallpaperCanvas(React, ui)
  await act(async () => rendered.render(React.createElement(DecisionCard, { control, t: key => zh[key] })))
  const inspect = [...document.querySelectorAll('button')].find(button => button.textContent === zh.directCropReinspect)
  assert.ok(inspect)
  assert.equal(inspect.disabled, false)
  assert.deepEqual(control.events, [])
  await act(async () => inspect.click())
  assert.deepEqual(control.events, [{ detail: true }])
}))

test('a saved output with a visible background seam offers rework after two planning decisions', async () => fixture(async rendered => {
  const control = controller(), { ImageStepCard } = createWallpaperCanvas(React, ui)
  control.value.settings = wallpaperSettingsSchema.parse({ maxReworks: 2, maxEditsPerImage: 2, decision: { maxRoundsPerImage: 2 } })
  control.item.reason = 'decision-round-limit'
  control.item.failedStep = 'reviewing'
  control.item.edits = 1
  control.item.decisions = [1, 2].map(round => ({ id: 'planning-' + round, planRevision: 1, round, sourceStage: 'planning', status: 'manual' }))
  control.attempt.plan.mode = 'single'
  control.attempt.plan.uncertainties = []
  control.attempt.checks = []
  control.attempt.outputId = 'rendered'
  control.attempt.needsOutpaint = true
  const pass = { result: 'satisfied', reason: 'Verified from the supplied pixels.' }
  const background = { result: 'violated', reason: 'A visible seam crosses the extended sky.' }
  control.attempt.review = {
    reviewVersion: 'wallpaper-review-source-v1', subject: 'Vehicle', styleResults: [],
    checks: { subject: pass, protection: pass, clock: pass, readability: pass, composition: pass, background, style: pass, clarity: pass },
    issues: [{ kind: 'background', reason: background.reason }],
    subjectIntegrity: { mode: 'single', source: { extent: 'complete', imageVersionId: 'source', reason: 'All vehicle contours are in frame.' }, output: { extent: 'complete', imageVersionId: 'rendered', reason: 'All vehicle contours were preserved.' }, task: pass },
  }
  control.reviewCurrent = () => control.events.push({ review: true })
  control.rework = () => control.events.push({ rework: true })
  await act(async () => rendered.render(React.createElement(ImageStepCard, { kind: 'reviewing', stage: 'reviewing', control, t: key => zh[key] })))
  assert.ok(document.querySelector('[role="alert"]').textContent.includes(background.reason))
  const buttons = [...document.querySelectorAll('button')]
  const rework = buttons.find(button => button.textContent === '继续返工')
  assert.ok(rework && !rework.disabled)
  assert.equal(buttons.some(button => button.textContent === zh.wallpaperReviewCurrent), false)
  assert.deepEqual(control.events, [])
  await act(async () => rework.click())
  assert.deepEqual(control.events, [{ rework: true }])
}))

test('the failed manual inspection displays its own result and accepts another inspection after decision round two', async () => fixture(async rendered => {
  const control = controller(), components = createWallpaperCanvas(React, ui), t = key => zh[key]
  control.item.status = 'technical-failed'
  control.item.failedStep = 'planning'
  control.item.errorCode = 'vision-invalid-output'
  control.item.decisions = [{ id: 'old-decision', round: 2, planRevision: 1, status: 'failed', reason: 'old decision error' }]
  control.item.detailInspection = { origin: 'manual', requestId: 'new-inspection', planRevision: 1, decisionRoundAtStart: 2, status: 'failed', errorCode: 'vision-invalid-output' }
  const steps = capsule.exports.imageWorkflowWindow(control.item, control.attempt)
  await act(async () => rendered.render(React.createElement(React.Fragment, null, steps.map(({ stage, kind }) =>
    stage === 'decision' ? React.createElement(components.DecisionCard, { key: stage, control, t }) : React.createElement(components.ImageStepCard, { key: stage, stage, kind, control, t })
  ))))
  assert.ok(document.body.textContent.includes(zh.directCropDetailManual))
  assert.ok(document.body.textContent.includes(zh.directCropDetailInvalidOutput))
  assert.equal(document.body.textContent.includes(zh.wallpaperDecisionLimit), false)
  assert.equal(document.body.textContent.includes('old decision error'), false)
  const card = [...document.querySelectorAll('section')].find(element => element.textContent.includes(zh.directCropDetailFailed))
  const buttons = [...card.querySelectorAll('button')]
  const details = buttons.find(button => button.textContent === zh.wallpaperStepDetails)
  const retry = buttons.find(button => button.textContent === zh.directCropReinspect)
  assert.ok(retry && !retry.disabled)
  await act(async () => details.click())
  await act(async () => retry.click())
  assert.deepEqual(control.events, [{ details: 'detail' }, { detail: true }])
}))

test('the current-image bar exposes replacement, single-image cancel and retry separately from batch cancel',async()=>fixture(async rendered=>{
 const control=controller(),components=createWallpaperCanvas(React,ui)
 control.replaceImage=()=>control.events.push({replace:control.item.imageVersionId})
 control.cancelImage=()=>control.events.push({cancel:control.item.imageVersionId})
 control.retryCurrent=()=>control.events.push({retry:control.item.imageVersionId})
 const paint=()=>act(async()=>rendered.render(React.createElement(components.TaskStatus,{control,t:key=>zh[key]})))
 await paint()
 const buttons=()=>[...document.querySelectorAll('.vc-direct-task-actions button')]
 assert.deepEqual(buttons().filter(button=>expected.imageActions.includes(button.textContent)).map(button=>button.textContent),expected.imageActions)
 assert.deepEqual(control.events,[])
 for(const label of expected.imageActions)await act(async()=>buttons().find(button=>button.textContent===label).click())
 assert.deepEqual(control.events,[{replace:'source'},{cancel:'source'},{retry:'source'}])
 await act(async()=>buttons().find(button=>button.textContent===zh.wallpaperBatchActions).click())
 const batchCancel=[...document.querySelectorAll('[role="menuitem"]')].find(node=>node.textContent===zh.wallpaperCancelAllImages)
 assert.ok(batchCancel)
 await act(async()=>batchCancel.click())
 assert.deepEqual(control.events.at(-1),{command:'cancel'})
 control.value.status='running';await paint()
 assert(buttons().filter(button=>expected.imageActions.includes(button.textContent)).every(button=>button.disabled))
}))
test('a settled run with unresolved evidence stays attention and offers diagnostics without automatic work',async()=>fixture(async rendered=>{const control=controller(),components=createWallpaperCanvas(React,ui);await act(async()=>rendered.render(React.createElement(components.TaskStatus,{control,t:key=>zh[key]})));const summary=document.querySelector('.vc-direct-task-status');assert.equal(summary.dataset.phase,expected.phase);assert(summary.textContent.includes(expected.approved));assert(summary.textContent.includes(expected.hint));assert(!summary.textContent.includes(zh.workflowPhaseCompleted));assert.equal(control.events.length,0);await act(async()=>[...summary.querySelectorAll('button')].find(button=>button.textContent===zh.directCropInspect).click());assert.deepEqual(control.events,[{details:'planning'}]);control.events.length=0;control.value.status='running';await act(async()=>rendered.render(React.createElement(components.TaskStatus,{control,t:key=>zh[key]})));assert.equal(document.querySelector('.vc-direct-task-status').dataset.phase,'running');await act(async()=>[...document.querySelectorAll('button')].find(button=>button.textContent===zh.wallpaperPause).click());assert.deepEqual(control.events,[{command:'pause'}]);control.value.status='completed';control.value.counts={passed:1};control.item.status='passed';await act(async()=>rendered.render(React.createElement(components.TaskStatus,{control,t:key=>zh[key]})));assert.equal(document.querySelector('.vc-direct-task-status').dataset.phase,'completed');assert.equal(document.querySelectorAll('.vc-direct-task-status button').length,4);assert([...document.querySelectorAll('.vc-direct-task-status button')].some(button=>button.textContent===zh.wallpaperBatchActions))}))
