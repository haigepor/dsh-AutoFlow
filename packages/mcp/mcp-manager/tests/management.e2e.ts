/** Real profile composition, MCP HTTP exchange, and an existing Agent across configuration changes. */
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import PluginManager from '@deepseek-ai/dsh-plugin-manager'
import Hmr from '@deepseek-ai/dsh-hmr'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import McpConnections from '../../../mcp/mcp-client/src/connections.ts'
import { startHttpMcpFixture } from '../../../mcp/mcp-client/tests/http-fixture.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import McpSettings from '../src/index.ts'

async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-mcp-settings-')))
  const dir = join(home, 'profiles', 'test')
  initProfile(dir, ['core'])
  const bundle = join(dir, 'node_modules', 'core')
  mkdirSync(bundle, { recursive: true })
  const scope = join(dir, 'node_modules', '@deepseek-ai')
  mkdirSync(scope, { recursive: true })
  symlinkSync(fileURLToPath(new URL('../../../mcp/mcp-client', import.meta.url)), join(scope, 'dsh-mcp-client'), 'junction')
  writeFileSync(join(home, 'package.json'), '{"name":"mcp-test-installation"}\n', 'utf8')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'core', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }), 'utf8')
  const plugins = {
    editor: ConfigEditor, manager: PluginManager, connections: McpConnections, mcpSettings: McpSettings,
    systemPrompt: SystemPrompt, tools: ToolRuntime, agents: AgentRegistry, agentLoop: AgentLoop,
    llm: LlmRuntime, sessions: SessionStore, projections: SessionProjectionRegistry,
  }
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: Object.keys(plugins).map(name => ({ id: name, name: `cordis:${name}`, ...name === 'agentLoop' ? { config: { agents: [] } } : {} })) }]), 'utf8')
  writeFileSync(join(dir, 'cordis.yml'), '[]\n', 'utf8')
  const restart = vi.fn()
  const profile: ProfileContext = { name: 'test', startedBundles: ['core'], dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined, restart }
  const ctx = await boot('mcp-test', join(dir, 'cordis.yml'), readProfilePatches('mcp-test', profile), (ctx) => {
    ctx.provide('profileContext', profile)
    ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    Object.assign(ctx.loader.builtins, plugins)
  })
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  await ctx.plugin(Timer)
  await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
  await ctx.hmr.runExclusive(async () => {})
  const server = await startHttpMcpFixture()
  onTestFinished(() => server.close())
  return { ctx, dir, server, restart }
}

it('adds, edits while disabled, enables, restarts and disables MCP without replacing an existing session', async () => {
  const { ctx, server, dir } = await fixture()
  const adapter = new MockAdapter([textResponse('before'), toolCallResponse('mcp-call', 'mcp__demo__ping', {}), textResponse('after'), textResponse('disabled')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('existing-mcp-session'), { provider: 'mock', model: 'model' })
  const send = async (): Promise<void> => {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
  await send()
  const firstEvents = agent.session.snapshotEvents()
  const defaults = (await ctx.mcpSettings.list()).defaults
  const created = await ctx.mcpSettings.create({ ...defaults, serverName: 'demo', transport: 'streamable-http', url: server.url, headers: { Authorization: 'Bearer private-token' } }, false)
  expect(created).toMatchObject({ status: 'saved', server: { enabled: false, phase: 'disabled' } })
  if (created.status !== 'saved') throw new Error(JSON.stringify(created))
  const detail = await ctx.mcpSettings.detail(created.server.id)
  expect(detail.config.headers).toEqual({ Authorization: null })
  expect(JSON.stringify(detail)).not.toContain('private-token')
  expect(await ctx.mcpSettings.update(detail.id, { ...detail.config, toolCallTimeoutMs: 12000 }, detail.revision)).toMatchObject({ status: 'saved', server: { phase: 'disabled' } })
  expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toContain('private-token')
  expect(await ctx.mcpSettings.update(detail.id, detail.config, detail.revision)).toMatchObject({ status: 'rejected', code: 'conflict' })
  const enabled = await ctx.mcpSettings.setEnabled(detail.id, true)
  expect(enabled).toMatchObject({ status: 'saved', application: 'applied', server: { phase: 'connected', tools: ['mcp__demo__ping'] } })
  await send()
  expect(adapter.requests.at(-1)?.tools?.map(tool => tool.name)).toContain('mcp__demo__ping')
  expect(server.calls).toEqual(['ping'])
  const tools = ctx.tools.schemas(agent).filter(tool => tool.name === 'mcp__demo__ping')
  expect(tools).toHaveLength(1)
  const beforeRestart = server.authorization.length
  expect(await ctx.mcpSettings.restart(detail.id)).toMatchObject({ status: 'saved', server: { phase: 'connected' } })
  expect(server.authorization.length).toBeGreaterThan(beforeRestart)
  expect(ctx.tools.schemas(agent).filter(tool => tool.name === 'mcp__demo__ping')).toHaveLength(1)
  expect(await ctx.mcpSettings.setEnabled(detail.id, false)).toMatchObject({ status: 'saved', server: { phase: 'disabled', tools: [] } })
  await send()
  expect(adapter.requests.at(-1)?.tools?.map(tool => tool.name) ?? []).not.toContain('mcp__demo__ping')
  expect(agent.session.id).toBe('existing-mcp-session')
  expect(agent.session.snapshotEvents().slice(0, firstEvents.length)).toEqual(firstEvents)
})

it('rejects invalid and duplicate entries and authorizes configuration restart without a plugin upgrade', async () => {
  const { ctx, server, dir, restart } = await fixture()
  const defaults = (await ctx.mcpSettings.list()).defaults
  const draft = { ...defaults, serverName: 'demo', transport: 'streamable-http' as const, url: server.url }
  expect(await ctx.mcpSettings.create({ ...draft, url: 'file:///tmp' }, false)).toEqual({ status: 'rejected', code: 'invalid-config' })
  expect((await ctx.mcpSettings.list()).servers).toEqual([])
  expect(await ctx.mcpSettings.create(draft, false)).toMatchObject({ status: 'saved' })
  const saved = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
  expect(await ctx.mcpSettings.create(draft, false)).toEqual({ status: 'rejected', code: 'duplicate-name' })
  expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(saved)
  const status = ctx.pluginManager.restartStatus()
  expect(ctx.pluginManager.restartAfterUpdate(status.generation)).toBe(false)
  expect(ctx.pluginManager.restartForConfiguration(status.generation)).toBe(true)
  expect(ctx.pluginManager.restartForConfiguration(status.generation)).toBe(true)
  expect(restart).toHaveBeenCalledOnce()
})
