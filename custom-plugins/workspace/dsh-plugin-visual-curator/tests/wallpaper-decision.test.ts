import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { wallpaperDecisionActionKinds, wallpaperDecisionActionSchema, wallpaperDecisionOutputSchema, wallpaperDecisionRecordSchema, wallpaperDecisionResponseSchema, wallpaperDecisionSettingsSchema } from '../src/shared/wallpaper-decision.ts'
import type { WallpaperDecisionAction, WallpaperDecisionResponse } from '../src/shared/wallpaper-decision.ts'
import { wallpaperAttemptSchema, wallpaperItemSchema, wallpaperPlanSchema, wallpaperPromptBundleSchema, wallpaperSettingsSchema, wallpaperWorkImage } from '../src/shared/wallpaper.ts'
import { sourceFaithfulWallpaperPrompts, wallpaperDecisionPrompt, wallpaperPromptBundle, wallpaperPrompts } from '../src/shared/wallpaper-prompts.ts'

const concerns = [{ id: 'wheel-occlusion', text: 'Distinguish normal rear-wheel self-occlusion from frame truncation.' }, { id: 'background-tree', text: 'Determine whether the distant tree touching the image edge blocks this task.' }]
const response: WallpaperDecisionResponse = {
  version: 'wallpaper-decision-v1', imageVersionId: 'source', planRevision: 2,
  findings: [
    { concernId: 'wheel-occlusion', scope: 'subject', classification: 'normal-occlusion', blocking: false, reason: 'The visible wheel contour is complete; the vehicle normally hides its far side.', evidenceImageVersionIds: ['source', 'wheel-detail'] },
    { concernId: 'background-tree', scope: 'background', classification: 'background-crop', blocking: false, reason: 'The distant tree is ordinary background framing, not a protected subject.', evidenceImageVersionIds: ['source'] },
  ],
  sourceExtent: { extent: 'complete', reason: 'Every contour expected from this view remains in the source frame.' }, action: { kind: 'continue_current_plan' }, reason: 'Continue the unchanged plan and retain independent final review.',
}
const images = ['source', 'wheel-detail', 'sign-detail']
const parse = () => wallpaperDecisionOutputSchema('source', 2, concerns, ['continue_current_plan', 'inspect_region', 'replan', 'manual_review'], images)

test('new decision limits are bounded while legacy settings, prompts and image histories receive no defaults', () => {
  assert.deepEqual(wallpaperDecisionSettingsSchema.parse({}), { version: 'wallpaper-decision-v1', enabled: true, maxRoundsPerImage: 2, maxDetailRequests: 1 })
  assert.equal(wallpaperDecisionSettingsSchema.parse({ enabled: false, maxDetailRequests: 0 }).enabled, false)
  assert.equal(wallpaperSettingsSchema.parse({}).decision, undefined)
  assert.equal(wallpaperItemSchema.parse({ imageVersionId: 'source', familyId: 'family', status: 'queued' }).decisions, undefined)
  assert.equal(wallpaperSettingsSchema.parse({ decision: {} }).decision?.maxRoundsPerImage, 2)
  assert.equal(wallpaperPromptBundle().decision?.version, 'wallpaper-decision-v1')
  assert.equal(sourceFaithfulWallpaperPrompts().decision?.version, 'wallpaper-decision-v1')
  assert.equal(wallpaperPrompts['wallpaper-decision'], wallpaperDecisionPrompt.text)
  assert.equal(wallpaperWorkImage({ continuationKind: 'decision', decidedImageId: 'source', retryImageId: 'other' }), 'source')
  assert.equal(wallpaperWorkImage({ continuationKind: 'decision' }), undefined)
  for (const version of ['wallpaper-plan-v1', 'wallpaper-plan-v2', 'wallpaper-plan-v3', 'wallpaper-plan-v4', 'wallpaper-plan-v5'] as const) {
    const old = wallpaperPromptBundle('wallpaper-review-v1', version)
    assert.equal(old.decision, undefined)
    assert.equal(wallpaperPromptBundleSchema.parse(old).decision, undefined)
  }
  for (const input of [{ maxRoundsPerImage: 0 }, { maxRoundsPerImage: 5 }, { maxDetailRequests: -1 }, { maxDetailRequests: 3 }, { reasoningEffort: '' }, { reasoningEffort: 'a'.repeat(129) }, { model: 'change-global-model' }]) assert.equal(wallpaperDecisionSettingsSchema.safeParse(input).success, false)
})

