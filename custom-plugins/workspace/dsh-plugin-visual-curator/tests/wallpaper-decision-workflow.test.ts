/** Real isolated wallpaper jobs keep decisions bounded, preserve legacy evidence and never treat routing as qualification. */
import assert from 'node:assert/strict'
import { wallpaperFixtureResponse } from './helpers/wallpaper-response.ts'
import { test } from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { type ImageGenerationTask } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import LocalAttachmentStore from '../../../../packages/attachment/attachment-local/src/index.ts'
import { serviceFixture } from './helpers/service-fixture.ts'
import { RunEngine, dataOf, specOf, toJson, executionSchema } from '../src/host/runtime.ts'
import { WallpaperWorkflows } from '../src/host/wallpaper-workflow.ts'
import { contentDigest } from '../src/domain/repository.ts'
import { runSchema, type RunRecord } from '../src/shared/model.ts'
import { wallpaperStateSchema, wallpaperPlanSchema, wallpaperReviewKeys, wallpaperSettingsSchema, wallpaperPromptBundleSchema } from '../src/shared/wallpaper.ts'
import { wallpaperDecisionSettingsSchema, wallpaperDecisionActionKinds, type WallpaperDecisionAction, type WallpaperDecisionResponse } from '../src/shared/wallpaper-decision.ts'
import { wallpaperPlanDetailPrompt } from '../src/shared/wallpaper-prompts.ts'
import { wallpaperReviewSchema } from '../src/shared/wallpaper.ts'

const rectSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
const concernSchema = z.object({ id: z.string(), text: z.string(), scope: z.enum(['subject', 'critical', 'background', 'technical']).optional(), detailImageVersionIds: z.array(z.string()).optional() })
const packetSchema = z.object({
  outputSchema: z.object({ properties: z.record(z.string(), z.json()) }),
  input: z.object({ operation: z.string(), images: z.array(z.object({ imageVersionId: z.string(), role: z.string() })), usage: z.object({
    concerns: z.array(concernSchema).optional(), priorPlan: wallpaperPlanSchema.optional(),
    decision: z.object({ planRevision: z.number(), concerns: z.array(concernSchema), allowedActions: z.array(z.enum(wallpaperDecisionActionKinds)), stage: z.string().optional() }).passthrough().optional(),
    imageRepresentations: z.array(z.object({ imageVersionId: z.string(), sourceRect: rectSchema.optional() })).optional(),
  }).passthrough() }),
})
type Packet = z.infer<typeof packetSchema>
type Scenario = 'held' | 'cut-off' | 'review-format' | 'unknown-generation'
const routingSnapshot = JSON.parse(await readFile(new URL('./fixtures/wallpaper-decision.expected.json', import.meta.url), 'utf8'))

function answer(packet: Packet, action: WallpaperDecisionAction, extent: 'complete' | 'cut-off' = 'complete'): WallpaperDecisionResponse {
  const decision = packet.input.usage.decision!
  const sourceId = packet.input.images.find(image => image.role === 'wallpaper-original')!.imageVersionId
  return {
    version: z.object({ const: z.enum(['wallpaper-decision-v1', 'wallpaper-decision-v2']) }).parse(packet.outputSchema.properties.version).const, imageVersionId: sourceId, planRevision: decision.planRevision,
    findings: decision.concerns.map(concern => {
      const background = concern.text.includes('tree')
      const technical = concern.scope === 'technical' || decision.stage === 'reviewing' || decision.stage === 'rendering'
      return { concernId: concern.id, scope: concern.scope ?? (technical ? 'technical' : background ? 'background' : 'subject'),
        classification: technical ? 'technical-failure' : extent === 'cut-off' ? 'frame-truncation' : background ? 'background-crop' : 'normal-occlusion',
        blocking: false, reason: 'Isolated supplied pixels explain this concern; no hidden structure is generated.',
        evidenceImageVersionIds: background ? [sourceId] : [concern.detailImageVersionIds?.[0] ?? sourceId] }
    }),
    sourceExtent: { extent, reason: extent === 'cut-off' ? 'The actual source frame cuts the subject.' : 'The complete visible object is inside the original frame.' },
    action, reason: 'Choose the next permitted step; final qualification remains independent.',
  }
}

