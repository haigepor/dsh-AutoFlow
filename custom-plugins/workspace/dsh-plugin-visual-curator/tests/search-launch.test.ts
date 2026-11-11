import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, stat, mkdir, rename, symlink, unlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { serviceFixture } from './helpers/service-fixture.ts'
import { searchLaunchViewSchema } from '../src/shared/search-launch.ts'
import type { NativeSearchSessions } from '../src/host/native-search-session.ts'
import type { SessionTaskSnapshot } from '@deepseek-ai/dsh-api-session-controller/types'
import { taskPresentationSchema } from '../src/shared/task-presentation.ts'
import { deliverSearchResults, originalSearchResult } from '../src/host/search-results.ts'
import { AssetFiles } from '../src/media/index.ts'
import { BudgetLedger, dataOf, specOf, toJson, type ExecutionSpec } from '../src/host/runtime.ts'
import { SearchLaunches } from '../src/host/search-launch.ts'
import { RunEngine } from '../src/host/runtime.ts'
import { modelProfileSchema, profileExportSchema, runSchema, imageVersionSchema, assessmentSchema, selectionSchema, type RunRecord } from '../src/shared/model.ts'
import { ModelProfiles } from '../src/domain/model-profile.ts'
import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { createAgentTools } from '../src/host/tools.ts'
import { importedRecords } from '../src/host/imports.ts'
import { wallpaperSettingsSchema, wallpaperStateSchema, wallpaperPlanSchema, wallpaperReviewKeys, wallpaperReviewSchema } from '../src/shared/wallpaper.ts'
import { wallpaperPromptBundle } from '../src/shared/wallpaper-prompts.ts'
import { contentDigest } from '../src/domain/repository.ts'

class NativeFixture implements NativeSearchSessions {
  readonly presentations: SessionTaskSnapshot[] = []
  failPresentation = false
  async present(_id: string, snapshot: SessionTaskSnapshot) {
    if (this.failPresentation) throw new Error('Presentation acknowledgement unavailable')
    this.presentations.push(structuredClone(snapshot))
  }
  path = ''; created: string[] = []; messages: { sessionId: string; requestId: string; text: string; bytes: Uint8Array }[] = []; cancelled: string[] = []
  fail: 'create-ack' | 'attach' | 'prompt-ack' | 'cancel' | undefined
  readonly sessions = new SessionStore(new Context())
  readonly selectedModels: { sessionId: string; provider: string; model: string }[] = []
  workspaces() { return [{ id: 'workspace', title: 'Photos', path: this.path }] }
  async models() { return { conversationModels: [{ provider: 'fixture', model: 'default', label: 'Default' }, { provider: 'fixture', model: 'alternate', label: 'Alternate' }], defaultConversationModel: { provider: 'fixture', model: 'default' } } }
  async selectModel(sessionId: string, model: { provider: string; model: string }) { this.selectedModels.push({ sessionId, ...model }) }
  async preflight() { return this.workspaces()[0]! }
  async ensure(_target: unknown, id: string) {
    if (!this.created.includes(id)) { this.created.push(id); this.sessions.create(brandString<import('@deepseek-ai/dsh-session').SessionId>(id), { meta: { cwd: this.path } }) }
    if (this.fail === 'create-ack') { this.fail = undefined; throw new Error('Lost creation acknowledgement') }
  }
  async accepted(id: string, requestId: string) { return this.messages.some(item => item.sessionId === id && item.requestId === requestId) }
  failure() { return undefined }
  async name() {}
  async submit(sessionId: string, requestId: string, text: string, _name: string, bytes: Uint8Array) {
    if (this.fail === 'attach') { this.fail = undefined; throw new Error('Attachment unavailable') }
    if (!await this.accepted(sessionId, requestId)) this.messages.push({ sessionId, requestId, text, bytes })
    if (this.fail === 'prompt-ack') { this.fail = undefined; throw new Error('Lost prompt acknowledgement') }
  }
  async cancel(id: string) { if (this.fail === 'cancel') { this.fail = undefined; throw new Error('Cancel was not acknowledged') } this.cancelled.push(id) }
}

async function wallpaperHandoffFixture(targetCount = 1) {
  const setupValue = await setup(), { f, native, input, profile, settled } = setupValue
  await f.action('search-launch-start', { ...input, targetCount, wallpaper: true })
  const launch = await settled(), actor = { kind: 'agent' as const, id: 'wallpaper-reader', sessionId: launch.sessionId, profileId: f.profileId }
  const sourceFiles = await f.files.importBytes(f.http.image, 'image/png'), imported = importedRecords(f.profileId, actor, sourceFiles, { kind: 'provider', providerId: 'images', accountIdentity: '', providerAssetId: 'handoff-photo', description: 'Handoff source', obtainedAt: '2026-11-07T00:00:00.000Z' })
  const outputFiles = await f.files.importBytes(await sharp({ create: { width: 1845, height: 3280, channels: 3, background: '#536f53' } }).png().toBuffer(), 'image/png')
  const output = imageVersionSchema.parse({ ...imported.image, id: 'handoff-wallpaper-output', versionKind: 'composition', parentImageVersionId: imported.image.id, blob: outputFiles.normalized.blob, geometry: { ...imported.image.geometry, width: 1845, height: 3280 } })
  const sourceSpec: ExecutionSpec = { kind: 'search', config: f.service.config, input: { targetCount, taskBrief: input.taskBrief, queries: ['green forest'] }, fixed: { release: toJson(profile), output: { kind: 'original' }, wallpaperAuto: true }, specDigest: contentDigest('handoff-source') }
  const data = { attemptId: 'fixture-attempt', attempts: 1, budget: new BudgetLedger(sourceSpec.config.limits).snapshot(), checkpoint: {}, counts: { qualified: 1 }, warnings: [], requestIds: [], resultIds: [] }
  const source = runSchema.parse({ schemaVersion: 1, profileId: f.profileId, id: 'handoff-search', createdAt: '2026-11-07T00:00:00.000Z', kind: 'run', owner: { kind: 'session', sessionId: actor.sessionId }, revision: 1, status: 'completed', stage: 'finalizing', outcome: targetCount === 1 ? 'target-met' : 'source-exhausted', spec: toJson(sourceSpec), data })
  const sourceAssessment = assessmentSchema.parse({ schemaVersion: 1, profileId: f.profileId, id: 'handoff-source-assessment', createdAt: source.createdAt, kind: 'assessment', runId: source.id, imageVersionId: imported.image.id, stage: 'final', releaseId: profile.id, recipeId: profile.recipe.id, reviewBundleId: 'source-review', technicalStatus: 'completed', verdict: 'pass', ruleResults: [], cropPotential: 'direct', preferenceScores: {}, data: {} })
  const sourceSelection = selectionSchema.parse({ schemaVersion: 1, profileId: f.profileId, id: 'handoff-source-selection', createdAt: source.createdAt, kind: 'selection', runId: source.id, imageVersionId: imported.image.id, assessmentId: sourceAssessment.id, qualification: 'auto-qualified', rank: 0, warnings: [] })
  await f.repository.commit({ aggregateId: 'handoff-source', expectedRevision: 0, operationId: 'seed-source', request: {}, records: [source, ...imported.records, output, sourceAssessment, sourceSelection], state: {} })
  const settings = wallpaperSettingsSchema.parse({}), plan = wallpaperPlanSchema.parse({ version: 1, imageVersionId: imported.image.id, mode: 'single', subject: 'Green source', evidence: 'Saved source pixels.', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [{ name: 'subject', role: 'subject', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }], placement: { scale: 1, left: 600, top: 1130 }, reason: 'Saved layout.' })
  const childSpec: ExecutionSpec = { kind: 'crop', config: f.service.config, input: { workflow: 'wallpaper-v1', operationId: 'handoff-wallpaper', sourceRunId: source.id, imageVersionIds: [imported.image.id], targetCount: 1, taskBrief: input.taskBrief }, fixed: { release: toJson(profile), wallpaper: toJson(settings), sourceSessionId: actor.sessionId, skill: { id: 'fixture-skill', content: 'Preserve source.' }, prompts: toJson(wallpaperPromptBundle()) }, specDigest: contentDigest('handoff-wallpaper') }
  let child: RunRecord | undefined
  const read = async (id = source.id, reader = actor) => f.service.action({ operation: 'run-get', args: { runId: id } }, reader, new AbortController().signal)
  return { ...setupValue, actor, source, sourceSpec, childSpec, output, imported, read, get child() { return child! }, async putChild(mode: 'running' | 'rejected' | 'passed') {
    const review = mode === 'running' ? undefined : wallpaperReviewSchema.parse({ subject: 'Green source.', checks: Object.fromEntries(wallpaperReviewKeys.map(key => [key, { result: mode === 'rejected' && key === 'background' ? 'violated' : 'satisfied', reason: 'Saved independent review.' }])), issues: mode === 'rejected' ? [{ kind: 'background', reason: 'Visible seam.' }] : [] })
    const state = wallpaperStateSchema.parse({ version: 1, sourceRunId: source.id, skillVersion: 'fixture-skill', items: [{ imageVersionId: imported.image.id, originalId: imported.image.id, familyId: imported.asset.familyId, status: mode === 'running' ? 'rendering' : mode === 'passed' ? 'passed' : 'needs-review', edits: 1, attempts: [{ revision: 1, plan, checks: [], needsOutpaint: true, outputId: output.id, ...(review ? { review } : {}) }] }] })
    child = runSchema.parse({ ...source, id: 'handoff-wallpaper', createdAt: '2026-11-07T00:00:01.000Z', owner: { kind: 'profile' }, revision: (child?.revision ?? 0) + 1, status: mode === 'running' ? 'running' : 'completed', stage: mode === 'running' ? 'cropping' : 'finalizing', ...(mode === 'running' ? { outcome: undefined } : { outcome: mode === 'passed' ? 'target-met' : 'source-exhausted' }), spec: toJson(childSpec), data: toJson({ ...data, jobId: 'wallpaper-job', checkpoint: { wallpaper: toJson(state) } }) })
    const assessment = assessmentSchema.parse({ ...sourceAssessment, id: 'handoff-wallpaper-assessment', runId: child.id, imageVersionId: output.id })
    const selected = selectionSchema.parse({ ...sourceSelection, id: 'handoff-wallpaper-selection', runId: child.id, imageVersionId: output.id, assessmentId: assessment.id })
    await f.repository.commit({ aggregateId: 'handoff-child', expectedRevision: f.repository.manifest('handoff-child')?.revision ?? 0, operationId: `child-${mode}`, request: {}, records: [child, ...(mode === 'passed' ? [assessment, selected] : [])], state: {} })
  } }
}

