/** Saved generation handles can be recomposed through the real service without another image dispatch. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { type ImageGenerationHandle, type ImageGenerationTask } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import LocalAttachmentStore from '../../../../packages/attachment/attachment-local/src/index.ts'
import { serviceFixture } from './helpers/service-fixture.ts'
import { BudgetLedger, dataOf, specOf, toJson, type ExecutionSpec } from '../src/host/runtime.ts'
import { assessmentSchema, selectionSchema, imageVersionSchema, runSchema, requestSchema, type CuratorRecord, type RunRecord } from '../src/shared/model.ts'
import { wallpaperPlanSchema, wallpaperReviewKeys, wallpaperReviewSchema, wallpaperSettingsSchema, wallpaperStateSchema, wallpaperProgress, wallpaperViewSchema } from '../src/shared/wallpaper.ts'
import { wallpaperPromptBundle } from '../src/shared/wallpaper-prompts.ts'
import { wallpaperGeometry } from '../src/media/wallpaper-render.ts'
import { contentDigest } from '../src/domain/repository.ts'
import { createCuratorTransport } from '../src/client/transport.ts'
import { MediaError } from '../src/media/errors.ts'
import { readFile } from 'node:fs/promises'

const receiptSchema = z.object({ wallpaper: z.object({
  continuation: z.object({ parentRunId: z.string(), kind: z.enum(['replan', 'recompose', 'continue']), changedImageVersionId: z.string().optional() }).optional(),
  outputs: z.array(z.object({ imageVersionId: z.string(), sourceImageVersionId: z.string(), cumulativeImageEdits: z.number(), assessmentId: z.string().optional(), inherited: z.object({ runId: z.string(), assessmentId: z.string(), selectionId: z.string() }).nullable().optional() })),
}) })

async function fixture(twoSources = false, weightedPolicy = false) {
  const f = await serviceFixture(undefined, { maxVisionCalls: 20 }), context = new Context(), llm = new LlmRuntime(context), attachments = new LocalAttachmentStore(context, { dshHome: f.root })
  f.host.llm = llm; f.host.attachments = attachments
  try {
    await f.service.initialize()
    let generationState: ImageGenerationTask['state'] = 'succeeded', rejectReview = false, startedImages = 0, offcanvasPlans = 0, styleOnlyFailure = false, invalidStyleRows = false
    const readHandles: ImageGenerationHandle[] = [], operations: string[] = []
    const generated = await sharp({ create: { width: 1845, height: 3280, channels: 3, background: '#1933d1' } }).png().toBuffer()
    const original = await attachments.saveFile({ data: generated, name: 'saved-provider-result.png' }), previews = await attachments.saveImages([{ data: generated, mediaType: 'image/png', name: 'saved-provider-preview.png' }])
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
    const profile = f.repository.list('modelProfile')[0]!, images = f.repository.list('reference').map(reference => f.domain.require('imageVersion', reference.imageVersionId)), image = images.find(image => image.geometry.width === 1000)!, asset = f.domain.require('asset', image.assetId)
    const stale = await f.files.importBytes(generated, 'image/png'), staleOutput = imageVersionSchema.parse({ ...image, id: 'old-composition', versionKind: 'composition', parentImageVersionId: image.id, blob: stale.normalized.blob, geometry: { ...image.geometry, width: 1845, height: 3280 } })
    const settings = wallpaperSettingsSchema.parse({ imageProvider: handle.provider, imageModel: handle.model, learningEnabled: false })
    const plan = wallpaperPlanSchema.parse({ version: 1, imageVersionId: image.id, mode: 'single', subject: 'The original red source.', evidence: 'Actual original pixels.', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: ['subject', 'critical'].map(role => ({ name: role, role, rect: { x: 0.25, y: 0.2, width: 0.3, height: 0.2 } })), placement: { scale: 1, left: 400, top: 1100 }, reason: 'Keep the protected source inside the safe region.' })
    assert.deepEqual(wallpaperGeometry(image.geometry, plan, settings).checks, [])
    const review = wallpaperReviewSchema.parse({ subject: 'Saved prior review.', checks: Object.fromEntries(wallpaperReviewKeys.map(key => [key, { result: key === 'background' ? 'violated' : 'satisfied', reason: 'Saved old review.' }])), issues: [{ kind: 'background', reason: 'Recompose the existing provider output.' }] })
    const state = wallpaperStateSchema.parse({ version: 1, sourceRunId: 'source-search', skillVersion: 'fixture-skill', budgetStopped: true, items: [{ imageVersionId: image.id, originalId: image.id, familyId: asset.familyId, status: 'needs-review', edits: 2, attempts: [{ revision: 1, plan, checks: [], needsOutpaint: true, canvasId: image.id, maskId: image.id, analysisId: staleOutput.id, simulationId: staleOutput.id, outputId: staleOutput.id, generation: handle, generationOperation: handle.id, editReserved: true, review }] }] })
    if (twoSources) {
      const other = images.find(other => other.id !== image.id)!, otherAsset = f.domain.require('asset', other.assetId)
      const otherPlan = wallpaperPlanSchema.parse({ ...plan, imageVersionId: other.id, placement: { left: 0, top: 0, scale: 1 }, regions: plan.regions.map(region => ({ ...region, rect: { x: 0.25, y: 0.4, width: 0.3, height: 0.2 } })) })
      state.items.push({ imageVersionId: other.id, originalId: other.id, familyId: otherAsset.familyId, status: 'technical-failed', failedStep: 'reviewing', edits: 0, attempts: [{ revision: 1, plan: otherPlan, checks: [], needsOutpaint: false }] })
    }
    const prompts = { ...wallpaperPromptBundle(), outpaint: { version: 'wallpaper-outpaint-v1', text: 'Saved first-generation editing instructions.' } }
    const spec: ExecutionSpec = { kind: 'crop', config: f.service.config, input: { workflow: 'wallpaper-v1', operationId: 'old-wallpaper', sourceRunId: state.sourceRunId, imageVersionIds: state.items.map(item => item.imageVersionId), taskBrief: 'Recompose saved source pixels.', targetCount: state.items.length }, fixed: { release: toJson(profile), ...(weightedPolicy ? { executionRecipe: toJson({ ...profile.recipe, styleMatching: { version: 2, minSatisfiedRatio: 0.75 } }) } : {}), wallpaper: toJson(settings), skill: { id: 'fixture-skill', content: 'Keep original protected pixels.' }, prompts: toJson(prompts) }, specDigest: contentDigest('saved-wallpaper') }
    const old = runSchema.parse({ schemaVersion: 1, profileId: f.profileId, id: 'old-wallpaper', createdAt: '1970-01-01T00:00:00.000Z', kind: 'run', owner: { kind: 'profile' }, revision: 1, status: 'completed', stage: 'finalizing', outcome: 'source-exhausted', spec: toJson(spec), data: { attemptId: 'old-attempt', attempts: 1, budget: { ...new BudgetLedger(spec.config.limits).snapshot(), vision: 5, search: 2, downloadBytes: 1234 }, checkpoint: { wallpaper: toJson(state) }, counts: {}, warnings: [], requestIds: [], resultIds: [] } })
    const sourceRun = runSchema.parse({ ...old, id: state.sourceRunId, spec: toJson({ ...spec, kind: 'search', input: { taskBrief: 'Saved source search.', targetCount: state.items.length } }) })
    await f.repository.commit({ aggregateId: 'saved-wallpaper', expectedRevision: 0, operationId: 'saved-wallpaper', request: {}, records: [sourceRun, old, staleOutput], state: {} })
    operations.length = 0
    return { f, old, state, image, handle, operations, readHandles, setReviewRejected() { rejectReview = true }, setStyleOnlyFailure() { styleOnlyFailure = true }, setInvalidStyleRows() { invalidStyleRows = true }, setOffcanvasPlans(n: number) { offcanvasPlans = n }, setGenerationFailed() { generationState = 'failed' }, get startedImages() { return startedImages }, async cleanup() { await f.cleanup(); await context.fiber.dispose() } }
  } catch (error) { await f.cleanup(); await context.fiber.dispose(); throw error }
}

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
    assert.equal(item.status, 'needs-review'); assert.equal(item.attempts.length, 2); assert.equal(item.edits, 2)
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
    const old = runSchema.parse({ ...f.old, id: 'legacy-no-threshold', spec: toJson({ ...spec, fixed: { ...spec.fixed, release } }) })
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
      const old = runSchema.parse({ ...f.old, id, data: toJson({ ...dataOf(f.old), checkpoint: { wallpaper: toJson(state) } }) })
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
      const inheritedSpec = specOf(ancestor), next = runSchema.parse({ ...ancestor, id: `recomposed-descendant-${number}`, spec: toJson({ ...inheritedSpec, input: { ...inheritedSpec.input, continuationKind: 'recompose', continuationOf: ancestor.id, operationId: `ancestor-${number}`, recomposedImageId: f.image.id } }) })
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
    f.f.files.importBytes = async () => { throw new MediaError('budget-exhausted', 'media', false, 'The private media storage limit is exhausted.', 'Increase the storage limit or choose a smaller import.') }
    const receipt = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-continue', { runId: f.old.id, operationId: 'quota', recompose: { imageVersionId: f.image.id, revision: 1 } })); await f.f.jobs.drain()
    const run = f.f.domain.require('run', receipt.runId), data = dataOf(run), state = wallpaperStateSchema.parse(data.checkpoint.wallpaper)
    assert.equal(run.outcome, 'budget-exhausted'); assert.equal(state.budgetStopped, true); assert.equal(data.error?.stage, 'media'); assert.match(data.error!.safeMessage, /private media storage/)
    assert.ok(data.warnings.some(message => message.includes('private media storage'))); assert.ok(f.f.domain.require('imageVersion', f.state.items[0]!.attempts[0]!.outputId!)); assert.deepEqual(f.f.domain.require('run', f.old.id), f.old); assert.equal(f.startedImages, 0)
  } finally { await f.cleanup() }
})

test('manual JSON replans reject unsafe source geometry before creating work and retain valid and accepted revisions', async () => {
  const f = await fixture()
  try {
    const plan = f.state.items[0]!.attempts[0]!.plan
    const cases = [
      { name: 'clock', placement: { ...plan.placement, top: 0 }, code: 'constraint-conflict', stage: 'wallpaper-replan' },
      { name: 'buffer', placement: { ...plan.placement, top: 650 }, code: 'constraint-conflict', stage: 'wallpaper-replan' },
      { name: 'critical', placement: { ...plan.placement, left: 0 }, code: 'constraint-conflict', stage: 'wallpaper-replan' },
      { name: 'off-canvas', placement: { ...plan.placement, left: 1846 }, code: 'invalid-input', stage: 'wallpaper-layout' },
    ]
    const runs = f.f.repository.list('run').length, requests = f.f.repository.list('request').length
    for (const sample of cases) {
      await assert.rejects(f.f.action('wallpaper-plan-update', { runId: f.old.id, imageVersionId: f.image.id, operationId: `manual-invalid-${sample.name}`, plan: { ...plan, placement: sample.placement } }), { code: sample.code, stage: sample.stage }, sample.name)
      assert.equal(f.f.repository.list('run').length, runs)
      assert.equal(f.f.repository.list('request').length, requests)
      assert.deepEqual(f.f.domain.require('run', f.old.id), f.old)
    }
    assert.equal(f.startedImages, 0); assert.deepEqual(f.readHandles, []); assert.deepEqual(f.operations, [])
    const input = { runId: f.old.id, imageVersionId: f.image.id, operationId: 'manual-valid', plan }
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
    assert.deepEqual(await f.f.action('wallpaper-plan-update', { runId: f.old.id, imageVersionId: f.image.id, operationId, plan: invalid }), { runId: legacy.id })
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
    const input = { runId: old.id, imageVersionId: item.imageVersionId, operationId: 'owner-corrected-after-limit', plan: first.plan, backgroundPolicy: 'current' }
    const started = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-plan-update', input))
    assert.deepEqual(await f.f.action('wallpaper-plan-update', input), started)
    const child = f.f.domain.require('run', started.runId), spec = specOf(child), initial = wallpaperStateSchema.parse(spec.fixed.initialWallpaperState)
    assert.equal(wallpaperSettingsSchema.parse(spec.fixed.wallpaper).maxReworks, 2)
    assert.equal(initial.items[0]!.attempts.length, 4)
    assert.equal(initial.items[0]!.edits, 2)
    assert.equal(initial.items[0]!.attempts.at(-1)!.compositionMode, 'protected-context-v2')
    assert.equal(z.object({ outpaint: z.object({ version: z.string() }) }).parse(spec.fixed.prompts).outpaint.version, 'wallpaper-outpaint-v3')
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

test('a two-image continuation retains truthful qualification for its already-passed sibling without another review', async () => {
  const f = await fixture(true)
  try {
    const parent = z.object({ runId: z.string() }).parse(await f.f.action('wallpaper-continue', { runId: f.old.id, operationId: 'two-image-parent', recompose: { imageVersionId: f.image.id, revision: 1 } }))
    await f.f.jobs.drain()
    const prior = f.f.domain.require('run', parent.runId), saved = wallpaperStateSchema.parse(dataOf(prior).checkpoint.wallpaper), kept = saved.items.find(item => item.status === 'passed')!, target = saved.items.find(item => item.status === 'technical-failed')!
    assert.ok(kept); assert.ok(target)
    const priorSelection = f.f.repository.list('selection').find(row => row.runId === prior.id && row.imageVersionId === kept.attempts.at(-1)!.outputId)!
    const priorAssessment = f.f.domain.require('assessment', priorSelection.assessmentId)
    for (const operation of ['replan', 'continue'] as const) {
      const previousCalls = f.operations.length, previousReads = f.readHandles.length
      const started = z.object({ runId: z.string() }).parse(operation === 'replan'
        ? await f.f.action('wallpaper-plan-update', { runId: prior.id, imageVersionId: target.imageVersionId, operationId: 'two-image-replan', plan: target.attempts.at(-1)!.plan })
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
      const invalidParent = runSchema.parse({ ...prior, id, spec: toJson({ ...originalSpec, input: { ...originalSpec.input, operationId: id, imageVersionIds: [retained.imageVersionId], targetCount: 1 }, fixed: { ...originalSpec.fixed, initialWallpaperState: toJson(invalidState) } }), data: toJson({ ...dataOf(prior), requestIds: [], checkpoint: { wallpaper: toJson(invalidState) } }) })
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