async function fixture(scenario: Scenario = 'held', rounds = 2, options: { autoDecision?: boolean; maxReworks?: number; shrinkReplan?: boolean; singleImage?: boolean; failFirstContinuedReview?: boolean; decisionMaxImages?: number } = {}) {
  const f = await serviceFixture(), context = new Context(), llm = new LlmRuntime(context), attachments = new LocalAttachmentStore(context, { dshHome: f.root })
  f.host.llm = llm; f.host.attachments = attachments
  f.service.config.wallpaper.concurrency = 1; f.service.config.wallpaper.maxReworks = options.maxReworks ?? 0
  f.service.config.wallpaper.imageProvider = 'isolated-decision-images'; f.service.config.wallpaper.imageModel = 'isolated-image-model'
  if (options.autoDecision) delete f.service.config.wallpaper.decision
  else f.service.config.wallpaper.decision = wallpaperDecisionSettingsSchema.parse({ enabled: false })
  const operations: Packet[] = [], decisionPackets: Packet[] = [], reviewOutputIds: string[] = [], inspectionCheckpoints: RunRecord[] = [], pendingDecisionCheckpoints: RunRecord[] = []
  let firstSourceId = '', initializing = true, starts = 0, gets = 0, saved: ImageGenerationTask | undefined
  let rejectFinal = false, continuedReviewFailed = false
  let inspectedResult: 'resolved' | 'unresolved' | 'failed' = 'unresolved'
  let choose: (packet: Packet, round: number) => WallpaperDecisionAction = () => options.autoDecision ? { kind: 'manual_review' } : { kind: 'continue_current_plan' }
  llm.startImageGeneration = async request => {
    starts++
    saved = { id: request.id, provider: request.provider, model: request.model, taskId: brandString<import('@deepseek-ai/dsh-llm').ImageGenerationTaskId>('isolated-unknown-image-task'), state: 'outcome-unknown', images: [] }
    return saved
  }
  llm.getImageGeneration = async handle => {
    gets++
    if (!saved) throw Object.assign(new Error('No accepted image operation'), { code: 'IMAGE_GENERATION_NOT_FOUND' })
    assert.equal(handle.id, saved.id)
    return saved
  }
  const send = f.http.request.bind(f.http)
  f.http.request = async (url, request) => {
    if (!url.startsWith('https://vision.example.test')) return send(url, request)
    const envelope = z.object({ messages: z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ text: z.string().optional() }).passthrough())]) })) }).parse(JSON.parse(Buffer.from(request.body!).toString('utf8')))
    const content = envelope.messages.find(message => message.role === 'user')!.content
    assert(Array.isArray(content))
    const packet = packetSchema.parse(JSON.parse(content[0]!.text!)), input = packet.input
    operations.push(packet)
    const sourceId = input.images.find(image => image.role === 'wallpaper-original')!.imageVersionId
    let result: unknown
    if (input.operation === 'wallpaper-decision') {
      decisionPackets.push(packet)
      result = answer(packet, choose(packet, decisionPackets.length), scenario === 'cut-off' ? 'cut-off' : 'complete')
    } else if (input.operation === 'wallpaper-plan' && input.usage.priorPlan) {
      const { placement: _placement, truncations: backgroundTruncations, ...observation } = input.usage.priorPlan
      const detailId = input.images.find(image => image.role.endsWith('detail-only'))!.imageVersionId
      result = { version: 'wallpaper-plan-detail-v3', imageVersionId: sourceId, backgroundTruncations,
        protectedSubjectExtent: { extent: scenario === 'cut-off' ? 'cut-off' : 'complete', reason: 'Independent whole-source inspection in the isolated fixture.' },
        findings: input.usage.concerns!.map(concern => ({ concernId: concern.id, result: inspectedResult, reason: 'Independent inspection of the selected native detail.', evidenceImageVersionIds: [detailId] })), observation: { ...observation, uncertainties: inspectedResult === 'resolved' ? [] : observation.uncertainties } }
    } else if (input.operation === 'wallpaper-plan') {
      firstSourceId ||= sourceId
      const held = initializing && sourceId === firstSourceId && (scenario === 'held' || scenario === 'cut-off')
      result = { version: 1, imageVersionId: sourceId, mode: 'single', subject: 'Complete visible test vehicle', evidence: 'Only the supplied isolated image pixels are relevant.', priorities: [], anchors: [], truncations: [],
        uncertainties: held ? ['The far wheel has normal self-occlusion.', 'A background tree touches the image frame.'] : [],
        regions: [{ name: 'Whole vehicle', role: 'subject', rect: !initializing && options.shrinkReplan ? { x: 0.4, y: 0.45, width: 0.2, height: 0.2 } : { x: 0.3, y: 0.4, width: 0.4, height: 0.3 } }, { name: 'Visible badge', role: 'critical', rect: { x: 0.45, y: 0.5, width: 0.1, height: 0.08 } }],
        reason: 'Keep all native source protection inside the fixed safe area.', editPrompt: 'Extend only the existing background without altering the vehicle.' }
    } else {
      assert.equal(input.operation, 'wallpaper-review')
      const outputId = input.images.find(image => image.role === 'actual-wallpaper')!.imageVersionId
      reviewOutputIds.push(outputId)
      if (!initializing && sourceId === firstSourceId && options.failFirstContinuedReview && !continuedReviewFailed) { continuedReviewFailed = true; result = '{' }
      else if (initializing && sourceId === firstSourceId && scenario === 'review-format') result = '{'
      else {
        const rejected = rejectFinal && sourceId === firstSourceId
        result = { reviewVersion: 'wallpaper-review-source-v1', subject: 'Independent final-pixel review in an isolated fixture.',
          checks: Object.fromEntries([...wallpaperReviewKeys, 'clarity'].map(key => [key, { result: rejected && key === 'background' ? 'violated' : 'satisfied', reason: rejected && key === 'background' ? 'The actual final background still has a seam.' : 'Scripted final-pixel evidence only.' }])),
          issues: rejected ? [{ kind: 'background', reason: 'The visible final seam must remain blocked.' }] : [], styleResults: [],
          subjectIntegrity: { mode: 'single', source: { extent: 'complete', reason: 'Complete source.', imageVersionId: sourceId }, output: { extent: 'complete', reason: 'Complete output.', imageVersionId: outputId }, task: { result: 'satisfied', reason: 'Independent unchanged task check.' } } }
      }
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: typeof result === 'string' ? result : JSON.stringify(wallpaperFixtureResponse(JSON.parse(content[0]!.text!), result)) }, finish_reason: 'stop' }] })) }
  }
  const engine = new RunEngine(f.repository, f.jobs, undefined, undefined, undefined, undefined, run => {
    const saved = wallpaperStateSchema.safeParse(dataOf(run).checkpoint.wallpaper)
    if (saved.success && saved.data.items.some(item => item.decisions?.at(-1)?.status === 'running' && item.decisions.at(-1)?.input)) pendingDecisionCheckpoints.push(structuredClone(run))
    if (saved.success && saved.data.items.some(item => {
      const last = item.decisions?.at(-1)
      return last?.targetStage === 'detail' && item.detailInspection?.origin === 'decision'
    })) inspectionCheckpoints.push(structuredClone(run))
  })
  try {
    await f.service.initialize()
    const count = scenario === 'unknown-generation' || options.singleImage ? 1 : 2, files: { path: string; name: string }[] = []
    for (let index = 0; index < count; index++) {
      const bytes = await sharp({ create: { width: scenario === 'unknown-generation' ? 2400 : 1845, height: scenario === 'unknown-generation' ? 1800 : 3280, channels: 3, background: index === 0 ? '#587181' : '#63815b' } }).png().toBuffer()
      const path = join(f.root, `decision-source-${index}.png`); await writeFile(path, bytes); files.push({ path, name: `decision-source-${index}.png` })
    }
    const receipt = z.object({ runId: z.string() }).parse(await f.action('direct-crop-start', { operationId: 'legacy-batch', name: 'Isolated decision recovery', source: { kind: 'local', files } }))
    await f.jobs.drain()
    const initial = f.domain.require('run', receipt.runId), oldSpec = specOf(initial), settings = wallpaperSettingsSchema.parse(oldSpec.fixed.wallpaper), prompts = wallpaperPromptBundleSchema.parse(oldSpec.fixed.prompts)
    const legacyState = wallpaperStateSchema.parse(dataOf(initial).checkpoint.wallpaper)
    if (!options.autoDecision) {
      delete settings.decision; delete prompts.decision
      // These cases own the frozen V3 recovery behavior; current readiness has a separate real-response regression.
      prompts.detail = wallpaperPlanDetailPrompt
      for (const item of legacyState.items) for (const attempt of item.attempts) if (attempt.detailAnalysis) {
        const { requestId, outcome, protectedSubjectExtent } = attempt.detailAnalysis
        attempt.detailAnalysis = { version: 'wallpaper-plan-detail-v3', requestId, outcome, ...(protectedSubjectExtent ? { protectedSubjectExtent } : {}) }
      }
    }
    const fixed = { ...oldSpec.fixed, wallpaper: toJson(settings), prompts: toJson(prompts) }
    const old = runSchema.parse({ ...initial, data: toJson({ ...dataOf(initial), checkpoint: { ...dataOf(initial).checkpoint, wallpaper: toJson(legacyState) } }), spec: toJson({ ...oldSpec, fixed, specDigest: contentDigest({ ...oldSpec, fixed }) }) })
    const aggregateId = `run:${old.id}`
    await f.repository.commit({ aggregateId, expectedRevision: f.repository.manifest(aggregateId)!.revision, operationId: 'fixture-legacy-settings', request: {}, records: [old], state: { runId: old.id } })
    const before = structuredClone(f.domain.require('run', old.id)), state = wallpaperStateSchema.parse(dataOf(before).checkpoint.wallpaper)
    assert.notEqual(state.items[0]!.status, 'passed', JSON.stringify(dataOf(before).error ?? state.items[0]))
    if (count > 1) assert.equal(state.items[1]!.status, 'passed', JSON.stringify(dataOf(before).error ?? state.items[1]))
    f.service.config.wallpaper.decision = wallpaperDecisionSettingsSchema.parse({ enabled: true, maxRoundsPerImage: rounds, maxDetailRequests: 1 })
    const workflows = new WallpaperWorkflows({ domain: f.domain, files: f.files, engine, config: () => f.service.config, vision: async config => {
      const provider = await f.providers.vision(config)
      if (options.decisionMaxImages !== undefined) provider.config.maxImages = options.decisionMaxImages
      return provider
    }, source: f.providers.source, media: f.providers.media, llm, attachments, skill: () => ({ id: 'isolated-decision', content: 'Keep native source pixels and independent final review.' }) })
    const initialDecisionPackets = [...decisionPackets]
    initializing = false; operations.length = 0; decisionPackets.length = 0; reviewOutputIds.length = 0
    return { f, before, state, workflows, engine, operations, decisionPackets, initialDecisionPackets, reviewOutputIds, inspectionCheckpoints, pendingDecisionCheckpoints,
      setAction(value: typeof choose) { choose = value }, setInspection(value: typeof inspectedResult) { inspectedResult = value }, rejectReview() { rejectFinal = true }, get starts() { return starts }, get gets() { return gets },
      async resume(runId = before.id, operationId = 'decide-one') { const receipt = await workflows.continue({ runId, operationId, decision: { imageVersionId: state.items[0]!.imageVersionId } }, f.actor); await f.jobs.drain(); return f.domain.require('run', receipt.runId) },
      async cleanup() { await engine.dispose(); await f.cleanup(); await context.fiber.dispose() },
    }
  } catch (error) { await engine.dispose(); await f.cleanup(); await context.fiber.dispose(); throw error }
}

