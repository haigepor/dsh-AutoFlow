/** Source facts cover varied media and views without turning absent anatomy or damage into editing permission. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { z } from 'zod'
import { wallpaperActualBoundary } from '../src/host/wallpaper-boundary.ts'
import { applyWallpaperSourceReview } from '../src/host/wallpaper-review.ts'
import { wallpaperSourceIntentSchema, wallpaperSourceMediumSchema, wallpaperSourceIntentObservationInstructions, wallpaperSourceIntentReviewInstructions, wallpaperPrimaryMeasurementInstructions, wallpaperSourceReplanSchema, wallpaperSourceReplanPrompt, wallpaperSubjectPresentationInstructions } from '../src/shared/wallpaper-source-intent.ts'
import { resolveWallpaperProcessing } from '../src/shared/wallpaper-policy.ts'
import { wallpaperPracticalReviewOutputSchema } from '../src/shared/wallpaper-practical.ts'
import { completeCanvasWallpaperPrompts } from '../src/shared/wallpaper-prompts.ts'
import { wallpaperPlanningObservation, wallpaperRoleObservationOutputSchema, wallpaperSettingsSchema, wallpaperVerdict } from '../src/shared/wallpaper.ts'

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

test('staged props stay visible without receiving safety geometry, while independently presented objects stay protected', () => {
  const settings = wallpaperSettingsSchema.parse({ processing: resolveWallpaperProcessing(), sourceIntentPolicy: { version: 'source-intent-v2', alignment: 'subject-fill-v1', fill: { relativeLayout: {} } } })
  const historical = completeCanvasWallpaperPrompts(settings, true, true)
  const current = completeCanvasWallpaperPrompts(settings, true, true, true)
  assert.equal(historical.plan.version, 'wallpaper-plan-v12')
  assert.equal(current.plan.version, 'wallpaper-plan-v13')
  assert.ok(current.plan.text.includes(wallpaperSubjectPresentationInstructions))
  assert.deepEqual(current.review, historical.review)
  const table = { entityId: 'table', name: 'Tiered wood table', role: 'primary', safetyClass: 'general', evidence: 'The tiered table is the product on display.', rect: { x: 0.28, y: 0.44, width: 0.4, height: 0.4 }, sourceEdges: [], sourceIntent: { framing: 'whole', visibility: 'visible', preserve: ['Retain the round shelves.'], relationships: ['The top shelf carries the arranged vessel.'] } }
  const vessel = { ...table, entityId: 'vessel', name: 'Ceramic vessel with branches', evidence: 'A pale vessel and tall branches stage the top shelf.', rect: { x: 0.39, y: 0.09, width: 0.19, height: 0.35 }, sourceIntent: { ...table.sourceIntent, preserve: ['The branches meet the mouth of the vessel.'], relationships: ['The vessel sits on the top shelf.'] } }
  const sculpture = { ...table, entityId: 'sculpture', name: 'White sculpture', evidence: 'An upright white head has its own dark pedestal.', rect: { x: 0.69, y: 0.17, width: 0.2, height: 0.39 }, sourceIntent: { ...table.sourceIntent, preserve: ['Keep the face and neck profile.'], relationships: ['The head stands on a separate pedestal.'] } }
  const originalRoles = [table, vessel, sculpture]
  const independent = (entityId: string) => ({ entityId, kind: 'independent', evidence: 'The object is independently presented; removing it removes one of the displayed works.' })
  const styling = { entityId: vessel.entityId, kind: 'styling', supportsEntityId: table.entityId, evidence: 'The branches dress the top shelf. The table is still on display if the vessel is removed.' }
  const input = {
    version: 1, imageVersionId: 'source', mode: 'group', subject: 'Original furniture and sculpture display', evidence: 'The shelf and plinth show a table and a sculpture.', sourceMedium: 'photograph',
    objectRoles: originalRoles, handAssessments: originalRoles.map(object => ({ entityId: object.entityId, kind: 'non-person' })), presentationAssessments: [independent(table.entityId), styling, independent(sculpture.entityId)], actionPartIds: [],
    priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [], reason: 'Preserve the objects and staging.', editPrompt: 'Extend the wall naturally.',
  }
  const schema = wallpaperRoleObservationOutputSchema(undefined, true, true, true, undefined, true, true, true, true)
  assert.equal(z.fromJSONSchema(z.toJSONSchema(schema, { io: 'output' })).safeParse(input).success, true)
  const raw = schema.parse(input)
  assert.deepEqual(schema.parse(raw), raw, 'A committed source response keeps its wire evidence for replay')
  const plan = wallpaperPlanningObservation(raw)
  assert.deepEqual(plan.regions.map(region => region.entityId), [table.entityId, sculpture.entityId])
  assert.deepEqual(plan.objectRoles.find(object => object.entityId === vessel.entityId), { ...vessel, role: 'supporting' })
  assert.equal(plan.mode, 'group')
  assert.equal('presentationAssessments' in plan || 'handAssessments' in plan, false)
  const coLead = wallpaperPlanningObservation(schema.parse({ ...input, presentationAssessments: originalRoles.map(object => independent(object.entityId)) }))
  assert.deepEqual(coLead.regions.map(region => region.entityId), [table.entityId, vessel.entityId, sculpture.entityId])
  const oneLead = wallpaperPlanningObservation(schema.parse({ ...input, presentationAssessments: [independent(table.entityId), styling, { ...styling, entityId: sculpture.entityId }] }))
  assert.equal(oneLead.mode, 'single')
  assert.equal(schema.safeParse({ ...input, presentationAssessments: [independent(table.entityId), { ...styling, supportsEntityId: 'unknown' }, independent(sculpture.entityId)] }).success, false)
  assert.equal(schema.safeParse({ ...input, presentationAssessments: [independent(table.entityId), styling] }).success, false)
  assert.equal(schema.safeParse({ ...input, objectRoles: [table, { ...vessel, safetyClass: 'automobile' }, sculpture] }).success, false)
  const frozen = wallpaperRoleObservationOutputSchema(raw.objectRoles, true, true, true, raw.sourceMedium, true, true, true, true)
  assert.equal(frozen.safeParse(input).success, false, 'An existing plan keeps its frozen subjects during a correction')
})

test('a seated singer requires an independent actual gesture box even when the measured person and microphone pass', () => {
  const settings = wallpaperSettingsSchema.parse({ processing: resolveWallpaperProcessing(), sourceIntentPolicy: { version: 'source-intent-v2', alignment: 'subject-fill-v1', fill: { relativeLayout: {} } } })
  const prompts = completeCanvasWallpaperPrompts(settings, true, true)
  assert.equal(prompts.plan.version, 'wallpaper-plan-v12')
  assert.equal(completeCanvasWallpaperPrompts(settings, true).plan.version, 'wallpaper-plan-v8')
  assert.ok(prompts.plan.text.includes(wallpaperPrimaryMeasurementInstructions))
  assert.ok(prompts.review.text.includes(wallpaperPrimaryMeasurementInstructions))
  assert.match(prompts.plan.text, /查两手各自在做什么/)
  assert.match(prompts.plan.text, /自然垂放或仅承重的手无需为布局单列/)
  assert.match(prompts.plan.text, /handAssessments须逐一覆盖每个primary/)
  assert.match(prompts.review.text, /同一头部及关键动作，包括未持物的表达手势/)
  const singer = { entityId: 'singer', name: 'Seated singer', role: 'primary', safetyClass: 'general', rect: { x: 0.06, y: 0.24, width: 0.86, height: 0.76 }, evidence: 'One singer seated at the window, cropped at the lower legs.', sourceEdges: ['bottom'], sourceIntent: {
    framing: 'partial', visibility: 'frame-cropped', layoutFocus: { x: 0.12, y: 0.24, width: 0.78, height: 0.47 },
    preserve: ['Retain the head, hand holding the microphone and outward open hand from the wrist to the fingertips.'],
    relationships: ['The free hand extends right with the palm raised while the other hand holds the microphone near the mouth.'],
  } }
  const mic = { entityId: 'mic', name: 'Microphone', role: 'critical-part', rect: { x: 0.31, y: 0.39, width: 0.19, height: 0.2 }, evidence: 'The microphone grille and handle are visible.', sourceEdges: [], sourceIntent: {
    framing: 'whole', visibility: 'occluded', preserve: ['Preserve the grille, visible handle and original angle.'], relationships: ['The singer grasps the handle.'],
  } }
  const hand = { entityId: 'free-hand', name: 'Open hand', role: 'critical-part', rect: { x: 0.75, y: 0.48, width: 0.15, height: 0.16 }, evidence: 'The singer opens her free hand outward from the wrist to her longest visible fingertip.', sourceEdges: [], sourceIntent: {
    framing: 'whole', visibility: 'visible', preserve: ['Retain the open palm and spread visible fingertips.'], relationships: ['The wrist connects to the same raised arm.'],
  } }
  const legacy = {
    version: 1, imageVersionId: 'source', mode: 'single', subject: 'Seated singer', evidence: 'The singer and microphone are distinct from the brick wall.', sourceMedium: 'photograph', actionPartIds: ['mic'],
    objectRoles: [singer, mic], priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [], reason: 'Preserve the seated performance.', editPrompt: 'Continue the brick wall and retain the original performance pose.',
  }
  const handAssessments = [{ entityId: singer.entityId, kind: 'person', left: { kind: 'ordinary' }, right: { kind: 'gesture', entityId: hand.entityId } }]
  const input = { ...legacy, actionPartIds: ['mic', 'free-hand'], objectRoles: [...legacy.objectRoles, hand], handAssessments }
  const observation = wallpaperRoleObservationOutputSchema(undefined, true, true, true, undefined, true, true)
  const oldObservation = wallpaperRoleObservationOutputSchema(undefined, true, true, true, undefined, true)
  assert.equal(oldObservation.safeParse(legacy).success, true, 'Previously frozen source requests retain the historical contract')
  assert.equal(observation.safeParse(legacy).success, false, 'The current plan records evidence for each person’s hands')
  assert.equal(observation.safeParse({ ...input, handAssessments: [] }).success, false)
  assert.equal(observation.safeParse({ ...input, actionPartIds: ['mic'] }).success, false)
  assert.equal(observation.safeParse({ ...input, handAssessments: [{ ...handAssessments[0], entityId: mic.entityId }] }).success, false)
  const transmitted = z.fromJSONSchema(z.toJSONSchema(observation, { io: 'input' }))
  assert.equal(transmitted.safeParse(legacy).success, false)
  assert.equal(transmitted.safeParse(input).success, true)
  const plan = observation.parse(input)
  assert.deepEqual(observation.parse(plan), plan, 'A committed V11 planning response can be parsed again after a restart')
  assert.deepEqual(plan.actionPartIds, ['mic', 'free-hand'])
  assert.equal(plan.regions.find(region => region.entityId === hand.entityId)?.role, 'critical')
  const check = { result: 'satisfied', reason: 'The same seated pose and the original contact with the microphone remain visible.' }
  const review = wallpaperPracticalReviewOutputSchema('source', 'finished', plan.objectRoles, plan.mode, true, true)
  const output = (right: number, handRight: number) => ({
    reviewVersion: 'wallpaper-review-source-v4', protocol: 'practical-v2', sourceImageVersionId: 'source', outputImageVersionId: 'finished', mode: 'single', subject: 'Seated singer',
    actualLayout: { regions: [
      { entityId: 'singer', name: singer.name, role: 'subject', scope: 'core', rect: { x: 0.11, y: 0.43, width: 0.82, height: 0.57 }, layoutFocus: { x: 0.16, y: 0.43, width: right - 0.16, height: 0.3 } },
      { entityId: 'mic', name: mic.name, role: 'critical', scope: 'core', rect: { x: 0.34, y: 0.54, width: 0.16, height: 0.18 } },
      { entityId: 'free-hand', name: hand.name, role: 'critical', scope: 'core', rect: { x: 0.72, y: 0.5, width: handRight - 0.72, height: 0.16 } },
    ] }, defects: [], uncertainties: [], sourceStyle: check,
    sourcePreservation: plan.objectRoles.map(({ entityId }) => ({ entityId, appearance: check, framing: check, relationships: check })),
  })
  const acceptable = output(0.87, 0.84)
  const onlyPersonAndProp = acceptable.actualLayout.regions.filter(region => region.entityId !== hand.entityId)
  assert.equal(review.safeParse({ ...acceptable, actualLayout: { regions: onlyPersonAndProp } }).success, false)
  const inspect = (right: number, handRight = 0.84) => review.parse(output(right, handRight))
  const outside = wallpaperActualBoundary({ ...inspect(0.92).actualLayout, imageVersionId: 'finished' }, plan.mode, settings, settings.sourceIntentPolicy)
  assert.deepEqual(outside.hard, ['subject-overflow:Seated singer'])
  const slight = wallpaperActualBoundary({ ...inspect(0.87).actualLayout, imageVersionId: 'finished' }, plan.mode, settings, settings.sourceIntentPolicy)
  assert.deepEqual(slight.hard, [])
  assert.ok(slight.warnings.includes('core-outside:Seated singer'))
  const handOutside = wallpaperActualBoundary({ ...inspect(0.84, 0.9).actualLayout, imageVersionId: 'finished' }, plan.mode, settings, settings.sourceIntentPolicy)
  assert.deepEqual(handOutside.hard, ['critical-outside:Open hand'])
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(inspect(0.84, 0.9), false, settings, settings.sourceIntentPolicy)), 'reject')
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(inspect(0.87), false, settings, settings.sourceIntentPolicy)), 'pass')
})

test('direct source observation distinguishes independently displayed products from edge and tabletop support', () => {
  const settings = wallpaperSettingsSchema.parse({ processing: resolveWallpaperProcessing(), sourceIntentPolicy: { version: 'source-intent-v2', alignment: 'subject-fill-v1', fill: { relativeLayout: {} } } })
  const current = completeCanvasWallpaperPrompts(settings, true, true)
  assert.match(current.plan.text, /每个primary的evidence须说明这个对象如何组织画面主题/)
  assert.match(current.plan.text, /边缘框景、搭配、桌面装饰或承托作用的独立物件为supporting/)
  assert.match(current.plan.text, /真正的并列展示和直接承担主题的局部特写仍保留各自的primary/)
  assert.doesNotMatch(completeCanvasWallpaperPrompts(settings, true).plan.text, /每个primary的evidence须说明这个对象如何组织画面主题/)
})

test('same-core measurements preserve visible accessory paths against the complete output frame', () => {
  const settings = wallpaperSettingsSchema.parse({ processing: resolveWallpaperProcessing(), sourceIntentPolicy: { version: 'source-intent-v2', alignment: 'subject-fill-v1', peripheralFrameAdaptation: 'verified-v2', fill: { relativeLayout: {} } } })
  const current = completeCanvasWallpaperPrompts(settings, true, true)
  assert.match(current.plan.text, /sourceIntent\.visibleAccessoryExtent/)
  assert.match(current.plan.text, /在preserve记录连接点、已见端点或自然回绕处/)
  assert.match(current.review.text, /允许超出安全区但不能被成品画框新增截断/)
  assert.match(current.review.text, /保留原有遮挡和已有真实截断，不补全未见部分/)
})
