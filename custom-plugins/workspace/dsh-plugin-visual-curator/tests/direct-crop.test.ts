/** Direct-original execution uses real storage/rendering with explicitly isolated model responses. */
import assert from 'node:assert/strict'
import { wallpaperFixtureResponse } from './helpers/wallpaper-response.ts'
import { test } from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'
import { dataOf, specOf, toJson } from '../src/host/runtime.ts'
import { wallpaperStateSchema, wallpaperReviewKeys, wallpaperReviewOutputSchema, wallpaperStoredSourceReviewV4Schema, wallpaperVerdict } from '../src/shared/wallpaper.ts'
import { directCropBatchSchema } from '../src/shared/direct-crop.ts'
import { applyWallpaperSourceReview } from '../src/host/wallpaper-review.ts'
import { createCuratorTransport } from '../src/client/transport.ts'
import { CuratorError } from '../src/shared/errors.ts'
import { contentDigest } from '../src/domain/repository.ts'
import { wallpaperDecisionSettingsSchema } from '../src/shared/wallpaper-decision.ts'
import { wallpaperProcessingSchema } from '../src/shared/wallpaper-policy.ts'

async function fixture(extent: 'complete' | 'cut-off' = 'complete', appearance: 'satisfied' | 'unknown' = 'satisfied', detailMode?: 'resolved' | 'unresolved' | 'violated', maxVisionCalls = 20, maxRetryAttempts = 0) {
  let exportDirectory = '', corruptDetail = false, sourceTruncation = false, wholeFrameSubject = false, readabilityFailure = false, changedSubject = false, changedReadability = false, shrinkReplan = false, criticalUnknownOnce = false, planCalls = 0, reviewCalls = 0
  const f = await serviceFixture(undefined, { maxVisionCalls, maxRetryAttempts }, { pickLocalPaths: async kind => kind === 'folder' ? [exportDirectory] : null })
  exportDirectory = join(f.root, 'exports'); await mkdir(exportDirectory)
  f.service.config.wallpaper.decision = wallpaperDecisionSettingsSchema.parse({ enabled: false })
  f.service.config.wallpaper.repairPolicy = { version: 'subject-repair-v1', mode: 'preserve', maxRepeatedDefects: 2 }
  await f.service.initialize()
  const path = join(f.root, 'direct-original.png'), bytes = await sharp({ create: { width: 2400, height: 4000, channels: 3, background: '#536f53' } }).png().toBuffer()
  await writeFile(path, bytes)
  const observations: string[] = [], detailRequests: object[] = [], reviewRequests: { effort: string | undefined; roles: string[] }[] = [], send = f.http.request.bind(f.http)
  f.http.request = async (url, request) => {
    if (!url.startsWith('https://vision.example.test')) return send(url, request)
    const envelope = z.object({ reasoning_effort: z.string().optional(), messages: z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ text: z.string().optional() }).passthrough())]) })) }).parse(JSON.parse(Buffer.from(request.body!).toString('utf8')))
    const content = envelope.messages.find(row => row.role === 'user')!.content
    assert.ok(Array.isArray(content))
    const input = z.object({ input: z.object({ operation: z.string(), rules: z.array(z.unknown()), requestId: z.string(), usage: z.record(z.string(), z.unknown()).optional(), images: z.array(z.object({ imageVersionId: z.string(), role: z.string() })) }) }).parse(JSON.parse(content[0]!.text!)).input
    observations.push(input.operation); assert.deepEqual(input.rules, [])
    let result: object
    if (input.operation === 'wallpaper-plan') result = { version: 1, imageVersionId: input.images[0]!.imageVersionId, mode: 'single', subject: 'Isolated fixture subject', evidence: 'Scripted annotations, not a real visual judgment.', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [{ name: 'Whole subject', role: 'subject', rect: { x: 0.35, y: 0.5, width: 0.3, height: 0.2 } }, { name: 'Identity', role: 'critical', rect: { x: 0.45, y: 0.56, width: 0.05, height: 0.04 } }], reason: 'The scripted subject fits without background generation.', editPrompt: 'Continue the uniform muted green background from the supplied original; preserve the protected subject and identity pixels, match the existing lighting and texture, and keep transitions continuous without inventing new objects or detail.' }
    else {
      const original = input.images.find(image => image.role === 'wallpaper-original')!, final = input.images.find(image => image.role === 'actual-wallpaper')!
      result = { reviewVersion: 'wallpaper-review-source-v1', subject: 'Isolated fixture subject', checks: { ...Object.fromEntries(wallpaperReviewKeys.map(key => [key, { result: key === 'style' ? appearance : 'satisfied', reason: 'Isolated scripted observation.' }])), clarity: { result: 'satisfied', reason: 'Scripted clarity observation.' } }, issues: [], styleResults: [], subjectIntegrity: { mode: 'single', source: { extent, reason: 'Isolated source extent.', imageVersionId: original.imageVersionId }, output: { extent, reason: 'Isolated output extent.', imageVersionId: final.imageVersionId }, task: { result: 'satisfied', reason: 'Scripted task check.' } } }
    }
    if (input.operation === 'wallpaper-plan' && detailMode) {
      const observation = z.object({ version: z.number(), imageVersionId: z.string(), mode: z.string(), subject: z.string(), evidence: z.string(), priorities: z.array(z.string()), anchors: z.array(z.string()), truncations: z.array(z.string()), uncertainties: z.array(z.string()), regions: z.array(z.unknown()), reason: z.string(), editPrompt: z.string() }).parse(result)
      if (input.requestId.includes(':detail:')) {
        detailRequests.push(input)
        const concerns = z.array(z.object({ id: z.string(), text: z.string() })).parse(input.usage?.concerns), crops = input.images.filter(image => image.role === 'wallpaper-original-detail-only')
        assert.equal(crops.length, 1)
        const evidenceIds = corruptDetail ? [input.images[0]!.imageVersionId] : crops.map(crop => crop.imageVersionId); corruptDetail = false
        const { truncations: _truncations, ...detailObservation } = observation
        const backgroundTruncations = detailMode === 'resolved' ? ['Peripheral flowers cross the original frame.'] : []
        result = { version: 'wallpaper-plan-detail-v3', imageVersionId: input.images[0]!.imageVersionId, backgroundTruncations, protectedSubjectExtent: { extent: detailMode === 'resolved' ? 'complete' : detailMode === 'violated' ? 'cut-off' : 'unknown', reason: 'Isolated second source observation.' }, findings: concerns.map(concern => ({ concernId: concern.id, result: detailMode, reason: 'Isolated detail evidence for ' + concern.text, evidenceImageVersionIds: evidenceIds })), observation: { ...detailObservation, uncertainties: detailMode === 'resolved' ? [] : ['The scripted boundary remains unresolved.'] } }
      } else result = { ...observation, truncations: detailMode === 'resolved' ? ['Peripheral flowers cross the original frame.'] : [], uncertainties: ['The overview cannot resolve a visible wheel boundary.'] }
    }
    if (sourceTruncation && input.operation === 'wallpaper-plan' && !input.requestId.includes(':detail:')) result = { ...result, uncertainties: [], truncations: ['The rear half of the main vehicle is cut off by the source frame.'] }
    if (wholeFrameSubject && input.operation === 'wallpaper-plan' && !input.requestId.includes(':detail:')) { const plan = z.object({ regions: z.array(z.object({ name: z.string(), role: z.string(), rect: z.unknown() })) }).parse(result); result = { ...result, regions: plan.regions.map(region => region.role === 'subject' ? { ...region, rect: { x: 0, y: 0, width: 1, height: 1 } } : region) } }
    if (input.operation === 'wallpaper-plan') {
      planCalls++
      if (changedSubject && planCalls > 1) { const plan = z.object({ regions: z.array(z.object({ name: z.string(), role: z.string(), rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }) })) }).parse(result); result = { ...result, regions: plan.regions.map(region => region.role === 'subject' ? { ...region, rect: { ...region.rect, width: 0.32 } } : region) } }
    }
    if (shrinkReplan && input.operation === 'wallpaper-plan' && planCalls > 1) { const plan=z.object({regions:z.array(z.object({name:z.string(),role:z.string(),rect:z.unknown()}))}).parse(result);result={...result,regions:plan.regions.filter(r=>r.role==='subject').map(r=>({...r,rect:{x:0.4,y:0.55,width:0.1,height:0.1}}))} }
    if (input.operation === 'wallpaper-review') {
      reviewCalls++
      reviewRequests.push({ effort: envelope.reasoning_effort, roles: input.images.map(image => image.role) })
      if (criticalUnknownOnce && reviewCalls === 1) { const review = z.object({ checks: z.record(z.string(), z.unknown()), subjectIntegrity: z.object({ output: z.object({ imageVersionId: z.string(), reason: z.string(), extent: z.string() }) }) }).parse(result); result = { ...result, checks: { ...review.checks, subject: { result: 'unknown', reason: 'Critical structure needs a native crop.' } }, subjectIntegrity: { ...z.object({ subjectIntegrity: z.unknown() }).parse(result).subjectIntegrity as object, output: { ...review.subjectIntegrity.output, extent: 'unknown' } }, sourceCorrespondence: { result: 'unknown', reason: 'Critical structure needs a native crop.' }, issues: [{ kind: 'unknown', reason: 'Critical structure needs a native crop.', detail: { sourceRect: { x: 0.44, y: 0.55, width: 0.08, height: 0.08 }, outputRect: { x: 0.44, y: 0.55, width: 0.08, height: 0.08 }, question: 'Is the visible critical connection complete?' } }] } }
      if (readabilityFailure && !(changedSubject && reviewCalls > 1)) { const review = z.object({ checks: z.record(z.string(), z.unknown()) }).parse(result); result = { ...result, checks: { ...review.checks, [changedSubject && !changedReadability ? 'subject' : 'readability']: { result: 'violated', reason: 'Scripted failed pixel evidence.' } }, issues: [{ kind: changedSubject && !changedReadability ? 'preservation' : 'readability', reason: 'Scripted failed pixel evidence.' }] } }
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(wallpaperFixtureResponse(JSON.parse(content[0]!.text!), result)) }, finish_reason: 'stop' }] })) }
  }
  const input = { operationId: 'direct-local', name: 'Isolated direct-original batch', source: { kind: 'local' as const, files: [{ path, name: 'direct-original.png' }] } }
  return { ...f, path, bytes, input, observations, detailRequests, reviewRequests, setCriticalUnknownOnce() { criticalUnknownOnce = true }, setReadabilityFailure(changed = false, unchangedDate = false) { f.service.config.wallpaper.processing = wallpaperProcessingSchema.parse({ clockContrast: {} }); readabilityFailure = true; changedSubject = changed; changedReadability = unchangedDate }, setShrinkingReplan() { f.service.config.wallpaper.processing = wallpaperProcessingSchema.parse({ clockContrast: {} }); readabilityFailure = true; shrinkReplan = true }, setWholeFrameSubject() { wholeFrameSubject = true }, setSourceTruncation() { sourceTruncation = true }, setCorruptDetailOnce() { corruptDetail = true }, setDetailMode(value: 'resolved' | 'unresolved' | 'violated') { detailMode = value } }
}