test('review composition and background concerns retain Host-owned scopes during routing', async () => {
  const t = await fixture('review-format')
  try {
    const item = t.state.items[0]!, attempt = item.attempts.at(-1)!
    attempt.review = wallpaperReviewSchema.parse({ subject: 'Saved product group', checks: Object.fromEntries(wallpaperReviewKeys.map(key => [key, { result: key === 'composition' || key === 'background' ? 'violated' : 'satisfied', reason: key === 'composition' ? 'Group is outside the planned position' : 'Visible background patch seam' }])), issues: [{ kind: 'layout', reason: 'Position failure' }, { kind: 'background', reason: 'Patch seam' }] })
    item.status = 'needs-review'; delete item.errorCode; delete item.failedStep; delete item.reason
    const updated = runSchema.parse({ ...t.before, data: toJson({ ...dataOf(t.before), checkpoint: { ...dataOf(t.before).checkpoint, wallpaper: t.state } }) })
    const aggregateId = 'run:' + updated.id
    await t.f.repository.commit({ aggregateId, expectedRevision: t.f.repository.manifest(aggregateId)!.revision, operationId: 'saved-product-quality-failures', request: {}, records: [updated], state: { runId: updated.id } })
    t.setAction(packet => {
      const concerns = packet.input.usage.decision!.concerns
      assert.equal(concerns.find(concern => concern.id === 'review:composition')?.scope, 'subject')
      assert.equal(concerns.find(concern => concern.id === 'review:background')?.scope, 'background')
      return { kind: 'manual_review' }
    })
    const run = await t.resume()
    const after = wallpaperStateSchema.parse(dataOf(run).checkpoint.wallpaper).items[0]!
    assert.equal(after.decisions?.at(-1)?.response?.action.kind, 'manual_review')
    assert.equal(after.status, 'needs-review')
    assert.equal(t.starts, 0, 'A decision cannot convert a content failure into another image automatically')
  } finally { await t.cleanup() }
})

test('a completed targeted continuation resumes an inherited unfinished decision at its existing final round', async () => {
  const t = await fixture('held', 1)
  try {
    t.setAction(() => ({ kind: 'manual_review' }))
    const completed = await t.resume(), captured = t.pendingDecisionCheckpoints[0]!
    assert.ok(captured)
    const state = wallpaperStateSchema.parse(dataOf(captured).checkpoint.wallpaper), item = state.items[0]!, pending = item.decisions!.at(-1)!
    pending.id += ':interrupted-fixture'
    assert.equal(pending.round, 1); assert.equal(pending.status, 'running'); assert.equal(item.status, 'planning')
    const before = structuredClone(item), other = structuredClone(state.items[1]!), frozen = specOf(captured)
    const input = { ...frozen.input, operationId: 'other-image-finished', continuationOf: completed.id, decidedImageId: other.imageVersionId }
    const fixed = { ...frozen.fixed, initialWallpaperState: toJson(state) }
    const spec = executionSchema.parse({ ...frozen, input, fixed, specDigest: contentDigest({ kind: frozen.kind, config: frozen.config, input, fixed }) })
    const parked = await t.engine.create(spec, t.f.actor, t.workflows.worker(), 'other-image-finished')
    await t.f.jobs.drain()
    const parent = structuredClone(t.f.domain.require('run', parked.id))
    const view = t.workflows.read(state.sourceRunId, t.f.actor, 0, 2, undefined, parked.id)
    assert.ok(view)
    assert.equal(view.status, 'completed'); assert.equal(view.workImageVersionId, other.imageVersionId); assert.equal(view.counts.planning, 0); assert.equal(view.counts.attention, 1)
    t.operations.length = 0; t.decisionPackets.length = 0
    const resumed = await t.resume(parked.id, 'resume-inherited-decision'), after = wallpaperStateSchema.parse(dataOf(resumed).checkpoint.wallpaper)
    assert.equal(resumed.status, 'completed'); assert.equal(after.items[0]!.decisions!.length, 1)
    assert.equal(after.items[0]!.decisions![0]!.id, before.decisions![0]!.id)
    assert.equal(after.items[0]!.decisions![0]!.round, 1); assert.deepEqual(after.items[0]!.decisions![0]!.input, before.decisions![0]!.input)
    assert.equal(after.items[0]!.decisions![0]!.status, 'manual'); assert.equal(after.items[0]!.status, 'needs-review')
    assert.equal(t.decisionPackets.length, 1); assert.deepEqual(after.items[1], other)
    assert.deepEqual(t.f.domain.require('run', parked.id), parent); assert.equal(t.starts, 0)
    assert.deepEqual({ task: resumed.status, decisionStatus: after.items[0]!.decisions![0]!.status, imageStatus: after.items[0]!.status,
      rounds: after.items[0]!.decisions!.length, round: after.items[0]!.decisions![0]!.round,
      reusedInput: contentDigest(after.items[0]!.decisions![0]!.input) === contentDigest(before.decisions![0]!.input),
      unchangedOtherImage: contentDigest(after.items[1]) === contentDigest(other), newImageGenerations: t.starts,
    }, JSON.parse(await readFile(new URL('./fixtures/wallpaper-interrupted-decision.expected.json', import.meta.url), 'utf8')))
  } finally { await t.cleanup() }
})

