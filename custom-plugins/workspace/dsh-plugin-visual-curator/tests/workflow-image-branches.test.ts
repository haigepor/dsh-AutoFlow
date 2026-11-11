import assert from 'node:assert/strict'
import {test} from 'node:test'
import {planningImagesPerPage,planningWindowStart,planningImageNodeId,planningImageLane,planningImagePhase,imageWorkflowNodeId,imageWorkflowPhase,imageWorkflowStagePhase,imageNavigationPageSize,imageWorkflowStages,imageWorkflowWindow,imageWorkflowConnections,imageWorkflowArtifact,imageWorkflowRework,imageWorkflowDecisionRecord,fixedImageWorkflowNodeId} from '../src/client/workflow-image-branches.ts'
import {wallpaperRecovery,wallpaperCanDecide} from '../src/client/wallpaper-recovery.ts'
import {wallpaperDecisionRecordSchema} from '../src/shared/wallpaper-decision.ts'
import {wallpaperCanCancel,wallpaperImageWorkStatus,wallpaperPendingDecision,wallpaperProgress,wallpaperStateSchema,wallpaperViewSchema,wallpaperItemSchema,wallpaperPlanSchema,wallpaperReviewSchema,wallpaperReviewKeys} from '../src/shared/wallpaper.ts'

test('settled pending images remain cancellable while completed or already cancelled batches do not',()=>{
  assert.equal(wallpaperCanCancel('completed',5,4),true)
  assert.equal(wallpaperCanCancel('completed',5,5),false)
  assert.equal(wallpaperCanCancel('cancelled',5,4),false)
  assert.equal(wallpaperCanCancel('cancelling',5,4),false)
  assert.equal(wallpaperCanCancel('failed',5,0),true)
  assert.equal(wallpaperCanCancel('failed',0,0),false)
  assert.equal(wallpaperCanCancel('paused',5,4),true)
})

test('one hundred source images use twenty-five bounded groups with stable per-image identities',()=>{
  const sources=Array.from({length:100},(_,i)=>`source-${i}`),seen=new Set<string>(),sizes=[]
  for(let offset=0;offset<sources.length;offset+=planningImagesPerPage){
    const start=planningWindowStart(offset,planningImagesPerPage),group=sources.slice(start,start+planningImagesPerPage)
    sizes.push(group.length)
    for(const source of group){const id=planningImageNodeId('batch',source);assert.equal(planningImageLane(id),'batch');assert.equal(id,planningImageNodeId('batch',source));seen.add(id)}
  }
  assert.equal(sizes.length,25);assert.equal(Math.max(...sizes),4);assert.equal(seen.size,100)
  assert.equal(planningWindowStart(99,planningImagesPerPage),96)
  assert.notEqual(planningImageNodeId('batch',':'),planningImageNodeId('batch','_3A'))
  assert.match(planningImageNodeId('batch','车:图/a?b#c %'),/^batch:planning-image:[A-Za-z0-9_-]+$/)
})

test('planning cards follow their own stage and never animate stale work in a completed batch',()=>{
  const plan=wallpaperPlanSchema.parse({version:1,imageVersionId:'source',mode:'single',subject:'Vehicle',evidence:'Saved pixels',priorities:[],anchors:[],truncations:[],uncertainties:[],regions:[],placement:{scale:1,left:0,top:0},reason:'Saved layout'})
  const item=wallpaperItemSchema.parse({imageVersionId:'source',originalId:'source',familyId:'family',status:'planning',attempts:[]})
  assert.equal(planningImagePhase(item,'running'),'running')
  assert.equal(planningImagePhase(item,'paused'),'paused')
  assert.equal(planningImagePhase(item,'completed'),'queued')
  item.attempts.push({revision:1,plan,checks:[],needsOutpaint:false})
  item.status='needs-review';item.failedStep='reviewing'
  assert.equal(planningImagePhase(item,'completed'),'completed')
  item.attempts[0]!.checks=['top-buffer-overlap:Vehicle']
  assert.equal(planningImagePhase(item,'completed'),'attention')
  item.failedStep='downloading'
  assert.equal(planningImagePhase(item,'failed'),'blocked')
})

test('one hundred images have four distinct step identities each without sharing a rendering or review node',()=>{
  const ids=new Set<string>()
  for(let image=0;image<100;image++)for(const kind of ['downloading','planning','rendering','reviewing'] as const){
    const id=imageWorkflowNodeId('batch',`source-${image}`,kind)
    assert.equal(planningImageLane(id),'batch');assert(!ids.has(id));ids.add(id)
  }
  assert.equal(ids.size,400);assert.equal(imageNavigationPageSize,12)
})

