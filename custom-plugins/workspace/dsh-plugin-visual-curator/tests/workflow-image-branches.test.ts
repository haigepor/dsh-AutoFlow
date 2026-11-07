import assert from 'node:assert/strict'
import {test} from 'node:test'
import {planningImagesPerPage,planningWindowStart,planningImageNodeId,planningImageLane,planningImagePhase,imageWorkflowNodeId,imageWorkflowPhase,imageNavigationPageSize,imageWorkflowStages,fixedImageWorkflowNodeId} from '../src/client/workflow-image-branches.ts'
import {wallpaperItemSchema,wallpaperPlanSchema} from '../src/shared/wallpaper.ts'

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
  assert.equal(ids.length,6);assert.equal(new Set(ids).size,6)
  for(let image=0;image<100;image++)assert.deepEqual(imageWorkflowStages.map(step=>fixedImageWorkflowNodeId('batch',step.stage)),ids)
  assert(imageWorkflowStages.every(step=>fixedImageWorkflowNodeId('other-batch',step.stage)!==fixedImageWorkflowNodeId('batch',step.stage)))
})