test('a settled wallpaper batch with an unresolved image can be cancelled without changing saved images or receipts', async () => {
  const t = await fixture('held', 1)
  try {
    t.setAction(() => ({ kind: 'manual_review' }))
    const latest = await t.resume(), before = structuredClone(t.f.domain.require('run', latest.id)), saved = wallpaperStateSchema.parse(dataOf(before).checkpoint.wallpaper)
    assert.equal(before.status, 'completed'); assert.equal(saved.items[0]!.status, 'needs-review'); assert.equal(saved.items[1]!.status, 'passed')
    await assert.rejects(t.f.action('wallpaper-control', { runId: t.before.id, command: 'cancel' }), { code: 'constraint-conflict' })
    assert.deepEqual(t.f.domain.require('run', t.before.id), t.before)
    const images = structuredClone(t.f.repository.list('imageVersion')), requests = structuredClone(t.f.repository.list('request')), selections = structuredClone(t.f.repository.list('selection')), assessments = structuredClone(t.f.repository.list('assessment'))
    await t.f.action('wallpaper-control', { runId: latest.id, command: 'cancel' })
    const after = t.f.domain.require('run', latest.id), state = wallpaperStateSchema.parse(dataOf(after).checkpoint.wallpaper)
    assert.equal(after.status, 'cancelled'); assert.equal(dataOf(after).autoResume, false)
    assert.deepEqual(state, saved); assert.deepEqual(t.f.repository.list('imageVersion'), images)
    assert.deepEqual(t.f.repository.list('request'), requests); assert.deepEqual(t.f.repository.list('selection'), selections); assert.deepEqual(t.f.repository.list('assessment'), assessments)
    await t.f.action('wallpaper-control', { runId: latest.id, command: 'cancel' })
    assert.deepEqual(t.f.domain.require('run', latest.id), after); assert.equal(t.starts, 0)
    assert.deepEqual({ status: after.status, autoResume: dataOf(after).autoResume,
      keptCheckpoint: contentDigest(state) === contentDigest(saved), keptImages: contentDigest(t.f.repository.list('imageVersion')) === contentDigest(images),
      keptReceipts: contentDigest(t.f.repository.list('request')) === contentDigest(requests),
      keptQualifications: contentDigest(t.f.repository.list('selection')) === contentDigest(selections) && contentDigest(t.f.repository.list('assessment')) === contentDigest(assessments), newImageGenerations: t.starts,
    }, JSON.parse(await readFile(new URL('./fixtures/wallpaper-cancel-pending.expected.json', import.meta.url), 'utf8')))
  } finally { await t.cleanup() }
})

test('cancelled current work can be removed while superseded paused snapshots and all image evidence remain intact', async () => {
  const t = await fixture('held', 1)
  try {
    const aggregateId = `run:${t.before.id}`, paused = runSchema.parse({ ...t.before, status: 'paused', data: toJson({ ...dataOf(t.before), autoResume: false }) })
    await t.f.repository.commit({ aggregateId, expectedRevision: t.f.repository.manifest(aggregateId)!.revision, operationId: 'fixture-paused-ancestor', request: {}, records: [paused], state: { runId: paused.id } })
    t.setAction(() => ({ kind: 'manual_review' }))
    const current = await t.resume()
    await t.f.action('wallpaper-control', { runId: current.id, command: 'cancel' })
    const markHistory = async (status: 'running' | 'paused') => {
      const old = t.f.domain.require('run', paused.id), aggregate = `run:${old.id}`
      const record = runSchema.parse({ ...old, status })
      await t.f.repository.commit({ aggregateId: aggregate, expectedRevision: t.f.repository.manifest(aggregate)!.revision, operationId: `fixture-history-${status}`, request: {}, records: [record], state: { runId: old.id } })
    }
    await markHistory('running')
    const blocked = z.object({ batches: z.array(z.object({ removable: z.boolean() })) }).parse(await t.f.action('direct-crop-list'))
    assert.equal(blocked.batches[0]!.removable, false)
    await assert.rejects(t.f.action('direct-crop-delete', { runId: t.before.id, operationId: 'cannot-remove-executing-history' }), { code: 'constraint-conflict' })
    await markHistory('paused')
    const before = contentDigest({ runs: t.f.repository.list('run'), images: t.f.repository.list('imageVersion'), assets: t.f.repository.list('asset'), requests: t.f.repository.list('request'), selections: t.f.repository.list('selection'), assessments: t.f.repository.list('assessment') })
    const list = z.object({ batches: z.array(z.object({ runId: z.string(), removable: z.boolean(), wallpaper: z.object({ status: z.string(), attention: z.number() }) })) }).parse(await t.f.action('direct-crop-list'))
    assert.equal(list.batches[0]!.wallpaper.status, 'cancelled')
    assert.equal(list.batches[0]!.removable, true); assert.equal(list.batches[0]!.wallpaper.attention, 0)
    assert.deepEqual(await t.f.action('direct-crop-delete', { runId: t.before.id, operationId: 'remove-cancelled-with-paused-history' }), { runId: t.before.id, deleted: true })
    assert.deepEqual(z.object({ batches: z.array(z.unknown()), total: z.number() }).parse(await t.f.action('direct-crop-list')), { batches: [], total: 0 })
    assert.equal(contentDigest({ runs: t.f.repository.list('run'), images: t.f.repository.list('imageVersion'), assets: t.f.repository.list('asset'), requests: t.f.repository.list('request'), selections: t.f.repository.list('selection'), assessments: t.f.repository.list('assessment') }), before)
    assert.equal(t.f.domain.require('run', paused.id).status, 'paused')
    assert.equal(t.f.domain.require('run', current.id).status, 'cancelled'); assert.equal(t.starts, 0)
    await assert.rejects(t.f.action('wallpaper-control',{runId:paused.id,command:'resume'}),{code:'constraint-conflict'})
    await assert.rejects(t.f.action('run-control',{runId:paused.id,command:'resume'}),{code:'constraint-conflict'})
    await assert.rejects(t.f.action('wallpaper-continue',{runId:current.id,operationId:'do-not-restart-cancelled'}),{code:'constraint-conflict'})
    assert.equal(t.starts,0)
    assert.deepEqual({status:list.batches[0]!.wallpaper.status,removable:list.batches[0]!.removable,attention:list.batches[0]!.wallpaper.attention,remainingBatches:0,
      pausedHistoryKept:t.f.domain.require('run',paused.id).status==='paused',
      evidenceKept:contentDigest({runs:t.f.repository.list('run'),images:t.f.repository.list('imageVersion'),assets:t.f.repository.list('asset'),requests:t.f.repository.list('request'),selections:t.f.repository.list('selection'),assessments:t.f.repository.list('assessment')})===before,
      newImageGenerations:t.starts,
    },JSON.parse(await readFile(new URL('./fixtures/wallpaper-cancel-delete.expected.json',import.meta.url),'utf8')))
  } finally { await t.cleanup() }
})