test('single-image steps preserve download activity and isolate downstream failures and saved revision reviews',()=>{
  const item=wallpaperItemSchema.parse({imageVersionId:'source',familyId:'family',status:'queued',attempts:[]})
  assert.equal(imageWorkflowPhase('downloading',item,'running'),'queued')
  item.status='downloading';assert.equal(imageWorkflowPhase('downloading',item,'running'),'running')
  assert.equal(imageWorkflowPhase('downloading',item,'paused'),'paused')
  assert.equal(imageWorkflowPhase('planning',item,'running'),'blocked')
  item.originalId='source'
  const plan=wallpaperPlanSchema.parse({version:1,imageVersionId:'source',mode:'single',subject:'Vehicle',evidence:'Saved pixels',priorities:[],anchors:[],truncations:[],uncertainties:[],regions:[],placement:{scale:1,left:0,top:0},reason:'Saved layout'})
  item.attempts.push({revision:1,plan,checks:[],needsOutpaint:false,outputId:'output'})
  item.status='technical-failed';item.failedStep='reviewing';item.errorCode='vision-failed'
  assert.equal(imageWorkflowPhase('downloading',item,'completed'),'completed')
  assert.equal(imageWorkflowPhase('planning',item,'completed'),'completed')
  assert.equal(imageWorkflowPhase('rendering',item,'completed'),'completed')
  assert.equal(imageWorkflowPhase('reviewing',item,'completed'),'failed')
  const old=item.attempts[0]!
  item.attempts.push({...old,revision:2});item.status='rendering';delete item.failedStep;delete item.errorCode
  assert.equal(imageWorkflowPhase('reviewing',item,'running',old),'queued')
  assert.equal(imageWorkflowPhase('planning',item,'running',old),'completed')
})

test('fixed presentation slots are batch-owned and independent from source identity',()=>{
  const ids=imageWorkflowStages.map(step=>fixedImageWorkflowNodeId('batch',step.stage))
  assert.equal(ids.length,7);assert.equal(new Set(ids).size,7)
  for(let image=0;image<100;image++)assert.deepEqual(imageWorkflowStages.map(step=>fixedImageWorkflowNodeId('batch',step.stage)),ids)
  assert(imageWorkflowStages.every(step=>fixedImageWorkflowNodeId('other-batch',step.stage)!==fixedImageWorkflowNodeId('batch',step.stage)))
})

test('clarity stage uses its own evidence and never fabricates a completed check for history',()=>{
  const item = wallpaperItemSchema.parse({imageVersionId:'image',familyId:'family',status:'passed'})
  assert.equal(imageWorkflowStagePhase('clarity',item,'completed'),'idle')
})

test('progressive image flows retain completed nodes, preview one next step and never run the final step during review',()=>{
  const item = wallpaperItemSchema.parse({imageVersionId:'source',familyId:'family',status:'downloading'})
  const stages = () => imageWorkflowWindow(item).map(step=>step.stage)
  assert.deepEqual(stages(),['original','planning'])
  assert.equal(imageWorkflowStagePhase('original',item,'running'),'running')
  assert.equal(imageWorkflowStagePhase('planning',item,'running'),'blocked')
  item.originalId='original';item.status='planning'
  assert.deepEqual(stages(),['original','planning','geometry'])
  const plan=wallpaperPlanSchema.parse({version:1,imageVersionId:'source',mode:'single',subject:'Vehicle',evidence:'Saved pixels',priorities:[],anchors:[],truncations:[],uncertainties:[],regions:[],placement:{scale:1,left:0,top:0},reason:'Saved layout'})
  item.attempts.push({revision:1,plan,checks:[],needsOutpaint:false,canvasId:'canvas',layoutAnalysisId:'geometry'});item.status='rendering'
  assert.deepEqual(stages(),['original','planning','geometry','rendering','clarity'])
  const attempt=item.attempts[0]!;attempt.outputId='output';attempt.simulationId='simulation';attempt.analysisId='review-overlay';item.status='reviewing'
  assert.deepEqual(stages(),['original','planning','geometry','rendering','reviewing','final'])
  assert.equal(imageWorkflowStagePhase('reviewing',item,'running'),'running')
  assert.equal(imageWorkflowStagePhase('final',item,'running'),'blocked')
  assert.equal(imageWorkflowArtifact('planning',item),'original');assert.equal(imageWorkflowArtifact('geometry',item),'geometry')
  assert.equal(imageWorkflowArtifact('rendering',item),'output');assert.equal(imageWorkflowArtifact('reviewing',item),'simulation')
  attempt.clarity={status:'not-needed',reason:'No enhancement needed'}
  assert.deepEqual(stages(),['original','planning','geometry','rendering','clarity','reviewing','final'])
})