test('a completed wallpaper search exposes its real pending, running, rejected and passed child without claiming intermediate originals as completion', async () => {
  const f = await wallpaperHandoffFixture()
  const viewSchema = z.object({ wallpaperRequired: z.literal(true), workflowComplete: z.boolean(), wallpaper: z.object({ runId: z.string(), artifactStorage: z.literal('profile'), status: z.string(), passed: z.number(), complete: z.boolean(), targetWidth: z.number(), targetHeight: z.number(), counts: z.record(z.string(), z.number()), outputs: z.array(z.object({ imageVersionId: z.string(), sourceImageVersionId: z.string(), sourceName: z.string(), outputKind: z.string(), width: z.number(), height: z.number(), review: z.string().nullable(), passed: z.boolean(), previewPath: z.string() })) }).nullable() })
  try {
    assert.match(f.native.messages[0]!.text, /original 表示保留来源原图，不表示跳过后续壁纸规划/)
    assert.match(f.native.messages[0]!.text, /找图 Run completed 不能代表整条工作流完成/)
    assert.match(f.native.messages[0]!.text, /1845×3280/)
    assert.match(f.native.messages[0]!.text, /wallpaper.artifactStorage=profile/)
    assert.match(f.native.messages[0]!.text, /通过 outputs\[\]\.previewPath 或工作台查看和下载，不在 source delivery 原图目录/)
    assert.match(f.native.messages[0]!.text, /不要把 source 原图作为最终壁纸或 deliverables/)
    assert.match(f.native.messages[0]!.text, /sourceImageVersionId 关联来源.*sourceName.*outputKind.*不要按数组序号/)
    assert.match(f.native.messages[0]!.text, /新子任务或派生成品 ID 不代表重新生图.*outputs\[\]\.inherited.*cumulativeImageEdits 是历史累计次数，不是本次调用数/)
    assert.match(f.native.messages[0]!.text, /configuredDeadlineMs\/deadlineMs 是配置，不是实耗时；native-model 且 deadlineEnforced=false 不承诺该时限内完成/)
    assert.doesNotMatch(f.native.messages[0]!.text, /输出：保留来源原图，不裁剪/)
    const pending = viewSchema.parse(await f.read())
    assert.equal(pending.wallpaper, null); assert.equal(pending.workflowComplete, false)
    await f.putChild('running')
    const running = viewSchema.parse(await f.read())
    assert.equal(running.wallpaper!.runId, f.child.id); assert.equal(running.wallpaper!.status, 'running'); assert.equal(running.workflowComplete, false)
    const childRunning = viewSchema.parse(await f.read(f.child.id))
    assert.equal(childRunning.wallpaper!.counts.planned, 1); assert.equal(childRunning.wallpaper!.counts.rendered, 1); assert.equal(childRunning.wallpaper!.counts.reviewed, 0)
    assert.deepEqual([childRunning.wallpaper!.outputs[0]!.width, childRunning.wallpaper!.outputs[0]!.height], [1845, 3280])
    await f.putChild('rejected')
    const rejected = viewSchema.parse(await f.read())
    assert.equal(rejected.workflowComplete, false); assert.equal(rejected.wallpaper!.counts.reviewingFailed, 1); assert.equal(rejected.wallpaper!.outputs[0]!.review, 'reject')
    await f.putChild('passed')
    const passed = viewSchema.parse(await f.read())
    assert.equal(passed.workflowComplete, true); assert.equal(passed.wallpaper!.passed, 1)
    const childPassed = viewSchema.parse(await f.read(f.child.id))
    assert.equal(childPassed.workflowComplete, true); assert.equal(childPassed.wallpaper!.outputs[0]!.passed, true)
    const artifact = childPassed.wallpaper!.outputs[0]!
    assert.equal(artifact.sourceImageVersionId, f.imported.image.id)
    assert.equal(artifact.imageVersionId, f.output.id)
    assert.deepEqual({ artifactStorage: childPassed.wallpaper!.artifactStorage, sourceName: artifact.sourceName, outputKind: artifact.outputKind, width: artifact.width, height: artifact.height, passed: artifact.passed }, JSON.parse(await readFile(new URL('./fixtures/wallpaper-handoff-output.expected.json', import.meta.url), 'utf8')))
    const ownerView = viewSchema.parse(await f.f.action('run-get', { runId: f.child.id }))
    assert.equal(ownerView.workflowComplete, true)
    assert.ok(new URL(ownerView.wallpaper!.outputs[0]!.previewPath, 'http://fixture').searchParams.has('sessionToken'))
    const tool = createAgentTools(f.f.service).find(tool => tool.name === 'visual_run_get')!
    // The tool adapter reads only Agent identity; the real service owns all task and image authorization.
    const execution: ToolRunContext = { callId: ToolCallId('wallpaper-read'), rootCallId: ToolCallId('wallpaper-read'), name: tool.name, arguments: { runId: f.child.id }, token: Symbol('wallpaper-read') as ToolExecutionToken, agent: { id: brandString<import('@deepseek-ai/dsh-session').SessionId>(f.actor.sessionId) } as NonNullable<ToolRunContext['agent']>, signal: new AbortController().signal, deferContext() {}, concludeTurn() {} }
    const toolResult = await tool.execute({ runId: f.child.id }, execution)
    const modelArtifact = viewSchema.parse(JSON.parse(String(toolResult))).wallpaper!.outputs[0]!
    assert.equal(modelArtifact.passed, true); assert.equal(modelArtifact.sourceName, 'Handoff source'); assert.equal(modelArtifact.outputKind, 'composition')
    const path = childPassed.wallpaper!.outputs[0]!.previewPath
    assert.ok(new URL(path, 'http://fixture').searchParams.has('sessionToken'))
    const resource = await f.f.service.resource(new Request(`http://fixture${path}`))
    assert.equal(resource.status, 200); await resource.body?.cancel()
    await f.native.ensure(undefined, 'other-session')
    const grant = z.object({ sessionToken: z.string() }).parse(await f.f.action('session-open', { sessionId: 'other-session' }))
    const otherPath = new URL(path, 'http://fixture'); otherPath.searchParams.set('sessionToken', grant.sessionToken)
    assert.equal((await f.f.service.resource(new Request(otherPath))).status, 403)
    const noGrant = new URL(path, 'http://fixture'); noGrant.searchParams.delete('sessionToken')
    assert.equal((await f.f.service.resource(new Request(noGrant))).status, 403)
    await assert.rejects(f.f.service.action({ operation: 'wallpaper-continue', args: { runId: f.child.id, operationId: 'agent-control' } }, f.actor, new AbortController().signal), { code: 'owner-denied' })
  } finally { await f.f.cleanup() }
})