test('a fully qualified settled wallpaper batch rejects cancellation without changing its stored results', async () => {
  const t = await fixture('held', 1)
  try {
    const receipt = z.object({ runId: z.string() }).parse(await t.f.action('direct-crop-start', { operationId: 'fully-qualified-cancel-guard', name: 'Qualified cancellation guard', source: { kind: 'local', files: [{ path: join(t.f.root, 'decision-source-1.png'), name: 'qualified-source.png' }] } }))
    await t.f.jobs.drain()
    const completed = t.f.domain.require('run', receipt.runId), state = wallpaperStateSchema.parse(dataOf(completed).checkpoint.wallpaper)
    assert.ok(state.items.every(item => item.status === 'passed'))
    const requests = structuredClone(t.f.repository.list('request'))
    await assert.rejects(t.f.action('wallpaper-control', { runId: completed.id, command: 'cancel' }), { code: 'constraint-conflict' })
    assert.deepEqual(t.f.domain.require('run', completed.id), completed); assert.deepEqual(t.f.repository.list('request'), requests)
    assert.equal(t.starts, 0)
  } finally { await t.cleanup() }
})

test('legacy opt-in decides only the held image, preserves the old run and still blocks a failed final review', async () => {
  const t = await fixture('held', 2, { maxReworks: 1 })
  try {
    t.rejectReview()
    t.setAction((_packet, round) => round === 1 ? { kind: 'continue_current_plan' } : { kind: 'manual_review' })
    const oldOther = structuredClone(t.state.items[1]), oldRegions = structuredClone(t.state.items[0]!.attempts[0]!.plan.regions)
    const child = await t.resume(), state = wallpaperStateSchema.parse(dataOf(child).checkpoint.wallpaper), item = state.items[0]!
    assert.notEqual(child.id, t.before.id); assert.deepEqual(t.f.domain.require('run', t.before.id), t.before)
    assert.equal(wallpaperSettingsSchema.parse(specOf(t.before).fixed.wallpaper).decision, undefined)
    assert.equal(wallpaperSettingsSchema.parse(specOf(child).fixed.wallpaper).decision?.enabled, true)
    assert.equal(wallpaperPromptBundleSchema.parse(specOf(t.before).fixed.prompts).decision, undefined)
    assert.equal(wallpaperPromptBundleSchema.parse(specOf(child).fixed.prompts).decision?.version, 'wallpaper-decision-v1')
    assert.deepEqual(state.items[1], oldOther); assert.deepEqual(item.attempts[0]!.plan.regions, oldRegions)
    assert.ok(t.decisionPackets.length >= 1 && t.decisionPackets.length <= 2); assert.equal(item.decisions?.[0]?.response?.action.kind, 'continue_current_plan')
    if (item.decisions!.length > 1) assert.equal(item.decisions?.[1]?.response?.action.kind, 'manual_review')
    assert.ok(item.attempts.at(-1)!.outputId, 'The real renderer must create final pixels after continuation.')
    assert.equal(t.reviewOutputIds.length, 1); assert.notEqual(item.status, 'passed')
    assert.equal(item.attempts.at(-1)!.review?.checks.background.result, 'violated')
    assert.ok(!t.f.repository.list('assessment').some(row => row.runId === child.id && row.imageVersionId === item.attempts.at(-1)!.outputId && row.verdict === 'pass'))
    assert.ok(!t.f.repository.list('selection').some(row => row.runId === child.id && row.imageVersionId === item.attempts.at(-1)!.outputId))
    assert.equal(t.starts, 0)
    assert.deepEqual({
      operations: t.operations.map(packet => packet.input.operation),
      decisions: item.decisions!.map(record => ({ round: record.round, status: record.status, action: record.response!.action.kind, sourceStage: record.sourceStage, targetStage: record.targetStage })),
      itemStatus: item.status, otherStatus: state.items[1]!.status,
      finalBackground: item.attempts.at(-1)!.review!.checks.background.result,
      originalDetail: item.attempts[0]!.detailAnalysis!.outcome,
      outputDetail: item.attempts.at(-1)!.detailAnalysis!.outcome,
      imageStarts: t.starts,
    }, routingSnapshot)
  } finally { await t.cleanup() }
})

test('ordinary legacy continuation never opts into the current decision policy', async () => {
  const t = await fixture()
  try {
    const receipt = await t.workflows.continue({ runId: t.before.id, operationId: 'ordinary-legacy-continue' }, t.f.actor)
    await t.f.jobs.drain()
    const child = t.f.domain.require('run', receipt.runId), item = wallpaperStateSchema.parse(dataOf(child).checkpoint.wallpaper).items[0]!
    assert.equal(t.decisionPackets.length, 0); assert.equal(item.decisions, undefined)
    assert.equal(wallpaperSettingsSchema.parse(specOf(child).fixed.wallpaper).decision, undefined)
    assert.notEqual(item.status, 'passed'); assert.equal(item.attempts.at(-1)!.outputId, undefined)
    assert.deepEqual(t.f.domain.require('run', t.before.id), t.before); assert.equal(t.starts, 0)
  } finally { await t.cleanup() }
})

