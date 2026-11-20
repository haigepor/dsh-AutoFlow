/** Source-framing conflicts retain actionable evidence and recover without authorizing anatomy changes. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { z } from 'zod'
import { wallpaperFramingObservationSchema, wallpaperSettingsSchema, wallpaperStateSchema, wallpaperViewSchema, type WallpaperFramingObservation } from '../src/shared/wallpaper.ts'
import { resolveWallpaperProcessing, wallpaperRepairPolicySchema } from '../src/shared/wallpaper-policy.ts'
import { wallpaperFramingDetailRects, wallpaperFramingInspectionSchema, applyWallpaperFramingInspection, wallpaperUnverifiedFramingEdges, wallpaperVerifiedPeripheralEdges } from '../src/shared/wallpaper-framing.ts'
import { fitWallpaperPlacement, wallpaperGeometry, wallpaperSourceFrameContacts, wallpaperFrameSafetyConflict, WallpaperFramingConflictError } from '../src/shared/wallpaper-geometry.ts'
import { wallpaperFramingAnnotation } from '../src/media/wallpaper-render.ts'
import { dataOf, specOf, toJson } from '../src/host/runtime.ts'
import { wallpaperActualBoundary } from '../src/host/wallpaper-boundary.ts'
import { wallpaperRecovery } from '../src/client/wallpaper-recovery.ts'
import { imageWorkflowGallery } from '../src/client/workflow-image-branches.ts'
import { serviceFixture } from './helpers/service-fixture.ts'

function observation(imageVersionId = 'watercolor'): WallpaperFramingObservation {
  const objects = [
    { entityId: 'woman', name: 'Woman', role: 'primary', safetyClass: 'general', evidence: 'Visible half-length painted figure', rect: { x: 0, y: 0.14, width: 0.85, height: 0.86 }, sourceEdges: ['left','bottom'], sourceIntent: { framing: 'partial', visibility: 'frame-cropped', preserve: ['Retain the head, hands and original visible pose without adding limbs'], relationships: ['Holds the violin and bow'], layoutFocus: { x: 0.14, y: 0.14, width: 0.34, height: 0.6 } } },
    { entityId: 'violin', name: 'Violin', role: 'primary', safetyClass: 'general', evidence: 'Complete held violin', rect: { x: 0.42, y: 0.355, width: 0.57, height: 0.18 }, sourceEdges: [], sourceIntent: { framing: 'whole', visibility: 'occluded', preserve: ['Retain the complete visible instrument'], relationships: ['Held under the chin'] } },
    { entityId: 'bow', name: 'Bow', role: 'critical-part', safetyClass: 'general', evidence: 'Complete visible bow', rect: { x: 0.2, y: 0.22, width: 0.68, height: 0.55 }, sourceEdges: [], sourceIntent: { framing: 'whole', visibility: 'visible', preserve: ['Retain both visible ends'], relationships: ['Held by the right hand'] } },
  ]
  return wallpaperFramingObservationSchema.parse({ version: 1, imageVersionId, mode: 'group', subject: 'Watercolor violin portrait', evidence: 'The original left sleeve and waist are cut by the frame.', priorities: [], anchors: [], truncations: ['Original left and bottom cuts'], uncertainties: [], objectRoles: objects, regions: objects.map(object => ({ entityId: object.entityId, name: object.name, role: object.role === 'primary' ? 'subject' : 'critical', rect: object.rect, safetyClass: object.safetyClass })), sourceMedium: 'painting', reason: 'Preserve visible framing', editPrompt: 'Extend only the watercolor background; never add anatomy.' })
}

function rainCloseUp(imageVersionId = 'rain') {
  const rect = { x: 0, y: 0.03, width: 0.99, height: 0.97 }
  return wallpaperFramingObservationSchema.parse({ ...observation(imageVersionId), subject: 'Rain close-up', mode: 'single', sourceMedium: 'photograph',
    objectRoles: [{ entityId: 'woman', name: 'Woman', role: 'primary', safetyClass: 'general', evidence: 'Head and shoulder close-up.',
      rect, sourceEdges: ['left', 'bottom'], sourceIntent: { framing: 'close-up', visibility: 'frame-cropped', preserve: ['Keep the hair and original framing.'], relationships: [], layoutFocus: { x: 0.4, y: 0.08, width: 0.5, height: 0.55 } } }],
    regions: [{ entityId: 'woman', name: 'Woman', role: 'subject', safetyClass: 'general', rect }],
  })
}

function portraitWithFeasibleBottom(imageVersionId?: string) {
  const observed = observation(imageVersionId)
  const shorterBow = { x: 0.2, y: 0.22, width: 0.68, height: 0.43 }
  return { ...observed, objectRoles: observed.objectRoles.map(row => row.entityId === 'bow' ? { ...row, rect: shorterBow } : row),
    regions: observed.regions.map(row => row.entityId === 'bow' ? { ...row, rect: shorterBow } : row) }
}

function singlePeripheralContact(imageVersionId: string): WallpaperFramingObservation {
  const observed = portraitWithFeasibleBottom(imageVersionId)
  const woman = observed.objectRoles.find(object => object.entityId === 'woman')!
  woman.sourceEdges = ['left']
  woman.rect = { ...woman.rect, height: 0.75 }
  return { ...observed, regions: observed.regions.map(region => region.entityId === 'woman' ? { ...region, rect: woman.rect } : region) }
}

const settings = wallpaperSettingsSchema.parse({ processing: resolveWallpaperProcessing(), sourceIntentPolicy: { version: 'source-intent-v2', minimumSubjectScaleRatio: 0.9, alignment: 'subject-center-v1' } })
const source = { width: 1024, height: 1536 }
const findings = (observed: WallpaperFramingObservation, detailIds: string[], corrected = false) => observed.objectRoles.map(object => ({
  entityId: object.entityId,
  rect: corrected ? object.entityId === 'woman' ? { x: 0, y: 0.06, width: 0.87, height: 0.94 } : object.entityId === 'violin' ? { x: 0.375, y: 0.235, width: 0.6, height: 0.21 } : { x: 0.25, y: 0.08, width: 0.56, height: 0.58 } : object.rect,
  sourceEdges: object.sourceEdges,
  ...(object.sourceIntent.layoutFocus ? { layoutFocus: corrected ? { x: 0.2, y: 0.07, width: 0.6, height: 0.5 } : object.sourceIntent.layoutFocus } : {}),
  evidenceImageVersionIds: detailIds, reason: 'Compared the visible source pixels and real crop.',
}))

test('confirmed car frame cuts cannot be bypassed by calling the view whole', () => {
  const rect = { x: 0, y: 0.02, width: 1, height: 0.83 }
  const observed = wallpaperFramingObservationSchema.parse({ ...observation(), mode: 'single', sourceMedium: 'photograph',
    objectRoles: [{ entityId: 'car', name: 'Car', role: 'primary', safetyClass: 'automobile', evidence: 'Three frame cuts are visible.',
      rect, sourceEdges: ['left', 'top', 'right'], sourceIntent: { framing: 'whole', visibility: 'frame-cropped', preserve: ['Keep the source framing.'], relationships: [] } }],
    regions: [{ entityId: 'car', name: 'Car', role: 'subject', safetyClass: 'automobile', rect }],
  })
  assert.throws(() => fitWallpaperPlacement(source, observed, settings, 'subject-first-v2', [], settings.sourceIntentPolicy), error => {
    assert.ok(error instanceof WallpaperFramingConflictError)
    assert.deepEqual(error.diagnostics.edges, ['left', 'top', 'right'])
    return true
  })
  assert.doesNotThrow(() => fitWallpaperPlacement(source, observed, settings, 'subject-first-v2'))
})

test('final framing uses the full actual body regardless of the safe focus', () => {
  const sourceLayout = { version: 'source-intent-v2' as const, minimumSubjectScaleRatio: 0.9, expectedFrameContacts: wallpaperSourceFrameContacts(observation(), settings.sourceIntentPolicy) }
  const layoutFocus = { x: 0.4, y: 0.4, width: 0.23, height: 0.25 }
  const rect = { x: 0, y: 0.38, width: 0.75, height: 0.62 }
  const actual = (body: typeof rect) => ({ imageVersionId: 'output', regions: [{ entityId: 'woman', name: 'Woman', role: 'subject' as const, scope: 'core' as const, rect: body, layoutFocus }] })
  assert.deepEqual(wallpaperActualBoundary(actual(rect), 'single', settings, sourceLayout).hard, ['subject-overflow:Woman'])
  const opened = { x: 0.23, y: 0.38, width: 0.52, height: 0.42 }
  assert.deepEqual(wallpaperActualBoundary(actual(opened), 'single', settings, sourceLayout).hard, ['source-frame-lost:left:Woman', 'source-frame-lost:bottom:Woman'])
  assert.deepEqual(wallpaperActualBoundary(actual(opened), 'single', settings, { ...sourceLayout, expectedFrameContacts: [] }).hard, [])
})

test('an existing left crop permits trimming only the opposite background when whole-source placement has no fit', () => {
  const source = { width: 1536, height: 1024 }
  const sourceIntent = { framing: 'partial' as const, preserve: ['Keep both visible subjects.'], relationships: [] }
  const adult = { x: 0, y: 0.155, width: 0.37, height: 0.685 }, pup = { x: 0.257, y: 0.384, width: 0.335, height: 0.508 }
  const observed = wallpaperFramingObservationSchema.parse({ ...observation(), subject: 'Otters', sourceMedium: 'illustration',
    objectRoles: [
      { entityId: 'adult', name: 'Adult otter', role: 'primary', safetyClass: 'general', evidence: 'Adult body cut on left.', rect: adult, sourceEdges: ['left'],
        sourceIntent: { ...sourceIntent, visibility: 'frame-cropped', layoutFocus: { x: 0.085, y: 0.16, width: 0.285, height: 0.64 } } },
      { entityId: 'pup', name: 'Otter pup', role: 'primary', safetyClass: 'general', evidence: 'Pup sheltered next to adult.', rect: pup, sourceEdges: [],
        sourceIntent: { ...sourceIntent, visibility: 'occluded', layoutFocus: { x: 0.268, y: 0.388, width: 0.225, height: 0.41 } } },
    ],
    regions: [{ entityId: 'adult', name: 'Adult otter', role: 'subject', safetyClass: 'general', rect: adult },
      { entityId: 'pup', name: 'Otter pup', role: 'subject', safetyClass: 'general', rect: pup }],
  })
  const policy = { version: 'source-intent-v2' as const, minimumSubjectScaleRatio: 0.9, alignment: 'subject-fill-v1' as const,
    fill: { safeOccupancy: 0.86, maximumCenterDrift: 0.08, minimumRetainedAxis: 0.4, relativeLayout: { minimumRelativeScaleRatio: 0.8, minimumWholeAspectRatio: 0.65 } } }
  const placement = fitWallpaperPlacement(source, observed, settings, 'subject-first-v2', [], policy)
  const geometry = wallpaperGeometry(source, { ...observed, placement }, settings, policy)
  assert.deepEqual(geometry.checks, [])
  assert.equal(geometry.backgroundCrop, true)
  assert.equal(geometry.reviewWholeSubjects, false)
  assert.equal(geometry.left, 0)
  assert.equal(geometry.target.height, geometry.height)
  assert.ok(geometry.target.width < geometry.width)
  assert.ok(geometry.regions.every(region => region.left >= settings.safe.left && region.left + region.width <= settings.safe.left + settings.safe.width))
  assert.ok(wallpaperGeometry(source, { ...observed, placement: { ...placement, top: -1 } }, settings, policy).checks.includes('source-background-crop-unavailable'))
  assert.throws(() => fitWallpaperPlacement(source, observed, settings, 'subject-first-v2', [], { ...policy, fill: { ...policy.fill, minimumRetainedAxis: 0.7 } }), WallpaperFramingConflictError)
})

test('a cropped portrait reports incompatible scale limits without changing the source or safety template', () => {
  const observed = observation(), original = structuredClone(observed), frozen = structuredClone(settings)
  assert.throws(() => fitWallpaperPlacement(source, observed, settings, 'subject-first-v2', [], settings.sourceIntentPolicy), error => {
    assert.ok(error instanceof WallpaperFramingConflictError)
    assert.equal(error.code, 'source-framing-conflict')
    assert.equal(error.diagnostics.minimumScale.toFixed(3), '1.967')
    assert.equal(error.diagnostics.maximumScale?.toFixed(3), ((1587 - 24 - 282) / ((0.99 - 0.14) * 1024)).toFixed(3))
    assert.deepEqual(error.diagnostics.edges, ['left','bottom'])
    assert.ok(error.diagnostics.limits.every(limit => limit.axis === 'horizontal'))
    return true
  })
  assert.deepEqual(observed, original); assert.deepEqual(settings, frozen)
  const crops = wallpaperFramingDetailRects(observed)
  assert.ok(crops.length >= 2 && crops[0]?.x === 0 && crops.some(crop => crop.y + crop.height === 1))
})

test('a framing hold adapts only a locally verified peripheral edge and keeps the other cut', () => {
  const observed = portraitWithFeasibleBottom(), original = structuredClone(observed)
  const active = wallpaperSettingsSchema.parse({ ...settings, sourceIntentPolicy: {
    version: 'source-intent-v2', alignment: 'subject-fill-v1', peripheralFrameAdaptation: 'verified-v2', fill: { relativeLayout: {} },
  } })
  const sourceLayout = active.sourceIntentPolicy
  const [left, bottom] = wallpaperFramingDetailRects(observed)
  assert.ok(left && bottom)
  const crops = [{ imageVersionId: 'left-crop', sourceRect: left }, { imageVersionId: 'bottom-crop', sourceRect: bottom }]
  const ids = ['left-crop', 'bottom-crop']
  const withAssessment = (cropImageVersionId: string) => ({
    version: 'wallpaper-source-framing-v1', imageVersionId: observed.imageVersionId, result: 'confirmed', reason: 'Source crop was inspected.',
    findings: findings(observed, ids).map(row => ({ ...row, peripheralEdges: row.entityId === 'woman' ? [{ edge: 'left', detail: 'clothing-edge', cropImageVersionId }] : [] })),
  })
  const v2 = wallpaperFramingInspectionSchema(observed, ids, 'verified-v2')
  const omitted = { ...withAssessment('left-crop'), findings: findings(observed, ids) }
  assert.equal(v2.safeParse(omitted).success, false, 'Every entity in a new inspection requires an explicit assessment')
  assert.equal(wallpaperFramingInspectionSchema(observed, ids, 'verified-v1').safeParse(omitted).success, true, 'The former protocol can still replay its optional assessment')
  const result = (cropImageVersionId: string) => v2.parse(withAssessment(cropImageVersionId))
  const wrong = wallpaperVerifiedPeripheralEdges(observed, result('bottom-crop').findings, crops)
  assert.deepEqual(wrong, [])
  assert.throws(() => fitWallpaperPlacement(source, observed, active, 'subject-first-v2', [], sourceLayout, wrong), WallpaperFramingConflictError)
  const approved = wallpaperVerifiedPeripheralEdges(observed, result('left-crop').findings, crops)
  assert.deepEqual(approved, [{ entityId: 'woman', edge: 'left', detail: 'clothing-edge' }])
  const car = { ...observed, objectRoles: observed.objectRoles.map(object => object.entityId === 'woman' ? { ...object, safetyClass: 'automobile' as const } : object) }
  assert.deepEqual(wallpaperVerifiedPeripheralEdges(car, result('left-crop').findings, crops), [])
  assert.throws(() => fitWallpaperPlacement(source, observed, settings, 'subject-first-v2', [], settings.sourceIntentPolicy, approved), WallpaperFramingConflictError)
  const placement = fitWallpaperPlacement(source, observed, active, 'subject-first-v2', [], sourceLayout, approved)
  const plan = { ...observed, placement }
  assert.deepEqual(placement.adaptedSourceEdges, approved)
  assert.ok(placement.left > 0)
  assert.equal(placement.top + Math.round(source.height * placement.scale), active.height)
  assert.deepEqual(wallpaperSourceFrameContacts(plan, sourceLayout).map(contact => contact.edge), ['bottom'])
  assert.deepEqual(wallpaperGeometry(source, plan, active, sourceLayout).checks, [])
  assert.deepEqual(wallpaperGeometry(source, { ...plan, placement: { ...placement, top: placement.top - 1 } }, active, sourceLayout).checks, ['source-framing:bottom'])
  assert.deepEqual(observed, original)
})

test('native contact review accounts for each real cut without relaxing other source edges', () => {
  const observed = portraitWithFeasibleBottom()
  const { sourceIntentPolicy, ...base } = settings
  const active = wallpaperSettingsSchema.parse({ ...base, sourceIntentPolicy: {
    version: 'source-intent-v2', alignment: 'subject-fill-v1', peripheralFrameAdaptation: 'verified-v4', fill: { relativeLayout: {} },
  } })
  const [left, bottom] = wallpaperFramingDetailRects(observed)
  assert.ok(left && bottom)
  const crops = [{ imageVersionId: 'left-crop', sourceRect: left }, { imageVersionId: 'bottom-crop', sourceRect: bottom }]
  const ids = crops.map(crop => crop.imageVersionId)
  const sourceFindings = findings(observed, ids)
  const confirmed = { version: 'wallpaper-source-framing-v1', imageVersionId: observed.imageVersionId, result: 'confirmed', reason: 'The native crops show a fabric contact on the left and the original intentional half-body cut at the bottom.' }
  const old = { ...confirmed, findings: sourceFindings.map(row => ({ ...row, peripheralEdges: [] })) }
  assert.equal(wallpaperFramingInspectionSchema(observed, ids, 'verified-v3', crops).safeParse(old).success, true)
  const schema = wallpaperFramingInspectionSchema(observed, ids, 'verified-v4', crops)
  assert.equal(schema.safeParse(old).success, false)
  const lateral = { edge: 'left', kind: 'peripheral', detail: 'clothing-edge', cropImageVersionId: 'left-crop' }
  const lower = { edge: 'bottom', kind: 'keep-contact' }
  const response = (frameEdgeAssessments: readonly object[]) => ({
    ...confirmed, findings: sourceFindings.map(row => ({ ...row, frameEdgeAssessments: row.entityId === 'woman' ? frameEdgeAssessments : [] })),
  })
  for (const invalid of [[], [lower], [lateral, lateral], [{ ...lateral, cropImageVersionId: 'bottom-crop' }, lower]]) {
    assert.equal(schema.safeParse(response(invalid)).success, false)
  }
  const parsed = schema.parse(response([lateral, lower]))
  assert.deepEqual(schema.parse(parsed), parsed)
  const corrected = applyWallpaperFramingInspection(observed, parsed.findings, 'verified-v4', crops)
  const adapted = wallpaperVerifiedPeripheralEdges(corrected, parsed.findings, crops)
  const unresolved = schema.parse(response([{ edge: 'left', kind: 'uncertain' }, lower]))
  assert.deepEqual(wallpaperVerifiedPeripheralEdges(corrected, unresolved.findings, crops), [])
  assert.throws(() => fitWallpaperPlacement(source, observed, settings, 'subject-first-v2', [], sourceIntentPolicy), WallpaperFramingConflictError)
  const placement = fitWallpaperPlacement(source, corrected, active, 'subject-first-v2', [], active.sourceIntentPolicy, adapted)
  assert.deepEqual(placement.adaptedSourceEdges, [{ entityId: 'woman', edge: 'left', detail: 'clothing-edge' }])
  const plan = { ...corrected, placement }
  assert.deepEqual(wallpaperSourceFrameContacts(plan, active.sourceIntentPolicy).map(contact => contact.edge), ['bottom'])
  assert.deepEqual(wallpaperGeometry(source, plan, active, active.sourceIntentPolicy).checks, [])
})

test('verified peripheral crops can refine a whole assembly that is cropped at the frame', () => {
  const rect = { x: 0, y: 0.01, width: 1, height: 0.99 }
  const sourceEdges = ['left', 'right', 'bottom']
  const entityId = 'station'
  const preserve = ['Retain the main ring, central modules and connected trusses.']
  const relationships = ['Both outer panel arrays attach to the central structure.']
  const layoutFocus = { x: 0.23, y: 0.01, width: 0.66, height: 0.74 }
  const observed = wallpaperFramingObservationSchema.parse({ ...observation('station-source'), mode: 'single', sourceMedium: 'illustration', subject: 'Orbital station',
    objectRoles: [{ entityId, name: 'Orbital station', role: 'primary', safetyClass: 'general', rect, sourceEdges, evidence: 'The main ring and modules are visible with outer panel arrays cut by the frame.', sourceIntent: { framing: 'whole', visibility: 'frame-cropped', preserve, relationships } }],
    regions: [{ entityId, name: 'Orbital station', role: 'subject', safetyClass: 'general', rect }],
  })
  const original = structuredClone(observed)
  const nativeSize = { width: 1672, height: 941 }, cropTop = 9 / nativeSize.height, cropBottom = 475 / nativeSize.height
  const crops = [
    { imageVersionId: 'left', sourceRect: { x: 0, y: cropTop, width: 0.5, height: 1 - cropTop } },
    { imageVersionId: 'right', sourceRect: { x: 0.5, y: cropTop, width: 0.5, height: 1 - cropTop } },
    { imageVersionId: 'bottom', sourceRect: { x: 0, y: cropBottom, width: 1, height: 1 - cropBottom } },
  ]
  const ids = crops.map(crop => crop.imageVersionId)
  const peripheralEdges = sourceEdges.map(edge => ({ edge, detail: 'repeat-structure-edge', cropImageVersionId: edge }))
  const finding = { entityId, rect, layoutFocus, sourceEdges, peripheralEdges, evidenceImageVersionIds: ids, reason: 'The native edge crops show repeated panel sections crossing the outer frame. The main ring, hubs and connecting trusses are inside the frame.' }
  const response = { version: 'wallpaper-source-framing-v1', imageVersionId: observed.imageVersionId, result: 'corrected', reason: 'The core is intact, while peripheral sections reach the real frame.', findings: [finding] }
  const active = wallpaperSettingsSchema.parse({ ...settings, sourceIntentPolicy: {
    version: 'source-intent-v2', alignment: 'subject-fill-v1', peripheralFrameAdaptation: 'verified-v3', fill: { relativeLayout: {} },
  } })
  assert.equal(wallpaperFramingInspectionSchema(observed, ids, 'verified-v2', crops).safeParse(response).success, false)
  const schema = wallpaperFramingInspectionSchema(observed, ids, 'verified-v3', crops)
  assert.equal(schema.safeParse({ ...response, findings: [{ ...finding, layoutFocus: undefined }] }).success, false)
  assert.equal(schema.safeParse({ ...response, findings: [{ ...finding, layoutFocus: rect }] }).success, false)
  assert.equal(schema.safeParse({ ...response, findings: [{ ...finding, peripheralEdges: peripheralEdges.slice(0, 2) }] }).success, false)
  assert.equal(schema.safeParse({ ...response, findings: [{ ...finding, peripheralEdges: peripheralEdges.map(row => row.edge === 'left' ? { ...row, cropImageVersionId: 'right' } : row) }] }).success, false)
  const car = { ...observed, objectRoles: observed.objectRoles.map(object => ({ ...object, safetyClass: 'automobile' as const })) }
  assert.equal(wallpaperFramingInspectionSchema(car, ids, 'verified-v3', crops).safeParse(response).success, false)
  const parsed = schema.parse(response)
  const refined = applyWallpaperFramingInspection(observed, parsed.findings, 'verified-v3', crops)
  assert.deepEqual(refined.objectRoles[0]?.sourceIntent, { framing: 'partial', visibility: 'frame-cropped', preserve, relationships, layoutFocus })
  assert.deepEqual(refined.objectRoles[0]?.rect, rect)
  assert.deepEqual(refined.objectRoles[0]?.sourceEdges, sourceEdges)
  assert.throws(() => fitWallpaperPlacement(nativeSize, observed, active, 'subject-first-v2', [], active.sourceIntentPolicy), WallpaperFramingConflictError)
  const edges = wallpaperVerifiedPeripheralEdges(refined, parsed.findings, crops)
  assert.deepEqual(edges.map(row => row.edge), sourceEdges)
  const placement = fitWallpaperPlacement(nativeSize, refined, active, 'subject-first-v2', [], active.sourceIntentPolicy, edges)
  assert.deepEqual(placement.adaptedSourceEdges?.map(row => row.edge), ['right', 'bottom'])
  assert.deepEqual(wallpaperGeometry(nativeSize, { ...refined, placement }, active, active.sourceIntentPolicy).checks, [])
  const { peripheralEdges: peripheral, ...measured } = finding
  const classified = wallpaperFramingInspectionSchema(observed, ids, 'verified-v4', crops).parse({
    ...response, findings: [{ ...measured, frameEdgeAssessments: peripheral.map(edge => ({ ...edge, kind: 'peripheral' })) }],
  })
  const current = applyWallpaperFramingInspection(observed, classified.findings, 'verified-v4', crops)
  assert.deepEqual(current, refined)
  assert.deepEqual(wallpaperVerifiedPeripheralEdges(current, classified.findings, crops), edges)
  assert.deepEqual(observed, original)
})

test('a crop-bound reread can correct boxes while retaining every entity, source cut and preservation requirement', () => {
  const observed = observation(), old = structuredClone(observed), schema = wallpaperFramingInspectionSchema(observed, ['crop-left'])
  const returned = findings(observed, [observed.imageVersionId, 'crop-left'], true).map(row => row.entityId === 'violin' ? { ...row, layoutFocus: row.rect } : row)
  const parsed = schema.parse({ version: 'wallpaper-source-framing-v1', imageVersionId: observed.imageVersionId, result: 'corrected', reason: 'The source geometry was reread.', findings: returned })
  assert.ok(parsed.findings.every(finding => finding.evidenceImageVersionIds.length === 1 && finding.evidenceImageVersionIds[0] === 'crop-left'))
  assert.deepEqual(schema.parse(parsed), parsed, 'A committed response can be replayed using the same strict schema')
  const corrected = applyWallpaperFramingInspection(observed, parsed.findings)
  assert.equal(corrected.objectRoles.find(object => object.entityId === 'violin')?.sourceIntent.layoutFocus, undefined)
  const plan = { ...corrected, placement: fitWallpaperPlacement(source, corrected, settings, 'subject-first-v2', [], settings.sourceIntentPolicy) }
  assert.deepEqual(wallpaperGeometry(source, plan, settings, settings.sourceIntentPolicy).checks, [])
  assert.equal(plan.placement.left, 0)
  assert.equal(plan.placement.top + Math.round(source.height * plan.placement.scale), settings.height)
  assert.deepEqual(corrected.objectRoles.map(object => [object.entityId, object.role, object.sourceIntent.preserve, object.sourceIntent.relationships]), observed.objectRoles.map(object => [object.entityId, object.role, object.sourceIntent.preserve, object.sourceIntent.relationships]))
  assert.deepEqual(observed, old)
  const invalid = { ...parsed, findings: parsed.findings.slice(1) }
  assert.equal(schema.safeParse(invalid).success, false)
  assert.equal(schema.safeParse({ ...parsed, findings: parsed.findings.map(row => ({ ...row, evidenceImageVersionIds: ['unrelated-crop'] })) }).success, false)
  assert.equal(schema.safeParse({ ...parsed, findings: parsed.findings.map(row => ({ ...row, evidenceImageVersionIds: [observed.imageVersionId] })) }).success, false)
  assert.equal(schema.safeParse({ ...parsed, findings: parsed.findings.map(row => row.entityId === 'violin' ? { ...row, layoutFocus: { ...row.rect, width: row.rect.width / 2 } } : row) }).success, false)
  assert.equal(schema.safeParse({ ...parsed, findings: parsed.findings.map((row, index) => index ? row : { ...row, layoutFocus: { x: 0.9, y: 0.1, width: 0.1, height: 0.2 } }) }).success, false)
  assert.equal(schema.safeParse({ ...parsed, findings: parsed.findings.map(row => ({ ...row, framing: 'whole' })) }).success, false)
})

test('source annotations retain original dimensions and do not alter their input pixels', async () => {
  const pixels = await sharp({ create: { ...source, channels: 3, background: '#7962a3' } }).png().toBuffer(), original = Buffer.from(pixels)
  const marked = await wallpaperFramingAnnotation(pixels, source, observation()), metadata = await sharp(marked).metadata()
  assert.equal(metadata.width, source.width); assert.equal(metadata.height, source.height)
  assert.equal(pixels.equals(original), true); assert.equal(marked.equals(pixels), false)
})

test('unreported borders near an already cropped close-up are selected before known edges', () => {
  const observed = rainCloseUp()
  const suspects = wallpaperUnverifiedFramingEdges(observed, { width: 1086, height: 1448 }, 48)
  assert.deepEqual(suspects.map(candidate => candidate.edge), ['right', 'top'])
  const [right, top] = wallpaperFramingDetailRects(observed, suspects)
  assert.ok(right && right.x + right.width === 1)
  assert.equal(top?.y, 0)
})

for (const outcome of ['confirmed','uncertain','corrected','technical-retry','annotation-retry', 'unreported-edges', 'verified-periphery'] as const) test(`source-only recovery retains planning evidence after ${outcome}`, async t => {
  const f = await serviceFixture()
  t.after(f.cleanup)
  f.service.config.wallpaper.processing = resolveWallpaperProcessing()
  f.service.config.wallpaper.repairPolicy = wallpaperRepairPolicySchema.parse({})
  f.service.config.wallpaper.decision = { version: 'wallpaper-decision-v1', enabled: false, maxRoundsPerImage: 2, maxDetailRequests: 1 }
  const path = join(f.root, 'watercolor.png')
  await writeFile(path, await sharp({ create: { ...(outcome === 'unreported-edges' ? { width: 1086, height: 1448 } : source), channels: 3, background: '#7962a3' } }).png().toBuffer())
  let plans = 0, inspections = 0
  const send = f.http.request.bind(f.http)
  f.http.request = async (url, request) => {
    if (!url.startsWith('https://vision.example.test')) return send(url, request)
    const messages = z.object({ messages: z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ text: z.string().optional() }).passthrough())]) })) }).parse(JSON.parse(Buffer.from(request.body ?? []).toString('utf8'))).messages
    const content = messages.find(message => message.role === 'user')?.content
    assert.ok(Array.isArray(content))
    const text = content[0]?.text; assert.ok(text)
    const descriptor = z.object({ input: z.object({ images: z.array(z.object({ imageVersionId: z.string(), role: z.string() })), usage: z.unknown() }), outputSchema: z.object({ properties: z.record(z.string(), z.unknown()) }) }).parse(JSON.parse(text))
    const original = descriptor.input.images.find(image => image.role === 'wallpaper-original'); assert.ok(original)
    const observed = outcome === 'unreported-edges' ? rainCloseUp(original.imageVersionId)
      : outcome === 'verified-periphery' ? singlePeripheralContact(original.imageVersionId)
      : observation(original.imageVersionId)
    let output: object
    if ('findings' in descriptor.outputSchema.properties) {
      inspections++
      const crops = descriptor.input.images.filter(image => image.role === 'wallpaper-original-detail-only').map(image => image.imageVersionId)
      assert.ok(crops.length > 0)
      const inspected = findings(observed, [original.imageVersionId, ...crops], outcome === 'corrected')
      if (outcome === 'unreported-edges') {
        assert.deepEqual(z.object({ unverifiedSourceEdges: z.array(z.object({ edge: z.string() })) }).parse(descriptor.input.usage).unverifiedSourceEdges.map(candidate => candidate.edge), ['right', 'top'])
        inspected[0] = { ...inspected[0]!, rect: { x: 0, y: 0, width: 1, height: 1 }, sourceEdges: ['left', 'bottom', 'right', 'top'] }
      }
      if (outcome === 'verified-periphery') {
        const usage = z.object({ edgeCrops: z.array(z.object({ imageVersionId: z.string(), frameEdges: z.array(z.string()) })) }).parse(descriptor.input.usage)
        assert.ok(usage.edgeCrops.some(crop => crop.imageVersionId === crops[0] && crop.frameEdges.includes('left')))
      }
      output = { version: 'wallpaper-source-framing-v1', imageVersionId: original.imageVersionId, result: outcome === 'uncertain' ? 'uncertain' : outcome === 'corrected' || outcome === 'unreported-edges' ? 'corrected' : 'confirmed', reason: 'Source crop evidence has been inspected.',
        findings: inspected.map(row => ({ ...row, frameEdgeAssessments: row.sourceEdges.map(edge =>
          outcome === 'verified-periphery' && row.entityId === 'woman' && edge === 'left' ? { edge, kind: 'peripheral', detail: 'clothing-edge', cropImageVersionId: crops[0] } : { edge, kind: 'keep-contact' }) })) }
    } else {
      plans++
      output = { ...observed, ...('actionPartIds' in descriptor.outputSchema.properties ? { actionPartIds: outcome === 'unreported-edges' ? [] : ['bow'] } : {}),
        ...('presentationAssessments' in descriptor.outputSchema.properties ? { presentationAssessments: observed.objectRoles.filter(object => object.role === 'primary').map(object => ({ entityId: object.entityId, kind: 'independent', evidence: object.evidence })) } : {}),
        ...('handAssessments' in descriptor.outputSchema.properties ? { handAssessments: observed.objectRoles.filter(object => object.role === 'primary').map(object => object.entityId === 'woman'
          ? { entityId: object.entityId, kind: 'person', left: { kind: 'ordinary' }, right: { kind: 'ordinary' } }
          : { entityId: object.entityId, kind: 'non-person' }) } : {}) }
    }
    const malformed = outcome === 'technical-retry' && inspections === 1
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: malformed ? 'invalid JSON' : JSON.stringify(output) }, finish_reason: 'stop' }] })) }
  }
  await f.service.initialize()
  const importBytes = f.files.importBytes.bind(f.files)
  let failAnnotation = outcome === 'annotation-retry'
  f.files.importBytes = async (...args) => {
    if (failAnnotation && inspections > 0) { failAnnotation = false; throw new Error('The reviewed source annotation could not be saved.') }
    return importBytes(...args)
  }
  const receipt = z.object({ runId: z.string() }).parse(await f.action('direct-crop-start', { operationId: 'framing-'+outcome, name: 'Framing regression', source: { kind: 'local', files: [{ path, name: 'watercolor.png' }] } }))
  await f.jobs.drain()
  const read = async (runId: string) => z.object({ state: wallpaperStateSchema }).parse(await f.action('wallpaper-read', { sourceRunId: receipt.runId, runId, offset: 0, limit: 1 })).state
  let currentId = receipt.runId, state = await read(currentId), item = state.items[0]; assert.ok(item)
  assert.equal(plans, 1); assert.equal(inspections, 1, item.reason); assert.equal(item.edits, 0)
  assert.ok(item.framingConflict?.analysisId && item.framingConflict.inspection?.detailIds.length)
  const originalRun = JSON.stringify(f.domain.require('run', receipt.runId)), originalPixels = await readFile(path)
  if (outcome === 'technical-retry' || outcome === 'annotation-retry') {
    assert.equal(item.status, 'technical-failed'); assert.equal(item.framingConflict.inspection.status, 'failed')
    const requestId = item.framingConflict.inspection.requestId
    currentId = z.object({ runId: z.string() }).parse(await f.action('wallpaper-continue', { runId: currentId, operationId: 'retry-framing', reinspect: { imageVersionId: item.imageVersionId } })).runId
    await f.jobs.drain(); state = await read(currentId); item = state.items[0]; assert.ok(item)
    assert.equal(inspections, outcome === 'annotation-retry' ? 1 : 2); assert.equal(plans, 1)
    assert.equal(item.framingConflict?.inspection?.requestId, requestId)
    assert.equal(JSON.stringify(f.domain.require('run', receipt.runId)), originalRun)
  }
  assert.equal(item.edits, 0)
  if (outcome === 'unreported-edges') {
    assert.deepEqual(item.framingConflict?.observation.objectRoles[0]?.sourceEdges, ['left', 'bottom'])
    assert.ok(item.framingConflict?.diagnostics.edges.includes('top') && item.framingConflict.diagnostics.edges.includes('right'))
    assert.equal(item.framingConflict?.diagnostics.version, 'source-framing-conflict-v1')
  }
  const cleared = outcome === 'verified-periphery'
  assert.equal(item.framingConflict?.resolution, outcome === 'uncertain' ? 'uncertain' : cleared ? 'cleared' : 'blocked')
  if (cleared) {
    assert.equal(item.attempts.length, 1); assert.deepEqual(item.attempts[0]?.checks, [])
    const plan = item.attempts[0]!.plan
    const approved = plan.placement.adaptedSourceEdges
    assert.ok(approved)
    assert.deepEqual(approved, [{ entityId: 'woman', edge: 'left', detail: 'clothing-edge' }])
    const fabricated: typeof plan = { ...plan, placement: { ...plan.placement, adaptedSourceEdges: [...approved, { entityId: 'woman', edge: 'bottom', detail: 'clothing-edge' }] } }
    const activeSettings = wallpaperSettingsSchema.parse(specOf(f.domain.require('run', currentId)).fixed.wallpaper)
    assert.deepEqual(wallpaperGeometry(source, fabricated, activeSettings, activeSettings.sourceIntentPolicy).checks, [])
    const runs = f.repository.list('run').length, requests = f.repository.list('request').length
    await assert.rejects(f.action('wallpaper-plan-update', { runId: currentId, imageVersionId: item.imageVersionId, operationId: 'invented-frame-approval', plan: toJson(fabricated) }), { code: 'constraint-conflict', stage: 'wallpaper-replan' })
    assert.equal(f.repository.list('run').length, runs)
    assert.equal(f.repository.list('request').length, requests)
    assert.equal(JSON.stringify(f.domain.require('run', receipt.runId)), originalRun)
  } else {
    assert.equal(item.status, 'needs-review'); assert.equal(item.errorCode, undefined); assert.equal(item.attempts.length, 0)
    const view = await f.action('wallpaper-read', { sourceRunId: receipt.runId, runId: currentId, offset: 0, limit: 1 })
    const parsed = wallpaperViewSchema.parse(view)
    assert.equal(wallpaperRecovery(parsed, item, undefined).kind, 'none')
    assert.ok(imageWorkflowGallery('planning', item).some(slide => slide.label === 'wallpaperFramingAnnotation'))
    if (outcome === 'confirmed') {
      const wire = z.object({ bundle: z.object({ promptVersion: z.literal('wallpaper-source-framing-v1'), operation: z.literal('wallpaper-plan'), images: z.array(z.object({ role: z.string() })) }) })
      const recorded = f.repository.list('request').map(record => wire.safeParse(record.data)).find(result => result.success)
      assert.ok(recorded?.success)
      const expected = JSON.parse(await readFile(new URL('./fixtures/wallpaper-framing.expected.json', import.meta.url), 'utf8'))
      const inspection = item.framingConflict?.inspection
      assert.deepEqual({ promptVersion: recorded.data.bundle.promptVersion, operation: recorded.data.bundle.operation, imageRoles: recorded.data.bundle.images.map(image => image.role), status: item.status, reason: item.reason, resolution: item.framingConflict?.resolution, generations: item.attempts.filter(attempt => attempt.generation).length, recovery: wallpaperRecovery(parsed,item,undefined).kind, gallery: imageWorkflowGallery('planning',item).map(slide=>slide.label), citedCropCounts: inspection?.findings?.map(finding => finding.evidenceImageVersionIds.filter(id => inspection.detailIds.includes(id)).length) }, expected)
    }
    await assert.rejects(f.action('wallpaper-continue', { runId: currentId, operationId: 'repeat-framing', reinspect: { imageVersionId: item.imageVersionId } }), { code: 'source-framing-conflict' })
  }
  assert.equal((await readFile(path)).equals(originalPixels), true)
  assert.equal(specOf(f.domain.require('run', currentId)).fixed.completeCanvasPolicy, 'provider-canvas-v1')
  assert.equal(dataOf(f.domain.require('run', currentId)).counts.cropGenerated, 0)
})

test('a cut assembly cannot both contact the canvas and meet whole-subject safety without a verified release', () => {
  const policy = wallpaperSettingsSchema.parse({ sourceIntentPolicy: { version: 'source-intent-v2', alignment: 'subject-fill-v1', wholeSubjectSafety: 'extrema-v1', peripheralFrameAdaptation: 'verified-v4' } }).sourceIntentPolicy
  const example = observation()
  const station = { ...example.objectRoles[0]!, entityId: 'station', name: 'Assembly', sourceEdges: ['left' as const], rect: { x: 0, y: 0.1, width: 0.9, height: 0.78 } }
  const observed = { ...example, objectRoles: [station] }
  assert.deepEqual(wallpaperFrameSafetyConflict(observed, settings, policy)?.edges, ['left'])
  assert.equal(wallpaperFrameSafetyConflict({ ...observed, placement: { left: 0, top: 0, scale: 1, adaptedSourceEdges: [{ entityId: 'station', edge: 'left', detail: 'repeat-structure-edge' }] } }, settings, policy), undefined)
})