test('selected-image cancellation and replacement retain the other image and predecessor budgets', async () => {
  const f = await fixture()
  try {
    f.setReadabilityFailure()
    const secondPath = join(f.root, 'second.png')
    await writeFile(secondPath, await sharp({ create: { width: 2400, height: 4000, channels: 3, background: '#334455' } }).png().toBuffer())
    const { runId } = z.object({ runId: z.string() }).parse(await f.action('direct-crop-start', { ...f.input, source: { kind: 'local', files: [...f.input.source.files, { path: secondPath, name: 'second.png' }] } }))
    await f.jobs.drain()
    const recordedRun = f.domain.require('run', runId), recordedData = dataOf(recordedRun)
    const before = wallpaperStateSchema.parse(recordedData.checkpoint.wallpaper)
    before.items[0]!.edits = 3
    const aggregateId = 'run:' + runId
    await f.repository.commit({ aggregateId, expectedRevision: f.repository.manifest(aggregateId)!.revision, operationId: 'record-spent-image-edits', request: {}, state: { runId }, records: [{ ...recordedRun, data: toJson({ ...recordedData, checkpoint: { ...recordedData.checkpoint, wallpaper: toJson(before) } }) }] })
    assert.equal(before.items.length, 2)
    assert.equal(before.items[0]!.status, 'needs-review')
    const calls = f.observations.length
    const cancelArgs = { runId, operationId: 'cancel-selected-only', imageAction: { action: 'cancel', imageVersionId: before.items[0]!.imageVersionId } }
    const cancelled = z.object({ runId: z.string() }).parse(await f.action('wallpaper-continue', cancelArgs))
    await f.jobs.drain()
    const stopped = wallpaperStateSchema.parse(dataOf(f.domain.require('run', cancelled.runId)).checkpoint.wallpaper)
    assert.equal(stopped.items[0]!.status, 'cancelled')
    assert.equal(stopped.items[0]!.edits, before.items[0]!.edits)
    assert.deepEqual(stopped.items[0]!.attempts, before.items[0]!.attempts)
    assert.deepEqual(stopped.items[1], before.items[1])
    assert.equal(f.observations.length, calls)
    assert.deepEqual(await f.action('wallpaper-continue', cancelArgs), cancelled)
    const path = join(f.root, 'replacement.png')
    await writeFile(path, await sharp({ create: { width: 2400, height: 4000, channels: 3, background: '#223322' } }).png().toBuffer())
    const replacementArgs = { runId: cancelled.runId, imageVersionId: stopped.items[0]!.imageVersionId, operationId: 'replace-selected-only', file: { path, name: 'replacement.png' } }
    const replaced = z.object({ runId: z.string() }).parse(await f.action('direct-crop-replace', replacementArgs))
    await f.jobs.drain()
    const after = wallpaperStateSchema.parse(dataOf(f.domain.require('run', replaced.runId)).checkpoint.wallpaper)
    assert.equal(after.items.length, 2)
    assert.notEqual(after.items[0]!.imageVersionId, stopped.items[0]!.imageVersionId)
    assert.equal(after.items[0]!.replacementOf?.imageVersionId, stopped.items[0]!.imageVersionId)
    assert(after.items[0]!.attempts.length > 0)
    assert.equal(after.items[0]!.attempts[0]!.plan.imageVersionId, after.items[0]!.originalId)
    assert.deepEqual(after.items[1], before.items[1])
    assert.deepEqual(wallpaperStateSchema.parse(dataOf(f.domain.require('run', runId)).checkpoint.wallpaper), before)
    assert.deepEqual(await f.action('direct-crop-replace', replacementArgs), replaced)
    await assert.rejects(f.action('direct-crop-replace', { ...replacementArgs, runId: replaced.runId, imageVersionId: after.items[0]!.imageVersionId, operationId: 'same-pixels-cannot-reset' }), /different original/)
    await assert.rejects(f.action('direct-crop-replace', { ...replacementArgs, runId: replaced.runId, imageVersionId: after.items[0]!.imageVersionId, operationId: 'old-original-cannot-reset', file: { path: f.path, name: 'original-again.png' } }), /different original/)
    const reencoded = join(f.root, 'same-pixels-new-encoding.png')
    await sharp(path).png({ compressionLevel: 1 }).toFile(reencoded)
    await assert.rejects(f.action('direct-crop-replace', { ...replacementArgs, runId: replaced.runId, imageVersionId: after.items[0]!.imageVersionId, operationId: 'encoding-cannot-reset', file: { path: reencoded, name: 'same-pixels-new-encoding.png' } }), /different original/)

    assert.deepEqual({ cancelledImages: stopped.items.filter(i => i.status === 'cancelled').length, untouchedImages: after.items.filter(i => i.imageVersionId === before.items[1]!.imageVersionId).length, replacementSaved: !!after.items[0]!.originalId, oldHistoryRetained: stopped.items[0]!.attempts.length > 0 }, JSON.parse(await readFile(new URL('./fixtures/wallpaper-image-actions.expected.json', import.meta.url), 'utf8')))
  } finally { await f.cleanup() }
})