test('a real source-frame truncation cannot be converted into continue_current_plan', async () => {
  const t = await fixture('cut-off', 2, { autoDecision: true })
  try {
    assert.equal(t.state.items[0]!.status, 'rejected')
    assert.equal(t.state.items[1]!.status, 'passed')
    assert.equal(t.initialDecisionPackets.length, 0)
    await assert.rejects(t.resume(), { code: 'constraint-conflict', stage: 'wallpaper-decision' })
    assert.equal(t.state.items[0]!.attempts.at(-1)!.outputId, undefined); assert.equal(t.decisionPackets.length, 0)
    assert.equal(t.reviewOutputIds.length, 0); assert.equal(t.starts, 0)
    assert.deepEqual(t.f.domain.require('run', t.before.id), t.before)
  } finally { await t.cleanup() }
})

test('one additional native detail returns to decision and never repeats the same inspection indefinitely', async () => {
  const t = await fixture('held', 2, { decisionMaxImages: 2 })
  try {
    t.setAction((packet, round) => round === 1 ? { kind: 'inspect_region', rect: { x: 0.76, y: 0.04, width: 0.23, height: 0.23 }, concernIds: [packet.input.usage.decision!.concerns.find(concern => concern.text.includes('tree'))!.id] } : { kind: 'manual_review' })
    const child = await t.resume(), state = wallpaperStateSchema.parse(dataOf(child).checkpoint.wallpaper), item = state.items[0]!
    assert.equal(t.decisionPackets.length, 2)
    assert.deepEqual(t.operations.map(p => p.input.operation), ['wallpaper-decision', 'wallpaper-plan', 'wallpaper-decision'])
    assert.equal(t.operations[1]!.input.images.length, 2)
    assert.equal(item.detailInspection?.status, 'unresolved')
    assert.equal(item.decisions?.filter(record => record.response?.action.kind === 'inspect_region').length, 1)
    const views = t.decisionPackets[1]!.input.usage.imageRepresentations ?? []
    assert.ok(views.some(view => view.sourceRect && view.sourceRect.x >= 0.75 && view.sourceRect.y < 0.1), 'The second decision must receive the newly requested native source region.')
    assert.notEqual(item.status, 'passed'); assert.equal(t.reviewOutputIds.length, 0); assert.equal(t.starts, 0)
    const again = await t.resume(child.id, 'decision-limit-again'), resumed = wallpaperStateSchema.parse(dataOf(again).checkpoint.wallpaper).items[0]!
    assert.equal(t.decisionPackets.length, 2); assert.equal(resumed.decisions?.length, item.decisions?.length)
    assert.notEqual(resumed.status, 'passed')
  } finally { await t.cleanup() }
})

test('an exhausted legacy planning decision hands off once to subject-scoped inspection and independent review', async () => {
  const t = await fixture('held', 1, { singleImage: true })
  try {
    t.setAction(() => ({ kind: 'manual_review' }))
    const old = await t.resume(), data = dataOf(old), state = wallpaperStateSchema.parse(data.checkpoint.wallpaper)
    const item = state.items[0]!, attempt = item.attempts.at(-1)!
    assert.equal(item.decisions?.length, 1)
    delete item.detailInspection
    attempt.detailAnalysis = { version: 'wallpaper-plan-detail-v2', requestId: attempt.detailAnalysis!.requestId, outcome: 'violated' }
    const recorded = runSchema.parse({ ...old, data: toJson({ ...data, checkpoint: { ...data.checkpoint, wallpaper: toJson(state) } }) })
    const aggregateId = 'run:' + old.id
    await t.f.repository.commit({ aggregateId, expectedRevision: t.f.repository.manifest(aggregateId)!.revision, operationId: 'legacy-background-violation', request: {}, records: [recorded], state: { runId: old.id } })
    t.setInspection('resolved'); t.operations.length = 0
    const child = await t.resume(old.id, 'inspect-after-exhaustion'), result = wallpaperStateSchema.parse(dataOf(child).checkpoint.wallpaper).items[0]!
    assert.equal(result.status, 'passed', result.reason)
    assert.equal(result.decisions?.length, 1); assert.equal(result.detailInspection?.status, 'resolved')
    assert.equal(result.detailInspection?.origin, 'decision'); assert.equal(result.detailInspection?.decisionRoundAtStart, 1)
    assert.ok(result.attempts.at(-1)?.review); assert.equal(result.originalId, item.originalId)
    assert.deepEqual(t.operations.map(p => p.input.operation), ['wallpaper-plan', 'wallpaper-review'])
    const statuses = t.inspectionCheckpoints.map(r => wallpaperStateSchema.parse(dataOf(r).checkpoint.wallpaper).items[0]!.detailInspection!.status)
    assert.ok(statuses.indexOf('queued') >= 0 && statuses.indexOf('running') > statuses.indexOf('queued') && statuses.indexOf('resolved') > statuses.indexOf('running'))
    assert.equal(t.starts, 0)
  } finally { await t.cleanup() }
})

test('a failed native inspection retains its decision link and reports the inspection failure without another model turn', async () => {
  const t = await fixture('held', 2, { singleImage: true })
  try {
    t.setInspection('failed')
    t.setAction(packet => ({ kind: 'inspect_region', rect: { x: 0.76, y: 0.04, width: 0.23, height: 0.23 }, concernIds: [packet.input.usage.decision!.concerns[0]!.id] }))
    const child = await t.resume(), result = wallpaperStateSchema.parse(dataOf(child).checkpoint.wallpaper).items[0]!
    assert.equal(result.status, 'technical-failed')
    assert.equal(result.detailInspection?.status, 'failed'); assert.equal(result.detailInspection.errorCode, 'vision-invalid-output')
    assert.ok(result.detailInspection.reason); assert.equal(result.detailInspection.decisionId, result.decisions?.[0]?.id)
    assert.deepEqual(t.operations.map(p => p.input.operation), ['wallpaper-decision', 'wallpaper-plan'])
    assert.equal(t.starts, 0); assert.equal(result.attempts.at(-1)?.outputId, undefined)
  } finally { await t.cleanup() }
})