test('wallpaper output names and saved kinds stay attached to source IDs when item order changes', async () => {
  const f = await wallpaperHandoffFixture(2)
  try {
    await f.putChild('passed')
    const second = importedRecords(f.f.profileId, f.actor, await f.f.files.importBytes(f.f.http.image, 'image/png'), { kind: 'local-import', description: '' })
    const crop = imageVersionSchema.parse({ ...f.output, id: 'handoff-pure-crop', assetId: second.asset.id, parentImageVersionId: second.image.id, versionKind: 'crop' })
    const state = wallpaperStateSchema.parse(dataOf(f.child).checkpoint.wallpaper), first = state.items[0]!, attempt = first.attempts[0]!
    state.items.unshift({ ...first, imageVersionId: second.image.id, originalId: second.image.id, familyId: second.asset.familyId, edits: 0, attempts: [{ ...attempt, plan: { ...attempt.plan!, imageVersionId: second.image.id }, needsOutpaint: false, outputId: crop.id }] })
    const child = runSchema.parse({ ...f.child, revision: f.child.revision + 1, data: toJson({ ...dataOf(f.child), checkpoint: { wallpaper: toJson(state) } }) })
    const assessment = assessmentSchema.parse({ ...f.f.domain.require('assessment', 'handoff-wallpaper-assessment'), id: 'handoff-crop-assessment', imageVersionId: crop.id })
    const selection = selectionSchema.parse({ ...f.f.domain.require('selection', 'handoff-wallpaper-selection'), id: 'handoff-crop-selection', imageVersionId: crop.id, assessmentId: assessment.id })
    await f.f.repository.commit({ aggregateId: 'handoff-child', expectedRevision: f.f.repository.manifest('handoff-child')!.revision, operationId: 'reverse-items', request: {}, records: [child, ...second.records, crop, assessment, selection], state: {} })
    const view = z.object({ wallpaper: z.object({ artifactStorage: z.literal('profile'), outputs: z.array(z.object({ imageVersionId: z.string(), sourceImageVersionId: z.string(), sourceName: z.string(), outputKind: z.string() })) }) }).parse(await f.read(child.id))
    assert.deepEqual(view.wallpaper.outputs, [
      { imageVersionId: crop.id, sourceImageVersionId: second.image.id, sourceName: second.asset.id, outputKind: 'crop' },
      { imageVersionId: f.output.id, sourceImageVersionId: f.imported.image.id, sourceName: 'Handoff source', outputKind: 'composition' },
    ])
  } finally { await f.f.cleanup() }
})

test('wallpaper child observation rejects other Sessions, profiles, mismatched parents and unrelated profile-owned tasks', async () => {
  const f = await wallpaperHandoffFixture()
  try {
    await f.putChild('running')
    await assert.rejects(f.read(f.child.id, { ...f.actor, sessionId: 'other-session' }), { code: 'owner-denied' })
    await assert.rejects(f.read(f.child.id, { ...f.actor, profileId: 'other-profile' }), { code: 'owner-denied' })
    const otherParent = runSchema.parse({ ...f.source, id: 'other-parent', owner: { kind: 'session', sessionId: 'other-session' } })
    const cropParent = runSchema.parse({ ...f.source, id: 'crop-parent', spec: toJson({ ...f.sourceSpec, kind: 'crop' }) })
    await f.f.repository.commit({ aggregateId: 'other-parents', expectedRevision: 0, operationId: 'seed-other-parents', request: {}, records: [otherParent, cropParent], state: {} })
    for (const mode of ['source-session', 'unknown-parent', 'other-parent', 'crop-parent', 'not-wallpaper', 'state-parent'] as const) {
      const spec = { ...f.childSpec, input: { ...f.childSpec.input, ...(mode === 'not-wallpaper' ? { workflow: 'crop' } : mode.includes('parent') && mode !== 'state-parent' ? { sourceRunId: mode } : {}) }, fixed: { ...f.childSpec.fixed, ...(mode === 'source-session' ? { sourceSessionId: 'other-session' } : {}) } }
      const data = dataOf(f.child)
      if (mode === 'state-parent') data.checkpoint.wallpaper = toJson({ ...wallpaperStateSchema.parse(data.checkpoint.wallpaper), sourceRunId: 'other-parent' })
      const forged = runSchema.parse({ ...f.child, id: `forged-${mode}`, spec: toJson(spec), data: toJson(data) })
      await f.f.repository.commit({ aggregateId: `forged-${mode}`, expectedRevision: 0, operationId: `forged-${mode}`, request: {}, records: [forged], state: {} })
      await assert.rejects(f.read(forged.id), { code: 'owner-denied' }, mode)
    }
  } finally { await f.f.cleanup() }
})

test('a passed wallpaper child retains a partial search outcome and rejects a wrong-size artifact as workflow completion', async () => {
  const f = await wallpaperHandoffFixture(2)
  const summary = z.object({ workflowComplete: z.boolean(), wallpaper: z.object({ requestedCount: z.number(), total: z.number(), passed: z.number() }) })
  try {
    await f.putChild('passed')
    for (const id of [f.source.id, f.child.id]) {
      const view = summary.parse(await f.read(id))
      assert.equal(view.workflowComplete, false); assert.equal(view.wallpaper.requestedCount, 2); assert.equal(view.wallpaper.passed, 1)
    }
    const state = wallpaperStateSchema.parse(dataOf(f.child).checkpoint.wallpaper)
    state.items[0]!.attempts.at(-1)!.outputId = f.imported.image.id
    const invalid = runSchema.parse({ ...f.child, id: 'wrong-size-wallpaper', createdAt: '2026-11-07T00:00:02.000Z', data: toJson({ ...dataOf(f.child), checkpoint: { wallpaper: toJson(state) } }) })
    const selection = selectionSchema.parse({ schemaVersion: 1, profileId: f.f.profileId, id: 'wrong-size-selection', createdAt: invalid.createdAt, kind: 'selection', runId: invalid.id, imageVersionId: f.imported.image.id, assessmentId: 'wrong-size-assessment', qualification: 'auto-qualified', rank: 0, warnings: [] })
    await f.f.repository.commit({ aggregateId: 'wrong-size-wallpaper', expectedRevision: 0, operationId: 'wrong-size-wallpaper', request: {}, records: [invalid, selection], state: {} })
    const view = summary.parse(await f.read(invalid.id))
    assert.equal(view.workflowComplete, false); assert.equal(view.wallpaper.passed, 0)
  } finally { await f.f.cleanup() }
})

