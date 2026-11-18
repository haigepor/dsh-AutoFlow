/** Source-intent protocols retain exact preservation verdicts independently of compact defect lists. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { wallpaperCompleteCanvasPrompt } from '../src/media/wallpaper-generation.ts'
import { applyWallpaperSourceReview } from '../src/host/wallpaper-review.ts'
import { wallpaperPracticalReviewOutputSchema, wallpaperPracticalReviewSchema, type WallpaperPracticalReview } from '../src/shared/wallpaper-practical.ts'
import { wallpaperItemSchema, wallpaperPlanSchema, wallpaperReviewReworkAvailable, wallpaperRoleObservationOutputSchema, wallpaperSettingsSchema, wallpaperStoredSourceReviewV4Schema, wallpaperVerdict } from '../src/shared/wallpaper.ts'

type CurrentReview = Extract<WallpaperPracticalReview, { protocol: 'practical-v2' }>
const settings = wallpaperSettingsSchema.parse({ processing: { acceptance: { version: 'practical-v2' } }, sourceIntentPolicy: { version: 'source-intent-v1' }, repairPolicy: {} })
const plan = wallpaperPlanSchema.parse({ version: 1, imageVersionId: 'original', mode: 'single', subject: 'A half-length award portrait behind a lectern.', evidence: 'The original includes the face, hands, award and lectern occlusion.', priorities: ['Keep the visible face and award large.'], anchors: ['Continue the gold curtain and dark stage.'], truncations: [], uncertainties: [], placement: { scale: 1, left: 0, top: 0 }, reason: 'Keep the original portrait framing.', sourceMedium: 'photograph',
  regions: [{ name: 'Portrait', entityId: 'main', role: 'subject', rect: { x: 0.2, y: 0.3, width: 0.6, height: 0.65 }, safetyClass: 'general' }],
  objectRoles: [{ name: 'Portrait', entityId: 'main', role: 'primary', rect: { x: 0.2, y: 0.3, width: 0.6, height: 0.65 }, sourceEdges: [], safetyClass: 'general', evidence: 'The portrait is the main subject.', sourceIntent: { framing: 'partial', visibility: 'occluded', preserve: ['Keep the smile, hair, glasses, clothes and visible hands unchanged.'], relationships: ['The lectern continues to occlude the lower body.'], layoutFocus: { x: 0.35, y: 0.35, width: 0.3, height: 0.3 } } }],
  editPrompt: 'Keep this exact half-length portrait; extend only the gold curtain and dark stage. Do not reveal legs.' })
const main = plan.objectRoles?.[0]
assert.ok(main)
const schema = wallpaperPracticalReviewOutputSchema('original', 'final', [main], 'single', true)

test('source observation composes required intent and safety fields before deriving rectangles', () => {
  const { placement: _placement, ...observed } = plan
  const current = wallpaperRoleObservationOutputSchema(undefined, true, true, true)
  assert.equal(current.safeParse({ ...observed, regions: [] }).success, true)
  const parsed = current.parse({ ...observed, regions: [] })
  assert.deepEqual(parsed.regions.map(row => row.rect), [main.rect], 'Layout focus never replaces the full source subject rectangle')
  assert.equal(current.safeParse({ ...observed, sourceMedium: undefined }).success, false)
  assert.equal(current.safeParse({ ...observed, objectRoles: observed.objectRoles?.map(row => ({ ...row, sourceIntent: undefined })) }).success, false)
  assert.equal(current.safeParse({ ...observed, objectRoles: observed.objectRoles?.map(row => ({ ...row, safetyClass: undefined })) }).success, false)
  const transmitted = z.fromJSONSchema(z.toJSONSchema(current, { io: 'input' }))
  assert.equal(transmitted.safeParse(observed).success, true)
  assert.equal(transmitted.safeParse({ ...observed, sourceMedium: undefined }).success, false)
  assert.equal(transmitted.safeParse({ ...observed, objectRoles: observed.objectRoles?.map(row => ({ ...row, sourceIntent: undefined })) }).success, false)
  assert.equal(transmitted.safeParse({ ...observed, objectRoles: observed.objectRoles?.map(row => ({ ...row, safetyClass: undefined })) }).success, false)
  assert.equal(current.safeParse({ ...observed, objectRoles: observed.objectRoles?.map(row => ({ ...row, safetyClass: 'automobile' })) }).success, false, 'A car cannot borrow a portrait focus to evade whole-car protection')
  const outsideFocus = { ...main.sourceIntent, layoutFocus: { x: 0.01, y: 0.4, width: 0.1, height: 0.2 } }
  assert.equal(current.safeParse({ ...observed, objectRoles: [{ ...main, sourceIntent: outsideFocus }] }).success, false)
  const frozen = wallpaperRoleObservationOutputSchema(parsed.objectRoles, true, true, true)
  assert.equal(frozen.safeParse({ ...observed, objectRoles: [{ ...main, sourceIntent: { ...main.sourceIntent, preserve: ['Invent a new face and legs.'] } }] }).success, false)
  const legacy = { ...observed, sourceMedium: undefined, objectRoles: observed.objectRoles?.map(({ sourceIntent: _intent, safetyClass: _safety, ...object }) => object) }
  assert.equal(wallpaperRoleObservationOutputSchema(undefined, true).safeParse(legacy).success, true)
  assert.equal(wallpaperRoleObservationOutputSchema(undefined, false).safeParse(legacy).success, true)
  assert.equal(wallpaperRoleObservationOutputSchema(undefined, true, false, true).safeParse(observed).success, true)
})

function review(): CurrentReview {
  return { reviewVersion: 'wallpaper-review-source-v4', protocol: 'practical-v2', sourceImageVersionId: 'original', outputImageVersionId: 'final', mode: 'single', subject: 'The original half-length portrait remains behind its lectern.',
    actualLayout: { regions: [{ name: 'Portrait', entityId: 'main', role: 'subject', scope: 'core', rect: { x: 0.2, y: 0.3, width: 0.6, height: 0.65 }, layoutFocus: { x: 0.35, y: 0.35, width: 0.3, height: 0.3 } }] }, defects: [], uncertainties: [],
    sourcePreservation: [{ entityId: 'main', framing: { result: 'satisfied', reason: 'The lower body remains occluded with the original half-length framing.' }, appearance: { result: 'satisfied', reason: 'The smile, clothes, hand and award retain their original visible appearance.' }, relationships: { result: 'satisfied', reason: 'The hand still holds the award and the lectern remains in front.' } }],
    sourceStyle: { result: 'satisfied', reason: 'The original photographic medium and warm stage light remain.' } }
}

test('source-intent review requires the new protocol and explicit checks for every frozen primary', () => {
  const current = review()
  assert.equal(schema.safeParse(current).success, true)
  const { sourcePreservation: _checks, sourceStyle: _style, ...withoutChecks } = current
  assert.equal(schema.safeParse(withoutChecks).success, false)
  assert.equal(schema.safeParse({ ...withoutChecks, protocol: 'practical-v1' }).success, false)
  assert.equal(schema.safeParse({ ...current, sourcePreservation: [] }).success, false)
  assert.equal(wallpaperPracticalReviewSchema.safeParse({ ...current, sourcePreservation: [] }).success, false, 'The shared reader cannot invent successful correspondence from an empty V2 preservation result')
  assert.equal(schema.safeParse({ ...current, sourcePreservation: [...current.sourcePreservation, ...current.sourcePreservation] }).success, false)
  assert.equal(schema.safeParse({ ...current, sourcePreservation: current.sourcePreservation.map(row => ({ ...row, entityId: 'foreign' })) }).success, false)
  assert.equal(schema.safeParse({ ...current, sourceStyle: undefined }).success, false)
  const other = { ...main, entityId: 'companion', name: 'Companion' }
  assert.equal(wallpaperPracticalReviewOutputSchema('original', 'final', [main, other], 'group', true).safeParse({ ...current, mode: 'group' }).success, false)
})

test('the transmitted review schema excludes supporting identities and fixes the preservation count', () => {
  const transmitted = z.fromJSONSchema(z.toJSONSchema(schema, { io: 'input' }))
  const current = review(), first = current.sourcePreservation[0]; assert.ok(first)
  assert.equal(transmitted.safeParse(current).success, true)
  assert.equal(transmitted.safeParse({ ...current, sourcePreservation: [] }).success, false)
  assert.equal(transmitted.safeParse({ ...current, sourcePreservation: [{ ...first, entityId: 'supporting-music-stand' }] }).success, false)
  assert.equal(transmitted.safeParse({ ...current, sourcePreservation: [...current.sourcePreservation, first] }).success, false)
})

test('an indispensable frozen structure requires its own actual region and preservation result', () => {
  const critical = { ...main, entityId: 'award', name: 'Held award', role: 'critical-part' as const, rect: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 }, sourceIntent: { framing: 'whole' as const, visibility: 'visible' as const, preserve: ['Keep the award silhouette and engraved mark.'], relationships: ['The original hand holds this award.'] } }
  const protectedSchema = wallpaperPracticalReviewOutputSchema('original', 'final', [main, critical], 'single', true)
  const output = review(), first = output.sourcePreservation[0]; assert.ok(first)
  output.actualLayout.regions.push({ entityId: critical.entityId, name: critical.name, role: 'critical', scope: 'core', rect: critical.rect })
  assert.equal(protectedSchema.safeParse(output).success, false, 'A primary passing result cannot stand in for its critical component')
  output.sourcePreservation.push({ ...first, entityId: critical.entityId, appearance: { result: 'unknown', reason: 'The award engraving cannot be confirmed in actual pixels.' } })
  const parsed = protectedSchema.parse(output)
  const stored = wallpaperStoredSourceReviewV4Schema.parse(applyWallpaperSourceReview(parsed, false, settings, settings.sourceIntentPolicy))
  assert.equal(wallpaperVerdict(stored), 'needs-review')
  assert.equal(stored.sourceCorrespondence.result, 'unknown')
  assert.ok('practicalReview' in stored && stored.practicalReview?.uncertainties.some(reason => reason.includes('engraving')))
  assert.equal(protectedSchema.safeParse({ ...output, actualLayout: { regions: output.actualLayout.regions.filter(region => region.entityId !== critical.entityId) } }).success, false)
})

test('review cannot invent a focus for a whole source to bypass complete-subject safety', () => {
  const intent = main.sourceIntent; assert.ok(intent)
  const { layoutFocus: _focus, ...sourceIntent } = intent
  const whole = { ...main, sourceIntent: { ...sourceIntent, framing: 'whole' as const, visibility: 'visible' as const } }
  const wholeSchema = wallpaperPracticalReviewOutputSchema('original', 'final', [whole], 'single', true)
  assert.equal(wholeSchema.safeParse(review()).success, false)
  const output = review()
  delete output.actualLayout.regions[0]?.layoutFocus
  assert.equal(wholeSchema.safeParse(output).success, true)
})

test('new layout focus cannot replace the full subject rectangle or escape its visible extent', () => {
  const current = review()
  const missingFocus = structuredClone(current)
  delete missingFocus.actualLayout.regions[0]?.layoutFocus
  assert.equal(schema.safeParse(missingFocus).success, false)
  const escaped = structuredClone(current), region = escaped.actualLayout.regions[0]
  assert.ok(region)
  region.layoutFocus = { x: 0.05, y: 0.4, width: 0.1, height: 0.2 }
  assert.equal(schema.safeParse(escaped).success, false)
  const parsed = wallpaperPracticalReviewSchema.parse(schema.parse(current))
  assert.equal(parsed.actualLayout.regions[0]?.rect.height, 0.65)
})

test('an empty defect list cannot qualify generated anatomy, changed animal markings, product labels or lost relationships', () => {
  for (const scenario of [
    { key: 'framing', reason: 'The half-length portrait now reveals generated legs below the lectern.' },
    { key: 'appearance', reason: 'The cat has a different source coat pattern and an invented visible paw.' },
    { key: 'appearance', reason: 'The originally readable product label has been replaced by invented lettering.' },
    { key: 'relationships', reason: 'The child no longer holds the adult hand visible in the source.' },
  ] as const) {
    const wire = review(), check = wire.sourcePreservation[0]
    assert.ok(check)
    check[scenario.key] = { result: 'violated', reason: scenario.reason }
    const stored = wallpaperStoredSourceReviewV4Schema.parse(applyWallpaperSourceReview(schema.parse(wire), true, settings, settings.sourceIntentPolicy))
    assert.equal(wallpaperVerdict(stored), 'reject', scenario.reason)
    assert.equal(stored.sourceCorrespondence.result, 'violated')
    assert.deepEqual(stored.practicalReview?.sourcePreservation, wire.sourcePreservation)
  }
})

test('source-medium changes reject while unresolved preservation prevents automatic corrective generation', () => {
  const changed = review()
  changed.sourceStyle = { result: 'violated', reason: 'The original brushwork was replaced by photographic skin and smooth plastic surfaces.' }
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(schema.parse(changed), true, settings, settings.sourceIntentPolicy)), 'reject')
  const unknown = review(), row = unknown.sourcePreservation[0]
  assert.ok(row)
  row.appearance = { result: 'unknown', reason: 'The original visible equipment connection cannot be matched in the final pixels.' }
  const held = wallpaperStoredSourceReviewV4Schema.parse(applyWallpaperSourceReview(schema.parse(unknown), true, settings, settings.sourceIntentPolicy))
  assert.equal(held.sourceCorrespondence.result, 'unknown')
  assert.equal(wallpaperVerdict(held), 'needs-review')
  assert(held.practicalReview?.uncertainties.length)
  unknown.defects = [{ kind: 'collage-seam', severity: 'major', reason: 'A visible rectangular seam remains.', outputRect: { x: 0.2, y: 0.5, width: 0.1, height: 0.1 } }]
  const mixed = wallpaperStoredSourceReviewV4Schema.parse(applyWallpaperSourceReview(schema.parse(unknown), true, settings, settings.sourceIntentPolicy))
  const item = wallpaperItemSchema.parse({ imageVersionId: 'original', originalId: 'original', familyId: 'family', status: 'reviewing', edits: 1, attempts: [{ revision: 1, plan, checks: [], needsOutpaint: true, compositionMode: 'generated-canvas-v1', outputId: 'final', review: mixed }] })
  assert.equal(wallpaperReviewReworkAvailable(item, settings), false, 'A known seam cannot turn an unresolved source-preservation question into permission to regenerate')
})

test('legacy compact records remain decodable without fabricated source-preservation evidence', () => {
  const { sourcePreservation: _checks, sourceStyle: _style, ...current } = review()
  const legacy = { ...current, protocol: 'practical-v1', actualLayout: { regions: current.actualLayout.regions.map(({ layoutFocus: _focus, ...region }) => region) } }
  assert.equal(wallpaperPracticalReviewSchema.safeParse(legacy).success, true)
  assert.equal(wallpaperPracticalReviewOutputSchema('original', 'final', [main], 'single').safeParse(legacy).success, true)
  assert.equal(wallpaperPracticalReviewOutputSchema('original', 'final', [main], 'single').safeParse(review()).success, false)
  const stored = wallpaperStoredSourceReviewV4Schema.parse(applyWallpaperSourceReview(legacy, true, wallpaperSettingsSchema.parse({ processing: { acceptance: { version: 'practical-v2' } }, repairPolicy: {} })))
  assert.equal(stored.practicalReview?.version, 'practical-v1')
  assert.equal(stored.practicalReview.sourcePreservation, undefined)
})

test('complete generation carries source-specific instructions and cannot impose a pullback on frozen partial views', () => {
  const prompt = wallpaperCompleteCanvasPrompt(plan, settings)
  assert(prompt.includes(plan.editPrompt ?? ''))
  assert.match(prompt, /保持原有摄影风格/)
  assert.doesNotMatch(prompt, /sourceMedium|referenceTransformAlreadyApplied|desiredSourceTransform|objectRoles/)
  assert.doesNotMatch(prompt, /必须拉远镜头/)
  assert.match(prompt, /不拉远成小主体/)
  assert.match(prompt, /不补画原图未见的身体/)
  assert.match(prompt, /不以背景、涂抹或渐隐遮盖已有主体/)
  assert.match(prompt, /同一|取景/)
  const source = plan.objectRoles?.[0]
  assert.ok(source)
  for (const medium of ['illustration', 'three-dimensional', 'graphic'] as const) {
    const variant = wallpaperPlanSchema.parse({ ...plan, sourceMedium: medium, editPrompt: `Preserve the original ${medium} details and visible lettering.`, backgroundBrief: { version: 'background-only-v1', setting: 'Original stage', light: 'Warm overhead light', palette: 'Gold and black', texture: 'Visible paper grain or original material', perspective: 'Existing source perspective' }, objectRoles: [{ ...source, sourceIntent: { ...source.sourceIntent, preserve: [`Keep the original ${medium} surface and lettering.`] } }] })
    const text = wallpaperCompleteCanvasPrompt(variant, settings)
    assert(text.includes(variant.editPrompt ?? '')); assert(text.includes('重要文字')); assert(text.includes('Warm overhead light'))
  }
})