test('an unresolved critical finding receives one high request with original and output native crops', async () => {
  const f = await fixture()
  try {
    f.setCriticalUnknownOnce()
    const { runId } = z.object({ runId: z.string() }).parse(await f.action('direct-crop-start', f.input)); await f.jobs.drain()
    const item = wallpaperStateSchema.parse(dataOf(f.domain.require('run', runId)).checkpoint.wallpaper).items[0]!
    assert.equal(item.status, 'passed', item.reason)
    assert.deepEqual(f.reviewRequests.map(request => request.effort), ['medium', 'high'])
    assert.equal(f.reviewRequests[1]!.roles.filter(role => role.endsWith('-detail-only')).length, 2)
    assert.deepEqual(f.observations, ['wallpaper-plan', 'wallpaper-review', 'wallpaper-review'])
    assert.deepEqual(wallpaperStoredSourceReviewV4Schema.parse(item.attempts.at(-1)!.review).criticalDetail?.resolvedChecks, ['subject', 'sourceCorrespondence'])
  } finally { await f.cleanup() }
})

test('local originals produce a separate crop batch without creating styles, references or searches', async () => {
  const f = await fixture()
  try {
    const receipt = z.object({ runId: z.string() }).parse(await f.action('direct-crop-start', f.input)); await f.jobs.drain()
    const run = f.domain.require('run', receipt.runId), state = wallpaperStateSchema.parse(dataOf(run).checkpoint.wallpaper), item = state.items[0]!, spec = specOf(run)
    assert.equal(run.status, 'completed'); assert.equal(run.outcome, 'target-met', JSON.stringify({ status: item.status, reason: item.reason, errorCode: item.errorCode, attempts: item.attempts.map(attempt => ({ checks: attempt.checks, review: attempt.review })) })); assert.equal(item.status, 'passed')
    assert.equal(item.attempts[0]!.compositionMode, 'generated-canvas-v1')
    assert.equal(z.object({ review: z.object({ version: z.literal('wallpaper-review-source-v4') }) }).parse(spec.fixed.prompts).review.version, 'wallpaper-review-source-v4')
    assert.equal(spec.fixed.release, undefined); assert.equal(spec.fixed.executionRecipe, undefined)
    assert.equal(spec.config.wallpaper.learningEnabled, true, 'The profile configuration is not rewritten')
    const settings = z.object({ learningEnabled: z.literal(false), autoPromote: z.literal(false) }).parse(spec.fixed.wallpaper)
    assert.equal(settings.learningEnabled, false)
    const source = f.domain.require('imageVersion', item.originalId!), asset = f.domain.require('asset', source.assetId)
    assert.deepEqual(await f.files.read(asset.originalBlob!), f.bytes)
    const output = f.domain.require('imageVersion', item.attempts.at(-1)!.outputId!), measured = await sharp(await f.files.read(output.blob)).metadata()
    assert.equal(measured.width, 1845); assert.equal(measured.height, 3280); assert.equal(output.processing?.wallpaperArtifact, 'final')
    assert.equal(f.repository.list('selection').length, 1)
    const exported = z.object({ directory: z.string(), files: z.number(), excluded: z.number() }).parse(await f.action('direct-crop-export', { runId: receipt.runId, title: 'Export isolated results' }))
    assert.equal(exported.files, 1); assert.equal(exported.excluded, 0)
    const manifest = z.object({ files: z.array(z.object({ name: z.string(), sourceDigest: z.string() })) }).parse(JSON.parse(await readFile(join(exported.directory, 'manifest.json'), 'utf8')))
    assert.equal(manifest.files[0]!.sourceDigest, asset.originalBlob!.digest)
    assert.deepEqual(await readFile(join(exported.directory, manifest.files[0]!.name)), await f.files.read(output.blob))
    assert.deepEqual(await f.action('direct-crop-export', { runId: receipt.runId, title: 'Export isolated results' }), exported)
    const assessment = f.repository.list('assessment')[0]!
    assert.equal(assessment.releaseId, undefined); assert.equal(assessment.standard, undefined); assert.equal(assessment.directPolicy?.version, 'source-faithful-v2')
    const list = z.object({ batches: z.array(directCropBatchSchema) }).parse(await f.action('direct-crop-list'))
    assert.equal(list.batches[0]!.kind, 'crop'); assert.equal(list.batches[0]!.runId, receipt.runId)
    const actual = { workflow: spec.input.workflow, stateVersion: state.version, origin: list.batches[0]!.origin, reviewVersion: item.attempts[0]!.review && 'reviewVersion' in item.attempts[0]!.review ? item.attempts[0]!.review.reviewVersion : null, modelOperations: f.observations, trainingRecords: Object.fromEntries(['style', 'reference', 'modelProfile', 'release'].map(kind => [kind, f.repository.list(kind as 'style' | 'reference' | 'modelProfile' | 'release').length])) }
    assert.deepEqual(actual, JSON.parse(await readFile(new URL('./fixtures/direct-crop.expected.json', import.meta.url), 'utf8')))
    assert.deepEqual(await f.action('direct-crop-start', f.input), receipt)
    await assert.rejects(f.action('direct-crop-start', { ...f.input, name: 'Different task' }), /different originals/)
    const history = contentDigest(run), plan = item.attempts[0]!.plan
    await assert.rejects(f.action('wallpaper-plan-update', { runId: receipt.runId, operationId: 'invalid-plan', imageVersionId: item.imageVersionId, plan: toJson({ ...plan, placement: { ...plan.placement, left: 100000 } }) }), error => error instanceof CuratorError && ['invalid-input', 'constraint-conflict'].includes(error.code))
    assert.equal(contentDigest(f.domain.require('run', receipt.runId)), history)
    const next = z.object({ runId: z.string() }).parse(await f.action('wallpaper-plan-update', { runId: receipt.runId, operationId: 'manual-version', imageVersionId: item.imageVersionId, plan: toJson({ ...plan, reason: 'Human confirmed the existing valid placement.' }) })); await f.jobs.drain()
    assert.notEqual(next.runId, receipt.runId); assert.equal(contentDigest(f.domain.require('run', receipt.runId)), history)
    const newer = wallpaperStateSchema.parse(dataOf(f.domain.require('run', next.runId)).checkpoint.wallpaper)
    assert.equal(newer.items[0]!.originalId, item.originalId); assert.equal(newer.items[0]!.attempts.length, 2); assert.equal(newer.items[0]!.status, 'passed')
    const followed = z.object({ batches: z.array(directCropBatchSchema) }).parse(await f.action('direct-crop-list', { runId: receipt.runId }))
    assert.equal(followed.batches[0]!.wallpaper?.runId, next.runId)
  } finally { await f.cleanup() }
})

