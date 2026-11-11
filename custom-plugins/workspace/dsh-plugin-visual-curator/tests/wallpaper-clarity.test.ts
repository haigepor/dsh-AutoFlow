/** Isolated real-pixel execution; scripted review conclusions do not establish real model quality. */
import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'
import { dataOf, specOf } from '../src/host/runtime.ts'
import { wallpaperStateSchema, wallpaperReviewKeys, wallpaperViewSchema } from '../src/shared/wallpaper.ts'

async function execute(clarity: 'satisfied' | 'violated' | 'unknown', cutOff = false) {
  const f = await serviceFixture(undefined, { maxReferenceImages: 6, maxReferenceBytes: 8_000_000, maxImportBytes: 24_000_000 })
  await f.service.initialize()
  const width = 2000, height = 3500, raw = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const at = (y * width + x) * 3; raw[at] = Math.floor(x / 12) % 2 ? 70 : 130; raw[at + 1] = (x + y) % 180 + 40; raw[at + 2] = Math.floor(y / 8) % 2 ? 80 : 120 }
  f.http.image = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer()
  const send = f.http.request.bind(f.http), reviewInputs: { images: { imageVersionId: string; role: string }[]; usage: { imageRepresentations: { imageVersionId: string; sourceImageVersionId?: string | undefined; sourceRect?: { x: number; y: number; width: number; height: number } | undefined }[] } }[] = []
  f.http.request = async (url, request) => {
    if (!url.startsWith('https://vision.example.test')) return send(url, request)
    const body = JSON.parse(Buffer.from(request.body!).toString('utf8'))
    const user = body.messages.find((row: { role: string }) => row.role === 'user').content
    const input = z.object({ input: z.object({ operation: z.string(), images: z.array(z.object({ imageVersionId: z.string(), role: z.string() })), rules: z.array(z.object({ ruleId: z.string() })), usage: z.unknown().optional() }) }).parse(JSON.parse(user[0].text)).input
    if (!input.operation.startsWith('wallpaper-')) return send(url, request)
    let result: object
    if (input.operation === 'wallpaper-plan') result = { version: 1, imageVersionId: input.images[0]!.imageVersionId, mode: 'single', subject: 'Visible vehicle', evidence: 'Scripted source annotations.', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [
      { name: 'Whole vehicle', role: 'subject', rect: { x: 0.3, y: 0.4, width: 0.3, height: 0.1 } }, { name: 'Identity marking', role: 'critical', rect: { x: 0.43, y: 0.46, width: 0.02, height: 0.02 } },
    ], reason: 'Source covers the canvas without generation.' }
    else {
      const usage = z.object({ imageRepresentations: z.array(z.object({ imageVersionId: z.string(), sourceImageVersionId: z.string().optional(), sourceRect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional() })) }).parse(input.usage)
      reviewInputs.push({ images: input.images, usage })
      const original = input.images.find(row => row.role === 'wallpaper-original')!, final = input.images.find(row => row.role === 'actual-wallpaper')!, detail = input.images.find(row => row.role === 'actual-wallpaper-detail-only')!
      result = { reviewVersion: 'wallpaper-review-v4', subject: 'Scripted complete subject.', checks: { ...Object.fromEntries(wallpaperReviewKeys.map(key => [key, { result: 'satisfied', reason: 'Scripted independent check.' }])), clarity: { result: reviewInputs.length === 1 ? clarity : 'satisfied', reason: 'Scripted clarity check.' } }, issues: [], styleResults: input.rules.map(rule => ({ ruleId: rule.ruleId, result: 'satisfied', reason: 'Actual scripted final pixels.', evidenceImageVersionIds: [final.imageVersionId, detail.imageVersionId] })), subjectIntegrity: { mode: 'single', source: { extent: cutOff ? 'cut-off' : 'complete', reason: 'Scripted source extent.', imageVersionId: original.imageVersionId }, output: { extent: cutOff ? 'cut-off' : 'complete', reason: 'Scripted output extent.', imageVersionId: final.imageVersionId }, task: { result: 'satisfied', reason: 'Frozen task requirement.' } } }
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] })) }
  }
  try {
    const style = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'style', name: 'Clarity execution' }))
    await f.action('reference-import', { operationId: 'reference', styleId: style.id, expectedRevision: 1, files: [{ name: 'reference.png', mime: 'image/png', base64: f.referenceImage.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    await f.action('reference-analyze', { operationId: 'analyze', styleId: style.id }); await f.jobs.drain()
    const profile = f.repository.list('modelProfile')[0]!
    const source = z.object({ runId: z.string() }).parse(await f.action('search-start', { operationId: 'search', releaseId: profile.id, sourceId: 'images', output: { kind: 'original' }, taskBrief: 'Keep the whole vehicle.', queries: ['vehicle'], targetCount: 1 }))
    await f.jobs.drain()
    assert.equal(f.domain.require('run', source.runId).status, 'completed')
    const started = z.object({ runId: z.string() }).parse(await f.action('wallpaper-start', { operationId: 'wallpaper', sourceRunId: source.runId }))
    await f.jobs.drain()
    const run = f.domain.require('run', started.runId), state = wallpaperStateSchema.parse(dataOf(run).checkpoint.wallpaper), item = state.items[0]!
    return { f, run, item, attempt: item.attempts.at(-1)!, reviewInputs }
  } catch (error) { await f.cleanup(); throw error }
}

test('new wallpaper checks sufficient detail once and saves mapped ROI views without unnecessary enhancement', async () => {
  const result = await execute('satisfied')
  try {
    assert.equal(result.item.status, 'passed', JSON.stringify(result.item))
    assert.equal(result.attempt.clarity?.status, 'not-needed'); assert.equal(result.attempt.clarity?.enhancedOutputId, undefined)
    assert.equal(result.reviewInputs.length, 1); assert.equal(result.item.edits, 0)
    const views = result.reviewInputs[0]!.usage.imageRepresentations.filter(row => row.sourceRect)
    assert.equal(views.length, 2)
    for (const view of views) { const image = result.f.domain.require('imageVersion', view.imageVersionId); assert.equal(image.parentImageVersionId, view.sourceImageVersionId); assert.deepEqual(image.processing?.requestedRect, view.sourceRect) }
    const read = wallpaperViewSchema.parse(await result.f.action('wallpaper-read', { sourceRunId: z.string().parse(specOf(result.run).input.sourceRunId), runId: result.run.id }))
    assert.ok(!views.some(view => read.sourceImages[result.item.originalId!]!.previewPath.includes(view.imageVersionId)))
  } finally { await result.f.cleanup() }
})

test('a blurry result gets one independent super-resolution version and a new full review without resetting generation edits', async () => {
  const result = await execute('violated')
  try {
    assert.equal(result.item.status, 'passed', JSON.stringify(result.item))
    assert.equal(result.item.edits, 0); assert.equal(result.reviewInputs.length, 2)
    assert.equal(result.attempt.clarity?.status, 'passed'); assert.ok(result.attempt.clarityBaseReview)
    assert.notEqual(result.attempt.clarity?.originalOutputId, result.attempt.outputId)
    assert.equal(result.attempt.clarity?.enhancedOutputId, result.attempt.outputId)
    assert.ok(result.reviewInputs[1]!.images.some(row => row.role === 'wallpaper-before-enhancement'))
  } finally { await result.f.cleanup() }
})

test('unknown detail and a cut-off source never trigger enhancement to obtain an automatic pass', async () => {
  for (const [clarity, cutOff, expected] of [['unknown', false, 'needs-review'], ['violated', true, 'rejected']] as const) {
    const result = await execute(clarity, cutOff)
    try { assert.equal(result.item.status, expected, JSON.stringify(result.item)); assert.equal(result.attempt.clarity?.enhancedOutputId, undefined); assert.equal(result.reviewInputs.length, 1); assert.equal(result.item.edits, 0) }
    finally { await result.f.cleanup() }
  }
})