test('normal occlusion and background framing can continue without inventing a passing review', () => {
  const result = parse().parse(response)
  assert.deepEqual(result, response)
  assert.equal(result.action.kind, 'continue_current_plan')
  assert.equal('passed' in result, false)
  assert.equal('review' in result, false)
  assert.equal(wallpaperDecisionResponseSchema.safeParse({ ...response, qualified: true }).success, false)
  assert.equal(parse().safeParse({ ...response, action: { kind: 'continue_current_plan', passed: true } }).success, false)
})

test('continuation retains real truncation, unreadable critical content, unknown extent and every explicit blocker', () => {
  for (const change of [
    { scope: 'subject', classification: 'frame-truncation', blocking: false },
    { scope: 'critical', classification: 'frame-truncation', blocking: false },
    { scope: 'critical', classification: 'observation-limit', blocking: false },
    { scope: 'critical', classification: 'unknown', blocking: false },
    { scope: 'technical', classification: 'technical-failure', blocking: true },
    { scope: 'background', classification: 'background-crop', blocking: true },
  ]) assert.equal(parse().safeParse({ ...response, findings: [{ ...response.findings[0], ...change, reason: 'A favorable sentence cannot override these structured findings.' }, response.findings[1]] }).success, false)
  for (const extent of ['cut-off', 'occluded', 'unknown', 'not-applicable']) assert.equal(parse().safeParse({ ...response, sourceExtent: { extent, reason: 'The current source extent has not been established as complete.' } }).success, false)
  const replan = { ...response, findings: response.findings.map(finding => ({ ...finding, blocking: true })), action: { kind: 'replan', guidance: 'Retain all protected source regions and ask the existing planner to reconsider placement.' } }
  assert.deepEqual(parse().parse(replan).findings, replan.findings)
  assert.equal(parse().safeParse({ ...replan, action: { ...replan.action, qualified: true } }).success, false)
})

test('not-applicable source extent needs explicit non-object Host context and no subject or critical concern', () => {
  const backgroundConcerns = [concerns[1]!]
  const scene = { ...response, findings: [response.findings[1]!], sourceExtent: { extent: 'not-applicable', reason: 'The Host and supplied pixels establish a background scene without an object subject.' } }
  const build = (mode: 'scene' | 'abstract' | 'single' | 'uncertain', hasProtectedSubject: boolean) => wallpaperDecisionOutputSchema('source', 2, backgroundConcerns, ['continue_current_plan'], images, { mode, hasProtectedSubject })
  for (const mode of ['scene', 'abstract'] as const) assert.deepEqual(build(mode, false).parse(scene), scene)
  assert.equal(wallpaperDecisionOutputSchema('source', 2, backgroundConcerns, ['continue_current_plan'], images).safeParse(scene).success, false)
  assert.equal(build('scene', true).safeParse(scene).success, false)
  assert.equal(build('single', false).safeParse(scene).success, false)
  assert.equal(build('uncertain', false).safeParse(scene).success, false)
  const protectedConcern = [{ ...backgroundConcerns[0]!, scope: 'critical' as const }]
  assert.equal(wallpaperDecisionOutputSchema('source', 2, protectedConcern, ['continue_current_plan'], images, { mode: 'scene', hasProtectedSubject: false }).safeParse({ ...scene, findings: [{ ...scene.findings[0], scope: 'critical' }] }).success, false)
})

