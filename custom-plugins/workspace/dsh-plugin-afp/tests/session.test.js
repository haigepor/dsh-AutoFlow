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
test('recorded keyless Session plans and reads AFP metadata with safe errors, then disposal removes all tools',
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
    const scriptedCalls = [
      ['afp_search_plan', { query: 'food photography' }],
      ['afp_photo_search_start', { query: 'cat', limit: 2, language: 'en' }],
      ['afp_photo_search', { query: 'cat', limit: 2, language: 'en', cursor: 'next' }],
      ['afp_photo_search', { query: 'cat', cursor: '?' }],
      ['afp_photo_details', { photoId: 'p1' }],
      ['afp_collection_list', {}],
      ['afp_collection_items', { collectionId: 'shared', limit: 2 }],
      ['afp_search_plan', { query: ' ' }],
    ]
    class ScriptedAdapter extends LlmAdapter {
      calls = 0
      async resolveModel(provider, model) { return { provider, id: model, name: model } }
      async *stream() {
        const call = scriptedCalls[this.calls++]
        if (call) {
          const block = { type: 'tool-call', id: `afp-fixture-call-${this.calls}`, name: call[0], arguments: JSON.stringify(call[1]) }
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
    const photo = id => ({ id, guid: id, title: `Photo ${id}`, caption: 'Cat', provider: 'AFP', mockup: [{ href: 'https://signed.example/?token=secret' }] })
    const client = {
      async searchPhotos(request) { return request.variables.input.cursor ? { docs: [photo('p2')], hasMore: false }
        : { docs: [photo('p1')], hasMore: true, cursor: 'next' } },
      async photosByIds(ids) { return ids.map(photo) },
      async listSelections() { return [{ id: 'shared', name: 'Shared', isPrivate: false }] },
      async getSelection() { return { docs: ['p1', 'p2', 'p3'] } },
    }
    const service = new AfpService({ profileContext: { home, dir: join(home, 'profile') } }, resolveConfig({ pageSize: 2 }),
      { connection: { async open() { return { client } } } })
    const disable = await service.enable('read')
    const tools = await ctx.plugin({ inject: ['tools'], apply(child) { registerAgentTools(child, service, 'read') } })
    async function turn(id) {
      const agent = await ctx.agentLoop.create(SessionId(id), { provider: 'fixture', model: 'fixture' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Plan AFP search, read actual photo pages and collection metadata, and reject a blank query.' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      return agent.session.snapshotEvents()
    }
    const enabled = await turn('afp-enabled')
    await tools.dispose(); await disable()
    const disabled = await turn('afp-disabled')
    const offered = foldRequestHeader(enabled).tools
    const search = offered.find(tool => tool.name === 'afp_photo_search')
    assert.ok(search)
    const start = offered.find(tool => tool.name === 'afp_photo_search_start')
    assert.ok(start); assert.equal(Object.hasOwn(start.parameters.properties, 'cursor'), false)
    const projection = { tools: offered.map(tool => tool.name), firstPageSchema: structuredClone(start.parameters), cursorSchema: structuredClone(search.parameters.properties.cursor),
      calls: enabled.filter(event => event.type === 'tool/call').map(event => ({ name: event.data.name, arguments: event.data.arguments })),
      results: enabled.filter(event => event.type === 'tool/result').map(event => structuredClone(event.data)),
      disabledTools: (foldRequestHeader(disabled).tools ?? []).map(tool => tool.name) }
    assert.equal(projection.calls.length, scriptedCalls.length); assert.equal(projection.results.length, scriptedCalls.length)
    assert.equal(projection.results[0].message.isError, false)
    assert.equal(projection.results[3].message.isError, true)
    assert.equal(projection.results.at(-1).message.isError, true)
    assert.equal(Object.hasOwn(projection.cursorSchema, 'pattern'), false)
    assert.doesNotMatch(JSON.stringify(projection.results), /signed\.example|secret|previewPath/)
    assert.deepEqual(projection.disabledTools, [])
    // 快照保留工具数据和错误字段，仅移除协议 ID 与真实测量耗时。
    for (const result of projection.results) {
      delete result.message.id; delete result.durationMs
      for (const block of result.message.content) if (block.type === 'text' && (block.text.startsWith('{') || (result.message.isError && block.text.startsWith('Error: {')))) {
        const prefix = result.message.isError ? 'Error: ' : ''
        const payload = JSON.parse(block.text.slice(prefix.length))
        if (payload.meta) delete payload.meta.durationMs
        if (payload.code) delete payload.durationMs
        block.text = prefix + JSON.stringify(payload)
      }
    }
    const file = new URL('./fixtures/session-search.expected.json', import.meta.url)
    if (process.env.DSH_AFP_REFRESH_SNAPSHOT === '1') await writeFile(file, JSON.stringify(projection, null, 2) + '\n', 'utf8')
    assert.deepEqual(projection, JSON.parse(await readFile(file, 'utf8')))
  })