async function setup(previewSource = false, negativeCount = 0) {
  const native = new NativeFixture(), f = await serviceFixture(undefined, {}, { nativeSessions: native }, previewSource ? { provider: 'unsplash' } : {})
  native.path = f.root
  f.host.sessions.get = id => native.sessions.get(id)
  await f.service.initialize()
  const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'style', name: 'Green photos' }))
  const negatives = await Promise.all(Array.from({ length: negativeCount }, async (_, index) => ({ name: `negative-${index}.png`, mime: 'image/png', base64: (await sharp({ create: { width: 80, height: 40, channels: 3, background: { r: 50 + index * 30, g: 25, b: 35 } } }).png().toBuffer()).toString('base64'), role: 'negative', intent: 'overall', dimensions: [] })))
  const reference = await sharp({ create: { width: 80, height: 40, channels: 3, background: { r: 30, g: 140, b: 35 } } }).png().toBuffer()
  await f.action('reference-import', { operationId: 'reference', styleId, expectedRevision: 1, files: [{ name: 'ref.png', mime: 'image/png', base64: reference.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }, ...negatives] })
  await f.action('reference-analyze', { operationId: 'analysis', styleId, buildDataset: true }); await f.jobs.drain()
  const profile = f.repository.list('modelProfile')[0]!
  assert.ok(profile)
  const datasetId = f.repository.list('profileExport').find(item => item.modelProfileId === profile.id && !item.sampleScope)!.id
  const input = { operationId: randomUUID(), workspaceId: 'workspace', modelProfileId: profile.id, datasetId, taskBrief: 'Find muted green landscapes.', targetCount: 1, output: { kind: 'original' } }
  const settled = async () => {
    for (let i = 0; i < 100; i++) {
      const values = z.array(searchLaunchViewSchema).parse(await f.action('search-launch-list'))
      if (values.length && values.every(item => item.status !== 'working')) return values[0]!
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('Launch did not settle')
  }
  return { f, native, profile, styleId, input, settled }
}

test('workflow presentation precedes execution and display retries never submit a conversation turn', async () => {
  const { f, native, input, settled } = await setup()
  try {
    const start = f.jobs.start
    f.jobs.start = spec => {
      assert.ok(native.presentations.some(snapshot => taskPresentationSchema.parse(snapshot.data).type === 'launch'))
      return start(spec)
    }
    const args = { ...input, executionMode: 'workflow' }
    await f.action('search-launch-start', args)
    await f.action('search-launch-start', args)
    const launch = await settled()
    assert.equal(launch.status, 'accepted')
    await f.jobs.drain()
    const calls = f.http.operations.length
    await f.action('search-launch-presentation', { id: input.operationId })
    await f.action('search-launch-presentation', { id: input.operationId })
    const searchRuns = f.repository.list('run').filter(run => run.owner.kind === 'session' && run.owner.sessionId === launch.sessionId && specOf(run).kind === 'search')
    assert.equal(searchRuns.length, 1)
    assert.equal(searchRuns[0]?.status, 'completed')
    assert.equal(dataOf(searchRuns[0]!).counts.qualified, 1)
    assert.equal(native.created.length, 1); assert.equal(native.messages.length, 0)
    assert.equal(f.http.operations.length, calls)
    assert.ok(native.presentations.every(snapshot => snapshot.taskId === input.operationId))
    assert.ok(native.presentations.some(snapshot => taskPresentationSchema.parse(snapshot.data).type === 'run'))
    const stopped = searchLaunchViewSchema.parse(await f.action('search-launch-stop', { id: input.operationId }))
    assert.equal(stopped.status, 'stopped')
    assert.ok(native.presentations.some(snapshot => { const data = taskPresentationSchema.parse(snapshot.data); return data.type === 'launch' && data.status === 'stopped' }))
    await assert.rejects(f.action('search-launch-resume', { id: input.operationId }), /stopped/)
  } finally { await f.cleanup() }
})

test('an unacknowledged first display checkpoint resumes the same launch before creating its Run', async () => {
  const { f, native, input, settled } = await setup()
  try {
    native.failPresentation = true
    await f.action('search-launch-start', { ...input, executionMode: 'workflow' })
    const failed = await settled()
    assert.equal(failed.status, 'failed'); assert.equal(failed.sessionReady, true)
    assert.equal(failed.runIds.length, 0); assert.equal(native.messages.length, 0)
    native.failPresentation = false
    await f.action('search-launch-resume', { id: input.operationId })
    const accepted = await settled()
    assert.equal(accepted.sessionId, failed.sessionId)
    assert.equal(accepted.status, 'accepted'); assert.equal(accepted.runIds.length, 1)
    assert.equal(native.created.length, 1); assert.equal(native.messages.length, 0)
  } finally { await f.cleanup() }
})

test('legacy Session-scoped datasets remain selectable and reusable in another Session and model', async () => {
  const { f, native, input, profile, styleId, settled } = await setup()
  try {
    const legacyProfile = modelProfileSchema.parse({ ...profile, id: 'legacy-session-profile',
      createdAt: new Date(Date.parse(profile.createdAt) + 1).toISOString(),
      access: { kind: 'session-run', sessionId: 'original-session' } })
    await f.repository.commit({ aggregateId: 'legacy-session-profile', expectedRevision: 0, operationId: 'legacy-session-profile', request: {}, records: [legacyProfile], state: {} })
    const profiles = new ModelProfiles(f.domain)
    const exported = await profiles.export(legacyProfile, 'legacy-export-source', { ...f.actor, sessionId: 'original-session' })
    const dataset = profileExportSchema.parse({ ...exported, id: 'legacy-session-export', access: legacyProfile.access })
    await f.repository.commit({ aggregateId: 'legacy-session-export', expectedRevision: 0, operationId: 'legacy-session-export', request: {}, records: [dataset], state: {} })
    assert.equal(profiles.current(styleId, { ...f.actor, sessionId: 'new-session' })?.id, legacyProfile.id)
    const choices = z.object({ entries: z.array(z.object({ exportId: z.string(), styleId: z.string(), duplicateExports: z.array(z.object({ exportId: z.string() })).optional() })) }).parse(
      await f.action('search-launch-datasets', { styleId, modelProfileId: legacyProfile.id }))
    assert.ok(choices.entries.some(item => item.exportId === dataset.id || item.duplicateExports?.some(copy => copy.exportId === dataset.id)))
    assert.ok(choices.entries.every(item => item.styleId === styleId))
    assert.equal(z.object({ exportId: z.string() }).parse(await f.action('export-get', { exportId: dataset.id })).exportId, dataset.id)
    assert.equal((await f.service.resource(new Request(`https://fixture.invalid/api/visual-curator/resource?exportId=${dataset.id}`, { method: 'HEAD' }))).status, 200)
    await f.action('search-launch-start', { ...input, modelProfileId: legacyProfile.id, datasetId: dataset.id,
      conversationModel: { provider: 'fixture', model: 'alternate' } })
    const accepted = await settled()
    assert.equal(accepted.status, 'accepted'); assert.equal(accepted.datasetId, dataset.id)
    assert.notEqual(accepted.sessionId, 'original-session')
    assert.equal(native.selectedModels[0]?.model, 'alternate')
    assert.equal(JSON.parse(Buffer.from(native.messages[0]!.bytes).toString('utf8')).export, dataset.id)
    assert.throws(() => profiles.authorizeDataset(legacyProfile, dataset.id, { ...f.actor, profileId: 'foreign-profile' }), { code: 'owner-denied' })
  } finally { await f.cleanup() }
})