for (const [extent, appearance, expected] of [['cut-off', 'satisfied', 'rejected'], ['complete', 'unknown', 'needs-review']] as const) test(`direct review stops at ${expected} despite other scripted satisfied checks`, async () => {
  const f = await fixture(extent, appearance)
  try {
    const { runId } = z.object({ runId: z.string() }).parse(await f.action('direct-crop-start', f.input)); await f.jobs.drain()
    const item = wallpaperStateSchema.parse(dataOf(f.domain.require('run', runId)).checkpoint.wallpaper).items[0]!
    assert.equal(item.status, expected); assert.equal(f.repository.list('selection').length, 0)
    assert.deepEqual(f.observations, ['wallpaper-plan', 'wallpaper-review'])
    assert.notEqual(wallpaperVerdict(item.attempts.at(-1)!.review!), 'pass')
  } finally { await f.cleanup() }
})

test('source-fidelity review rejects foreign image evidence and additional model fields', () => {
  const schema = wallpaperReviewOutputSchema('wallpaper-review-source-v1', [], ['source', 'output'], 'output', 'source')
  const review = { reviewVersion: 'wallpaper-review-source-v1', subject: 'Example', checks: { ...Object.fromEntries(wallpaperReviewKeys.map(key => [key, { result: 'satisfied', reason: 'Example' }])), clarity: { result: 'satisfied', reason: 'Example' } }, issues: [], styleResults: [], subjectIntegrity: { mode: 'single', source: { extent: 'complete', reason: 'Example', imageVersionId: 'source' }, output: { extent: 'complete', reason: 'Example', imageVersionId: 'output' }, task: { result: 'satisfied', reason: 'Example' } } }
  assert.ok(schema.safeParse(review).success)
  assert.equal(schema.safeParse({ ...review, extra: 'ignored' }).success, false)
  assert.equal(schema.safeParse({ ...review, subjectIntegrity: { ...review.subjectIntegrity, source: { ...review.subjectIntegrity.source, imageVersionId: 'foreign' } } }).success, false)
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview({ ...review, subjectIntegrity: { ...review.subjectIntegrity, source: { ...review.subjectIntegrity.source, extent: 'cut-off' } } })), 'reject')
})