test('every concern and evidence identity is exact, unique and bound to the current source revision', () => {
  for (const value of [
    { ...response, imageVersionId: 'other-source' }, { ...response, planRevision: 1 },
    { ...response, findings: [response.findings[0]] }, { ...response, findings: [response.findings[0], response.findings[0]] },
    { ...response, findings: [{ ...response.findings[0], concernId: 'invented-concern' }, response.findings[1]] },
    { ...response, findings: [{ ...response.findings[0], evidenceImageVersionIds: ['foreign-image'] }, response.findings[1]] },
    { ...response, findings: [{ ...response.findings[0], evidenceImageVersionIds: ['source', 'source'] }, response.findings[1]] },
    { ...response, findings: [{ ...response.findings[0], evidenceImageVersionIds: [] }, response.findings[1]] },
  ]) assert.equal(parse().safeParse(value).success, false)
  const scoped = [{ ...concerns[0]!, scope: 'critical' as const }, concerns[1]!]
  assert.equal(wallpaperDecisionOutputSchema('source', 2, scoped, ['continue_current_plan'], images).safeParse(response).success, false)
  assert.throws(() => wallpaperDecisionOutputSchema('source', 2, [concerns[0]!, concerns[0]!], ['manual_review'], images))
  assert.throws(() => wallpaperDecisionOutputSchema('source', 2, concerns, [], images))
  assert.throws(() => wallpaperDecisionOutputSchema('source', 2, concerns, ['manual_review'], ['wheel-detail']))
})

test('critical detail resolution cannot borrow the full frame or an unrelated native crop', () => {
  const detailConcerns = [{ id: 'sign', text: 'The task-critical sign must be readable from its actual covering native crop.', scope: 'critical' as const, detailImageVersionIds: ['sign-detail'] }]
  const sign = { ...response, findings: [{ concernId: 'sign', scope: 'critical', classification: 'resolved', blocking: false, reason: 'The currently supplied sign crop resolves the text.', evidenceImageVersionIds: ['sign-detail'], sourceRegion: { x: 0.7, y: 0.1, width: 0.1, height: 0.1 } }] }
  const schema = wallpaperDecisionOutputSchema('source', 2, detailConcerns, ['continue_current_plan', 'inspect_region'], images)
  assert.deepEqual(schema.parse(sign).findings, sign.findings)
  const { scope: _scope, ...boundSign } = sign.findings[0]!
  for (const finding of [boundSign, { ...boundSign, scope: 'background' }]) {
    assert.deepEqual(schema.parse({ ...sign, findings: [finding] }).findings, sign.findings)
    assert.equal(schema.safeParse({ ...sign, findings: [{ ...finding, evidenceImageVersionIds: ['wheel-detail'] }] }).success, false)
  }
  const unclassified = wallpaperDecisionOutputSchema('source', 2, [{ id: 'sign', text: 'Inspect the sign.' }], ['continue_current_plan'], images)
  assert.equal(unclassified.safeParse({ ...sign, findings: [boundSign] }).success, false)
  for (const evidenceImageVersionIds of [['source'], ['wheel-detail']]) assert.equal(schema.safeParse({ ...sign, findings: [{ ...sign.findings[0], evidenceImageVersionIds }] }).success, false)
  assert.equal(wallpaperDecisionOutputSchema('source', 2, [{ ...detailConcerns[0]!, detailImageVersionIds: [] }], ['continue_current_plan'], images).safeParse(sign).success, false)
  const unresolved = { ...sign, findings: [{ ...sign.findings[0], classification: 'observation-limit', blocking: true, evidenceImageVersionIds: ['source'] }], action: { kind: 'inspect_region', rect: { x: 0.2, y: 0.3, width: 0.2, height: 0.1 }, concernIds: ['sign'] } }
  assert.equal(schema.safeParse(unresolved).success, true)
  const { sourceRegion: _region, ...withoutRegion } = sign.findings[0]!
  assert.equal(schema.safeParse({ ...sign, findings: [withoutRegion] }).success, false)
  assert.equal(wallpaperDecisionResponseSchema.safeParse({ ...sign, findings: [withoutRegion] }).success, true, 'Stored legacy responses retain their original optional fields; current routing requires region evidence.')
})