test('review repair follows current pixels through red remake, yellow review and green acceptance without reusing earlier conclusions',()=>{
  const plan=wallpaperPlanSchema.parse({version:1,imageVersionId:'original',mode:'single',subject:'Motorcycle',evidence:'Original pixels',priorities:[],anchors:[],truncations:[],uncertainties:[],regions:[],placement:{scale:1,left:0,top:0},reason:'Safe placement'})
  const review=(failed=false)=>wallpaperReviewSchema.parse({subject:'Motorcycle',checks:Object.fromEntries(wallpaperReviewKeys.map(key=>[key,{result:failed&&key==='background'?'violated':'satisfied',reason:failed&&key==='background'?'Visible seam':'Observed pixels'}])),issues:failed?[{kind:'background',reason:'Visible seam'}]:[]})
  const item=wallpaperItemSchema.parse({imageVersionId:'source',originalId:'original',familyId:'family',status:'needs-review',attempts:[{revision:1,plan,checks:[],needsOutpaint:true,canvasId:'first-seed',outputId:'first-output',review:review(true)}]})
  const prior=item.attempts[0]!
  assert.deepEqual(imageWorkflowRework(item,'completed'),{stage:'rendering',phase:'attention',flowing:false})
  item.attempts.push({revision:2,plan,checks:[],needsOutpaint:true,canvasId:'second-seed',retryFrom:'reviewing',retryTarget:'rendering'})
  const current=item.attempts[1]!
  item.status='rendering'
  assert.deepEqual(imageWorkflowRework(item,'running'),{stage:'rendering',phase:'running',flowing:true})
  assert.deepEqual(imageWorkflowRework(item,'paused'),{stage:'rendering',phase:'paused',flowing:false})
  assert.equal(imageWorkflowStagePhase('reviewing',item,'running'),'blocked')
  current.outputId='second-output';current.simulationId='second-review';item.status='reviewing';item.reason='Visible seam in revision one'
  assert.deepEqual(imageWorkflowRework(item,'running'),{stage:'reviewing',phase:'running',flowing:true})
  assert.deepEqual(imageWorkflowRework(item,'completed'),{stage:'reviewing',phase:'queued',flowing:false})
  assert.deepEqual(imageWorkflowRework(item,'paused'),{stage:'reviewing',phase:'paused',flowing:false})
  assert.equal(imageWorkflowStagePhase('reviewing',item,'running'),'running')
  assert.equal(current.review,undefined)
  item.status='technical-failed';item.failedStep='reviewing';item.errorCode='vision-invalid-output'
  assert.deepEqual(imageWorkflowRework(item,'completed'),{stage:'reviewing',phase:'failed',flowing:false})
  assert.equal(imageWorkflowStagePhase('reviewing',item,'completed'),'failed')
  current.review=review(true);item.status='needs-review';delete item.failedStep;delete item.errorCode
  assert.deepEqual(imageWorkflowRework(item,'completed'),{stage:'rendering',phase:'attention',flowing:false})
  current.review=review();item.status='passed'
  assert.deepEqual(imageWorkflowRework(item,'completed'),{stage:'passed',phase:'completed',flowing:false})
  assert.equal(imageWorkflowStagePhase('reviewing',item,'completed'),'completed')
  assert.equal(prior.review!.checks.background.result,'violated')
  const initial=wallpaperItemSchema.parse({imageVersionId:'new-source',familyId:'new-family',status:'queued'})
  assert.equal(imageWorkflowRework(initial,'created'),undefined)
})

