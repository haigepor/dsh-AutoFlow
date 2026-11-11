import assert from 'node:assert/strict'
import test from 'node:test'
import { searchBatchSchema } from '../src/shared/search-batches.ts'
import { modelProfileSchema } from '../src/shared/model.ts'
import { preferredWorkflowBatch, workflowWallpaperPhase, workflowBatchPhase, workflowReferencePhase, workflowLaunchPhase, workflowSearchStage } from '../src/client/workflow-current-task.ts'
import { wallpaperStage } from '../src/client/workflow-node-state.ts'
import { wallpaperProgress, wallpaperReviewKeys, wallpaperStateSchema } from '../src/shared/wallpaper.ts'
const batch = (runId: string, status: string, extras = {}) => searchBatchSchema.parse({ runId, status, kind: 'search', createdAt: '2026-11-07T00:00:00Z', taskBrief: 'Find scenes', matched: 0, unavailable: false, images: [], ...extras })
test('active work takes precedence over settled history without changing history order', () => {
 const done = batch('latest', 'completed'), active = batch('active', 'running'), history = [done, active]
 assert.equal(preferredWorkflowBatch(history, ''), active)
 assert.deepEqual(history.map(item => item.runId), ['latest', 'active'])
})
test('explicit task and launch choices retain historical failures', () => {
 const failed = batch('failed', 'failed', { launchId: 'original-launch' }), active = batch('active', 'running')
 assert.equal(preferredWorkflowBatch([active, failed], 'failed'), failed)
 assert.equal(preferredWorkflowBatch([active, failed], 'original-launch'), failed)
})
test('active wallpaper stays current after its source search completes', () => {
 const wallpaper = batch('source', 'completed', { wallpaper: { runId: 'wallpaper', status: 'running', total: 3, planned: 0, rendered: 0, reviewed: 0, passed: 0, attention: 0, budgetStopped: false } })
 assert.equal(preferredWorkflowBatch([batch('latest', 'completed'), wallpaper], ''), wallpaper)
 assert.equal(preferredWorkflowBatch([], ''), undefined)
})

test('a settled wallpaper Run does not report success for failed or missing outputs', () => {
 const summary = { runId: batch('wallpaper', 'completed').runId, status: 'completed' as const, total: 10, planned: 0, rendered: 0, reviewed: 0, passed: 0, attention: 10, budgetStopped: false }
 assert.equal(workflowWallpaperPhase({ ...summary, counts: { downloadingFailed: 4 } }), 'failed')
 assert.equal(workflowWallpaperPhase(summary), 'attention')
 assert.equal(workflowWallpaperPhase({ ...summary, passed: 10, attention: 0 }), 'completed')
 assert.equal(workflowWallpaperPhase({ ...summary, status: 'cancelled' }), 'cancelled')
})

test('unknown final checks retain attention while explicit violations retain failure', () => {
 const state = wallpaperStateSchema.parse({ version: 1, sourceRunId: 'source', skillVersion: 'skill', items: [{ imageVersionId: 'source-image', originalId: 'original-image', familyId: 'family', status: 'needs-review', attempts: [{ revision: 1, plan: { version: 1, imageVersionId: 'original-image', mode: 'single', subject: 'Car', evidence: 'The car is visible.', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [], placement: { scale: 1, left: 0, top: 0 }, reason: 'Keep the original subject.' }, checks: [], needsOutpaint: false, outputId: 'output', review: { subject: 'Car', checks: Object.fromEntries(wallpaperReviewKeys.map(key => [key, { result: key === 'style' ? 'unknown' : 'satisfied', reason: 'Saved visual evidence.' }])), issues: [] } }] }] })
 const summary = { runId: batch('wallpaper', 'completed').runId, status: 'completed' as const, total: 1, planned: 1, rendered: 1, reviewed: 1, passed: 0, attention: 1, budgetStopped: false }
 const uncertain = wallpaperProgress(state)
 assert.equal(wallpaperStage('reviewing', 'completed', 1, uncertain).phase, 'attention')
 assert.equal(workflowWallpaperPhase({ ...summary, counts: uncertain }), 'attention')
 assert.equal(uncertain.reviewingFailed, 0)
 assert.equal(uncertain.reviewingAttention, 1)
 state.items[0]!.attempts[0]!.review!.checks.style.result = 'violated'
 const rejected = wallpaperProgress(state)
 assert.equal(wallpaperStage('reviewing', 'completed', 1, rejected).phase, 'failed')
 assert.equal(workflowWallpaperPhase({ ...summary, counts: rejected }), 'failed')
 assert.equal(rejected.reviewingFailed, 1)
})

test('selected workflow status retains downstream failure, cancellation and partial completion', () => {
 const source = batch('source', 'completed', { matched: 10, targetCount: 10 })
 const wallpaper = { runId: source.runId, status: 'failed' as const, total: 10, planned: 4, rendered: 4, reviewed: 4, passed: 4, attention: 6, budgetStopped: false }
 assert.equal(workflowBatchPhase({ ...source, wallpaper }), 'failed')
 assert.equal(workflowBatchPhase({ ...source, wallpaper: { ...wallpaper, status: 'cancelled' } }), 'cancelled')
 assert.equal(workflowBatchPhase({ ...source, wallpaper: { ...wallpaper, status: 'completed' } }), 'attention')
 assert.equal(workflowBatchPhase({ ...source, matched: 4 }), 'attention')
 assert.equal(workflowBatchPhase({ ...source, wallpaperRequested: true }), 'queued')
 assert.equal(workflowBatchPhase({ ...source, status: 'cancelled', postProcessingError: 'handoff-failed' }), 'cancelled')
 assert.equal(workflowBatchPhase(source), 'completed')
})

test('pending historical references retain saved dataset evidence during a different collection analysis', () => {
 const historical = { modelProfileId: modelProfileSchema.shape.id.parse('frozen-profile'), status: 'completed' as const }
 assert.equal(workflowReferencePhase('failed', 'frozen-profile', 'current-profile', historical), 'completed')
 assert.equal(workflowReferencePhase('running', 'frozen-profile', 'current-profile', historical), 'completed')
 assert.equal(workflowReferencePhase('failed', 'frozen-profile', 'current-profile', undefined), 'queued')
 assert.equal(workflowReferencePhase('failed', 'frozen-profile', 'current-profile', { ...historical, modelProfileId: modelProfileSchema.shape.id.parse('different-profile') }), 'queued')
 assert.equal(workflowReferencePhase('running', 'current-profile', 'current-profile', historical), 'running')
})

test('accepted conversation preparation remains distinct from committed search stages', () => {
 assert.equal(workflowLaunchPhase({status:'accepted'}),'running')
 assert.equal(workflowLaunchPhase({status:'accepted',runStatus:'paused'}),'paused')
 assert.equal(workflowSearchStage(batch('waiting','running')),undefined)
 for(const [stage,key] of [['planning','workflowSearchPreparing'],['retrieving','taskStageRetrieving'],['screening','taskStageScreening'],['reviewing','taskStageReviewing'],['finalizing','workflowSearchFinalizing']]) {
  assert.equal(workflowSearchStage(batch('active','running',{progress:{stage,counts:{qualified:0},requests:1}})),key)
 }
 assert.equal(workflowSearchStage(batch('done','completed',{progress:{stage:'reviewing',counts:{},requests:0}})),undefined)
})
