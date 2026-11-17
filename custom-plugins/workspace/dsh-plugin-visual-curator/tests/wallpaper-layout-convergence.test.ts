/** Recorded station geometry and real candidate pixels guard layout-only convergence. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import sharp from 'sharp'
import { z } from 'zod'
import { wallpaperCompositionEligible, wallpaperDisplayState, wallpaperStateSchema, wallpaperProgress, wallpaperPlanSchema, wallpaperSettingsSchema, wallpaperSourceReviewV4Schema, wallpaperStoredSourceReviewV4Schema, wallpaperReviewKeys, wallpaperItemSchema, wallpaperRepairWithoutProgress, wallpaperReviewReworkAvailable, wallpaperEditingRetry } from '../src/shared/wallpaper.ts'
import { wallpaperCandidatePlacement, wallpaperPositionedLayout } from '../src/shared/wallpaper-geometry.ts'
import { applyWallpaperInventory, applyWallpaperSourceReview } from '../src/host/wallpaper-review.ts'
import { lockWallpaperCandidate } from '../src/media/wallpaper-render.ts'

const recorded = z.object({ settings: wallpaperSettingsSchema, plan: wallpaperPlanSchema,
  cases: z.array(z.object({ revision: z.number(), actualLayout: wallpaperSourceReviewV4Schema.shape.actualLayout,
    expectedPlacement: wallpaperPlanSchema.shape.placement.nullable(), alignment: z.number() })) }).parse(JSON.parse(await readFile(new URL('./fixtures/station-layout.expected.json', import.meta.url), 'utf8')))

function review(actualLayout: typeof recorded.cases[number]['actualLayout'], violated = true) {
  return wallpaperStoredSourceReviewV4Schema.parse(applyWallpaperSourceReview({ reviewVersion: 'wallpaper-review-source-v4', subject: 'Station', actualLayout,
    checks: Object.fromEntries([...wallpaperReviewKeys, 'clarity'].map(key => [key, { result: key === 'protection' && violated ? 'violated' : 'satisfied', reason: 'Independent station observation' }])),
    issues: violated ? [{ kind: 'layout', check: 'protection', code: 'other', reason: 'Frozen primary overflow' }] : [], styleResults: [],
    sourceRepair: { result: 'satisfied', reason: 'Continuous background' }, sourceCorrespondence: { result: 'satisfied', reason: 'Same station' },
    subjectIntegrity: { mode: 'single', source: { extent: 'complete', imageVersionId: recorded.plan.imageVersionId, reason: 'Complete original' },
      output: { extent: 'complete', imageVersionId: actualLayout.imageVersionId, reason: 'Complete candidate' }, task: { result: 'satisfied', reason: 'Identity retained' } },
  }, true, recorded.settings))
}

test('five recorded station versions reproduce saved corrections and distinguish progress from repeated wording', () => {
  const attempts = recorded.cases.map(row => ({ revision: row.revision, plan: recorded.plan, checks: [], needsOutpaint: true,
    outputId: row.actualLayout.imageVersionId, compositionMode: 'generated-canvas-v1', review: review(row.actualLayout, row.revision !== 5) }))
  for (const [index, row] of recorded.cases.entries()) {
    const plan = wallpaperCandidatePlacement(wallpaperItemSchema.parse({ imageVersionId: recorded.plan.imageVersionId, familyId: 'station', status: 'needs-review', edits: index + 1, attempts: [attempts[index]] }).attempts[0]!, recorded.settings)
    if (row.expectedPlacement) assert.deepEqual(plan?.placement, row.expectedPlacement)
    else assert.equal(plan, undefined)
  }
  const item = wallpaperItemSchema.parse({ imageVersionId: recorded.plan.imageVersionId, familyId: 'station', status: 'needs-review', edits: 2, attempts: attempts.slice(0, 2) })
  item.attempts[1]!.review = item.attempts[0]!.review
  assert.equal(wallpaperRepairWithoutProgress(item, recorded.settings), true, 'Unchanged overflow stops even without identical prompts')
  const secondOutput = item.attempts[1]!.outputId
  item.attempts[1]!.outputId = item.attempts[0]!.outputId
  assert.equal(wallpaperRepairWithoutProgress(item, recorded.settings), false, 'Reviewing the same pixels twice is not two failed edits')
  item.attempts[0]!.generationOperation = 'paid-first'
  item.attempts[1]!.generationOperation = 'paid-second'
  assert.equal(wallpaperRepairWithoutProgress(item, recorded.settings), true, 'Two distinct edits returning the same pixels still count as failed repairs')
  delete item.attempts[0]!.generationOperation
  delete item.attempts[1]!.generationOperation
  item.attempts[1]!.outputId = secondOutput
  item.attempts[1]!.review = attempts[1]!.review
  assert.equal(wallpaperRepairWithoutProgress(item, recorded.settings), false, 'The recorded top excess is improving')
})

test('positioned layout separates frozen identities from source rectangles', () => {
  const layout = wallpaperPositionedLayout(recorded.plan, recorded.settings, recorded.settings)
  assert.equal(layout.coordinateSystem, 'whole-output-top-left')
  assert.equal(layout.sourceImageVersionId, recorded.plan.imageVersionId)
  assert.equal('rect' in layout.objectRoles![0]!, false)
  assert.ok(layout.positionedRegions[0]!.rect.y > recorded.settings.safe.top / recorded.settings.height)
  assert.equal(recorded.plan.objectRoles![0]!.rect.y, 0.13, 'The original observation stays unchanged')
})

test('layout-only candidate restoration is forbidden even when the provider reframes the scene', async () => {
  const settings = wallpaperSettingsSchema.parse({ backgroundTransitionPixels: 0 })
  const pixels = Buffer.alloc(1845 * 3280 * 3)
  for (let y = 1200; y < 1600; y++) for (let x = 400; x < 800; x++) pixels[(y * 1845 + x) * 3] = 255
  const candidate = await sharp(pixels, { raw: { width: 1845, height: 3280, channels: 3 } }).png().toBuffer()
  const background = await sharp({ create: { width: 1845, height: 3280, channels: 3, background: '#00ff00' } }).png().toBuffer()
  const plan = wallpaperPlanSchema.parse({ ...recorded.plan, placement: { scale: 0.5, left: 400, top: 1000 }, regions: [{ name: 'Station', role: 'subject', rect: { x: 0.125, y: 0.083333333333, width: 0.375, height: 0.25 } }] })
  await assert.rejects(lockWallpaperCandidate(candidate, plan, settings, background), /overlays are disabled/)
})

test('overflow evidence cannot disappear outside the same entity envelope', () => {
  const original = review(recorded.cases[0]!.actualLayout)
  const bounded = applyWallpaperSourceReview({ ...wallpaperSourceReviewV4Schema.strip().parse(original),
    issues: [{ kind: 'layout', check: 'protection', code: 'other', reason: 'Far truss', evidence: { kind: 'safe-area-overflow', entityIds: ['source-1'], imageVersionId: original.actualLayout.imageVersionId, outputRect: { x: 0.95, y: 0.4, width: 0.05, height: 0.02 } } }],
    actualLayout: { ...original.actualLayout, regions: original.actualLayout.regions.map(region => ({ ...region, rect: { x: 0.2, y: 0.3, width: 0.4, height: 0.4 } })) },
  }, true, recorded.settings)
  assert.ok('actualLayout' in bounded)
  assert.equal(bounded.actualLayout.regions[0]!.rect.x + bounded.actualLayout.regions[0]!.rect.width, 1)
  assert.equal(bounded.checks.protection.result, 'violated')
  const minor = applyWallpaperSourceReview({ ...wallpaperSourceReviewV4Schema.strip().parse(original),
    issues: [{ kind: 'layout', check: 'protection', code: 'minor-peripheral-overflow', reason: 'Tiny peripheral antenna', evidence: { kind: 'safe-area-overflow', entityIds: ['source-1'], imageVersionId: original.actualLayout.imageVersionId, outputRect: { x: 0.86, y: 0.4, width: 0.002, height: 0.01 } } }],
    actualLayout: { ...original.actualLayout, regions: [{ name: 'Core', entityId: 'source-1', role: 'subject', scope: 'core', rect: { x: 0.2, y: 0.4, width: 0.4, height: 0.2 } },
      { name: 'Peripheral antenna', entityId: 'source-1', role: 'subject', scope: 'peripheral', rect: { x: 0.86, y: 0.4, width: 0.002, height: 0.01 } }] },
  }, true, recorded.settings)
  assert.equal(minor.checks.protection.result, 'satisfied', 'Confirmed minor peripheral evidence never expands the hard core')
})


test('allowed subject overflow cannot stop repairs for different background and clarity defects', () => {
  const last = recorded.cases.at(-1)!
  const attempts = [1, 2].map(revision => {
    const base = review(last.actualLayout, false), imageVersionId = 'quality-' + revision
    const check = revision === 1 ? 'background' as const : 'clarity' as const
    const actualLayout = { ...base.actualLayout, imageVersionId, regions: base.actualLayout.regions.map(region => region.role === 'subject' ? { ...region, rect: { ...region.rect, x: (recorded.settings.safe.left - 10) / recorded.settings.width, width: 0.65 } } : region) }
    const measured = wallpaperStoredSourceReviewV4Schema.parse(applyWallpaperSourceReview(wallpaperSourceReviewV4Schema.parse({ reviewVersion: base.reviewVersion, subject: base.subject, styleResults: [],
      checks: { ...base.checks, [check]: { result: 'violated', reason: revision === 1 ? 'Background seam' : 'Unrelated detail loss' } },
      issues: [{ kind: revision === 1 ? 'background' : 'preservation', check, code: 'other', reason: revision === 1 ? 'Background seam' : 'Unrelated detail loss', evidence: { kind: revision === 1 ? 'background-artifact' : 'detail-loss', entityIds: [], imageVersionId, outputRect: { x: 0.4, y: 0.5, width: 0.1, height: 0.1 } } }],
      actualLayout: { ...actualLayout, regions: [...actualLayout.regions, { name: 'Necessary antenna', role: 'critical', scope: 'core', rect: { x: 0.4, y: 0.5, width: 0.02, height: 0.03 } }] }, subjectIntegrity: { ...base.subjectIntegrity, output: { ...base.subjectIntegrity.output, imageVersionId } }, sourceRepair: base.sourceRepair, sourceCorrespondence: base.sourceCorrespondence }), true, recorded.settings))
    assert.equal(measured.checks.protection.result, 'satisfied')
    assert.deepEqual(measured.layoutChecks, [])
    return { revision, plan: recorded.plan, checks: [], needsOutpaint: true, outputId: imageVersionId, compositionMode: 'generated-canvas-v1', review: measured }
  })
  const item = wallpaperItemSchema.parse({ imageVersionId: recorded.plan.imageVersionId, originalId: recorded.plan.imageVersionId, familyId: 'station', status: 'needs-review', edits: 2, attempts })
  assert.equal(wallpaperRepairWithoutProgress(item, recorded.settings), false)
})

test('localized background and layout defects reuse the complete candidate without restoring subject rectangles', () => {
  const base = recorded.cases.find(row => row.expectedPlacement)!
  const quality = review(base.actualLayout)
  const source = { revision: 1, plan: recorded.plan, checks: [], needsOutpaint: true, compositionMode: 'generated-canvas-v1', outputId: base.actualLayout.imageVersionId, review: quality }
  const background = { kind: 'background' as const, check: 'background' as const, code: 'other' as const, reason: 'Localized background seam', evidence: { kind: 'background-artifact' as const, entityIds: [], imageVersionId: source.outputId, outputRect: { x: 0, y: 0.9, width: 0.02, height: 0.05 } } }
  quality.checks.background = { result: 'violated', reason: background.reason }
  quality.modelIssues.push(background); quality.issues.push(background)
  const item = wallpaperItemSchema.parse({ imageVersionId: recorded.plan.imageVersionId, originalId: recorded.plan.imageVersionId, familyId: 'station', status: 'needs-review', edits: 1, attempts: [source] })
  assert.equal(wallpaperEditingRetry(item, recorded.settings)?.layoutCorrection?.version, 'candidate-placement-v1')
  const overlap = item.attempts[0]!.review!
  if (!('modelIssues' in overlap)) throw Error('Fixture must retain model evidence')
  overlap.modelIssues.find(issue => issue.check === 'background')!.evidence!.outputRect = { ...base.actualLayout.regions[0]!.rect }
  assert.ok(wallpaperCandidatePlacement(item.attempts[0]!, recorded.settings), 'A complete generated canvas can repair background beside a protected object without pasting another subject')
})

test('background repair cannot restore subject rectangles over generated pixels', async () => {
  const settings = wallpaperSettingsSchema.parse({ backgroundTransitionPixels: 0, backgroundContextPixels: 0 })
  const candidate = await sharp({ create: { width: settings.width, height: settings.height, channels: 3, background: '#ff0000' } }).png().toBuffer()
  const generated = await sharp({ create: { width: settings.width, height: settings.height, channels: 3, background: '#0000ff' } }).png().toBuffer()
  const plan = wallpaperPlanSchema.parse({ ...recorded.plan, placement: { scale: 1, left: 0, top: 0 }, regions: [{ name: 'Healthy subject', role: 'subject', rect: { x: 0.3, y: 0.5, width: 0.2, height: 0.2 } }] })
  await assert.rejects(lockWallpaperCandidate(candidate, plan, settings, generated, true), /overlays are disabled/)
})

test('an original group with two cookies retains both; only additional instances override a favorable opinion', () => {
  const base = wallpaperSourceReviewV4Schema.strip().parse(review(recorded.cases[0]!.actualLayout))
  const one = { x: 0.4, y: 0.5, width: 0.05, height: 0.05 }, two = { x: 0.5, y: 0.5, width: 0.05, height: 0.05 }
  const inventory = [{ entityId: 'cookies', status: 'retained' as const, sourceInstances: [one, two], instances: [one, two], reason: 'Two source cookies remain two output cookies.' }]
  assert.equal(applyWallpaperInventory({ ...base, inventory, newForeground: [] }).checks.background.result, 'satisfied')
  const extra = applyWallpaperInventory({ ...base, inventory: [{ ...inventory[0]!, instances: [one, two, { ...two, x: 0.6 }] }], newForeground: [] })
  assert.equal(extra.checks.background.result, 'violated')
})

test('pasted historical approvals stay stored but cannot appear as currently qualified outputs', () => {
  const raw = wallpaperStateSchema.parse({ version: 2, skillVersion: 'historical-skill', sourceRunId: 'historical-batch', items: [{ imageVersionId: 'source', originalId: 'source', familyId: 'source', status: 'passed', edits: 1, attempts: [{ revision: 1, plan: recorded.plan, checks: [], needsOutpaint: true, compositionMode: 'background-plate-v2', review: review(recorded.cases[0]!.actualLayout), outputId: 'historical-output' }] }] })
  const snapshot = structuredClone(raw), presented = wallpaperDisplayState(raw)
  assert.equal(wallpaperCompositionEligible(raw.items[0]!.attempts[0]), false)
  assert.equal(presented.items[0]!.status, 'needs-review')
  assert.equal(wallpaperProgress(raw).passed, 0)
  assert.deepEqual(raw, snapshot)
})