test('direct batches retain large HTTP projections and use the caller cancellation signal', async () => {
  const lifetime = new AbortController(), caller = new AbortController(), value = { detail: 'Saved batch metadata. '.repeat(1500) }
  let reads = 0
  const transport = createCuratorTransport({ baseUrl: 'https://isolated.example/', signal: lifetime.signal, action: async () => { throw new Error('Direct batches must not use the bounded action-text response') }, fetch: async (url, init) => {
    assert.equal(String(url), 'https://isolated.example/api/visual-curator/data'); assert.ok(init?.signal)
    reads++; return Response.json({ ok: true, value })
  } })
  for (const operation of ['direct-crop-list', 'direct-crop-start', 'direct-crop-delete', 'direct-crop-export']) assert.deepEqual(await transport.invoke(operation, {}, caller.signal), value)
  assert.equal(reads, 4)
})


for (const [mode, expected] of [['resolved', 'passed'], ['unresolved', 'needs-review'], ['violated', 'rejected']] as const) test(`planning detail ${mode} retains strict source evidence and ends at ${expected}`, async () => {
  const f = await fixture('complete', 'satisfied', mode)
  try {
    if (mode === 'unresolved') f.service.config.wallpaper.decision = wallpaperDecisionSettingsSchema.parse({ enabled: false })
    const { runId } = z.object({ runId: z.string() }).parse(await f.action('direct-crop-start', f.input)); await f.jobs.drain()
    const state = wallpaperStateSchema.parse(dataOf(f.domain.require('run', runId)).checkpoint.wallpaper), item = state.items[0]!
    assert.equal(item.status, expected); assert.equal(f.detailRequests.length, 1)
    assert(item.attempts[0]!.plan.uncertainties.length > 0, 'The first observation remains saved')
    assert.equal(item.attempts[0]!.detailAnalysis?.outcome, mode)
    const views = f.repository.list('imageVersion').filter(image => image.geometry.processorVersion.endsWith('/wallpaper-detail-view-v1'))
    assert(views.some(image => image.parentImageVersionId === item.originalId))
    if (mode === 'resolved') {
      assert.equal(item.attempts.length, 2); assert.equal(item.attempts[1]!.plan.uncertainties.length, 0)
      assert.equal(item.attempts[1]!.detailAnalysis?.protectedSubjectExtent, 'complete')
      assert.deepEqual(item.attempts[1]!.plan.truncations, ['Peripheral flowers cross the original frame.'])
      assert.deepEqual(item.attempts[1]!.checks, []); assert(item.attempts[1]!.review); assert(item.attempts[1]!.outputId)
      assert.equal(f.repository.list('selection').length, 1)
      assert.deepEqual(f.observations, ['wallpaper-plan', 'wallpaper-plan', 'wallpaper-review'])
      assert.deepEqual({ operations: f.observations, revisions: item.attempts.length, firstUncertaintyRetained: !!item.attempts[0]!.plan.uncertainties.length, detailOutcome: item.attempts[0]!.detailAnalysis!.outcome, finalStatus: item.status, independentReview: !!item.attempts[1]!.review }, JSON.parse(await readFile(new URL('./fixtures/wallpaper-detail.expected.json', import.meta.url), 'utf8')))
    } else {
      assert.equal(item.attempts.length, 1); assert.equal(item.attempts[0]!.outputId, undefined); assert.equal(f.repository.list('selection').length, 0)
      assert.deepEqual(f.observations, ['wallpaper-plan', 'wallpaper-plan'])
    }
  } finally { await f.cleanup() }
})

