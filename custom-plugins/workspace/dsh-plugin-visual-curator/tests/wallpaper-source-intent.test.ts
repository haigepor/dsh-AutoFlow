/** Source facts cover varied media and views without turning absent anatomy or damage into editing permission. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { z } from 'zod'
import { wallpaperSourceIntentSchema, wallpaperSourceMediumSchema, wallpaperSourceIntentObservationInstructions, wallpaperSourceIntentReviewInstructions, wallpaperSourceReplanSchema, wallpaperSourceReplanPrompt } from '../src/shared/wallpaper-source-intent.ts'
import { completeCanvasWallpaperPrompts } from '../src/shared/wallpaper-prompts.ts'
import { wallpaperRoleObservationOutputSchema, wallpaperSettingsSchema } from '../src/shared/wallpaper.ts'

const snapshot = z.strictObject({
  legacyPromptHashes: z.array(z.strictObject({ name: z.string(), settings: wallpaperSettingsSchema, plan: z.string(), review: z.string() })),
  sourceObservations: z.array(z.strictObject({ name: z.string(), medium: wallpaperSourceMediumSchema, intent: wallpaperSourceIntentSchema })),
  replanExample: wallpaperSourceReplanSchema,
}).parse(JSON.parse(await readFile(new URL('./fixtures/wallpaper-source-intent.expected.json', import.meta.url), 'utf8')))

test('source observations retain original views, occlusions, media and relations across real portraits, artwork, animals and products', () => {
  assert.equal(snapshot.sourceObservations.length, 11)
  for (const sample of snapshot.sourceObservations) {
    assert.equal(wallpaperSourceMediumSchema.parse(sample.medium), sample.medium, sample.name)
    assert.deepEqual(wallpaperSourceIntentSchema.parse(sample.intent), sample.intent, sample.name)
  }
  const observed = snapshot.sourceObservations.find(value => value.name === 'Real half portrait')
  assert.ok(observed)
  assert.equal(observed.intent.framing, 'partial')
  assert.equal(observed.intent.visibility, 'occluded')
  assert.deepEqual(observed.intent.relationships, ['The lectern continues to hide the lower body.'])
})

test('layout replanning returns only editing instructions and cannot redefine frozen source facts', () => {
  const schema = wallpaperSourceReplanSchema.extend({ imageVersionId: z.literal('original') })
  assert.deepEqual(schema.parse(snapshot.replanExample), snapshot.replanExample)
  const wire = z.toJSONSchema(schema)
  assert.deepEqual(Object.keys(wire.properties ?? {}).sort(), ['editPrompt', 'imageVersionId', 'reason'])
  assert.equal(z.fromJSONSchema(wire).safeParse(snapshot.replanExample).success, true)
  for (const forbidden of ['sourceMedium', 'sourceIntent', 'objectRoles', 'regions', 'placement', 'mode']) assert.equal(schema.safeParse({ ...snapshot.replanExample, [forbidden]: [] }).success, false, forbidden)
  assert.equal(schema.safeParse({ ...snapshot.replanExample, imageVersionId: 'foreign-original' }).success, false)
  assert.equal(completeCanvasWallpaperPrompts(wallpaperSettingsSchema.parse({}), true).replan?.version, wallpaperSourceReplanPrompt.version)
  assert.equal(completeCanvasWallpaperPrompts(wallpaperSettingsSchema.parse({}), false).replan, undefined)
})

test('confirmed partial primaries need a meaningful focus while critical parts and automobiles keep full protection', () => {
  const schema = wallpaperRoleObservationOutputSchema(undefined, true, true, true)
  const object = { entityId: 'person', name: 'Person', role: 'primary', safetyClass: 'general', evidence: 'A visible upper body with the original lower edge cut.', rect: { x: 0.1, y: 0.2, width: 0.8, height: 0.8 }, sourceEdges: [], sourceIntent: { framing: 'partial', visibility: 'frame-cropped', preserve: ['Keep the visible pose and original framing.'], relationships: [] } }
  const observed = { version: 1, imageVersionId: 'original', mode: 'single', subject: 'Visible upper body', evidence: object.evidence, priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [], sourceMedium: 'painting', objectRoles: [object], reason: 'Preserve the source view.', editPrompt: 'Preserve the original partial view.' }
  assert.equal(schema.safeParse(observed).success, false)
  const transmitted = z.fromJSONSchema(z.toJSONSchema(schema, { io: 'input' }))
  assert.equal(transmitted.safeParse(observed).success, false, 'The model sees that partial primaries require focus')
  const focused = { ...object, sourceIntent: { ...object.sourceIntent, layoutFocus: { x: 0.25, y: 0.25, width: 0.4, height: 0.4 } } }
  const admitted = schema.parse({ ...observed, objectRoles: [focused] })
  assert.equal(transmitted.safeParse({ ...observed, objectRoles: [focused] }).success, true)
  assert.equal(transmitted.safeParse({ ...observed, objectRoles: [{ ...focused, sourceIntent: { ...focused.sourceIntent, framing: 'whole' } }] }).success, false, 'The model sees that whole views cannot provide focus')
  assert.deepEqual(admitted.objectRoles[0]?.rect, object.rect, 'Focus never substitutes for full visible source content')
  const nearFrame = { ...focused, rect: { ...focused.rect, x: 0.01, width: 0.89 }, sourceEdges: ['left', 'bottom'] }
  assert.deepEqual(schema.parse({ ...observed, objectRoles: [nearFrame] }).objectRoles[0]?.sourceEdges, ['left', 'bottom'], 'A visually confirmed frame cut survives approximate bounding-box coordinates')
  const instrument = { ...object, entityId: 'instrument', name: 'Violin', role: 'critical-part', sourceIntent: { ...object.sourceIntent, framing: 'whole', visibility: 'visible' } }
  assert.equal(schema.safeParse({ ...observed, objectRoles: [focused, instrument] }).success, true)
  assert.equal(schema.safeParse({ ...observed, objectRoles: [{ ...object, safetyClass: 'automobile' }] }).success, true)
})

test('a partial layout focus is finite and contained in the image and never invents permission for a whole or uncertain view', () => {
  const partial = { framing: 'partial', visibility: 'frame-cropped', preserve: ['Retain the original upper-body view.'], relationships: [], layoutFocus: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 } }
  assert.equal(wallpaperSourceIntentSchema.safeParse(partial).success, true)
  for (const layoutFocus of [{ x: 0.8, y: 0, width: 0.3, height: 0.2 }, { x: 0, y: 0.9, width: 0.2, height: 0.2 }, { x: -0.1, y: 0, width: 0.2, height: 0.2 }, { x: 0, y: 0, width: 0, height: 0.2 }, { x: Number.NaN, y: 0, width: 0.2, height: 0.2 }]) {
    assert.equal(wallpaperSourceIntentSchema.safeParse({ ...partial, layoutFocus }).success, false)
  }
  for (const framing of ['whole', 'uncertain']) assert.equal(wallpaperSourceIntentSchema.safeParse({ ...partial, framing }).success, false)
  assert.equal(wallpaperSourceIntentSchema.safeParse({ ...partial, framing: 'close-up' }).success, true)
})

test('damaged and uncertain source facts stay reportable without accepting model-authored editing authorization', () => {
  const original = { framing: 'uncertain', visibility: 'uncertain', preserve: ['Keep the visible source structure.'], relationships: [] }
  assert.deepEqual(wallpaperSourceIntentSchema.parse(original), original)
  assert.equal(wallpaperSourceIntentSchema.parse({ ...original, framing: 'whole', visibility: 'damaged' }).visibility, 'damaged')
  assert.equal(wallpaperSourceIntentSchema.safeParse({ ...original, autoRepair: true }).success, false)
  assert.equal(wallpaperSourceIntentSchema.safeParse({ ...original, visibility: 'repairable' }).success, false)
  assert.equal(wallpaperSourceMediumSchema.safeParse('person').success, false, 'Subject names cannot substitute for the observed medium')
})

test('preservation statements and relationships cannot be omitted, blank or expanded beyond the compact observation limits', () => {
  const original = { framing: 'whole', visibility: 'visible', preserve: ['Keep the readable original brand.'], relationships: [] }
  assert.equal(wallpaperSourceIntentSchema.safeParse({ ...original, preserve: [] }).success, false)
  assert.equal(wallpaperSourceIntentSchema.safeParse({ ...original, preserve: ['   '] }).success, false)
  assert.equal(wallpaperSourceIntentSchema.safeParse({ ...original, preserve: Array.from({ length: 9 }, () => 'Preserve this fact.') }).success, false)
  assert.equal(wallpaperSourceIntentSchema.safeParse({ ...original, relationships: ['\n'] }).success, false)
  assert.equal(wallpaperSourceIntentSchema.safeParse({ ...original, relationships: Array.from({ length: 7 }, () => 'Keep the source relation.') }).success, false)
  assert.deepEqual(wallpaperSourceIntentSchema.parse({ ...original, preserve: ['  Keep the source mark.  '] }).preserve, ['Keep the source mark.'])
})

test('source-intent replanning freezes the observed medium while initial observations and historical tasks keep their own admission rules', () => {
  const observed = { version: 1, imageVersionId: 'original', mode: 'single', subject: 'One visible person', evidence: 'The source is a photograph.', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [], sourceMedium: 'photograph',
    objectRoles: [{ entityId: 'person', name: 'Person', role: 'primary', safetyClass: 'general', evidence: 'The original visible person.', rect: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 }, sourceEdges: [], sourceIntent: { framing: 'whole', visibility: 'visible', preserve: ['Keep the original appearance.'], relationships: [] } }],
    reason: 'Preserve the observed source.', editPrompt: 'Extend the background only.' }
  const initial = wallpaperRoleObservationOutputSchema(undefined, true, true, true)
  const parsed = initial.parse(observed)
  assert.equal(initial.safeParse({ ...observed, sourceMedium: 'painting' }).success, true, 'The first observation is not frozen before the source is classified')
  const frozen = wallpaperRoleObservationOutputSchema(parsed.objectRoles, true, true, true, parsed.sourceMedium)
  assert.equal(frozen.safeParse(observed).success, true)
  assert.equal(frozen.safeParse({ ...observed, sourceMedium: 'painting' }).success, false)
  assert.equal(frozen.safeParse({ ...observed, sourceMedium: undefined }).success, false)
  const transmitted = z.fromJSONSchema(z.toJSONSchema(frozen, { io: 'input' }))
  assert.equal(transmitted.safeParse(observed).success, true)
  assert.equal(transmitted.safeParse({ ...observed, sourceMedium: 'painting' }).success, false, 'The model-visible schema carries the frozen medium literal')
  const historical = wallpaperRoleObservationOutputSchema(undefined, true, false, false, 'photograph')
  assert.equal(historical.safeParse({ ...observed, sourceMedium: undefined }).success, true)
  assert.equal(historical.safeParse({ ...observed, sourceMedium: 'painting' }).success, true, 'A prior medium does not silently enable the new policy for old tasks')
})

test('historical complete-canvas prompt text is byte-identical unless source-intent policy is explicitly enabled', () => {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  for (const original of snapshot.legacyPromptHashes) {
    for (const legacy of [completeCanvasWallpaperPrompts(original.settings), completeCanvasWallpaperPrompts(original.settings, false)]) {
      assert.equal(hash(legacy.plan.text), original.plan, original.name)
      assert.equal(hash(legacy.review.text), original.review, original.name)
    }
  }
})

test('current complete-canvas observation and review each receive the same source-intent requirements once', () => {
  for (const original of snapshot.legacyPromptHashes) {
    const legacy = completeCanvasWallpaperPrompts(original.settings), current = completeCanvasWallpaperPrompts(original.settings, true)
    assert.equal(current.plan.text, legacy.plan.text + '\n' + wallpaperSourceIntentObservationInstructions)
    assert.equal(current.review.text, legacy.review.text.replace('protocol固定practical-v1', 'protocol固定practical-v2') + '\n' + wallpaperSourceIntentReviewInstructions)
    if (legacy.review.text.includes('protocol固定practical-v1')) {
      assert.match(current.review.text, /protocol固定practical-v2/)
      assert.doesNotMatch(current.review.text, /protocol固定practical-v1/)
      assert.match(legacy.review.text, /protocol固定practical-v1/)
    }
    assert.equal(current.plan.text.split(wallpaperSourceIntentObservationInstructions).length - 1, 1)
    assert.equal(current.review.text.split(wallpaperSourceIntentReviewInstructions).length - 1, 1)
    assert.equal(current.plan.version, legacy.plan.version)
    assert.equal(current.review.version, legacy.review.version)
  }
})
