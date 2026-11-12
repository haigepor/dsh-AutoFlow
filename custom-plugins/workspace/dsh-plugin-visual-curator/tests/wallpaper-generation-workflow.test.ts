/** Isolated service execution retains native receipts and requires explicit reconstruction before undersized backgrounds reach review. */
import assert from 'node:assert/strict'
import { wallpaperFixtureResponse } from './helpers/wallpaper-response.ts'
import { test } from 'node:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { type ImageGenerationTask, type ImageGenerationRequest } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import LocalAttachmentStore from '../../../../packages/attachment/attachment-local/src/index.ts'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import { useHistoricalWallpaperCpu, serviceFixture } from './helpers/service-fixture.ts'
import { dataOf, specOf, toJson } from '../src/host/runtime.ts'
import { runSchema } from '../src/shared/model.ts'
import { wallpaperStateSchema, wallpaperReviewKeys } from '../src/shared/wallpaper.ts'
import { backgroundResolutionSettingsSchema } from '../src/shared/background-resolution.ts'
import { z } from 'zod'
import { wallpaperPromptPreparationPolicySchema } from '../src/shared/wallpaper-generation-brief.ts'
import { contentDigest } from '../src/domain/repository.ts'

for (const size of [{ width: 1872, height: 3328, expected: 'passed', reconstruction: false, brief: true }, { width: 1872, height: 3328, expected: 'passed', reconstruction: false, brief: true, legacyBrief: true }, { width: 1872, height: 3328, expected: 'technical-failed', reconstruction: false, receiptFailure: true }, { width: 1872, height: 3328, expected: 'passed', reconstruction: false }, { width: 941, height: 1672, expected: 'needs-review', reconstruction: false }, { width: 941, height: 1672, expected: 'passed', reconstruction: true }, { width: 1872, height: 3328, expected: 'needs-review', reconstruction: false, admissionFailure: true }, ...(['automatic', 'legacy', 'limit'] as const).map(rework => ({ width: 1872, height: 3328, expected: rework === 'limit' ? 'needs-review' : 'passed', reconstruction: false, rework }))] as const) test(`background generation ${'brief' in size ? 'prepares the reviewer image brief before dispatch' + ('legacyBrief' in size ? ' with frozen V2 composition' : '') : 'rework' in size ? 'rework ' + size.rework : 'admissionFailure' in size ? 'retains the reference admission failure' : `retains one target canvas and ${size.reconstruction ? 'reconstructs' : 'validates'} ${size.width}×${size.height} as ${size.expected}`}`, async () => {
  const f = await serviceFixture(), context = new Context(), llm = new LlmRuntime(context), attachments = new LocalAttachmentStore(context, { dshHome: f.root })
  useHistoricalWallpaperCpu(f)
  if ('brief' in size) f.service.config.vision.wallpaperPromptPreparation = wallpaperPromptPreparationPolicySchema.parse({ version: 'legacyBrief' in size ? 'style-brief-v2' : 'style-brief-v3', enabled: true, reasoningEffort: 'high' })
  f.host.llm = llm; f.host.attachments = attachments
  f.service.config.wallpaper.imageProvider = 'isolated-images'; f.service.config.wallpaper.imageModel = 'isolated-high-model'
  f.service.config.wallpaper.backgroundResolution = backgroundResolutionSettingsSchema.parse({ version: 'espcn-background-v1', enabled: size.reconstruction })
  const rework = 'rework' in size ? size.rework : undefined
  if (rework === 'legacy') f.service.config.wallpaper.maxEditsPerImage = 1
  const generationIds = new Set<string>()
  let dispatched = 0, reviews = 0, plans = 0, saved: ImageGenerationTask | undefined, submitted: ImageGenerationRequest | undefined
  const readFile = async (reference: Parameters<typeof attachments.readFileStream>[0]) => { const chunks: Uint8Array[] = []; for await (const chunk of attachments.readFileStream(reference)) chunks.push(chunk); return Buffer.concat(chunks) }
  const source = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: '#587181' } }).png().toBuffer(), path = join(f.root, 'original.png')
  await writeFile(path, source)
  const generated = await sharp({ create: { width: size.width, height: size.height, channels: 3, background: '#587181' } }).png().toBuffer()
  try {
    llm.getImageGeneration = async handle => { if (saved?.id !== handle.id) throw Object.assign(new Error('No receipt yet'), { code: 'IMAGE_GENERATION_NOT_FOUND' }); return saved }
    llm.startImageGeneration = async request => {
      dispatched++; submitted = request
      if ('receiptFailure' in size && dispatched === 1) return saved = { id: request.id!, provider: request.provider, model: request.model, taskId: brandString<import('@deepseek-ai/dsh-llm').ImageGenerationTaskId>('known-failed'), state: 'failed', images: [], error: { code: 'image-http-error', message: 'Known failed service receipt, no image produced.' } }
      assert(!generationIds.has(request.id!)); generationIds.add(request.id!)
      const result = dispatched > 1 ? await sharp({ create: { width: size.width, height: size.height, channels: 3, background: { r: 88, g: 113 + dispatched * 5, b: 129 } } }).png().toBuffer() : generated
      const original = await attachments.saveFile({ data: result, name: 'provider-original.png' }), preview = await attachments.saveImages([{ data: result, mediaType: 'image/png' }])
      return saved = { id: request.id!, provider: request.provider, model: request.model, taskId: brandString<import('@deepseek-ai/dsh-llm').ImageGenerationTaskId>('isolated-provider-task-' + dispatched), state: 'succeeded', images: [{ original, preview: preview[0]! }] }
    }
    const send = f.http.request.bind(f.http)
    f.http.request = async (url, request) => {
      if (!url.startsWith('https://vision.example.test')) return send(url, request)
      const envelope = z.object({ messages: z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ text: z.string().optional() }).passthrough())]) })) }).parse(JSON.parse(Buffer.from(request.body!).toString('utf8')))
      const content = envelope.messages.find(row => row.role === 'user')!.content; assert(Array.isArray(content))
      const input = z.object({ input: z.object({ operation: z.string(), images: z.array(z.object({ imageVersionId: z.string(), role: z.string() })) }) }).parse(JSON.parse(content[0]!.text!)).input
      const plan = { version: 1, imageVersionId: input.images[0]!.imageVersionId, mode: 'single', subject: 'Isolated motorcycle-shaped subject', evidence: 'Scripted evidence for service execution only.', priorities: ['Keep the subject native pixels.'], anchors: ['Continuous sea horizon.'], truncations: [], uncertainties: [], regions: [{ name: 'Vehicle', role: 'subject', rect: { x: 0.1, y: 0.2, width: 0.8, height: 0.7 } }, { name: 'Tank', role: 'critical', rect: { x: 0.4, y: 0.4, width: 0.2, height: 0.1 } }], reason: 'Use the complete available safe area.', editPrompt: 'Continue the original sea and overcast sky without a rectangular transition; retain the tank and wheels.' }
      const sourceId = input.images.find(image => image.role === 'wallpaper-original')!.imageVersionId
      const outputId = input.images.find(image => image.role === 'actual-wallpaper')?.imageVersionId
      if (input.operation === 'wallpaper-plan') plans++
      if (input.operation === 'wallpaper-decision') {
        const decision = z.object({ input: z.object({ usage: z.object({ decision: z.object({ planRevision: z.number(), concerns: z.array(z.object({ id: z.string(), scope: z.enum(['subject', 'critical', 'background', 'technical']).optional() })), reason: z.string() }) }) }) }).parse(JSON.parse(content[0]!.text!)).input.usage.decision
        const version = z.object({ outputSchema: z.object({ properties: z.object({ version: z.object({ const: z.string() }) }) }) }).parse(JSON.parse(content[0]!.text!)).outputSchema.properties.version.const
        const result = { version, imageVersionId: sourceId, planRevision: decision.planRevision, findings: decision.concerns.map(concern => ({ concernId: concern.id, scope: concern.scope ?? 'technical', classification: 'technical-failure', blocking: true, reason: 'The saved technical failure remains unresolved.', evidenceImageVersionIds: [sourceId] })), sourceExtent: { extent: 'unknown', reason: 'Technical recovery is not independent visual acceptance.' }, action: { kind: 'manual_review' }, reason: decision.reason }
        return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(wallpaperFixtureResponse(JSON.parse(content[0]!.text!), result)) }, finish_reason: 'stop' }] })) }
      }
      if (input.operation === 'wallpaper-review') {
        reviews++
        assert.deepEqual(input.images.map(image => image.role), ['actual-wallpaper', 'wallpaper-original'], 'A task without a clock rule reviews the clean candidate and original without a simulated clock image')
      }
      const reject = !!rework && (reviews === 1 || rework === 'limit')
      const result = input.operation === 'wallpaper-plan' ? plan : { reviewVersion: 'wallpaper-review-source-v1', subject: plan.subject, checks: { ...Object.fromEntries([...wallpaperReviewKeys, 'clarity'].map(key => [key, { result: reject && ['subject', 'style', 'clarity', 'background'].includes(key) ? 'violated' : 'satisfied', reason: 'Isolated scripted result, not real visual acceptance.' }])) }, issues: reject ? [{ kind: 'preservation', reason: 'Detail lost on the protected subject.' }, { kind: 'background', reason: 'A visible horizon seam remains.' }] : [], styleResults: [], subjectIntegrity: { mode: 'single', source: { extent: 'complete', reason: 'Scripted source.', imageVersionId: sourceId }, output: { extent: 'complete', reason: 'Scripted output.', imageVersionId: outputId }, task: { result: 'satisfied', reason: 'Scripted task.' } } }
      return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(wallpaperFixtureResponse(JSON.parse(content[0]!.text!), result)) }, finish_reason: 'stop' }] })) }
    }
    await f.service.initialize()
    if ('admissionFailure' in size) attachments.saveImages = async () => { throw new AttachmentError('Image exceeds the configured byte limit.', 'IMAGE_TOO_LARGE') }
    const receipt = z.object({ runId: z.string() }).parse(await f.action('direct-crop-start', { operationId: 'size-check', name: 'Isolated generation size check', source: { kind: 'local', files: [{ path, name: 'original.png' }] } }))
    await f.jobs.drain()
    let run = f.domain.require('run', receipt.runId), item = wallpaperStateSchema.parse(dataOf(run).checkpoint.wallpaper).items[0]!
    if ('receiptFailure' in size) {
      assert.equal(item.status, 'technical-failed'); assert.equal(item.failedStep, 'rendering'); assert.equal(item.edits, 1)
      const previous = contentDigest(run), failedHandle = item.attempts[0]!.generation
      const child = z.object({ runId: z.string() }).parse(await f.action('wallpaper-continue', { runId: run.id, operationId: 'continue-known-failure' }))
      await f.jobs.drain()
      const recovered = wallpaperStateSchema.parse(dataOf(f.domain.require('run', child.runId)).checkpoint.wallpaper).items[0]!
      assert.equal(recovered.status, 'passed', recovered.reason); assert.equal(recovered.edits, 2); assert.equal(dispatched, 2)
      assert.deepEqual(recovered.attempts[0]!.generation, failedHandle)
      assert.notEqual(recovered.attempts[1]!.generation!.id, failedHandle!.id)
      assert.equal(contentDigest(f.domain.require('run', run.id)), previous)
      return
    }
    const attempt = item.attempts.at(-1)!
    if (rework) {
      if (rework === 'legacy') {
        assert.equal(item.reason, 'edit-limit'); assert.equal(item.edits, 1)
        const last = run, spec = specOf(last), data = dataOf(last), state = wallpaperStateSchema.parse(data.checkpoint.wallpaper), target = state.items[0]!
        target.reason = 'decision-round-limit'
        target.decisions = [1, 2].map(round => ({ id: 'recorded-plan-' + round, version: 'wallpaper-decision-v1', inputDigest: '1'.repeat(64), evidenceDigest: '2'.repeat(64), planRevision: 1, round, status: 'failed', reason: 'Recorded planning decision.', sourceStage: 'planning' }))
        const settings = { ...spec.config.wallpaper, maxEditsPerImage: 2, maxReworks: 2 }; delete settings.recoveryLimitVersion
        const recorded = runSchema.parse({ ...last, spec: toJson({ ...spec, fixed: { ...spec.fixed, wallpaper: toJson(settings) } }), data: toJson({ ...data, checkpoint: { ...data.checkpoint, wallpaper: toJson(state) } }) })
        const aggregateId = 'run:' + last.id
        await f.repository.commit({ aggregateId, expectedRevision: f.repository.manifest(aggregateId)!.revision, operationId: 'legacy-reviewed-artifact', request: {}, state: {runId: last.id}, records:[recorded] })
        const args = { runId: last.id, operationId: 'rework-reviewed-file', rework: { imageVersionId: target.imageVersionId, outputId: attempt.outputId!, revision: attempt.revision } }
        const next = z.object({runId:z.string()}).parse(await f.action('wallpaper-continue', args))
        assert.deepEqual(await f.action('wallpaper-continue', args), next); await f.jobs.drain()
        run = f.domain.require('run', next.runId); item = wallpaperStateSchema.parse(dataOf(run).checkpoint.wallpaper).items[0]!
        assert.equal(item.decisions?.length, 2); assert.deepEqual(f.domain.require('run', last.id), recorded)
        assert.equal(z.object({maxEditsPerImage:z.literal(5),maxReworks:z.literal(5)}).safeParse(specOf(run).fixed.wallpaper).success, true)
      }
      assert.equal(item.status, size.expected, item.reason)
      const count = rework === 'limit' ? 5 : 2
      assert.equal(reviews, count); assert.equal(dispatched, count); assert.equal(item.edits, count)
      const productions = item.attempts.filter(attempt => attempt.outputId)
      assert.equal(plans, 1, 'Pixel repairs reuse confirmed source observations and geometry')
      assert.ok(productions.slice(1).every(attempt => attempt.retryTarget === 'rendering'))
      assert.match(submitted!.prompt, /previousDefects/)
      assert.equal(new Set(productions.map(attempt => attempt.generation?.taskId)).size, count)
      assert.equal(f.repository.list('selection').length, rework === 'limit' ? 0 : 1)
      if (rework === 'limit') assert.equal(item.reason, 'edit-limit')
      return
    }
    if ('admissionFailure' in size) {
      assert.equal(item.status, 'needs-review'); assert.equal(item.errorCode, 'IMAGE_TOO_LARGE'); assert.equal(item.failedStep, 'rendering')
      assert.equal(item.decisions?.at(-1)?.response?.action.kind, 'manual_review')
      assert.equal(dispatched, 0); assert.equal(reviews, 0); assert.equal(attempt.generation, undefined); assert.equal(attempt.outputId, undefined)
      assert.equal(f.repository.list('selection').length, 0); assert.ok(item.originalId)
      return
    }
    assert.equal(item.status, size.expected, item.reason); assert.equal(dispatched, 1); assert.equal(attempt.compositionMode, 'legacyBrief' in size ? 'generated-canvas-protected-v2' : 'generated-canvas-v1')
    assert.deepEqual(attempt.generationInput!.references.map(reference => reference.role), ['canvas'])
    if ('brief' in size) { assert.equal(plans, 2); assert.equal(z.object({ version: z.enum(['style-brief-v2', 'style-brief-v3']) }).parse(specOf(run).fixed.generationPromptPolicy).version, 'legacyBrief' in size ? 'style-brief-v2' : 'style-brief-v3'); assert.equal(attempt.generationBrief?.status, 'saved'); assert.equal(attempt.generationBrief?.reasoningEffort, 'high'); assert.match(submitted!.prompt, /broken dry-brush/); assert.match(submitted!.prompt, /第1张参考图是完整画布及唯一构图依据/); if ('legacyBrief' in size) assert.match(submitted!.prompt, /Host会在交付时逐像素恢复/); else assert.doesNotMatch(submitted!.prompt, /Host会在交付时逐像素恢复/); assert.doesNotMatch(submitted!.prompt, /时钟背景是允许调整的背景区域/); assert.equal(dispatched, 1); assert.equal(dataOf(run).budget.vision, plans + reviews) }
    assert.equal(attempt.generation!.taskId, saved!.taskId); assert.equal(attempt.generationInput!.prompt, submitted!.prompt)
    const mask = await readFile(submitted!.mask!)
    const metadata = await sharp(mask).metadata()
    assert.equal(metadata.width, submitted!.references![0]!.width); assert.equal(metadata.height, submitted!.references![0]!.height)
    assert.deepEqual(await readFile(saved!.images[0]!.original), generated)
    if (size.reconstruction) { assert.equal(attempt.backgroundResolution?.status, 'passed'); assert.deepEqual(attempt.backgroundResolution.output, { width: 1845, height: 3280 }); assert.equal(attempt.backgroundResolution.input.width, 941) }
    else assert.equal(attempt.backgroundResolution, undefined)
    if (size.expected === 'passed') { assert.equal(reviews, 1); assert.equal(f.repository.list('selection').length, 1) }
    if ('brief' in size) {
      const rereview = z.object({ runId: z.string() }).parse(await f.action('wallpaper-continue', { runId: receipt.runId, operationId: 'rereview-keeps-authored-brief', review: { outputId: attempt.outputId! } }))
      await f.jobs.drain()
      const current = wallpaperStateSchema.parse(dataOf(f.domain.require('run', rereview.runId)).checkpoint.wallpaper).items[0]!
      assert.equal(current.status, 'passed', current.reason)
      assert.equal(current.edits, 1); assert.equal(plans, 2); assert.equal(dispatched, 1)
      assert.deepEqual(current.attempts.at(-1)!.generationBrief, attempt.generationBrief)
    }

    else if (size.expected === 'needs-review') {
      assert.equal(reviews, 1); assert.equal(f.repository.list('selection').length, 0); assert.equal(attempt.outputId, undefined); assert.match(item.reason!, /941×1672/)
      assert.equal(item.failedStep, 'rendering')
      const retry = z.object({ runId: z.string() }).parse(await f.action('wallpaper-continue', { runId: receipt.runId, operationId: 'reconcile-only', retryImage: { imageVersionId: item.imageVersionId, revision: attempt.revision, step: 'rendering' } }))
      await f.jobs.drain()
      const retried = wallpaperStateSchema.parse(dataOf(f.domain.require('run', retry.runId)).checkpoint.wallpaper).items[0]!
      assert.equal(retried.status, 'needs-review'); assert.equal(retried.attempts.at(-1)!.generation!.taskId, saved!.taskId); assert.equal(dispatched, 1)
      assert.equal(retried.decisions?.at(-1)?.response?.action.kind, 'manual_review')
      assert.equal(wallpaperStateSchema.parse(dataOf(f.domain.require('run', receipt.runId)).checkpoint.wallpaper).items[0]!.status, 'needs-review')
    }
  } finally { await f.cleanup(); await context.fiber.dispose() }
})