test('a new Session samples completed mismatches at Run admission even when its launch and preparation were earlier', async () => {
  const { f, input, settled } = await setup()
  try {
    f.http.mode = 'reject-final'
    const first = searchLaunchViewSchema.parse(await f.action('search-launch-start', input)); await settled()
    const second = searchLaunchViewSchema.parse(await f.action('search-launch-start', { ...input, operationId: randomUUID() })); await settled()
    assert.notEqual(first.sessionId, second.sessionId)
    const actor = (sessionId: string) => ({ kind: 'agent' as const, id: sessionId, sessionId, profileId: f.profileId })
    const args = { releaseId: input.modelProfileId, sourceId: 'images', taskBrief: input.taskBrief, targetCount: input.targetCount, output: input.output }
    const prepared = z.object({ status: z.literal('ready'), preparationDigest: z.string() }).passthrough().parse(await f.service.action({ operation: 'task-prepare', args: { ...args, kind: 'search' } }, actor(second.sessionId), new AbortController().signal))
    const firstRun = z.object({ runId: z.string() }).parse(await f.service.action({ operation: 'search-start', args: { ...args, operationId: 'first-review' } }, actor(first.sessionId), new AbortController().signal))
    await f.jobs.drain()
    assert.ok(f.repository.list('assessment').some(row => row.runId === firstRun.runId && row.stage === 'final' && row.technicalStatus === 'completed' && row.verdict === 'reject'))
    const before = f.http.operations.filter(operation => operation.startsWith('review:')).length
    const secondRun = z.object({ runId: z.string() }).parse(await f.service.action({ operation: 'search-start', args: { ...args, operationId: 'second-review', preparationDigest: prepared.preparationDigest } }, actor(second.sessionId), new AbortController().signal))
    await f.jobs.drain()
    assert.equal(f.http.operations.filter(operation => operation.startsWith('review:')).length, before, 'Already completed mismatches must be filtered before another paid review')
    assert.equal(dataOf(f.domain.require('run', secondRun.runId)).counts.excludedPrevious, 1)
    assert.equal(f.repository.list('selection').filter(row => row.runId === secondRun.runId).length, 0)
  } finally { await f.cleanup() }
})

test('automatic preparation freezes collection negative datasets across Sessions without duplicate images', async () => {
  const { f, native, input, profile, styleId, settled } = await setup(false, 2), commit = f.repository.commit.bind(f.repository)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    const profiles = new ModelProfiles(f.domain)
    await profiles.export(profile, 'negative-a', f.actor, { sampleScope: 'negative' })
    await profiles.export(profile, 'negative-b', f.actor, { sampleScope: 'negative' })
    await profiles.export(profile, 'negative-private', { ...f.actor, sessionId: 'private' }, { sampleScope: 'negative' })
    const current = await profiles.save({ operationId: 'new-profile', styleId, analysisRunId: profile.analysisRunId, expectedProfileId: profile.id, changes: [{ ruleId: profile.options[0]!.rule.ruleId, enabled: true, statement: 'Prefer muted green with visible detail.' }] }, f.actor)
    const options = z.object({ entries: z.array(z.unknown()), negativeReferences: z.object({ datasets: z.number(), references: z.number() }) }).parse(await f.action('search-launch-datasets', { styleId, modelProfileId: current.id }))
    assert.equal(options.entries.length, 1, 'Previously completed full datasets remain selectable after profile changes')
    assert.deepEqual(options.negativeReferences, { datasets: 1, references: 2 })
    f.repository.commit = async request => { if (request.records.some(record => record.kind === 'profileExport' && record.modelProfileId === current.id && !record.sampleScope)) { entered.resolve(); await release.promise }; return await commit(request) }
    const { datasetId: oldDataset, ...draft } = input
    const automatic = { ...draft, modelProfileId: current.id, autoPrepareDataset: true, includeNegativeDatasets: true }
    const receipt = searchLaunchViewSchema.parse(await f.action('search-launch-start', automatic))
    await entered.promise
    const preparing = z.array(searchLaunchViewSchema).parse(await f.action('search-launch-list'))[0]!
    assert.equal(preparing.stage, 'preparing-dataset')
    assert.deepEqual(native.created, [receipt.sessionId])
    assert.equal(native.messages.length, 0)
    await profiles.export(current, 'negative-after-admission', f.actor, { sampleScope: 'negative' })
    release.resolve()
    const accepted = await settled(), dataset = f.domain.require('profileExport', accepted.datasetId!)
    assert.equal(dataset.modelProfileId, current.id)
    assert.equal(dataset.access.kind, 'profile-library')
    const attachment = z.object({ negativeReferences: z.object({ datasets: z.array(z.object({ exportId: z.string() })), samples: z.array(z.object({ reference: z.object({ role: z.literal('negative'), imageVersionId: z.string() }), inferred: z.array(z.unknown()) })) }) }).parse(JSON.parse(Buffer.from(native.messages[0]!.bytes).toString('utf8')))
    assert.equal(attachment.negativeReferences.datasets.length, 1, 'Late packages must not change admitted references')
    assert.equal(attachment.negativeReferences.samples.length, 2)
    assert.equal(new Set(attachment.negativeReferences.samples.map(sample => sample.reference.imageVersionId)).size, 2)
    assert.ok(attachment.negativeReferences.samples.every(sample => sample.inferred.length > 0))
    assert.ok(native.messages[0]!.text.includes('negativeReferences'))
    await f.action('search-launch-start', automatic); await settled()
    assert.equal(native.created.length, 1); assert.equal(native.messages.length, 1)
    assert.equal(f.repository.list('profileExport').filter(item => item.modelProfileId === current.id && !item.sampleScope).length, 1)
    assert.ok(f.domain.require('profileExport', oldDataset))
  } finally { release.resolve(); f.repository.commit = commit; await f.cleanup() }
})

test('automatic preparation reuses an existing complete package and does not republish without launch authorization', async () => {
  const { f, input, profile, settled } = await setup()
  try {
    const { datasetId, ...draft } = input
    await f.action('search-launch-start', { ...draft, autoPrepareDataset: true, includeNegativeDatasets: true })
    assert.equal((await settled()).datasetId, datasetId)
    assert.equal(f.repository.list('profileExport').length, 1)
    await assert.rejects(new ModelProfiles(f.domain).export(profile, 'unapproved-library-export', f.actor, { shareWithLibrary: true }), { code: 'owner-denied' })
  } finally { await f.cleanup() }
})

test('launch dataset choices share verified directory reads and the service package-size cache', async context => {
  const { f, profile, styleId } = await setup(false, 2)
  try {
    await new ModelProfiles(f.domain).export(profile, 'negative-choice', f.actor, { sampleScope: 'negative' })
    await f.action('datasets-list', { styleId })
    const serializing = context.mock.method(JSON, 'stringify'), listing = context.mock.method(f.repository, 'list')
    const choices = z.object({ total: z.number(), negativeReferences: z.object({ datasets: z.number(), references: z.number() }) }).parse(await f.action('search-launch-datasets', { styleId, modelProfileId: profile.id }))
    assert.equal(choices.total, 1); assert.deepEqual(choices.negativeReferences, { datasets: 1, references: 2 })
    assert.equal(listing.mock.calls.filter(call => call.arguments[0] === 'modelProfile').length, 1)
    assert.equal(listing.mock.calls.filter(call => call.arguments[0] === 'profileExport').length, 1)
    assert.equal(serializing.mock.calls.filter(call => { const value = call.arguments[0]; return value && typeof value === 'object' && 'formatVersion' in value && value.formatVersion === 2 && 'export' in value && 'files' in value }).length, 0)
  } finally { await f.cleanup() }
})

