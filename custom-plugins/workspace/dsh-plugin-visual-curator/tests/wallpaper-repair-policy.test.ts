/** Frozen authorization permits generated repair without weakening independent final checks. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import { wallpaperPlanSchema, wallpaperRepairObservationPlanSchema, wallpaperRoleObservationPlanSchema, wallpaperRoleObservationOutputSchema, wallpaperHasBackgroundAnchors, wallpaperSettingsSchema, wallpaperSubjectCheck, wallpaperStoredSourceReviewV4Schema, wallpaperReviewKeys } from '../src/shared/wallpaper.ts'
import { wallpaperCandidatePlacement, wallpaperGeometry, wallpaperObjectProtectionRegions, wallpaperSourceExtensionEdges, wallpaperSourceContinuationTargets, wallpaperSourceContinuationReviewRegions, fitWallpaperPlacement } from '../src/shared/wallpaper-geometry.ts'
import { retainWallpaperRegions, retainWallpaperObjectRoles, wallpaperPlanConcerns } from '../src/shared/wallpaper-detail.ts'
import { wallpaperRepairMask, wallpaperSourceRepairNeeded } from '../src/media/wallpaper-repair.ts'
import { wallpaperRepairPolicySchema } from '../src/shared/wallpaper-policy.ts'
import { wallpaperReviewNeedsSubjectEdit, resolveWallpaperProcessing } from '../src/shared/wallpaper-policy.ts'
import { wallpaperGenerationRetry, wallpaperEditingRetry, wallpaperItemSchema } from '../src/shared/wallpaper.ts'
import { sourceFaithfulWallpaperPrompts } from '../src/shared/wallpaper-prompts.ts'
import { serviceFixture } from './helpers/service-fixture.ts'
import { specOf } from '../src/host/runtime.ts'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

test('new direct admissions freeze generated repair by default while historical fixtures can opt into preservation', async () => {
  const fixture = await serviceFixture()
  try {
    delete fixture.service.config.wallpaper.repairPolicy
    await fixture.service.initialize()
    const path = join(fixture.root, 'new-default.png')
    await writeFile(path, await sharp({ create: { width: 100, height: 100, channels: 3, background: '#405040' } }).png().toBuffer())
    const { runId } = z.object({ runId: z.string() }).parse(await fixture.action('direct-crop-start', { operationId: 'new-default', name: 'Default policy', source: { kind: 'local', files: [{ path, name: 'new-default.png' }] } }))
    const frozen = specOf(fixture.domain.require('run', runId)).fixed
    assert.equal(wallpaperSettingsSchema.parse(frozen.wallpaper).repairPolicy?.mode, 'repair-when-needed')
    assert.equal(z.object({ version: z.string() }).parse(frozen.directPolicy).version, 'subject-repair-v1')
    assert.equal(z.object({ plan: z.object({ version: z.literal('wallpaper-plan-v8') }) }).parse(frozen.prompts).plan.version, 'wallpaper-plan-v8')
    await fixture.jobs.drain()
  } finally { await fixture.cleanup() }
})

test('localized source uncertainty permits a candidate only with frozen generated-repair authorization', async () => {
  const plan = wallpaperPlanSchema.parse({ version: 1, imageVersionId: 'source', mode: 'single', subject: 'Cut-off truck', evidence: 'Truck front is missing.', priorities: [], anchors: [], truncations: ['Front cut off'], uncertainties: ['Front connection unclear'], regions: [{ name: 'Truck', role: 'subject', rect: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 } }, { name: 'Cab', role: 'critical', rect: { x: 0.3, y: 0.3, width: 0.1, height: 0.1 } }], placement: { scale: 1, left: 500, top: 1200 }, reason: 'Leave room for generated front.' })
  const legacy = wallpaperSettingsSchema.parse({}), authorized = wallpaperSettingsSchema.parse({ repairPolicy: wallpaperRepairPolicySchema.parse({}) })
  assert.equal(wallpaperSourceRepairNeeded(plan, authorized), true, 'Observed missing truck structure authorizes generation')
  assert.ok(wallpaperGeometry({ width: 1000, height: 1000 }, plan, legacy).checks.includes('uncertain-subject'))
  assert.deepEqual(wallpaperGeometry({ width: 1000, height: 1000 }, plan, authorized).checks, [])
  const { placement: _placement, ...observation } = plan
  assert.ok(wallpaperRepairObservationPlanSchema.safeParse({ ...observation, editPrompt: 'Repair the missing front.' }).success)
  assert.equal(wallpaperRepairObservationPlanSchema.safeParse({ ...observation, editPrompt: 'Repair the front.', regions: [...plan.regions, { name: 'Sky', role: 'anchor', rect: { x: 0, y: 0, width: 1, height: 0.2 } }] }).success, false)
  assert.equal(wallpaperHasBackgroundAnchors({ ...plan, regions: [...plan.regions, { name: 'Local focal detail', role: 'anchor', rect: { x: 0.3, y: 0.3, width: 0.1, height: 0.1 } }] }), false)
  assert.equal(wallpaperHasBackgroundAnchors({ ...plan, regions: [...plan.regions, { name: 'Sky', role: 'anchor', rect: { x: 0, y: 0, width: 1, height: 0.2 } }] }), true)
  const mask = await sharp({ create: { width: 1845, height: 3280, channels: 4, background: '#ffffff' } }).png().toBuffer()
  assert.equal(await wallpaperRepairMask(mask, plan, legacy, [], { width: 1000, height: 1000 }), mask)
  assert.equal(await wallpaperRepairMask(mask, plan, authorized, [], { width: 1000, height: 1000 }), mask, 'A truncation note alone cannot open interior pixels')
  const edgeRepair = wallpaperSettingsSchema.parse({ repairPolicy: wallpaperRepairPolicySchema.parse({}), sourceFrameRepair: { enabled: true, marginPixels: 128 } })
  const edgePlan = { ...plan, regions: [{ ...plan.regions[0]!, rect: { x: 0, y: 0.2, width: 0.4, height: 0.4 } }, plan.regions[1]!] }
  const pixels = await sharp(await wallpaperRepairMask(mask, edgePlan, edgeRepair, [], { width: 1000, height: 1000 })).ensureAlpha().raw().toBuffer()
  assert.equal(pixels[(1500 * 1845 + 550) * 4 + 3], 0, 'Only a bounded source-edge strip is editable')
  assert.equal(pixels[(1500 * 1845 + 800) * 4 + 3], 255, 'Healthy subject interior remains protected')
  assert.equal(pixels[(100 * 1845 + 100) * 4 + 3], 255, 'Healthy background remains protected')
  const cosmetics = { ...plan, regions: [
    { name: 'Left bottle', role: 'subject' as const, rect: { x: 0, y: 0.25, width: 0.2, height: 0.5 } },
    { name: 'Top cap', role: 'subject' as const, rect: { x: 0.4, y: 0, width: 0.2, height: 0.2 } },
    { name: 'Right brush', role: 'subject' as const, rect: { x: 0.8, y: 0.4, width: 0.2, height: 0.2 } },
    { name: 'Bottom palette', role: 'subject' as const, rect: { x: 0.5, y: 0.8, width: 0.4, height: 0.2 } },
  ] }
  const cosmeticsPixels = await sharp(await wallpaperRepairMask(mask, cosmetics, edgeRepair, [], { width: 1000, height: 1000 })).ensureAlpha().raw().toBuffer()
  assert.equal(cosmeticsPixels[(1700 * 1845 + 1000) * 4 + 3], 255, 'Four cut source edges still cannot open the healthy makeup interior')
  assert.equal(cosmeticsPixels[(1200 * 1845 + 950) * 4 + 3], 0, 'The cut top edge remains editable')
  const healthy = { ...plan, truncations: [], uncertainties: [] }
  assert.equal(await wallpaperRepairMask(mask, healthy, authorized, [], { width: 1000, height: 1000 }, true), mask, 'No clock policy keeps a healthy source protected')
  const layoutUncertain = { ...healthy, uncertainties: ['The cup rim may approach the final safe boundary'] }
  assert.equal(wallpaperSourceRepairNeeded(layoutUncertain, authorized), false, 'Final placement uncertainty does not authorize source reconstruction')
  assert.equal(await wallpaperRepairMask(mask, layoutUncertain, authorized, [], { width: 1000, height: 1000 }), mask)
  const clockPolicy = wallpaperSettingsSchema.parse({ repairPolicy: wallpaperRepairPolicySchema.parse({}), processing: { clockContrast: {} } })
  const clockPixels = await sharp(await wallpaperRepairMask(mask, healthy, clockPolicy, [], { width: 1000, height: 1000 }, true)).ensureAlpha().raw().toBuffer()
  assert.equal(clockPixels[(500 * 1845 + 900) * 4 + 3], 0, 'An explicit clock policy can open the clock background')
  assert.equal(clockPixels[(500 * 1845 + 100) * 4 + 3], 255, 'Other source pixels remain protected')
  assert.match(sourceFaithfulWallpaperPrompts(authorized).plan.text, /已看清的严重缺失直接/)
  assert.match(sourceFaithfulWallpaperPrompts(authorized).review.text, /sourceCorrespondence/)
})

test('placed cosmetic source edges open only interior object endings, not the final-frame bottom crop', async () => {
  const settings = wallpaperSettingsSchema.parse({ repairPolicy: {}, sourceFrameRepair: { enabled: true, marginPixels: 128 } })
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })
  const plan = wallpaperPlanSchema.parse({ version: 1, imageVersionId: 'cosmetics-source', mode: 'group', subject: 'Two lipsticks', evidence: 'The lipsticks lead a makeup still life.', priorities: [], anchors: [], truncations: [], uncertainties: [],
    regions: [{ entityId: 'lipstick', name: 'Lipstick', role: 'subject', rect: rect(0.4, 0.4, 0.2, 0.3) }],
    objectRoles: [
      { entityId: 'lipstick', name: 'Lipstick', role: 'primary', evidence: 'Central focal object', rect: rect(0.4, 0.4, 0.2, 0.3), sourceEdges: [] },
      { entityId: 'top-bottle', name: 'Top bottle', role: 'supporting', evidence: 'Visible upper bottle', rect: rect(0.35, 0, 0.25, 0.28), sourceEdges: ['top'] },
      { entityId: 'left-bottle', name: 'Left bottle', role: 'supporting', evidence: 'Visible left bottle', rect: rect(0, 0.2, 0.22, 0.4), sourceEdges: ['left'] },
      { entityId: 'right-brush', name: 'Right brush', role: 'supporting', evidence: 'Visible right brush', rect: rect(0.73, 0.35, 0.27, 0.2), sourceEdges: ['right'] },
      { entityId: 'bottom-palette', name: 'Bottom palette', role: 'supporting', evidence: 'Visible bottom palette', rect: rect(0.3, 0.8, 0.35, 0.2), sourceEdges: ['bottom'] },
    ], placement: { scale: 0.88125, left: 110, top: 586 }, reason: 'Saved makeup placement' })
  const source = { width: 1845, height: 3280 }
  const targets = wallpaperSourceContinuationTargets(plan, settings, source)
  assert.deepEqual(targets.map(({ entityId, disposition }) => [entityId, disposition]), [
    ['top-bottle', 'interior'], ['left-bottle', 'interior'], ['right-brush', 'interior'], ['bottom-palette', 'final-frame-crop'],
  ])
  const reviewRegions = wallpaperSourceContinuationReviewRegions(plan, settings, source)
  assert.deepEqual(reviewRegions.map(({ entityId }) => entityId), ['top-bottle', 'left-bottle', 'right-brush'])
  assert.ok(reviewRegions[0]!.rect.y < plan.placement.top / settings.height, 'The enlarged review sees generated pixels above the old top cut')
  assert.ok(reviewRegions[0]!.rect.y + reviewRegions[0]!.rect.height > plan.placement.top / settings.height, 'The same view also sees the original bottle')
  const mask = await sharp({ create: { width: settings.width, height: settings.height, channels: 4, background: '#ffffff' } }).png().toBuffer()
  const alpha = await sharp(await wallpaperRepairMask(mask, plan, settings, [], source)).extractChannel('alpha').raw().toBuffer()
  assert.equal(alpha[600 * settings.width + 900], 0, 'The old top cut inside the frame can be redrawn')
  assert.equal(alpha[600 * settings.width + 1500], 255, 'Unrelated healthy pixels along the same source edge remain protected')
  assert.equal(alpha[3200 * settings.width + 900], 255, 'The final-frame bottom crop does not open healthy pixels')
})

test('generated completion keeps the damaged source fact and requires a complete independently checked output', () => {
  const integrity = { mode: 'single' as const, source: { extent: 'cut-off' as const, reason: 'Source truck front missing', imageVersionId: 'source' }, output: { extent: 'complete' as const, reason: 'Generated front and wheel visible', imageVersionId: 'output' }, task: { result: 'satisfied' as const, reason: 'Authorized generated completion meets task' } }
  assert.equal(wallpaperSubjectCheck(integrity).result, 'violated')
  assert.equal(wallpaperSubjectCheck(integrity, true).result, 'satisfied')
  assert.equal(wallpaperSubjectCheck({ ...integrity, mode: 'scene' }, true).result, 'satisfied')
  assert.equal(integrity.source.extent, 'cut-off')
  assert.equal(wallpaperSubjectCheck({ ...integrity, output: { ...integrity.output, extent: 'cut-off' } }, true).result, 'violated')
  assert.equal(wallpaperSubjectCheck({ ...integrity, output: { ...integrity.output, extent: 'unknown' } }, true).result, 'unknown')
})

test('one complete object rectangle supplies stricter core protection without another observation', () => {
  const plan = wallpaperPlanSchema.parse({ version: 1, imageVersionId: 'source', mode: 'single', subject: 'Complete car', evidence: 'All visible car parts are inside the frame.', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [{ name: 'Entire car', role: 'subject', rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.5 } }], placement: { scale: 1, left: 200, top: 1200 }, reason: 'Keep every car part protected.' })
  const settings = wallpaperSettingsSchema.parse({ repairPolicy: wallpaperRepairPolicySchema.parse({}) })
  const normalized = { ...plan, regions: wallpaperObjectProtectionRegions(plan) }
  assert.deepEqual(normalized.regions[1]?.rect, plan.regions[0]?.rect)
  assert.equal(normalized.regions[1]?.role, 'critical')
  assert.deepEqual(wallpaperGeometry({ width: 1000, height: 1000 }, normalized, settings).checks, [])
  assert.ok(wallpaperGeometry({ width: 1000, height: 1000 }, { ...normalized, placement: { ...normalized.placement, left: 100 } }, settings).checks.some(check => check.startsWith('critical-outside:')))
  assert.equal(wallpaperObjectProtectionRegions({ ...plan, regions: [] }).length, 0)
  assert.ok(wallpaperGeometry({ width: 1000, height: 1000 }, { ...plan, regions: [] }, settings).checks.includes('missing-protected-regions'))
})

test('cosmetics protect the two focal lipsticks without shrinking for supporting products', () => {
  const objects = [
    { entityId: 'red-lipstick', name: 'Red lipstick', role: 'primary', evidence: 'Central saturated foreground product', rect: { x: 0.4, y: 0.42, width: 0.12, height: 0.28 }, sourceEdges: [] },
    { entityId: 'black-lipstick', name: 'Black lipstick', role: 'primary', evidence: 'Second central lipstick', rect: { x: 0.53, y: 0.34, width: 0.11, height: 0.3 }, sourceEdges: [] },
    { entityId: 'left-bottle', name: 'Foundation bottle', role: 'supporting', evidence: 'Peripheral product', rect: { x: 0, y: 0.06, width: 0.25, height: 0.58 }, sourceEdges: ['left'] },
    { entityId: 'top-bottle', name: 'Top bottle', role: 'supporting', evidence: 'Source-frame crop', rect: { x: 0.38, y: 0, width: 0.24, height: 0.22 }, sourceEdges: ['top'] },
  ] as const
  const observation = { version: 1, imageVersionId: 'source', mode: 'group', subject: 'Two lipsticks', evidence: 'Red lipsticks lead the product scene.', priorities: [], anchors: ['Pink studio background'], truncations: [], uncertainties: [],
    objectRoles: objects.map(object => ({ ...object, sourceEdges: [...object.sourceEdges] })),
    regions: objects.filter(object => object.role === 'primary').map(object => ({ name: object.name, entityId: object.entityId, role: 'subject', rect: object.rect })), reason: 'Keep the lipsticks prominent.', editPrompt: 'Extend the original pink product photograph.' }
  const parsed = wallpaperRoleObservationPlanSchema.parse(observation)
  assert.deepEqual(wallpaperPlanConcerns(wallpaperPlanSchema.parse({ ...parsed, placement: { scale: 1, left: 0, top: 0 } })), [], 'Two primary objects do not require an invented critical part')
  const frozen = wallpaperRoleObservationOutputSchema(parsed.objectRoles)
  assert.equal(frozen.safeParse({ ...observation, regions: observation.regions.map(region => ({ ...region, name: `${region.name} observed again` })) }).success, true)
  assert.equal(frozen.safeParse({ ...observation, objectRoles: observation.objectRoles.map(object => object.entityId === 'left-bottle' ? { ...object, role: 'primary' } : object) }).success, false)
  assert.equal(wallpaperRoleObservationPlanSchema.safeParse({ ...observation, regions: [...observation.regions, { name: 'Bottle', entityId: 'left-bottle', role: 'subject', rect: objects[2].rect }] }).success, false)
  assert.equal(wallpaperRoleObservationPlanSchema.safeParse({ ...observation, regions: observation.regions.slice(0, 1) }).success, false)
  assert.equal(wallpaperRoleObservationPlanSchema.safeParse({ ...observation, objectRoles: observation.objectRoles.map(object => object.entityId === 'top-bottle' ? { ...object, sourceEdges: [] } : object) }).success, false)
  assert.equal(wallpaperRoleObservationPlanSchema.safeParse({ ...observation, mode: 'group', objectRoles: observation.objectRoles.slice(2), regions: [] }).success, false, 'A group cannot hide the focal objects')
  assert.equal(wallpaperRoleObservationPlanSchema.safeParse({ ...observation, mode: 'uncertain', objectRoles: observation.objectRoles.slice(2), regions: [] }).success, true, 'Ambiguous foreground roles remain a planning hold instead of a malformed response')
  assert.equal(wallpaperRoleObservationPlanSchema.safeParse({ ...observation, mode: 'abstract', objectRoles: [], regions: [] }).success, true, 'An abstract source need not invent a foreground object')
  const settings = wallpaperSettingsSchema.parse({ repairPolicy: {}, sourceFrameRepair: { enabled: true, marginPixels: 128 } })
  const focused = { ...parsed, regions: wallpaperObjectProtectionRegions(parsed) }
  const wholeDisplay = { ...focused, regions: [...focused.regions, ...objects.slice(2).map(object => ({ name: object.name, entityId: object.entityId, role: 'critical' as const, rect: object.rect }))] }
  const focusedScale = fitWallpaperPlacement({ width: 1845, height: 3280 }, focused, settings, 'subject-first-v2').scale
  const wholeDisplayScale = fitWallpaperPlacement({ width: 1845, height: 3280 }, wholeDisplay, settings, 'subject-first-v2').scale
  assert.ok(focusedScale > wholeDisplayScale, 'Supporting bottles do not force the focal lipstick pair to shrink')
  assert.deepEqual(wallpaperSourceExtensionEdges(focused, settings), ['left', 'top'])
  assert.equal(wallpaperSourceRepairNeeded(wallpaperPlanSchema.parse({ ...focused, placement: { scale: focusedScale, left: 0, top: 0 } }), settings), true)
  const renamed = retainWallpaperRegions(focused.regions, focused.regions.map(region => ({ ...region, name: `Reworded ${region.name}`, rect: { ...region.rect, width: region.rect.width + 0.01 } })))
  assert.equal(renamed.length, focused.regions.length, 'Stable IDs prevent repeated object names from adding rectangles')
  assert.ok(renamed.every(region => region.rect.width > focused.regions.find(previous => previous.entityId === region.entityId && previous.role === region.role)!.rect.width))
  const retainedObjects = retainWallpaperObjectRoles(parsed.objectRoles, parsed.objectRoles.map(object => object.entityId === 'top-bottle' ? { ...object, name: 'Renamed top prop', rect: { x: 0.4, y: 0.04, width: 0.18, height: 0.12 }, sourceEdges: [] } : object))
  assert.deepEqual(retainedObjects.find(object => object.entityId === 'top-bottle')?.sourceEdges, ['top'])
  assert.deepEqual(retainedObjects.find(object => object.entityId === 'top-bottle')?.rect, objects[3].rect)
})

test('layout correction uniformly fits a complete candidate while incomplete structure and unclear quality still require repair', async () => {
  const settings = wallpaperSettingsSchema.parse({ repairPolicy: wallpaperRepairPolicySchema.parse({}) })
  const plan = wallpaperPlanSchema.parse({ version: 1, imageVersionId: 'source', mode: 'single', subject: 'Repaired truck', evidence: 'Missing front in source', priorities: [], anchors: [], truncations: ['Front missing'], uncertainties: [], regions: [], placement: { scale: 1, left: 0, top: 0 }, reason: 'Original observation' })
  const review = wallpaperStoredSourceReviewV4Schema.parse({ reviewVersion: 'wallpaper-review-source-v4', subject: 'Complete truck too wide', layoutChecks: [], layoutWarnings: [], modelProtectionCheck: { result: 'violated', reason: 'Truck exceeds side bounds' }, modelIssues: [], checks: Object.fromEntries([...wallpaperReviewKeys, 'clarity'].map(key => [key, { result: key === 'protection' ? 'violated' : 'satisfied', reason: 'Independent output evidence' }])), issues: [{ kind: 'layout', check: 'protection', code: 'other', reason: 'Truck exceeds side bounds' }], styleResults: [], sourceRepair: { result: 'satisfied', reason: 'Completed front visible' }, sourceCorrespondence: { result: 'satisfied', reason: 'Visible source structure retained' }, actualLayout: { imageVersionId: 'candidate', regions: [{ name: 'Whole truck', role: 'subject', scope: 'core', rect: { x: 0.01, y: 0.15, width: 0.98, height: 0.8 } }] }, subjectIntegrity: { mode: 'single', source: { extent: 'cut-off', imageVersionId: 'source', reason: 'Front missing' }, output: { extent: 'complete', imageVersionId: 'candidate', reason: 'Full truck visible' }, task: { result: 'satisfied', reason: 'Authorized reconstruction' } } })
  const prior = { plan, review, outputId: 'candidate', compositionMode: 'generated-canvas-v1' as const }
  const correction = wallpaperCandidatePlacement(prior, settings)!
  assert.ok(correction.placement.scale > 0 && correction.placement.scale < 1)
  assert.deepEqual(wallpaperGeometry(settings, correction, settings).checks, [])
  assert.equal(correction.imageVersionId, 'candidate'); assert.equal(plan.imageVersionId, 'source')
  assert.deepEqual(correction.truncations, []); assert.deepEqual(plan.truncations, ['Front missing'])
  assert.equal(wallpaperCandidatePlacement(prior, wallpaperSettingsSchema.parse({})), undefined)
  for (const key of ['subject', 'composition', 'background', 'style', 'clarity'] as const) {
    const changed = structuredClone(prior); changed.review.checks[key].result = 'unknown'
    assert.equal(wallpaperCandidatePlacement(changed, settings), undefined, key)
  }
  const incomplete = structuredClone(prior); incomplete.review.subjectIntegrity.output.extent = 'cut-off'
  assert.equal(wallpaperCandidatePlacement(incomplete, settings), undefined)
  const unrelated = structuredClone(prior); unrelated.review.issues.push({ kind: 'preservation', check: 'subject', code: 'other', reason: 'Missing wheel' })
  assert.equal(wallpaperCandidatePlacement(unrelated, settings), undefined)

  const layoutOnly = structuredClone(prior)
  layoutOnly.plan.truncations = []
  layoutOnly.review.modelIssues = [{ kind: 'layout', check: 'composition', code: 'other', reason: 'The complete group needs uniform repositioning' }]
  layoutOnly.review.checks.subject.result = 'violated'; layoutOnly.review.checks.composition.result = 'violated'
  layoutOnly.review.subjectIntegrity.task.result = 'violated'; layoutOnly.review.sourceRepair.result = 'violated'
  layoutOnly.review.issues.push({ kind: 'preservation', check: 'subject', code: 'other', reason: 'Task placement was not met' })
  assert.equal(wallpaperReviewNeedsSubjectEdit(layoutOnly.review), false, 'Layout-derived subject/task failures do not authorize content reconstruction')
  assert.ok(wallpaperCandidatePlacement(layoutOnly, settings), 'A complete layout-only candidate can be moved as a whole')
  const mask = await sharp({ create: { width: settings.width, height: settings.height, channels: 4, background: '#ffffff' } }).png().toBuffer()
  const previous = { ...layoutOnly, revision: 1, checks: [], needsOutpaint: true }
  assert.equal(await wallpaperRepairMask(mask, layoutOnly.plan, settings, [previous], settings), mask, 'Healthy subject pixels stay protected during a layout correction')
  const damage = structuredClone(layoutOnly.review)
  damage.checks.clarity.result = 'violated'; damage.modelIssues.push({ kind: 'preservation', check: 'clarity', code: 'other', reason: 'Visible edges are smeared' })
  assert.equal(wallpaperReviewNeedsSubjectEdit(damage), true, 'Actual texture damage still authorizes subject editing')

  const corrected = { ...previous, layoutCorrection: { version: 'candidate-placement-v1' as const, plan: correction }, generationOperation: 'old-operation' }
  const technicalRetry = wallpaperGenerationRetry(corrected, '2026-11-13T00:00:00.000Z')
  assert.deepEqual(technicalRetry.layoutCorrection, corrected.layoutCorrection)
  assert.notEqual(technicalRetry.layoutCorrection, corrected.layoutCorrection)
  assert.equal(technicalRetry.generationOperation, undefined)
  assert.equal(technicalRetry.review, undefined)
  const backgroundRetry = structuredClone(corrected)
  backgroundRetry.review.modelIssues = [{ kind: 'background', check: 'background', code: 'other', reason: 'Background seam remains' }]
  backgroundRetry.review.issues = backgroundRetry.review.modelIssues
  const item = wallpaperItemSchema.parse({ imageVersionId: 'source', familyId: 'family', status: 'needs-review', edits: 1, attempts: [backgroundRetry] })
  assert.deepEqual(wallpaperEditingRetry(item, settings)?.layoutCorrection, corrected.layoutCorrection, 'A later background edit retains the current candidate placement')
})

test('new admission inset leaves drift room inside the same safe area without changing historical placement policy', () => {
  const settings = wallpaperSettingsSchema.parse({ processing: resolveWallpaperProcessing() })
  const plan = wallpaperPlanSchema.parse({ version: 1, imageVersionId: 'source', mode: 'single', subject: 'Whole food bowl', evidence: 'Complete foreground object', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [{ name: 'Whole bowl', role: 'subject', rect: { x: 0.155, y: 0.18, width: 0.745, height: 0.565 } }, { name: 'Whole bowl core', role: 'critical', rect: { x: 0.155, y: 0.18, width: 0.745, height: 0.565 } }], placement: { scale: 1, left: 0, top: 0 }, reason: 'Source observation' })
  const { placement: _placement, ...observed } = plan
  const placement = fitWallpaperPlacement(settings, observed, settings, 'subject-first-v2')
  const measured = wallpaperGeometry(settings, { ...plan, placement }, settings)
  assert.deepEqual(measured.checks, [])
  for (const region of measured.regions) {
    assert.ok(region.left >= settings.safe.left + 24)
    assert.ok(region.top >= settings.safe.top + 24)
    assert.ok(region.left + region.width <= settings.safe.left + settings.safe.width - 24)
    assert.ok(region.top + region.height <= settings.safe.top + settings.safe.height - 24)
  }
  assert.equal(wallpaperSettingsSchema.parse({ processing: {} }).processing?.layoutInsetPixels, undefined, 'Reading an old checkpoint does not add the current inset')
})