test('the action allowlist and strict action parameters reject new generation, arbitrary commands and invalid regions', () => {
  const actions: WallpaperDecisionAction[] = [
    { kind: 'continue_current_plan' }, { kind: 'inspect_region', rect: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 }, concernIds: ['wheel-occlusion'] }, { kind: 'replan', guidance: 'Preserve the existing cumulative protection and use the original planner.' },
    { kind: 'retry_reference_preparation' }, { kind: 'query_saved_generation' }, { kind: 'recompose_saved_background' }, { kind: 'reconstruct_saved_background' }, { kind: 'retry_saved_review' }, { kind: 'skip_image' }, { kind: 'manual_review' },
  ]
  assert.deepEqual(actions.map(action => wallpaperDecisionActionSchema.parse(action).kind), wallpaperDecisionActionKinds)
  for (const action of [{ kind: 'generate_new_image' }, { kind: 'query_saved_generation', taskId: 'invented-task' }, { kind: 'manual_review', command: 'run arbitrary code' }, { kind: 'replan' }, { kind: 'inspect_region', rect: { x: 0.9, y: 0, width: 0.2, height: 0.2 }, concernIds: ['wheel-occlusion'] }, { kind: 'inspect_region', rect: { x: 0, y: 0, width: 0, height: 1 }, concernIds: ['wheel-occlusion'] }]) assert.equal(wallpaperDecisionActionSchema.safeParse(action).success, false)
  const limited = wallpaperDecisionOutputSchema('source', 2, concerns, ['inspect_region', 'manual_review'], images)
  assert.equal(limited.safeParse(response).success, false)
  assert.equal(limited.safeParse({ ...response, action: actions[1] }).success, true)
  for (const concernIds of [['foreign-concern'], ['wheel-occlusion', 'wheel-occlusion']]) assert.equal(limited.safeParse({ ...response, action: { ...actions[1], concernIds } }).success, false)
  const json = z.toJSONSchema(limited, { unrepresentable: 'any' })
  const actionJson = JSON.stringify(json.properties?.action)
  assert.equal(actionJson.includes('continue_current_plan'), false)
  assert.equal(actionJson.includes('query_saved_generation'), false)
  assert.equal(actionJson.includes('inspect_region'), true)
})

test('one image retains decision rounds outside attempts and preserves safe frozen input for running recovery', () => {
  const record = { id: 'decision-one', version: 'wallpaper-decision-v1', inputDigest: 'a'.repeat(64), evidenceDigest: 'b'.repeat(64), planRevision: 2, round: 1, status: 'running', reason: 'The existing request is still running.', sourceStage: 'planning', input: { concerns, detailRects: [{ imageVersionId: 'source', rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } }] } }
  const first = wallpaperDecisionRecordSchema.parse(record)
  const second = wallpaperDecisionRecordSchema.parse({ ...record, id: 'decision-two', planRevision: 3, round: 2, status: 'manual', reason: 'No new evidence remains.', input: undefined })
  const item = wallpaperItemSchema.parse({ imageVersionId: 'source', familyId: 'family', status: 'planning', decisions: [first, second] })
  assert.deepEqual(item.decisions?.map(decision => decision.round), [1, 2])
  assert.deepEqual(item.decisions?.[0]?.input, record.input)
  assert.equal(item.attempts.length, 0)
  const plan = wallpaperPlanSchema.parse({ version: 1, imageVersionId: 'source', mode: 'single', subject: 'A complete visible subject.', evidence: 'Source pixels.', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [], placement: { scale: 1, left: 0, top: 0 }, reason: 'Keep existing evidence.' })
  assert.equal(wallpaperAttemptSchema.safeParse({ revision: 2, plan, checks: [], needsOutpaint: true, decisions: [first] }).success, false)
  assert.equal(wallpaperDecisionRecordSchema.safeParse({ ...record, response: { ...response, planRevision: 3 } }).success, false)
  assert.equal(wallpaperDecisionRecordSchema.safeParse({ ...record, sourceStage: 'decision' }).success, false)
  assert.equal(wallpaperDecisionRecordSchema.safeParse({ ...record, input: new Uint8Array([1, 2, 3]) }).success, false)
  assert.equal(wallpaperDecisionRecordSchema.parse({ ...record, targetStage: 'decision' }).targetStage, 'decision')
  for (const status of ['running', 'applied', 'manual', 'skipped', 'failed']) assert.equal(wallpaperDecisionRecordSchema.parse({ ...record, status }).status, status)
})