test('a technical review decision reuses the same saved output and never rerenders or generates', async () => {
  const t = await fixture('review-format')
  try {
    assert.equal(t.state.items[0]!.failedStep, 'reviewing')
    const outputId = t.state.items[0]!.attempts.at(-1)!.outputId!
    t.setAction(() => ({ kind: 'retry_saved_review' }))
    const child = await t.resume(), item = wallpaperStateSchema.parse(dataOf(child).checkpoint.wallpaper).items[0]!
    assert.equal(item.status, 'passed', item.reason); assert.equal(item.attempts.at(-1)!.outputId, outputId)
    assert.deepEqual(t.reviewOutputIds, [outputId]); assert.ok(!t.operations.some(packet => packet.input.operation === 'wallpaper-plan'))
    assert.equal(t.starts, 0); assert.deepEqual(t.f.domain.require('run', t.before.id), t.before)
  } finally { await t.cleanup() }
})

test('continued source approval survives a review-only revision with identical saved source evidence', async () => {
  const t = await fixture('held', 2, { maxReworks: 1, singleImage: true, failFirstContinuedReview: true })
  try {
    const original = structuredClone(t.state.items[0]!), originalAttempt = original.attempts[0]!
    assert.equal(originalAttempt.detailAnalysis?.outcome, 'unresolved')
    t.setAction((_packet, round) => round === 1 ? { kind: 'continue_current_plan' } : { kind: 'retry_saved_review' })
    const child = await t.resume(), state = wallpaperStateSchema.parse(dataOf(child).checkpoint.wallpaper), item = state.items[0]!
    assert.equal(state.items.length, 1); assert.equal(item.status, 'passed', item.reason)
    assert.equal(t.decisionPackets.length, 2)
    assert.deepEqual(item.decisions!.map(record => record.response!.action.kind), ['continue_current_plan', 'retry_saved_review'])
    assert.equal(item.attempts.length, 3)
    const rendered = item.attempts[1]!, reviewed = item.attempts[2]!
    assert.ok(rendered.outputId); assert.equal(reviewed.outputId, rendered.outputId)
    assert.deepEqual(t.reviewOutputIds, [rendered.outputId, rendered.outputId])
    assert.equal(reviewed.review?.checks.background.result, 'satisfied')
    assert.equal(item.originalId, original.originalId); assert.deepEqual(item.attempts[0], originalAttempt)
    assert.deepEqual(rendered.plan, reviewed.plan); assert.deepEqual(rendered.plan.regions, originalAttempt.plan.regions)
    assert.deepEqual(rendered.detailAnalysis, originalAttempt.detailAnalysis)
    assert.deepEqual(reviewed.detailAnalysis, originalAttempt.detailAnalysis)
    assert.equal(t.starts, 0); assert.equal(t.gets, 0)
    assert.deepEqual(t.f.domain.require('run', t.before.id), t.before)
  } finally { await t.cleanup() }
})

test('a two-slot decision keeps the saved original and output without requesting a detail view', async () => {
  const t = await fixture('review-format', 2, { singleImage: true, decisionMaxImages: 2 })
  try {
    const prior = t.state.items[0]!, outputId = prior.attempts.at(-1)!.outputId!
    const original = structuredClone(t.f.domain.require('imageVersion', prior.originalId!)), output = structuredClone(t.f.domain.require('imageVersion', outputId))
    t.setAction(() => ({ kind: 'manual_review' }))
    const child = await t.resume(), item = wallpaperStateSchema.parse(dataOf(child).checkpoint.wallpaper).items[0]!
    assert.equal(t.decisionPackets.length, 1)
    assert.deepEqual(t.decisionPackets[0]!.input.images.map(image => image.role), ['wallpaper-original', 'actual-wallpaper'])
    assert.equal(item.decisions!.length, 1); assert.equal(item.decisions![0]!.response!.action.kind, 'manual_review'); assert.equal(item.decisions![0]!.status, 'manual')
    assert.equal(item.originalId, prior.originalId); assert.equal(item.attempts.at(-1)!.outputId, outputId)
    assert.deepEqual(t.f.domain.require('imageVersion', original.id), original); assert.deepEqual(t.f.domain.require('imageVersion', output.id), output)
    assert.deepEqual(specOf(child).config.limits, specOf(t.before).config.limits)
    assert.equal(t.reviewOutputIds.length, 0); assert.equal(t.starts, 0); assert.deepEqual(t.f.domain.require('run', t.before.id), t.before)
  } finally { await t.cleanup() }
})

test('a saved applied region inspection resumes the next decision before any replanning', async () => {
  const t = await fixture('held', 2, { singleImage: true })
  try {
    const rect = { x: 0.76, y: 0.04, width: 0.23, height: 0.23 }
    t.setAction((packet, round) => round === 1 ? { kind: 'inspect_region', rect, concernIds: [packet.input.usage.decision!.concerns.find(concern => concern.text.includes('tree'))!.id] } : { kind: 'manual_review' })
    const completed = await t.resume(), captured = t.inspectionCheckpoints[0]!
    assert.ok(captured, 'Capture the real durable save between the inspection action and its next decision.')
    const saved = wallpaperStateSchema.parse(dataOf(captured).checkpoint.wallpaper), prior = saved.items[0]!
    assert.equal(prior.status, 'planning'); assert.equal(prior.decisions!.length, 1)
    assert.equal(prior.decisions![0]!.status, 'applied'); assert.deepEqual(prior.decisions![0]!.detailRect, rect)
    const frozen = specOf(captured), input = { ...frozen.input, operationId: 'resume-applied-inspection', continuationOf: completed.id }
    const fixed = { ...frozen.fixed, initialWallpaperState: toJson(saved) }
    const spec = executionSchema.parse({ ...frozen, input, fixed, specDigest: contentDigest({ kind: frozen.kind, config: frozen.config, input, fixed }) })
    t.operations.length = 0; t.decisionPackets.length = 0; t.reviewOutputIds.length = 0
    t.setAction(() => ({ kind: 'manual_review' }))
    const receipt = await t.engine.create(spec, t.f.actor, t.workflows.worker(), 'resume-applied-inspection')
    await t.f.jobs.drain()
    const resumed = t.f.domain.require('run', receipt.id), item = wallpaperStateSchema.parse(dataOf(resumed).checkpoint.wallpaper).items[0]!
    assert.deepEqual(t.operations.map(packet => packet.input.operation), ['wallpaper-decision'])
    assert.equal(item.decisions!.length, 2); assert.deepEqual(item.decisions![0], prior.decisions![0])
    assert.equal(item.decisions![1]!.response!.action.kind, 'manual_review')
    const views = t.decisionPackets[0]!.input.usage.imageRepresentations ?? []
    assert.ok(views.some(view => view.sourceRect && view.sourceRect.x >= 0.75 && view.sourceRect.y < 0.1), 'Recovery must include the persisted requested region in the next decision.')
    assert.deepEqual(item.attempts, wallpaperStateSchema.parse(dataOf(completed).checkpoint.wallpaper).items[0]!.attempts); assert.notEqual(item.status, 'passed')
    assert.equal(t.starts, 0); assert.deepEqual(t.f.domain.require('run', completed.id), completed)
  } finally { await t.cleanup() }
})

