/** Practical final reviews hold real uncertainty and reject visible damage without enforcing decorative background inventories. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { z } from 'zod'
import { wallpaperPracticalReviewSchema, wallpaperPracticalReviewOutputSchema, wallpaperSafetyClassSchema, type WallpaperPracticalReview } from '../src/shared/wallpaper-practical.ts'
import { wallpaperObjectRoleSchema, wallpaperRoleObservationPlanSchema, wallpaperRoleObservationOutputSchema, wallpaperReviewOutputSchema, wallpaperSettingsSchema, wallpaperStoredSourceReviewV4Schema, wallpaperVerdict } from '../src/shared/wallpaper.ts'
import { completeCanvasWallpaperPrompts } from '../src/shared/wallpaper-prompts.ts'
import { applyWallpaperSourceReview, wallpaperCriticalReviewFocus } from '../src/host/wallpaper-review.ts'
import { CompatibleVisionProvider, type VisionInput } from '../src/media/vision.ts'

const schema = wallpaperPracticalReviewOutputSchema('source', 'output')
const settings = wallpaperSettingsSchema.parse({ processing: {}, repairPolicy: {} })
function review(): WallpaperPracticalReview {
  return { reviewVersion: 'wallpaper-review-source-v4', protocol: 'practical-v1', sourceImageVersionId: 'source', outputImageVersionId: 'output', mode: 'single', subject: 'A visible main subject with a natural continuous background.',
    actualLayout: { regions: [{ name: 'Main subject', entityId: 'main', role: 'subject', scope: 'core', rect: { x: 0.32, y: 0.42, width: 0.3, height: 0.35 } }] }, defects: [], uncertainties: [] }
}

const primaryObjects = wallpaperObjectRoleSchema.array().parse([
  { entityId: 'drink', name: 'Milkshake', role: 'primary', evidence: 'One co-lead in the source arrangement.', rect: { x: 0.45, y: 0.3, width: 0.22, height: 0.4 }, sourceEdges: [] },
  { entityId: 'cat', name: 'Cat plush', role: 'primary', evidence: 'The second co-lead in the source arrangement.', rect: { x: 0.2, y: 0.35, width: 0.2, height: 0.3 }, sourceEdges: [] },
  { entityId: 'tray', name: 'Serving tray', role: 'supporting', evidence: 'Ordinary supporting prop.', rect: { x: 0.1, y: 0.7, width: 0.8, height: 0.2 }, sourceEdges: [] },
])
const primarySchema = wallpaperReviewOutputSchema('wallpaper-review-source-v4', [], ['source', 'output'], 'output', 'source', true, primaryObjects, false, true, 'group')
function groupReview(): WallpaperPracticalReview {
  return { ...review(), mode: 'group', subject: 'Milkshake and cat plush with ordinary supporting props.', actualLayout: { regions: [
    { name: 'Milkshake', entityId: 'drink', role: 'subject', scope: 'core', rect: { x: 0.45, y: 0.42, width: 0.22, height: 0.35 } },
    { name: 'Cat plush', entityId: 'cat', role: 'subject', scope: 'core', rect: { x: 0.22, y: 0.46, width: 0.2, height: 0.24 } },
  ] } }
}

function sourceObservation() {
  const objectRoles = wallpaperObjectRoleSchema.array().parse([
    ...primaryObjects.filter(object => object.entityId !== 'tray'),
    { entityId: 'tray', name: 'Serving tray', role: 'supporting', evidence: 'An edge-cropped ordinary supporting prop.', rect: { x: 0.7, y: 0.65, width: 0.3, height: 0.35 }, sourceEdges: ['right', 'bottom'] },
    { entityId: 'label', name: 'Required product label', role: 'critical-part', evidence: 'The task requires this source identity detail.', rect: { x: 0.48, y: 0.36, width: 0.06, height: 0.04 }, sourceEdges: [] },
  ])
  return wallpaperRoleObservationPlanSchema.parse({ version: 1, imageVersionId: 'source', mode: 'group', subject: 'Milkshake and cat plush', evidence: 'Two co-primary subjects with an ordinary supporting tray.', priorities: [], anchors: [], truncations: [], uncertainties: [], objectRoles,
    regions: [{ entityId: 'drink', name: 'Milkshake', role: 'subject', rect: { x: 0.45, y: 0.3, width: 0.22, height: 0.4 } }, { entityId: 'cat', name: 'Cat plush', role: 'subject', rect: { x: 0.2, y: 0.35, width: 0.2, height: 0.3 } }, { entityId: 'label', name: 'Required product label', role: 'critical', rect: { x: 0.48, y: 0.36, width: 0.06, height: 0.04 } }],
    reason: 'Preserve both primary subjects and their required identity detail.', editPrompt: 'Extend the source light and natural background around both main subjects.' })
}

function classifiedSourceObservation() {
  const raw = sourceObservation()
  raw.subject = 'A red automobile and a companion plush.'
  raw.objectRoles = raw.objectRoles.map(object => object.role === 'primary' ? { ...object, safetyClass: object.entityId === 'drink' ? 'automobile' : 'general' } : object)
  raw.regions = []
  return raw
}

test('current source schemas require one visual safety category per primary and preserve historical optional fields', () => {
  const legacy = sourceObservation(), current = wallpaperRoleObservationOutputSchema(undefined, true, true)
  assert.equal(wallpaperRoleObservationOutputSchema(undefined, true).safeParse(legacy).success, true)
  assert.equal(current.safeParse(legacy).success, false)
  const classified = current.parse(classifiedSourceObservation())
  assert.deepEqual(classified.objectRoles.filter(object => object.role === 'primary').map(object => object.safetyClass), ['automobile', 'general'])
  assert.ok(classified.objectRoles.filter(object => object.role !== 'primary').every(object => object.safetyClass === undefined))
  assert.equal(classified.regions.find(region => region.entityId === 'drink')?.safetyClass, 'automobile')
  assert.equal(wallpaperSafetyClassSchema.safeParse('automobile').success, true)
  assert.equal(wallpaperSafetyClassSchema.safeParse('vehicle').success, false)
  const frozen = wallpaperRoleObservationOutputSchema(classified.objectRoles, true, true)
  const downgraded = classifiedSourceObservation(), car = downgraded.objectRoles.find(object => object.entityId === 'drink'); assert.ok(car)
  car.safetyClass = 'general'
  assert.equal(frozen.safeParse(downgraded).success, false)
  const omitted = classifiedSourceObservation(), missingCategory = omitted.objectRoles.find(object => object.entityId === 'drink'); assert.ok(missingCategory)
  delete missingCategory.safetyClass
  assert.equal(frozen.safeParse(omitted).success, false)
  const scene = classifiedSourceObservation(); scene.mode = 'scene'
  assert.equal(current.safeParse(scene).success, false, 'A primary car cannot become scenery to evade full vehicle safety')
})

test('final compact regions inherit source classifications even when the reviewer attempts to downgrade a car', () => {
  const source = wallpaperRoleObservationOutputSchema(undefined, true, true).parse(classifiedSourceObservation())
  const schema = wallpaperReviewOutputSchema('wallpaper-review-source-v4', [], ['source', 'output'], 'output', 'source', true, source.objectRoles, false, true, 'group')
  const wire = groupReview()
  wire.actualLayout.regions = wire.actualLayout.regions.map(region => ({ ...region, safetyClass: region.entityId === 'drink' ? 'general' : 'automobile' }))
  const normalized = wallpaperPracticalReviewSchema.parse(schema.parse(wire))
  assert.deepEqual(normalized.actualLayout.regions.map(region => [region.entityId, region.safetyClass]), [['drink', 'automobile'], ['cat', 'general']])
  assert.equal(normalized.protocol, 'practical-v1', 'Safety policy generations retain the compact wire protocol')
  const settings = wallpaperSettingsSchema.parse({ processing: { acceptance: { version: 'practical-v2' } }, repairPolicy: {} })
  const car = wire.actualLayout.regions.find(region => region.entityId === 'drink'); assert.ok(car)
  car.rect.x = (settings.safe.left - 2) / settings.width
  const rejected = wallpaperStoredSourceReviewV4Schema.parse(applyWallpaperSourceReview(schema.parse(wire), true, settings))
  assert.equal(rejected.actualLayout.regions.find(region => region.entityId === 'drink')?.safetyClass, 'automobile')
  assert.equal(wallpaperVerdict(rejected), 'reject', 'Even two pixels outside cannot borrow the general 97% requirement')
  const generalRoles = source.objectRoles.map(object => object.role === 'primary' ? { ...object, safetyClass: 'general' as const } : object)
  const generalSchema = wallpaperReviewOutputSchema('wallpaper-review-source-v4', [], ['source', 'output'], 'output', 'source', true, generalRoles, false, true, 'group')
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(generalSchema.parse(wire), true, settings)), 'pass')
  const unboundMode = wallpaperPracticalReviewOutputSchema('source', 'output', [{ entityId: 'main', name: 'Car', safetyClass: 'automobile' }])
  const escaped = review(); escaped.mode = 'scene'
  assert.equal(unboundMode.safeParse(escaped).success, false)
})

test('current compatible source planning advertises and validates primary safety classification before final-image review', async () => {
  let raw = sourceObservation()
  raw.regions = []
  const pixels = await sharp({ create: { width: 24, height: 32, channels: 3, background: 'black' } }).png().toBuffer()
  const provider = new CompatibleVisionProvider({ endpoint: 'https://fixture.invalid', model: 'planner', supportsMultiImage: true, maxImages: 8, maxImageBytes: 1_000_000, maxRequestBytes: 2_000_000, maxOutputTokens: 4096, temperature: 0 }, { async request() {
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(raw) }, finish_reason: 'stop' }] })) }
  } })
  const settings = wallpaperSettingsSchema.parse({ processing: { acceptance: { version: 'practical-v2' } }, repairPolicy: {} })
  const input: VisionInput = { requestId: 'classified-source', taskBrief: 'Observe the actual original subjects.', rules: [], wallpaperPrompt: completeCanvasWallpaperPrompts(settings).plan, usage: { settings },
    images: [{ imageVersionId: 'source', role: 'wallpaper-original', bytes: pixels, mime: 'image/png', digest: createHash('sha256').update(pixels).digest('hex') }] }
  const descriptor = JSON.parse(provider.describeRequest(input, 'wallpaper-plan').inputText)
  const transmitted = z.fromJSONSchema(descriptor.outputSchema)
  assert.equal(transmitted.safeParse(raw).success, false, 'The transmitted primary variant requires safetyClass too')
  await assert.rejects(provider.wallpaper(input, 'wallpaper-plan', { maxBytes: 65536, timeoutMs: 5000, maxRedirects: 0 }))
  raw = classifiedSourceObservation()
  assert.equal(transmitted.safeParse(raw).success, true)
  const output = wallpaperRoleObservationPlanSchema.parse(await provider.wallpaper(input, 'wallpaper-plan', { maxBytes: 65536, timeoutMs: 5000, maxRedirects: 0 }))
  assert.equal(output.regions.find(region => region.entityId === 'drink')?.safetyClass, 'automobile')
})

test('practical source planning derives redundant frame edges and protection rectangles while strict plans still require them', () => {
  const practical = wallpaperRoleObservationOutputSchema(undefined, true)
  const edgeMismatch = sourceObservation(), tray = edgeMismatch.objectRoles.find(object => object.entityId === 'tray'); assert.ok(tray)
  tray.sourceEdges = []
  const missingCritical = sourceObservation()
  missingCritical.regions = missingCritical.regions.filter(region => region.entityId !== 'label')
  const emptyDerived = sourceObservation()
  emptyDerived.regions = []
  for (const object of emptyDerived.objectRoles) object.sourceEdges = []
  emptyDerived.truncations = ['A real visible source edge still needs repair.']
  emptyDerived.uncertainties = ['A visible primary connection remains unclear.']
  for (const raw of [edgeMismatch, missingCritical, emptyDerived]) {
    assert.equal(wallpaperRoleObservationPlanSchema.safeParse(raw).success, false)
    const normalized = practical.parse(raw)
    assert.deepEqual(normalized.objectRoles.find(object => object.entityId === 'tray')?.sourceEdges, ['right', 'bottom'])
    assert.deepEqual(normalized.regions.map(region => [region.entityId, region.role]), [['drink', 'subject'], ['cat', 'subject'], ['label', 'critical']])
    assert.deepEqual(normalized.regions.find(region => region.entityId === 'label')?.rect, { x: 0.48, y: 0.36, width: 0.06, height: 0.04 })
    assert.deepEqual(normalized.truncations, raw.truncations)
    assert.deepEqual(normalized.uncertainties, raw.uncertainties)
  }
})

test('source derivation cannot erase duplicate identities, missing primaries or frozen identity and role changes', () => {
  const raw = sourceObservation(), practical = wallpaperRoleObservationOutputSchema(raw.objectRoles, true)
  const duplicate = sourceObservation(), first = duplicate.objectRoles[0]; assert.ok(first)
  duplicate.objectRoles.push(structuredClone(first)); duplicate.regions = []
  assert.equal(practical.safeParse(duplicate).success, false)
  const noPrimary = sourceObservation()
  noPrimary.objectRoles = noPrimary.objectRoles.filter(object => object.role !== 'primary'); noPrimary.regions = []
  assert.equal(wallpaperRoleObservationOutputSchema(undefined, true).safeParse(noPrimary).success, false)
  const missingFrozen = sourceObservation()
  missingFrozen.objectRoles = missingFrozen.objectRoles.filter(object => object.entityId !== 'cat'); missingFrozen.regions = []
  assert.equal(practical.safeParse(missingFrozen).success, false)
  const wrongIdentity = sourceObservation(), renamed = wrongIdentity.objectRoles.find(object => object.entityId === 'cat'); assert.ok(renamed)
  renamed.entityId = 'other-cat'; wrongIdentity.regions = []
  assert.equal(practical.safeParse(wrongIdentity).success, false)
  const wrongRole = sourceObservation(), demoted = wrongRole.objectRoles.find(object => object.entityId === 'cat'); assert.ok(demoted)
  demoted.role = 'supporting'; wrongRole.regions = []
  assert.equal(practical.safeParse(wrongRole).success, false)
  const explicitWrongRegion = sourceObservation(), region = explicitWrongRegion.regions[0]; assert.ok(region)
  region.entityId = 'unseen-object'
  assert.equal(practical.safeParse(explicitWrongRegion).success, false)
  region.entityId = 'drink'; region.role = 'critical'
  assert.equal(practical.safeParse(explicitWrongRegion).success, false)
})

test('compatible source planning transmits an object schema and accepts derived practical observations in one request', async () => {
  const raw = sourceObservation()
  raw.regions = []
  for (const object of raw.objectRoles) object.sourceEdges = []
  const pixels = await sharp({ create: { width: 24, height: 32, channels: 3, background: 'black' } }).png().toBuffer()
  let calls = 0
  const provider = new CompatibleVisionProvider({ endpoint: 'https://fixture.invalid', model: 'planner', supportsMultiImage: true, maxImages: 8, maxImageBytes: 1_000_000, maxRequestBytes: 2_000_000, maxOutputTokens: 4096, temperature: 0 }, { async request() {
    calls++
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(raw) }, finish_reason: 'stop' }] })) }
  } })
  const practical = wallpaperSettingsSchema.parse({ processing: { acceptance: { version: 'practical-v1' } }, repairPolicy: {} })
  const input: VisionInput = { requestId: 'practical-source', taskBrief: 'Observe both source primary subjects.', rules: [], wallpaperPrompt: completeCanvasWallpaperPrompts(practical).plan, usage: { settings: practical },
    images: [{ imageVersionId: 'source', role: 'wallpaper-original', bytes: pixels, mime: 'image/png', digest: createHash('sha256').update(pixels).digest('hex') }] }
  const descriptor = provider.describeRequest(input, 'wallpaper-plan')
  const transmitted = z.object({ outputSchema: z.object({ type: z.literal('object'), properties: z.object({ objectRoles: z.unknown(), regions: z.unknown() }), required: z.array(z.string()) }) }).parse(JSON.parse(descriptor.inputText))
  assert.ok(transmitted.outputSchema.required.includes('objectRoles')); assert.ok(transmitted.outputSchema.required.includes('regions'))
  const actual = wallpaperRoleObservationPlanSchema.parse(await provider.wallpaper(input, 'wallpaper-plan', { maxBytes: 65536, timeoutMs: 5000, maxRedirects: 0 }))
  assert.equal(calls, 1)
  assert.equal(actual.regions.length, 3)
  assert.deepEqual(actual.objectRoles.find(object => object.entityId === 'tray')?.sourceEdges, ['right', 'bottom'])
  const strict = wallpaperSettingsSchema.parse({ processing: { acceptance: { version: 'strict-v1' } }, repairPolicy: {} })
  await assert.rejects(provider.wallpaper({ ...input, requestId: 'strict-source', usage: { settings: strict } }, 'wallpaper-plan', { maxBytes: 65536, timeoutMs: 5000, maxRedirects: 0 }), error => {
    assert.ok(error instanceof Error && 'code' in error)
    assert.equal(error.code, 'vision-invalid-output')
    return true
  })
})

test('frozen co-primary subjects each require one core region without an inventory of supporting props', () => {
  const wire = groupReview()
  assert.equal(primarySchema.safeParse(wire).success, true)
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(primarySchema.parse(wire), true, settings)), 'pass')
  const coverageSchema = wallpaperPracticalReviewOutputSchema('source', 'output', primaryObjects.filter(object => object.role === 'primary'))
  for (const mode of ['group', 'scene', 'abstract'] as const) {
    const omitted = groupReview()
    omitted.mode = mode
    omitted.actualLayout.regions = omitted.actualLayout.regions.filter(region => region.entityId !== 'cat')
    assert.equal(coverageSchema.safeParse(omitted).success, false, `${mode} cannot omit the frozen second primary`)
  }
  const noIdentity = groupReview()
  const firstRegion = noIdentity.actualLayout.regions[0]
  assert.ok(firstRegion)
  delete firstRegion.entityId
  assert.equal(primarySchema.safeParse(noIdentity).success, false)
  const promotedTray = groupReview()
  promotedTray.actualLayout.regions.push({ name: 'Serving tray', entityId: 'tray', role: 'subject', scope: 'core', rect: { x: 0.2, y: 0.7, width: 0.6, height: 0.1 } })
  assert.equal(primarySchema.safeParse(promotedTray).success, false, 'Supporting props cannot become primary safety subjects')
})

test('frozen object composition cannot switch to scene while original landscapes retain their natural focal scale', () => {
  const escaped = groupReview()
  escaped.mode = 'scene'
  assert.equal(primarySchema.safeParse(escaped).success, false, 'Even complete primary coverage cannot change the original group into a scene')
  const unresolved = groupReview()
  unresolved.mode = 'uncertain'
  assert.equal(primarySchema.safeParse(unresolved).success, true)
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(primarySchema.parse(unresolved), true, settings)), 'needs-review')
  const sceneSchema = wallpaperPracticalReviewOutputSchema('source', 'output', [{ entityId: 'main', name: 'Distant cabin' }], 'scene')
  const landscape = review()
  landscape.mode = 'scene'; landscape.subject = 'A lake landscape with a distant cabin.'
  landscape.actualLayout.regions = [{ name: 'Distant cabin', entityId: 'main', role: 'subject', scope: 'core', rect: { x: 0.4, y: 0.5, width: 0.04, height: 0.03 } }]
  const practical = wallpaperSettingsSchema.parse({ processing: { acceptance: { version: 'practical-v1' } }, repairPolicy: {} })
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(sceneSchema.parse(landscape), true, practical)), 'pass')
})

test('a primary may have peripheral and critical detail while retaining exactly one main core region', () => {
  const wire = groupReview()
  wire.actualLayout.regions.push({ name: 'Milkshake straw tip', entityId: 'drink', role: 'subject', scope: 'peripheral', rect: { x: 0.55, y: 0.37, width: 0.01, height: 0.05 } },
    { name: 'Cat face', entityId: 'cat', role: 'critical', scope: 'core', rect: { x: 0.26, y: 0.48, width: 0.1, height: 0.08 } })
  assert.equal(primarySchema.safeParse(wire).success, true)
  const duplicateCore = groupReview()
  duplicateCore.actualLayout.regions.push({ name: 'Second milkshake core', entityId: 'drink', role: 'subject', scope: 'core', rect: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 } })
  assert.equal(primarySchema.safeParse(duplicateCore).success, false)
})

test('an explicitly absent primary is rejected as content damage without inventing its output rectangle', () => {
  const wire = groupReview()
  wire.actualLayout.regions = wire.actualLayout.regions.filter(region => region.entityId !== 'cat')
  wire.defects = [{ kind: 'subject-damage', severity: 'major', entityId: 'cat', absent: true, reason: 'The original co-primary cat plush is entirely missing from the final image.' }]
  assert.equal(primarySchema.safeParse(wire).success, true)
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(primarySchema.parse(wire), true, settings)), 'reject')
  const contradictory = groupReview()
  contradictory.defects = wire.defects
  assert.equal(primarySchema.safeParse(contradictory).success, false, 'An observed core cannot also be declared absent')
  const foreign = structuredClone(wire)
  foreign.defects = [{ kind: 'subject-damage', severity: 'major', entityId: 'tray', absent: true, reason: 'A supporting prop is absent.' }]
  assert.equal(primarySchema.safeParse(foreign).success, false)
  const notEntirelyAbsent = structuredClone(wire)
  notEntirelyAbsent.defects = [{ kind: 'subject-damage', severity: 'major', entityId: 'cat', reason: 'A visible cat paw is deformed.' }]
  assert.equal(primarySchema.safeParse(notEntirelyAbsent).success, false, 'Visible damage still needs its actual location and the primary core')
  const allAbsent = groupReview()
  allAbsent.actualLayout.regions = []
  allAbsent.defects = ['drink', 'cat'].map(entityId => ({ kind: 'subject-damage', severity: 'major', entityId, absent: true, reason: `The entire ${entityId} co-primary is missing.` }))
  assert.equal(primarySchema.safeParse(allAbsent).success, true)
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(primarySchema.parse(allAbsent), true, settings)), 'reject')
})

test('compact responses bind exact pixels and require locations for major visible content defects', () => {
  assert.deepEqual(schema.parse(review()), review())
  assert.equal(schema.safeParse({ ...review(), outputImageVersionId: 'simulation' }).success, false)
  const missingLocation = review()
  missingLocation.defects = [{ kind: 'duplicate-subject', severity: 'major', reason: 'An extra copy appears next to the original.' }]
  assert.equal(schema.safeParse(missingLocation).success, false)
  const missingSubject = review()
  missingSubject.actualLayout.regions = []
  assert.equal(schema.safeParse(missingSubject).success, false)
})

test('natural background changes and minor visible differences do not require inventories or another edit', () => {
  const wire = review()
  wire.subject = 'Two original biscuits with an extended garden background.'
  wire.defects = [{ kind: 'quality-loss', severity: 'minor', reason: 'Background foliage has slightly different soft detail.' }]
  const effective = wallpaperStoredSourceReviewV4Schema.parse(applyWallpaperSourceReview(schema.parse(wire), true, settings))
  assert.equal(wallpaperVerdict(effective), 'pass')
  assert.deepEqual(effective.issues, [])
  assert.ok(effective.layoutWarnings.includes(wire.defects[0]!.reason))
  assert.equal(effective.inventory, undefined)
  assert.match(effective.subjectIntegrity.source.reason, /有意取景/)
})

test('major duplication, collage seams and severe quality loss continue to reject actual final pixels', () => {
  for (const kind of ['duplicate-subject', 'collage-seam', 'subject-damage', 'quality-loss', 'style-change'] as const) {
    const wire = review()
    wire.defects = [{ kind, severity: 'major', reason: `Visible ${kind} damages the final image.`, outputRect: { x: 0.4, y: 0.5, width: 0.12, height: 0.12 } }]
    const effective = wallpaperStoredSourceReviewV4Schema.parse(applyWallpaperSourceReview(schema.parse(wire), true, settings))
    assert.equal(wallpaperVerdict(effective), 'reject', kind)
    assert.equal(effective.modelIssues.length, 1)
    assert.equal(effective.modelIssues[0]!.evidence?.imageVersionId, 'output')
  }
})

test('model layout opinions cannot veto Host measurements of an acceptable actual subject', () => {
  const wire = review()
  wire.defects = [{ kind: 'layout', severity: 'major', reason: 'The model claims the subject is too high.' }]
  const effective = wallpaperStoredSourceReviewV4Schema.parse(applyWallpaperSourceReview(schema.parse(wire), true, settings))
  assert.equal(wallpaperVerdict(effective), 'pass')
  assert.deepEqual(effective.layoutChecks, [])
  assert.ok(effective.layoutWarnings.includes(wire.defects[0]!.reason))
  const outside = structuredClone(wire)
  outside.actualLayout.regions[0]!.rect.y = 0.08
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(schema.parse(outside), true, settings)), 'reject')
})

test('actual quality uncertainty remains held and has no request for another whole-frame inspection', () => {
  const wire = review()
  wire.uncertainties = ['The visible facial structure is unclear in the supplied pixels.']
  const effective = wallpaperStoredSourceReviewV4Schema.parse(applyWallpaperSourceReview(schema.parse(wire), true, settings))
  assert.equal(wallpaperVerdict(effective), 'needs-review')
  assert.equal(wallpaperCriticalReviewFocus(effective), undefined)
  const scene = review()
  scene.mode = 'abstract'; scene.actualLayout.regions = []
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(schema.parse(scene), true, settings)), 'pass')
})

test('one genuine local uncertainty may request native detail without reopening a whole-frame review', () => {
  const wire = review()
  wire.inspection = { sourceRect: { x: 0.4, y: 0.4, width: 0.15, height: 0.12 }, outputRect: { x: 0.42, y: 0.52, width: 0.15, height: 0.12 }, question: 'Is the visible facial outline structurally intact?' }
  assert.equal(schema.safeParse(wire).success, false, 'A passing review cannot request arbitrary inspection')
  wire.uncertainties = ['The facial outline needs its native pixels.']
  const effective = wallpaperStoredSourceReviewV4Schema.parse(applyWallpaperSourceReview(schema.parse(wire), true, settings))
  assert.equal(wallpaperVerdict(effective), 'needs-review')
  assert.deepEqual(wallpaperCriticalReviewFocus(effective), wire.inspection)
  const oversized = structuredClone(wire)
  assert.ok(oversized.inspection)
  oversized.inspection.sourceRect = { x: 0.1, y: 0.1, width: 0.6, height: 0.5 }
  assert.equal(schema.safeParse(oversized).success, false, 'The crop may not exceed one quarter of the original')
  const nearlyFullWidth = structuredClone(wire)
  assert.ok(nearlyFullWidth.inspection)
  nearlyFullWidth.inspection.outputRect = { x: 0, y: 0.5, width: 0.9, height: 0.1 }
  assert.equal(schema.safeParse(nearlyFullWidth).success, false, 'A narrow whole-frame strip is not a local question')
})

test('the transmitted compact schema does not receive historical exhaustive-output instructions', async () => {
  const bytes = await sharp({ create: { width: 24, height: 32, channels: 3, background: 'black' } }).png().toBuffer()
  const provider = new CompatibleVisionProvider({ endpoint: 'https://fixture.invalid', model: 'reviewer', supportsMultiImage: true, maxImages: 8, maxImageBytes: 1_000_000, maxRequestBytes: 2_000_000, maxOutputTokens: 4096, temperature: 0 }, { async request() { throw Error('Describing a review must not invoke a model') } })
  const input: VisionInput = { requestId: 'practical', taskBrief: 'Check visible final usability.', rules: [], wallpaperPrompt: { version: 'wallpaper-review-source-v4', text: 'Return compact practical-v1 observations only.' }, wallpaperReviewProtocol: 'practical-v1', wallpaperOutputSchema: schema,
    images: ['source', 'output'].map((imageVersionId, index) => ({ imageVersionId, role: index ? 'actual-wallpaper' : 'wallpaper-original', bytes, mime: 'image/png', digest: createHash('sha256').update(bytes).digest('hex') })) }
  const descriptor = provider.describeRequest(input, 'wallpaper-review')
  const transmitted = z.object({ outputSchema: z.object({ required: z.array(z.string()) }) }).parse(JSON.parse(descriptor.inputText))
  assert.ok(transmitted.outputSchema.required.includes('protocol'))
  assert.ok(transmitted.outputSchema.required.includes('defects'))
  assert.equal(transmitted.outputSchema.required.includes('checks'), false)
  assert.equal(transmitted.outputSchema.required.includes('inventory'), false)
  assert.equal(descriptor.instructions.includes('Every checks.* object'), false)
  const legacyInput = { ...input }
  delete legacyInput.wallpaperReviewProtocol
  assert.equal(provider.describeRequest(legacyInput, 'wallpaper-review').instructions.includes('Every checks.* object'), true)
})

test('practical scene mode remains a landscape through the stored-review adapter even with a small focal subject', () => {
  const scene = review(); scene.mode = 'scene'; scene.subject = 'A lake landscape with a naturally distant cabin.'
  scene.actualLayout.regions = [{ name: 'Distant cabin', role: 'subject', scope: 'core', rect: { x: 0.4, y: 0.5, width: 0.04, height: 0.03 } }]
  const practical = wallpaperSettingsSchema.parse({ processing: { acceptance: { version: 'practical-v1' } }, repairPolicy: {} })
  const effective = applyWallpaperSourceReview(scene, true, practical)
  assert.equal(wallpaperVerdict(effective), 'pass')
})
