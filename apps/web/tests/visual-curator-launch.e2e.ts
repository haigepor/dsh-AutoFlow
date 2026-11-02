/** Isolated shipped-Web launch acceptance, optionally held for MCP interaction. */
import { createServer, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import { launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { REPO_ROOT } from './support.ts'

const HOLD = process.env.VC_LAUNCH_MCP === '1'
const PACKAGE = join(REPO_ROOT, 'custom-plugins/workspace/dsh-plugin-visual-curator')
const METADATA = join(REPO_ROOT, '.playwright-mcp/visual-curator-launch-server.json')
const PROVIDER = 'visual-curator-launch-fixture'
const MODEL = 'launch-fixture'
const BRIEF = 'Find 3 muted green landscapes with soft natural light.'
const PAGE_FEATURES = ['ui-panel', 'ui-conversation', 'ui-settings']
const actionEnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.json() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), safeMessage: z.string() }).passthrough() }),
])
const searchLaunchViewSchema = z.object({
  id: z.string(), sessionId: z.string(), stage: z.string(), status: z.string(),
  input: z.object({ taskBrief: z.string(), targetCount: z.number().int().positive() }).passthrough(),
}).passthrough()

function visionResponse(bytes: Buffer, operations: string[]) {
  const request = z.object({ messages: z.array(z.object({ role: z.string(), content: z.union([
    z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
  ]) })) }).parse(JSON.parse(bytes.toString('utf8')))
  const content = request.messages.find(message => message.role === 'user')?.content
  if (!Array.isArray(content)) throw new Error('The local vision fixture requires image content')
  const { input } = z.object({ input: z.object({ operation: z.enum(['analyze', 'summarize']), taskBrief: z.string(),
    images: z.array(z.object({ imageVersionId: z.string() })).min(1),
  }) }).parse(JSON.parse(content[0]?.text ?? '{}'))
  operations.push(`${input.operation}:`)
  if (input.operation === 'analyze') return { observations: input.images.map(image => ({ imageVersionId: image.imageVersionId,
    dimensions: [{ dimension: 'color', observation: 'A muted green palette is visible.', uncertain: false }],
  })) }
  const samples = z.object({ samples: z.array(z.object({ imageVersionId: z.string() })) }).parse(JSON.parse(input.taskBrief))
  const supportImageVersionIds = samples.samples.map(sample => sample.imageVersionId)
  return { name: 'Muted green', summary: 'Soft lighting with muted greens.',
    matchingPrompt: 'Prefer muted green palettes and soft light; inspect actual candidate pixels.',
    searchHints: ['muted green landscape'], avoidTerms: ['neon'], conflicts: [],
    dimensions: [{ dimension: 'color', description: 'Muted greens are shared across positive examples.', consistency: 'consistent', supportImageVersionIds, counterImageVersionIds: [] }],
    suggestedRules: [{ statement: 'Use muted green colors.', dimension: 'color', strength: 'preferred', stage: 'source', supportImageVersionIds, counterImageVersionIds: [], condition: '', exceptions: [] }],
  }
}

class LaunchAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override providerInfo(provider: string) { return { id: provider, name: 'Visual Curator local fixture' } }
  override async listModels(provider: string) { return [await this.resolveModel(provider, MODEL)] }
  override async resolveModel(provider: string, id: string) {
    return { provider, id, name: 'Launch fixture (local)', inputModalities: ['text', 'image'] as const, context: { contextWindow: 1_000_000 } }
  }
  override async *stream(input: GenerateOptions): AsyncIterable<StreamChunk> {
    input.signal?.throwIfAborted()
    this.requests.push(input)
    const text = 'The isolated launch fixture received one dataset attachment. No external image search was started.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

it('launches one native search conversation while request preparation is held, then logs one uploaded prompt', async () => {
  expect(webSnapshotMode(), 'this fixture never enables real model adapters').toBe('replay')
  const root = await mkdtemp(join(tmpdir(), 'visual-curator-web-launch-'))
  const owner = randomUUID(), visionOperations: string[] = [], adapter = new LaunchAdapter()
  const closed = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<string>(), released = Promise.withResolvers<undefined>()
  const lifetime = new AbortController()
  let scaffold: WebScaffold | undefined, gateSession: string | undefined, gateArmed = false, gateReleased = false
  let styleId = '', modelProfileId = '', datasetId = '', workspaceId = '', ready = false
  const invoke = async (operation: string, args: Record<string, unknown> = {}) => {
    if (scaffold === undefined) throw new Error('The isolated Web scaffold is not ready')
    const result = await scaffold.ctx.pluginManager.invokeAction('dsh-plugin-visual-curator', 'workbench', { operation, args: JSON.stringify(args) }, lifetime.signal)
    const envelope = actionEnvelopeSchema.parse(JSON.parse(result.output))
    if (!envelope.ok) throw Object.assign(new Error(envelope.error.safeMessage), envelope.error)
    return envelope.value
  }
  const launches = async () => z.array(searchLaunchViewSchema).parse(await invoke('search-launch-list'))
  const release = () => { gateReleased = true; released.resolve(undefined) }
  const status = async () => ({
    ready, gate: { armed: gateArmed, entered: gateSession !== undefined, released: gateReleased, sessionId: gateSession },
    styleId, modelProfileId, datasetId, workspaceId, requests: adapter.requests.length,
    visionOperations,
    launches: ready ? await launches() : [],
    sessions: scaffold === undefined ? [] : scaffold.ctx.agents.list().map((agent) => {
      const events = agent.session.snapshotEvents()
      return { id: agent.id, status: agent.status,
        userMessages: events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length,
        uploadedFiles: events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user' ? event.data.content.filter(part => part.type === 'file') : []).length,
        toolCalls: events.filter(event => event.type === 'tool/call').length,
      }
    }),
  })
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === 'GET' && request.url === '/status') { json(response, await status()); return }
      if (request.method === 'POST' && request.url === '/release') { release(); json(response, { released: true }); return }
      if (request.method === 'POST' && request.url === '/close') { json(response, { closing: true }); closed.resolve(undefined); return }
      if (request.method !== 'POST' || request.url !== '/vision') { json(response, { error: 'Unknown isolated fixture route' }, 404); return }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      json(response, { choices: [{ message: { content: JSON.stringify(visionResponse(Buffer.concat(chunks), visionOperations)) }, finish_reason: 'stop' }] })
    })().catch((error) => { json(response, { error: error instanceof Error ? error.message : 'Fixture request failed' }, 500) })
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('The local fixture did not bind a TCP port')
    const controlUrl = `http://127.0.0.1:${address.port}`
    const overlay = join(root, 'visual-curator.overlay.yml')
    await writeFile(overlay, JSON.stringify([
      { id: 'visual-curator', config: {
        source: { provider: 'generic', endpoint: 'https://source.example.test/search', credentialRef: '' },
        vision: { backend: 'compatible', endpoint: `${controlUrl}/vision`, localOrigin: controlUrl, model: 'fixture', credentialRef: '', vendorVersion: 'fixture-v1', supportsStreaming: false },
        limits: { maxRetryAttempts: 0, maxVisionCalls: 10, requestTimeoutMs: 30_000 },
      } },
      ...['panel', 'conversation', 'settings'].map(page => ({ id: `visual-curator-ui-${page}`, disabled: false })),
    ]), 'utf8')
    scaffold = await launchWebScaffold({
      developerTools: true,
      profile: { hmr: false, packages: [{ dir: PACKAGE, enabled: true }] },
      extraOverlayPath: [fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)), overlay],
    })
    const host = scaffold
    expect(host.ctx.get('sessionController')).toBeDefined()
    expect(host.ctx.get('fileUploads')).toBeDefined()
    const bundle = (await host.ctx.pluginManager.listBundles()).find(item => item.name === 'dsh-plugin-visual-curator')
    if (bundle?.features === undefined) throw new Error('The installed Visual Curator bundle did not declare its page features')
    const selectedFeatures = bundle.features
      .filter(feature => feature.enabled || PAGE_FEATURES.includes(feature.id))
      .map(feature => feature.id)
    // Client availability reads persisted feature choices as well as active Host rows.
    const changed = await host.ctx.pluginManager.setBundleFeatures(bundle.name, selectedFeatures, true)
    expect(changed.error).toBeUndefined()
    const activeBundle = (await host.ctx.pluginManager.listBundles()).find(item => item.name === bundle.name)
    const rows = await host.ctx.pluginManager.listPlugins()
    expect(activeBundle?.enabled).toBe(true)
    for (const page of PAGE_FEATURES) {
      const feature = activeBundle?.features?.find(item => item.id === page)
      const entryId = activeBundle?.rows.find(row => row.rowId === feature?.rowId)?.entryId
      expect(feature?.enabled, `${page} is selected in the temporary profile`).toBe(true)
      expect(rows.find(row => row.entryId === entryId), `${page} Host row is ready for Client registration`).toMatchObject({ enabled: true, fiberPhase: 'active' })
    }
    host.ctx.effect(() => host.ctx.llm.registerAdapter([PROVIDER], adapter), 'Visual Curator isolated launch model')
    await host.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
    host.ctx.on('agent/request', async ({ agent, signal }, next) => {
      if (gateArmed && gateSession === undefined) {
        gateSession = agent.id
        entered.resolve(agent.id)
        const aborted = Promise.withResolvers<never>()
        const onAbort = () => aborted.reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        try { signal.throwIfAborted(); await Promise.race([released.promise, aborted.promise]); signal.throwIfAborted() }
        finally { signal.removeEventListener('abort', onAbort) }
      }
      return next()
    })
    // Production import normalizes real pixels; only the remote vision response is local.
    const fixturePng = await readFile(join(PACKAGE, 'assets/visual-curator-logo-v1.png'))
    styleId = z.object({ id: z.string() }).parse(await invoke('style-create', { operationId: randomUUID(), name: 'MCP launch fixture' })).id
    const imported = z.object({ results: z.array(z.object({ ok: z.boolean() }).passthrough()) }).parse(await invoke('reference-import', { operationId: randomUUID(), styleId, expectedRevision: 1, files: [{ name: 'fixture-reference.png', mime: 'image/png', base64: fixturePng.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] }))
    expect(imported.results).toEqual([expect.objectContaining({ ok: true })])
    const analysis = z.object({ runId: z.string() }).parse(await invoke('reference-analyze', { operationId: randomUUID(), styleId, buildDataset: true }))
    await expect.poll(async () => z.object({ status: z.string() }).parse(await invoke('run-get', { runId: analysis.runId })).status, { timeout: 30_000 }).toBe('completed')
    modelProfileId = z.object({ modelProfile: z.object({ id: z.string() }) }).parse(await invoke('style-get', { styleId })).modelProfile.id
    await invoke('export-start', { operationId: randomUUID(), kind: 'style', purpose: 'reference', releaseId: modelProfileId, mode: 'references-only' })
    await expect.poll(async () => {
      const page = z.object({ entries: z.array(z.object({ status: z.string(), exportId: z.string().optional() })) }).parse(await invoke('datasets-list', { styleId }))
      datasetId = page.entries.find(entry => entry.status === 'completed')?.exportId ?? ''
      return datasetId.length > 0
    }, { timeout: 30_000 }).toBe(true)
    const workspace = await host.ctx.workspaceRegistry.create(host.workspaceCwd, 'MCP image workspace')
    workspaceId = workspace.id
    gateArmed = true; ready = true
    if (HOLD) {
      await mkdir(join(REPO_ROOT, '.playwright-mcp'), { recursive: true })
      await writeFile(METADATA, JSON.stringify({ owner, pid: process.pid, ready, authenticatedUrl: host.authenticatedUrl,
        baseUrl: host.baseUrl, controlUrl, workspaceCwd: host.workspaceCwd, persistenceRoot: host.persistenceRoot,
        profileDir: host.ctx.profileContext.dir, harnessHome: host.harnessHome, styleId, modelProfileId, datasetId, workspaceId,
        suggestedBrief: BRIEF, suggestedTarget: 3, model: { provider: PROVIDER, model: MODEL },
        releasePath: '/release', statusPath: '/status', closePath: '/close',
      }, null, 2) + '\n', 'utf8')
      process.stdout.write('Visual Curator isolated Web is ready; authentication and control metadata were written to .playwright-mcp/visual-curator-launch-server.json\n')
      await closed.promise
    } else {
      const launch = searchLaunchViewSchema.parse(await invoke('search-launch-start', {
        operationId: randomUUID(), workspaceId, modelProfileId, datasetId,
        conversationModel: { provider: PROVIDER, model: MODEL }, taskBrief: BRIEF, targetCount: 3, output: { kind: 'original' },
      }))
      expect(await entered.promise).toBe(launch.sessionId)
      await expect.poll(async () => (await launches())[0]?.status, { timeout: 30_000 }).toBe('accepted')
      const agent = host.ctx.agents.get(SessionId(launch.sessionId))
      if (agent === undefined) throw new Error('The native launch did not retain its Agent')
      expect(agent.status).toBe('running')
      expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(0)
      expect(adapter.requests).toHaveLength(0)
      const grant = z.object({ sessionToken: z.string() }).parse(await invoke('session-open', { sessionId: launch.sessionId }))
      const conversation = z.object({ tasks: z.array(z.unknown()), launch: searchLaunchViewSchema }).parse(await invoke('conversation-runs', { sessionId: launch.sessionId, sessionToken: grant.sessionToken }))
      expect(conversation.tasks).toHaveLength(0)
      expect(conversation.launch.input).toMatchObject({ taskBrief: BRIEF, targetCount: 3 })
      release()
    }
    if (gateSession !== undefined) {
      release()
      const sessionId = SessionId(gateSession)
      await expect.poll(() => host.ctx.agents.get(sessionId)?.status, { timeout: 30_000 }).toBe('idle')
      const agent = host.ctx.agents.get(sessionId)
      if (agent === undefined) throw new Error('The accepted launch lost its Agent')
      const prompts = agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
      expect(prompts).toHaveLength(1)
      expect(prompts[0]?.type === 'user/message' ? prompts[0].data.content.filter(part => part.type === 'file') : []).toHaveLength(1)
      expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/call')).toHaveLength(0)
      expect(adapter.requests).toHaveLength(1)
      expect(workspace.sessionIds).toContain(SessionId(gateSession))
    }
  } finally {
    ready = false; release(); lifetime.abort()
    await scaffold?.close()
    await new Promise<void>((resolve, reject) => {
      server.close(error => error === undefined ? resolve() : reject(error))
      server.closeIdleConnections()
    })
    if (HOLD) {
      const metadata = await readFile(METADATA, 'utf8').catch((error) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''
        throw error
      })
      if (metadata && z.object({ owner: z.string() }).parse(JSON.parse(metadata)).owner === owner) await rm(METADATA)
    }
    await rm(root, { recursive: true, force: true })
  }
}, HOLD ? 30 * 60_000 : 180_000)