test('decision presentation is explicit, revision-scoped and never qualifies a saved image',()=>{
  const plan=wallpaperPlanSchema.parse({version:1,imageVersionId:'source',mode:'single',subject:'Vehicle',evidence:'Observed source',priorities:[],anchors:[],truncations:[],uncertainties:['A normal occlusion needs classification.'],regions:[],placement:{scale:1,left:0,top:0},reason:'Saved plan'})
  const item=wallpaperItemSchema.parse({imageVersionId:'source',originalId:'original',familyId:'family',status:'needs-review',attempts:[{revision:1,plan,checks:['uncertain-subject'],needsOutpaint:false}]})
  const snapshot=JSON.stringify(item)
  assert(wallpaperCanDecide(item));assert(imageWorkflowWindow(item).some(step=>step.stage==='decision'))
  assert.equal(imageWorkflowStagePhase('decision',item,'completed'),'attention');assert.equal(item.decisions,undefined)
  assert.equal(JSON.stringify(item),snapshot)
  const record=wallpaperDecisionRecordSchema.parse({id:'decision-1',version:'wallpaper-decision-v1',inputDigest:'a'.repeat(64),evidenceDigest:'b'.repeat(64),planRevision:1,round:1,status:'running',reason:'Checking actual source evidence.'})
  item.decisions=[record];item.status='planning'
  assert.deepEqual(imageWorkflowWindow(item).filter(step=>imageWorkflowStagePhase(step.stage,item,'running')==='running').map(step=>step.stage),['decision'])
  assert.equal(imageWorkflowStagePhase('planning',item,'running'),'attention')
  item.failedStep='planning';item.errorCode='vision-invalid-output';assert.equal(imageWorkflowStagePhase('planning',item,'running'),'attention');delete item.failedStep;delete item.errorCode
  assert.equal(imageWorkflowWindow(item).some(step=>step.stage==='rendering'),false)
  record.targetStage='rendering';assert.equal(imageWorkflowWindow(item).some(step=>step.stage==='rendering'),true);delete record.targetStage
  assert.equal(imageWorkflowStagePhase('decision',item,'running'),'running');assert.equal(imageWorkflowStagePhase('decision',item,'paused'),'paused');assert.equal(wallpaperCanDecide(item),false)
  assert.equal(wallpaperPendingDecision(item),record)
  assert.equal(wallpaperCanDecide(item,item.attempts[0],'completed'),true)
  assert.equal(wallpaperCanDecide(item,item.attempts[0],'running'),false)
  assert.equal(imageWorkflowStagePhase('decision',item,'completed'),'attention')
  const inactive=wallpaperProgress(wallpaperStateSchema.parse({version:1,sourceRunId:'root',skillVersion:'fixture',items:[item],budgetStopped:false}),undefined,'completed')
  assert.equal(inactive.planning,0);assert.equal(inactive.attention,1)
  const parked=wallpaperImageWorkStatus({status:'running',workImageVersionId:'another-image'},item.imageVersionId)
  assert.equal(parked,'paused');assert.equal(imageWorkflowStagePhase('decision',item,parked),'paused')
  assert.equal(record.status,'running');assert.equal(record.round,1)
  const cancelled=wallpaperViewSchema.parse({runId:'cancelled-run',sourceRunId:'root',status:'cancelled',settings:{},state:{version:1,sourceRunId:'root',skillVersion:'fixture',items:[item],budgetStopped:false},resources:{},sourceImages:{},total:1,offset:0,counts:{},warnings:[]})
  const preserved=JSON.stringify(item)
  assert.equal(imageWorkflowStagePhase('decision',item,'cancelled'),'cancelled')
  assert.equal(imageWorkflowStagePhase('geometry',item,'cancelled'),'cancelled')
  assert.equal(wallpaperCanDecide(item,item.attempts[0],'cancelled'),false)
  assert.deepEqual(wallpaperRecovery(cancelled,item,item.attempts[0]),{kind:'none'})
  assert.equal(wallpaperProgress(cancelled.state,undefined,'cancelled').attention,0)
  assert.equal(JSON.stringify(item),preserved)
  record.status='applied';record.targetStage='rendering';record.targetRevision=2
  item.attempts.push({...item.attempts[0]!,revision:2,checks:[]});item.status='rendering'
  assert.equal(imageWorkflowDecisionRecord(item),record);assert.equal(imageWorkflowDecisionRecord(item,item.attempts[0]),record)
  assert.equal(imageWorkflowStagePhase('decision',item,'running'),'completed');assert.equal(item.status,'rendering');assert.equal(item.attempts[1]!.review,undefined)
  item.status='planning'
  for(const status of ['manual','skipped','failed'] as const){record.status=status;assert.equal(imageWorkflowStagePhase('decision',item,'completed'),status==='failed'?'failed':'attention');assert.deepEqual(imageWorkflowWindow(item).filter(step=>imageWorkflowStagePhase(step.stage,item,'running')==='running'),[])}
  record.status='applied';item.status='needs-review';item.reason='decision-round-limit'
  assert.equal(imageWorkflowStagePhase('decision',item,'running'),'attention');assert.equal(imageWorkflowWindow(item).some(step=>step.stage==='rendering'),false)
  delete item.reason
  item.attempts.push({...item.attempts[1]!,revision:3});assert.equal(imageWorkflowDecisionRecord(item),undefined)
  item.status='rejected';assert.equal(wallpaperCanDecide(item),false)
  item.status='passed';assert.equal(wallpaperCanDecide(item),false)
  const missing=wallpaperItemSchema.parse({imageVersionId:'missing',familyId:'family',status:'technical-failed'});assert.equal(wallpaperCanDecide(missing),false)
})

