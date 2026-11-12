/** Saved generation handles can be recomposed through the real service without another image dispatch. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { type ImageGenerationHandle, type ImageGenerationTask } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import LocalAttachmentStore from '../../../../packages/attachment/attachment-local/src/index.ts'
import { useHistoricalWallpaperCpu, serviceFixture } from './helpers/service-fixture.ts'
import { BudgetLedger, dataOf, specOf, toJson, type ExecutionSpec } from '../src/host/runtime.ts'
import { assessmentSchema, selectionSchema, assetSchema, imageVersionSchema, runSchema, requestSchema, type CuratorRecord, type RunRecord } from '../src/shared/model.ts'
import { wallpaperPlanSchema, wallpaperReviewKeys, wallpaperReviewSchema, wallpaperSettingsSchema, wallpaperStateSchema, wallpaperProgress, wallpaperViewSchema } from '../src/shared/wallpaper.ts'
import { wallpaperPromptBundle } from '../src/shared/wallpaper-prompts.ts'
import { wallpaperGeometry, renderWallpaper } from '../src/media/wallpaper-render.ts'
import { contentDigest } from '../src/domain/repository.ts'
import { createCuratorTransport } from '../src/client/transport.ts'
import { MediaError } from '../src/media/errors.ts'
import { readFile } from 'node:fs/promises'

const receiptSchema = z.object({ wallpaper: z.object({
  continuation: z.object({ parentRunId: z.string(), kind: z.enum(['replan', 'recompose', 'review', 'continue']), changedImageVersionId: z.string().optional() }).optional(),
  outputs: z.array(z.object({ imageVersionId: z.string(), sourceImageVersionId: z.string(), cumulativeImageEdits: z.number(), assessmentId: z.string().optional(), inherited: z.object({ runId: z.string(), assessmentId: z.string(), selectionId: z.string() }).nullable().optional() })),
}) })

async function fixture(twoSources = false, weightedPolicy = false, sessionSource = false) {
  const f = await serviceFixture(undefined, { maxVisionCalls: 20 }), context = new Context(), llm = new LlmRuntime(context), attachments = new LocalAttachmentStore(context, { dshHome: f.root })
  useHistoricalWallpaperCpu(f)
  f.host.llm = llm; f.host.attachments = attachments
  try {
    await f.service.initialize()
    let generationState: ImageGenerationTask['state'] = 'succeeded', rejectReview = false, startedImages = 0, offcanvasPlans = 0, styleOnlyFailure = false, invalidStyleRows = false, sourceExtent = 'complete'
    const readHandles: ImageGenerationHandle[] = [], operations: string[] = []
    const generated = await sharp({ create: { width: 1845, height: 3280, channels: 3, background: '#1933d1' } }).png().toBuffer()
    let original = await attachments.saveFile({ data: generated, name: 'saved-provider-result.png' }), previews = await attachments.saveImages([{ data: generated, mediaType: 'image/png', name: 'saved-provider-preview.png' }])
    const handle = { id: brandString<import('@deepseek-ai/dsh-llm').ImageGenerationId>('saved-generation'), provider: 'fixture-images', model: 'fixture-image-model', taskId: brandString<import('@deepseek-ai/dsh-llm').ImageGenerationTaskId>('saved-provider-task') }
    llm.startImageGeneration = async () => { startedImages++; throw new Error('Recomposition must never dispatch another image generation') }
    llm.getImageGeneration = async value => {
      readHandles.push(structuredClone(value)); assert.deepEqual(value, handle)
      return { ...handle, state: generationState, images: generationState === 'succeeded' ? [{ original, preview: previews[0]! }] : [], ...(generationState === 'failed' ? { error: { code: 'fixture-image-failed', message: 'The saved operation failed.' } } : {}) }
    }
    const request = f.http.request.bind(f.http)
    f.http.request = async (url, input) => {
      if (url.startsWith('https://vision.example.test')) {
        const messages = z.object({ messages: z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]) })) }).parse(JSON.parse(Buffer.from(input.body ?? []).toString('utf8'))).messages
        const content = messages.find(message => message.role === 'user')!.content
        assert.ok(Array.isArray(content))
        const descriptor = z.object({ outputSchema: z.object({ properties: z.record(z.string(), z.unknown()) }), input: z.object({ operation: z.string(), rules: z.array(z.object({ ruleId: z.string() })), images: z.array(z.object({ imageVersionId: z.string(), role: z.string() })) }) }).parse(JSON.parse(content[0]!.text!))
        const operation = descriptor.input.operation
        if (operation.startsWith('wallpaper-')) {
          operations.push(operation)
          let result: unknown
          if (operation === 'wallpaper-plan') {
            const selected = state.items.find(item => item.originalId === descriptor.input.images[0]?.imageVersionId)?.attempts[0]?.plan ?? plan
            result = offcanvasPlans-- > 0 ? { ...selected, placement: { ...selected.placement, left: 10000 } } : selected
          }
          else {
            assert.equal(operation, 'wallpaper-review')
            const review = wallpaperReviewSchema.parse({ subject: 'The saved source is visible in the recomposed output.', checks: Object.fromEntries(wallpaperReviewKeys.map(key => [key, { result: rejectReview && key === 'background' || styleOnlyFailure && key === 'style' ? 'violated' : 'satisfied', reason: 'Scripted review of the supplied final pixels.' }])), issues: rejectReview ? [{ kind: 'background', reason: 'The background still needs human review.' }] : styleOnlyFailure ? [{ kind: 'style', reason: 'A preferred palette is absent.' }] : [] })
            result = descriptor.outputSchema.properties.styleResults ? { ...review, styleResults: descriptor.input.rules.slice(0, invalidStyleRows ? 0 : undefined).map(rule => ({ ruleId: rule.ruleId, result: styleOnlyFailure ? 'violated' : 'satisfied', reason: 'Actual final pixels.', evidenceImageVersionIds: [descriptor.input.images.find(image => image.role === 'actual-wallpaper')!.imageVersionId] })) } : review
            if (descriptor.outputSchema.properties.subjectIntegrity) result = { ...z.record(z.string(), z.unknown()).parse(result), reviewVersion: 'wallpaper-review-v3', subjectIntegrity: { mode: 'single', source: { extent: sourceExtent, reason: 'Independent original frame evidence.', imageVersionId: descriptor.input.images.find(image => image.role === 'wallpaper-original')!.imageVersionId }, output: { extent: sourceExtent, reason: 'Independent actual-output frame evidence.', imageVersionId: descriptor.input.images.find(image => image.role === 'actual-wallpaper')!.imageVersionId }, task: { result: 'satisfied', reason: 'The unchanged task is independently reviewed.' } } }
          }
          if (operation === 'wallpaper-review' && z.object({ const: z.string() }).safeParse(descriptor.outputSchema.properties.reviewVersion).data?.const === 'wallpaper-review-v4') {
            const saved = z.object({ checks: z.record(z.string(), z.unknown()) }).passthrough().parse(result)
            result = { ...saved, reviewVersion: 'wallpaper-review-v4', checks: { ...saved.checks, clarity: { result: 'satisfied', reason: 'The actual subject is clear in this scripted fixture.' } } }
          }
          return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] })) }
        }
      }
      return request(url, input)
    }
    const style = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'style', name: 'Saved background recomposition' }))
    const source = await sharp({ create: { width: 1000, height: 2000, channels: 3, background: '#ac3922' } }).png().toBuffer()
    const second = twoSources ? await sharp({ create: { width: 1845, height: 3280, channels: 3, background: '#367a44' } }).png().toBuffer() : undefined
    await f.action('reference-import', { operationId: 'reference', styleId: style.id, expectedRevision: 1, files: [{ name: 'source.png', mime: 'image/png', base64: source.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }, ...(second ? [{ name: 'second.png', mime: 'image/png', base64: second.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] : [])] })
    await f.action('reference-analyze', { operationId: 'analysis', styleId: style.id, buildDataset: true }); await f.jobs.drain()
    const profile = f.repository.list('modelProfile')[0]!, images = f.repository.list('reference').map(reference => f.domain.require('imageVersion', reference.imageVersionId)), importedImage = images.find(image => image.geometry.width === 1000)!, importedAsset = f.domain.require('asset', importedImage.assetId)
    const image = sessionSource ? imageVersionSchema.parse({ ...importedImage, id: 'session-source-image', assetId: 'session-source-asset' }) : importedImage
    const asset = sessionSource ? assetSchema.parse({ ...importedAsset, id: image.assetId, access: { kind: 'session-run', sessionId: 'source-session' } }) : importedAsset
    const stale = await f.files.importBytes(generated, 'image/png'), staleOutput = imageVersionSchema.parse({ ...image, id: 'old-composition', versionKind: 'composition', parentImageVersionId: image.id, blob: stale.normalized.blob, geometry: { ...image.geometry, width: 1845, height: 3280 } })
    const staleSimulation = imageVersionSchema.parse({ ...staleOutput, id: 'old-simulation' })
    const settings = wallpaperSettingsSchema.parse({ imageProvider: handle.provider, imageModel: handle.model, learningEnabled: false, maxReworks: 2, maxEditsPerImage: 2, recoveryLimitVersion: 'five-attempts-v1' })
    const plan = wallpaperPlanSchema.parse({ version: 1, imageVersionId: image.id, mode: 'single', subject: 'The original red source.', evidence: 'Actual original pixels.', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: ['subject', 'critical'].map(role => ({ name: role, role, rect: { x: 0.25, y: 0.2, width: 0.3, height: 0.2 } })), placement: { scale: 1, left: 400, top: 1100 }, reason: 'Keep the protected source inside the safe region.' })
    assert.deepEqual(wallpaperGeometry(image.geometry, plan, settings).checks, [])
    const review = wallpaperReviewSchema.parse({ subject: 'Saved prior review.', checks: Object.fromEntries(wallpaperReviewKeys.map(key => [key, { result: key === 'background' ? 'violated' : 'satisfied', reason: 'Saved old review.' }])), issues: [{ kind: 'background', reason: 'Recompose the existing provider output.' }] })
    const state = wallpaperStateSchema.parse({ version: 1, sourceRunId: 'source-search', skillVersion: 'fixture-skill', budgetStopped: true, items: [{ imageVersionId: image.id, originalId: image.id, familyId: asset.familyId, status: 'needs-review', edits: 2, attempts: [{ revision: 1, plan, checks: [], needsOutpaint: true, canvasId: image.id, maskId: image.id, analysisId: staleOutput.id, simulationId: staleSimulation.id, outputId: staleOutput.id, generation: handle, generationOperation: handle.id, editReserved: true, review }] }] })
    if (twoSources) {
      const other = images.find(other => other.id !== image.id)!, otherAsset = f.domain.require('asset', other.assetId)
      const otherPlan = wallpaperPlanSchema.parse({ ...plan, imageVersionId: other.id, placement: { left: 0, top: 0, scale: 1 }, regions: plan.regions.map(region => ({ ...region, rect: { x: 0.25, y: 0.4, width: 0.3, height: 0.2 } })) })
      state.items.push({ imageVersionId: other.id, originalId: other.id, familyId: otherAsset.familyId, status: 'technical-failed', failedStep: 'reviewing', edits: 0, attempts: [{ revision: 1, plan: otherPlan, checks: [], needsOutpaint: false }] })
    }
    const prompts = { ...wallpaperPromptBundle('wallpaper-review-v1', 'wallpaper-plan-v2'), outpaint: { version: 'wallpaper-outpaint-v1', text: 'Saved first-generation editing instructions.' } }
    const spec: ExecutionSpec = { kind: 'crop', config: f.service.config, input: { workflow: 'wallpaper-v1', operationId: 'old-wallpaper', sourceRunId: state.sourceRunId, imageVersionIds: state.items.map(item => item.imageVersionId), taskBrief: 'Recompose saved source pixels.', targetCount: state.items.length }, fixed: { ...(sessionSource ? { sourceSessionId: 'source-session' } : {}), release: toJson(profile), ...(weightedPolicy ? { executionRecipe: toJson({ ...profile.recipe, styleMatching: { version: 2, minSatisfiedRatio: 0.75 } }) } : {}), wallpaper: toJson(settings), skill: { id: 'fixture-skill', content: 'Keep original protected pixels.' }, prompts: toJson(prompts) }, specDigest: contentDigest('saved-wallpaper') }
    const old = runSchema.parse({ schemaVersion: 1, profileId: f.profileId, id: 'old-wallpaper', createdAt: '1970-01-01T00:00:00.000Z', kind: 'run', owner: { kind: 'profile' }, revision: 1, status: 'completed', stage: 'finalizing', outcome: 'source-exhausted', spec: toJson(spec), data: { attemptId: 'old-attempt', attempts: 1, budget: { ...new BudgetLedger(spec.config.limits).snapshot(), vision: 5, search: 2, downloadBytes: 1234 }, checkpoint: { wallpaper: toJson(state) }, counts: {}, warnings: [], requestIds: [], resultIds: [] } })
    const sourceRun = runSchema.parse({ ...old, id: state.sourceRunId, spec: toJson({ ...spec, kind: 'search', input: { taskBrief: 'Saved source search.', targetCount: state.items.length } }) })
    await f.repository.commit({ aggregateId: 'saved-wallpaper', expectedRevision: 0, operationId: 'saved-wallpaper', request: {}, records: [sourceRun, old, staleOutput, staleSimulation, ...(sessionSource ? [asset, image] : [])], state: {} })
    operations.length = 0
    return { f, old, state, image, handle, operations, readHandles, async setGenerated(bytes: Uint8Array) { original = await attachments.saveFile({ data: bytes, name: 'saved-provider-result.png' }); previews = await attachments.saveImages([{ data: bytes, mediaType: 'image/png', name: 'saved-provider-preview.png' }]) }, setSourceExtent(value: string) { sourceExtent = value }, setReviewRejected() { rejectReview = true }, setStyleOnlyFailure() { styleOnlyFailure = true }, setInvalidStyleRows() { invalidStyleRows = true }, setOffcanvasPlans(n: number) { offcanvasPlans = n }, setGenerationFailed() { generationState = 'failed' }, setGenerationState(value: ImageGenerationTask['state']) { generationState = value }, get startedImages() { return startedImages }, async cleanup() { await f.cleanup(); await context.fiber.dispose() } }
  } catch (error) { await f.cleanup(); await context.fiber.dispose(); throw error }
}

for (const [extent, expected] of [['complete', 'passed'], ['cut-off', 'rejected'], ['unknown', 'needs-review']] as const) test(`saved-output review uses current subject evidence (${extent}) without image generation or historical writes`, async () => {
  const f = await fixture(true)
  try {
    f.setSourceExtent(extent)
    const previous = structuredClone(f.old), other = structuredClone(f.state.items[1])
    const outputId = f.state.items[0]!.attempts[0]!.outputId!
    const args = { runId: f.old.id, operationId: `review-existing-${extent}`, review: { outputId } }
    const receipt = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-continue', args))
    assert.deepEqual(await f.f.action('wallpaper-continue', args), receipt)
    await f.f.jobs.drain()
    const child = f.f.domain.require('run', receipt.runId), spec = specOf(child), state = wallpaperStateSchema.parse(dataOf(child).checkpoint.wallpaper), item = state.items[0]!, attempt = item.attempts.at(-1)!
    assert.equal(item.status, expected, JSON.stringify({ reason: item.reason, errorCode: item.errorCode, runError: dataOf(child).error }))
    assert.equal(attempt.outputId, outputId); assert.equal(item.edits, 2)
    assert.deepEqual(state.items[1], other)
    assert.deepEqual(f.f.domain.require('run', f.old.id), previous)
    assert.equal(z.object({ review: z.object({ version: z.string() }) }).parse(spec.fixed.prompts).review.version, 'wallpaper-review-v4')
    assert.equal(spec.config.vision.model, f.f.service.config.vision.model)
    assert.deepEqual(f.operations, ['wallpaper-review']); assert.equal(f.startedImages, 0); assert.deepEqual(f.readHandles, [])
    const result = z.object({ wallpaperTask: z.literal(true), results: z.array(z.object({ imageVersionId: z.string() })) }).parse(await f.f.action('run-get', { runId: child.id, resultFilter: extent === 'complete' ? 'selected' : extent === 'cut-off' ? 'rejected' : 'review' }))
    assert(result.results.some(row => row.imageVersionId === outputId))
    const opened = z.object({ runId: z.string(), resolvedFromRunId: z.string(), wallpaperTask: z.literal(true) }).parse(await f.f.action('run-get', { runId: f.state.sourceRunId, followLatestWallpaper: true }))
    assert.equal(opened.runId, child.id)
    assert.equal(opened.resolvedFromRunId, f.state.sourceRunId)
    assert.equal(z.object({ runId: z.string() }).parse(await f.f.action('run-get', { runId: f.old.id })).runId, f.old.id)
    assert.equal(dataOf(child).budget.vision, 1)
  } finally { await f.cleanup() }
})

test('saved-output review rejects a foreign artifact without creating a task', async () => {
  const f = await fixture()
  try {
    const runs = f.f.repository.list('run').length
    await assert.rejects(f.f.action('wallpaper-continue', { runId: f.old.id, operationId: 'foreign-review', review: { outputId: f.image.id } }), { code: 'constraint-conflict', stage: 'wallpaper-review' })
    assert.equal(f.f.repository.list('run').length, runs)
    assert.deepEqual(f.f.domain.require('run', f.old.id), f.old)
  } finally { await f.cleanup() }
})

test('single-image reads include a small preview directory without loading the other images plans or changing saved work',async()=>{
  const f=await fixture(true)
  try{
    const view=wallpaperViewSchema.parse(await f.f.action('wallpaper-read',{sourceRunId:f.state.sourceRunId,offset:0,limit:1}))
    assert.equal(view.state.items.length,1);assert.equal(view.itemIndex?.length,2)
    for(const item of view.itemIndex!){
      assert(item.previewPath)
      const id=new URL(item.previewPath,'https://owner.example').searchParams.get('imageVersionId')!
      assert.equal(f.f.domain.require('imageVersion',id).versionKind,'preview')
      assert.notEqual(id,view.state.items.find(row=>row.imageVersionId===item.imageVersionId)?.originalId)
    }
    assert.equal(Object.keys(view.sourceImages).length,1)
    assert.deepEqual(f.f.domain.require('run',f.old.id),f.old)
    assert.equal(f.startedImages,0)
  }finally{await f.cleanup()}
})

test('recomposition reuses a saved generation, changes real composition pixels and preserves immutable history', async () => {
  const f = await fixture()
  try {
    const input = { runId: f.old.id, operationId: 'recompose', recompose: { imageVersionId: f.image.id, revision: 1 } }
    const started = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-continue', input))
    const repeated = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-continue', input))
    assert.equal(repeated.runId, started.runId)
    await f.f.jobs.drain()
    const settledRetry = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-continue', input))
    assert.equal(settledRetry.runId, started.runId)
    const run = f.f.domain.require('run', started.runId), spec = specOf(run), initial = wallpaperStateSchema.parse(spec.fixed.initialWallpaperState), saved = wallpaperStateSchema.parse(dataOf(run).checkpoint.wallpaper), item = saved.items[0]!, attempt = item.attempts.at(-1)!
    assert.equal(spec.input.continuationKind, 'recompose')
    assert.deepEqual(spec.fixed.prompts, specOf(f.old).fixed.prompts)
    assert.equal(initial.items[0]!.attempts.length, 2)
    assert.deepEqual(initial.items[0]!.attempts[0], f.state.items[0]!.attempts[0])
    assert.equal(initial.items[0]!.attempts[1]!.outputId, undefined)
    assert.equal(initial.items[0]!.attempts[1]!.review, undefined)
    assert.equal(initial.items[0]!.attempts[1]!.analysisId, undefined)
    assert.equal(initial.items[0]!.attempts[1]!.simulationId, undefined)
    assert.equal(item.edits, 2); assert.equal(item.attempts.length, 2); assert.equal(attempt.revision, 2)
    assert.deepEqual(attempt.generation, f.handle)
    assert.equal(item.status, 'passed'); assert.equal(f.startedImages, 0); assert.ok(f.readHandles.length > 0)
    const receipt = receiptSchema.parse(await f.f.action('run-get', { runId: run.id })).wallpaper
    assert.deepEqual(receipt.continuation, { parentRunId: f.old.id, kind: 'recompose', changedImageVersionId: f.image.id })
    assert.equal(receipt.outputs[0]!.inherited, null)
    assert.equal(receipt.outputs[0]!.assessmentId, f.f.repository.list('selection').find(row => row.runId === run.id)!.assessmentId)
    const expected = JSON.parse(await readFile(new URL('./fixtures/wallpaper-continuation-receipt.expected.json', import.meta.url), 'utf8'))
    assert.deepEqual({ kind: receipt.continuation.kind, cumulativeImageEdits: receipt.outputs[0]!.cumulativeImageEdits, inherited: receipt.outputs[0]!.inherited !== null, newGenerations: f.startedImages }, expected.recompose)
    assert.deepEqual(f.operations, ['wallpaper-review'])
    assert.equal(dataOf(run).budget.vision, 1); assert.equal(dataOf(run).budget.search, 0); assert.equal(dataOf(run).budget.downloadBytes, 0)
    assert.deepEqual(f.f.domain.require('run', f.old.id), f.old)
    const output = f.f.domain.require('imageVersion', attempt.outputId!), oldOutput = f.f.domain.require('imageVersion', f.state.items[0]!.attempts[0]!.outputId!)
    assert.notEqual(output.blob.digest, oldOutput.blob.digest)
    const bytes = await f.f.files.read(output.blob), pixel = await sharp(bytes).extract({ left: 700, top: 1700, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
    assert.deepEqual([...pixel], [172, 57, 34], 'Protected source pixels replace the old provider-only output')
    assert.deepEqual([output.geometry.width, output.geometry.height], [1845, 3280])
    const transport = createCuratorTransport({ baseUrl: 'https://owner.example/', signal: new AbortController().signal,
      action: async () => { throw new Error('Wallpaper reads must not use bounded action output') },
      fetch: async (url, options) => {
        assert.equal(String(url), 'https://owner.example/api/visual-curator/data')
        assert.equal(options?.credentials, 'same-origin')
        const response = await f.f.service.data(new Request(url, options))
        assert.equal(response.status, 200)
        assert.equal(response.headers.get('cache-control'), 'private, no-store')
        return response
      },
    })
    const view = await transport.invoke('wallpaper-read', { sourceRunId: f.state.sourceRunId })
    assert.equal(z.object({ runId: z.string() }).parse(await transport.invoke('wallpaper-continue', input)).runId, started.runId)
    assert.equal(f.startedImages, 0, 'An HTTP retry retains the accepted recomposition receipt')
    const projected = z.object({ resources: z.record(z.string(), z.string()), previewResources: z.record(z.string(), z.string()) }).parse(view)
    assert.notEqual(projected.previewResources[output.id], projected.resources[output.id])
    const small = f.f.domain.require('imageVersion', `${output.id}:preview`)
    assert.deepEqual([small.geometry.width, small.geometry.height], [720, 1280])
    assert.equal(small.parentImageVersionId, output.id)
    assert.notEqual(attempt.analysisId, f.state.items[0]!.attempts[0]!.analysisId)
    assert.equal((await sharp(bytes).stats()).isOpaque, true)
    assert.equal(f.f.repository.list('selection').filter(row => row.runId === started.runId).length, 1)
  } finally { await f.cleanup() }
})

test('recomposition rejection stops for human review without replanning or another generation', async () => {
  const f = await fixture(); f.setReviewRejected()
  try {
    const { runId } = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-continue', { runId: f.old.id, operationId: 'reject-recomposition', recompose: { imageVersionId: f.image.id, revision: 1 } }))
    await f.f.jobs.drain()
    const run = f.f.domain.require('run', runId), item = wallpaperStateSchema.parse(dataOf(run).checkpoint.wallpaper).items[0]!
    assert.equal(run.status, 'completed'); assert.equal(item.status, 'needs-review'); assert.equal(item.attempts.length, 2); assert.equal(item.edits, 2)
    assert.equal(item.attempts.at(-1)!.review!.checks.background.result, 'violated')
    assert.deepEqual(f.operations, ['wallpaper-review']); assert.equal(f.startedImages, 0)
    assert.equal(f.f.repository.list('selection').filter(row => row.runId === runId).length, 0)
    assert.deepEqual(f.f.domain.require('run', f.old.id), f.old)
  } finally { await f.cleanup() }
})

test('a failed saved generation cannot be replaced by a new image dispatch', async () => {
  const f = await fixture(); f.setGenerationFailed()
  try {
    const { runId } = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-continue', { runId: f.old.id, operationId: 'failed-recomposition', recompose: { imageVersionId: f.image.id, revision: 1 } }))
    await f.f.jobs.drain()
    const item = wallpaperStateSchema.parse(dataOf(f.f.domain.require('run', runId)).checkpoint.wallpaper).items[0]!
    assert.equal(item.status, 'technical-failed'); assert.equal(item.failedStep, 'rendering'); assert.equal(item.attempts.length, 2); assert.equal(item.edits, 2)
    assert.equal(item.attempts.at(-1)!.outputId, undefined); assert.equal(f.startedImages, 0); assert.deepEqual(f.operations, [])
    assert.deepEqual(f.f.domain.require('run', f.old.id), f.old)
  } finally { await f.cleanup() }
})

test('recomposition refuses missing receipts and active tasks before running work', async () => {
  const f = await fixture()
  try {
    for (const mode of ['missing-receipt', 'active'] as const) {
      const state = structuredClone(f.state)
      if (mode === 'missing-receipt') delete state.items[0]!.attempts[0]!.generation
      const old: RunRecord = { ...f.old, id: runSchema.shape.id.parse(`old-${mode}`), ...(mode === 'active' ? { status: 'running' } : {}), data: toJson({ ...dataOf(f.old), checkpoint: { wallpaper: toJson(state) } }) }
      await f.f.repository.commit({ aggregateId: `seed-${mode}`, expectedRevision: 0, operationId: `seed-${mode}`, request: {}, records: [old], state: {} })
      const before = f.f.repository.list('run').length
      await assert.rejects(f.f.action('wallpaper-continue', { runId: old.id, operationId: `refused-${mode}`, recompose: { imageVersionId: f.image.id, revision: 1 } }), { code: 'constraint-conflict' }, mode)
      assert.equal(f.f.repository.list('run').length, before, mode)
      assert.deepEqual(f.f.domain.require('run', old.id), old)
    }
    assert.equal(f.startedImages, 0); assert.deepEqual(f.readHandles, []); assert.deepEqual(f.operations, [])
  } finally { await f.cleanup() }
})

test('current review rejects an unfrozen legacy style policy and accepts its original saved review', async () => {
  const f = await fixture()
  try {
    const spec = specOf(f.old), release = z.object({ recipe: z.record(z.string(), z.json()) }).passthrough().parse(spec.fixed.release)
    delete release.recipe.styleMatching
    const old = runSchema.parse({ ...f.old, id: 'legacy-no-threshold', createdAt: new Date().toISOString(), spec: toJson({ ...spec, fixed: { ...spec.fixed, release } }) })
    await f.f.repository.commit({ aggregateId: old.id, expectedRevision: 0, operationId: old.id, request: {}, records: [old], state: {} })
    const before = f.f.repository.list('run').length
    await assert.rejects(f.f.action('wallpaper-continue', { runId: old.id, operationId: 'ineligible-current', recompose: { imageVersionId: f.image.id, revision: 1, reviewPolicy: 'current' } }), { code: 'constraint-conflict', stage: 'wallpaper-review-policy' })
    assert.equal(f.f.repository.list('run').length, before); assert.deepEqual(f.operations, []); assert.equal(f.startedImages, 0)
    const receipt = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-continue', { runId: old.id, operationId: 'saved-legacy', recompose: { imageVersionId: f.image.id, revision: 1 } })); await f.f.jobs.drain()
    const child = f.f.domain.require('run', receipt.runId), childSpec = specOf(child), { recomposedMode: _mode, reviewPolicy: _policy, ...legacyInput } = childSpec.input
    const legacyReceipt = runSchema.parse({ ...child, id: 'old-receipt-without-new-keys', spec: toJson({ ...childSpec, input: { ...legacyInput, operationId: 'old-receipt' } }) })
    await f.f.repository.commit({ aggregateId: legacyReceipt.id, expectedRevision: 0, operationId: legacyReceipt.id, request: {}, records: [legacyReceipt], state: {} })
    assert.deepEqual(await f.f.action('wallpaper-continue', { runId: old.id, operationId: 'old-receipt', recompose: { imageVersionId: f.image.id, revision: 1 } }), { runId: legacyReceipt.id })
    assert.deepEqual(f.operations, ['wallpaper-review']); assert.equal(f.startedImages, 0)
  } finally { await f.cleanup() }
})

test('explicit context recovery upgrades only the child review and leaves unrelated pending items untouched', async () => {
  const f = await fixture(true, true)
  try {
    const state = structuredClone(f.state), other = state.items[1]!
    other.status = 'rendering'; other.attempts = []; delete other.failedStep
    const old = runSchema.parse({ ...f.old, id: 'stopped-with-pending', data: toJson({ ...dataOf(f.old), checkpoint: { wallpaper: toJson(state) } }) })
    await f.f.repository.commit({ aggregateId: old.id, expectedRevision: 0, operationId: old.id, request: {}, records: [old], state: {} })
    const input = { runId: old.id, operationId: 'context-current', recompose: { imageVersionId: f.image.id, revision: 1, mode: 'protected-context-v1', reviewPolicy: 'current' } }
    const receipt = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-continue', input)); await f.f.jobs.drain()
    const child = f.f.domain.require('run', receipt.runId), spec = specOf(child), saved = wallpaperStateSchema.parse(dataOf(child).checkpoint.wallpaper), attempt = saved.items[0]!.attempts.at(-1)!
    assert.equal(attempt.compositionMode, 'protected-context-v1'); assert.equal(saved.items[0]!.status, 'passed'); assert.equal(saved.budgetStopped, true)
    assert.deepEqual(saved.items[1], other); assert.deepEqual(attempt.generation, f.handle); assert.equal(attempt.canvasId, f.state.items[0]!.attempts[0]!.canvasId); assert.equal(attempt.maskId, f.state.items[0]!.attempts[0]!.maskId)
    assert.equal(wallpaperProgress(saved).rendering, 1); assert.equal(wallpaperProgress(saved, f.image.id).rendering, 0); assert.equal(wallpaperProgress(saved, f.image.id).passed, 1)
    const scoped = z.object({ counts: z.record(z.string(), z.number()), total: z.number() }).parse(await f.f.action('wallpaper-read', { sourceRunId: state.sourceRunId }))
    assert.equal(scoped.counts.rendering, 0); assert.equal(scoped.total, 2)
    assert.equal(z.object({ review: z.object({ version: z.string() }) }).parse(spec.fixed.prompts).review.version, 'wallpaper-review-v2')
    assert.equal(z.object({ review: z.object({ version: z.string() }) }).parse(specOf(old).fixed.prompts).review.version, 'wallpaper-review-v1')
    assert.ok(attempt.review && 'styleMatch' in attempt.review); assert.deepEqual(f.operations, ['wallpaper-review']); assert.equal(f.startedImages, 0)
    assert.equal(z.object({ workflowComplete: z.boolean() }).parse(await f.f.action('run-get', { runId: child.id })).workflowComplete, false)
    assert.deepEqual(await f.f.action('wallpaper-continue', input), receipt)
    await assert.rejects(f.f.action('wallpaper-continue', { ...input, recompose: { ...input.recompose, mode: 'source-edge-v1' } }), { code: 'operation-conflict' })
    assert.deepEqual(f.f.domain.require('run', old.id), old)
  } finally { await f.cleanup() }
})

test('V2 invalid coverage remains a consumed failed request and style-only rejection cannot trigger generation', async () => {
  const f = await fixture(false, true)
  try {
    f.setInvalidStyleRows()
    const input = { runId: f.old.id, operationId: 'invalid-coverage', recompose: { imageVersionId: f.image.id, revision: 1, reviewPolicy: 'current' } }
    const receipt = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-continue', input)); await f.f.jobs.drain()
    const child = f.f.domain.require('run', receipt.runId), item = wallpaperStateSchema.parse(dataOf(child).checkpoint.wallpaper).items[0]!
    assert.equal(item.status, 'technical-failed'); assert.equal(item.errorCode, 'vision-invalid-output'); assert.equal(item.attempts.at(-1)!.review, undefined)
    assert.equal(f.f.repository.list('selection').filter(row => row.runId === child.id).length, 0); assert.equal(dataOf(child).budget.vision, 1)
    assert.equal(f.f.repository.list('request').filter(row => row.runId === child.id && row.state === 'outcome-unknown').length, 1); assert.equal(f.startedImages, 0)
  } finally { await f.cleanup() }
  const g = await fixture(false, true)
  try {
    g.setStyleOnlyFailure()
    const receipt = z.object({ runId: z.string() }).parse(await g.f.action('wallpaper-continue', { runId: g.old.id, operationId: 'style-only', recompose: { imageVersionId: g.image.id, revision: 1, reviewPolicy: 'current' } })); await g.f.jobs.drain()
    const item = wallpaperStateSchema.parse(dataOf(g.f.domain.require('run', receipt.runId)).checkpoint.wallpaper).items[0]!
    assert.equal(item.status, 'needs-review'); assert.equal(item.attempts.at(-1)!.review!.checks.style.result, 'violated'); assert.deepEqual(g.operations, ['wallpaper-review']); assert.equal(g.startedImages, 0)
  } finally { await g.cleanup() }
})

test('schema-valid off-canvas model plans are retained and bounded; a committed legacy plan is reused before a new round', async () => {
  const f = await fixture(true)
  try {
    const seed = async (id: string, legacy: boolean) => {
      const state = structuredClone(f.state), other = state.items[1]!, valid = other.attempts[0]!.plan
      state.items = [{ ...other, status: 'technical-failed', failedStep: 'planning', attempts: [] }]
      const old = runSchema.parse({ ...f.old, id, createdAt: new Date().toISOString(), data: toJson({ ...dataOf(f.old), checkpoint: { wallpaper: toJson(state) } }) })
      const records: CuratorRecord[] = [old]
      if (legacy) {
        const bundle = { operation: 'wallpaper-plan', requestId: `${id}:${other.imageVersionId}:plan:1` }
        records.push(requestSchema.parse({ schemaVersion: 1, profileId: f.f.profileId, id: `${id}-request`, kind: 'request', createdAt: old.createdAt, runId: id, state: 'committed', requestDigest: contentDigest(bundle), data: { bundle, output: { ...valid, placement: { ...valid.placement, left: 10000 } } } }))
      }
      await f.f.repository.commit({ aggregateId: id, expectedRevision: 0, operationId: id, request: {}, records, state: {} })
      return old
    }
    f.setOffcanvasPlans(1)
    const old = await seed('bad-then-valid', false), receipt = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-continue', { runId: old.id, operationId: 'correct-plan' })); await f.f.jobs.drain()
    const state = wallpaperStateSchema.parse(dataOf(f.f.domain.require('run', receipt.runId)).checkpoint.wallpaper), attempts = state.items[0]!.attempts
    assert.deepEqual(attempts[0]!.checks, ['source-outside-canvas']); assert.equal(attempts[0]!.analysisId, undefined); assert.equal(attempts.length, 2); assert.equal(state.items[0]!.status, 'passed')
    assert.deepEqual(f.operations, ['wallpaper-plan', 'wallpaper-plan', 'wallpaper-review']); assert.equal(f.startedImages, 0)
    const attentionReceipt = z.object({ wallpaper: z.object({ attentionTotal: z.number(), attention: z.array(z.object({ sourceImageVersionId: z.string(), sourceName: z.string(), status: z.string(), reason: z.string().optional(), errorCode: z.string().optional(), failedStep: z.string().optional(), revision: z.number().optional(), checks: z.array(z.string()).optional() })) }) })
    assert.deepEqual(attentionReceipt.parse(await f.f.action('run-get', { runId: receipt.runId })).wallpaper, { attentionTotal: 0, attention: [] })
    f.operations.length = 0
    const legacy = await seed('legacy-bad', true)
    let ancestor = legacy
    for (const number of [1, 2]) {
      const inheritedSpec = specOf(ancestor), next = runSchema.parse({ ...ancestor, id: `recomposed-descendant-${number}`, createdAt: new Date().toISOString(), spec: toJson({ ...inheritedSpec, input: { ...inheritedSpec.input, continuationKind: 'recompose', continuationOf: ancestor.id, operationId: `ancestor-${number}`, recomposedImageId: f.image.id } }) })
      await f.f.repository.commit({ aggregateId: next.id, expectedRevision: 0, operationId: next.id, request: {}, records: [next], state: {} }); ancestor = next
    }
    const recovered = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-continue', { runId: ancestor.id, operationId: 'reuse-plan' })); await f.f.jobs.drain()
    const child = f.f.domain.require('run', recovered.runId), saved = wallpaperStateSchema.parse(dataOf(child).checkpoint.wallpaper)
    assert.equal(saved.items[0]!.status, 'passed'); assert.deepEqual(saved.items[0]!.attempts[0]!.checks, ['source-outside-canvas']); assert.deepEqual(f.operations, ['wallpaper-plan', 'wallpaper-review']); assert.equal(dataOf(child).budget.vision, 2)
    assert.equal(z.record(z.string(), z.string()).parse(specOf(child).fixed.recoveredPlanRequests)[saved.items[0]!.imageVersionId], 'legacy-bad-request')
    assert.deepEqual(f.f.domain.require('run', legacy.id), legacy); assert.deepEqual(f.f.domain.require('run', ancestor.id), ancestor)
    f.operations.length = 0; f.setOffcanvasPlans(10)
    const bounded = await seed('all-outside', false), last = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-continue', { runId: bounded.id, operationId: 'bounded-plan' })); await f.f.jobs.drain()
    const lastItem = wallpaperStateSchema.parse(dataOf(f.f.domain.require('run', last.runId)).checkpoint.wallpaper).items[0]!
    assert.equal(lastItem.status, 'needs-review'); assert.equal(lastItem.attempts.length, 3); assert.deepEqual(f.operations, ['wallpaper-plan', 'wallpaper-plan', 'wallpaper-plan']); assert.equal(f.startedImages, 0)
    const report = attentionReceipt.parse(await f.f.action('run-get', { runId: last.runId })).wallpaper
    assert.equal(report.attentionTotal, 1); assert.equal(report.attention.length, 1)
    const attention = report.attention[0]!, source = f.f.domain.authorizedImage(lastItem.imageVersionId, f.f.actor).asset
    assert.equal(attention.sourceImageVersionId, lastItem.imageVersionId); assert.equal(attention.sourceName, source.source.description || source.id)
    assert.deepEqual({ ...attention, sourceImageVersionId: 'source', sourceName: 'source' }, { sourceImageVersionId: 'source', sourceName: 'source', status: 'needs-review', reason: 'rework-limit', revision: 3, checks: ['source-outside-canvas'] })
    assert.equal(receiptSchema.parse(await f.f.action('run-get', { runId: last.runId })).wallpaper.outputs.length, 0)
  } finally { await f.cleanup() }
})

test('private media quota preserves committed history and persists its safe cause', async () => {
  const f = await fixture()
  try {
    const importBytes = f.f.files.importBytes.bind(f.f.files)
    f.f.files.importBytes = async () => { throw new MediaError('budget-exhausted', 'media', false, 'The private media storage limit is exhausted.', 'Increase the storage limit or choose a smaller import.') }
    const receipt = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-continue', { runId: f.old.id, operationId: 'quota', recompose: { imageVersionId: f.image.id, revision: 1 } })); await f.f.jobs.drain()
    const run = f.f.domain.require('run', receipt.runId), data = dataOf(run), state = wallpaperStateSchema.parse(data.checkpoint.wallpaper)
    assert.equal(run.outcome, 'budget-exhausted'); assert.equal(state.budgetStopped, true); assert.equal(data.error?.stage, 'media'); assert.match(data.error!.safeMessage, /private media storage/)
    assert.ok(data.warnings.some(message => message.includes('private media storage'))); assert.ok(f.f.domain.require('imageVersion', f.state.items[0]!.attempts[0]!.outputId!)); assert.deepEqual(f.f.domain.require('run', f.old.id), f.old); assert.equal(f.startedImages, 0)
    const item = state.items[0]!
    assert.equal(item.status, 'technical-failed'); assert.equal(item.failedStep, 'rendering'); assert.equal(item.errorCode, 'budget-exhausted'); assert.equal(item.reason, data.error!.safeMessage)
    f.f.files.importBytes = importBytes
    const resumed = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-continue', { runId: run.id, operationId: 'quota-recovery', retryImage: { imageVersionId: item.imageVersionId, revision: item.attempts.at(-1)!.revision, step: 'rendering' } }))
    await f.f.jobs.drain()
    const recovered = wallpaperStateSchema.parse(dataOf(f.f.domain.require('run', resumed.runId)).checkpoint.wallpaper).items[0]!
    assert.equal(recovered.status, 'passed'); assert.equal(recovered.edits, item.edits); assert.equal(f.startedImages, 0)
    assert.deepEqual(recovered.attempts.at(-1)!.generation, item.attempts.at(-1)!.generation)
  } finally { await f.cleanup() }
})

test('manual JSON replans reject unsafe source geometry before creating work and retain valid and accepted revisions', async () => {
  const f = await fixture()
  try {
    const plan = f.state.items[0]!.attempts[0]!.plan
    const cases = [
      { name: 'above-safe-area', placement: { ...plan.placement, top: 0 }, code: 'constraint-conflict', stage: 'wallpaper-replan' },
      { name: 'critical', placement: { ...plan.placement, left: 0 }, code: 'constraint-conflict', stage: 'wallpaper-replan' },
      { name: 'off-canvas', placement: { ...plan.placement, left: 1846 }, code: 'invalid-input', stage: 'wallpaper-layout' },
    ]
    assert.deepEqual(wallpaperGeometry(f.image.geometry, { ...plan, placement: { ...plan.placement, top: 650 } }, wallpaperSettingsSchema.parse(specOf(f.old).fixed.wallpaper)).checks, [], 'Without an explicit clock rule, safe content needs no extra clock buffer')
    const runs = f.f.repository.list('run').length, requests = f.f.repository.list('request').length
    for (const sample of cases) {
      await assert.rejects(f.f.action('wallpaper-plan-update', { runId: f.old.id, imageVersionId: f.image.id, operationId: `manual-invalid-${sample.name}`, plan: toJson({ ...plan, placement: sample.placement }) }), { code: sample.code, stage: sample.stage }, sample.name)
      assert.equal(f.f.repository.list('run').length, runs)
      assert.equal(f.f.repository.list('request').length, requests)
      assert.deepEqual(f.f.domain.require('run', f.old.id), f.old)
    }
    assert.equal(f.startedImages, 0); assert.deepEqual(f.readHandles, []); assert.deepEqual(f.operations, [])
    const input = { runId: f.old.id, imageVersionId: f.image.id, operationId: 'manual-valid', plan: toJson(plan) }
    const started = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-plan-update', input))
    const repeated = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-plan-update', input))
    assert.equal(repeated.runId, started.runId)
    await f.f.jobs.drain()
    const child = f.f.domain.require('run', started.runId), initial = wallpaperStateSchema.parse(specOf(child).fixed.initialWallpaperState)
    assert.deepEqual(initial.items[0]!.attempts.at(-1)!.plan, plan)
    assert.deepEqual(initial.items[0]!.attempts.at(-1)!.checks, [])
    assert.deepEqual(f.f.domain.require('run', f.old.id), f.old)
    const invalid = { ...plan, placement: { ...plan.placement, top: 0 } }, operationId = 'legacy-manual-accepted'
    const spec = specOf(f.old), legacy = runSchema.parse({ ...f.old, id: 'legacy-manual-child', spec: toJson({ ...spec, input: { ...spec.input, operationId, continuationKind: 'replan', continuationOf: f.old.id, replacementImageId: f.image.id, replacementPlanDigest: contentDigest(invalid) } }) })
    await f.f.repository.commit({ aggregateId: 'legacy-manual-child', expectedRevision: 0, operationId: 'seed-legacy-manual-child', request: {}, records: [legacy], state: {} })
    const beforeReplay = f.f.repository.list('run').length
    assert.deepEqual(await f.f.action('wallpaper-plan-update', { runId: f.old.id, imageVersionId: f.image.id, operationId, plan: toJson(invalid) }), { runId: legacy.id })
    assert.equal(f.f.repository.list('run').length, beforeReplay)
  } finally { await f.cleanup() }
})

test('an explicit owner plan remains available after automatic replans stop and does not replenish image edits', async () => {
  const f = await fixture()
  try {
    const saved = structuredClone(f.state), item = saved.items[0]!, first = item.attempts[0]!
    item.attempts = [1, 2, 3].map(revision => ({ ...structuredClone(first), revision }))
    item.reason = 'rework-limit'
    const old = runSchema.parse({ ...f.old, revision: f.old.revision + 1, data: toJson({ ...dataOf(f.old), checkpoint: { wallpaper: toJson(saved) } }) })
    await f.f.repository.commit({ aggregateId: 'saved-wallpaper', expectedRevision: 1, operationId: 'seed-exhausted-plans', request: {}, records: [old], state: {} })
    const input = { runId: old.id, imageVersionId: item.imageVersionId, operationId: 'owner-corrected-after-limit', plan: toJson(first.plan), backgroundPolicy: 'current' }
    const started = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-plan-update', input))
    assert.deepEqual(await f.f.action('wallpaper-plan-update', input), started)
    const child = f.f.domain.require('run', started.runId), spec = specOf(child), initial = wallpaperStateSchema.parse(spec.fixed.initialWallpaperState)
    assert.equal(wallpaperSettingsSchema.parse(spec.fixed.wallpaper).maxReworks, 2)
    assert.equal(initial.items[0]!.attempts.length, 4)
    assert.equal(initial.items[0]!.edits, 2)
    assert.equal(initial.items[0]!.attempts.at(-1)!.compositionMode, 'protected-context-v2')
    assert.equal(z.object({ outpaint: z.object({ version: z.string() }) }).parse(spec.fixed.prompts).outpaint.version, 'wallpaper-outpaint-v4')
    assert.deepEqual(initial.items[0]!.attempts.slice(0, 3), item.attempts)
    await f.f.jobs.drain()
    const result = wallpaperStateSchema.parse(dataOf(f.f.domain.require('run', started.runId)).checkpoint.wallpaper)
    assert.equal(result.items[0]!.status, 'needs-review')
    assert.equal(result.items[0]!.reason, 'edit-limit')
    assert.equal(result.items[0]!.edits, 2)
    assert.equal(f.startedImages, 0)
    assert.deepEqual(f.operations, [])
    assert.deepEqual(f.f.domain.require('run', old.id), old)
  } finally { await f.cleanup() }
})

test('an old generation cannot be relabeled as using a new subject-context request mask', async () => {
  const f = await fixture()
  try {
    const runs = f.f.repository.list('run').length
    await assert.rejects(f.f.action('wallpaper-continue', { runId: f.old.id, operationId: 'old-mask-new-label', recompose: { imageVersionId: f.image.id, revision: 1, mode: 'protected-context-v2' } }), { code: 'constraint-conflict', stage: 'wallpaper-recompose' })
    assert.equal(f.f.repository.list('run').length, runs)
    assert.equal(f.startedImages, 0); assert.deepEqual(f.readHandles, [])
  } finally { await f.cleanup() }
})

test('explicit background reconstruction reuses the provider receipt, preserves protected pixels and still requires independent approval', async () => {
  const f = await fixture()
  try {
    const bytes = await sharp({ create: { width: 941, height: 1672, channels: 3, background: '#1946b1' } }).png().toBuffer()
    await f.setGenerated(bytes)
    const state = structuredClone(f.state), prior = state.items[0]!.attempts[0]!
    prior.compositionMode = 'protected-context-v2'
    prior.generationInput = { version: 'wallpaper-edit-input-v1', prompt: 'Saved current-mask request.', references: [{ role: 'canvas', attachmentId: 'saved-canvas', width: 1536, height: 2730 }] }
    const originalSpec = specOf(f.old), prompts = { ...wallpaperPromptBundle('wallpaper-review-v1'), outpaint: wallpaperPromptBundle().outpaint }
    const parent = runSchema.parse({ ...f.old, id: 'saved-small-current-background', spec: toJson({ ...originalSpec, fixed: { ...originalSpec.fixed, prompts: toJson(prompts) } }), data: { ...dataOf(f.old), checkpoint: { wallpaper: toJson(state) } } })
    await f.f.repository.commit({ aggregateId: parent.id, expectedRevision: 0, operationId: 'seed-small-background', request: {}, records: [parent], state: {} })
    const denied = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-continue', { runId: parent.id, operationId: 'native-only-small-background', recompose: { imageVersionId: f.image.id, revision: 1, mode: 'protected-context-v2' } }))
    await f.f.jobs.drain()
    const deniedItem = wallpaperStateSchema.parse(dataOf(f.f.domain.require('run', denied.runId)).checkpoint.wallpaper).items[0]!
    assert.equal(deniedItem.errorCode, 'image-resolution-insufficient'); assert.equal(deniedItem.attempts.at(-1)!.outputId, undefined)
    assert.deepEqual(f.operations, []); assert.equal(f.startedImages, 0)
    const args = { runId: denied.runId, operationId: 'reconstruct-saved-small-background', recompose: { imageVersionId: f.image.id, revision: deniedItem.attempts.at(-1)!.revision, mode: 'protected-context-v2', backgroundResolution: 'current' } }
    const receipt = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-continue', args))
    assert.deepEqual(await f.f.action('wallpaper-continue', args), receipt)
    await f.f.jobs.drain()
    const child = f.f.domain.require('run', receipt.runId), item = wallpaperStateSchema.parse(dataOf(child).checkpoint.wallpaper).items[0]!, attempt = item.attempts.at(-1)!, evidence = attempt.backgroundResolution
    assert.equal(item.status, 'passed', JSON.stringify({ reason: item.reason, errorCode: item.errorCode, runError: dataOf(child).error }))
    assert.equal(item.edits, 2); assert.equal(f.startedImages, 0); assert.deepEqual(attempt.generation, f.handle)
    assert.equal(evidence?.status, 'passed'); assert.equal(evidence.model, 'espcn-x3-luma'); assert.equal(evidence.input.width, 941); assert.equal(evidence.input.height, 1672)
    assert.deepEqual(evidence.output, { width: 1845, height: 3280 }); assert.ok(evidence.tiles! > 1)
    const output = f.f.domain.require('imageVersion', attempt.outputId!), settings = wallpaperSettingsSchema.parse(specOf(child).fixed.wallpaper)
    const baseline = await renderWallpaper(await f.f.files.read(f.image.blob), attempt.plan, settings, undefined, 'protected-context-v2')
    const actual = await sharp(await f.f.files.read(output.blob)).removeAlpha().raw().toBuffer(), source = await sharp(baseline.image).removeAlpha().raw().toBuffer()
    let protectedPixelChanges = 0
    for (const region of baseline.geometry.regions) for (let y = Math.floor(region.top); y < Math.ceil(region.top + region.height); y++) for (let x = Math.floor(region.left); x < Math.ceil(region.left + region.width); x++) {
      const at = (y * settings.width + x) * 3
      assert.deepEqual(actual.subarray(at, at + 3), source.subarray(at, at + 3))
      if (!actual.subarray(at, at + 3).equals(source.subarray(at, at + 3))) protectedPixelChanges++
    }
    assert.deepEqual(f.operations, ['wallpaper-review'])
    assert.deepEqual(f.f.domain.require('run', parent.id), parent); assert.deepEqual(f.f.domain.require('run', f.old.id), f.old)
    f.setReviewRejected()
    const rejected = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-continue', { runId: child.id, operationId: 'reject-reconstructed-background', review: { outputId: output.id } }))
    await f.f.jobs.drain()
    const rejectedRun = f.f.domain.require('run', rejected.runId), rejectedItem = wallpaperStateSchema.parse(dataOf(rejectedRun).checkpoint.wallpaper).items[0]!
    assert.equal(rejectedItem.status, 'rejected'); assert.equal(rejectedItem.attempts.at(-1)!.backgroundResolution?.status, 'needs-review')
    assert.equal(f.f.repository.list('selection').filter(selection => selection.runId === rejected.runId).length, 0)
    assert.equal(f.startedImages, 0); assert.equal(rejectedItem.edits, 2)
    const expected = JSON.parse(await readFile(new URL('./fixtures/wallpaper-continuation-receipt.expected.json', import.meta.url), 'utf8'))
    assert.deepEqual({ nativeSize: `${evidence.input.width}x${evidence.input.height}`, reconstructedSize: `${evidence.output!.width}x${evidence.output!.height}`, cumulativeImageEdits: item.edits, newGenerations: f.startedImages, protectedPixelChanges, rejectedQualifiedOutputs: f.f.repository.list('selection').filter(selection => selection.runId === rejected.runId).length }, expected.backgroundResolution)
    const savedRevision = rejectedItem.attempts.at(-1)!.revision
    const repeated = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-continue', { runId: rejected.runId, operationId: 'reuse-espcn-background', recompose: { imageVersionId: f.image.id, revision: savedRevision, mode: 'protected-context-v2', backgroundResolution: 'current' } }))
    await f.f.jobs.drain()
    const reused = wallpaperStateSchema.parse(dataOf(f.f.domain.require('run', repeated.runId)).checkpoint.wallpaper).items[0]!.attempts.at(-1)!.backgroundResolution
    assert.equal(reused?.enhancedId, evidence.enhancedId)
    assert.equal(reused?.durationMs, evidence.durationMs)
    assert.equal(reused?.reusedFromRevision, savedRevision)
    assert.equal(f.startedImages, 0)
  } finally { await f.cleanup() }
})

for (const operation of ['replan', 'continue'] as const) test(`a two-image ${operation} retains truthful qualification for its already-passed sibling without another review`, async () => {
  const f = await fixture(true)
  try {
    const parent = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-continue', { runId: f.old.id, operationId: 'two-image-parent', recompose: { imageVersionId: f.image.id, revision: 1 } }))
    await f.f.jobs.drain()
    const prior = f.f.domain.require('run', parent.runId), saved = wallpaperStateSchema.parse(dataOf(prior).checkpoint.wallpaper), kept = saved.items.find(item => item.status === 'passed')!, target = saved.items.find(item => item.status === 'technical-failed')!
    assert.ok(kept); assert.ok(target)
    const priorSelection = f.f.repository.list('selection').find(row => row.runId === prior.id && row.imageVersionId === kept.attempts.at(-1)!.outputId)!
    const priorAssessment = f.f.domain.require('assessment', priorSelection.assessmentId)
    {
      const previousCalls = f.operations.length, previousReads = f.readHandles.length
      const started = z.object({ runId: z.string() }).parse(operation === 'replan'
        ? await f.f.action('wallpaper-plan-update', { runId: prior.id, imageVersionId: target.imageVersionId, operationId: 'two-image-replan', plan: toJson(target.attempts.at(-1)!.plan) })
        : await f.f.action('wallpaper-continue', { runId: prior.id, operationId: 'two-image-continue' }))
      await f.f.jobs.drain()
      const child = f.f.domain.require('run', started.runId), childState = wallpaperStateSchema.parse(dataOf(child).checkpoint.wallpaper), selections = f.f.repository.list('selection').filter(row => row.runId === child.id)
      assert.equal(childState.items.filter(item => item.status === 'passed').length, 2)
      assert.equal(selections.length, 2, 'both passed outputs need qualification owned by the child')
      const copied = f.f.domain.require('assessment', selections.find(row => row.imageVersionId === kept.attempts.at(-1)!.outputId)!.assessmentId)
      assert.equal(copied.runId, child.id); assert.equal(copied.reviewBundleId, priorAssessment.reviewBundleId)
      assert.deepEqual(z.object({ reusedQualification: z.object({ runId: z.string(), assessmentId: z.string(), selectionId: z.string() }) }).parse(copied.data).reusedQualification, { runId: prior.id, assessmentId: priorAssessment.id, selectionId: priorSelection.id })
      const report = z.object({ workflowComplete: z.boolean(), wallpaper: z.object({ complete: z.boolean(), passed: z.number() }), results: z.array(z.object({ imageVersionId: z.string() })) }).parse(await f.f.action('run-get', { runId: child.id }))
      assert.equal(report.workflowComplete, true); assert.equal(report.wallpaper.complete, true); assert.equal(report.wallpaper.passed, 2); assert.equal(report.results.length, 2)
      const receipt = receiptSchema.parse(await f.f.action('run-get', { runId: child.id })).wallpaper
      assert.deepEqual(receipt.continuation, { parentRunId: prior.id, kind: operation, ...(operation === 'replan' ? { changedImageVersionId: target.imageVersionId } : {}) })
      const keptOutput = receipt.outputs.find(output => output.sourceImageVersionId === kept.imageVersionId)!, currentOutput = receipt.outputs.find(output => output.sourceImageVersionId === target.imageVersionId)!
      assert.deepEqual(keptOutput.inherited, { runId: prior.id, assessmentId: priorAssessment.id, selectionId: priorSelection.id })
      assert.equal(keptOutput.assessmentId, copied.id); assert.equal(keptOutput.cumulativeImageEdits, kept.edits)
      assert.equal(currentOutput.inherited, null)
      assert.equal(currentOutput.assessmentId, selections.find(row => row.imageVersionId === currentOutput.imageVersionId)!.assessmentId)
      const expected = JSON.parse(await readFile(new URL('./fixtures/wallpaper-continuation-receipt.expected.json', import.meta.url), 'utf8'))
      assert.deepEqual({ kind: receipt.continuation!.kind, inheritedOutputs: receipt.outputs.filter(output => output.inherited).length, currentRunReviewedOutputs: receipt.outputs.filter(output => output.assessmentId && output.inherited === null).length, inheritedCumulativeImageEdits: keptOutput.cumulativeImageEdits, newGenerations: f.startedImages }, expected[operation])
      assert.deepEqual(f.operations.slice(previousCalls), ['wallpaper-review'], 'only the newly processed image is reviewed')
      assert.equal(f.readHandles.length, previousReads); assert.equal(f.startedImages, 0)
      assert.deepEqual(f.f.domain.require('run', prior.id), prior)
      assert.deepEqual(f.f.domain.require('assessment', priorAssessment.id), priorAssessment)
    }
    for (const failure of ['missing-selection', 'rejected-review', 'wrong-pixels', 'legacy-settings', 'different-settings'] as const) {
      const id = `invalid-parent-${failure}`, retained = structuredClone(kept), records: CuratorRecord[] = []
      let outputId = retained.attempts.at(-1)!.outputId!
      if (failure === 'rejected-review') retained.attempts.at(-1)!.review!.checks.clock.result = 'violated'
      if (failure === 'wrong-pixels') {
        const actual = f.f.domain.require('imageVersion', outputId), different = imageVersionSchema.parse({ ...actual, id: `invalid-output-${failure}`, blob: f.image.blob })
        records.push(different); retained.attempts.at(-1)!.outputId = different.id; outputId = different.id
      }
      const invalidState = wallpaperStateSchema.parse({ ...saved, items: [retained] }), originalSpec = specOf(prior)
      const invalidParent = runSchema.parse({ ...prior, id, createdAt: new Date().toISOString(), spec: toJson({ ...originalSpec, input: { ...originalSpec.input, operationId: id, imageVersionIds: [retained.imageVersionId], targetCount: 1 }, fixed: { ...originalSpec.fixed, initialWallpaperState: toJson(invalidState) } }), data: toJson({ ...dataOf(prior), requestIds: [], checkpoint: { wallpaper: toJson(invalidState) } }) })
      records.push(invalidParent)
      if (failure !== 'missing-selection') {
        const evidence = z.object({ settings: z.record(z.string(), z.json()) }).passthrough().parse(priorAssessment.data)
        if (failure === 'legacy-settings') delete evidence.settings.backgroundTransitionPixels
        if (failure === 'different-settings') evidence.settings.backgroundTransitionPixels = 0
        const assessment = assessmentSchema.parse({ ...priorAssessment, id: `invalid-assessment-${failure}`, runId: id, imageVersionId: outputId, data: toJson(evidence) })
        records.push(assessment, selectionSchema.parse({ ...priorSelection, id: `invalid-selection-${failure}`, runId: id, imageVersionId: outputId, assessmentId: assessment.id }))
      }
      await f.f.repository.commit({ aggregateId: id, expectedRevision: 0, operationId: `seed-${id}`, request: {}, records, state: {} })
      const calls = f.operations.length, reads = f.readHandles.length
      const started = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-continue', { runId: id, operationId: `continue-${failure}` }))
      await f.f.jobs.drain()
      const child = f.f.domain.require('run', started.runId), item = wallpaperStateSchema.parse(dataOf(child).checkpoint.wallpaper).items[0]!
      const childSelections = f.f.repository.list('selection').filter(row => row.runId === child.id)
      if (failure === 'legacy-settings') {
        assert.equal(item.status, 'passed'); assert.equal(childSelections.length, 1)
        const copied = f.f.domain.require('assessment', childSelections[0]!.assessmentId), original = f.f.domain.require('assessment', `invalid-assessment-${failure}`)
        const oldSettings = z.object({ settings: z.record(z.string(), z.json()) }).parse(original.data).settings
        const copiedSettings = z.object({ settings: z.record(z.string(), z.json()) }).parse(copied.data).settings
        assert.equal(wallpaperSettingsSchema.parse(oldSettings).backgroundTransitionPixels, 192)
        assert.equal(Object.hasOwn(oldSettings, 'backgroundTransitionPixels'), false)
        assert.deepEqual(copiedSettings, oldSettings, 'default normalization must not alter copied review evidence')
      } else {
        assert.equal(item.status, 'technical-failed', failure); assert.equal(item.failedStep, 'reviewing', failure)
        assert.equal(childSelections.length, 0, failure)
      }
      assert.equal(dataOf(child).requestIds.length, 0, failure)
      assert.equal(f.operations.length, calls); assert.equal(f.readHandles.length, reads); assert.equal(f.startedImages, 0)
      assert.deepEqual(f.f.domain.require('run', id), invalidParent)
    }
  } finally { await f.cleanup() }
})
test('saved-output review retains the authorized task source Session without opening other Session images', async () => {
  const f = await fixture(false, false, true)
  try {
    assert.throws(() => f.f.domain.authorizedImage(f.image.id, { kind: 'human', id: 'profile-owner', profileId: f.f.profileId }), /another Session/)
    const outputId = f.state.items[0]!.attempts[0]!.outputId!
    const receipt = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-continue', { runId: f.old.id, operationId: 'review-session-output', review: { outputId } }))
    await f.f.jobs.drain()
    const child = f.f.domain.require('run', receipt.runId), item = wallpaperStateSchema.parse(dataOf(child).checkpoint.wallpaper).items[0]!
    assert.equal(item.status, 'passed', item.reason)
    assert.equal(specOf(child).fixed.sourceSessionId, 'source-session')
    assert.deepEqual(f.f.domain.require('run', f.old.id), f.old)
    assert.deepEqual(f.operations, ['wallpaper-review']); assert.equal(f.startedImages, 0)
    assert.throws(() => f.f.domain.authorizedImage(f.image.id, { kind: 'human', id: 'other-owner', profileId: f.f.profileId, sessionId: 'another-session' }), /another Session/)
  } finally { await f.cleanup() }
})

test('incomplete style output cannot hide validated subject truncation or create a qualified wallpaper', async () => {
  const f = await fixture(false, true)
  try {
    f.setSourceExtent('cut-off'); f.setInvalidStyleRows()
    const outputId = f.state.items[0]!.attempts[0]!.outputId!
    const receipt = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-continue', { runId: f.old.id, operationId: 'reject-incomplete-response', review: { outputId } }))
    await f.f.jobs.drain()
    const child = f.f.domain.require('run', receipt.runId), item = wallpaperStateSchema.parse(dataOf(child).checkpoint.wallpaper).items[0]!
    assert.equal(item.status, 'rejected', item.reason); assert.equal(item.attempts.at(-1)!.review!.checks.style.result, 'unknown')
    assert('subjectRejectionOnly' in item.attempts.at(-1)!.review!)
    assert.equal(dataOf(child).counts.finalPassed, 0)
    const result = z.object({ results: z.array(z.object({ imageVersionId: z.string(), reason: z.string() })) }).parse(await f.f.action('run-get', { runId: child.id, resultFilter: 'rejected' }))
    assert(result.results.some(row => row.imageVersionId === outputId && row.reason.includes('主体完整性不通过')))
    assert(f.f.repository.list('request').some(q => q.runId === child.id && q.state === 'outcome-unknown'))
    assert.equal(f.startedImages, 0); assert.deepEqual(f.readHandles, []); assert.deepEqual(f.f.domain.require('run', f.old.id), f.old)
  } finally { await f.cleanup() }
})
test('historical workflow reads pin the requested task and expose source-image routes without rewriting history', async () => {
  const f = await fixture()
  try {
    const outputId = f.state.items[0]!.attempts[0]!.outputId!
    const receipt = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-continue', { runId: f.old.id, operationId: 'historical-route', review: { outputId } }))
    await f.f.jobs.drain()
    const latest = wallpaperViewSchema.parse(await f.f.action('wallpaper-read', { sourceRunId: f.state.sourceRunId, offset: 0, limit: 1 }))
    const pinned = wallpaperViewSchema.parse(await f.f.action('wallpaper-read', { sourceRunId: f.state.sourceRunId, runId: f.old.id, offset: 0, limit: 1 }))
    assert.equal(latest.runId, receipt.runId); assert.equal(pinned.runId, f.old.id)
    assert.deepEqual(pinned.state.items, f.state.items)
    const result = z.object({ wallpaper: z.object({ sourceRunId: z.string() }), results: z.array(z.object({ workflowImageVersionId: z.string() })) }).parse(await f.f.action('run-get', { runId: receipt.runId }))
    assert.equal(result.wallpaper.sourceRunId, f.state.sourceRunId); assert.equal(result.results[0]!.workflowImageVersionId, f.image.id)
    await assert.rejects(f.f.action('wallpaper-read', { sourceRunId: f.state.sourceRunId, runId: f.state.sourceRunId, offset: 0, limit: 1 }), /does not belong/)
    assert.deepEqual(f.f.domain.require('run', f.old.id), f.old); assert.deepEqual(f.operations, ['wallpaper-review']); assert.equal(f.startedImages, 0)
  } finally { await f.cleanup() }
})

for (const receiptState of ['failed', 'outcome-unknown', 'succeeded'] as const) test('single-image recovery checks a ' + receiptState + ' receipt before creating any new edit', async () => {
  const f = await fixture(true)
  try {
    const llm = f.f.host.llm!, successful = await llm.getImageGeneration(f.handle), state = structuredClone(f.state), item = state.items[0]!
    item.edits = 1; item.reason = 'image-operation-failed'; item.status = 'needs-review'
    delete item.attempts[0]!.outputId; delete item.attempts[0]!.review; delete item.attempts[0]!.simulationId
    const parent = runSchema.parse({ ...f.old, id: 'single-image-failed-parent', createdAt: new Date().toISOString(), data: { ...dataOf(f.old), checkpoint: { wallpaper: toJson(state) } } })
    await f.f.repository.commit({ aggregateId: 'single-image-failed-seed', expectedRevision: 0, operationId: 'single-image-failed-seed', request: {}, records: [parent], state: {} })
    let starts = 0, queries = 0
    const nextHandle = { ...f.handle, id: brandString<import('@deepseek-ai/dsh-llm').ImageGenerationId>('new-operation'), taskId: brandString<import('@deepseek-ai/dsh-llm').ImageGenerationTaskId>('new-task') }
    llm.getImageGeneration = async handle => {
      queries++
      if (handle.id === f.handle.id) return { ...successful, state: receiptState, images: receiptState === 'succeeded' ? successful.images : [] }
      if (handle.taskId === undefined) throw Object.assign(new Error('Known absent operation'), { code: 'IMAGE_GENERATION_NOT_FOUND' })
      return { ...successful, ...nextHandle }
    }
    llm.startImageGeneration = async input => { assert(queries > 0); starts++; nextHandle.id = input.id!; return { ...successful, ...nextHandle } }
    await assert.rejects(f.f.action('wallpaper-continue', { runId: parent.id, operationId: 'old-version', retryImage: { imageVersionId: item.imageVersionId, revision: 99, step: 'rendering' } }), { code: 'constraint-conflict' })
    const args = { runId: parent.id, operationId: 'single-image-retry', retryImage: { imageVersionId: item.imageVersionId, revision: 1, step: 'rendering' } }
    const receipt = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-continue', args))
    assert.deepEqual(await f.f.action('wallpaper-continue', args), receipt)
    await f.f.jobs.drain()
    const after = wallpaperStateSchema.parse(dataOf(f.f.domain.require('run', receipt.runId)).checkpoint.wallpaper)
    assert.equal(starts, receiptState === 'failed' ? 1 : 0)
    assert.equal(after.items[0]!.edits, receiptState === 'failed' ? 2 : 1)
    assert.equal(after.items[0]!.attempts.length, receiptState === 'failed' ? 2 : 1)
    assert.deepEqual(after.items[1], state.items[1]); assert.deepEqual(f.f.domain.require('run', parent.id), parent)
    if (receiptState === 'outcome-unknown') { assert.equal(after.items[0]!.status, 'technical-failed'); assert.equal(after.items[0]!.failedStep, 'rendering') }
  } finally { await f.cleanup() }
})
