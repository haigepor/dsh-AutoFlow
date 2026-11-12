/** Frozen authorization permits generated repair without weakening independent final checks. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import { wallpaperPlanSchema, wallpaperRepairObservationPlanSchema, wallpaperHasBackgroundAnchors, wallpaperSettingsSchema, wallpaperSubjectCheck, wallpaperStoredSourceReviewV4Schema, wallpaperReviewKeys } from '../src/shared/wallpaper.ts'
import { wallpaperCandidatePlacement, wallpaperGeometry, wallpaperObjectProtectionRegions } from '../src/shared/wallpaper-geometry.ts'
import { wallpaperRepairMask, wallpaperSourceRepairNeeded } from '../src/media/wallpaper-repair.ts'
import { wallpaperRepairPolicySchema } from '../src/shared/wallpaper-policy.ts'
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
  const pixels = await sharp(await wallpaperRepairMask(mask, plan, authorized, [], { width: 1000, height: 1000 })).ensureAlpha().raw().toBuffer()
  assert.equal(pixels[(1500 * 1845 + 800) * 4 + 3], 0, 'Defective truck pixels are editable')
  assert.equal(pixels[(100 * 1845 + 100) * 4 + 3], 255, 'Healthy area remains protected')
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

test('layout correction uniformly fits a complete candidate while incomplete structure and unclear quality still require repair', () => {
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
})