test('automatic package generation recovers from failure without creating another Session or export', async () => {
  const { f, native, input, profile, styleId, settled } = await setup(), commit = f.repository.commit.bind(f.repository)
  let fail = true
  try {
    const current = await new ModelProfiles(f.domain).save({ operationId: 'retry-profile', styleId, analysisRunId: profile.analysisRunId, expectedProfileId: profile.id, changes: [{ ruleId: profile.options[0]!.rule.ruleId, enabled: true, statement: 'Prefer muted green and natural detail.' }] }, f.actor)
    f.repository.commit = async request => { if (fail && request.records.some(record => record.kind === 'profileExport' && record.modelProfileId === current.id)) { fail = false; throw new Error('Package storage temporarily unavailable') }; return await commit(request) }
    const { datasetId, ...draft } = input
    const automatic = { ...draft, modelProfileId: current.id, autoPrepareDataset: true, includeNegativeDatasets: true }
    await f.action('search-launch-start', automatic)
    assert.equal((await settled()).status, 'failed')
    assert.equal(native.created.length, 1)
    await f.action('search-launch-start', automatic)
    assert.equal((await settled()).status, 'accepted')
    assert.equal(native.created.length, 1); assert.equal(native.messages.length, 1)
    assert.equal(f.repository.list('profileExport').filter(item => item.modelProfileId === current.id).length, 1)
  } finally { f.repository.commit = commit; await f.cleanup() }
})

test('observation-only exports cannot start a style-search conversation', async () => {
  const { f, native, input, profile } = await setup()
  try {
    const observations = await new ModelProfiles(f.domain).export(profile, 'positive-observations', f.actor, { sampleScope: 'positive' })
    await assert.rejects(f.action('search-launch-start', { ...input, datasetId: observations.id }), { code: 'constraint-conflict' })
    const privateObservations = await new ModelProfiles(f.domain).export(profile, 'private-observations', { ...f.actor, sessionId: 'private' }, { sampleScope: 'positive' })
    await assert.rejects(f.action('search-launch-start', { ...input, datasetId: privateObservations.id }), { code: 'constraint-conflict' })
    assert.equal(native.created.length, 0)
  } finally { await f.cleanup() }
})

test('a chosen conversation model is frozen and is not selected again after acknowledgement', async () => {
  const { f, native, input, settled } = await setup()
  try {
    const conversationModel = { provider: 'fixture', model: 'alternate' }, selected = { ...input, conversationModel }
    await f.action('search-launch-start', selected)
    const receipt = await settled()
    assert.deepEqual(receipt.input.conversationModel, conversationModel)
    assert.deepEqual(native.selectedModels, [{ sessionId: receipt.sessionId, ...conversationModel }])
    await f.action('search-launch-start', selected); await settled()
    assert.equal(native.selectedModels.length, 1)
    assert.equal(native.messages.length, 1)
  } finally { await f.cleanup() }
})

test('launch progress reaches attaching only after the native Session exists and is scoped to that Session', async () => {
  const { f, native, input, settled } = await setup()
  const ensureEntered = Promise.withResolvers<void>(), releaseEnsure = Promise.withResolvers<void>(), namingEntered = Promise.withResolvers<void>(), releaseNaming = Promise.withResolvers<void>()
  const ensure = native.ensure.bind(native)
  native.ensure = async (...args) => { ensureEntered.resolve(); await releaseEnsure.promise; await ensure(...args) }
  native.name = async () => { namingEntered.resolve(); await releaseNaming.promise }
  const launches = new SearchLaunches({ domain: f.domain, files: new AssetFiles(join(f.root, 'visual-curator'), { maxFileBytes: 1000000, maxPixels: 80000000, maxDimension: 20000, previewMaxDimension: 1280, maxStorageBytes: 4294967296 }), engine: new RunEngine(f.repository, f.jobs), signal: new AbortController().signal, native: () => native, freeze: async () => { throw new Error('Reading launch progress cannot resolve current defaults') } })
  try {
    const receipt = searchLaunchViewSchema.parse(await f.action('search-launch-start', input))
    await ensureEntered.promise
    assert.equal(launches.forSession(receipt.sessionId)?.stage, 'creating-session')
    assert.equal(native.created.length, 0)
    assert.equal(launches.forSession('another-session'), undefined)
    releaseEnsure.resolve()
    await namingEntered.promise
    assert.equal(launches.forSession(receipt.sessionId)?.stage, 'attaching')
    assert.deepEqual(native.created, [receipt.sessionId])
    assert.equal(native.messages.length, 0)
    releaseNaming.resolve()
    const accepted = await settled()
    assert.equal(launches.forSession(receipt.sessionId)?.status, 'accepted')
    assert.equal(accepted.sessionId, receipt.sessionId)
  } finally { releaseEnsure.resolve(); releaseNaming.resolve(); await f.cleanup() }
})

test('native preview launch requests a subject-and-style query plan and preparation preserves it', async () => {
  const { f, native, input, styleId, settled } = await setup(true)
  try {
    await f.action('search-launch-start', { ...input, output: { kind: 'preview' } })
    const launch = await settled()
    assert.equal(launch.status, 'accepted')
    assert.match(native.messages[0]!.text, /short English queries/)
    assert.match(native.messages[0]!.text, /at most half the search-page budget/)
    assert.match(native.messages[0]!.text, /saved pixel reviews to deepen productive directions/)
    assert.match(native.messages[0]!.text, /partial keyword matches/)
    assert.match(native.messages[0]!.text, /use architecture only when an enabled rule or group calls for it/)
    assert.match(native.messages[0]!.text, /50- or 100-candidate pool is retrieval within the same run/)
    assert.match(native.messages[0]!.text, /do not raise budgets or start a second search/)
    assert.match(native.messages[0]!.text, /不下载原图/)
    assert.ok(native.messages[0]!.text.includes(`styleId：${styleId}`))
    assert.match(native.messages[0]!.text, /afp_\* tools operate a separate AFP service/)
    assert.match(native.messages[0]!.text, /without visual_style_list or fetching a newer profile/)
    const actor = { kind: 'agent' as const, id: launch.sessionId, sessionId: launch.sessionId, profileId: f.profileId }
    const args = { kind: 'search', releaseId: input.modelProfileId, taskBrief: input.taskBrief, targetCount: 1, output: { kind: 'preview' }, queries: ['muted green forest soft light', 'misty landscape natural light'] }
    const result = z.object({ status: z.literal('ready'), normalizedInput: z.object({ queries: z.array(z.string()), output: z.object({ kind: z.literal('preview') }) }), preparationDigest: z.string() }).parse(await f.service.action({ operation: 'task-prepare', args }, actor, new AbortController().signal))
    assert.deepEqual(result.normalizedInput.queries, args.queries)
    assert.equal(result.normalizedInput.output.kind, 'preview')
    await f.action('search-launch-stop', { id: launch.id })
    await assert.rejects(f.service.action({ operation: 'task-prepare', args }, actor, new AbortController().signal), /stopped/)
  } finally { await f.cleanup() }
})

test('native original search preserves its explicit query plan through preparation and execution', async () => {
  const { f, native, input, settled } = await setup()
  try {
    await f.action('search-launch-start', input)
    const launch = await settled(), actor = { kind: 'agent' as const, id: launch.sessionId, sessionId: launch.sessionId, profileId: f.profileId }
    const frozen = JSON.parse(native.messages[0]!.text.split('固定参数：')[1]!.split('\n')[0]!)
    assert.equal('queries' in frozen, false, 'Historical hints must not compete with the requested query plan')
    const queries = ['forest landscape', 'green valley']
    const args = { kind: 'search', releaseId: input.modelProfileId, taskBrief: input.taskBrief, targetCount: 1, output: { kind: 'original' }, queries }
    const checked = z.object({ status: z.literal('ready'), normalizedInput: z.record(z.string(), z.json()), preparationDigest: z.string() }).parse(await f.service.action({ operation: 'task-prepare', args }, actor, new AbortController().signal))
    assert.deepEqual(checked.normalizedInput.queries, queries)
    const receipt = z.object({ runId: z.string() }).parse(await f.service.action({ operation: 'search-start', args: { ...checked.normalizedInput, operationId: 'explicit-original-plan', preparationDigest: checked.preparationDigest } }, actor, new AbortController().signal))
    await f.jobs.drain()
    const spec = specOf(f.repository.get('run', receipt.runId)!)
    assert.deepEqual(spec.input.queries, queries)
    assert.equal(spec.fixed.cropReviewPolicy, 'candidate-focus-v1')
    const excessive = Array.from({ length: f.service.config.limits.maxSearchPages + 1 }, (_, index) => `landscape ${index}`)
    const rejected = z.object({ status: z.literal('blocked'), error: z.object({ code: z.literal('invalid-input') }) }).parse(await f.service.action({ operation: 'task-prepare', args: { ...args, queries: excessive } }, actor, new AbortController().signal))
    assert.equal(rejected.status, 'blocked')
  } finally { await f.cleanup() }
})

