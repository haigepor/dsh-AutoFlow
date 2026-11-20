/** Practical acceptance exercises real Host actions, saved pixels and bounded corrective work. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import sharp from 'sharp'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import LlmRuntime, { type ImageGenerationRequest, type ImageGenerationTask, type ImageGenerationTaskId } from '@deepseek-ai/dsh-llm'
import LocalAttachmentStore from '../../../../packages/attachment/attachment-local/src/index.ts'
import { contentDigest } from '../src/domain/repository.ts'
import { dataOf, specOf, toJson } from '../src/host/runtime.ts'
import { MediaError } from '../src/media/errors.ts'
import { wallpaperGeometry } from '../src/shared/wallpaper-geometry.ts'
import { claritySettingsSchema } from '../src/shared/clarity.ts'
import { backgroundResolutionSettingsSchema } from '../src/shared/background-resolution.ts'
import { resolveWallpaperProcessing, wallpaperProcessingSchema, wallpaperRepairPolicySchema } from '../src/shared/wallpaper-policy.ts'
import { wallpaperStateSchema, wallpaperSettingsSchema, wallpaperStoredSourceReviewV4Schema, wallpaperViewSchema } from '../src/shared/wallpaper.ts'
import { runSchema } from '../src/shared/model.ts'
import { serviceFixture } from './helpers/service-fixture.ts'
import { wallpaperFixtureResponse } from './helpers/wallpaper-response.ts'

type Outcome = 'minor' | 'major' | 'seam' | 'unknown' | 'pass' | 'coarse-layout' | 'near-layout' | 'relative-layout' | 'near-right-layout' | 'missing-primary' | 'car-outside' | 'car-left-estimate' | 'car-left-measured' | 'high-layout-estimate' | 'high-redraw-with-room'
const receipt = z.object({ runId: z.string() })
const bodyRect = { x: 0.25, y: 0.4, width: 0.45, height: 0.32 }
const legacyPlacement = wallpaperProcessingSchema.parse({ ...resolveWallpaperProcessing(), acceptance: { version: 'practical-v2', expansionReview: { version: 'expansion-first-v1' } } })

async function workflow(t: TestContext, outcomes: Outcome[], lowOfficialResolution = false, correctCompanion = false, holdSuccessfulReceipt = false, holdInitialPlan = false, referenceCase: 'bird' | 'large-jpeg' | 'automobile' | 'attachment-rejected' | 'transparent-subscription' | 'native-seam' | 'isolated-seam' | 'full-span-edge' | 'wide-source-estimate' | 'unknown-source-estimate' | 'wide-abstract' | 'relative-then-edge' = 'bird') {
  let exportDirectory: string
  const f = await serviceFixture(undefined, referenceCase === 'large-jpeg' ? { maxImportBytes: 20 * 1024 * 1024, maxReferenceBytes: 20 * 1024 * 1024, maxPixels: 80_000_000, previewMaxDimension: 512 } : {}, { pickLocalPaths: async () => [exportDirectory] })
  exportDirectory = f.root
  const context = new Context(), llm = new LlmRuntime(context), attachments = new LocalAttachmentStore(context, { dshHome: f.root, ...(referenceCase === 'attachment-rejected' ? { maxImageBytes: 1 } : {}) })
  const submittedImages: { mediaType: string; bytes: number; digest: string }[] = []
  const requests: ImageGenerationRequest[] = []
  const saveImages = attachments.saveImages.bind(attachments)
  attachments.saveImages = async inputs => {
    submittedImages.push(...inputs.map(input => ({ mediaType: input.mediaType, bytes: input.data.byteLength, digest: createHash('sha256').update(input.data).digest('hex') })))
    return saveImages(inputs)
  }
  t.after(async () => { try { await f.cleanup() } finally { await context.fiber.dispose() } })
  f.host.llm = llm; f.host.attachments = attachments
  f.service.config.wallpaper.processing = resolveWallpaperProcessing()
  f.service.config.wallpaper.repairPolicy = wallpaperRepairPolicySchema.parse({})
  f.service.config.wallpaper.imageProvider = lowOfficialResolution ? 'visual-curator-openai' : 'isolated-practical-images'
  f.service.config.wallpaper.imageModel = 'isolated-model'
  f.service.config.wallpaper.decision = { version: 'wallpaper-decision-v1', enabled: false, maxRoundsPerImage: 2, maxDetailRequests: 1 }
  f.service.config.wallpaper.clarity = claritySettingsSchema.parse({ enabled: false })
  const transparentSubscription = referenceCase === 'transparent-subscription'
  const nativeSeam = referenceCase === 'native-seam'
  const isolatedSeam = referenceCase === 'isolated-seam'
  const fullSpanEdge = referenceCase === 'full-span-edge'
  const wideAbstract = referenceCase === 'wide-abstract'
  const relativeThenEdge = referenceCase === 'relative-then-edge'
  const pairedSubjects = [
    { entityId: 'bird', name: 'Bird', rect: { x: 0.13, y: 0.39, width: 0.26, height: 0.37 } },
    { entityId: 'drink', name: 'Drink', rect: { x: 0.6, y: 0.34, width: 0.27, height: 0.42 } },
  ]
  f.service.config.wallpaper.backgroundResolution = backgroundResolutionSettingsSchema.parse({ enabled: transparentSubscription || nativeSeam || wideAbstract })
  let source: Buffer
  if (referenceCase === 'large-jpeg') {
    const pixels = Buffer.alloc(6000 * 3000 * 3)
    let seed = 0x13579bdf
    for (let index = 0; index < pixels.length; index++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels[index] = seed >>> 24 }
    source = await sharp(pixels, { raw: { width: 6000, height: 3000, channels: 3 } }).withMetadata({ orientation: 6 }).jpeg({ quality: 80 }).toBuffer()
  } else source = await sharp({ create: { width: fullSpanEdge ? 1845 : wideAbstract ? 1672 : 1000, height: fullSpanEdge ? 3280 : wideAbstract ? 941 : 1600, channels: 3, background: '#c9d4ca' } }).png().toBuffer()
  const filename = referenceCase === 'large-jpeg' ? 'large-original.jpg' : 'bird-original.png'
  const path = join(f.root, filename); await writeFile(path, source)
  const tasks = new Map<string, ImageGenerationTask>(), generated: Buffer[] = [], reviews: string[] = [], reviewRequests: { requestId: string; roles: string[]; nativeSeamScreen: boolean }[] = []
  let plans = 0
  let confirmationArrival: (() => void) | undefined
  llm.getImageGeneration = async handle => {
    const task = tasks.get(handle.id)
    if (!task) throw Object.assign(new Error('This isolated provider has no saved receipt.'), { code: 'IMAGE_GENERATION_NOT_FOUND' })
    if (holdSuccessfulReceipt) throw new MediaError('remote-timeout', 'wallpaper-edit', true, 'The completed image receipt is temporarily unavailable.', 'Retry the saved receipt after the provider recovers.')
    return task
  }
  llm.startImageGeneration = async request => {
    requests.push(request)
    const subject = await sharp({ create: { width: 800, height: 1000, channels: 3, background: '#b89658' } }).png().toBuffer()
    const incomplete = transparentSubscription && generated.length === 0
    const background = sharp({ create: { width: 1845, height: 3280, channels: incomplete ? 4 : 3, background: incomplete ? '#00000000' : generated.length ? '#507260' : '#456b55' } })
    let layer = { input: subject, left: 480, top: 1350 }
    if (nativeSeam && (!generated.length || outcomes[1] === 'seam') || (isolatedSeam || fullSpanEdge) && !generated.length) {
      const run = f.repository.list('run').find(row => specOf(row).input.workflow === 'wallpaper-direct-v1'); assert.ok(run)
      const item = wallpaperStateSchema.parse(dataOf(run).checkpoint.wallpaper).items[0]; assert.ok(item?.originalId)
      const attempt = item.attempts.at(-1); assert.ok(attempt)
      const settings = wallpaperSettingsSchema.parse(specOf(run).fixed.wallpaper)
      const original = f.domain.require('imageVersion', item.originalId)
      const target = wallpaperGeometry(original.geometry, attempt.plan, settings, settings.sourceIntentPolicy).target
      assert.ok(target.left >= 0 && target.top >= 0 && target.left + target.width <= 1845 && target.top + target.height <= 3280, JSON.stringify(target))
      if (fullSpanEdge) {
        assert.equal(target.left, 0)
        assert.equal(target.width, settings.width)
        assert.ok(target.top > 8)
        const joint = await sharp({ create: { width: target.width, height: settings.height - target.top, channels: 3, background: '#d9babb' } }).png().toBuffer()
        layer = { input: joint, left: target.left, top: target.top }
      } else if (isolatedSeam) {
        const w = Math.floor(target.width / 2), h = Math.floor(target.height * 2 / 3)
        const path = `M0 0C${w} 0 ${w} ${h} 0 ${h}Z`
        const isolated = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><path d="${path}" fill="#d9babb"/></svg>`)
        layer = { input: isolated, left: target.left, top: target.top + 32 }
      } else {
        const stripe = await sharp({ create: { width: target.width, height: target.height, channels: 3, background: '#d9babb' } }).png().toBuffer()
        layer = { input: stripe, left: target.left, top: target.top }
      }
    }
    const full = await (wideAbstract && generated.length ? background : background.composite([layer])).png().toBuffer()
    const pixels = lowOfficialResolution || transparentSubscription || nativeSeam || wideAbstract ? await sharp(full).resize(936, 1664).png().toBuffer() : full
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
    const wire = JSON.parse(content[0]!.text!)
    const descriptor = z.object({ input: z.object({ operation: z.string(), requestId: z.string(), images: z.array(z.object({ imageVersionId: z.string(), role: z.string() })) }), outputSchema: z.object({ properties: z.record(z.string(), z.unknown()), $defs: z.record(z.string(), z.unknown()).optional() }) }).parse(wire)
    const input = descriptor.input, original = input.images.find(image => image.role === 'wallpaper-original'); assert.ok(original)
    const measuredSource = input.requestId.endsWith(':source-and-actual:layout-confirm')
    const safetyCrop = input.requestId.endsWith(':safety-crops')
    const placementCrop = input.requestId.endsWith(':placement-crops-v2')
    const cropOnly = placementCrop || safetyCrop && !descriptor.outputSchema.properties.review
    const measuredRect = { x: 0.18, y: 0.13, width: 0.61, height: 0.51 }
    const sourceEstimate = referenceCase === 'wide-source-estimate' || referenceCase === 'unknown-source-estimate'
    const resolveSchema = (value: unknown): unknown => {
      const reference = z.object({ $ref: z.string().startsWith('#/$defs/') }).safeParse(value)
      return reference.success ? descriptor.outputSchema.$defs?.[reference.data.$ref.slice('#/$defs/'.length)] : value
    }
    const reviewSchema = measuredSource || safetyCrop && !cropOnly ? { ...z.object({ properties: z.record(z.string(), z.unknown()), required: z.array(z.string()).optional() }).parse(resolveSchema(descriptor.outputSchema.properties.review)), $defs: descriptor.outputSchema.$defs } : descriptor.outputSchema
    let output: object
    if (input.operation === 'wallpaper-plan') {
      plans++
      const rect = fullSpanEdge ? { x: 0.25, y: 0.195, width: 0.5, height: 0.42 } : { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }
      output = { version: 1, imageVersionId: original.imageVersionId, mode: 'single', subject: 'Bird', evidence: 'One main bird is visible.', priorities: [], anchors: ['Soft natural woodland background.'], truncations: [], uncertainties: [],
        objectRoles: [{ entityId: 'bird', name: 'Bird', role: 'primary', safetyClass: referenceCase === 'automobile' ? 'automobile' : 'general', evidence: 'The visible main subject is the focal object.', rect, sourceEdges: [] }], regions: [{ entityId: 'bird', name: 'Bird body', role: 'subject', rect }], reason: 'Keep the main subject prominent below the upper band.', editPrompt: 'Extend the original soft woodland light and natural foliage around the focal subject.' }
      if (wideAbstract) output = { ...output, mode: 'abstract', subject: 'Continuous paper ribbons', evidence: 'The full image is a repeating texture.', anchors: ['Overlapping paper ribbons.'], regions: [], objectRoles: [] }
      if (relativeThenEdge) output = { ...output, mode: 'group', subject: 'Bird and drink', evidence: 'Two independent co-primary objects sit next to one another.',
        objectRoles: pairedSubjects.map(subject => ({ ...subject, role: 'primary', safetyClass: 'general', evidence: 'This is one of two co-primary objects.', sourceEdges: [] })),
        regions: pairedSubjects.map(subject => ({ ...subject, role: 'subject' })),
      }
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
      if (cropOnly) assert.deepEqual(Object.keys(reviewSchema.properties), ['boundaryCrops'])
      else assert.equal(z.object({ const: z.string() }).parse(resolveSchema(reviewSchema.properties.protocol)).const, 'practical-v2')
      assert.equal(reviewSchema.properties.checks, undefined)
      const instructions = messages.flatMap(message => typeof message.content === 'string' ? [message.content] : message.content.flatMap(part => part.text ? [part.text] : [])).join('\n')
      assert.equal(instructions.includes('checks严格只有八项'), false)
      assert.equal(instructions.includes('subjectIntegrity必须'), false)
      const roles = input.images.map(image => image.role)
      const edgeConfirmation = input.requestId.endsWith(':actual-edge:layout-confirm')
      if (placementCrop) assert.deepEqual(roles, ['actual-wallpaper', 'wallpaper-original', 'actual-wallpaper-detail-only', 'actual-wallpaper-detail-only'])
      else if (edgeConfirmation || safetyCrop) {
        assert.ok(roles.includes('actual-wallpaper-detail-only'))
        assert.ok(roles.includes('wallpaper-original'))
        assert.ok(instructions.includes('borderlineRegions'))
      } else if (input.requestId.endsWith(':layout-confirm')) assert.deepEqual([...roles].sort(), [
        'actual-wallpaper', ...(instructions.includes('borderlineRegions') ? ['actual-wallpaper-detail-only'] : []), 'wallpaper-layout-only', 'wallpaper-original',
      ])
      else if (nativeSeam || isolatedSeam || fullSpanEdge || wideAbstract) assert.deepEqual(roles.slice(0, 2), ['actual-wallpaper', 'wallpaper-original'])
      else if (transparentSubscription) assert.deepEqual(roles, ['actual-wallpaper', 'wallpaper-original', ...(input.requestId.includes(':final-review:') ? ['wallpaper-native-reference-only'] : [])])
      else assert.deepEqual(roles, ['actual-wallpaper', 'wallpaper-original'])
      reviewRequests.push({ requestId: input.requestId, roles, nativeSeamScreen: instructions.includes('nativeSeamScreen') })
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
      const run = f.repository.list('run').find(row => input.requestId.startsWith(row.id + ':')); assert.ok(run)
      const current = wallpaperStateSchema.parse(dataOf(run).checkpoint.wallpaper).items.find(item => item.originalId === original.imageVersionId)?.attempts.at(-1); assert.ok(current)
      const sourceGeometry = f.domain.require('imageVersion', original.imageVersionId).geometry
      const positioned = (rect: typeof bodyRect) => ({ x: (current.plan.placement.left + rect.x * sourceGeometry.width * current.plan.placement.scale) / 1845, y: (current.plan.placement.top + rect.y * sourceGeometry.height * current.plan.placement.scale) / 3280, width: rect.width * sourceGeometry.width * current.plan.placement.scale / 1845, height: rect.height * sourceGeometry.height * current.plan.placement.scale / 3280 })
      const bird = current.plan.objectRoles?.find(object => object.entityId === 'bird'); assert.ok(bird || wideAbstract)
      const positionedBody = bird ? positioned(sourceEstimate ? measuredRect : bird.rect) : bodyRect
      const carLeft = outcome === 'car-left-estimate' ? 0.135 : 0.145
      const actualRect = outcome === 'car-outside' ? { x: 0.1, y: 0.44, width: 0.8, height: 0.2 }
        : outcome === 'car-left-estimate' || outcome === 'car-left-measured' ? { ...positionedBody, x: carLeft, width: positionedBody.x + positionedBody.width - carLeft }
        : outcome === 'high-layout-estimate' ? { ...positionedBody, y: 0.322, height: 0.34 }
        : outcome === 'high-redraw-with-room' ? { ...positionedBody, y: positionedBody.y + positionedBody.height / 2 - 0.066 - 0.22, height: 0.44 }
        : outcome === 'coarse-layout' ? { ...bodyRect, x: 0.465, width: 0.49 }
        : outcome === 'near-layout' ? { ...positionedBody, x: 258 / 1845 - positionedBody.width * 0.031 } : positionedBody
      output = { reviewVersion: 'wallpaper-review-source-v4', protocol: 'practical-v1', sourceImageVersionId: original.imageVersionId, outputImageVersionId: actual.imageVersionId, mode: wideAbstract ? 'abstract' : 'single', subject: wideAbstract ? 'Continuous paper ribbons' : 'Bird', actualLayout: { regions: bird ? [{ entityId: 'bird', name: 'Bird body', role: 'subject', scope: 'core', safetyClass: 'general', rect: actualRect }] : [] },
        defects: outcome === 'minor' ? [{ kind: 'style-change', severity: 'minor', reason: 'Natural added leaves remain consistent with the woodland style.' }] : outcome === 'major' ? [{ kind: 'duplicate-subject', severity: 'major', reason: 'An extra independent bird duplicates the focal subject.', outputRect: { x: 0.7, y: 0.55, width: 0.2, height: 0.2 } }] : outcome === 'seam' ? [{ kind: 'collage-seam', severity: 'major', reason: 'Paired hard lines visibly cut the scene into a central patch.', outputRect: { x: 0.12, y: 0.29, width: 0.06, height: 0.45 } }] : [],
        uncertainties: outcome === 'unknown' ? ['The eye detail cannot be confirmed from the available final pixels.'] : [] }
      if (relativeThenEdge) output = { ...output, mode: 'group', subject: 'Bird and drink', actualLayout: { regions: pairedSubjects.map(subject => {
        const rect = positioned(subject.rect)
        if (subject.entityId === 'bird') return { ...subject, role: 'subject', scope: 'core', safetyClass: 'general', rect }
        const observed = outcome === 'relative-layout' ? { ...rect, x: rect.x - 175 / 1845 }
          : outcome === 'near-right-layout' ? { ...rect, width: (1587 / 1845 - rect.x) / 0.966 }
          : edgeConfirmation ? { ...rect, width: 1577 / 1845 - rect.x } : rect
        return { ...subject, role: 'subject', scope: 'core', safetyClass: 'general', rect: observed }
      }) } }
      if (correctCompanion && plans > 1 && bird) output = { ...output, mode: 'group', actualLayout: { regions: [
          { entityId: 'bird', name: 'Bird body', role: 'subject', scope: 'core', rect: positioned(bird.rect) },
        ...(outcome === 'missing-primary' ? [] : current.plan.objectRoles?.filter(object => object.entityId === 'companion').map(object => ({ entityId: object.entityId, name: object.name, role: 'subject', scope: 'core', rect: positioned(object.rect) })) ?? []),
      ] } }
      if (holdInitialPlan) output = { ...output, mode: 'group', actualLayout: { regions: [
        ...current.plan.objectRoles?.map(object => ({ entityId: object.entityId, name: object.name, role: 'subject', scope: 'core', rect: positioned(object.rect) })) ?? [],
      ] } }
    }
    const response = wallpaperFixtureResponse(measuredSource ? { ...wire, outputSchema: reviewSchema } : wire, output)
    const data = measuredSource ? { sourceMeasurements: { sourceImageVersionId: original.imageVersionId, measurements: relativeThenEdge
      ? pairedSubjects.map(({ entityId, rect }) => ({ entityId, result: 'measured', rect, reason: 'Only the visible object belongs inside the original rectangle.' })) : referenceCase === 'wide-source-estimate'
      ? [{ entityId: 'bird', result: 'measured', rect: measuredRect, reason: 'Only the visible object belongs inside the original rectangle.' }]
      : [{ entityId: 'bird', result: 'unknown', reason: 'No independent source measurement was scripted.' }] }, review: response } : response
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) }, finish_reason: 'stop' }] })) }
  }
  await f.service.initialize()
  const start = async (waitForCompletion = true) => {
    const { runId } = receipt.parse(await f.action('direct-crop-start', { operationId: 'isolated-practical-start', name: 'Practical woodland wallpaper', source: { kind: 'local', files: [{ path, name: filename }] } }))
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
  return { f, start, state, generated, tasks, requests, reviews, reviewRequests, outcomes, plans: () => plans, diagnostics, releaseReceipt: () => { holdSuccessfulReceipt = false }, holdNextConfirmation, source, submittedImages, attachmentLimit: attachments.imageLimits.maxImageBytes }
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
  assert.deepEqual(await sharp(bytes).raw().toBuffer(), expected, 'The delivered pixels come from the complete provider canvas without restored source pixels')
  assert.equal(attempt.sourceIntentProof, undefined)
  assert.ok(attempt.review && 'practicalReview' in attempt.review && attempt.review.practicalReview?.warnings.some(reason => reason.includes('Natural added leaves')))
})

test('batch recheck keeps the saved output and parent, even when the current quality review blocks it', async t => {
  const w = await workflow(t, ['pass', 'major'], true), runId = await w.start()
  const parent = w.f.domain.require('run', runId), parentDigest = contentDigest(parent)
  const before = w.state(runId).items[0]!
  assert.equal(before.status, 'passed')
  const next = receipt.parse(await w.f.action('wallpaper-continue', { runId, operationId: 'current-saved-batch-recheck', recheckAll: 'current' }))
  await w.f.jobs.drain()
  const after = w.state(next.runId).items[0]!
  assert.equal(after.attempts.at(-1)?.outputId, before.attempts.at(-1)?.outputId)
  assert.equal(after.edits, before.edits)
  assert.notEqual(after.status, 'passed')
  assert.equal(after.attempts.at(-1)?.review?.checks.background.result, 'violated')
  assert.equal(w.requests.length, 1)
  assert.equal(contentDigest(w.f.domain.require('run', runId)), parentDigest)
})

test('unresolved recheck returns to a safe saved output instead of the latest overflowing draft', async t => {
  const w = await workflow(t, ['pass', 'pass'], true)
  w.f.service.config.wallpaper.processing = legacyPlacement
  const runId = await w.start()
  const parent = w.f.domain.require('run', runId), item = w.state(runId).items[0]!
  const older = item.attempts[0]!
  assert.equal(item.status, 'passed')
  assert.ok(older.outputId && older.analysisId && older.analysisId !== older.outputId)
  w.f.service.config.wallpaper.processing = resolveWallpaperProcessing()
  const skip = receipt.parse(await w.f.action('wallpaper-continue', { runId, operationId: 'unresolved-recheck-approved', recheckAll: 'unresolved' }))
  await w.f.jobs.drain()
  assert.equal(w.state(skip.runId).items[0]?.status, 'passed')
  assert.equal(w.state(skip.runId).items[0]?.attempts.length, 1)
  assert.equal(w.reviews.length, 1)

  const seeded = w.state(skip.runId), target = seeded.items[0]!
  const review = wallpaperStoredSourceReviewV4Schema.parse(older.review)
  const reason = 'subject-overflow:Bird'
  const newer = { ...older, revision: older.revision + 1, outputId: older.analysisId, review: { ...review,
    actualLayout: { ...review.actualLayout, imageVersionId: older.analysisId, regions: review.actualLayout.regions.map(region => ({ ...region, rect: { ...region.rect, y: 0.1 } })) },
    checks: { ...review.checks, protection: { result: 'violated' as const, reason } }, layoutChecks: [reason],
    issues: [{ kind: 'layout' as const, check: 'protection' as const, code: 'other' as const, reason }],
  } }
  target.status = 'needs-review'; target.attempts.push(newer)
  const current = w.f.domain.require('run', skip.runId), saved = dataOf(current), aggregateId = 'run:' + skip.runId
  const manifest = w.f.repository.manifest(aggregateId); assert.ok(manifest)
  const recorded = runSchema.parse({ ...current, data: toJson({ ...saved, checkpoint: { ...saved.checkpoint, wallpaper: toJson(seeded) } }) })
  await w.f.repository.commit({ aggregateId, expectedRevision: manifest.revision, operationId: 'record-newer-overflowing-draft', request: { reason }, records: [recorded], state: { runId: skip.runId } })
  const preserved = contentDigest(w.f.domain.require('run', skip.runId))
  const next = receipt.parse(await w.f.action('wallpaper-continue', { runId: skip.runId, operationId: 'unresolved-recheck-history', recheckAll: 'unresolved' }))
  await w.f.jobs.drain()
  const after = w.state(next.runId).items[0]!
  assert.equal(after.status, 'passed')
  assert.equal(after.attempts.at(-1)?.revision, newer.revision + 1)
  assert.equal(after.attempts.at(-1)?.outputId, older.outputId)
  assert.equal(w.reviews.at(-1), older.outputId)
  assert.equal(w.requests.length, 1)
  assert.equal(contentDigest(w.f.domain.require('run', skip.runId)), preserved)
  assert.equal(contentDigest(w.f.domain.require('run', runId)), contentDigest(parent))
})

test('a transparent subscription canvas is archived and corrected before reconstruction or review', async t => {
  const w = await workflow(t, ['pass', 'pass'], false, false, false, false, 'transparent-subscription')
  const item = w.state(await w.start()).items[0]!
  assert.equal(item.status, 'passed', JSON.stringify({ reason: item.reason, code: item.errorCode }) + w.diagnostics())
  assert.equal(w.requests.length, 2)
  assert.equal(w.reviews.length, 2)
  assert.equal(item.attempts.length, 2)
  const [incomplete, corrected] = item.attempts
  assert.ok(incomplete?.generatedImageId)
  assert.deepEqual(incomplete.checks, ['generated-canvas-transparent'])
  assert.equal(incomplete.backgroundResolution, undefined)
  assert.equal(incomplete.outputId, undefined)
  const archived = w.f.domain.require('imageVersion', incomplete.generatedImageId)
  assert.equal((await sharp(await w.f.files.read(archived.blob)).stats()).isOpaque, false)
  assert.ok(corrected?.backgroundResolution?.enhancedId)
  assert.equal(corrected.preResolutionReview?.nativeId, w.reviews[0])
  assert.equal(corrected.outputId, w.reviews[1])
})

test('confirmed rectangular seams stop native candidates before super-resolution', async t => {
  const w = await workflow(t, ['seam', 'seam'], false, false, false, false, 'native-seam')
  const item = w.state(await w.start()).items[0]!
  assert.equal(item.status, 'needs-review', JSON.stringify({ reason: item.reason, code: item.errorCode, reviews: w.reviewRequests }) + w.diagnostics())
  assert.equal(w.requests.length, 2)
  assert.equal(w.reviews.length, 2)
  assert.ok(w.reviewRequests[0]?.nativeSeamScreen)
  assert.deepEqual(w.requests.map(request => [request.references.length, !!request.mask]), [[1, false], [1, false]])
  assert.deepEqual([w.requests[1]?.references[0]?.width, w.requests[1]?.references[0]?.height], [1000, 1600])
  assert.ok(item.attempts.every(attempt => attempt.preResolutionReview && !attempt.backgroundResolution))
})

test('a continuous scene regenerated after a confirmed seam passes independent native and final review', async t => {
  const w = await workflow(t, ['seam', 'pass', 'pass'], false, false, false, false, 'native-seam')
  const item = w.state(await w.start()).items[0]!
  assert.equal(item.status, 'passed', JSON.stringify({ reason: item.reason, code: item.errorCode, reviews: w.reviewRequests }) + w.diagnostics())
  assert.equal(w.requests.length, 2)
  const [first, correction] = w.requests
  assert.equal(correction?.references[0]?.attachmentId, first?.references[0]?.attachmentId)
  assert.equal(first?.mask, undefined)
  assert.equal(correction?.mask, undefined)
  assert.match(correction?.prompt ?? '', /上一版已核实的主体位置与尺度合格/)
  assert.match(correction?.prompt ?? '', /主体核心位于横向.*纵向/)
  assert.deepEqual(item.attempts[1]?.generationInput?.references.map(reference => reference.role), ['original'])
  assert.equal(item.attempts[1]?.generationInput?.version, 'wallpaper-edit-input-v4')
  assert.ok(item.attempts[1]?.preResolutionReview)
  assert.ok(item.attempts[1]?.backgroundResolution?.enhancedId)
  assert.equal(item.attempts[1]?.postResolutionReview?.imageVersionId, item.attempts[1]?.outputId)
  assert.match(w.reviewRequests[2]?.requestId ?? '', /:final-review:/)
})

test('an unchanged original-only redraw retains its native measurements when final review estimates a different center', async t => {
  const w = await workflow(t, ['seam', 'pass', 'high-layout-estimate'], false, false, false, false, 'native-seam')
  const item = w.state(await w.start()).items[0]!
  assert.equal(item.status, 'passed', JSON.stringify({ reason: item.reason, code: item.errorCode, reviews: w.reviewRequests }) + w.diagnostics())
  assert.equal(w.requests.length, 2)
  const redraw = item.attempts[1]
  assert.ok(redraw?.postResolutionReview?.review)
  const result = wallpaperStoredSourceReviewV4Schema.parse(redraw.postResolutionReview.review)
  assert.deepEqual(result.layoutChecks, [])
  assert.deepEqual(result.actualLayout.regions, wallpaperStoredSourceReviewV4Schema.parse(redraw.review).actualLayout.regions)
  assert.equal(result.criticalDetail, undefined)
  assert.equal(w.reviews.length, 3)
  assert.equal(w.reviews.at(-1), redraw.outputId)
})

test('a duplicate found on the delivered frame still blocks approval after matching native measurements', async t => {
  const w = await workflow(t, ['seam', 'pass', 'major'], false, false, false, false, 'native-seam')
  const item = w.state(await w.start()).items[0]!
  assert.equal(item.status, 'needs-review', JSON.stringify({ reason: item.reason, code: item.errorCode, reviews: w.reviewRequests }) + w.diagnostics())
  const result = wallpaperStoredSourceReviewV4Schema.parse(item.attempts[1]?.postResolutionReview?.review)
  assert.equal(result.checks.protection.result, 'satisfied')
  assert.equal(result.checks.background.result, 'violated')
  assert.equal(w.requests.length, 2)
})

test('a same-frame safety disagreement checks the actual delivered edge instead of accepting the earlier box', async t => {
  const w = await workflow(t, ['seam', 'pass', 'coarse-layout', 'coarse-layout', 'pass', 'coarse-layout'], false, false, false, false, 'native-seam')
  const runId = await w.start(), item = w.state(runId).items[0]!
  const redraw = item.attempts[1]!
  assert.equal(item.status, 'needs-review', JSON.stringify({ reason: item.reason, code: item.errorCode, reviews: w.reviewRequests }) + w.diagnostics())
  assert.equal(w.requests.length, 2)
  assert.equal(w.reviews.at(-1), redraw.outputId)
  assert.match(redraw.boundaryReview?.requestId ?? '', /:final-review:2:safety-crops$/)
  assert.ok(w.reviewRequests.at(-1)?.roles.includes('actual-wallpaper-detail-only'))
  assert.equal(redraw.postResolutionReview?.review?.checks.protection.result, 'violated')
  const next = receipt.parse(await w.f.action('wallpaper-continue', { runId, operationId: 'recheck-confirmed-edge', recheckAll: 'unresolved' }))
  await w.f.jobs.drain()
  const rechecked = w.state(next.runId).items[0]!
  assert.equal(rechecked.status, 'needs-review')
  assert.equal(rechecked.attempts.at(-1)?.outputId, redraw.outputId)
  assert.match(w.reviewRequests.at(-1)?.requestId ?? '', /:final-review:3:safety-crops$/)
  assert.equal(w.requests.length, 2)
})

test('a misplaced complete redraw under the saved crop policy is cropped from one canvas and that exact output is reviewed', async t => {
  const w = await workflow(t, ['seam', 'high-redraw-with-room', 'high-redraw-with-room', 'pass'], false, false, false, false, 'native-seam')
  w.f.service.config.wallpaper.processing = legacyPlacement
  const runId = await w.start(), item = w.state(runId).items[0]!
  const redraw = item.attempts[1]!
  assert.equal(item.status, 'passed', JSON.stringify({ reason: item.reason, code: item.errorCode, reviews: w.reviewRequests }) + w.diagnostics())
  assert.equal(w.requests.length, 2)
  const viewport = redraw.preResolutionReview?.placementCrop
  assert.ok(viewport)
  assert.equal(viewport.y, 0)
  assert.ok(viewport.height < 3280)
  const native = wallpaperStoredSourceReviewV4Schema.parse(redraw.review)
  assert.ok(native.layoutChecks.some(check => check.startsWith('subject-center-drift:')))
  assert.equal(redraw.postResolutionReview?.imageVersionId, redraw.outputId)
  assert.equal(w.reviews.at(-1), redraw.outputId)
  assert.ok(redraw.backgroundResolution?.enhancedId && redraw.outputId)
  const full = await w.f.files.read(w.f.domain.require('imageVersion', redraw.backgroundResolution.enhancedId).blob)
  const actual = await w.f.files.read(w.f.domain.require('imageVersion', redraw.outputId).blob)
  const expected = await sharp(full).extract({ left: viewport.x, top: viewport.y, width: viewport.width, height: viewport.height }).resize(1845, 3280, { fit: 'fill' }).toColourspace('srgb').raw().toBuffer()
  assert.equal(createHash('sha256').update(await sharp(actual).raw().toBuffer()).digest('hex'), createHash('sha256').update(expected).digest('hex'))
  const report = z.object({ wallpaper: z.object({ outputs: z.array(z.object({ imageVersionId: z.string(), review: z.literal('pass'), passed: z.literal(true) })) }) }).parse(await w.f.action('run-get', { runId }))
  assert.equal(report.wallpaper.outputs[0]?.imageVersionId, redraw.outputId)
  const exported = z.object({ directory: z.string(), files: z.literal(1) }).parse(await w.f.action('direct-crop-export', { runId, title: 'Export the corrected image' }))
  const manifest = z.object({ files: z.array(z.object({ name: z.string(), imageVersionId: z.string() })) }).parse(JSON.parse(await readFile(join(exported.directory, 'manifest.json'), 'utf8')))
  assert.equal(manifest.files[0]?.imageVersionId, redraw.outputId)
  assert.equal(createHash('sha256').update(await readFile(join(exported.directory, manifest.files[0]!.name))).digest('hex'), createHash('sha256').update(actual).digest('hex'))
})

test('a cropped redraw with an independent final quality failure stays unqualified', async t => {
  const w = await workflow(t, ['seam', 'high-redraw-with-room', 'high-redraw-with-room', 'major'], false, false, false, false, 'native-seam')
  w.f.service.config.wallpaper.processing = legacyPlacement
  const item = w.state(await w.start()).items[0]!
  assert.equal(item.status, 'needs-review', JSON.stringify({ reason: item.reason, code: item.errorCode, reviews: w.reviewRequests }) + w.diagnostics())
  const redraw = item.attempts[1]!
  assert.ok(redraw.preResolutionReview?.placementCrop)
  assert.equal(w.reviews.at(-1), redraw.outputId)
  assert.equal(redraw.postResolutionReview?.review?.checks.background.result, 'violated')
  assert.equal(w.requests.length, 2)
})

test('an isolated cut at a positioned edge reaches native detail review even at delivery dimensions', async t => {
  const w = await workflow(t, ['seam', 'pass', 'pass'], false, false, false, false, 'isolated-seam')
  const item = w.state(await w.start()).items[0]!
  assert.equal(item.status, 'passed', JSON.stringify({ reason: item.reason, code: item.errorCode, reviews: w.reviewRequests }) + w.diagnostics())
  assert.ok(w.reviewRequests[0]?.nativeSeamScreen)
  assert.ok(w.reviewRequests[0]?.roles.includes('actual-wallpaper-detail-only'))
  assert.deepEqual(w.requests.map(request => [request.references.length, !!request.mask]), [[1, false], [1, false]])
  assert.ok(item.attempts.every(attempt => attempt.preResolutionReview && !attempt.backgroundResolution))
  assert.equal(item.attempts[1]?.postResolutionReview?.imageVersionId, item.attempts[1]?.outputId)
})

test('a visually confirmed natural full-span edge stays accepted without another generation', async t => {
  const w = await workflow(t, ['pass', 'pass'], false, false, false, false, 'full-span-edge')
  const item = w.state(await w.start()).items[0]!
  assert.equal(item.status, 'passed', JSON.stringify({ reason: item.reason, code: item.errorCode, reviews: w.reviewRequests }) + w.diagnostics())
  assert.ok(w.reviewRequests[0]?.nativeSeamScreen)
  assert.ok(w.reviewRequests[0]?.roles.includes('actual-wallpaper-detail-only'))
  assert.equal(w.requests.length, 1)
  assert.equal(item.attempts[0]?.postResolutionReview?.imageVersionId, item.attempts[0]?.outputId)
})

test('wide abstract retries use the original texture and require native and final quality evidence', async t => {
  const w = await workflow(t, ['seam', 'pass', 'pass'], false, false, false, false, 'wide-abstract')
  const [item] = w.state(await w.start()).items
  assert.ok(item)
  assert.equal(item.status, 'passed', JSON.stringify({ reason: item.reason, code: item.errorCode, reviews: w.reviewRequests }) + w.diagnostics())
  assert.equal(w.requests.length, 2)
  assert.equal(w.reviews.length, 3)
  for (const request of w.requests) {
    assert.equal(request.references.length, 1)
    assert.deepEqual([request.references[0]?.width, request.references[0]?.height], [1672, 941])
    assert.equal(request.mask, undefined)
  }
  const [rejected, approved] = item.attempts
  assert.equal(rejected?.generationInput?.references[0]?.role, 'original')
  assert.ok(rejected?.preResolutionReview)
  assert.equal(rejected.review?.checks.background.result, 'violated')
  assert.equal(rejected.backgroundResolution, undefined)
  assert.equal(rejected.postResolutionReview, undefined)
  assert.equal(approved?.generationInput?.references[0]?.role, 'original')
  assert.ok(approved?.preResolutionReview)
  assert.ok(approved.backgroundResolution?.enhancedId)
  assert.equal(approved.postResolutionReview?.imageVersionId, approved.outputId)
  assert.match(w.reviewRequests[2]?.requestId ?? '', /:final-review:/)
})

test('a small estimated overhang inspects the same candidate edge without generating a new image', async t => {
  const w = await workflow(t, ['near-layout', 'pass'])
  const [item] = w.state(await w.start()).items
  assert.ok(item)
  assert.equal(item.status, 'passed', w.diagnostics())
  assert.equal(w.requests.length, 1)
  assert.equal(w.reviews.length, 2)
  assert.equal(w.reviews[0], w.reviews[1])
  assert.ok(w.reviewRequests[1]?.roles.includes('actual-wallpaper-detail-only'))
})

test('a newly reported edge after relative layout confirmation rechecks the same candidate before rework', async t => {
  const w = await workflow(t, ['relative-layout', 'near-right-layout', 'pass'], false, false, false, false, 'relative-then-edge')
  const item = w.state(await w.start()).items[0]!
  assert.equal(item.status, 'passed', JSON.stringify({ reason: item.reason, reviews: w.reviewRequests }) + w.diagnostics())
  assert.equal(w.requests.length, 1)
  assert.equal(item.attempts.length, 1)
  const { outputId, review } = item.attempts[0]!
  assert.deepEqual(w.reviews, [outputId, outputId, outputId])
  assert.match(w.reviewRequests[1]!.requestId, /:source-and-actual:layout-confirm$/)
  assert.equal(w.reviewRequests[1]!.roles.includes('actual-wallpaper-detail-only'), false)
  assert.match(w.reviewRequests[2]!.requestId, /:actual-edge:layout-confirm$/)
  assert.ok(w.reviewRequests[2]!.roles.includes('actual-wallpaper-detail-only'))
  assert.equal(review?.checks.protection.result, 'satisfied')
})

test('a newly reported edge that remains below 97 percent after local confirmation requires correction', async t => {
  const w = await workflow(t, ['relative-layout', 'near-right-layout', 'near-right-layout', 'pass'], false, false, false, false, 'relative-then-edge')
  const item = w.state(await w.start()).items[0]!
  assert.equal(item.status, 'passed', JSON.stringify({ reason: item.reason, reviews: w.reviewRequests }) + w.diagnostics())
  const [first, second] = item.attempts
  assert.ok(first && second)
  assert.equal(w.requests.length, 2)
  assert.deepEqual(w.reviews, [first.outputId, first.outputId, first.outputId, second.outputId])
  assert.match(w.reviewRequests[2]!.requestId, /:actual-edge:layout-confirm$/)
  assert.deepEqual(wallpaperStoredSourceReviewV4Schema.parse(first.review).layoutChecks, ['subject-overflow:Drink'])
})

test('a newly reported edge that cannot be resolved keeps the same candidate for manual review', async t => {
  const w = await workflow(t, ['relative-layout', 'near-right-layout', 'unknown'], false, false, false, false, 'relative-then-edge')
  const item = w.state(await w.start()).items[0]!
  assert.equal(item.status, 'needs-review', JSON.stringify({ reason: item.reason, reviews: w.reviewRequests }) + w.diagnostics())
  assert.equal(w.requests.length, 1)
  assert.equal(item.attempts.length, 1)
  const { outputId, review } = item.attempts[0]!
  assert.deepEqual(w.reviews, [outputId, outputId, outputId])
  assert.match(w.reviewRequests[2]!.requestId, /:actual-edge:layout-confirm$/)
  assert.equal(review?.checks.protection.result, 'unknown')
})

test('an overextended source rectangle is measured on the same candidate without a fresh image', async t => {
  const w = await workflow(t, ['pass', 'pass'], false, false, false, false, 'wide-source-estimate')
  const item = w.state(await w.start()).items[0]!
  assert.equal(item.status, 'passed', w.diagnostics())
  assert.equal(w.requests.length, 1)
  assert.equal(w.reviews.length, 2)
  assert.equal(w.reviews[0], w.reviews[1])
  assert.match(w.reviewRequests[1]!.requestId, /:source-and-actual:layout-confirm$/)
  assert.deepEqual(item.attempts[0]!.plan.objectRoles?.[0]?.rect, { x: 0.1, y: 0.1, width: 0.8, height: 0.8 })
})

test('an unresolved source estimate holds the same candidate rather than authorizing another image', async t => {
  const w = await workflow(t, ['pass', 'pass'], false, false, false, false, 'unknown-source-estimate')
  const item = w.state(await w.start()).items[0]!
  assert.equal(item.status, 'needs-review', w.diagnostics())
  assert.equal(w.requests.length, 1)
  assert.equal(w.reviews.length, 2)
  assert.equal(w.reviews[0], w.reviews[1])
  const review = wallpaperStoredSourceReviewV4Schema.parse(item.attempts[0]!.review)
  assert.equal(review.checks.protection.result, 'unknown')
  assert.ok(review.practicalReview?.uncertainties.length)
})

test('a newly confirmed duplicate can authorize correction despite an unresolved source estimate', async t => {
  const w = await workflow(t, ['pass', 'major', 'pass', 'pass'], false, false, false, false, 'unknown-source-estimate')
  const item = w.state(await w.start()).items[0]!
  assert.equal(w.requests.length, 2, w.diagnostics())
  assert.equal(w.reviews[0], w.reviews[1])
  const first = wallpaperStoredSourceReviewV4Schema.parse(item.attempts[0]!.review)
  assert.ok(first.modelIssues.some(issue => issue.check === 'background'))
  assert.deepEqual(first.practicalReview?.uncertainties, [])
})

test('an oversized normalized JPEG source uses its archived bytes as the appearance reference', async t => {
  const w = await workflow(t, ['pass'], false, false, false, false, 'large-jpeg'), runId = await w.start()
  const item = w.state(runId).items[0]!, attempt = item.attempts.at(-1)!
  const source = w.f.domain.require('imageVersion', item.originalId!), asset = w.f.domain.require('asset', source.assetId)
  assert.ok(asset.originalBlob); assert.ok(attempt.canvasId)
  assert.ok(source.blob.byteLength > w.attachmentLimit, 'The saved lossless PNG must reproduce the oversized attachment')
  assert.ok(w.source.byteLength < w.f.files.limits.maxFileBytes)
  assert.equal(item.status, 'passed', JSON.stringify({ stage: item.failedStep, code: item.errorCode, attemptedEdits: item.edits, dispatched: w.requests.length,
    inputBytes: w.source.byteLength, attachmentLimit: w.attachmentLimit, references: w.submittedImages.map(({ mediaType, bytes }) => ({ mediaType, bytes })) }))
  const canvas = w.f.domain.require('imageVersion', attempt.canvasId)
  const input = attempt.generationInput
  assert.ok(input?.version === 'wallpaper-edit-input-v4')
  assert.deepEqual([source.geometry.width, source.geometry.height], [3000, 6000])
  assert.deepEqual([canvas.geometry.width, canvas.geometry.height], [3000, 6000])
  assert.deepEqual(input.references.map(reference => reference.role), ['original'])
  assert.equal(attempt.maskId, undefined)
  assert.equal(w.requests[0]?.mask, undefined)
  assert.deepEqual(w.submittedImages.find(image => image.mediaType === 'image/jpeg'), { mediaType: 'image/jpeg', bytes: w.source.byteLength, digest: createHash('sha256').update(w.source).digest('hex') })
  assert.deepEqual(w.requests[0]?.references[0]?.originalDimensions, { width: 3000, height: 6000 })
  assert.equal(w.requests.length, 1); assert.equal(w.reviews.length, 1); assert.equal(item.edits, 1)
  await assert.rejects(w.f.files.importBytes(await w.f.files.read(source.blob)), /configured import limit/)
  assert.deepEqual(await w.f.files.read(asset.originalBlob), w.source, 'The archived original must remain unchanged')
})

test('a rejected generation attachment leaves the saved plan and the full edit budget available', async t => {
  const w = await workflow(t, [], false, false, false, false, 'attachment-rejected'), runId = await w.start()
  const item = w.state(runId).items[0]!, attempt = item.attempts.at(-1)!
  assert.equal(item.status, 'technical-failed')
  assert.equal(item.failedStep, 'rendering'); assert.equal(item.errorCode, 'IMAGE_TOO_LARGE')
  assert.ok(item.originalId && attempt.canvasId)
  assert.equal(item.edits, 0); assert.equal(w.requests.length, 0)
  assert.equal(attempt.generationOperation, undefined); assert.equal(attempt.generation, undefined)
})

test('a confirmed automobile overflow uses one correction with the original artwork alone', async t => {
  const w = await workflow(t, ['car-outside', 'car-outside', 'pass', 'pass'], false, false, false, false, 'automobile'), runId = await w.start()
  const item = w.state(runId).items[0]!, [first, second] = item.attempts
  assert.ok(first && second)
  const failed = wallpaperStoredSourceReviewV4Schema.parse(first.review)
  assert.equal(item.status, 'passed', item.reason + w.diagnostics())
  assert.equal(w.requests.length, 2); assert.equal(w.plans(), 1); assert.equal(item.edits, 2)
  assert.notEqual(first.generation?.id, second.generation?.id)
  assert.deepEqual(second.plan, first.plan)
  const originalInput = first.generationInput, correctedInput = second.generationInput
  assert.ok(originalInput?.version === 'wallpaper-edit-input-v4' && correctedInput?.version === 'wallpaper-edit-input-v4')
  assert.deepEqual(correctedInput.references, originalInput.references)
  assert.deepEqual(w.requests.map(request => request.mask), [undefined, undefined])
  assert.deepEqual(w.reviews, [first.outputId, first.outputId, second.outputId, second.outputId])
  assert.equal(failed.actualLayout.regions[0]!.safetyClass, 'automobile')
  assert.ok(failed.layoutChecks.some(check => check.startsWith('automobile-outside:')))
  assert.equal(item.attempts.length, 2)
  assert.equal(first.boundaryReview?.status, 'completed')
})

test('an automobile measurement corrected on the same pixels leaves the generation count at one', async t => {
  const w = await workflow(t, ['car-left-estimate', 'car-left-measured'], false, false, false, false, 'automobile'), runId = await w.start()
  const item = w.state(runId).items[0]!, attempt = item.attempts[0]!
  assert.equal(item.status, 'passed', item.reason + w.diagnostics())
  assert.equal(item.attempts.length, 1); assert.equal(item.edits, 1); assert.equal(w.requests.length, 1); assert.equal(w.plans(), 1)
  assert.equal(attempt.boundaryReview?.status, 'completed')
  assert.deepEqual(w.reviews, [attempt.outputId, attempt.outputId])
})

test('one major duplicate is corrected inside the same job with exactly two generations and final reviews', async t => {
  const w = await workflow(t, ['major', 'pass']), runId = await w.start()
  const item = w.state(runId).items[0]!
  assert.equal(item.status, 'passed', JSON.stringify({ reason: item.reason, code: item.errorCode, step: item.failedStep, reviewRequests: w.reviewRequests }) + w.diagnostics())
  assert.equal(w.generated.length, 2); assert.equal(w.reviews.length, 2); assert.equal(w.f.jobs.hooks.length, 1)
  assert.equal(item.edits, 2)
  const settings = wallpaperSettingsSchema.parse(specOf(w.f.domain.require('run', runId)).fixed.wallpaper)
  assert.equal(settings.maxEditsPerImage, 2); assert.equal(settings.maxReworks, 1)
  assert.equal(item.attempts.length, 2)
  assert.deepEqual(w.requests.map(request => [request.references.length, !!request.mask]), [[1, false], [1, false]])
  assert.match(w.requests[1]?.prompt ?? '', /上版已确认的缺陷必须消除/)
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
  assert.equal(attempt.review.checks.protection.result, 'satisfied')
  assert.equal(wallpaperStoredSourceReviewV4Schema.parse(attempt.review).practicalReview?.version, 'practical-v2')
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

test('a receipt check observes the provider state and leaves a confirmed failure for an explicit new edit', async t => {
  const w = await workflow(t, ['pass'], false, false, true), runId = await w.start()
  const item = w.state(runId).items[0], saved = item?.attempts.at(-1)
  assert.ok(item && saved?.generation)
  const task = w.tasks.get(saved.generation.id)
  assert.ok(task)
  const read = async () => wallpaperViewSchema.parse(await w.f.action('wallpaper-read', { sourceRunId: runId, offset: 0, limit: 1 })).generationReceipts
  assert.deepEqual(await read(), { [task.id]: 'unavailable' })
  w.releaseReceipt()
  assert.deepEqual(await read(), { [task.id]: 'succeeded' })
  const retryImage = { imageVersionId: item.imageVersionId, revision: saved.revision, step: 'rendering' }
  const original = contentDigest(w.f.domain.require('run', runId))
  const priorRuns = w.f.repository.list('run').map(run => run.id)
  w.tasks.set(task.id, { ...task, state: 'outcome-unknown', images: [] })
  const checked = await w.f.action('wallpaper-continue', { runId, operationId: 'query-unknown-receipt', retryImage: { ...retryImage, receiptOnly: true } })
  assert.deepEqual(checked, { runId, receiptState: 'outcome-unknown' })
  assert.deepEqual(w.f.repository.list('run').map(run => run.id), priorRuns)
  assert.equal(w.requests.length, 1)
  w.tasks.set(task.id, { ...task, state: 'failed', images: [] })
  assert.deepEqual(await read(), { [task.id]: 'failed' })
  await assert.rejects(w.f.action('wallpaper-continue', { runId, operationId: 'query-terminal-receipt', retryImage: { ...retryImage, receiptOnly: true } }), { code: 'constraint-conflict' })
  assert.equal(w.generated.length, 1)
  assert.equal(contentDigest(w.f.domain.require('run', runId)), original)
  const next = receipt.parse(await w.f.action('wallpaper-continue', { runId, operationId: 'explicit-next-edit', retryImage }))
  await w.f.jobs.drain()
  assert.equal(w.state(next.runId).items[0]?.status, 'passed')
  assert.equal(w.generated.length, 2)
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

test('explicit review measures the selected saved preview at delivery size after a native rejection', { timeout: 60_000 }, async t => {
  const w = await workflow(t, ['seam', 'seam', 'major'], false, false, false, false, 'native-seam')
  const runId = await w.start(), item = w.state(runId).items[0]!
  const prior = item.attempts.at(-1), candidate = prior?.nativeReviewCandidate
  assert.ok(candidate && prior.outputId === candidate.previewId)
  const original = w.f.domain.require('imageVersion', candidate.previewId)
  assert.notEqual(original.blob.digest, candidate.nativeDigest)
  const edits = item.edits, generationCount = w.requests.length, reviewCount = w.reviews.length
  const next = receipt.parse(await w.f.action('wallpaper-continue', { runId, operationId: 'review-selected-preview-bytes', review: { outputId: candidate.previewId } }))
  await w.f.jobs.drain()
  const observed = w.reviews.slice(reviewCount).map(id => w.f.domain.require('imageVersion', id).blob.digest)
  assert.ok(observed.length && observed.every(digest => digest === original.blob.digest), JSON.stringify(observed))
  assert.equal(w.state(next.runId).items[0]?.edits, edits)
  assert.equal(w.requests.length, generationCount)
})