test('explicit detail recovery creates one child, retains its predecessor and reuses the saved original', async () => {
  const f = await fixture('complete', 'satisfied', 'unresolved')
  try {
    f.service.config.wallpaper.decision = wallpaperDecisionSettingsSchema.parse({ enabled: false })
    const first = z.object({ runId: z.string() }).parse(await f.action('direct-crop-start', f.input)); await f.jobs.drain()
    const old = f.domain.require('run', first.runId), digest = contentDigest(old), previous = wallpaperStateSchema.parse(dataOf(old).checkpoint.wallpaper)
    f.setDetailMode('resolved')
    const input = { runId: old.id, operationId: 'explicit-detail-recovery', reinspect: { imageVersionId: previous.items[0]!.imageVersionId } }
    const next = z.object({ runId: z.string() }).parse(await f.action('wallpaper-continue', input))
    assert.deepEqual(await f.action('wallpaper-continue', input), next); await f.jobs.drain()
    assert.notEqual(next.runId, first.runId); assert.equal(contentDigest(f.domain.require('run', first.runId)), digest)
    const current = wallpaperStateSchema.parse(dataOf(f.domain.require('run', next.runId)).checkpoint.wallpaper)
    assert.equal(current.items[0]!.originalId, previous.items[0]!.originalId); assert.equal(current.items[0]!.status, 'passed')
    assert.equal(current.items[0]!.detailInspection?.origin, 'manual'); assert.equal(current.items[0]!.detailInspection?.status, 'resolved')
    assert.deepEqual(f.observations, ['wallpaper-plan', 'wallpaper-plan', 'wallpaper-plan', 'wallpaper-review'])
  } finally { await f.cleanup() }
})

test('the detail pass cannot exceed the frozen vision-call budget', async () => {
 const f = await fixture('complete', 'satisfied', 'resolved', 1)
 try {
  const {runId}=z.object({runId:z.string()}).parse(await f.action('direct-crop-start',f.input));await f.jobs.drain()
  const run=f.domain.require('run',runId),state=wallpaperStateSchema.parse(dataOf(run).checkpoint.wallpaper)
  assert.equal(run.outcome,'budget-exhausted');assert.equal(f.detailRequests.length,0);assert.equal(state.items[0]!.attempts[0]!.outputId,undefined);assert.equal(f.repository.list('selection').length,0)
 } finally {await f.cleanup()}
})

test('source-only detail evidence is rejected with a specific repair code before an allowed corrected response continues', async () => {
 const f = await fixture('complete', 'satisfied', 'resolved', 20, 1)
 try {
  f.setCorruptDetailOnce()
  const {runId}=z.object({runId:z.string()}).parse(await f.action('direct-crop-start',f.input));await f.jobs.drain()
  const errors=f.repository.list('request').filter(r=>r.runId===runId&&r.state==='outcome-unknown').map(r=>z.object({diagnostics:z.object({issues:z.array(z.string())})}).parse(r.data).diagnostics.issues)
  assert(errors.some(issues=>issues.includes('custom::detail-evidence-mismatch')))
  const item=wallpaperStateSchema.parse(dataOf(f.domain.require('run',runId)).checkpoint.wallpaper).items[0]!
  assert.equal(item.status,'passed');assert.equal(f.detailRequests.length,2);assert.equal(item.attempts.length,2);assert(item.attempts.at(-1)!.review)
 }finally{await f.cleanup()}
})

test('reported source truncation triggers a full-frame detail check even without uncertainty and stops before rendering', async()=>{
 const f=await fixture('complete','satisfied','violated')
 try{
  f.setSourceTruncation()
  const {runId}=z.object({runId:z.string()}).parse(await f.action('direct-crop-start',f.input));await f.jobs.drain()
  const item=wallpaperStateSchema.parse(dataOf(f.domain.require('run',runId)).checkpoint.wallpaper).items[0]!
  assert.equal(item.attempts[0]!.plan.uncertainties.length,0);assert.equal(item.status,'rejected');assert.equal(item.attempts[0]!.detailAnalysis?.outcome,'violated')
  assert.equal(item.edits,0);assert.equal(item.attempts[0]!.outputId,undefined);assert.deepEqual(f.observations,['wallpaper-plan','wallpaper-plan']);assert.equal(f.repository.list('selection').length,0)
 }finally{await f.cleanup()}
})

