/** Critical routing findings require the actual native crop of their source-coordinate region. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { wallpaperDecisionVisionSchema, type VisionInput } from '../src/media/vision.ts'
import type { WallpaperDecisionConcern } from '../src/shared/wallpaper-decision.ts'

const signRect = { x: 0.72, y: 0.1, width: 0.18, height: 0.12 }
const wheelRect = { x: 0.08, y: 0.6, width: 0.25, height: 0.25 }
const signRegion = { x: 0.75, y: 0.12, width: 0.1, height: 0.05 }
const representations = [
  { imageVersionId: 'sign-crop', sourceImageVersionId: 'source', sourceRect: signRect },
  { imageVersionId: 'wheel-crop', sourceImageVersionId: 'source', sourceRect: wheelRect },
]
function preparedInput(concern: WallpaperDecisionConcern = { id: 'uncertainty:0', text: 'Determine whether the required source content is readable.' }, views: readonly { imageVersionId: string; sourceImageVersionId?: string; sourceRect?: typeof signRect }[] = representations): VisionInput {
  return {
    requestId: 'decision', taskBrief: 'Preserve source content and use independent final review.', rules: [],
    images: ['source', 'sign-crop', 'wheel-crop'].map(imageVersionId => ({ imageVersionId, digest: 'a'.repeat(64), mime: 'image/webp', bytes: new Uint8Array([1]), role: imageVersionId === 'source' ? 'wallpaper-original' : 'wallpaper-original-detail-only' })),
    usage: { decision: { planRevision: 1, concerns: [concern], allowedActions: ['continue_current_plan', 'inspect_region', 'retry_saved_review', 'manual_review'], context: { mode: 'single', hasProtectedSubject: true } }, imageRepresentations: views },
  }
}
function response() {
  return {
    version: 'wallpaper-decision-v1', imageVersionId: 'source', planRevision: 1,
    findings: [{ concernId: 'uncertainty:0', scope: 'critical', classification: 'resolved', blocking: false, reason: 'The supplied native sign crop establishes readable source content.', evidenceImageVersionIds: ['sign-crop'], sourceRegion: signRegion }],
    sourceExtent: { extent: 'complete', reason: 'The whole original frame contains the expected visible subject.' },
    action: { kind: 'continue_current_plan' }, reason: 'Continue the saved plan and retain independent final review.',
  }
}

test('the prepared decision parser retains Host concern-to-crop bindings', () => {
  const schema = wallpaperDecisionVisionSchema(preparedInput({ id: 'uncertainty:0', text: 'The required sign must be readable.', scope: 'critical', detailImageVersionIds: ['sign-crop'] }))
  assert.deepEqual(schema.parse(response()), response())
  const wrong = response()
  wrong.findings[0]!.evidenceImageVersionIds = ['wheel-crop']
  wrong.findings[0]!.sourceRegion = { x: 0.1, y: 0.65, width: 0.1, height: 0.1 }
  assert.equal(schema.safeParse(wrong).success, false)
  assert.equal(wallpaperDecisionVisionSchema(preparedInput({ id: 'uncertainty:0', text: 'No actual covering detail is supplied.', scope: 'critical', detailImageVersionIds: [] })).safeParse(response()).success, false)
})

test('model-classified critical findings cite a crop that actually contains their source region', () => {
  const schema = wallpaperDecisionVisionSchema(preparedInput())
  assert.deepEqual(schema.parse(response()), response())
  for (const evidenceImageVersionIds of [['wheel-crop'], ['source']]) {
    const wrong = response(); wrong.findings[0]!.evidenceImageVersionIds = evidenceImageVersionIds
    assert.equal(schema.safeParse(wrong).success, false)
  }
  const outside = response(); outside.findings[0]!.sourceRegion = { x: 0.6, y: 0.12, width: 0.25, height: 0.05 }
  assert.equal(schema.safeParse(outside).success, false)
  const invalid = response(); invalid.findings[0]!.sourceRegion = { x: 0.9, y: 0.12, width: 0.2, height: 0.05 }
  assert.equal(schema.safeParse(invalid).success, false)
})

test('critical resolution requires source coordinates and verified same-source representation metadata', () => {
  const complete = response(), { sourceRegion: _region, ...finding } = complete.findings[0]!
  const noRegion = { ...complete, findings: [finding] }
  assert.equal(wallpaperDecisionVisionSchema(preparedInput()).safeParse(noRegion).success, false)
  assert.equal(wallpaperDecisionVisionSchema(preparedInput()).safeParse({ ...noRegion, action: { kind: 'manual_review' } }).success, false)
  for (const views of [[], [{ ...representations[0]!, sourceImageVersionId: 'different-source' }], [{ imageVersionId: 'sign-crop', sourceImageVersionId: 'source' }], [{ ...representations[0]!, sourceRect: wheelRect }]]) {
    assert.equal(wallpaperDecisionVisionSchema(preparedInput(undefined, views)).safeParse(complete).success, false)
  }
  const notNative = preparedInput(); notNative.images = notNative.images.map(image => image.imageVersionId === 'sign-crop' ? { ...image, role: 'actual-wallpaper-detail-only' } : image)
  assert.equal(wallpaperDecisionVisionSchema(notNative).safeParse(complete).success, false)
  const unresolved = { ...noRegion, findings: [{ ...finding, classification: 'observation-limit', blocking: true, evidenceImageVersionIds: ['source'] }], action: { kind: 'inspect_region', rect: signRect, concernIds: ['uncertainty:0'] } }
  assert.equal(wallpaperDecisionVisionSchema(preparedInput()).safeParse(unresolved).success, true)
})

test('whole-frame background decisions and technical saved-review recovery do not require native crops', () => {
  const input = preparedInput(undefined, []); input.images = [input.images[0]!]
  const base = response(), { sourceRegion: _region, ...finding } = base.findings[0]!
  const background = { ...base, findings: [{ ...finding, scope: 'background', classification: 'background-crop', evidenceImageVersionIds: ['source'] }] }
  assert.deepEqual(wallpaperDecisionVisionSchema(input).parse(background), background)
  const technical = { ...background, findings: [{ ...finding, scope: 'technical', classification: 'technical-failure', evidenceImageVersionIds: ['source'] }], sourceExtent: { extent: 'unknown', reason: 'The saved review response failed structurally; source extent is not being resolved by this action.' }, action: { kind: 'retry_saved_review' } }
  assert.deepEqual(wallpaperDecisionVisionSchema(input).parse(technical), technical)
})