test('zero qualified results expose a pending receipt without claiming or creating an output directory', async () => {
  const { f, input, settled } = await setup()
  try {
    await f.action('search-launch-start', input)
    const launch = await settled(), actor = { kind: 'agent' as const, id: launch.sessionId, sessionId: launch.sessionId, profileId: f.profileId }
    const original = f.http.request.bind(f.http)
    f.http.request = async (url, request) => url.startsWith('https://source.example.test')
      ? { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ items: [{ id: 'no-original', previewUrl: 'https://images.example.test/preview' }], nextCursor: null })) }
      : original(url, request)
    const checked = z.object({ normalizedInput: z.record(z.string(), z.json()), preparationDigest: z.string() }).parse(await f.service.action({ operation: 'task-prepare', args: { kind: 'search', releaseId: input.modelProfileId, taskBrief: input.taskBrief, targetCount: 1, output: { kind: 'original' } } }, actor, new AbortController().signal))
    const run = z.object({ runId: z.string() }).parse(await f.service.action({ operation: 'search-start', args: { ...checked.normalizedInput, operationId: 'empty-search', preparationDigest: checked.preparationDigest } }, actor, new AbortController().signal))
    await f.jobs.drain()
    const report = z.object({ delivery: z.object({ status: z.literal('pending'), directory: z.string().optional(), files: z.literal(0) }), resultSummary: z.object({ selected: z.literal(0), unavailable: z.literal(1) }) }).parse(await f.service.action({ operation: 'run-get', args: { runId: run.runId } }, actor, new AbortController().signal))
    assert.equal(report.delivery.directory, undefined)
    await assert.rejects(stat(join(f.root, '.visual-curator', input.operationId)), { code: 'ENOENT' })
  } finally { await f.cleanup() }
})

test('owner launch creates one native Session, attaches exact package and submits a recoverable frozen search', async () => {
  const { f, native, input, profile, settled } = await setup()
  try {
    const [a, b] = await Promise.all([f.action('search-launch-start', input), f.action('search-launch-start', input)])
    assert.equal(searchLaunchViewSchema.parse(a).sessionId, searchLaunchViewSchema.parse(b).sessionId)
    const launch = await settled()
    assert.equal(launch.status, 'accepted'); assert.equal(native.created.length, 1); assert.equal(native.messages.length, 1)
    const message = native.messages[0]!, dataset = f.domain.require('profileExport', launch.datasetId!)
    assert.deepEqual(JSON.parse(Buffer.from(message.bytes).toString('utf8')), { formatVersion: 2, export: dataset.id, files: dataset.files, resources: [] })
    assert.ok(message.text.includes(profile.id)); assert.ok(message.text.includes('visual_search_start')); assert.ok(message.text.includes('不需要先用文件工具读取附件或安装 Skill'))
    assert.ok(message.text.includes('不要为找图运行 Shell'))
    assert.ok(message.text.includes('修改文件及目录权限、ACL'))
    assert.ok(message.text.includes('零张合格结果时不会创建目录'))
    assert.ok(message.text.includes('delivery'))
    await assert.rejects(f.action('search-launch-start', { ...input, targetCount: 2 }), /different/)
    const actor = { kind: 'agent' as const, id: launch.sessionId, sessionId: launch.sessionId, profileId: f.profileId }
    const checked = z.object({ status: z.literal('ready'), normalizedInput: z.record(z.string(), z.unknown()), preparationDigest: z.string() }).parse(await f.service.action({ operation: 'task-prepare', args: { kind: 'search', releaseId: profile.id, taskBrief: input.taskBrief, targetCount: 1, output: { kind: 'original' } } }, actor, new AbortController().signal))
    const run = z.object({ runId: z.string() }).parse(await f.service.action({ operation: 'search-start', args: { ...z.record(z.string(), z.json()).parse(checked.normalizedInput), operationId: 'agent-search', preparationDigest: checked.preparationDigest } }, actor, new AbortController().signal))
    await f.jobs.drain()
    assert.equal(f.domain.require('run', run.runId).status, 'completed', JSON.stringify(dataOf(f.domain.require('run', run.runId)).error))
    const selection = f.repository.list('selection').find(item => item.runId === run.runId)!
    assert.ok(selection); assert.equal(f.repository.list('cropCandidate').length, 0)
    const directory = join(f.root, '.visual-curator', input.operationId)
    assert.deepEqual(await readFile(join(directory, `${selection.id}.png`)), f.http.image)
    const grant = z.object({ sessionToken: z.string() }).parse(await f.action('session-open', { sessionId: launch.sessionId }))
    const response = await f.service.resource(new Request(`http://localhost/api/visual-curator/resource?selectionId=${selection.id}&sessionId=${launch.sessionId}&sessionToken=${grant.sessionToken}`))
    assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.http.image)
    assert.equal((await f.service.resource(new Request(`http://localhost/api/visual-curator/resource?selectionId=${selection.id}`))).status, 403)
    assert.equal(f.domain.authorizedImage(selection.imageVersionId, actor).asset.exportPermission, 'references-only')
    const files = new AssetFiles(join(f.root, 'visual-curator'), { maxFileBytes: 1000000, maxPixels: 80000000, maxDimension: 20000, previewMaxDimension: 1280, maxStorageBytes: 4294967296 })
    await assert.rejects(originalSearchResult(f.domain, files, selection.id, { ...actor, sessionId: 'foreign' }), /Only this launch/)
    await writeFile(join(directory, `${selection.id}.png`), 'unrelated', 'utf8')
    const identity = await stat(f.root)
    const delivery = { domain: f.domain, files, launchId: input.operationId, sessionId: launch.sessionId, workspace: { id: 'workspace', path: f.root, device: String(identity.dev), inode: String(identity.ino) }, runId: run.runId, original: true }
    await mkdir(join(f.root, 'alternate-output'))
    await rename(join(f.root, '.visual-curator'), join(f.root, '.saved-output'))
    await symlink(join(f.root, 'alternate-output'), join(f.root, '.visual-curator'), 'junction')
    await assert.rejects(deliverSearchResults(delivery), /redirected/)
    assert.deepEqual(await readdir(join(f.root, 'alternate-output')), [])
    await unlink(join(f.root, '.visual-curator')); await rename(join(f.root, '.saved-output'), join(f.root, '.visual-curator'))
    await assert.rejects(deliverSearchResults({ domain: f.domain, files, launchId: input.operationId, sessionId: launch.sessionId, workspace: { id: 'workspace', path: f.root, device: String(identity.dev), inode: String(identity.ino) }, runId: run.runId, original: true }), /not been overwritten/)
    assert.equal(await readFile(join(directory, `${selection.id}.png`), 'utf8'), 'unrelated')
    const final = z.array(searchLaunchViewSchema).parse(await f.action('search-launch-list'))[0]!
    assert.deepEqual(final.runIds, [run.runId]); assert.equal(final.qualified, 1)
    const expected = { status: final.status, createdSessions: native.created.length, submittedMessages: native.messages.length, attachedFormat: 2, output: final.input.output.kind, linkedRuns: final.runIds.length, qualified: final.qualified, cropCandidates: f.repository.list('cropCandidate').length, foreignRead: 'denied', existingFile: 'preserved' }
    assert.deepEqual(expected, JSON.parse(readFileSync(new URL('./fixtures/search-launch.expected.json', import.meta.url), 'utf8')))
  } finally { await f.cleanup() }
})

