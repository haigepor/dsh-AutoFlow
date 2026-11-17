/** Practical acceptance exercises real Host actions, saved pixels and bounded corrective work. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import sharp from 'sharp'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import LlmRuntime, { type ImageGenerationTask, type ImageGenerationTaskId } from '@deepseek-ai/dsh-llm'
import LocalAttachmentStore from '../../../../packages/attachment/attachment-local/src/index.ts'
import { contentDigest } from '../src/domain/repository.ts'
import { dataOf, specOf, toJson } from '../src/host/runtime.ts'
import { MediaError } from '../src/media/errors.ts'
import { claritySettingsSchema } from '../src/shared/clarity.ts'
import { backgroundResolutionSettingsSchema } from '../src/shared/background-resolution.ts'
import { resolveWallpaperProcessing, wallpaperRepairPolicySchema } from '../src/shared/wallpaper-policy.ts'
import { wallpaperStateSchema, wallpaperSettingsSchema, wallpaperStoredSourceReviewV4Schema } from '../src/shared/wallpaper.ts'
import { runSchema } from '../src/shared/model.ts'
import { serviceFixture } from './helpers/service-fixture.ts'

type Outcome = 'minor' | 'major' | 'unknown' | 'pass' | 'coarse-layout' | 'missing-primary' | 'car-outside'
const receipt = z.object({ runId: z.string() })
const bodyRect = { x: 0.25, y: 0.4, width: 0.45, height: 0.32 }

async function workflow(t: TestContext, outcomes: Outcome[], lowOfficialResolution = false, correctCompanion = false, holdSuccessfulReceipt = false, holdInitialPlan = false, referenceCase: 'bird' | 'large-jpeg' | 'automobile' = 'bird') {
  const f = await serviceFixture(undefined, referenceCase === 'large-jpeg' ? { maxImportBytes: 20 * 1024 * 1024, maxReferenceBytes: 20 * 1024 * 1024, maxPixels: 80_000_000, previewMaxDimension: 512 } : {})
  const context = new Context(), llm = new LlmRuntime(context), attachments = new LocalAttachmentStore(context, { dshHome: f.root })
  const submittedImages: { mediaType: string; bytes: number; digest: string }[] = [], savedReferences: { originalDimensions?: { width: number; height: number } }[] = []
  const saveImages = attachments.saveImages.bind(attachments)
  attachments.saveImages = async inputs => {
    submittedImages.push(...inputs.map(input => ({ mediaType: input.mediaType, bytes: input.data.byteLength, digest: createHash('sha256').update(input.data).digest('hex') })))
    const references = await saveImages(inputs)
    savedReferences.push(...references)
    return references
  }
  t.after(async () => { try { await f.cleanup() } finally { await context.fiber.dispose() } })
  f.host.llm = llm; f.host.attachments = attachments
  f.service.config.wallpaper.processing = resolveWallpaperProcessing()
  f.service.config.wallpaper.repairPolicy = wallpaperRepairPolicySchema.parse({})
  f.service.config.wallpaper.imageProvider = lowOfficialResolution ? 'visual-curator-openai' : 'isolated-practical-images'
  f.service.config.wallpaper.imageModel = 'isolated-model'
  f.service.config.wallpaper.decision = { version: 'wallpaper-decision-v1', enabled: false, maxRoundsPerImage: 2, maxDetailRequests: 1 }
  f.service.config.wallpaper.clarity = claritySettingsSchema.parse({ enabled: false })
  f.service.config.wallpaper.backgroundResolution = backgroundResolutionSettingsSchema.parse({ enabled: false })
  let source: Buffer
  if (referenceCase === 'large-jpeg') {
    const pixels = Buffer.alloc(6000 * 3000 * 3)
    let seed = 0x13579bdf
    for (let index = 0; index < pixels.length; index++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels[index] = seed >>> 24 }
    source = await sharp(pixels, { raw: { width: 6000, height: 3000, channels: 3 } }).withMetadata({ orientation: 6 }).jpeg({ quality: 80 }).toBuffer()
  } else source = await sharp({ create: { width: 1000, height: 1600, channels: 3, background: '#c9d4ca' } }).png().toBuffer()
  const path = join(f.root, 'bird-original.png'); await writeFile(path, source)
  const tasks = new Map<string, ImageGenerationTask>(), generated: Buffer[] = [], reviews: string[] = [], reviewRequests: { requestId: string; roles: string[] }[] = []
  let plans = 0
  let confirmationArrival: (() => void) | undefined
  llm.getImageGeneration = async handle => {
    const task = tasks.get(handle.id)
    if (!task) throw Object.assign(new Error('This isolated provider has no saved receipt.'), { code: 'IMAGE_GENERATION_NOT_FOUND' })
    if (holdSuccessfulReceipt) throw new MediaError('remote-timeout', 'wallpaper-edit', true, 'The completed image receipt is temporarily unavailable.', 'Retry the saved receipt after the provider recovers.')
    return task
  }
  llm.startImageGeneration = async request => {
    const subject = await sharp({ create: { width: 800, height: 1000, channels: 3, background: '#b89658' } }).png().toBuffer()
    const full = await sharp({ create: { width: 1845, height: 3280, channels: 3, background: generated.length ? '#507260' : '#456b55' } }).composite([{ input: subject, left: 480, top: 1350 }]).png().toBuffer()
    const pixels = lowOfficialResolution ? await sharp(full).resize(936, 1664).png().toBuffer() : full
    generated.push(pixels)
    const original = await attachments.saveFile({ data: pixels, name: 'complete-provider-canvas.png' })
    const [preview] = await attachments.saveImages([{ data: pixels, mediaType: 'image/png' }]); assert.ok(preview)
    const task: ImageGenerationTask = { id: request.id, provider: request.provider, model: request.model, taskId: brandString<ImageGenerationTaskId>('isolated-practical-' + generated.length), state: 'succeeded', images: [{ original, preview }] }
    tasks.set(request.id, task)
    return task
  }
  const send = f.http.request.bind(f.http)
  f.http.request = async (url, request) => {
    if (!url.startsWith('https://vision.example.test')) return send(url, request)
    const messages = z.object({ messages: z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ text: z.string().optional() }).passthrough())]) })) }).parse(JSON.parse(Buffer.from(request.body!).toString('utf8'))).messages
    const content = messages.find(message => message.role === 'user')!.content; assert.ok(Array.isArray(content))
    const descriptor = z.object({ input: z.object({ operation: z.string(), requestId: z.string(), images: z.array(z.object({ imageVersionId: z.string(), role: z.string() })) }), outputSchema: z.object({ properties: z.record(z.string(), z.unknown()), $defs: z.record(z.string(), z.unknown()).optional() }) }).parse(JSON.parse(content[0]!.text!))
    const input = descriptor.input, original = input.images.find(image => image.role === 'wallpaper-original'); assert.ok(original)
    let output: object
    if (input.operation === 'wallpaper-plan') {
      plans++
      const rect = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }
      output = { version: 1, imageVersionId: original.imageVersionId, mode: 'single', subject: 'Bird', evidence: 'One main bird is visible.', priorities: [], anchors: ['Soft natural woodland background.'], truncations: [], uncertainties: [],
        objectRoles: [{ entityId: 'bird', name: 'Bird', role: 'primary', safetyClass: referenceCase === 'automobile' ? 'automobile' : 'general', evidence: 'The visible main subject is the focal object.', rect, sourceEdges: [] }], regions: [{ entityId: 'bird', name: 'Bird body', role: 'subject', rect }], reason: 'Keep the main subject prominent below the upper band.', editPrompt: 'Extend the original soft woodland light and natural foliage around the focal subject.' }
      if (correctCompanion && plans > 1) output = { ...output, mode: 'group', objectRoles: [
        { entityId: 'bird', name: 'Bird', role: 'primary', safetyClass: 'general', evidence: 'One of two co-focal foreground birds.', rect, sourceEdges: [] },
        { entityId: 'companion', name: 'Companion bird', role: 'primary', safetyClass: 'general', evidence: 'The smaller companion independently participates in the portrait.', rect: { x: 0.1, y: 0.4, width: 0.25, height: 0.3 }, sourceEdges: [] },
      ], regions: [{ entityId: 'bird', name: 'Bird body', role: 'subject', rect }, { entityId: 'companion', name: 'Companion body', role: 'subject', rect: { x: 0.1, y: 0.4, width: 0.25, height: 0.3 } }] }
      if (holdInitialPlan) output = { ...output, mode: plans === 1 ? 'uncertain' : 'group', objectRoles: [
        { entityId: 'bird', name: 'Main bird', role: 'primary', safetyClass: 'general', evidence: 'One source co-primary.', rect: { x: 0.25, y: 0.1, width: 0.35, height: 0.6 }, sourceEdges: [] },
        { entityId: 'companion', name: 'Companion bird', role: 'primary', safetyClass: 'general', evidence: 'A second source co-primary.', rect: { x: 0.1, y: 0.35, width: 0.25, height: 0.35 }, sourceEdges: [] },
        { entityId: 'jelly', name: 'Fruit jelly', role: 'primary', safetyClass: 'general', evidence: 'A small independently featured co-primary.', rect: { x: 0.65, y: 0.65, width: 0.2, height: 0.2 }, sourceEdges: [] },
      ], regions: [
        { entityId: 'bird', name: 'Main bird body', role: 'subject', rect: { x: 0.25, y: 0.1, width: 0.35, height: 0.6 } },
        { entityId: 'companion', name: 'Companion body', role: 'subject', rect: { x: 0.1, y: 0.35, width: 0.25, height: 0.35 } },
        { entityId: 'jelly', name: 'Fruit jelly body', role: 'subject', rect: { x: 0.65, y: 0.65, width: 0.2, height: 0.2 } },
      ] }
    } else {
      assert.equal(input.operation, 'wallpaper-review', 'No extra analysis or decision request is needed')
      const protocol = z.union([z.object({ const: z.string() }), z.object({ $ref: z.string() })]).parse(descriptor.outputSchema.properties.protocol)
      assert.equal('const' in protocol ? protocol.const : z.object({ const: z.string() }).parse(descriptor.outputSchema.$defs?.[protocol.$ref.slice('#/$defs/'.length)]).const, 'practical-v1')
      assert.equal(descriptor.outputSchema.properties.checks, undefined)
      const instructions = messages.flatMap(message => typeof message.content === 'string' ? [message.content] : message.content.flatMap(part => part.text ? [part.text] : [])).join('\n')
      assert.equal(instructions.includes('checks严格只有八项'), false)
      assert.equal(instructions.includes('subjectIntegrity必须'), false)
      const roles = input.images.map(image => image.role)
      if (input.requestId.endsWith(':layout-confirm')) assert.deepEqual([...roles].sort(), ['actual-wallpaper', 'wallpaper-layout-only', 'wallpaper-original'])
      else assert.deepEqual(roles, ['actual-wallpaper', 'wallpaper-original'])
      reviewRequests.push({ requestId: input.requestId, roles })
      const actual = input.images.find(image => image.role === 'actual-wallpaper'); assert.ok(actual)
      reviews.push(actual.imageVersionId)
      if (input.requestId.endsWith(':layout-confirm') && confirmationArrival) {
        const arrived = confirmationArrival; confirmationArrival = undefined; arrived()
        const signal = request.signal; assert.ok(signal)
        await new Promise<never>((_resolve, reject) => {
          const aborted = () => reject(signal.reason)
          signal.addEventListener('abort', aborted, { once: true })
          if (signal.aborted) aborted()
        })
      }
      const outcome = outcomes.shift(); assert.ok(outcome, 'Every actual review has one explicitly scripted observation')
      output = { reviewVersion: 'wallpaper-review-source-v4', protocol: 'practical-v1', sourceImageVersionId: original.imageVersionId, outputImageVersionId: actual.imageVersionId, mode: 'single', subject: 'Bird', actualLayout: { regions: [{ entityId: 'bird', name: 'Bird body', role: 'subject', scope: 'core', safetyClass: 'general', rect: outcome === 'car-outside' ? { x: 0.1, y: 0.44, width: 0.8, height: 0.2 } : outcome === 'coarse-layout' ? { ...bodyRect, x: 0.465, width: 0.49 } : bodyRect }] },
        defects: outcome === 'minor' ? [{ kind: 'style-change', severity: 'minor', reason: 'Natural added leaves remain consistent with the woodland style.' }] : outcome === 'major' ? [{ kind: 'duplicate-subject', severity: 'major', reason: 'An extra independent bird duplicates the focal subject.', outputRect: { x: 0.7, y: 0.55, width: 0.2, height: 0.2 } }] : [],
        uncertainties: outcome === 'unknown' ? ['The eye detail cannot be confirmed from the available final pixels.'] : [] }
      if (correctCompanion && plans > 1) output = { ...output, mode: 'group', actualLayout: { regions: [
        { entityId: 'bird', name: 'Bird body', role: 'subject', scope: 'core', rect: bodyRect },
        ...(outcome === 'missing-primary' ? [] : [{ entityId: 'companion', name: 'Companion body', role: 'subject', scope: 'core', rect: { x: 0.15, y: 0.55, width: 0.25, height: 0.2 } }]),
      ] } }
      if (holdInitialPlan) output = { ...output, mode: 'group', actualLayout: { regions: [
        { entityId: 'bird', name: 'Main bird body', role: 'subject', scope: 'core', rect: bodyRect },
        { entityId: 'companion', name: 'Companion body', role: 'subject', scope: 'core', rect: { x: 0.15, y: 0.55, width: 0.25, height: 0.2 } },
        { entityId: 'jelly', name: 'Fruit jelly body', role: 'subject', scope: 'core', rect: { x: 0.57, y: 0.68, width: 0.16, height: 0.1 } },
      ] } }
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] })) }
  }
  await f.service.initialize()
  const start = async (waitForCompletion = true) => {
    const { runId } = receipt.parse(await f.action('direct-crop-start', { operationId: 'isolated-practical-start', name: 'Practical woodland wallpaper', source: { kind: 'local', files: [{ path, name: 'bird-original.png' }] } }))
    if (waitForCompletion) await f.jobs.drain()
    return runId
  }
  const state = (runId: string) => wallpaperStateSchema.parse(dataOf(f.domain.require('run', runId)).checkpoint.wallpaper)
  const diagnostics = () => JSON.stringify(f.repository.list('request').map(row => ({ state: row.state, diagnostics: z.object({ diagnostics: z.unknown().optional() }).parse(row.data).diagnostics })))
  const holdNextConfirmation = () => {
    const arrived = Promise.withResolvers<void>()
    confirmationArrival = arrived.resolve
    return arrived.promise
  }
  return { f, start, state, generated, tasks, reviews, reviewRequests, outcomes, plans: () => plans, diagnostics, releaseReceipt: () => { holdSuccessfulReceipt = false }, holdNextConfirmation, source, submittedImages, savedReferences }
}

test('practical minor natural-background variation gets one final compact review after normal official-image resizing', async t => {
  const w = await workflow(t, ['minor'], true), runId = await w.start()
  const run = w.f.domain.require('run', runId), item = w.state(runId).items[0]!, attempt = item.attempts.at(-1)!
  assert.equal(item.status, 'passed', JSON.stringify({ reason: item.reason, code: item.errorCode, step: item.failedStep, generations: w.generated.length, attempts: item.attempts.map(row => ({ checks: row.checks, generatedImageId: row.generatedImageId, outputId: row.outputId, generationFailure: row.generationFailure })) }) + w.diagnostics())
  assert.equal(w.generated.length, 1); assert.equal(w.reviews.length, 1); assert.equal(w.plans(), 1)
  assert.equal(w.f.jobs.hooks.length, 1)
  assert.equal(attempt.preResolutionReview, undefined); assert.equal(attempt.backgroundResolution, undefined)
  const frozen = wallpaperSettingsSchema.parse(specOf(run).fixed.wallpaper)
  assert.equal(frozen.clarity?.enabled, false); assert.equal(frozen.backgroundResolution?.enabled, false)
  assert.ok(attempt.outputId)
  const final = w.f.domain.require('imageVersion', attempt.outputId), bytes = await w.f.files.read(final.blob)
  assert.deepEqual(final.geometry, { ...final.geometry, width: 1845, height: 3280 })
  assert.equal((await sharp(w.generated[0]!).metadata()).width, 936)
  const expected = await sharp(w.generated[0]!).resize(1845, 3280, { fit: 'fill' }).toColourspace('srgb').raw().toBuffer()
  assert.deepEqual(await sharp(bytes).raw().toBuffer(), expected)
  assert.ok(attempt.review && 'practicalReview' in attempt.review && attempt.review.practicalReview?.warnings.some(reason => reason.includes('Natural added leaves')))
})

test('a JPEG whose normalized PNG exceeds the upload limit retains its verbatim reference and EXIF framing', async t => {
  const w = await workflow(t, ['pass'], false, false, false, false, 'large-jpeg'), runId = await w.start()
  const item = w.state(runId).items[0]!, attempt = item.attempts.at(-1)!
  assert.equal(item.status, 'passed', item.reason + w.diagnostics())
  const source = w.f.domain.require('imageVersion', item.originalId!), asset = w.f.domain.require('asset', source.assetId)
  assert.ok(asset.originalBlob); assert.ok(attempt.canvasId)
  assert.ok(source.blob.byteLength > w.f.files.limits.maxFileBytes, 'The saved lossless PNG must reproduce the real oversized intermediate')
  assert.ok(w.source.byteLength < w.f.files.limits.maxFileBytes)
  assert.equal(w.f.domain.require('imageVersion', attempt.canvasId).blob.digest, asset.originalBlob.digest)
  assert.deepEqual(w.submittedImages.find(image => image.mediaType === 'image/jpeg'), { mediaType: 'image/jpeg', bytes: w.source.byteLength, digest: createHash('sha256').update(w.source).digest('hex') })
  assert.deepEqual(w.savedReferences.find(reference => reference.originalDimensions)?.originalDimensions, { width: 3000, height: 6000 })
  assert.equal(w.generated.length, 1); assert.equal(w.reviews.length, 1)
  await assert.rejects(w.f.files.importBytes(await w.f.files.read(source.blob)), /configured import limit/)
  assert.deepEqual(await w.f.files.read(asset.originalBlob), w.source, 'The archived original must remain unchanged')
})

test('a frozen automobile cannot use a reviewer general label to pass overflow and receives one correction', async t => {
  const w = await workflow(t, ['car-outside', 'car-outside', 'pass'], false, false, false, false, 'automobile'), runId = await w.start()
  const item = w.state(runId).items[0]!, failed = wallpaperStoredSourceReviewV4Schema.parse(item.attempts[0]!.review)
  assert.equal(item.status, 'passed', item.reason + w.diagnostics())
  assert.equal(w.generated.length, 2); assert.equal(w.reviews.length, 3); assert.equal(w.plans(), 1)
  assert.equal(failed.actualLayout.regions[0]!.safetyClass, 'automobile')
  assert.ok(failed.layoutChecks.some(check => check.startsWith('automobile-outside:')))
  assert.equal(item.attempts.length, 2)
  assert.equal(item.attempts[0]!.boundaryReview?.status, 'completed')
})

test('one major duplicate is corrected inside the same job with exactly two generations and final reviews', async t => {
  const w = await workflow(t, ['major', 'pass']), runId = await w.start()
  const item = w.state(runId).items[0]!
  assert.equal(item.status, 'passed', item.reason)
  assert.equal(w.generated.length, 2); assert.equal(w.reviews.length, 2); assert.equal(w.f.jobs.hooks.length, 1)
  assert.equal(item.edits, 2)
  const settings = wallpaperSettingsSchema.parse(specOf(w.f.domain.require('run', runId)).fixed.wallpaper)
  assert.equal(settings.maxEditsPerImage, 2); assert.equal(settings.maxReworks, 1)
  assert.equal(item.attempts.length, 2)
  assert.ok(item.attempts[0]!.review?.issues.some(issue => issue.reason.includes('extra independent bird')))
  assert.ok(item.attempts.at(-1)!.outputId)
  assert.equal(w.f.domain.require('imageVersion', item.attempts.at(-1)!.outputId!).geometry.width, 1845)
})

test('a layout contradiction receives one guided coordinate confirmation without regenerating a healthy output', async t => {
  const w = await workflow(t, ['coarse-layout', 'pass']), runId = await w.start()
  const item = w.state(runId).items[0]!, attempt = item.attempts.at(-1)!
  assert.equal(item.status, 'passed', item.reason + w.diagnostics())
  assert.equal(w.generated.length, 1); assert.equal(w.reviews.length, 2); assert.equal(item.edits, 1)
  assert.equal(item.attempts.length, 1); assert.equal(w.f.jobs.hooks.length, 1)
  assert.equal(w.reviews[0], w.reviews[1], 'The confirmation examines the same saved output pixels')
  assert.equal(w.reviewRequests[0]!.requestId.endsWith(':layout-confirm'), false)
  assert.equal(w.reviewRequests[1]!.requestId.endsWith(':layout-confirm'), true)
  assert.ok(w.reviewRequests[1]!.roles.includes('wallpaper-layout-only'))
  assert.ok(attempt.boundaryReview)
  assert.equal(attempt.boundaryReview.status, 'completed')
  assert.equal(attempt.boundaryReview.requestId, w.reviewRequests[1]!.requestId)
  assert.ok(attempt.review && 'actualLayout' in attempt.review)
  assert.deepEqual(attempt.review.actualLayout.regions[0]!.rect, bodyRect)
})

test('unconfirmed focal detail keeps the generated pixels for review without another image request', async t => {
  const w = await workflow(t, ['unknown']), runId = await w.start()
  const item = w.state(runId).items[0]!
  assert.equal(item.status, 'needs-review', item.reason)
  assert.equal(w.generated.length, 1); assert.equal(w.reviews.length, 1); assert.equal(item.edits, 1)
  assert.equal(item.attempts.length, 1)
  assert.ok(item.attempts[0]!.outputId)
  assert.ok(item.attempts[0]!.review && 'practicalReview' in item.attempts[0]!.review && item.attempts[0]!.review.practicalReview?.uncertainties.length === 1)
})

test('a persistent major duplicate stops after the single permitted correction and retains both outputs', async t => {
  const w = await workflow(t, ['major', 'major']), runId = await w.start()
  const item = w.state(runId).items[0]!
  assert.equal(item.status, 'needs-review', item.reason)
  assert.equal(w.generated.length, 2); assert.equal(w.reviews.length, 2); assert.equal(item.edits, 2)
  assert.equal(item.attempts.length, 2)
  for (const attempt of item.attempts) assert.ok(attempt.outputId)
})

test('explicit practical current reevaluates a cancelled batch using its earliest complete output without regenerating or rewriting its parent', async t => {
  const w = await workflow(t, ['major', 'unknown']), parentId = await w.start()
  const original = w.state(parentId).items[0]!, first = original.attempts[0]!
  assert.equal(original.status, 'needs-review'); assert.equal(w.generated.length, 2)
  assert.ok(first.outputId); assert.notEqual(first.outputId, original.attempts.at(-1)!.outputId)
  await w.f.action('wallpaper-control', { runId: parentId, command: 'cancel' })
  await w.f.jobs.drain()
  const parent = w.f.domain.require('run', parentId), parentDigest = contentDigest(parent), parentState = w.state(parentId), parentCounts = structuredClone(dataOf(parent).counts)
  assert.equal(parent.status, 'cancelled')
  const firstImage = w.f.domain.require('imageVersion', first.outputId), firstBytes = Buffer.from(await w.f.files.read(firstImage.blob))
  w.outcomes.push('pass')
  const childId = receipt.parse(await w.f.action('wallpaper-continue', { runId: parentId, operationId: 'explicit-practical-current', practical: 'current' })).runId
  await w.f.jobs.drain()
  const child = w.state(childId).items[0]!, latest = child.attempts.at(-1)!
  assert.equal(child.status, 'passed', JSON.stringify({ reason: child.reason, code: child.errorCode, step: child.failedStep, reviews: w.reviews, latest: { checks: latest.checks, outputId: latest.outputId } }) + w.diagnostics())
  assert.equal(latest.outputId, first.outputId)
  assert.equal(w.reviews.at(-1), first.outputId)
  assert.equal(w.generated.length, 2, 'Reevaluation must never call startImageGeneration')
  assert.equal(child.edits, original.edits)
  assert.deepEqual(child.attempts.slice(0, original.attempts.length), parentState.items[0]!.attempts)
  assert.equal(contentDigest(w.f.domain.require('run', parentId)), parentDigest)
  assert.deepEqual(dataOf(w.f.domain.require('run', parentId)).counts, parentCounts)
  assert.deepEqual(await w.f.files.read(firstImage.blob), firstBytes)
})

test('current practical adoption reidentifies co-focal source subjects before reviewing the same saved output', async t => {
  const w = await workflow(t, ['pass'], false, true), parentId = await w.start()
  const parent = w.f.domain.require('run', parentId), digest = contentDigest(parent), first = w.state(parentId).items[0]!.attempts[0]!
  assert.equal(first.plan.mode, 'single'); assert.equal(w.plans(), 1)
  w.outcomes.push('pass')
  const childId = receipt.parse(await w.f.action('wallpaper-continue', { runId: parentId, operationId: 'current-co-focal-source', practical: 'current' })).runId
  await w.f.jobs.drain()
  const item = w.state(childId).items[0]!, latest = item.attempts.at(-1)!
  assert.equal(item.status, 'passed', item.reason + w.diagnostics())
  assert.equal(w.plans(), 2); assert.equal(w.generated.length, 1)
  assert.equal(latest.outputId, first.outputId); assert.equal(latest.plan.mode, 'group')
  assert.deepEqual(latest.plan.objectRoles?.filter(row => row.role === 'primary').map(row => row.entityId), ['bird', 'companion'])
  assert.ok(latest.review && 'actualLayout' in latest.review)
  assert.deepEqual(wallpaperStoredSourceReviewV4Schema.parse(latest.review).actualLayout.regions.filter(row => row.role === 'subject' && row.scope === 'core').map(row => row.entityId), ['bird', 'companion'])
  assert.equal(contentDigest(w.f.domain.require('run', parentId)), digest)
})

test('a compact response omitting a frozen primary retains the saved output as a format failure without another generation', async t => {
  const w = await workflow(t, ['pass'], false, true), parentId = await w.start()
  const parent = w.f.domain.require('run', parentId), parentDigest = contentDigest(parent), original = w.state(parentId).items[0]; assert.ok(original)
  const first = original.attempts[0]; assert.ok(first)
  assert.equal(original.status, 'passed'); assert.ok(first.outputId)
  const savedImage = w.f.domain.require('imageVersion', first.outputId), savedBytes = Buffer.from(await w.f.files.read(savedImage.blob))
  w.outcomes.push('missing-primary')
  const childId = receipt.parse(await w.f.action('wallpaper-continue', { runId: parentId, operationId: 'current-missing-primary-evidence', practical: 'current' })).runId
  await w.f.jobs.drain()
  const child = w.state(childId).items[0]; assert.ok(child)
  const latest = child.attempts.at(-1); assert.ok(latest)
  assert.equal(child.status, 'technical-failed', child.reason + w.diagnostics())
  assert.equal(child.failedStep, 'reviewing'); assert.equal(child.errorCode, 'vision-invalid-output')
  assert.equal(latest.outputId, first.outputId); assert.equal(w.reviews.at(-1), first.outputId)
  assert.equal(latest.review, undefined, 'A missing primary rectangle is not an invented image-quality verdict')
  assert.equal(w.generated.length, 1, 'Malformed review evidence cannot dispatch another paid image request')
  assert.equal(child.edits, original.edits); assert.equal(w.plans(), 2); assert.equal(w.reviews.length, 2)
  assert.deepEqual(child.attempts.slice(0, original.attempts.length), original.attempts)
  assert.equal(contentDigest(w.f.domain.require('run', parentId)), parentDigest)
  assert.deepEqual(await w.f.files.read(savedImage.blob), savedBytes)
})

test('practical current appends a receipt recovery attempt and preserves all saved history without paying for another image', async t => {
  const w = await workflow(t, ['pass'], false, false, true), parentId = await w.start()
  const original = w.state(parentId).items[0]; assert.ok(original)
  const savedAttempt = original.attempts.at(-1); assert.ok(savedAttempt)
  assert.equal(original.status, 'technical-failed', original.reason + w.diagnostics())
  assert.equal(original.failedStep, 'rendering'); assert.equal(original.errorCode, 'remote-timeout')
  assert.equal(savedAttempt.outputId, undefined); assert.equal(savedAttempt.generatedImageId, undefined)
  assert.ok(savedAttempt.generation); assert.ok(savedAttempt.generationOperation)
  assert.equal(w.tasks.get(savedAttempt.generation.id)?.state, 'succeeded', 'The paid provider result already exists before continuation')
  assert.equal(w.generated.length, 1); assert.equal(w.reviews.length, 0); assert.equal(original.edits, 1)
  const parent = w.f.domain.require('run', parentId), parentDigest = contentDigest(parent), parentCounts = structuredClone(dataOf(parent).counts)
  w.releaseReceipt()
  const childId = receipt.parse(await w.f.action('wallpaper-continue', { runId: parentId, operationId: 'current-saved-successful-receipt', practical: 'current' })).runId
  await w.f.jobs.drain()
  const child = w.state(childId).items[0]; assert.ok(child)
  const latest = child.attempts.at(-1); assert.ok(latest)
  assert.equal(child.status, 'passed', child.reason + w.diagnostics())
  assert.equal(child.attempts.length, original.attempts.length + 1)
  assert.deepEqual(child.attempts.slice(0, original.attempts.length), original.attempts, 'Recovery appends rather than modifying an inherited attempt')
  assert.equal(latest.revision, savedAttempt.revision + 1)
  assert.deepEqual(latest.generation, savedAttempt.generation); assert.equal(latest.generationOperation, savedAttempt.generationOperation)
  assert.deepEqual(latest.generationInput, savedAttempt.generationInput)
  assert.ok(latest.outputId); assert.equal(child.edits, original.edits)
  assert.equal(w.generated.length, 1, 'The successful saved receipt must not call startImageGeneration again')
  assert.equal(w.reviews.length, 1); assert.equal(w.plans(), 2)
  assert.equal(contentDigest(w.f.domain.require('run', parentId)), parentDigest)
  assert.deepEqual(dataOf(w.f.domain.require('run', parentId)).counts, parentCounts)
})

test('practical correction limits stop persistent defects even when a historical task retains five paid edits', async t => {
  const w = await workflow(t, ['major', 'major'], false, false, true), parentId = await w.start()
  const parent = w.f.domain.require('run', parentId), spec = specOf(parent)
  const historicalSettings = wallpaperSettingsSchema.parse({ ...wallpaperSettingsSchema.parse(spec.fixed.wallpaper), maxEditsPerImage: 5, maxReworks: 5 })
  const fixed = { ...spec.fixed, wallpaper: toJson(historicalSettings) }
  const recorded = runSchema.parse({ ...parent, spec: toJson({ ...spec, fixed, specDigest: contentDigest({ kind: spec.kind, config: spec.config, input: spec.input, fixed }) }) })
  const aggregateId = 'run:' + parentId, manifest = w.f.repository.manifest(aggregateId); assert.ok(manifest)
  await w.f.repository.commit({ aggregateId, expectedRevision: manifest.revision, operationId: 'record-historical-five-edit-budget', request: { maxEditsPerImage: 5, maxReworks: 5 }, records: [recorded], state: { runId: parentId } })
  w.releaseReceipt()
  const childId = receipt.parse(await w.f.action('wallpaper-continue', { runId: parentId, operationId: 'current-bounded-historical-edits', practical: 'current' })).runId
  await w.f.jobs.drain()
  const childRun = w.f.domain.require('run', childId), settings = wallpaperSettingsSchema.parse(specOf(childRun).fixed.wallpaper), child = w.state(childId).items[0]; assert.ok(child)
  assert.equal(settings.maxEditsPerImage, 5); assert.equal(settings.maxReworks, 5)
  assert.equal(settings.processing?.acceptance?.version, 'practical-v2')
  assert.ok(settings.processing?.acceptance?.version === 'practical-v2')
  assert.equal(settings.processing.acceptance.maximumAutomaticCorrections, 1)
  assert.equal(settings.decision?.enabled, false)
  assert.equal(child.status, 'needs-review', child.reason + w.diagnostics())
  assert.equal(w.generated.length, 2, 'The legacy fallback must not spend the third of five available edits')
  assert.equal(child.edits, 2); assert.equal(w.reviews.length, 2)
  assert.equal(w.outcomes.length, 0)
})

test('pausing a layout confirmation resumes the same saved output without replanning or regenerating it', { timeout: 60_000 }, async t => {
  const w = await workflow(t, ['coarse-layout', 'pass'])
  const confirmationArrived = w.holdNextConfirmation(), runId = await w.start(false)
  await confirmationArrived
  const pending = w.state(runId).items[0]; assert.ok(pending)
  const pendingAttempt = pending.attempts.at(-1); assert.ok(pendingAttempt?.outputId)
  assert.ok(pendingAttempt.boundaryReview)
  assert.equal(pendingAttempt.boundaryReview?.status, 'pending')
  const outputId = pendingAttempt.outputId, confirmationId = pendingAttempt.boundaryReview.requestId
  assert.equal(pendingAttempt.review?.checks.protection.result, 'violated', 'The interrupted confirmation retains its provisional geometry failure')
  await w.f.action('wallpaper-control', { runId, command: 'pause' })
  await w.f.jobs.drain()
  assert.equal(w.f.domain.require('run', runId).status, 'paused')
  assert.equal(w.generated.length, 1); assert.equal(w.plans(), 1)
  await w.f.action('wallpaper-control', { runId, command: 'resume' })
  await w.f.jobs.drain()
  const item = w.state(runId).items[0]; assert.ok(item)
  const latest = item.attempts.at(-1); assert.ok(latest)
  assert.equal(item.status, 'passed', item.reason + w.diagnostics())
  assert.equal(item.attempts.length, 1); assert.equal(latest.outputId, outputId)
  assert.equal(w.generated.length, 1, 'A provisional layout failure cannot dispatch another image')
  assert.equal(w.plans(), 1, 'A pending coordinate confirmation cannot start a new source plan')
  assert.equal(item.edits, 1); assert.equal(latest.boundaryReview?.status, 'completed')
  assert.equal(latest.boundaryReview?.requestId, confirmationId)
  assert.deepEqual(w.reviewRequests.filter(request => request.requestId.endsWith(':layout-confirm')).map(request => request.requestId), [confirmationId, confirmationId])
  assert.ok(w.reviews.every(reviewedId => reviewedId === outputId))
  assert.equal(w.outcomes.length, 0)
})

test('old geometry holds append a corrected plan without consuming the first image or its one real automatic correction', async t => {
  const w = await workflow(t, ['major', 'pass'], false, false, false, true), parentId = await w.start()
  const seeded = w.state(parentId), original = seeded.items[0]; assert.ok(original)
  const first = original.attempts[0]; assert.ok(first)
  assert.equal(original.status, 'needs-review'); assert.equal(w.plans(), 1)
  assert.equal(w.generated.length, 0); assert.equal(w.reviews.length, 0); assert.equal(original.edits, 0)
  const failed = { ...structuredClone(first), plan: { ...structuredClone(first.plan), mode: 'group' as const, placement: { scale: 1, left: 0, top: 2400 } }, checks: ['subject-outside-safe:Fruit jelly'] }
  original.attempts = [failed, { ...structuredClone(failed), revision: failed.revision + 1, retryFrom: 'planning', retryTarget: 'planning' }]
  original.reason = 'rework-limit'
  const parent = w.f.domain.require('run', parentId), savedData = dataOf(parent)
  const recorded = runSchema.parse({ ...parent, data: toJson({ ...savedData, checkpoint: { ...savedData.checkpoint, wallpaper: toJson(seeded) } }) })
  const aggregateId = 'run:' + parentId, manifest = w.f.repository.manifest(aggregateId); assert.ok(manifest)
  await w.f.repository.commit({ aggregateId, expectedRevision: manifest.revision, operationId: 'record-legacy-three-subject-layout-hold', request: { failure: 'fixed-bottom-allowance', generatedImages: 0 }, records: [recorded], state: { runId: parentId } })
  const parentDigest = contentDigest(w.f.domain.require('run', parentId)), history = structuredClone(original.attempts)
  const childId = receipt.parse(await w.f.action('wallpaper-continue', { runId: parentId, operationId: 'recover-legacy-geometry-without-planning' })).runId
  await w.f.jobs.drain()
  const child = w.state(childId).items[0]; assert.ok(child)
  assert.equal(child.status, 'passed', child.reason + w.diagnostics())
  assert.deepEqual(child.attempts.slice(0, history.length), history)
  assert.equal(child.attempts.length, history.length + 2, 'Geometry recovery and one actual image correction append distinct attempts')
  const recovered = child.attempts[history.length]; assert.ok(recovered)
  assert.equal(recovered.retryFrom, 'planning'); assert.equal(recovered.retryTarget, 'rendering')
  assert.deepEqual(recovered.checks, []); assert.ok(recovered.outputId)
  assert.notDeepEqual(recovered.plan.placement, failed.plan.placement)
  assert.equal(w.plans(), 1, 'A deterministic placement recovery must not request another model plan')
  assert.equal(w.generated.length, 2); assert.equal(w.reviews.length, 2); assert.equal(child.edits, 2)
  const settings = wallpaperSettingsSchema.parse(specOf(w.f.domain.require('run', childId)).fixed.wallpaper)
  assert.equal(settings.maxReworks, 1, 'Historical planning attempts cannot exhaust the practical generation correction budget')
  assert.equal(contentDigest(w.f.domain.require('run', parentId)), parentDigest)
  assert.equal(w.outcomes.length, 0)
})
