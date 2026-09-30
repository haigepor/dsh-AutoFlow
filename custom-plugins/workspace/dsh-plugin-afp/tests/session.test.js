import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AfpService } from '../src/host/afp-service.js'
import { registerAgentTools } from '../src/host/afp-agent-tools.js'
import { resolveConfig } from '../config-schema.js'

// 此测试消费仓库构建产物；独立 npm 副本没有仓库时明确跳过，不冒充已执行会话验证。
const repo = new URL('../../../../', import.meta.url)
const built = path => import(new URL(path + '/lib/index.js', repo))
test('recorded keyless Session calls the AFP search tool and a new Session after disposal cannot see it',
  { skip: !existsSync(new URL('packages/core/agent-loop/lib/index.js', repo)) }, async t => {
    const { Context } = await built('vendor/cordis')
    const { default: LlmRuntime, LlmAdapter, createUserMessage } = await built('packages/llm/llm')
    const { default: SessionStore, SessionId, foldRequestHeader } = await built('packages/core/session')
    const { default: Projection } = await built('packages/session/session-projection')
    const { default: SystemPrompt } = await built('packages/core/system-prompt')
    const { default: ToolRuntime } = await built('packages/core/tools')
    const { default: Agents } = await built('packages/core/agent')
    const { default: Loop } = await built('packages/core/agent-loop')
    const home = await mkdtemp(join(tmpdir(), 'afp-session-')), ctx = new Context()
    t.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
    for (const plugin of [LlmRuntime, SessionStore, Projection, ToolRuntime, Agents]) await ctx.plugin(plugin)
    await ctx.plugin(SystemPrompt, { personaPrefix: 'AFP fixture' }); await ctx.plugin(Loop, { agents: [] })
    class ScriptedAdapter extends LlmAdapter {
      calls = 0
      async resolveModel(provider, model) { return { provider, id: model, name: model } }
      async *stream() {
        if (this.calls++ === 0) {
          const block = { type: 'tool-call', id: 'afp-fixture-call', name: 'afp_search_plan', arguments: JSON.stringify({ query: 'food photography' }) }
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
          yield { type: 'block-end', index: 0, block }; yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } else {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: 'done' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
    }
    ctx.llm.registerAdapter(['fixture'], new ScriptedAdapter())
    const service = new AfpService({ profileContext: { home, dir: join(home, 'profile') } }, resolveConfig({}))
    const disable = await service.enable('read')
    const tools = await ctx.plugin({ inject: ['tools'], apply(child) { registerAgentTools(child, service, 'read') } })
    async function turn(id) {
      const agent = await ctx.agentLoop.create(SessionId(id), { provider: 'fixture', model: 'fixture' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Search AFP offline.' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      return agent.session.snapshotEvents()
    }
    const enabled = await turn('afp-enabled')
    await tools.dispose(); await disable()
    const disabled = await turn('afp-disabled')
    const projection = { tools: foldRequestHeader(enabled).tools.map(tool => tool.name),
      calls: enabled.filter(event => event.type === 'tool/call').map(event => ({ name: event.data.name, arguments: event.data.arguments })),
      results: enabled.filter(event => event.type === 'tool/result').map(event => structuredClone(event.data)),
      disabledTools: (foldRequestHeader(disabled).tools ?? []).map(tool => tool.name) }
    assert.equal(projection.calls.length, 1); assert.equal(projection.results.length, 1)
    assert.equal(projection.results[0].message.isError, false)
    assert.deepEqual(projection.disabledTools, [])
    // 仅归一化协议生成的消息 ID 与耗时；工具输出保持原样。
    for (const result of projection.results) { delete result.message.id; delete result.durationMs }
    const file = new URL('./fixtures/session-search.expected.json', import.meta.url)
    if (process.env.DSH_AFP_REFRESH_SNAPSHOT === '1') await writeFile(file, JSON.stringify(projection, null, 2) + '\n', 'utf8')
    assert.deepEqual(projection, JSON.parse(await readFile(file, 'utf8')))
  })
