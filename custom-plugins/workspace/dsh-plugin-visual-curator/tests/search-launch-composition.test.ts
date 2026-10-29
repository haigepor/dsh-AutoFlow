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
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as Domains from '@deepseek-ai/dsh-storage-domain'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import Typert from '@deepseek-ai/dsh-typert-registry'
import Commands from '@deepseek-ai/dsh-commands'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import Attachments from '@deepseek-ai/dsh-attachment-local'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import SessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import Jobs from '@deepseek-ai/dsh-jobs-local'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import SessionTitle from '@deepseek-ai/dsh-session-title'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'
import { CuratorService } from '../src/host/service.ts'
import { createAgentTools } from '../src/host/tools.ts'
import { searchLaunchViewSchema } from '../src/shared/search-launch.ts'
import { nativeSearchSessions, type NativeSearchSessions } from '../src/host/native-search-session.ts'
import { CompatibleVisionProvider, SourceHttpProvider } from '../src/media/index.ts'

test('Loader launch logs a native file prompt, creates a Workspace member, executes owned tools and unloads contributions', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'curator-native-launch-')), ctx = new Context(), external = await serviceFixture()
  let service: CuratorService | undefined, toolOwner: Awaited<ReturnType<Context['plugin']>> | undefined, searchArgs: Record<string, unknown> = {}, step = 0, assemblyError: unknown
  class Adapter extends LlmAdapter {
    override async resolveModel(provider: string, id: string) { return { provider, id, name: id, context: { contextWindow: 1000000 } } }
    override async listModels(provider: string) { return [await this.resolveModel(provider, 'fixture')] }
    async *stream(): AsyncGenerator<StreamChunk> {
      if (step++ === 0) {
        yield { type: 'tool-call-delta', index: 0, id: ToolCallId('native-search'), name: 'visual_search_start', argumentsDelta: JSON.stringify(searchArgs) }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'text-delta', index: 0, text: 'Image search accepted. Saved results remain available.' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  try {
    const path = join(root, 'cordis.yml')
    await writeFile(path, '- name: cordis:native\n- name: cordis:defaults\n  config:\n    provider: fixture\n    model: fixture\n- name: cordis:api\n', 'utf8')
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.defaults = DefaultModel
    ctx.loader.builtins.native = { name: 'curator-native-assembly', async apply(owner: Context) { try {
      owner.provide('profileContext', { name: 'fixture', dir: root, patchPath: join(root, 'cordis.patch.yml'), installAnchor: root, cwd: root, home: root, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined })
      await mountAgentLoopTestDependencies(owner, { workingDirectory: true })
      await mountAgentLoopTestHarness(owner)
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
      await owner.plugin(Jobs)
      await owner.plugin(ConfigEditor)
      await owner.inject(['llm'], adapterScope => { adapterScope.effect(() => adapterScope.llm.registerAdapter(['fixture'], new Adapter()), 'Native launch external model fixture') })
    } catch (error) { assemblyError = error; throw error } } }
    ctx.loader.builtins.api = { name: 'curator-native-api', inject: ['profileContext', 'credentials', 'storageDomain', 'agentDefaultModel', 'agents', 'attachments', 'fileUploads', 'fs', 'llm', 'remoteAccess', 'sessions', 'sessionProjections', 'sessionQuery', 'typert', 'workspaceRegistry', 'jobs', 'configEditor'], async apply(owner: Context) { try {
      const apiFiber = owner.plugin(SessionController, { nativeOpen: false }); await apiFiber.await(); if (!owner.get('sessionController')) throw new Error('controller state=' + apiFiber.state + '; deps=' + JSON.stringify(Object.keys(apiFiber.inject).map(name => [name,!!owner.get(name)])))
      const config = external.service.config, http = external.http
      const vision = new CompatibleVisionProvider({ endpoint: config.vision.endpoint, model: 'fixture', supportsMultiImage: true, maxImages: 10, maxImageBytes: 1000000, maxRequestBytes: 10000000, maxOutputTokens: 4000, temperature: 0, declaredModelVersion: 'fixture-v1' }, http)
      const source = new SourceHttpProvider({ endpoint: config.source.endpoint, method: 'GET', request: { query: 'q', cursor: 'cursor', pageSize: 'limit' }, response: { items: '/items', id: '/id', previewUrl: '/previewUrl', originalUrl: '/originalUrl', nextCursor: '/nextCursor' }, maxPageSize: 20 }, http)
      const native = nativeSearchSessions(owner)!
      let losePromptAck = true
      const observed: NativeSearchSessions = { ...native, async submit(...args) { await native.submit(...args); if (losePromptAck) { losePromptAck = false; throw new Error('The accepted prompt acknowledgement was lost') } } }
      service = new CuratorService(owner, config, { nativeSessions: observed, providers: { source: async () => source, vision: async () => vision, media: () => http } })
      owner.effect(() => owner.jobs.attachController('visual-curator'), 'Native launch jobs')
      owner.effect(() => () => service!.dispose(), 'Native launch provider drain')
      await service.initialize()
      const shared = service
      toolOwner = owner.plugin({ name: 'native-launch-visual-tools', inject: ['tools'], apply(tools: Context) { for (const tool of createAgentTools(shared)) tools.effect(() => tools.tools.register(tool), tool.name) } })
      await toolOwner
    } catch (error) { assemblyError = error; throw error } } }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } }); await ctx.loader.await()
    assert.ok(service, String(assemblyError) + JSON.stringify(['agentDefaultModel','agents','attachments','fileUploads','fs','llm','remoteAccess','sessions','sessionProjections','sessionQuery','typert','workspaceRegistry','jobs','configEditor'].map(name => [name,!!Reflect.get(ctx,name)]))); assert.ok(ctx.get('sessionController'), String(assemblyError))
    const actor = { kind: 'human' as const, id: 'owner', profileId: service.profileId }, invoke = (operation: string, args: Record<string, z.infer<typeof import('../src/shared/model.ts').jsonSchema>> = {}) => service!.action({ operation, args }, actor, new AbortController().signal)
    const { id: styleId } = z.object({ id: z.string() }).parse(await invoke('style-create', { operationId: 'style', name: 'Loader photos' }))
    await invoke('reference-import', { operationId: 'refs', styleId, expectedRevision: 1, files: [{ name: 'ref.png', mime: 'image/png', base64: external.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    const analysis = z.object({ runId: z.string() }).parse(await invoke('reference-analyze', { operationId: 'analysis', styleId, buildDataset: true }))
    const wait = async (read: () => Promise<boolean>) => { for (let i = 0; i < 1000; i++) { if (await read()) return; await new Promise(resolve => setTimeout(resolve, 5)) } throw new Error('Native launch did not settle') }
    let modelProfileId = ''
    await wait(async () => {
      const value = z.object({ styles: z.array(z.object({ modelProfile: z.object({ id: z.string() }).optional() })) }).parse(await invoke('snapshot'))
      if (!value.styles[0]?.modelProfile) return false
      const raw = z.object({ modelProfile: z.object({ id: z.string() }) }).parse(await invoke('style-get', { styleId }))
      modelProfileId = raw.modelProfile.id
      return true
    })
    assert.ok(modelProfileId)
    const workspace = await ctx.workspaceRegistry.create(root, 'Photos'), input = { operationId: randomUUID(), workspaceId: workspace.id, modelProfileId: modelProfileId, taskBrief: 'Muted green landscape.', targetCount: 1, output: { kind: 'original' } }
    searchArgs = { releaseId: modelProfileId, taskBrief: input.taskBrief, targetCount: 1, output: input.output, sourceId: 'images', budgets: { targetCount: 1, ...Object.fromEntries(['maxVisionCalls', 'maxSearchPages', 'maxCandidates', 'maxDownloadBytes', 'maxCropCandidatesPerImage', 'maxConcurrentRequests', 'maxRetryAttempts', 'deadlineMs'].map(key => [key, Reflect.get(service!.config.limits, key)])) } }
    const defaultSelection = ctx.agentDefaultModel.currentSelection()
    const receipt = searchLaunchViewSchema.parse(await invoke('search-launch-start', input))
    await wait(async () => z.array(searchLaunchViewSchema).parse(await invoke('search-launch-list'))[0]?.status === 'failed')
    await invoke('search-launch-start', input)
    await wait(async () => { const rows = z.array(searchLaunchViewSchema).parse(await invoke('search-launch-list')); return rows[0]?.status === 'accepted' && rows[0]?.runStatus === 'completed' })
    const launch = z.array(searchLaunchViewSchema).parse(await invoke('search-launch-list'))[0]!
    const inspection = await ctx.sessionController.inspect(importSessionId(receipt.sessionId)), prompt = inspection.events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
    assert.equal(inspection.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length, 1)
    assert.ok(prompt?.type === 'user/message'); assert.ok(prompt.data.content.some(part => part.type === 'file'))
    assert.ok(workspace.sessionIds.includes(importSessionId(receipt.sessionId)))
    assert.ok(inspection.events.some(event => event.type === 'tool/call' && event.data.name === 'visual_search_start'))
    assert.equal(launch.qualified, 1); assert.deepEqual(ctx.agentDefaultModel.currentSelection(), defaultSelection)
    const expected = { workspaceMembers: workspace.sessionIds.length, promptFiles: prompt.data.content.filter(part => part.type === 'file').length, loggedSearchTool: true, linkedRuns: launch.runIds.length, qualified: launch.qualified, nativeModelUnchanged: true }
    assert.deepEqual(expected, JSON.parse(await readFile(new URL('./fixtures/search-launch-native.expected.json', import.meta.url), 'utf8')))
    await toolOwner?.dispose(); assert.equal(ctx.tools.get('visual_search_start'), undefined)
    await assert.rejects(invoke('search-launch-start', { ...input, operationId: randomUUID() }), /Enable the Visual Curator/)
    assert.equal(workspace.sessionIds.length, 1)
    assert.equal(analysis.runId.length > 0, true)
  } finally { await ctx.fiber.dispose(); await external.cleanup(); await rm(root, { recursive: true, force: true }) }
})

import { SessionId as importSessionId } from '@deepseek-ai/dsh-session'
