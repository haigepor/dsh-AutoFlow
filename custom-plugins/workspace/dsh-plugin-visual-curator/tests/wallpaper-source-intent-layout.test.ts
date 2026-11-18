/** Frozen source intent keeps complete subjects observable while deriving layout and authorized edge work separately. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import sharp from 'sharp'
import { wallpaperPlanSchema, wallpaperRoleObservationOutputSchema, wallpaperSettingsSchema, wallpaperStoredSourceReviewV4Schema, wallpaperReviewKeys } from '../src/shared/wallpaper.ts'
import { wallpaperPracticalReviewOutputSchema } from '../src/shared/wallpaper-practical.ts'
import { resolveWallpaperProcessing } from '../src/shared/wallpaper-policy.ts'
import { fitWallpaperPlacement, wallpaperCandidatePlacement, wallpaperGeometry, wallpaperLayoutRegions, wallpaperPlacementScaleOptions, wallpaperPositionedLayout, wallpaperSourceContinuationTargets, wallpaperSourceExtensionEdges, type WallpaperSourceLayout } from '../src/shared/wallpaper-geometry.ts'
import { wallpaperActualBoundary } from '../src/host/wallpaper-boundary.ts'
import { renderWallpaper } from '../src/media/wallpaper-render.ts'
import { wallpaperRepairMask, wallpaperSourceRepairNeeded } from '../src/media/wallpaper-repair.ts'

const expected = JSON.parse(await readFile(new URL('./fixtures/wallpaper-source-intent-layout.expected.json', import.meta.url), 'utf8'))
const source = { width: 1845, height: 3280 }
const settings = wallpaperSettingsSchema.parse({ repairPolicy: {}, sourceFrameRepair: { enabled: true, marginPixels: 128 }, processing: resolveWallpaperProcessing() })
const policy: WallpaperSourceLayout = { version: 'source-intent-v1', minimumSubjectScaleRatio: 0.9 }

test('a small cropped painting fills more of the unchanged safe area while its original left and bottom cuts remain on the final frame', async () => {
  const source = { width: 1024, height: 1536 }, current = { ...policy, version: 'source-intent-v2' as const }
  const settings = wallpaperSettingsSchema.parse({ processing: resolveWallpaperProcessing(), sourceIntentPolicy: current })
  const portrait = wallpaperPlanSchema.parse({ version: 1, imageVersionId: 'painting', mode: 'group', subject: 'Woman and violin', evidence: 'The woman is intentionally cropped at the left and bottom, with a complete violin and bow.', priorities: [], anchors: [], truncations: [], uncertainties: [], placement: { scale: 1, left: 0, top: 0 }, reason: 'Retain the original pose.',
    objectRoles: [
      { entityId: 'woman', name: 'Woman', role: 'primary', evidence: 'Partial portrait', rect: { x: 0, y: 0.06, width: 0.87, height: 0.94 }, sourceEdges: ['left', 'bottom'], sourceIntent: { framing: 'partial', visibility: 'frame-cropped', preserve: ['Original body and pose'], relationships: ['Holds the violin'], layoutFocus: { x: 0.2, y: 0.07, width: 0.6, height: 0.5 } } },
      { entityId: 'violin', name: 'Violin', role: 'primary', evidence: 'Complete instrument', rect: { x: 0.375, y: 0.235, width: 0.6, height: 0.21 }, sourceEdges: [], sourceIntent: visible },
      { entityId: 'bow', name: 'Bow', role: 'critical-part', evidence: 'Complete indispensable bow', rect: { x: 0.25, y: 0.08, width: 0.56, height: 0.58 }, sourceEdges: [], sourceIntent: visible },
    ], regions: [
      { entityId: 'woman', name: 'Woman', role: 'subject', rect: { x: 0, y: 0.06, width: 0.87, height: 0.94 } },
      { entityId: 'violin', name: 'Violin', role: 'subject', rect: { x: 0.375, y: 0.235, width: 0.6, height: 0.21 } },
      { entityId: 'bow', name: 'Bow', role: 'critical', rect: { x: 0.25, y: 0.08, width: 0.56, height: 0.58 } },
    ] })
  const before = structuredClone(portrait)
  const placement = fitWallpaperPlacement(source, portrait, settings, 'subject-first-v2', [], current)
  assert.ok(placement.scale > 1.4 && placement.scale < 1.6)
  assert.equal(placement.left, 0)
  assert.equal(placement.top + Math.round(source.height * placement.scale), settings.height)
  assert.deepEqual(wallpaperGeometry(source, { ...portrait, placement }, settings, current).checks, [])
  assert.equal(fitWallpaperPlacement(source, portrait, settings, 'subject-first-v2', [], policy).scale, 1)
  const misplaced = { ...portrait, placement: { ...placement, left: 1 } }
  assert.ok(wallpaperGeometry(source, misplaced, settings, current).checks.includes('source-framing:left'))
  const impossible = wallpaperPlanSchema.parse({ ...portrait, objectRoles: portrait.objectRoles?.map(object => object.entityId === 'woman' ? { ...object, sourceIntent: { ...object.sourceIntent, layoutFocus: { x: 0.1, y: 0.07, width: 0.7, height: 0.5 } } } : object) })
  assert.throws(() => fitWallpaperPlacement(source, impossible, settings, 'subject-first-v2', [], current), /original framing/)
  assert.throws(() => fitWallpaperPlacement(source, impossible, settings, 'subject-first-v2', [], subjectFill), /original framing/)
  assert.deepEqual(portrait, before)
  const original = await sharp({ create: { ...source, channels: 3, background: '#1f8a6a' } }).png().toBuffer()
  const rendered = await renderWallpaper(original, { ...portrait, placement }, settings, undefined, 'generated-canvas-v1', current)
  assert.deepEqual([...await sharp(rendered.image).extract({ left: 10, top: placement.top + 10, width: 1, height: 1 }).removeAlpha().raw().toBuffer()], [31, 138, 106])
  const alpha = await sharp(rendered.mask).extractChannel('alpha').raw().toBuffer()
  assert.equal(alpha[(placement.top + 1) * settings.width + 1], 255)
  assert.equal(alpha[1], 0)
})
const visible = { framing: 'whole', visibility: 'visible', preserve: ['Keep the visible source object.'], relationships: [] }
const subjectFill = { version: 'source-intent-v2', minimumSubjectScaleRatio: 0.9, alignment: 'subject-fill-v1', fill: { safeOccupancy: 0.86, minimumRetainedAxis: 0.4, maximumCenterDrift: 0.08 } } satisfies WallpaperSourceLayout
const protectedFill = { ...subjectFill, fill: { ...subjectFill.fill, relativeLayout: { minimumRelativeScaleRatio: 0.8, minimumWholeAspectRatio: 0.65 } } } satisfies WallpaperSourceLayout
const damaged = { ...visible, visibility: 'damaged' }
const mainRect = { x: 0.3, y: 0.25, width: 0.4, height: 0.5 }
const product = () => wallpaperPlanSchema.parse({ version: 1, imageVersionId: 'source', mode: 'single', subject: 'Main product', evidence: 'One main product with optional peripheral props.', priorities: [], anchors: [], truncations: [], uncertainties: [],
  regions: [{ entityId: 'main', name: 'Main product', role: 'subject', rect: mainRect }],
  objectRoles: [{ entityId: 'main', name: 'Main product', role: 'primary', evidence: 'Visual lead', rect: mainRect, sourceEdges: [], sourceIntent: visible }],
  placement: { scale: 1, left: 0, top: 0 }, reason: 'Keep the original lead prominent.' })

const wideSource = { width: 1448, height: 1086 }

test('the original watercolor ribbon joins the centered protection plan and has independent final evidence', () => {
  const dancer = { entityId: 'dancer', name: 'Dancer', role: 'primary' as const, safetyClass: 'general' as const, evidence: 'Visible dancing pose', rect: { x: 0.008, y: 0.012, width: 0.521, height: 0.94 }, sourceEdges: [], sourceIntent: visible }
  const ribbon = { entityId: 'ribbon', name: 'Ribbon', role: 'supporting' as const, evidence: 'The visible ribbon follows the held wand through its free tip', rect: { x: 0.105, y: 0.012, width: 0.883, height: 0.603 }, sourceEdges: [], sourceIntent: visible }
  const { placement: _placement, ...base } = product()
  const original = { ...base, subject: 'Watercolor ribbon dancer', regions: [], sourceMedium: 'painting', objectRoles: [dancer, ribbon], editPrompt: 'Extend the unpainted surroundings while keeping the gesture and complete ribbon.' }
  const sourceSchema = wallpaperRoleObservationOutputSchema(undefined, true, true, true, undefined, true)
  assert.equal(sourceSchema.safeParse(original).success, false)
  assert.equal(sourceSchema.safeParse({ ...original, actionPartIds: ['unknown'] }).success, false)
  const plan = sourceSchema.parse({ ...original, actionPartIds: ['ribbon'] })
  assert.equal(plan.objectRoles.find(object => object.entityId === ribbon.entityId)?.role, 'critical-part')
  const current = wallpaperSettingsSchema.parse({ processing: resolveWallpaperProcessing(), sourceIntentPolicy: protectedFill })
  const placement = fitWallpaperPlacement(wideSource, plan, current, 'subject-first-v2', [], protectedFill)
  const geometry = wallpaperGeometry(wideSource, { ...plan, placement }, current, protectedFill)
  assert.deepEqual(geometry.checks, [])
  assert.ok(placement.scale >= 0.89, 'The co-protected ribbon and dancer still use the available safe span')
  const projected = geometry.regions.find(region => region.entityId === ribbon.entityId)
  assert.ok(projected && projected.left >= current.safe.left && projected.left + projected.width <= current.safe.left + current.safe.width)
  const actual = geometry.regions.map(region => ({ ...region, scope: 'core' as const, rect: { x: region.left / current.width, y: region.top / current.height, width: region.width / current.width, height: region.height / current.height } }))
  const observedRibbon = actual.find(region => region.entityId === ribbon.entityId)
  assert.ok(observedRibbon)
  const finalLayout = { ...protectedFill, expectedActionParts: [{ entityId: ribbon.entityId, name: ribbon.name, rect: observedRibbon.rect }] }
  assert.deepEqual(wallpaperActualBoundary({ imageVersionId: 'final', regions: actual }, 'single', current, finalLayout).hard, [])
  assert.ok(wallpaperActualBoundary({ imageVersionId: 'final', regions: actual.filter(region => region.entityId !== ribbon.entityId) }, 'single', current, finalLayout).hard.includes('missing-action-part:Ribbon'))
  assert.ok(wallpaperActualBoundary({ imageVersionId: 'final', regions: actual.map(region => region.entityId === ribbon.entityId ? { ...region, rect: { ...region.rect, width: region.rect.width * 0.65 } } : region) }, 'single', current, finalLayout).hard.includes('action-part-too-small:Ribbon'))

  const review = wallpaperPracticalReviewOutputSchema('source', 'final', plan.objectRoles, 'single', true)
  const retained = { result: 'satisfied', reason: 'The original feature is visible.' }
  const verdict = { reviewVersion: 'wallpaper-review-source-v4', protocol: 'practical-v2', subject: original.subject, sourceImageVersionId: 'source', outputImageVersionId: 'final', mode: 'single', defects: [], uncertainties: [], sourceStyle: retained,
    actualLayout: { regions: actual.map(({ name, entityId, role, scope, rect }) => ({ name, entityId, role, scope, rect })) },
    sourcePreservation: plan.objectRoles.map(({ entityId }) => ({ entityId, framing: retained, appearance: retained, relationships: retained })),
  }
  assert.equal(review.safeParse(verdict).success, true)
  const currentReview = wallpaperPracticalReviewOutputSchema('source', 'final', plan.objectRoles, 'single', true, true)
  const extraFocus = { ...verdict, actualLayout: { regions: verdict.actualLayout.regions.map(region => region.entityId === dancer.entityId
    ? { ...region, layoutFocus: { ...region.rect, x: region.rect.x + 0.025 } } : region) } }
  assert.equal(review.safeParse(extraFocus).success, false)
  assert.deepEqual(currentReview.parse(extraFocus).actualLayout, currentReview.parse(verdict).actualLayout)
  const frozenFocus = plan.objectRoles.map(object => object.entityId === dancer.entityId && object.sourceIntent ? { ...object, sourceIntent: { ...object.sourceIntent, layoutFocus: dancer.rect } } : object)
  assert.equal(wallpaperPracticalReviewOutputSchema('source', 'final', frozenFocus, 'single', true, true).safeParse(extraFocus).success, false)
  assert.equal(currentReview.safeParse({ ...verdict, sourcePreservation: verdict.sourcePreservation.filter(row => row.entityId !== ribbon.entityId) }).success, false)
})

test('automatic placement keeps at least forty percent of both rasterized axes at the rounding boundary', () => {
  const original = product(), rect = { x: 0.46, y: 0.5, width: 0.08, height: 0.1 }
  const plan = wallpaperPlanSchema.parse({ ...original, regions: original.regions.map(region => ({ ...region, rect })), objectRoles: original.objectRoles?.map(object => ({ ...object, rect })) })
  const current = wallpaperSettingsSchema.parse({ processing: resolveWallpaperProcessing(), sourceIntentPolicy: protectedFill })
  const placement = fitWallpaperPlacement(source, plan, current, 'subject-first-v2', [], protectedFill)
  const raster = wallpaperGeometry(source, { ...plan, placement }, current, protectedFill)
  assert.equal(raster.width, 4612)
  assert.equal(raster.backgroundCrop, true)
  assert.ok(raster.target.width / raster.width >= 0.4 && raster.target.height / raster.height >= 0.4)
  assert.deepEqual(raster.checks, [])
  const onePixelLarger = wallpaperGeometry(source, { ...plan, placement: { ...placement, scale: 2.5 } }, current, protectedFill)
  assert.equal(onePixelLarger.width, 4613)
  assert.deepEqual(onePixelLarger.checks, ['source-background-context'])
})

test('confirmed grape clusters retain extent across both axes while shortened and distorted parts fail', () => {
  const current = wallpaperSettingsSchema.parse({ processing: resolveWallpaperProcessing(), sourceIntentPolicy: protectedFill })
  const subjects = [
    { entityId: 'bear', name: 'Bear', role: 'subject' as const, scope: 'core' as const, rect: { x: 0.2, y: 0.4, width: 0.22, height: 0.33 } },
    { entityId: 'cup', name: 'Cup', role: 'subject' as const, scope: 'core' as const, rect: { x: 0.54, y: 0.39, width: 0.24, height: 0.34 } },
  ]
  const propRect = (width: number, height: number) => ({ x: 0.27, y: 0.55, width: width / current.width, height: height / current.height })
  const measure = (source: [number, number], rendered: [number, number], verified: boolean) => wallpaperActualBoundary({
    imageVersionId: 'final', regions: [...subjects, { entityId: 'prop', name: 'Held prop', role: 'critical', scope: 'core', rect: propRect(...rendered) }],
  }, 'group', current, {
    ...protectedFill,
    expectedSubjects: subjects.map(({ entityId, rect }) => ({ entityId, rect })),
    expectedActionParts: [{ entityId: 'prop', name: 'Held prop', rect: propRect(...source) }],
  }, verified ? new Set(['prop']) : undefined).hard

  assert.deepEqual(measure([445.704, 280.384], [322.875, 295.2], true), [])
  assert.deepEqual(measure([445.704, 280.384], [322.875, 295.2], false), ['action-part-too-small:Held prop'])
  assert.deepEqual(measure([445.704, 280.384], [322.875, 490], true), ['subject-aspect-changed:Held prop'])
  assert.deepEqual(measure([600, 44], [404, 44], true), ['action-part-too-small:Held prop'])
})

test('the final gate checks pairwise size, position and the aspect of complete subjects', () => {
  const subject = (entityId: string, name: string, x: number, y: number, width: number, height: number) => ({ entityId, name, role: 'subject' as const, scope: 'core' as const, rect: { x, y, width, height } })
  const person = subject('person', 'Person', 0.22, 0.42, 0.24, 0.31)
  const dog = subject('dog', 'Dog', 0.57, 0.52, 0.12, 0.14)
  const companion = subject('companion', 'Companion', 0.57, 0.42, 0.24, 0.31)
  const bottle = subject('bottle', 'Bottle', 0.4, 0.42, 0.2, 0.3)
  const current = wallpaperSettingsSchema.parse({ processing: resolveWallpaperProcessing(), sourceIntentPolicy: protectedFill })
  const measure = (expected: (typeof person)[], regions: (typeof person)[]) => wallpaperActualBoundary({ imageVersionId: 'final', regions }, expected.length === 1 ? 'single' : 'group', current, {
    ...protectedFill, expectedSubjects: expected.map(({ entityId, rect }) => ({ entityId, rect, wholeRect: rect })), reviewWholeSubjects: true,
  }).hard
  assert.deepEqual(measure([person, dog], [person, dog]), [])
  const uniform = [person, dog].map(region => ({ ...region, rect: { x: 0.5 + (region.rect.x - 0.5) * 1.05, y: 0.55 + (region.rect.y - 0.55) * 1.05, width: region.rect.width * 1.05, height: region.rect.height * 1.05 } }))
  assert.deepEqual(measure([person, dog], uniform), [])
  assert.ok(measure([person, dog], [person, subject('dog', 'Dog', 0.51, 0.45, 0.24, 0.28)]).includes('subject-relative-scale:Person · Dog'))
  assert.ok(measure([person, companion], [{ ...person, rect: companion.rect }, { ...companion, rect: person.rect }]).includes('subject-relative-position:Person · Companion'))
  assert.deepEqual(measure([bottle], [subject('bottle', 'Bottle', 0.45, 0.42, 0.1, 0.3)]), ['subject-aspect-changed:Bottle'])
})

function widePortrait() {
  const rect = { x: 0.386, y: 0.274, width: 0.272, height: 0.332 }
  const bowl = { x: 0.57, y: 0.464, width: 0.086, height: 0.095 }
  return wallpaperPlanSchema.parse({ ...product(), subject: 'A potter behind a workbench',
    objectRoles: [
      { entityId: 'main', name: 'Potter', role: 'primary', evidence: 'Visible upper body and hands', rect, sourceEdges: [], sourceIntent: { ...visible, framing: 'partial', visibility: 'occluded', layoutFocus: { x: 0.462, y: 0.282, width: 0.18, height: 0.276 } } },
      { entityId: 'bowl', name: 'Bowl', role: 'critical-part', evidence: 'The potter holds the bowl', rect: bowl, sourceEdges: [], sourceIntent: visible },
    ],
    regions: [{ entityId: 'main', name: 'Potter', role: 'subject', rect }, { entityId: 'bowl', name: 'Bowl', role: 'critical', rect: bowl }] })
}

test('a wide portrait can crop secondary background while centering the complete visible body and bowl', () => {
  const settings = wallpaperSettingsSchema.parse({ processing: resolveWallpaperProcessing(), sourceIntentPolicy: subjectFill })
  const observed = widePortrait(), before = structuredClone(observed)
  const placement = fitWallpaperPlacement(wideSource, observed, settings, 'subject-first-v2', [], subjectFill)
  const plan = { ...observed, placement }, geometry = wallpaperGeometry(wideSource, plan, settings, subjectFill)
  assert.deepEqual({ left: placement.left, top: placement.top, width: geometry.width, height: geometry.height }, expected.widePortrait)
  assert.deepEqual(geometry.checks, [])
  assert.equal(geometry.backgroundCrop, true)
  assert.ok(geometry.needsOutpaint)
  assert.ok(geometry.target.width / geometry.width >= 0.4 && geometry.target.height / geometry.height >= 0.4)
  assert.equal(geometry.regions.find(region => region.entityId === 'main')?.rect.width, 0.272)
  assert.ok(wallpaperPlacementScaleOptions(wideSource, observed, settings).maximum > placement.scale)
  assert.ok(wallpaperGeometry(wideSource, { ...plan, placement: { ...placement, left: placement.left - 1300 } }, settings, subjectFill).checks.includes('source-background-context'))
  assert.ok(wallpaperGeometry(wideSource, { ...plan, placement: { ...placement, top: placement.top - 350 } }, settings, subjectFill).checks.includes('source-crop-protected-outside'))
  assert.deepEqual(observed, before)
  const historical = { version: 'source-intent-v2', minimumSubjectScaleRatio: 0.9, alignment: 'subject-center-v1' } as const
  const old = fitWallpaperPlacement(wideSource, observed, settings, 'subject-first-v2', [], historical)
  assert.ok(old.scale < 1.28 && old.left >= 0)
})

test('a final review rejects displacement inside the safe area and a body crossing it despite an inside focus', () => {
  const settings = wallpaperSettingsSchema.parse({ processing: resolveWallpaperProcessing(), sourceIntentPolicy: subjectFill })
  const observed = widePortrait()
  const placement = fitWallpaperPlacement(wideSource, observed, settings, 'subject-first-v2', [], subjectFill)
  const reference = wallpaperPositionedLayout({ ...observed, placement }, wideSource, settings, subjectFill)
  const body = reference.positionedRegions.find(region => region.role === 'subject')
  assert.ok(body?.entityId)
  const focus = { x: body.rect.x + 0.12, y: body.rect.y + 0.12, width: 0.18, height: 0.12 }
  const policy = { ...subjectFill, reviewWholeSubjects: true as const, expectedSubjects: [{ entityId: body.entityId, rect: body.rect, focus }] }
  const measure = (pixels: number) => wallpaperActualBoundary({ imageVersionId: 'final', regions: [{
    name: body.name, entityId: body.entityId, role: 'subject', scope: 'core', rect: { ...body.rect, y: body.rect.y + pixels / settings.height },
    layoutFocus: { ...focus, y: focus.y + pixels / settings.height },
  }] }, 'single', settings, policy).hard
  assert.deepEqual(measure(0), [])
  assert.deepEqual(measure(200), ['subject-center-drift:0,200'])
  assert.ok(measure(-360).includes('critical-outside:Potter'))
})

test('a cropped portrait measures the same focus while its complete visible body stays protected', () => {
  const settings = wallpaperSettingsSchema.parse({ processing: resolveWallpaperProcessing(), sourceIntentPolicy: subjectFill })
  const plannedFocus = { x: 0.312, y: 0.429, width: 0.47, height: 0.242 }
  const body = { name: 'Potter', entityId: 'potter', role: 'subject' as const, scope: 'core' as const,
    rect: { x: 0.282, y: 0.441, width: 0.391, height: 0.271 }, layoutFocus: { x: 0.334, y: 0.441, width: 0.338, height: 0.269 } }
  const policy = { ...subjectFill, reviewWholeSubjects: true as const,
    expectedSubjects: [{ entityId: body.entityId, rect: { x: 0.201, y: 0.416, width: 0.597, height: 0.284 }, focus: plannedFocus }] }
  const measure = (region: typeof body) => wallpaperActualBoundary({ imageVersionId: 'final', regions: [region] }, 'single', settings, policy).hard
  assert.deepEqual(measure(body), [])
  assert.deepEqual(measure({ ...body, rect: { x: 0.195, y: 0.445, width: 0.535, height: 0.262 }, layoutFocus: { x: 0.198, y: 0.448, width: 0.525, height: 0.248 } }), [])
  assert.ok(measure({ ...body, layoutFocus: { ...body.layoutFocus, width: 0.3, height: 0.23 } }).includes('subject-too-small:Potter'))
  assert.ok(measure({ ...body, rect: { ...body.rect, x: 0.1, width: 0.58 } }).includes('critical-outside:Potter'))
})

test('supporting edge repairs stay local and cannot reduce the main product layout, while old tasks retain their frozen placement', () => {
  const original = product()
  const withProps = wallpaperPlanSchema.parse({ ...original, objectRoles: [...original.objectRoles ?? [],
    { entityId: 'top-prop', name: 'Top prop', role: 'supporting', evidence: 'Incidental damaged prop', rect: { x: 0.1, y: 0, width: 0.15, height: 0.1 }, sourceEdges: ['top'], sourceIntent: damaged },
    { entityId: 'bottom-prop', name: 'Bottom prop', role: 'supporting', evidence: 'Incidental damaged prop', rect: { x: 0.7, y: 0.9, width: 0.15, height: 0.1 }, sourceEdges: ['bottom'], sourceIntent: damaged },
  ] })
  const before = structuredClone(withProps)
  const mainOnly = fitWallpaperPlacement(source, original, settings, 'subject-first-v2', [], policy)
  const current = fitWallpaperPlacement(source, withProps, settings, 'subject-first-v2', [], policy)
  const historical = fitWallpaperPlacement(source, withProps, settings, 'subject-first-v2')
  assert.deepEqual(current, mainOnly)
  assert.ok(current.scale > historical.scale)
  assert.deepEqual(wallpaperSourceExtensionEdges(withProps, settings, policy), [])
  assert.deepEqual(wallpaperSourceContinuationTargets({ ...withProps, placement: current }, settings, source, policy).map(target => ({ entityId: target.entityId, disposition: target.disposition })), expected.supportingTargets)
  assert.deepEqual({ currentPlacement: current, historicalPlacement: historical }, expected.productPlacement)
  assert.deepEqual(wallpaperGeometry(source, { ...withProps, placement: current }, settings, policy).checks, [])
  assert.deepEqual(withProps, before, 'The original role bounds and source facts are not rewritten')
})

test('subject-centered layouts balance portraits and instruments without shrinking to a tiny exact-center solution', () => {
  const current = { ...policy, version: 'source-intent-v2' as const, alignment: 'subject-center-v1' as const }
  const settings = wallpaperSettingsSchema.parse({ processing: resolveWallpaperProcessing(), sourceIntentPolicy: current })
  const cases = [
    { source: { width: 1845, height: 3280 }, main: { x: 0.17, y: 0.255, width: 0.68, height: 0.585 }, focus: { x: 0.195, y: 0.255, width: 0.63, height: 0.36 }, part: { x: 0.585, y: 0.625, width: 0.125, height: 0.175 }, cropped: false, minScale: 0.8, maxScale: 0.92 },
    { source: { width: 1024, height: 1536 }, main: { x: 0.01, y: 0.075, width: 0.83, height: 0.925 }, focus: { x: 0.17, y: 0.085, width: 0.28, height: 0.22 }, part: { x: 0.33, y: 0.235, width: 0.655, height: 0.215 }, cropped: true, minScale: 1.05, maxScale: 1.3 },
  ]
  for (const item of cases) {
    const plan = wallpaperPlanSchema.parse({ ...product(), mode: 'group',
      objectRoles: [
        { entityId: 'person', name: 'Person', role: 'primary', evidence: 'The human is the visual lead.', rect: item.main, sourceEdges: item.cropped ? ['bottom'] : [], sourceIntent: { ...visible, framing: 'partial', visibility: item.cropped ? 'frame-cropped' : 'occluded', layoutFocus: item.focus } },
        { entityId: 'held', name: 'Held object', role: 'primary', evidence: 'A complete held object must remain safe.', rect: item.part, sourceEdges: [], sourceIntent: visible },
      ], regions: [{ entityId: 'person', name: 'Person', role: 'subject', rect: item.main }, { entityId: 'held', name: 'Held object', role: 'subject', rect: item.part }] })
    const frozen = structuredClone(plan)
    const placement = fitWallpaperPlacement(item.source, plan, settings, 'subject-first-v2', [], current)
    assert.ok(placement.scale > item.minScale && placement.scale < item.maxScale, JSON.stringify(placement))
    const width = Math.round(item.source.width * placement.scale), height = Math.round(item.source.height * placement.scale)
    assert.ok(Math.abs(placement.left + (item.main.x + item.main.width / 2) * width - (settings.safe.left + settings.safe.width / 2)) <= settings.safe.width * 0.01)
    const vertical = item.cropped ? item.focus : item.main
    assert.ok(Math.abs(placement.top + (vertical.y + vertical.height / 2) * height - (settings.safe.top + settings.safe.height / 2)) <= 20)
    if (item.cropped) assert.equal(placement.top + height, settings.height)
    assert.deepEqual(wallpaperGeometry(item.source, { ...plan, placement }, settings, current).checks, [])
    assert.deepEqual(plan, frozen)
  }
})

test('an intentional portrait focus may remain prominent without deleting the full source body from preservation evidence', () => {
  const originalRect = { x: 0.185, y: 0.247, width: 0.65, height: 0.563 }
  const layoutFocus = { x: 0.3, y: 0.29, width: 0.3, height: 0.3 }
  const portrait = wallpaperPlanSchema.parse({ ...product(), subject: 'Intentional partial portrait',
    regions: [{ entityId: 'person', name: 'Person', role: 'subject', rect: originalRect }],
    objectRoles: [{ entityId: 'person', name: 'Person', role: 'primary', evidence: 'Visible partial portrait behind a lectern', rect: originalRect, sourceEdges: ['bottom'], sourceIntent: { ...visible, framing: 'partial', visibility: 'occluded', layoutFocus } }],
  })
  const before = structuredClone(portrait)
  const current = fitWallpaperPlacement(source, portrait, settings, 'subject-first-v2', ['bottom'], policy)
  assert.equal(current.scale, 1)
  assert.deepEqual(wallpaperLayoutRegions(portrait, policy).map(region => region.rect), [layoutFocus])
  const layout = wallpaperPositionedLayout({ ...portrait, placement: current }, source, settings, policy)
  const outputFocus = layout.positionedRegions[0]?.rect
  assert.ok(outputFocus)
  assert.deepEqual(wallpaperSourceContinuationTargets(portrait, settings, source, policy), [])
  assert.deepEqual(wallpaperGeometry(source, { ...portrait, placement: current }, settings, policy).checks, [])
  assert.deepEqual({ placement: current, outputFocus: Object.fromEntries(Object.entries(outputFocus).map(([key, value]) => [key, Number(value.toFixed(6))])), fullSourceRect: portrait.objectRoles?.[0]?.rect }, expected.portrait)
  assert.deepEqual(portrait, before)
  assert.equal(wallpaperLayoutRegions(portrait), portrait.regions, 'Historical tasks do not opt into focus by the presence of a field')
})

test('fitting a bottom-cropped portrait positions the full visible body in the diagnostic canvas while its focus meets the safe band', async () => {
  const fullRect = { x: 0.1, y: 0.2, width: 0.8, height: 0.8 }, layoutFocus = { x: 0.3, y: 0.25, width: 0.3, height: 0.3 }
  const portrait = wallpaperPlanSchema.parse({ ...product(),
    regions: [{ entityId: 'person', name: 'Person', role: 'subject', rect: fullRect }],
    objectRoles: [{ entityId: 'person', name: 'Person', role: 'primary', evidence: 'The existing lower torso reaches the source frame.', rect: fullRect, sourceEdges: ['bottom'], sourceIntent: { ...visible, framing: 'partial', visibility: 'frame-cropped', layoutFocus } }],
    placement: { scale: 1, left: 0, top: 432 },
  })
  const before = structuredClone(portrait)
  assert.deepEqual(wallpaperGeometry(source, portrait, settings, policy).checks, ['source-clipped:Person'], 'A focus inside the safe band does not authorize discarding the visible lower torso')
  const placement = fitWallpaperPlacement(source, portrait, settings, 'subject-first-v2', [], policy)
  assert.ok(placement.scale < 1)
  assert.deepEqual(wallpaperGeometry(source, { ...portrait, placement }, settings, policy).checks, [])
  const width = Math.round(source.width * placement.scale), height = Math.round(source.height * placement.scale)
  assert.ok(placement.left + fullRect.x * width >= 0)
  assert.ok(placement.left + (fullRect.x + fullRect.width) * width <= settings.width)
  assert.ok(placement.top + fullRect.y * height >= 0)
  assert.ok(placement.top + (fullRect.y + fullRect.height) * height <= settings.height)
  const withProp = wallpaperPlanSchema.parse({ ...portrait, objectRoles: [...portrait.objectRoles ?? [], { entityId: 'prop', name: 'Incidental prop', role: 'supporting', evidence: 'A peripheral prop is not the portrait layout target.', rect: { x: 0, y: 0, width: 0.1, height: 0.1 }, sourceEdges: ['left', 'top'], sourceIntent: visible }] })
  assert.deepEqual(fitWallpaperPlacement(source, withProp, settings, 'subject-first-v2', [], policy), placement)
  assert.deepEqual(portrait, before, 'Fitting cannot rewrite the full source observation to justify a crop')
  const original = await sharp({ create: { ...source, channels: 3, background: '#1f8a6a' } }).png().toBuffer()
  const rendered = await renderWallpaper(original, { ...portrait, placement }, settings, undefined, 'generated-canvas-v1', policy)
  const left = Math.ceil(placement.left + fullRect.x * width), top = Math.ceil(placement.top + fullRect.y * height)
  const visibleBody = await sharp(rendered.image).extract({ left, top, width: Math.floor(placement.left + (fullRect.x + fullRect.width) * width) - left, height: Math.floor(placement.top + (fullRect.y + fullRect.height) * height) - top }).png().toBuffer()
  const retained = await sharp(visibleBody).stats()
  assert.deepEqual(retained.channels.slice(0, 3).map(channel => [channel.min, channel.max]), [[31, 31], [138, 138], [106, 106]], 'The diagnostic seed retains the full visible-body placement; it is not a final generated output')
})

test('partial and occluded source edges do not require subject generation or open the original mask under the frozen new policy', async () => {
  const currentSettings = wallpaperSettingsSchema.parse({ ...settings, sourceIntentPolicy: policy })
  for (const visibility of ['frame-cropped', 'occluded']) {
    const fullRect = { x: 0.3, y: 0, width: 0.4, height: 1 }, layoutFocus = { x: 0.3, y: 0.4, width: 0.4, height: 0.3 }
    const portrait = wallpaperPlanSchema.parse({ ...product(),
      truncations: ['The original lower torso is intentionally outside the frame or hidden by the lectern.'],
      regions: [{ entityId: 'person', name: 'Person', role: 'subject', rect: fullRect }],
      objectRoles: [{ entityId: 'person', name: 'Person', role: 'primary', evidence: 'Intentional upper-body source view', rect: fullRect, sourceEdges: ['top', 'bottom'], sourceIntent: { ...visible, framing: 'partial', visibility, layoutFocus } }],
    })
    assert.equal(wallpaperGeometry(source, portrait, currentSettings, policy).needsOutpaint, false)
    assert.equal(wallpaperSourceRepairNeeded(portrait, currentSettings), false)
    assert.equal(wallpaperSourceRepairNeeded(portrait, settings), true, 'Historical edge detection keeps its previous semantics')
    const opaqueMask = await sharp({ create: { width: settings.width, height: settings.height, channels: 4, background: '#ffffff' } }).png().toBuffer()
    const interiorSource = { ...portrait, placement: { scale: 0.9, left: 90, top: 128 } }
    assert.deepEqual(await wallpaperRepairMask(opaqueMask, interiorSource, currentSettings, [], source), opaqueMask)
    assert.notDeepEqual(await wallpaperRepairMask(opaqueMask, interiorSource, settings, [], source), opaqueMask, 'The omitted historical policy still permits its old edge mask')
  }
})

test('confirmed damage to a whole protected object requires authorized repair even without frame-edge or truncation text', () => {
  const currentSettings = wallpaperSettingsSchema.parse({ ...settings, sourceIntentPolicy: policy })
  const damagedProduct = wallpaperPlanSchema.parse({ ...product(), objectRoles: product().objectRoles?.map(object => ({ ...object, sourceIntent: damaged })) })
  assert.deepEqual(damagedProduct.truncations, [])
  assert.deepEqual(damagedProduct.objectRoles?.flatMap(object => object.sourceEdges), [])
  assert.equal(wallpaperSourceRepairNeeded(damagedProduct, currentSettings), true)
  assert.equal(wallpaperSourceRepairNeeded(damagedProduct, settings), false, 'Historical detection does not adopt new source facts')
  const preserveSettings = wallpaperSettingsSchema.parse({ ...currentSettings, repairPolicy: { mode: 'preserve' } })
  assert.equal(wallpaperSourceRepairNeeded(damagedProduct, preserveSettings), false)
  const supporting = wallpaperPlanSchema.parse({ ...damagedProduct, mode: 'scene', regions: [], objectRoles: damagedProduct.objectRoles?.map(object => ({ ...object, role: 'supporting' })) })
  assert.equal(wallpaperSourceRepairNeeded(supporting, currentSettings), false, 'Incidental damage cannot authorize whole-source regeneration')
})

test('a large co-primary cannot hide a shrunken companion and the companion retains its intentionally smaller planned size', () => {
  const main = { name: 'Main', entityId: 'main', role: 'subject' as const, scope: 'core' as const, rect: { x: 0.3, y: 0.4, width: 0.35, height: 0.3 } }
  const companion = { name: 'Companion', entityId: 'companion', role: 'subject' as const, scope: 'core' as const, rect: { x: 0.7, y: 0.6, width: 0.005, height: 0.005 } }
  const expectedCompanion = { ...companion.rect, width: 0.12, height: 0.16 }
  const sourceLayout = { ...policy, expectedSubjects: [{ entityId: 'main', rect: main.rect }, { entityId: 'companion', rect: expectedCompanion }] }
  const layout = { imageVersionId: 'output', regions: [main, companion] }
  const current = wallpaperActualBoundary(layout, 'group', settings, sourceLayout)
  assert.deepEqual(wallpaperActualBoundary(layout, 'group', settings).hard, [], 'The old aggregate-only gate remains readable for historical tasks')
  assert.deepEqual(current.hard, expected.shrunkenCompanion)
  assert.deepEqual(wallpaperActualBoundary({ ...layout, regions: [main, { ...companion, rect: expectedCompanion }] }, 'group', settings, sourceLayout).hard, [])
  assert.deepEqual(wallpaperActualBoundary(layout, 'group', settings, { ...policy, expectedSubjects: [{ entityId: 'main', rect: main.rect }, { entityId: 'companion', rect: companion.rect }] }).hard, [], 'A source-intended small companion does not inherit the larger main subject target')
})

test('V2 size retention measures the main extent instead of treating a different minor-axis observation as uniform shrinkage', () => {
  const current = { ...policy, version: 'source-intent-v2' as const, expectedSubjects: [{ entityId: 'violin', rect: { x: 0.3, y: 0.45, width: 0.55, height: 0.155 } }] }
  const violin = { name: 'Violin', entityId: 'violin', role: 'subject' as const, scope: 'core' as const, rect: { x: 0.3, y: 0.45, width: 0.52, height: 0.1 } }
  const layout = { imageVersionId: 'output', regions: [violin] }
  assert.ok(wallpaperActualBoundary(layout, 'single', settings, { ...current, version: 'source-intent-v1' }).hard.includes('subject-too-small:Violin'))
  assert.deepEqual(wallpaperActualBoundary(layout, 'single', settings, current).hard, [])
  const shrunken = { ...violin, rect: { ...violin.rect, width: 0.3, height: 0.06 } }
  assert.ok(wallpaperActualBoundary({ ...layout, regions: [shrunken] }, 'single', settings, current).hard.includes('subject-too-small:Violin'))
})

test('actual output focus drives new layout checks while full bodies and complete automobiles remain independently recorded', () => {
  const layoutFocus = { x: 0.3, y: 0.42, width: 0.25, height: 0.3 }
  const person = { name: 'Person', entityId: 'person', role: 'subject' as const, scope: 'core' as const, rect: { x: 0.2, y: 0.25, width: 0.65, height: 0.7 }, layoutFocus }
  const layout = { imageVersionId: 'output', regions: [person] }, before = structuredClone(layout)
  assert.ok(wallpaperActualBoundary(layout, 'single', settings).hard.includes('subject-overflow:Person'))
  assert.deepEqual(wallpaperActualBoundary(layout, 'single', settings, { ...policy, expectedSubjects: [{ entityId: 'person', rect: layoutFocus }] }).hard, [])
  assert.deepEqual(layout, before)
  const car = { ...person, name: 'Automobile', safetyClass: 'automobile' as const }
  assert.ok(wallpaperActualBoundary({ imageVersionId: 'output', regions: [car] }, 'single', settings, policy).hard.includes('automobile-outside:Automobile'))
})

test('new source intent authorizes only confirmed whole damaged structures, not partial views, occlusion or unknown source facts', () => {
  const original = product()
  const main = original.objectRoles?.[0]
  assert.ok(main)
  const frameObject = { ...main, rect: { x: 0.3, y: 0.5, width: 0.4, height: 0.5 }, sourceEdges: ['bottom'] }
  for (const intent of [visible, { ...visible, framing: 'partial', visibility: 'frame-cropped' }, { ...visible, framing: 'close-up', visibility: 'occluded' }, { ...visible, framing: 'uncertain', visibility: 'uncertain' }]) {
    const plan = wallpaperPlanSchema.parse({ ...original, objectRoles: [{ ...frameObject, sourceIntent: intent }] })
    assert.deepEqual(wallpaperSourceExtensionEdges(plan, settings, policy), [])
    assert.deepEqual(wallpaperSourceContinuationTargets(plan, settings, source, policy), [])
  }
  const damagedPlan = wallpaperPlanSchema.parse({ ...original, objectRoles: [{ ...frameObject, sourceIntent: damaged }] })
  assert.deepEqual(wallpaperSourceExtensionEdges(damagedPlan, settings, policy), ['bottom'])
  assert.deepEqual(wallpaperSourceExtensionEdges(damagedPlan, wallpaperSettingsSchema.parse({ ...settings, repairPolicy: { mode: 'preserve' } }), policy), [])
})

test('candidate layout correction locates the actual output focus without reusing original source coordinates or a same-entity critical detail', () => {
  const plan = wallpaperPlanSchema.parse({ ...product(), objectRoles: [{ entityId: 'main', name: 'Person', role: 'primary', evidence: 'Intentional partial portrait', rect: mainRect, sourceEdges: [], sourceIntent: { ...visible, framing: 'partial', layoutFocus: { x: 0.4, y: 0.3, width: 0.2, height: 0.2 } } }] })
  const actualRect = { x: 0.15, y: 0.2, width: 0.7, height: 0.75 }, actualFocus = { x: 0.2, y: 0.25, width: 0.25, height: 0.3 }
  const review = wallpaperStoredSourceReviewV4Schema.parse({ reviewVersion: 'wallpaper-review-source-v4', subject: 'Same portrait needing repositioning',
    checks: Object.fromEntries([...wallpaperReviewKeys, 'clarity'].map(key => [key, { result: key === 'protection' ? 'violated' : 'satisfied', reason: 'Actual output evidence' }])),
    layoutChecks: ['subject-overflow:Person'], layoutWarnings: [], modelProtectionCheck: { result: 'violated', reason: 'Focus is too high' }, modelIssues: [],
    issues: [{ kind: 'layout', check: 'protection', code: 'other', reason: 'Focus is too high' }], styleResults: [], sourceRepair: { result: 'satisfied', reason: 'No body was added' }, sourceCorrespondence: { result: 'satisfied', reason: 'Appearance and framing retained' },
    subjectIntegrity: { mode: 'single', source: { extent: 'complete', imageVersionId: 'source', reason: 'Intentional source view' }, output: { extent: 'complete', imageVersionId: 'candidate', reason: 'Same visible body scope' }, task: { result: 'satisfied', reason: 'Healthy source content retained' } },
    actualLayout: { imageVersionId: 'candidate', regions: [
      { entityId: 'main', name: 'Small face detail', role: 'critical', scope: 'core', rect: { x: 0.25, y: 0.3, width: 0.05, height: 0.05 } },
      { entityId: 'main', name: 'Person', role: 'subject', scope: 'core', rect: actualRect, layoutFocus: actualFocus },
    ] },
  })
  const before = structuredClone(plan)
  const corrected = wallpaperCandidatePlacement({ plan, review, outputId: 'candidate', compositionMode: 'generated-canvas-v1' }, settings, policy)
  assert.ok(corrected)
  assert.equal(corrected.imageVersionId, 'candidate')
  assert.deepEqual(corrected.objectRoles?.[0]?.rect, actualRect)
  assert.deepEqual(corrected.objectRoles?.[0]?.sourceIntent?.layoutFocus, actualFocus)
  assert.deepEqual(plan, before)
})
