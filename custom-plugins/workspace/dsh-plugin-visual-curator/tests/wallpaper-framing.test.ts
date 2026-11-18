/** Source-framing conflicts retain actionable evidence and recover without authorizing anatomy changes. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { z } from 'zod'
import { wallpaperFramingObservationSchema, wallpaperSettingsSchema, wallpaperStateSchema, wallpaperViewSchema, type WallpaperFramingObservation } from '../src/shared/wallpaper.ts'
import { resolveWallpaperProcessing, wallpaperRepairPolicySchema } from '../src/shared/wallpaper-policy.ts'
import { wallpaperFramingDetailRects, wallpaperFramingInspectionSchema, applyWallpaperFramingInspection } from '../src/shared/wallpaper-framing.ts'
import { fitWallpaperPlacement, wallpaperGeometry, WallpaperFramingConflictError } from '../src/shared/wallpaper-geometry.ts'
import { wallpaperFramingAnnotation } from '../src/media/wallpaper-render.ts'
import { dataOf, specOf } from '../src/host/runtime.ts'
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

const settings = wallpaperSettingsSchema.parse({ processing: resolveWallpaperProcessing(), sourceIntentPolicy: { version: 'source-intent-v2', minimumSubjectScaleRatio: 0.9, alignment: 'subject-center-v1' } })
const source = { width: 1024, height: 1536 }
const findings = (observed: WallpaperFramingObservation, detailIds: string[], corrected = false) => observed.objectRoles.map(object => ({
  entityId: object.entityId,
  rect: corrected ? object.entityId === 'woman' ? { x: 0, y: 0.06, width: 0.87, height: 0.94 } : object.entityId === 'violin' ? { x: 0.375, y: 0.235, width: 0.6, height: 0.21 } : { x: 0.25, y: 0.08, width: 0.56, height: 0.58 } : object.rect,
  sourceEdges: object.sourceEdges,
  ...(object.sourceIntent.layoutFocus ? { layoutFocus: corrected ? { x: 0.2, y: 0.07, width: 0.6, height: 0.5 } : object.sourceIntent.layoutFocus } : {}),
  evidenceImageVersionIds: detailIds, reason: 'Compared the visible source pixels and real crop.',
}))

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

for (const outcome of ['confirmed','uncertain','corrected','technical-retry','annotation-retry'] as const) test(`source-only recovery retains planning evidence after ${outcome}`, async t => {
  const f = await serviceFixture()
  t.after(f.cleanup)
  f.service.config.wallpaper.processing = resolveWallpaperProcessing()
  f.service.config.wallpaper.repairPolicy = wallpaperRepairPolicySchema.parse({})
  f.service.config.wallpaper.decision = { version: 'wallpaper-decision-v1', enabled: false, maxRoundsPerImage: 2, maxDetailRequests: 1 }
  const path = join(f.root, 'watercolor.png')
  await writeFile(path, await sharp({ create: { ...source, channels: 3, background: '#7962a3' } }).png().toBuffer())
  let plans = 0, inspections = 0
  const send = f.http.request.bind(f.http)
  f.http.request = async (url, request) => {
    if (!url.startsWith('https://vision.example.test')) return send(url, request)
    const messages = z.object({ messages: z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ text: z.string().optional() }).passthrough())]) })) }).parse(JSON.parse(Buffer.from(request.body ?? []).toString('utf8'))).messages
    const content = messages.find(message => message.role === 'user')?.content
    assert.ok(Array.isArray(content))
    const text = content[0]?.text; assert.ok(text)
    const descriptor = z.object({ input: z.object({ images: z.array(z.object({ imageVersionId: z.string(), role: z.string() })) }), outputSchema: z.object({ properties: z.record(z.string(), z.unknown()) }) }).parse(JSON.parse(text))
    const original = descriptor.input.images.find(image => image.role === 'wallpaper-original'); assert.ok(original)
    const observed = observation(original.imageVersionId)
    let output: object
    if ('findings' in descriptor.outputSchema.properties) {
      inspections++
      const crops = descriptor.input.images.filter(image => image.role === 'wallpaper-original-detail-only').map(image => image.imageVersionId)
      assert.ok(crops.length > 0)
      output = { version: 'wallpaper-source-framing-v1', imageVersionId: original.imageVersionId, result: outcome === 'uncertain' ? 'uncertain' : outcome === 'corrected' ? 'corrected' : 'confirmed', reason: 'Source crop evidence has been inspected.', findings: findings(observed, [original.imageVersionId, ...crops], outcome === 'corrected') }
    } else {
      plans++
      output = 'actionPartIds' in descriptor.outputSchema.properties ? { ...observed, actionPartIds: ['bow'] } : observed
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
  assert.equal(item.framingConflict?.resolution, outcome === 'uncertain' ? 'uncertain' : outcome === 'corrected' ? 'cleared' : 'blocked')
  if (outcome === 'corrected') { assert.equal(item.attempts.length, 1); assert.deepEqual(item.attempts[0]?.checks, []) }
  else {
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