test('unavailable detail cannot fall through to rendering when only source extent is unresolved',async()=>{
 const f=await fixture('complete','satisfied','resolved')
 try{
  f.setSourceTruncation();f.setWholeFrameSubject()
  const {runId}=z.object({runId:z.string()}).parse(await f.action('direct-crop-start',f.input));await f.jobs.drain()
  const item=wallpaperStateSchema.parse(dataOf(f.domain.require('run',runId)).checkpoint.wallpaper).items[0]!
  assert.equal(item.status,'needs-review');assert.equal(item.reason,'vision-detail-unavailable');assert.equal(item.attempts[0]!.detailAnalysis?.outcome,'unavailable');assert.equal(item.edits,0);assert.equal(item.attempts[0]!.outputId,undefined);assert.deepEqual(f.observations,['wallpaper-plan'])
 }finally{await f.cleanup()}
})

test('automatic rework stops instead of repeatedly reviewing identical rejected pixels and subject views',async()=>{
 const f=await fixture()
 try{
  f.setReadabilityFailure()
  const {runId}=z.object({runId:z.string()}).parse(await f.action('direct-crop-start',f.input));await f.jobs.drain()
  const item=wallpaperStateSchema.parse(dataOf(f.domain.require('run',runId)).checkpoint.wallpaper).items[0]!
  assert.equal(item.status,'needs-review');assert.equal(item.reason,'unchanged-review-evidence');assert.equal(item.attempts.length,2);assert(item.attempts[0]!.review);assert.equal(item.attempts[1]!.review,undefined);assert.equal(f.repository.list('selection').length,0);assert.deepEqual(f.observations,['wallpaper-plan','wallpaper-review','wallpaper-plan'])
 }finally{await f.cleanup()}
})
test('changed subject evidence still receives its own independent review',async()=>{
 const f=await fixture()
 try{
  f.setReadabilityFailure(true)
  const {runId}=z.object({runId:z.string()}).parse(await f.action('direct-crop-start',f.input));await f.jobs.drain()
  const item=wallpaperStateSchema.parse(dataOf(f.domain.require('run',runId)).checkpoint.wallpaper).items[0]!
  assert.equal(item.status,'passed');assert(item.attempts[1]!.review);assert.deepEqual(f.observations,['wallpaper-plan','wallpaper-review','wallpaper-plan','wallpaper-review'])
 }finally{await f.cleanup()}
})

test('a rejected revision retains its history while remade pixels clear stale reasons before independent review and acceptance', async () => {
  const f = await fixture()
  const checkpoints: Array<{ runId: string; state: z.infer<typeof wallpaperStateSchema> }> = []
  const writeManifest = f.adapter.writeManifest.bind(f.adapter)
  f.adapter.writeManifest = async manifest => {
    await writeManifest(manifest)
    for (const pointer of manifest.records) {
      const record = f.adapter.readRecord(pointer.key)
      if (record?.kind !== 'run') continue
      const saved = wallpaperStateSchema.safeParse(dataOf(record).checkpoint.wallpaper)
      if (saved.success) checkpoints.push({ runId: record.id, state: saved.data })
    }
  }
  try {
    f.setReadabilityFailure(true)
    const { runId } = z.object({ runId: z.string() }).parse(await f.action('direct-crop-start', f.input))
    await f.jobs.drain()
    const run = f.domain.require('run', runId), item = wallpaperStateSchema.parse(dataOf(run).checkpoint.wallpaper).items[0]!
    const prompts = z.object({ plan: z.object({ version: z.literal('wallpaper-plan-v7') }), outpaint: z.object({ version: z.literal('wallpaper-outpaint-v6') }) }).parse(specOf(run).fixed.prompts)
    assert.equal(prompts.plan.version, 'wallpaper-plan-v7'); assert.equal(prompts.outpaint.version, 'wallpaper-outpaint-v6')
    const saved = checkpoints.filter(checkpoint => checkpoint.runId === runId).map(checkpoint => checkpoint.state.items[0]!)
    const rejected = saved.find(checkpoint => checkpoint.attempts.length === 1 && checkpoint.reason === 'Scripted failed pixel evidence.')
    assert(rejected, 'The first rejection remains acknowledged before the replacement attempt starts')
    assert.equal(wallpaperVerdict(rejected.attempts[0]!.review!), 'reject')
    const history = contentDigest(rejected.attempts[0]!.review)
    const remade = saved.filter(checkpoint => checkpoint.attempts.at(-1)?.revision === 2 && ['rendering', 'reviewing'].includes(checkpoint.status))
    assert(remade.some(checkpoint => checkpoint.status === 'rendering'))
    assert(remade.some(checkpoint => checkpoint.status === 'reviewing' && checkpoint.attempts[1]!.outputId && !checkpoint.attempts[1]!.review))
    for (const checkpoint of remade) {
      assert.equal(checkpoint.reason, undefined); assert.equal(checkpoint.errorCode, undefined); assert.equal(checkpoint.failedStep, undefined)
      assert.equal(contentDigest(checkpoint.attempts[0]!.review), history)
      assert.ok(checkpoint.attempts[1]!.plan.editPrompt)
    }
    assert.equal(run.status, 'completed'); assert.equal(item.status, 'passed'); assert.equal(item.reason, undefined)
    assert.equal(contentDigest(item.attempts[0]!.review), history); assert.equal(wallpaperVerdict(item.attempts[1]!.review!), 'pass')
    assert.deepEqual(f.observations, ['wallpaper-plan', 'wallpaper-review', 'wallpaper-plan', 'wallpaper-review'])
    const original = f.domain.require('imageVersion', item.originalId!)
    assert.deepEqual(await f.files.read(original.blob), f.bytes)
    for (const attempt of item.attempts) {
      const output = f.domain.require('imageVersion', attempt.outputId!), metadata = await sharp(await f.files.read(output.blob)).metadata()
      assert.equal(output.parentImageVersionId, original.id); assert.equal(metadata.width, 1845); assert.equal(metadata.height, 3280)
    }
    assert.equal(f.repository.list('selection').length, 1)
  } finally { await f.cleanup() }
})

