/** Real Loader, native Session/Workspace/attachments/loop and tool execution; only remote model/media are fixtures. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { LlmAdapter, type StreamChunk, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as Domains from '@deepseek-ai/dsh-storage-domain'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import Typert from '@deepseek-ai/dsh-typert-registry'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import Commands from '@deepseek-ai/dsh-commands'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import Attachments from '@deepseek-ai/dsh-attachment-local'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import SessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import Jobs from '@deepseek-ai/dsh-jobs-local'
import * as JobTools from '@deepseek-ai/dsh-tool-jobs'
import PluginManager from '@deepseek-ai/dsh-plugin-manager'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import SessionTitle from '@deepseek-ai/dsh-session-title'
import { z } from 'zod'
import sharp from 'sharp'
import { serviceFixture } from './helpers/service-fixture.ts'
import { CuratorService } from '../src/host/service.ts'
import { mountCurator } from '../src/host/plugin.ts'
import * as CuratorTools from '../src/host/tools.ts'
import * as CuratorSkill from '../src/host/skill.ts'
import * as CuratorPage from '../src/host/page.ts'
import Skills from '@deepseek-ai/dsh-skill'
import { searchLaunchViewSchema } from '../src/shared/search-launch.ts'
import { nativeSearchSessions, type NativeSearchSessions } from '../src/host/native-search-session.ts'
import { CompatibleVisionProvider, SourceHttpProvider } from '../src/media/index.ts'

for (const stopSession of [false, true, 'model-cleanup', 'admission', 'normal-completion'] as const) test(stopSession === 'normal-completion' ? 'a naturally completed conversation leaves its accepted image search running' : stopSession ? `stopping the native Session cancels its image search without waking it or stopping independent work (${stopSession === true ? 'job wait' : stopSession})` : 'Loader launch logs a native file prompt, creates a Workspace member, executes owned tools and unloads contributions', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'curator-native-launch-')), ctx = new Context(), external = await serviceFixture()
  let service: CuratorService | undefined, toolOwner: Awaited<ReturnType<Context['plugin']>> | undefined, searchArgs: Record<string, unknown> = {}, step = 0, assemblyError: unknown, nativeFailure: unknown
  const preparationEntered = Promise.withResolvers<void>(), releasePreparation = Promise.withResolvers<void>()
  const reviewEntered = Promise.withResolvers<void>(), waitingForJob = Promise.withResolvers<void>()
  const modelCleanup = Promise.withResolvers<void>(), releaseModel = Promise.withResolvers<void>()
  const admissionStopped = Promise.withResolvers<void>()
  const waitEvent = async (event: Promise<void>, name: string) => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([event, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(`Missing ${name}; model requests=${step}; assembly=${String(assemblyError)}; jobs=${JSON.stringify(ctx.get('jobs')?.list().map(job => ({ status: job.status, owner: job.owner })) ?? [])}`)), 5000) })]) }
    finally { clearTimeout(timeout) }
  }
  let prepared = false, submitted = 0, selectedModels = 0
  let owningSessionId: import('@deepseek-ai/dsh-session').SessionId | undefined
  class Adapter extends LlmAdapter {
    override async resolveModel(provider: string, id: string) { return { provider, id, name: id, context: { contextWindow: 1000000 } } }
    override async listModels(provider: string) { return [await this.resolveModel(provider, 'fixture'), await this.resolveModel(provider, 'alternate')] }
    async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
      if (step++ === 0) {
        yield { type: 'tool-call-delta', index: 0, id: ToolCallId('native-search'), name: 'visual_search_start', argumentsDelta: JSON.stringify(searchArgs) }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else if (stopSession && stopSession !== 'normal-completion' && step === 2) {
        if (stopSession === 'model-cleanup') {
          assert.ok(options.signal)
          waitingForJob.resolve()
          await new Promise<void>(resolve => { if (options.signal!.aborted) resolve(); else options.signal!.addEventListener('abort', () => resolve(), { once: true }) })
          modelCleanup.resolve(); await releaseModel.promise
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        assert.ok(owningSessionId)
        const job = ctx.jobs.list(owningSessionId).find(job => job.owner !== undefined && job.status === 'running' && job.kind === 'visual-curator')
        assert.ok(job)
        yield { type: 'tool-call-delta', index: 0, id: ToolCallId('wait-search'), name: 'job_output', argumentsDelta: JSON.stringify({ job_id: job.id, wait: true, timeout_ms: 30000 }) }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'text-delta', index: 0, text: 'Image search accepted. Saved results remain available.' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  try {
    const path = join(root, 'cordis.yml')
    await writeFile(path, '- name: cordis:native\n- name: cordis:defaults\n  config:\n    provider: fixture\n    model: fixture\n- name: cordis:api\n- name: cordis:features\n', 'utf8')
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.defaults = DefaultModel
    ctx.loader.builtins.native = { name: 'curator-native-assembly', async apply(owner: Context) { try {
      owner.provide('profileContext', { name: 'fixture', dir: root, patchPath: join(root, 'cordis.patch.yml'), installAnchor: root, cwd: root, home: root, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined })
      await mountAgentLoopTestDependencies(owner, { workingDirectory: true })
      await mountAgentLoopTestHarness(owner)
      owner.on('agent/request', async (_payload, next) => {
        if (!prepared) {
          prepared = true; preparationEntered.resolve()
          await releasePreparation.promise
        }
        return next()
      })
      await owner.plugin(Typert)
      await owner.plugin(Storage)
      await owner.plugin(JsonStorage, { root: join(root, 'storage') })
      await owner.plugin(Domains, { backend: 'json' })
      await owner.plugin(Persistence, { root: join(root, 'sessions'), compression: 'none' })
      await owner.plugin(Credentials, { dshHome: root, watch: false })
      await owner.plugin(Connection)
      await owner.plugin(Commands)
      await owner.plugin(Attachments, { dshHome: root })
      await owner.plugin(FileUploads)
      await owner.plugin(WorkspaceRegistry)
      await owner.plugin(SessionQuery, { path: ':memory:', openAt: 'never' })
      await owner.plugin(SessionTitle, { fallbackMaxWords: 8, fallbackMaxBytes: 100, maxTitleBytes: 1024 })
      await owner.plugin(RemoteAccess)
      await owner.plugin(TypertGatewayService)
      await owner.plugin(Jobs)
      await owner.plugin(JobTools)
      await owner.plugin(ConfigEditor)
      await owner.plugin(PluginManager)
      await owner.plugin(Skills)
      owner.on('tools/pre-execute', (exec, next) => { if (exec.name === 'job_output') waitingForJob.resolve(); return next() })
      await owner.inject(['llm'], adapterScope => { adapterScope.effect(() => adapterScope.llm.registerAdapter(['fixture'], new Adapter()), 'Native launch external model fixture') })
    } catch (error) { assemblyError = error; throw error } } }
    ctx.loader.builtins.api = { name: 'curator-native-api', inject: ['profileContext', 'credentials', 'storageDomain', 'agentDefaultModel', 'agents', 'attachments', 'fileUploads', 'fs', 'llm', 'remoteAccess', 'sessions', 'sessionProjections', 'sessionQuery', 'typert', 'workspaceRegistry', 'jobs', 'configEditor', 'pluginManager'], async apply(owner: Context) { try {
      const apiFiber = owner.plugin(SessionController, { nativeOpen: false }); await apiFiber.await(); if (!owner.get('sessionController')) throw new Error('controller state=' + apiFiber.state + '; deps=' + JSON.stringify(Object.keys(apiFiber.inject).map(name => [name,!!owner.get(name)])))
      const config = external.service.config, http = external.http
      const vision = new CompatibleVisionProvider({ endpoint: config.vision.endpoint, model: 'fixture', supportsMultiImage: true, maxImages: 10, maxImageBytes: 1000000, maxRequestBytes: 10000000, maxOutputTokens: 4000, temperature: 0, declaredModelVersion: 'fixture-v1' }, http)
      if (stopSession) vision.review = async (_input, bounds) => {
        assert.ok(bounds.signal)
        bounds.signal.throwIfAborted(); reviewEntered.resolve()
        return await new Promise((_resolve, reject) => { bounds.signal!.addEventListener('abort', () => reject(bounds.signal!.reason), { once: true }) })
      }
      const source = new SourceHttpProvider({ endpoint: config.source.endpoint, method: 'GET', request: { query: 'q', cursor: 'cursor', pageSize: 'limit' }, response: { items: '/items', id: '/id', previewUrl: '/previewUrl', originalUrl: '/originalUrl', nextCursor: '/nextCursor' }, maxPageSize: 20 }, http)
      const native = nativeSearchSessions(owner)!
      let losePromptAck = true
      const observed: NativeSearchSessions = { ...native,
        async ensure(...args) { try { await native.ensure(...args) } catch (error) { nativeFailure = error; throw error } },
        async accepted(...args) { try { return await native.accepted(...args) } catch (error) { nativeFailure = error; throw error } },
        async selectModel(...args) { selectedModels++; await native.selectModel(...args) },
        async submit(...args) { submitted++; await native.submit(...args); if (losePromptAck) { losePromptAck = false; throw new Error('The accepted prompt acknowledgement was lost') } } }
      service = new CuratorService(owner, config, { nativeSessions: observed, providers: { source: async () => source, vision: async () => vision, media: () => http } })
      await mountCurator(owner, service)
      owner.effect(() => owner.jobs.events.subscribe({ owners: 'all' }, event => {
        if (stopSession === 'admission' && event.type === 'registered' && event.job.owner === owningSessionId && event.job.kind === 'visual-curator') {
          assert.ok(owningSessionId)
          ctx.sessionController.cancel({ sessionId: owningSessionId }); admissionStopped.resolve()
        }
      }), 'Stop at image job registration')
    } catch (error) { assemblyError = error; throw error } } }
    ctx.loader.builtins.features = { name: 'native-launch-visual-features', inject: ['visualCurator', 'tools', 'skills', 'pluginManager'], async apply(features: Context) {
      toolOwner = features.fiber
      for (const group of ['read', 'curate', 'export'] as const) await features.plugin(CuratorTools, { group })
      for (const skill of ['visual-style-reference', 'visual-style-calibration', 'visual-image-search', 'visual-crop-composition', 'visual-human-feedback', 'visual-dataset-export'] as const) await features.plugin(CuratorSkill, { skill })
      await features.plugin(CuratorPage, { page: 'panel' })
    } }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } }); await ctx.loader.await()
    const skills = ctx.get('skills')
    assert.ok(skills)
    assert.equal((await skills.list()).filter(skill => skill.provider === 'dsh-plugin-visual-curator').length, 6)
    assert.ok(service, String(assemblyError) + JSON.stringify(['agentDefaultModel','agents','attachments','fileUploads','fs','llm','remoteAccess','sessions','sessionProjections','sessionQuery','typert','workspaceRegistry','jobs','configEditor'].map(name => [name,!!Reflect.get(ctx,name)]))); assert.ok(ctx.get('sessionController'), String(assemblyError))
    const actor = { kind: 'human' as const, id: 'owner', profileId: service.profileId }, invoke = (operation: string, args: Record<string, z.infer<typeof import('../src/shared/model.ts').jsonSchema>> = {}) => service!.action({ operation, args }, actor, new AbortController().signal)
    const { id: styleId } = z.object({ id: z.string() }).parse(await invoke('style-create', { operationId: 'style', name: 'Loader photos' }))
    const negative = await sharp({ create: { width: 80, height: 40, channels: 3, background: { r: 140, g: 20, b: 35 } } }).png().toBuffer()
    const reference = await sharp({ create: { width: 80, height: 40, channels: 3, background: { r: 30, g: 140, b: 35 } } }).png().toBuffer()
    await invoke('reference-import', { operationId: 'refs', styleId, expectedRevision: 1, files: [{ name: 'ref.png', mime: 'image/png', base64: reference.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }, { name: 'negative.png', mime: 'image/png', base64: negative.toString('base64'), role: 'negative', intent: 'overall', dimensions: [] }] })
    const analysis = z.object({ runId: z.string() }).parse(await invoke('reference-analyze', { operationId: 'analysis', styleId, buildDataset: true }))
    let lastLaunch: unknown
    const wait = async (read: () => Promise<boolean>) => { for (let i = 0; i < 1000; i++) { if (await read()) return; await new Promise(resolve => setTimeout(resolve, 5)) } throw new Error('Native launch did not settle: ' + JSON.stringify(lastLaunch), { cause: nativeFailure }) }
    let modelProfileId = ''
    await wait(async () => {
      const value = z.object({ styles: z.array(z.object({ modelProfile: z.object({ id: z.string() }).optional() })) }).parse(await invoke('snapshot'))
      if (!value.styles[0]?.modelProfile) return false
      const raw = z.object({ modelProfile: z.object({ id: z.string() }) }).parse(await invoke('style-get', { styleId }))
      modelProfileId = raw.modelProfile.id
      return true
    })
    assert.ok(modelProfileId)
    await wait(async () => z.object({ status: z.string() }).parse(await invoke('run-get', { runId: analysis.runId })).status === 'completed')
    await invoke('export-start', { operationId: 'selected-dataset', kind: 'style', purpose: 'reference', releaseId: modelProfileId, mode: 'references-only' })
    let datasetId = ''
    await wait(async () => {
      const page = z.object({ entries: z.array(z.object({ exportId: z.string().optional(), status: z.string() })) }).parse(await invoke('datasets-list', { styleId }))
      datasetId = page.entries.find(entry => entry.status === 'completed')?.exportId ?? ''
      return datasetId.length > 0
    })
    const negativeExport = z.object({ runId: z.string() }).parse(await invoke('export-start', { operationId: 'negative-dataset', kind: 'style', purpose: 'reference', releaseId: modelProfileId, sampleScope: 'negative' }))
    await wait(async () => z.object({ status: z.string() }).parse(await invoke('run-get', { runId: negativeExport.runId })).status === 'completed')
    const workspace = await ctx.workspaceRegistry.create(root, 'Photos'), input = { operationId: randomUUID(), workspaceId: workspace.id, modelProfileId, datasetId, includeNegativeDatasets: true, conversationModel: { provider: 'fixture', model: 'alternate' }, taskBrief: 'Muted green landscape.', targetCount: 1, output: { kind: 'original' } }
    await assert.rejects(invoke('search-launch-start', { ...input, operationId: randomUUID(), conversationModel: { provider: 'fixture', model: 'disabled' } }), { code: 'configuration-required', stage: 'search-launch-model' })
    searchArgs = { releaseId: modelProfileId, taskBrief: input.taskBrief, targetCount: 1, output: input.output, sourceId: 'images', budgets: { targetCount: 1, ...Object.fromEntries(['maxVisionCalls', 'maxSearchPages', 'maxCandidates', 'maxDownloadBytes', 'maxCropCandidatesPerImage', 'maxConcurrentRequests', 'maxRetryAttempts', 'deadlineMs'].map(key => [key, Reflect.get(service!.config.limits, key)])) } }
    const defaultSelection = ctx.agentDefaultModel.currentSelection()
    const receipt = searchLaunchViewSchema.parse(await invoke('search-launch-start', input))
    owningSessionId = importSessionId(receipt.sessionId)
    await waitEvent(preparationEntered.promise, 'native request preparation')
    await wait(async () => z.array(searchLaunchViewSchema).parse(await invoke('search-launch-list'))[0]?.status === 'failed')
    const preparing = await ctx.sessionController.resolveAgent(importSessionId(receipt.sessionId))
    if ('error' in preparing) throw preparing.error
    assert.equal(preparing.agent.status, 'running')
    assert.equal(preparing.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length, 0)
    assert.equal(preparing.agent.inbox.nextTurn.length + preparing.agent.inbox.nextStep.length, 0)
    assert.equal(await nativeSearchSessions(ctx)!.accepted(receipt.sessionId, randomUUID()), false)
    await invoke('search-launch-start', input)
    await wait(async () => z.array(searchLaunchViewSchema).parse(await invoke('search-launch-list'))[0]?.status === 'accepted')
    assert.equal(submitted, 1)
    assert.equal(selectedModels, 1)
    releasePreparation.resolve()
    const cancellationSnapshot = JSON.parse(await readFile(new URL('./fixtures/session-cancellation.expected.json', import.meta.url), 'utf8'))
    if (stopSession === 'normal-completion') {
      await waitEvent(reviewEntered.promise, 'image review')
      const agent = ctx.agents.get(owningSessionId)!
      await agent.whenIdle()
      const target = ctx.jobs.list(owningSessionId).find(job => job.owner === owningSessionId && job.kind === 'visual-curator')!
      const launch = z.array(searchLaunchViewSchema).parse(await invoke('search-launch-list')).find(item => item.sessionId === owningSessionId)!
      assert.deepEqual({ jobStatus: target.status, runStatus: launch.runStatus, modelRequests: step, turns: agent.session.snapshotEvents().filter(event => event.type === 'turn/start').length }, cancellationSnapshot.normalCompletion)
      return
    }
    if (stopSession === 'admission') {
      await waitEvent(admissionStopped.promise, 'cancellation during Run admission')
      const agent = ctx.agents.get(owningSessionId)!
      await agent.whenIdle()
      const target = ctx.jobs.list(owningSessionId).find(job => job.owner === owningSessionId && job.kind === 'visual-curator')!
      assert.equal((await ctx.jobs.wait(target.id, 1500, owningSessionId)).status, 'killed')
      assert.equal(step, 1, 'Cancellation at admission must not dispatch a subsequent conversation request')
      const run = z.array(searchLaunchViewSchema).parse(await invoke('search-launch-list')).find(item => item.sessionId === owningSessionId)!
      assert.equal(run.runStatus, 'cancelled')
      const details = z.object({ counts: z.object({ candidates: z.number().optional() }) }).parse(await service.action({ operation: 'run-get', args: { runId: run.runIds[0]! } }, { kind: 'agent', id: owningSessionId, sessionId: owningSessionId, profileId: service.profileId }, new AbortController().signal))
      assert.equal(details.counts.candidates ?? 0, 0)
      assert.deepEqual({ jobStatus: ctx.jobs.get(target.id, owningSessionId).status, runStatus: run.runStatus, modelRequests: step, candidates: details.counts.candidates ?? 0 }, cancellationSnapshot.admission)
      return
    }
    if (stopSession) {
      await waitEvent(reviewEntered.promise, 'image review'); await waitEvent(waitingForJob.promise, 'job_output wait')
      const sessionId = importSessionId(receipt.sessionId), agent = ctx.agents.get(sessionId)!
      const other = await ctx.agentLoop.create(importSessionId('independent-session'), { provider: 'fixture', model: 'fixture' })
      const profileRun = z.object({ runId: z.string() }).parse(await invoke('search-start', { ...searchArgs, operationId: 'profile-search' }))
      const otherRun = z.object({ runId: z.string() }).parse(await service.action({ operation: 'search-start', args: { ...searchArgs, operationId: 'other-search' } }, { kind: 'agent', id: other.id, sessionId: other.id, profileId: service.profileId }, new AbortController().signal))
      const target = ctx.jobs.list(sessionId).find(job => job.owner === sessionId && job.kind === 'visual-curator' && job.status === 'running')!
      ctx.sessionController.cancel({ sessionId })
      if (stopSession === 'model-cleanup') await waitEvent(modelCleanup.promise, 'conversation model cleanup')
      else await agent.whenIdle()
      const stopped = await ctx.jobs.wait(target.id, 1500, sessionId)
      assert.equal(stopped.status, 'killed', 'Stopping the Session must reach the accepted image-search producer')
      if (stopSession === 'model-cleanup') assert.equal(agent.status, 'running', 'Image cancellation must not wait for the conversation model cleanup')
      releaseModel.resolve()
      await agent.whenIdle()
      const launches = z.array(searchLaunchViewSchema).parse(await invoke('search-launch-list'))
      assert.equal(launches.find(item => item.sessionId === sessionId)?.runStatus, 'cancelled')
      assert.equal(z.object({ status: z.string() }).parse(await invoke('run-get', profileRun)).status, 'running')
      assert.equal(z.object({ status: z.string() }).parse(await service.action({ operation: 'run-get', args: otherRun }, { kind: 'agent', id: other.id, sessionId: other.id, profileId: service.profileId }, new AbortController().signal)).status, 'running')
      assert.equal(step, 2, 'The cancellation notice must not start another model request')
      assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'turn/start').length, 1)
      assert.deepEqual({ jobStatus: stopped.status, runStatus: launches.find(item => item.sessionId === sessionId)?.runStatus, modelRequests: step, turns: agent.session.snapshotEvents().filter(event => event.type === 'turn/start').length }, cancellationSnapshot.stopped)
      return
    }
    await wait(async () => { const rows = z.array(searchLaunchViewSchema).parse(await invoke('search-launch-list')); lastLaunch = rows[0]; return rows[0]?.status === 'accepted' && rows[0]?.runStatus === 'completed' })
    const launch = z.array(searchLaunchViewSchema).parse(await invoke('search-launch-list'))[0]!
    const resolved = await ctx.sessionController.resolveAgent(importSessionId(receipt.sessionId))
    if ('error' in resolved) throw resolved.error
    assert.equal(resolved.agent.model.current()?.model, 'alternate')
    const inspection = { events: resolved.agent.session.snapshotEvents() }, prompt = inspection.events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
    assert.equal(inspection.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length, 1)
    assert.ok(prompt?.type === 'user/message'); assert.ok(prompt.data.content.some(part => part.type === 'file'))
    assert.ok(workspace.sessionIds.includes(importSessionId(receipt.sessionId)))
    assert.ok(inspection.events.some(event => event.type === 'tool/call' && event.data.name === 'visual_search_start'))
    assert.equal(launch.qualified, 1); assert.deepEqual(ctx.agentDefaultModel.currentSelection(), defaultSelection)
    const expected = { workspaceMembers: workspace.sessionIds.length, promptFiles: prompt.data.content.filter(part => part.type === 'file').length, loggedSearchTool: true, linkedRuns: launch.runIds.length, qualified: launch.qualified, nativeModelUnchanged: true, selectedConversationModel: resolved.agent.model.current()?.model, negativeReferences: launch.negativeReferences, loggedNegativeGuidance: prompt.data.content.some(part => part.type === 'text' && part.text.includes('negativeReferences')), loggedWorkflowRouting: prompt.data.content.some(part => part.type === 'text' && part.text.includes('afp_* tools operate a separate AFP service') && part.text.includes(`styleId：${styleId}`)) }
    assert.deepEqual(expected, JSON.parse(await readFile(new URL('./fixtures/search-launch-native.expected.json', import.meta.url), 'utf8')))
    await toolOwner?.dispose(); assert.equal(ctx.tools.get('visual_search_start'), undefined)
    await assert.rejects(invoke('search-launch-start', { ...input, operationId: randomUUID() }), /Enable the Visual Curator/)
    assert.equal(workspace.sessionIds.length, 1)
    assert.equal(analysis.runId.length > 0, true)
  } finally { releasePreparation.resolve(); releaseModel.resolve(); await ctx.fiber.dispose(); await external.cleanup(); await rm(root, { recursive: true, force: true }) }
})

import { SessionId as importSessionId } from '@deepseek-ai/dsh-session'