for (const failure of ['create-ack', 'attach', 'prompt-ack'] as const) test(`retry after ${failure} preserves Session, dataset and prompt identity`, async () => {
  const { f, native, input, settled } = await setup()
  try {
    native.fail = failure
    await f.action('search-launch-start', input)
    const failed = await settled(); assert.equal(failed.status, 'failed')
    await f.action('search-launch-start', input)
    const recovered = await settled()
    assert.equal(recovered.status, 'accepted'); assert.equal(recovered.sessionId, failed.sessionId); assert.equal(recovered.datasetId, failed.datasetId)
    assert.equal(native.created.length, 1); assert.equal(native.messages.length, 1)
    await f.action('search-launch-stop', { id: input.operationId }); assert.deepEqual(native.cancelled, [failed.sessionId])
  } finally { await f.cleanup() }
})

test('mismatched datasets and unsealed stale drafts fail while a selected completed dataset remains usable', async () => {
  const { f, native, profile, input, styleId, settled } = await setup()
  try {
    const privateProfile = modelProfileSchema.parse({ ...profile, id: 'private-profile', access: { kind: 'session-run', sessionId: 'another-session' } })
    await f.repository.commit({ aggregateId: 'private-profile', expectedRevision: 0, operationId: 'private-profile', request: {}, records: [privateProfile], state: {} })
    await assert.rejects(f.action('search-launch-start', { ...input, modelProfileId: privateProfile.id }), /matching the selected profile/)
    assert.equal(native.created.length, 0)
    await f.action('reference-import', { operationId: 'new-reference', styleId, expectedRevision: f.domain.require('draft', profile.draftId).revision, files: [{ name: 'new.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    const { datasetId, ...unsealed } = input
    await assert.rejects(f.action('search-launch-start', { ...unsealed, autoPrepareDataset: true }), /analyze the current collection/)
    assert.equal(native.created.length, 0)
    await f.action('search-launch-start', input)
    assert.equal((await settled()).datasetId, datasetId)
    assert.equal(native.created.length, 1)
    await assert.rejects(f.service.action({ operation: 'search-launch-start', args: input }, { kind: 'agent', id: 'foreign', sessionId: 'foreign', profileId: f.profileId }, new AbortController().signal), /authenticated workbench owner/)
  } finally { await f.cleanup() }
})

test('restart restages an unlogged accepted prompt with its original identity and never creates another Session', async () => {
  const { f, native, input, settled } = await setup()
  try {
    await f.action('search-launch-start', input); const launch = await settled(), original = native.messages[0]!
    native.messages.length = 0
    const recovered = new SearchLaunches({ domain: f.domain, files: new AssetFiles(join(f.root, 'visual-curator'), { maxFileBytes: 1000000, maxPixels: 80000000, maxDimension: 20000, previewMaxDimension: 1280, maxStorageBytes: 4294967296 }), engine: new RunEngine(f.repository, f.jobs), signal: new AbortController().signal, native: () => native, freeze: async () => { throw new Error('A durable launch must not resolve current defaults again') } })
    recovered.recover(); await recovered.drain()
    assert.equal(recovered.list()[0]?.status, 'accepted'); assert.equal(native.created.length, 1)
    assert.equal(native.messages[0]?.requestId, original.requestId); assert.deepEqual(native.messages[0]?.bytes, original.bytes)
    assert.equal(recovered.list()[0]?.sessionId, launch.sessionId)
  } finally { await f.cleanup() }
})

test('an unknown stop acknowledgement remains recoverable and cannot admit new search work', async () => {
  const { f, native, input, settled, profile } = await setup()
  try {
    await f.action('search-launch-start', input); const launch = await settled()
    native.fail = 'cancel'
    const failed = searchLaunchViewSchema.parse(await f.action('search-launch-stop', { id: input.operationId }))
    assert.equal(failed.status, 'failed'); assert.equal(failed.stopping, true)
    await assert.rejects(f.service.action({ operation: 'search-start', args: { releaseId: profile.id, taskBrief: input.taskBrief, operationId: 'late-start', output: { kind: 'original' }, sourceId: 'images' } }, { kind: 'agent', id: launch.sessionId, sessionId: launch.sessionId, profileId: f.profileId }, new AbortController().signal), /stopped/)
    const stopped = searchLaunchViewSchema.parse(await f.action('search-launch-start', input))
    assert.equal(stopped.status, 'stopped'); assert.equal(native.created.length, 1); assert.equal(native.messages.length, 1)
  } finally { await f.cleanup() }
})

test('accepted and explicitly selected dataset searches retain their exact profile after reference changes', async () => {
  const { f, input, profile, styleId, settled } = await setup()
  try {
    await f.action('search-launch-start', input); const launch = await settled()
    await f.action('reference-import', { operationId: 'later-reference', styleId, expectedRevision: f.domain.require('draft', profile.draftId).revision, files: [{ name: 'later.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    const profiles = new ModelProfiles(f.domain), actor = { kind: 'agent' as const, id: launch.sessionId, sessionId: launch.sessionId, profileId: f.profileId }
    const { datasetId, ...unsealed } = input
    await assert.rejects(f.action('search-launch-start', { ...unsealed, autoPrepareDataset: true, operationId: randomUUID() }), /analyze the current collection/)
    const selected = searchLaunchViewSchema.parse(await f.action('search-launch-start', { ...input, operationId: randomUUID() }))
    assert.equal(selected.datasetId, datasetId)
    const dataset = await profiles.export(profile, 'accepted-later-package', actor, { acceptedLaunchId: input.operationId })
    assert.equal(dataset.modelProfileId, profile.id); assert.equal(dataset.resources.length, profile.references.length)
    await assert.rejects(profiles.export(profile, 'unrelated-package', { ...actor, sessionId: 'foreign' }, { acceptedLaunchId: input.operationId }), /not authorized/)
  } finally { await f.cleanup() }
})

test('stop cancels the native Session and its active search without cancelling another Session’s Run', async () => {
  const { f, native, input, profile, settled } = await setup()
  try {
    await f.action('search-launch-start', input); const launch = await settled()
    let notify!: () => void
    const reached = new Promise<void>(done => { notify = done }), originalRequest = f.http.request.bind(f.http)
    f.http.request = async (url, request) => {
      if (request.headers?.accept === 'image/jpeg,image/png,image/webp') { const signal = request.signal; assert.ok(signal); return await new Promise((_done, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); notify() }) }
      return originalRequest(url, request)
    }
    const args = { releaseId: profile.id, taskBrief: input.taskBrief, targetCount: 1, output: { kind: 'original' }, sourceId: 'images' }, actor = { kind: 'agent' as const, id: launch.sessionId, sessionId: launch.sessionId, profileId: f.profileId }
    const own = z.object({ runId: z.string() }).parse(await f.service.action({ operation: 'search-start', args: { ...args, operationId: 'own-running' } }, actor, new AbortController().signal))
    await reached
    await native.ensure({}, 'unrelated-session')
    const other = z.object({ runId: z.string() }).parse(await f.service.action({ operation: 'search-start', args: { ...args, operationId: 'other-running' } }, { ...actor, id: 'unrelated-session', sessionId: 'unrelated-session' }, new AbortController().signal))
    const stopped = searchLaunchViewSchema.parse(await f.action('search-launch-stop', { id: input.operationId }))
    assert.equal(stopped.status, 'stopped'); assert.ok(['cancelling', 'cancelled'].includes(f.domain.require('run', own.runId).status))
    assert.equal(f.domain.require('run', other.runId).status, 'running'); assert.deepEqual(native.cancelled, [launch.sessionId])
  } finally { await f.cleanup() }
})