test('manual and automated detail inspections show the current request and its actual incoming edge', () => {
  const plan = wallpaperPlanSchema.parse({ version: 1, imageVersionId: 'source', mode: 'single', subject: 'Bottle', evidence: 'Saved original', priorities: [], anchors: [], truncations: [], uncertainties: ['Check the label'], regions: [], placement: { scale: 1, left: 0, top: 0 }, reason: 'Inspect detail' })
  const item = wallpaperItemSchema.parse({ imageVersionId: 'source', originalId: 'source', familyId: 'family', status: 'planning', attempts: [{ revision: 1, plan, checks: ['uncertain-subject'], needsOutpaint: true }], decisions: [{ id: 'decision', version: 'wallpaper-decision-v1', inputDigest: 'a'.repeat(64), evidenceDigest: 'b'.repeat(64), planRevision: 1, round: 2, status: 'failed', reason: 'Earlier failed decision' }], detailInspection: { origin: 'manual', status: 'running', planRevision: 1, requestId: 'manual-detail', decisionRoundAtStart: 2 } })
  const stages = () => imageWorkflowWindow(item).map(step => step.stage)
  const connections = () => imageWorkflowConnections(stages(), item)
  const inspection = item.detailInspection!
  assert.deepEqual(stages(), ['original', 'planning', 'geometry', 'detail'])
  assert.deepEqual(stages().filter(stage => imageWorkflowStagePhase(stage, item, 'running') === 'running'), ['detail'])
  assert.equal(imageWorkflowStagePhase('detail', item, 'interrupted'), 'paused')
  inspection.status = 'failed'
  item.status = 'technical-failed'
  item.failedStep = 'planning'
  item.errorCode = 'vision-invalid-output'
  assert.equal(imageWorkflowStagePhase('detail', item, 'completed'), 'failed')
  assert.equal(stages().includes('decision'), false)
  assert.deepEqual(wallpaperRecovery(wallpaperViewSchema.parse({ runId: 'manual', sourceRunId: 'root', status: 'completed', settings: {}, state: { version: 2, sourceRunId: 'root', skillVersion: 'v1', items: [item], budgetStopped: false }, total: 1, offset: 0, resources: {}, sourceImages: {}, warnings: [], counts: {} }), item, item.attempts[0]), { kind: 'reinspect' })
  inspection.origin = 'decision'
  inspection.decisionId = 'decision'
  inspection.status = 'queued'
  const decision = item.decisions![0]!
  decision.status = 'applied'
  decision.targetStage = 'detail'
  assert.deepEqual(stages().slice(-2), ['decision', 'detail'])
  assert.deepEqual(connections().slice(-2), [{ source: 'geometry', target: 'decision' }, { source: 'decision', target: 'detail' }])
  decision.status = 'failed'
  item.reason = 'decision-round-limit'
  assert.equal(imageWorkflowStagePhase('decision', item, 'running'), 'failed')
  assert.deepEqual(connections().at(-1), { source: 'decision', target: 'detail' })
  inspection.status = 'unresolved'
  assert.equal(imageWorkflowStagePhase('detail', item, 'completed'), 'attention')
  inspection.status = 'resolved'
  assert.equal(imageWorkflowStagePhase('detail', item, 'completed'), 'completed')
  delete item.detailInspection
  item.attempts[0]!.detailAnalysis = { version: 'wallpaper-plan-detail-v2', outcome: 'resolved', requestId: 'legacy' }
  assert.equal(imageWorkflowStagePhase('detail', item, 'completed'), 'completed')
})

test('receipt and saved review recovery keep priority over manual decisions',()=>{
  const plan=wallpaperPlanSchema.parse({version:1,imageVersionId:'original',mode:'single',subject:'Vehicle',evidence:'Observed pixels',priorities:[],anchors:[],truncations:[],uncertainties:[],regions:[],placement:{scale:1,left:0,top:0},reason:'Saved plan'})
  const item=wallpaperItemSchema.parse({imageVersionId:'source',originalId:'original',familyId:'family',status:'technical-failed',failedStep:'reviewing',errorCode:'vision-invalid-output',attempts:[{revision:1,plan,checks:[],needsOutpaint:false,outputId:'saved-output'}]})
  assert.equal(wallpaperCanDecide(item),false)
  item.status='needs-review';assert.equal(wallpaperCanDecide(item),false)
  delete item.attempts[0]!.outputId;item.attempts[0]!.generation={id:'operation',provider:'provider',model:'image',taskId:'task'}
  assert.equal(wallpaperCanDecide(item),false)
})