test('an explicit decision child retains an exhausted parent budget and dispatches no new model call', async () => {
  const t = await fixture('held', 2, { singleImage: true })
  try {
    const old = t.f.domain.require('run', t.before.id), spec = specOf(old), data = dataOf(old)
    const budget = { ...data.budget, vision: spec.config.limits.maxVisionCalls, search: 1, downloadBytes: 77 }
    const exhausted = runSchema.parse({ ...old, revision: old.revision + 1, data: toJson({ ...data, budget }) })
    const aggregateId = `run:${old.id}`
    await t.f.repository.commit({ aggregateId, expectedRevision: t.f.repository.manifest(aggregateId)!.revision, operationId: 'exhaust-isolated-parent-budget', request: {}, records: [exhausted], state: { runId: old.id } })
    const child = await t.resume()
    assert.deepEqual(dataOf(child).budget, budget)
    assert.equal(child.outcome, 'budget-exhausted'); assert.equal(t.operations.length, 0); assert.equal(t.decisionPackets.length, 0)
    assert.deepEqual(specOf(child).config.limits, spec.config.limits)
    assert.equal(specOf(child).input.continuationOf, old.id); assert.equal(t.starts, 0)
    assert.deepEqual(t.f.domain.require('run', old.id), exhausted)
  } finally { await t.cleanup() }
})

test('a decision child adds actual vision use to its parent counters without extending the deadline', async () => {
  const t = await fixture('held', 2, { maxReworks: 1, singleImage: true })
  try {
    const before = dataOf(t.before).budget
    assert.ok(before.vision > 0)
    t.setAction(() => ({ kind: 'continue_current_plan' }))
    const child = await t.resume(), after = dataOf(child).budget, item = wallpaperStateSchema.parse(dataOf(child).checkpoint.wallpaper).items[0]!
    assert.equal(item.status, 'passed', item.reason); assert.equal(t.decisionPackets.length, 1); assert.equal(t.reviewOutputIds.length, 1)
    assert.equal(after.vision, before.vision + t.operations.length)
    assert.equal(after.search, before.search); assert.equal(after.downloadBytes, before.downloadBytes); assert.equal(after.deadlineAt, before.deadlineAt)
    assert.deepEqual(specOf(child).config.limits, specOf(t.before).config.limits)
    assert.equal(t.starts, 0); assert.deepEqual(t.f.domain.require('run', t.before.id), t.before)
  } finally { await t.cleanup() }
})

test('an unknown accepted image operation can only be queried and never posted again', async () => {
  const t = await fixture('unknown-generation')
  try {
    const prior = t.state.items[0]!.attempts.at(-1)!, starts = t.starts, reads = t.gets
    assert.ok(prior.generation); assert.equal(starts, 1)
    t.setAction(() => ({ kind: 'query_saved_generation' }))
    const child = await t.resume(), item = wallpaperStateSchema.parse(dataOf(child).checkpoint.wallpaper).items[0]!
    assert.ok(t.gets > reads); assert.equal(t.starts, starts)
    assert.deepEqual(item.attempts.at(-1)!.generation, prior.generation)
    assert.equal(item.edits, t.state.items[0]!.edits); assert.notEqual(item.status, 'passed'); assert.equal(item.attempts.at(-1)!.outputId, undefined)
    assert.deepEqual(t.f.domain.require('run', t.before.id), t.before)
  } finally { await t.cleanup() }
})

test('decision rounds survive continuation and cannot reset to gain more model calls', async () => {
  const t = await fixture('held', 1)
  try {
    t.setAction(() => ({ kind: 'manual_review' }))
    const child = await t.resume(), before = wallpaperStateSchema.parse(dataOf(child).checkpoint.wallpaper).items[0]!
    assert.equal(t.decisionPackets.length, 1); assert.equal(before.decisions?.length, 1)
    const next = await t.resume(child.id, 'no-extra-round'), after = wallpaperStateSchema.parse(dataOf(next).checkpoint.wallpaper).items[0]!
    assert.equal(t.decisionPackets.length, 1); assert.deepEqual(after.decisions, before.decisions)
    assert.notEqual(after.status, 'passed'); assert.equal(t.starts, 0)
  } finally { await t.cleanup() }
})

test('a decision replan forwards guidance, retains every original protection region and reaches independent review', async () => {
  const t = await fixture('held', 2, { maxReworks: 1, shrinkReplan: true })
  try {
    const guidance = 'Keep the original wheel protection and continuous horizon; never move or redraw the vehicle.'
    t.setAction(() => ({ kind: 'replan', guidance }))
    const child = await t.resume(), item = wallpaperStateSchema.parse(dataOf(child).checkpoint.wallpaper).items[0]!
    const planRequest = t.operations.find(packet => packet.input.operation === 'wallpaper-plan' && !packet.input.usage.priorPlan)
    assert.ok(planRequest); assert.equal(planRequest.input.usage.decisionGuidance, guidance)
    assert.equal(item.attempts.length, 2); assert.deepEqual(item.attempts[1]!.plan.regions, t.state.items[0]!.attempts[0]!.plan.regions)
    assert.equal(item.decisions?.[0]?.response?.action.kind, 'replan'); assert.equal(item.status, 'passed', item.reason)
    assert.equal(t.reviewOutputIds.length, 1); assert.equal(t.starts, 0)
    assert.deepEqual(t.f.domain.require('run', t.before.id), t.before)
  } finally { await t.cleanup() }
})

test('a new batch freezes the default decision policy and automatically routes an unresolved detail', async () => {
  const t = await fixture('held', 2, { autoDecision: true })
  try {
    const settings = wallpaperSettingsSchema.parse(specOf(t.before).fixed.wallpaper), prompts = wallpaperPromptBundleSchema.parse(specOf(t.before).fixed.prompts)
    assert.equal(settings.decision?.enabled, true); assert.equal(settings.decision.maxRoundsPerImage, 2)
    assert.equal(prompts.decision?.version, 'wallpaper-decision-v2'); assert.equal(t.initialDecisionPackets.length, 1)
    assert.equal(t.state.items[0]!.decisions?.[0]?.response?.action.kind, 'manual_review')
    assert.notEqual(t.state.items[0]!.status, 'passed'); assert.equal(t.state.items[1]!.status, 'passed')
    assert.equal(t.starts, 0)
  } finally { await t.cleanup() }
})