test('changed subject views cannot reroll an unchanged failed date simulation',async()=>{
 const f=await fixture()
 try{
  f.setReadabilityFailure(true,true)
  const {runId}=z.object({runId:z.string()}).parse(await f.action('direct-crop-start',f.input));await f.jobs.drain()
  const item=wallpaperStateSchema.parse(dataOf(f.domain.require('run',runId)).checkpoint.wallpaper).items[0]!
  assert.equal(item.status,'needs-review');assert.equal(item.reason,'unchanged-review-evidence');assert.equal(item.attempts[1]!.review,undefined);assert.equal(f.repository.list('selection').length,0);assert.deepEqual(f.observations,['wallpaper-plan','wallpaper-review','wallpaper-plan'])
 }finally{await f.cleanup()}
})

test('automatic replanning retains all earlier subject and critical regions when the model removes or shrinks them',async()=>{
 const f=await fixture()
 try{
  f.setShrinkingReplan()
  const {runId}=z.object({runId:z.string()}).parse(await f.action('direct-crop-start',f.input));await f.jobs.drain()
  const item=wallpaperStateSchema.parse(dataOf(f.domain.require('run',runId)).checkpoint.wallpaper).items[0]!
  assert.equal(item.status,'needs-review');assert.equal(item.reason,'unchanged-review-evidence');assert.deepEqual(item.attempts[1]!.plan.regions,item.attempts[0]!.plan.regions);assert.equal(f.repository.list('selection').length,0)
 }finally{await f.cleanup()}
})

test('batch removal refuses active work and preserves every original, output and immutable run across versions',async()=>{
 const f=await fixture()
 try{
  const {runId}=z.object({runId:z.string()}).parse(await f.action('direct-crop-start',f.input))
  await assert.rejects(f.action('direct-crop-delete',{runId,operationId:'delete-batch'}),error=>error instanceof CuratorError&&error.code==='constraint-conflict')
  await f.jobs.drain()
  const state=wallpaperStateSchema.parse(dataOf(f.domain.require('run',runId)).checkpoint.wallpaper),item=state.items[0]!,plan=item.attempts[0]!.plan
  const child=z.object({runId:z.string()}).parse(await f.action('wallpaper-plan-update',{runId,operationId:'manual-child-before-delete',imageVersionId:item.imageVersionId,plan:toJson(plan)}))
  await assert.rejects(f.action('direct-crop-delete',{runId,operationId:'delete-batch'}),error=>error instanceof CuratorError&&error.code==='constraint-conflict')
  await f.jobs.drain()
  await assert.rejects(f.action('direct-crop-delete',{runId:child.runId,operationId:'delete-child'}),error=>error instanceof CuratorError&&error.code==='invalid-input')
  await assert.rejects(f.service.action({operation:'direct-crop-delete',args:{runId,operationId:'delete-agent'}},{kind:'agent',id:'isolated-agent',profileId:f.profileId,sessionId:'isolated-session'},new AbortController().signal),error=>error instanceof CuratorError&&error.code==='owner-denied')
  const before=contentDigest({runs:f.repository.list('run'),images:f.repository.list('imageVersion'),assets:f.repository.list('asset')})
  const response=await f.service.data(new Request('https://owner.example/api/visual-curator/data',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation:'direct-crop-delete',args:{runId,operationId:'delete-batch'}})}))
  const envelope=z.object({ok:z.literal(true),value:z.object({runId:z.string(),deleted:z.literal(true)})}).parse(await response.json()),receipt=envelope.value
  assert.deepEqual(receipt,{runId,deleted:true});assert.deepEqual(await f.action('direct-crop-delete',{runId,operationId:'delete-batch'}),receipt)
  const list=z.object({batches:z.array(directCropBatchSchema),total:z.number()}).parse(await f.action('direct-crop-list'))
  assert.equal(list.total,0);assert.deepEqual(list.batches,[])
  assert.deepEqual(z.object({batches:z.array(directCropBatchSchema)}).parse(await f.action('direct-crop-list',{runId})).batches,[])
  assert.equal(contentDigest({runs:f.repository.list('run'),images:f.repository.list('imageVersion'),assets:f.repository.list('asset')}),before)
  const exported=z.object({files:z.number()}).parse(await f.action('direct-crop-export',{runId:child.runId,title:'Export retained isolated output'}));assert.equal(exported.files,1)
 }finally{await f.cleanup()}
})
