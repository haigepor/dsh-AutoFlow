/** Final geometry contradictions use saved final pixels before consuming another image edit. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import LlmRuntime, { type ImageGenerationTask, type ImageGenerationTaskId } from '@deepseek-ai/dsh-llm'
import LocalAttachmentStore from '../../../../packages/attachment/attachment-local/src/index.ts'
import { contentDigest } from '../src/domain/repository.ts'
import { dataOf, toJson } from '../src/host/runtime.ts'
import { imageVersionSchema, runSchema } from '../src/shared/model.ts'
import { wallpaperPromptPreparationPolicySchema } from '../src/shared/wallpaper-generation-brief.ts'
import { wallpaperItemSchema, wallpaperSettingsSchema, wallpaperStateSchema, wallpaperVerdict } from '../src/shared/wallpaper.ts'
import { serviceFixture } from './helpers/service-fixture.ts'
import { wallpaperFixtureResponse } from './helpers/wallpaper-response.ts'

const recorded = z.object({ settings: wallpaperSettingsSchema, cases: z.array(z.object({ number: z.number(), item: wallpaperItemSchema })) }).parse(JSON.parse(await readFile(new URL('./fixtures/wallpaper-still-life-batch.expected.json', import.meta.url), 'utf8')))
const sourceCase = recorded.cases.find(row => row.number === 3)!.item.attempts.at(-1)!
const nativeReview = sourceCase.review!, finalReview = sourceCase.postResolutionReview!.review!
assert.ok('modelIssues' in nativeReview && 'modelIssues' in finalReview)
const sourceObjects = sourceCase.plan.objectRoles
assert.ok(sourceObjects)

for (const mode of ['remeasure', 'confirmed-overflow', 'budget', 'review-recovery', 'truncated-review-recovery', 'legacy-generic-retry', 'legacy-image-retry', 'historical-review', 'historical-recompose'] as const) test(`final safety ${mode} keeps native evidence and bounds generation`, async () => {
  const truncated = mode === 'truncated-review-recovery'
  const legacyRetry = mode === 'legacy-generic-retry' || mode === 'legacy-image-retry'
  const f = await serviceFixture(undefined, { maxVisionCalls: mode === 'budget' ? 3 : 20, maxRetryAttempts: 1 })
  const context = new Context(), llm = new LlmRuntime(context), attachments = new LocalAttachmentStore(context, { dshHome: f.root })
  f.host.llm = llm; f.host.attachments = attachments
  f.service.config.wallpaper.imageProvider = 'isolated-images'; f.service.config.wallpaper.imageModel = 'isolated-model'
  f.service.config.wallpaper.maxEditsPerImage = 2
  f.service.config.wallpaper.repairPolicy = recorded.settings.repairPolicy
  f.service.config.wallpaper.decision = { version: 'wallpaper-decision-v1', enabled: truncated, maxRoundsPerImage: 2, maxDetailRequests: 1 }
  f.service.config.wallpaper.clarity = { ...recorded.settings.clarity!, enabled: false }
  f.service.config.wallpaper.backgroundResolution = { ...recorded.settings.backgroundResolution!, enabled: false }
  f.service.config.vision.wallpaperPromptPreparation = wallpaperPromptPreparationPolicySchema.parse({ enabled: false })
  const width = 1845, height = 3280
  const rectangle = await sharp({ create: { width: 664, height: 1100, channels: 3, background: '#a35e82' } }).png().toBuffer()
  const pixels = await sharp({ create: { width, height, channels: 3, background: '#a6c2b4' } }).composite([{ input: rectangle, left: 900, top: 1200 }]).png().toBuffer()
  const wide = await sharp({ create: { width: 770, height: 1100, channels: 3, background: '#a35e82' } }).png().toBuffer()
  const overflowPixels = await sharp({ create: { width, height, channels: 3, background: '#a6c2b4' } }).composite([{ input: wide, left: 900, top: 1200 }]).png().toBuffer()
  const path = join(f.root, 'original.png'); await writeFile(path, pixels)
  const tasks = new Map<string, ImageGenerationTask>()
  let generations = 0, boundaries = 0, finalReviews = 0, decisions = 0, failBoundary = mode === 'review-recovery' || truncated
  llm.getImageGeneration = async handle => {
    const task = tasks.get(handle.id)
    if (!task) throw Object.assign(new Error('No isolated receipt'), { code: 'IMAGE_GENERATION_NOT_FOUND' })
    return task
  }
  llm.startImageGeneration = async request => {
    generations++
    if (legacyRetry && generations === 1) {
      const failed: ImageGenerationTask = { id: request.id, provider: request.provider, model: request.model, taskId: brandString<ImageGenerationTaskId>('isolated-failed'), state: 'failed', images: [], error: { code: 'image-http-error', message: 'The saved image request failed.' } }
      tasks.set(request.id, failed)
      return failed
    }
    const output = mode === 'confirmed-overflow' && generations === 1 ? overflowPixels : pixels
    const file = await attachments.saveFile({ data: output, name: 'complete-provider-image.png' })
    const [preview] = await attachments.saveImages([{ data: output, mediaType: 'image/png' }])
    assert.ok(preview)
    const task: ImageGenerationTask = { id: request.id, provider: request.provider, model: request.model, taskId: brandString<ImageGenerationTaskId>('isolated-' + generations), state: 'succeeded', images: [{ original: file, preview }] }
    tasks.set(request.id, task)
    return task
  }
  const send = f.http.request.bind(f.http)
  f.http.request = async (url, request) => {
    if (!url.startsWith('https://vision.example.test')) return send(url, request)
    const messages = z.object({ messages: z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ text: z.string().optional() }).passthrough())]) })) }).parse(JSON.parse(Buffer.from(request.body!).toString('utf8'))).messages
    const content = messages.find(message => message.role === 'user')!.content; assert.ok(Array.isArray(content))
    const descriptor = JSON.parse(content[0]!.text!)
    const input = z.object({ input: z.object({ operation: z.string(), images: z.array(z.object({ imageVersionId: z.string(), role: z.string() })), usage: z.object({ composition: z.object({ reviewStage: z.string() }).passthrough().optional(), boundaryReview: z.unknown().optional() }).passthrough().optional() }) }).parse(descriptor).input
    const source = input.images.find(image => image.role === 'wallpaper-original')!; assert.ok(source)
    let response: object
    if (input.operation === 'wallpaper-decision') {
      decisions++; failBoundary = false
      const decision = z.object({ planRevision: z.number(), concerns: z.array(z.object({ id: z.string(), scope: z.string().optional() })) }).parse(input.usage?.decision)
      const version = z.object({ outputSchema: z.object({ properties: z.object({ version: z.object({ const: z.string() }) }) }) }).parse(descriptor).outputSchema.properties.version.const
      response = { version, imageVersionId: source.imageVersionId, planRevision: decision.planRevision,
        findings: decision.concerns.map(concern => ({ concernId: concern.id, scope: concern.scope ?? 'technical', classification: 'technical-failure', blocking: true, reason: 'A failed boundary response requires review of the saved pixels.', evidenceImageVersionIds: input.images.map(image => image.imageVersionId) })),
        sourceExtent: { extent: 'cut-off', reason: 'The authorized original truncation remains recorded.' }, action: { kind: 'retry_saved_review' }, reason: 'Retry the saved final review without another image generation.' }
    } else if (input.operation === 'wallpaper-plan') {
      const { placement: _placement, ...observation } = sourceCase.plan
      response = { ...observation, regions: observation.regions.filter(region => region.role === 'subject'), imageVersionId: source.imageVersionId }
    } else {
      assert.equal(input.operation, 'wallpaper-review')
      const policy = z.object({ regions: z.array(z.object({ entityId: z.string().optional(), role: z.string() })) }).parse(input.usage?.objectPolicy)
      const subjects = policy.regions.filter(region => sourceObjects.some(object => object.role === 'primary' && object.entityId === region.entityId))
      assert.deepEqual(subjects.map(region => region.role), ['subject', 'subject'], 'Review instructions expose one canonical role per frozen primary subject')
      const actual = input.images.find(image => image.role === 'actual-wallpaper')!; assert.ok(actual)
      const finalStage = input.usage?.composition?.reviewStage === 'post-resolution-final'
      const boundary = input.usage?.boundaryReview !== undefined
      if (boundary) {
        boundaries++
        assert.equal(finalStage, true)
        assert.deepEqual(input.images.map(image => image.role), ['actual-wallpaper', 'wallpaper-original', 'wallpaper-layout-only'])
        if (failBoundary) return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] })) }
      } else if (finalStage) finalReviews++
      const bad = generations === 1 && (boundary ? mode === 'confirmed-overflow' : finalStage)
      const review = bad ? finalReview : nativeReview
      response = { reviewVersion: review.reviewVersion, subject: review.subject, checks: review.modelChecks ?? review.checks, issues: review.modelIssues,
        styleResults: review.styleResults, sourceRepair: review.sourceRepair, sourceCorrespondence: review.sourceCorrespondence,
        subjectIntegrity: { ...review.subjectIntegrity, source: { ...review.subjectIntegrity.source, ...(truncated ? { extent: 'cut-off' } : {}), imageVersionId: source.imageVersionId }, output: { ...review.subjectIntegrity.output, imageVersionId: actual.imageVersionId } },
        actualLayout: { ...review.actualLayout, imageVersionId: actual.imageVersionId } }
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(wallpaperFixtureResponse(descriptor, response)) }, finish_reason: 'stop' }] })) }
  }
  try {
    await f.service.initialize()
    const receipt = z.object({ runId: z.string() }).parse(await f.action('direct-crop-start', { operationId: 'final-boundary-' + mode, name: 'Isolated final boundary', source: { kind: 'local', files: [{ path, name: 'original.png' }] } }))
    await f.jobs.drain()
    const run = f.domain.require('run', receipt.runId), item = wallpaperStateSchema.parse(dataOf(run).checkpoint.wallpaper).items[0]!
    const first = item.attempts[0]!
    assert.ok(first, JSON.stringify({ status: item.status, reason: item.reason, issues: f.repository.list('request').filter(row => row.state === 'outcome-unknown').map(row => z.object({ diagnostics: z.object({ issues: z.array(z.string()) }).optional() }).parse(row.data).diagnostics?.issues) }))
    if (legacyRetry || mode === 'historical-review' || mode === 'historical-recompose') {
      assert.equal(item.status, legacyRetry ? 'technical-failed' : 'passed', item.reason)
      const state = wallpaperStateSchema.parse(dataOf(run).checkpoint.wallpaper), saved = state.items[0]!.attempts[0]!
      const candidate = imageVersionSchema.parse({ ...f.domain.require('imageVersion', item.originalId!), id: item.originalId + ':saved-candidate', parentImageVersionId: item.originalId })
      if (legacyRetry || mode === 'historical-recompose') saved.layoutCorrection = { version: 'candidate-placement-locked-v2', plan: { ...structuredClone(saved.plan), imageVersionId: candidate.id, placement: { scale: 0.9, left: 80, top: 300 } } }
      else saved.plan.regions.push({ name: 'Historical background anchor', role: 'anchor', rect: { x: 0, y: 0, width: 1, height: 0.1 } })
      const parent = runSchema.parse({ ...run, id: run.id + ':historical', data: { ...dataOf(run), checkpoint: { wallpaper: toJson(state) } } })
      await f.repository.commit({ aggregateId: parent.id, expectedRevision: 0, operationId: parent.id, request: {}, records: [candidate, parent], state: {} })
      const digest = contentDigest(parent)
      const child = z.object({ runId: z.string() }).parse(await f.action('wallpaper-continue', { runId: parent.id, operationId: 'recover-' + mode,
        ...(mode === 'legacy-image-retry' ? { retryImage: { imageVersionId: item.imageVersionId, revision: first.revision, step: 'rendering' } } : mode === 'historical-review' ? { review: { outputId: first.outputId! } } : mode === 'historical-recompose' ? { recompose: { imageVersionId: item.imageVersionId, revision: first.revision, mode: 'generated-canvas-v1', reviewPolicy: 'current' } } : {}) }))
      const created = wallpaperStateSchema.parse(dataOf(f.domain.require('run', child.runId)).checkpoint.wallpaper).items[0]!.attempts.at(-1)!
      if (legacyRetry) {
        assert.equal(created.layoutCorrection?.version, 'candidate-placement-v1')
        assert.equal(created.generation, undefined)
      } else assert.equal(created.boundaryReview, undefined)
      await f.jobs.drain()
      const recovered = wallpaperStateSchema.parse(dataOf(f.domain.require('run', child.runId)).checkpoint.wallpaper).items[0]!
      assert.equal(recovered.status, 'passed', recovered.reason)
      assert.equal(generations, legacyRetry ? 2 : 1)
      assert.equal(recovered.attempts.length, 2)
      if (mode === 'historical-recompose') assert.equal(recovered.attempts.at(-1)!.preResolutionReview!.nativeDigest, f.domain.require('imageVersion', first.generatedImageId!).blob.digest, 'Recomposition reviews the saved provider pixels without pasting the previous candidate')
      assert.equal(contentDigest(f.domain.require('run', parent.id)), digest)
      return
    }
    assert.equal(wallpaperVerdict(first.review!), 'pass', JSON.stringify(first.review!.issues))
    if (truncated) {
      assert.equal(item.status, 'passed', item.reason)
      assert.equal(decisions, 1); assert.equal(generations, 1)
      assert.equal(first.boundaryReview?.status, 'failed')
      const review = item.attempts.at(-1)!.review!
      assert.ok('subjectIntegrity' in review)
      assert.equal(review.subjectIntegrity.source.extent, 'cut-off')
      return
    }
    if (mode === 'review-recovery') {
      assert.equal(item.status, 'technical-failed', item.reason)
      assert.equal(first.boundaryReview?.status, 'failed')
      const original = contentDigest(run); failBoundary = false
      const child = z.object({ runId: z.string() }).parse(await f.action('wallpaper-continue', { runId: run.id, operationId: 'recover-final-boundary', retryImage: { imageVersionId: item.imageVersionId, revision: first.revision, step: 'reviewing' } }))
      assert.equal(wallpaperStateSchema.parse(dataOf(f.domain.require('run', child.runId)).checkpoint.wallpaper).items[0]!.attempts.at(-1)!.boundaryReview, undefined)
      await f.jobs.drain()
      const recovered = wallpaperStateSchema.parse(dataOf(f.domain.require('run', child.runId)).checkpoint.wallpaper).items[0]!
      assert.equal(recovered.status, 'passed', recovered.reason)
      assert.equal(generations, 1)
      assert.equal(contentDigest(f.domain.require('run', run.id)), original)
      return
    }
    if (mode === 'budget') {
      assert.equal(item.status, 'needs-review', item.reason)
      assert.equal(item.reason, 'boundary-review-unavailable')
      assert.equal(boundaries, 0); assert.equal(generations, 1)
      return
    }
    assert.equal(item.status, 'passed', item.reason)
    assert.equal(boundaries, 1)
    assert.equal(generations, mode === 'confirmed-overflow' ? 2 : 1)
    assert.equal(finalReviews, generations)
    assert.equal(f.repository.list('selection').length, 1)
    if (mode === 'confirmed-overflow') {
      assert.equal(wallpaperVerdict(first.postResolutionReview!.review!), 'reject')
      const latest = item.attempts.at(-1)!
      assert.equal(latest.layoutCorrection?.version, 'candidate-placement-v1')
      assert.equal(latest.preResolutionReview!.nativeId, latest.generatedImageId)
      assert.notEqual(latest.nativeReviewCandidate!.nativeDigest, first.nativeReviewCandidate!.nativeDigest)
    } else assert.ok(first.postResolutionReview!.review && 'criticalDetail' in first.postResolutionReview!.review && first.postResolutionReview!.review.criticalDetail)
  } finally { await f.cleanup(); await context.fiber.dispose() }
})
