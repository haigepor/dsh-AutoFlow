/** Recorded seven-image observations retain native and final evidence through safe candidate retries. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import sharp from 'sharp'
import { z } from 'zod'
import { contentDigest } from '../src/domain/repository.ts'
import { wallpaperGenerationAlignment } from '../src/media/wallpaper-alignment.ts'
import { wallpaperGeometry, wallpaperModelPlan, wallpaperPositionedLayout } from '../src/shared/wallpaper-geometry.ts'
import { wallpaperAttemptReview, wallpaperEditingRetry, wallpaperGenerationRetry, wallpaperItemSchema, wallpaperReviewReworkAvailable, wallpaperSettingsSchema, wallpaperVerdict } from '../src/shared/wallpaper.ts'
import { applyWallpaperBoundaryDetail, wallpaperBoundaryReviewNeeded } from '../src/host/wallpaper-review.ts'

const recorded = z.object({ version: z.literal(1), settings: wallpaperSettingsSchema,
  cases: z.array(z.object({ number: z.number().int(), item: wallpaperItemSchema })) }).parse(JSON.parse(await readFile(new URL('./fixtures/wallpaper-still-life-batch.expected.json', import.meta.url), 'utf8')))

test('model instructions retain one frozen subject role while Host core protection remains unchanged', () => {
  const plan = recorded.cases.find(row => row.number === 3)!.item.attempts.at(-1)!.plan
  const original = contentDigest(plan), model = wallpaperModelPlan(plan)
  assert.deepEqual(model.regions.map(region => region.role), ['subject', 'subject'])
  assert.deepEqual(wallpaperPositionedLayout(plan, recorded.settings, recorded.settings).positionedRegions.map(region => region.role), ['subject', 'subject'])
  assert.equal(wallpaperGeometry(recorded.settings, plan, recorded.settings).regions.length, 4)
  assert.equal(contentDigest(plan), original)
  const { objectRoles: _objects, ...legacy } = plan
  assert.equal(wallpaperModelPlan(legacy), legacy)
})

for (const number of [2, 6]) test(`recorded still life ${number} repairs background and Host-only overflow using one complete generated canvas`, () => {
  const item = recorded.cases.find(row => row.number === number)!.item
  const original = contentDigest(item), prior = item.attempts.at(-1)!
  const review = prior.review!
  assert.ok('modelIssues' in review)
  assert.equal(review.modelIssues.some(issue => issue.kind === 'layout'), false)
  assert.ok(review.layoutChecks.length > 0)
  assert.equal(wallpaperReviewReworkAvailable(item, recorded.settings), true)
  const retry = wallpaperEditingRetry(item, recorded.settings)
  assert.ok(retry?.layoutCorrection)
  assert.equal(retry.layoutCorrection.version, 'candidate-placement-v1')
  assert.deepEqual(wallpaperGeometry(recorded.settings, retry.layoutCorrection.plan, recorded.settings).checks, [])
  assert.equal(retry.layoutCorrection.plan.imageVersionId, prior.outputId)
  assert.equal(retry.generation, undefined)
  assert.equal(contentDigest(item), original)
})

test('recorded final safety rejection drives correction without replacing the passed native review', () => {
  const item = recorded.cases.find(row => row.number === 3)!.item
  const original = contentDigest(item), prior = item.attempts.at(-1)!
  assert.equal(wallpaperVerdict(prior.review!), 'pass')
  const review = wallpaperAttemptReview(prior)!
  assert.equal(wallpaperVerdict(review), 'reject')
  assert.ok('modelIssues' in review)
  assert.equal(wallpaperBoundaryReviewNeeded(review), true)
  assert.equal(wallpaperReviewReworkAvailable(item, recorded.settings), false, 'Unconfirmed final geometry requires its boundary review before another edit')
  const confirmed = structuredClone(item), final = confirmed.attempts.at(-1)!.postResolutionReview!
  final.review = applyWallpaperBoundaryDetail(review, review, 'isolated-confirmed-final-boundary')
  assert.equal(wallpaperVerdict(final.review), 'reject', 'Repeating the same overflowing bounds never approves the image')
  assert.equal(wallpaperReviewReworkAvailable(confirmed, recorded.settings), true)
  const retry = wallpaperEditingRetry(confirmed, recorded.settings)!
  assert.equal(retry.layoutCorrection!.version, 'candidate-placement-v1')
  assert.equal(retry.layoutCorrection!.plan.imageVersionId, prior.outputId)
  assert.deepEqual(wallpaperGeometry(recorded.settings, retry.layoutCorrection!.plan, recorded.settings).checks, [])
  assert.equal(contentDigest(item), original)
})

test('a recorded overlapping-subject composite requires a new source plan and retains its earlier attempts', () => {
  const item = structuredClone(recorded.cases.find(row => row.number === 3)!.item)
  item.attempts = item.attempts.slice(0, 3)
  item.edits = 3
  const original = contentDigest(item)
  assert.equal(wallpaperReviewReworkAvailable(item, recorded.settings), true)
  assert.equal(wallpaperEditingRetry(item, recorded.settings), undefined)
  assert.equal(contentDigest(item), original)
})

test('new technical retries of recorded locked candidates use complete generation and keep historical receipts', () => {
  const prior = recorded.cases.find(row => row.number === 3)!.item.attempts[2]!
  const original = contentDigest(prior)
  const retry = wallpaperGenerationRetry(prior, '2026-11-16T12:00:00.000Z')
  assert.equal(retry.layoutCorrection!.version, 'candidate-placement-v1')
  assert.deepEqual(retry.layoutCorrection!.plan, prior.layoutCorrection!.plan)
  assert.equal(retry.generatedImageId, undefined)
  assert.equal(retry.nativeReviewCandidate, undefined)
  assert.equal(contentDigest(prior), original)
})

test('recorded approved originals are not admitted to automatic rework', () => {
  for (const number of [1, 4, 5, 7]) {
    const item = recorded.cases.find(row => row.number === number)!.item
    assert.equal(wallpaperReviewReworkAvailable(item, recorded.settings), false)
    assert.equal(wallpaperVerdict(wallpaperAttemptReview(item.attempts.at(-1))!), 'pass')
  }
})

test('protection verification checks an identity-size candidate even when it exposes no new canvas', async () => {
  const plan = structuredClone(recorded.cases.find(row => row.number === 3)!.item.attempts[2]!.layoutCorrection!.plan)
  assert.deepEqual(plan.placement, { scale: 1, left: 0, top: 0 })
  const candidate = await sharp({ create: { width: recorded.settings.width, height: recorded.settings.height, channels: 3, background: '#c94a63' } }).png().toBuffer()
  const generated = await sharp({ create: { width: recorded.settings.width, height: recorded.settings.height, channels: 3, background: '#309a67' } }).png().toBuffer()
  assert.equal(wallpaperGeometry(recorded.settings, plan, recorded.settings).needsOutpaint, false)
  assert.equal(await wallpaperGenerationAlignment(candidate, generated, plan, recorded.settings), undefined)
  assert.equal((await wallpaperGenerationAlignment(candidate, generated, plan, recorded.settings, true))?.result, 'misaligned-source')
})
