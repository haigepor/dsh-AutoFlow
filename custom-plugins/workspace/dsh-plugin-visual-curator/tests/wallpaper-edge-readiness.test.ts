/** Actual mixed Desktop evidence must progress without erasing unknowns or relaxing final acceptance. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { wallpaperPlanConcerns, wallpaperPlanDetailOutputSchema, resolveWallpaperPlanDetail } from '../src/shared/wallpaper-detail.ts'
import { wallpaperDecisionOutputSchema } from '../src/shared/wallpaper-decision.ts'
import { wallpaperPlanSchema, wallpaperSettingsSchema, wallpaperEdgeRepairAuthorized, wallpaperReworkCount, type WallpaperItem } from '../src/shared/wallpaper.ts'
import { fitWallpaperPlacement, wallpaperGeometry } from '../src/shared/wallpaper-geometry.ts'
import { realWallpaperEdgeEvidence as saved, realWallpaperEdgeDetail } from './helpers/wallpaper-edge-real.ts'

const concerns = wallpaperPlanConcerns(saved.plan), ids = saved.nativeDetails.map(view => view.imageVersionId)
const schema = wallpaperPlanDetailOutputSchema(saved.source.imageVersionId, concerns, ids, 'wallpaper-plan-detail-v5', saved.nativeDetails)
const settings = wallpaperSettingsSchema.parse({ sourceFrameRepair: {} })

test('Desktop V5 evidence accepts overlapping localization of the same frame edge without broadening the repair', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/wallpaper-detail-desktop-v5.json', import.meta.url), 'utf8'))
  const prior = wallpaperPlanSchema.parse(fixture.priorPlan)
  const parse = wallpaperPlanDetailOutputSchema(prior.imageVersionId, fixture.concerns, fixture.nativeDetails.map((view: { imageVersionId: string }) => view.imageVersionId), 'wallpaper-plan-detail-v5', fixture.nativeDetails)
  const detail = parse.parse(fixture.output)
  assert.deepEqual(fixture.originalIssues, ['custom:edgeRepair:edge-repair-finding-target-mismatch'])
  assert.equal(resolveWallpaperPlanDetail(prior, detail, true).outcome, 'ready-for-edit')
  if (detail.version !== 'wallpaper-plan-detail-v5') throw new Error('Expected V5 response')
  assert.deepEqual(detail.edgeRepair.sourceRegion, { x: 0, y: 0.74, width: 0.18, height: 0.23 })
  assert.equal(detail.protectedSubjectExtent.extent, 'cut-off')
  assert.equal(detail.retainedUncertainties.length, 3)
  const disjoint = { ...fixture.output, findings: fixture.output.findings.map((finding: { concernId: string }) => finding.concernId === 'source-extent' ? { ...finding, sourceRegion: { x: 0, y: 0.3, width: 0.2, height: 0.1 } } : finding) }
  assert.equal(parse.safeParse(disjoint).success, false)
  const interior = { ...fixture.output, findings: fixture.output.findings.map((finding: { concernId: string }) => finding.concernId === 'source-extent' ? { ...finding, sourceRegion: { x: 0.05, y: 0.74, width: 0.1, height: 0.2 } } : finding) }
  assert.equal(parse.safeParse(interior).success, false)
})

test('mixed Desktop concerns keep resolved repairs separate from retained unseen facts', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/wallpaper-detail-desktop-mixed-v5.json', import.meta.url), 'utf8'))
  const prior = wallpaperPlanSchema.parse(fixture.priorPlan)
  const parse = wallpaperPlanDetailOutputSchema(prior.imageVersionId, fixture.concerns, fixture.nativeDetails.map((view: { imageVersionId: string }) => view.imageVersionId), 'wallpaper-plan-detail-v5', fixture.nativeDetails)
  const rejected = parse.safeParse(fixture.output)
  assert.equal(rejected.success, false, 'A resolved finding cannot also authorize retention of an unseen fact')
  if (!rejected.success) assert.deepEqual(rejected.error.issues.map(issue => `custom:${issue.path.join('.')}:${issue.message}`), fixture.originalIssues)
  const output = structuredClone(fixture.output)
  const uncertaintyIndex = output.observation.uncertainties.indexOf(output.retainedUncertainties.find((entry: { concernId: string }) => entry.concernId === 'uncertainty:1').text)
  const concernId = `observation:${uncertaintyIndex}`
  const repairFinding = output.findings.find((finding: { concernId: string }) => finding.concernId === 'uncertainty:1')
  output.findings.push({ ...repairFinding, concernId, result: 'unresolved', classification: 'unseen-detail', reason: 'The exact off-frame extent and any hidden plants remain unseen and must not be reconstructed.' })
  output.retainedUncertainties.find((entry: { concernId: string }) => entry.concernId === 'uncertainty:1').concernId = concernId
  const detail = parse.parse(output)
  const resolved = resolveWallpaperPlanDetail(prior, detail, true)
  assert.equal(resolved.outcome, 'ready-for-edit')
  assert.deepEqual(resolved.retainedUncertainties.map(entry => entry.text), fixture.output.observation.uncertainties)
  if (detail.version !== 'wallpaper-plan-detail-v5') throw new Error('Expected V5 response')
  assert.equal(detail.protectedSubjectExtent.extent, 'cut-off')
  assert.deepEqual(detail.edgeRepair, fixture.output.edgeRepair)
  const visibleAmbiguity = { ...output, findings: output.findings.map((finding: { concernId: string }) => finding.concernId === concernId ? { ...finding, classification: 'observation-limit', blocking: true } : finding) }
  assert.equal(parse.safeParse(visibleAmbiguity).success, false, 'Retained unknowns cannot conceal missing visible evidence')
  const actual = fixture.acceptedEvidence
  const actualSchema = wallpaperPlanDetailOutputSchema(prior.imageVersionId, fixture.concerns, actual.nativeDetails.map((view: { imageVersionId: string }) => view.imageVersionId), 'wallpaper-plan-detail-v5', actual.nativeDetails)
  const actualDetail = actualSchema.parse(actual.output)
  const actualResolution = resolveWallpaperPlanDetail(prior, actualDetail, true)
  assert.equal(actualResolution.outcome, 'ready-for-edit')
  assert.deepEqual(actualResolution.retainedUncertainties.map(entry => entry.text), actual.output.observation.uncertainties)
  assert.equal(actual.output.protectedSubjectExtent.extent, 'cut-off')
  assert.deepEqual(actual.output.edgeRepair.edges, ['left'])
})

function readyAttempt(): WallpaperItem['attempts'][number] {
  const detail = schema.parse(realWallpaperEdgeDetail()), result = resolveWallpaperPlanDetail(saved.plan, detail, true)
  if (detail.version !== 'wallpaper-plan-detail-v5') throw new Error('Expected current evidence.')
  const plan = wallpaperPlanSchema.parse({ ...result.observation, placement: fitWallpaperPlacement({ width: 941, height: 1672 }, result.observation, settings, 'subject-first-v2', detail.edgeRepair.edges) })
  return { revision: 2, plan, checks: wallpaperGeometry({ width: 941, height: 1672 }, plan, settings).checks, needsOutpaint: true,
    detailAnalysis: { version: detail.version, requestId: 'isolated-native-inspection', outcome: result.outcome, protectedSubjectExtent: detail.protectedSubjectExtent.extent, edgeRepair: detail.edgeRepair, concerns: [...concerns, { id: 'observation:1', text: detail.observation.uncertainties[1]! }], findings: detail.findings, retainedUncertainties: result.retainedUncertainties }, retryFrom: 'planning', retryTarget: 'planning' }
}

test('the actual V4 response reproduces the hold and the saved V1 response retains both semantic failures', () => {
  const detail = wallpaperPlanDetailOutputSchema(saved.source.imageVersionId, concerns, ids, 'wallpaper-plan-detail-v4').parse(saved.detail)
  assert.equal(resolveWallpaperPlanDetail(saved.plan, detail, true).outcome, 'unresolved')
  assert.equal(detail.findings.filter(finding => finding.result === 'unresolved').length, 3)
  const decision = wallpaperDecisionOutputSchema(saved.source.imageVersionId, 1, saved.decisionInput.concerns, ['continue_current_plan'], saved.decisionInput.images, saved.decisionInput.context).safeParse(saved.decision)
  assert.equal(decision.success, false)
  if (!decision.success) for (const message of ['decision-complete-source-required', 'decision-blocking-findings']) assert.ok(decision.error.issues.some(issue => issue.message === message))
  assert.deepEqual(saved.decisionIssues, ['custom:sourceExtent:decision-complete-source-required', 'custom:action:decision-blocking-findings'])
  assert.throws(() => JSON.parse(saved.malformedDecision), SyntaxError, 'Malformed output remains invalid; no appended braces or automatic execution')
})

test('native readiness retains every unknown and the cut-off fact, reserves only the subject left edge, and keeps all safety checks', () => {
  const response = realWallpaperEdgeDetail(), detail = schema.parse(response), result = resolveWallpaperPlanDetail(saved.plan, detail, true), attempt = readyAttempt()
  assert.equal(result.outcome, 'ready-for-edit'); assert.equal(attempt.detailAnalysis?.protectedSubjectExtent, 'cut-off')
  assert.deepEqual(result.retainedUncertainties.map(entry => entry.text), response.observation.uncertainties)
  assert.equal(attempt.detailAnalysis?.findings?.filter(finding => finding.result === 'unresolved').length, 4)
  assert.deepEqual(result.observation.uncertainties, [])
  assert.deepEqual(attempt.detailAnalysis?.edgeRepair?.edges, ['left'])
  for (const region of saved.plan.regions) assert.ok(attempt.plan.regions.some(actual => actual.name === region.name && actual.rect.x <= region.rect.x && actual.rect.y <= region.rect.y && actual.rect.x + actual.rect.width >= region.rect.x + region.rect.width && actual.rect.y + actual.rect.height >= region.rect.y + region.rect.height))
  assert.deepEqual(attempt.checks, []); assert.equal(attempt.plan.placement.scale, 1)
  assert.deepEqual(settings.safe, { left: 258, top: 1032, width: 1329, height: 1686 })
  assert.equal(wallpaperEdgeRepairAuthorized(attempt, settings), true)
  assert.equal(wallpaperEdgeRepairAuthorized(attempt, { ...settings, sourceFrameRepair: { enabled: false, marginPixels: 128 } }), false)
  assert.notEqual(resolveWallpaperPlanDetail(saved.plan, detail, false).outcome, 'ready-for-edit')
  assert.ok(saved.plan.uncertainties.length > 0, 'The saved original response is not rewritten')
  const item: WallpaperItem = { imageVersionId: saved.source.imageVersionId, originalId: saved.source.imageVersionId, familyId: 'fixture', status: 'rendering', edits: 0, attempts: [{ ...attempt, revision: 1 }, attempt] }
  assert.equal(wallpaperReworkCount(item), 0, 'Planning evidence does not consume an image edit')
  assert.equal(attempt.outputId, undefined); assert.equal(attempt.review, undefined)
})

test('visible ambiguity, identity-critical absence and unclassified new uncertainty remain blocked', () => {
  const original = realWallpaperEdgeDetail()
  const ambiguous = { ...original, findings: original.findings.map(finding => finding.concernId === 'uncertainty:0' ? { ...finding, classification: 'observation-limit', blocking: true } : finding) }
  assert.equal(resolveWallpaperPlanDetail(saved.plan, schema.parse(ambiguous), true).outcome, 'unresolved')
  const identity = realWallpaperEdgeDetail()
  const value = { ...identity, edgeRepair: { ...identity.edgeRepair, classification: 'identity-critical' }, findings: identity.findings.map(finding => finding.concernId === 'source-extent' ? { ...finding, result: 'violated', classification: 'frame-truncation', blocking: true } : finding) }
  assert.equal(resolveWallpaperPlanDetail(saved.plan, schema.parse(value), true).outcome, 'violated')
  const missing = realWallpaperEdgeDetail()
  missing.retainedUncertainties.pop()
  assert.equal(resolveWallpaperPlanDetail(saved.plan, schema.parse(missing), true).outcome, 'unresolved')
  const impossible = realWallpaperEdgeDetail()
  const badFinding = { ...impossible.findings[0]!, classification: 'observation-limit', blocking: false }
  assert.equal(schema.safeParse({ ...impossible, findings: [badFinding, ...impossible.findings.slice(1)] }).success, false)
})

test('repair authorization requires actual covering native evidence and the subject frame edge', () => {
  const value = realWallpaperEdgeDetail()
  assert.equal(wallpaperPlanDetailOutputSchema(saved.source.imageVersionId, concerns, ids, 'wallpaper-plan-detail-v5').safeParse(value).success, false)
  assert.equal(schema.safeParse({ ...value, edgeRepair: { ...value.edgeRepair, evidenceImageVersionIds: ['foreign-native-image'] } }).success, false)
  assert.equal(schema.safeParse({ ...value, edgeRepair: { ...value.edgeRepair, sourceRegion: { x: 0.1, y: 0.69, width: 0.14, height: 0.21 } } }).success, false)
  assert.equal(schema.safeParse({ ...value, edgeRepair: { ...value.edgeRepair, edges: ['left', 'bottom'] } }).success, false, 'Background bottom truncation grants no subject-bottom repair')
  assert.equal(schema.safeParse({ ...value, findings: value.findings.map(finding => finding.concernId === 'source-extent' ? { ...finding, evidenceImageVersionIds: [saved.source.imageVersionId] } : finding) }).success, false)
})

test('V2 routing uses saved readiness, retains Host scopes and rejects conflicting or self-authorized continuation', () => {
  const attempt = readyAttempt(), detail = attempt.detailAnalysis!
  const context = { mode: attempt.plan.mode, hasProtectedSubject: true, editEvidence: { outcome: detail.outcome, sourceExtent: detail.protectedSubjectExtent!, edgeRepair: detail.edgeRepair, findings: detail.findings!.map(({ result: _result, ...finding }) => finding) } }
  const classifiedConcerns = detail.concerns!.map(concern => ({ ...concern, scope: detail.findings!.find(finding => finding.concernId === concern.id)!.scope }))
  const response = { version: 'wallpaper-decision-v2', imageVersionId: saved.source.imageVersionId, planRevision: 2, findings: context.editEvidence.findings, sourceExtent: { extent: 'cut-off', reason: 'Saved native source edge remains cut off.' }, action: { kind: 'continue_current_plan' }, reason: 'Edit only the localized left continuation; retained unknowns are not reconstructed.' }
  const parse = wallpaperDecisionOutputSchema(saved.source.imageVersionId, 2, classifiedConcerns, ['continue_current_plan', 'manual_review'], [saved.source.imageVersionId, ...ids], context, 'wallpaper-decision-v2')
  assert.ok(parse.safeParse(response).success)
  assert.equal(parse.safeParse({ ...response, sourceExtent: { ...response.sourceExtent, extent: 'complete' } }).success, false)
  assert.equal(parse.safeParse({ ...response, findings: response.findings.map(finding => finding.concernId === 'source-extent' ? { ...finding, blocking: true } : finding) }).success, false)
  const noAuthorization = wallpaperDecisionOutputSchema(saved.source.imageVersionId, 2, classifiedConcerns, ['continue_current_plan'], [saved.source.imageVersionId, ...ids], { mode: attempt.plan.mode, hasProtectedSubject: true }, 'wallpaper-decision-v2')
  assert.equal(noAuthorization.safeParse(response).success, false)
  const changedScope = parse.parse({ ...response, findings: response.findings.map(finding => ({ ...finding, scope: 'background' })) })
  assert.equal(changedScope.findings.find(finding => finding.concernId === 'source-extent')?.scope, 'critical')
  const blocked = wallpaperDecisionOutputSchema(saved.source.imageVersionId, 2, classifiedConcerns, ['continue_current_plan'], [saved.source.imageVersionId, ...ids], { ...context, editEvidence: { ...context.editEvidence, outcome: 'unresolved' } }, 'wallpaper-decision-v2')
  assert.equal(blocked.safeParse(response).success, false)
})
