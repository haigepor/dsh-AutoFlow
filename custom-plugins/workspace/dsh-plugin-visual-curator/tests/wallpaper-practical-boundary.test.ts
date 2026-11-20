/** Practical wallpaper acceptance protects the focal body without penalizing natural peripheral framing. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { wallpaperActualBoundary } from '../src/host/wallpaper-boundary.ts'
import { wallpaperObjectProtectionRegions, wallpaperGeometry, fitWallpaperPlacement, wallpaperPracticalRegionBoundary } from '../src/shared/wallpaper-geometry.ts'
import { wallpaperProcessingSchema, resolveWallpaperProcessing, wallpaperReviewNeedsSubjectEdit, wallpaperPracticalAcceptance } from '../src/shared/wallpaper-policy.ts'
import { wallpaperSettingsSchema, wallpaperPlanSchema, wallpaperStoredSourceReviewV4Schema, wallpaperReviewKeys, type WallpaperPlan } from '../src/shared/wallpaper.ts'

const settings = wallpaperSettingsSchema.parse({ repairPolicy: {}, processing: resolveWallpaperProcessing() })
const strict = wallpaperSettingsSchema.parse({ repairPolicy: {} })
const historicalPractical = wallpaperSettingsSchema.parse({ repairPolicy: {}, processing: { acceptance: { version: 'practical-v1' } } })
const savedPractical = wallpaperSettingsSchema.parse({ repairPolicy: {}, processing: { acceptance: { version: 'practical-v2' } } })
const region = (name: string, role: WallpaperPlan['regions'][number]['role'], scope: 'core' | 'peripheral', left: number, top: number, width: number, height: number) => ({ name, role, scope, rect: { x: left / 1845, y: top / 3280, width: width / 1845, height: height / 3280 } })
const body = region('Focal body', 'subject', 'core', 240, 1200, 1000, 900)
const boundary = (regions: Parameters<typeof wallpaperActualBoundary>[0]['regions'], policy = settings, mode: WallpaperPlan['mode'] = 'single') => wallpaperActualBoundary({ imageVersionId: 'output', regions }, mode, policy)
const plan = (regions: WallpaperPlan['regions'], mode: WallpaperPlan['mode'] = 'single') => wallpaperPlanSchema.parse({ version: 1, imageVersionId: 'source', mode, subject: 'Focal subject', evidence: 'Visible source pixels', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: regions.map(({ name, role, rect }) => ({ name, role, rect })), placement: { scale: 1, left: 0, top: 0 }, reason: 'Keep the focal subject prominent.' })

test('new admissions freeze practical defaults while absent and explicit strict policies remain strict', () => {
  const nearBoundaryRecheck = { minimumInsideRatio: 0.93, maximumSafeAxisRatio: 0.03, maximumOutputShortSideRatio: 40 / 1845 }
  const expansionReview = { version: 'expansion-first-v2', minimumPlannedScaleRatio: 0.8, centerDriftMultiplier: 1.5 }
  assert.deepEqual(settings.processing?.acceptance, { version: 'practical-v2', minimumCoreInsideRatio: 0.97, minimumCoreSafeAreaRatio: 0.08, maximumAutomaticCorrections: 1, nearBoundaryRecheck, expansionReview })
  assert.equal(wallpaperProcessingSchema.parse({}).acceptance, undefined)
  assert.deepEqual(resolveWallpaperProcessing({ acceptance: { version: 'strict-v1' } }).acceptance, { version: 'strict-v1' })
  assert.deepEqual(resolveWallpaperProcessing({ acceptance: { version: 'practical-v1', minimumCoreInsideRatio: 0.92, maximumAutomaticCorrections: 2 } }).acceptance, { version: 'practical-v2', minimumCoreInsideRatio: 0.97, minimumCoreSafeAreaRatio: 0.08, maximumAutomaticCorrections: 2, nearBoundaryRecheck, expansionReview })
  assert.deepEqual(savedPractical.processing?.acceptance, { version: 'practical-v2', minimumCoreInsideRatio: 0.97, minimumCoreSafeAreaRatio: 0.08, maximumAutomaticCorrections: 1 })
  assert.equal(wallpaperPracticalAcceptance(strict), undefined)
  assert.equal(wallpaperPracticalAcceptance(settings)?.version, 'practical-v2')
  assert.deepEqual(wallpaperPracticalAcceptance(historicalPractical), { version: 'practical-v1', minimumCoreInsideRatio: 0.9, minimumCoreSafeAreaRatio: 0.08, maximumCoreEdgeOverflowRatio: 0.15, coordinateTolerancePixels: 24, maximumAutomaticCorrections: 1 })
  for (const invalid of [{ minimumCoreInsideRatio: 1.01 }, { minimumCoreSafeAreaRatio: -0.01 }, { maximumCoreEdgeOverflowRatio: -0.01 }, { coordinateTolerancePixels: 1.5 }, { maximumAutomaticCorrections: 4 }]) {
    assert.equal(wallpaperProcessingSchema.safeParse({ acceptance: { version: 'practical-v2', ...invalid } }).success, false)
  }
  assert.equal(wallpaperProcessingSchema.safeParse({ acceptance: { version: 'practical-v2', minimumCoreInsideRatio: 0.969 } }).success, false)
})

test('a saved partial focal box cannot excuse a connected structure outside the safety area', () => {
  const sourceLayout = { version: 'source-intent-v2' as const, minimumSubjectScaleRatio: 0.9 }
  const station = { ...region('Station and solar arrays', 'subject', 'core', 40, 1400, 1750, 800), safetyClass: 'general' as const,
    layoutFocus: region('Central module', 'subject', 'core', 500, 1420, 800, 620).rect }
  const layout = { imageVersionId: 'result', regions: [station] }
  assert.deepEqual(wallpaperActualBoundary(layout, 'single', savedPractical, sourceLayout).hard, [])
  assert.deepEqual(wallpaperActualBoundary(layout, 'single', settings, sourceLayout).hard, ['subject-overflow:Station and solar arrays'])
})

test('safe historical framing keeps a five-pixel scale estimate and a planned center offset advisory', () => {
  const configured = wallpaperSettingsSchema.parse({ ...settings, sourceIntentPolicy: { version: 'source-intent-v2', alignment: 'subject-fill-v1' } })
  const policy = configured.sourceIntentPolicy
  assert.ok(policy?.alignment === 'subject-fill-v1')
  const target = region('Cherries', 'subject', 'core', 465, 1171, 915, 1408)
  const actual = { ...region('Cherries', 'subject', 'core', 618, 1007, 812, 1122), entityId: 'cherries', safetyClass: 'general' as const }
  const sourceLayout = { ...policy, expectedSubjects: [{ entityId: 'cherries', rect: target.rect }] }
  const measured = (candidate: typeof actual) => wallpaperActualBoundary({ imageVersionId: 'saved-result', regions: [candidate] }, 'single', configured, sourceLayout)
  const observation = measured(actual)
  assert.deepEqual(observation.hard, [])
  assert.ok(observation.warnings.includes('subject-too-small:Cherries'))
  assert.ok(observation.warnings.some(check => check.startsWith('subject-center-drift:')))
  const legacy = wallpaperSettingsSchema.parse({ ...configured, processing: resolveWallpaperProcessing({ acceptance: { version: 'practical-v2', expansionReview: { version: 'expansion-first-v1', minimumPlannedScaleRatio: 0.8, centerDriftMultiplier: 1.5 }, minimumCoreInsideRatio: 0.97, minimumCoreSafeAreaRatio: 0.08, maximumAutomaticCorrections: 1 } }) })
  assert.deepEqual(wallpaperActualBoundary({ imageVersionId: 'saved-result', regions: [actual] }, 'single', legacy, sourceLayout).hard, ['subject-too-small:Cherries', 'subject-center-drift:102,-307'])
  assert.deepEqual(measured({ ...actual, rect: { ...actual.rect, y: 980 / settings.height } }).hard, ['subject-overflow:Cherries'])
  assert.deepEqual(measured({ ...actual, rect: { ...actual.rect, y: 1100 / settings.height, height: 950 / settings.height } }).hard, ['subject-too-small:Cherries'])
})

test('safe modest shift and scale differences are advisory while substantial shrinkage still blocks', () => {
  const configured = wallpaperSettingsSchema.parse({ ...settings, sourceIntentPolicy: { version: 'source-intent-v2', alignment: 'subject-fill-v1' } })
  const policy = configured.sourceIntentPolicy
  assert.ok(policy?.alignment === 'subject-fill-v1')
  const target = region('Sculpture', 'subject', 'core', 500, 1310, 500, 600)
  const actual = { ...region('Sculpture', 'subject', 'core', 660, 1310, 430, 516), entityId: 'sculpture', safetyClass: 'general' as const }
  const sourceLayout = { ...policy, expectedSubjects: [{ entityId: 'sculpture', rect: target.rect }] }
  const observation = wallpaperActualBoundary({ imageVersionId: 'result', regions: [actual] }, 'single', configured, sourceLayout)
  assert.deepEqual(observation.hard, [])
  assert.ok(observation.warnings.includes('subject-too-small:Sculpture'))
  assert.ok(observation.warnings.includes('subject-center-drift:125,-42'))
  const tiny = { ...actual, rect: region('Sculpture', 'subject', 'core', 625, 1460, 250, 300).rect }
  assert.deepEqual(wallpaperActualBoundary({ imageVersionId: 'result', regions: [tiny] }, 'single', configured, sourceLayout).hard, ['subject-too-small:Sculpture'])
})

test('a prominent focal body may extend slightly beyond the inner guide without a synthetic critical copy', () => {
  const observed = plan([body])
  assert.equal(wallpaperObjectProtectionRegions(observed, settings), observed.regions)
  assert.equal(wallpaperObjectProtectionRegions(observed, strict).length, 2)
  const practical = boundary([body])
  assert.deepEqual(practical.hard, [])
  assert.ok(practical.warnings.includes('core-outside:Focal body'))
  assert.ok(boundary([body], strict).hard.some(check => check.startsWith('critical-outside:')))
  assert.deepEqual(boundary([body], wallpaperSettingsSchema.parse({ repairPolicy: {}, processing: resolveWallpaperProcessing({ acceptance: { version: 'strict-v1' } }) })).hard, boundary([body], strict).hard)
})

test('large or distant core overflow and undersized object subjects still fail', () => {
  assert.ok(boundary([region('Mostly outside', 'subject', 'core', 50, 1200, 600, 900)]).hard.includes('subject-overflow:Mostly outside'))
  assert.ok(boundary([region('Far outside', 'subject', 'core', 1600, 1300, 120, 600)]).hard.includes('subject-overflow:Far outside'))
  assert.ok(boundary([region('Tiny subject', 'subject', 'core', 700, 1600, 80, 80)]).hard.includes('subject-too-small'))
  assert.ok(boundary([region('Small left', 'subject', 'core', 300, 1200, 80, 80), region('Small right', 'subject', 'core', 1400, 2200, 80, 80)], settings, 'group').hard.includes('subject-too-small'))
})

test('practical placement fits a smaller co-primary below the main drink without consuming final-review overflow tolerance', () => {
  const source = { width: 1845, height: 3280 }
  const observed = plan([
    { name: 'Penguin', role: 'subject', rect: { x: 0.09, y: 0.455, width: 0.37, height: 0.255 } },
    { name: 'Drink', role: 'subject', rect: { x: 0.43, y: 0.18, width: 0.36, height: 0.53 } },
    { name: 'Jelly', role: 'subject', rect: { x: 0.225, y: 0.705, width: 0.385, height: 0.13 } },
  ], 'group')
  const excessivePlacement = { ...observed, placement: { scale: 0.80137, left: 211, top: 583 } }
  assert.ok(wallpaperGeometry(source, excessivePlacement, settings).checks.includes('subject-overflow:Jelly'))
  const placement = fitWallpaperPlacement(source, observed, settings, 'subject-first-v2')
  const geometry = wallpaperGeometry(source, { ...observed, placement }, settings)
  assert.deepEqual(geometry.checks, [])
  assert.ok(placement.scale > 0.7, 'The group stays prominent rather than shrinking to a tiny valid placement')
  const inset = settings.processing?.layoutInsetPixels
  assert.ok(inset !== undefined)
  for (const subject of geometry.regions) {
    assert.ok(subject.left >= settings.safe.left + inset)
    assert.ok(subject.top >= settings.safe.top + inset)
    assert.ok(subject.left + subject.width <= settings.safe.left + settings.safe.width - inset)
    assert.ok(subject.top + subject.height <= settings.safe.top + settings.safe.height - inset)
  }
  assert.ok(geometry.regions.reduce((area, subject) => area + subject.width * subject.height, 0) >= settings.safe.width * settings.safe.height * 0.4)
})

test('V2 indispensable details remain fully inside while historical V1 retains its coordinate tolerance', () => {
  assert.deepEqual(boundary([body, region('Inside structure', 'critical', 'core', 258, 1400, 200, 200)]).hard, [])
  assert.ok(boundary([body, region('Small coordinate error', 'critical', 'core', 250, 1400, 200, 200)]).hard.includes('critical-outside:Small coordinate error'))
  assert.deepEqual(boundary([body, region('Small coordinate error', 'critical', 'core', 250, 1400, 200, 200)], historicalPractical).hard, [])
  assert.ok(boundary([body, region('Important structure', 'critical', 'core', 220, 1400, 200, 200)]).hard.includes('critical-outside:Important structure'))
  assert.ok(boundary([body, region('Misclassified structure', 'critical', 'peripheral', 500, 650, 12, 550)]).hard.includes('peripheral-critical:Misclassified structure'))
})

test('V2 requires every automobile rectangle to stay 100 percent inside the exact safe area', () => {
  const completeCar = { ...region('Complete car', 'subject', 'core', 258, 1200, 1000, 500), safetyClass: 'automobile' as const }
  assert.deepEqual(boundary([completeCar]).hard, [])
  const car99 = { ...region('Car at 99 percent', 'subject', 'core', 248, 1200, 1000, 500), safetyClass: 'automobile' as const }
  assert.ok(boundary([car99]).hard.includes('automobile-outside:Car at 99 percent'))
  const wing = { ...region('Car peripheral', 'subject', 'peripheral', 250, 1400, 20, 20), safetyClass: 'automobile' as const }
  assert.ok(boundary([completeCar, wing]).hard.includes('automobile-outside:Car peripheral'))
  const detail = { ...region('Car critical detail', 'critical', 'core', 250, 1400, 20, 20), safetyClass: 'automobile' as const }
  assert.ok(boundary([completeCar, detail]).hard.includes('automobile-outside:Car critical detail'))
  const atBottom = { ...region('Car touching bottom edge', 'subject', 'core', 500, 1796, 600, 922), safetyClass: 'automobile' as const }
  assert.deepEqual(boundary([atBottom]), { hard: [], warnings: [] })
  const overBottom = { ...atBottom, rect: { ...atBottom.rect, y: 1797 / settings.height } }
  assert.ok(boundary([overBottom]).hard.includes('automobile-outside:Car touching bottom edge'))
})

test('V2 general subjects pass exactly 97 percent and reject 96.9 percent without expanding the safe rectangle', () => {
  const other97 = { ...region('General at 97 percent', 'subject', 'core', 228, 1200, 1000, 500), safetyClass: 'general' as const }
  assert.deepEqual(boundary([other97]).hard, [])
  const other969 = { ...region('General at 96.9 percent', 'subject', 'core', 227, 1200, 1000, 500), safetyClass: 'general' as const }
  assert.ok(boundary([other969]).hard.includes('subject-overflow:General at 96.9 percent'))
  assert.deepEqual(boundary([other969], historicalPractical).hard, [])
  const actualRedCar = { name: 'Red sports car', role: 'subject' as const, scope: 'core' as const, safetyClass: 'automobile' as const, rect: { x: 0.1, y: 0.44, width: 0.8, height: 0.2 } }
  assert.ok(boundary([actualRedCar]).hard.includes('automobile-outside:Red sports car'))
  assert.deepEqual(boundary([actualRedCar], historicalPractical).hard, [])
})

test('a small single-sided estimate selects a local recheck while still failing the 97 percent gate', () => {
  const kitten = { name: 'Kitten', role: 'subject' as const, safetyClass: 'general' as const, left: 221.4, top: 1833.5, width: 586.7, height: 747.8 }
  const measured = wallpaperPracticalRegionBoundary(kitten, settings)
  assert.deepEqual(measured?.hard, ['subject-overflow:Kitten'])
  assert.equal(measured?.borderline?.edge, 'left')
  assert.equal(Math.round(measured?.borderline?.overflowPixels ?? 0), 37)
  assert.equal(wallpaperPracticalRegionBoundary(kitten, savedPractical)?.borderline, undefined)
  assert.equal(wallpaperPracticalRegionBoundary({ ...kitten, left: 230, top: 1000 }, settings)?.borderline, undefined, 'Two edges need separate evidence')
  assert.equal(wallpaperPracticalRegionBoundary({ ...kitten, width: 365 }, settings)?.borderline, undefined, 'A substantial fraction lies outside')
  assert.equal(wallpaperPracticalRegionBoundary({ ...kitten, left: -1, width: 4000 }, settings)?.borderline, undefined, 'A clipped image requires independent quality handling')
  assert.equal(wallpaperPracticalRegionBoundary({ ...kitten, role: 'critical' }, settings)?.borderline, undefined)
  assert.equal(wallpaperPracticalRegionBoundary({ ...kitten, safetyClass: 'automobile' }, settings)?.borderline, undefined)
  const cup = { ...kitten, name: 'Cup', left: 941, width: 590.4, top: 951.2, height: 1590.8 }
  assert.equal(wallpaperPracticalRegionBoundary(cup, settings)?.borderline, undefined, 'An 81 px top overflow needs evidence that the extra content is peripheral')
})

test('an upward straw and diagonal peripheral rectangles remain warnings regardless of their empty rectangle area', () => {
  const straw = region('Straw tip', 'subject', 'peripheral', 500, 650, 12, 550)
  const practical = boundary([body, straw])
  assert.deepEqual(practical.hard, [])
  assert.ok(practical.warnings.includes('peripheral-outside:Straw tip'))
  assert.ok(boundary([body, straw], strict).hard.includes('safe-top-overlap:Straw tip'))
  const diagonal = region('Diagonal fine branch', 'subject', 'peripheral', 50, 200, 500, 800)
  const looseBoxes = boundary([body, diagonal, { ...diagonal, name: 'Overlapping fine branch' }])
  assert.deepEqual(looseBoxes.hard, [])
  assert.ok(looseBoxes.warnings.includes('peripheral-total-overflow'))
})

test('scenery and abstract compositions keep small real focal details without an object-size requirement', () => {
  const focal = region('Distant focal detail', 'critical', 'core', 700, 1300, 20, 20)
  assert.deepEqual(boundary([focal], settings, 'scene').hard, [])
  assert.deepEqual(boundary([], settings, 'abstract').hard, [])
  assert.deepEqual(wallpaperGeometry(settings, plan([focal], 'scene'), settings).checks, [])
})

test('unresolved subject evidence never authorizes repainting a healthy candidate', () => {
  const review = wallpaperStoredSourceReviewV4Schema.parse({ reviewVersion: 'wallpaper-review-source-v4', subject: 'Focal subject', checks: Object.fromEntries([...wallpaperReviewKeys, 'clarity'].map(key => [key, { result: 'satisfied', reason: 'Visible pixels.' }])), issues: [], modelIssues: [], styleResults: [],
    actualLayout: { imageVersionId: 'output', regions: [body] }, sourceRepair: { result: 'satisfied', reason: 'Natural continuation.' }, sourceCorrespondence: { result: 'satisfied', reason: 'Source content retained.' },
    subjectIntegrity: { mode: 'single', source: { extent: 'complete', reason: 'Visible source.', imageVersionId: 'source' }, output: { extent: 'complete', reason: 'Visible output.', imageVersionId: 'output' }, task: { result: 'satisfied', reason: 'Subject retained.' } }, layoutChecks: [], layoutWarnings: [], modelProtectionCheck: { result: 'satisfied', reason: 'Subject body in guide.' } })
  review.checks.subject = { result: 'unknown', reason: 'A local detail is unresolved.' }
  review.checks.background = { result: 'violated', reason: 'One visible background seam.' }
  assert.equal(wallpaperReviewNeedsSubjectEdit(review), false)
  review.checks.clarity = { result: 'violated', reason: 'Visible focal texture loss.' }
  assert.equal(wallpaperReviewNeedsSubjectEdit(review), true)
})
