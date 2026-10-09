import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AfpService } from '../src/host/afp-service.js'
import { registerAgentTools } from '../src/host/afp-agent-tools.js'
import { resolveConfig } from '../config-schema.js'
import { conversationPhotoModel, conversationCandidateModel, conversationSummaryPhotoModel } from '../src/client/afp-conversation-photos.js'
import { createAfpApiClient } from '../src/vendor/auto-afp-img/afp-api-client.mjs'

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
    const ToolTodo = await built('packages/todo/tool-todo')
    const home = await mkdtemp(join(tmpdir(), 'afp-session-')), ctx = new Context()
    t.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
    for (const plugin of [LlmRuntime, SessionStore, Projection, ToolRuntime, Agents]) await ctx.plugin(plugin)
    await ctx.plugin(SystemPrompt, { personaPrefix: 'AFP fixture' }); await ctx.plugin(Loop, { agents: [] })
    const todoPlugin = await ctx.plugin(ToolTodo, { allowParallelInProgress: false })
    const tasks = ['制定检索计划', '读取图片与收藏夹元数据', '保存最终选图']
    const scriptedCalls = [
      ['todo_write', { todos: tasks.map((content, index) => ({ content, status: index === 0 ? 'in_progress' : 'pending' })) }],
      ['afp_search_plan', { query: 'food photography' }],
      ['afp_photo_search_start', { query: 'cat', limit: 2, language: 'en' }],
      ['afp_photo_search', { query: 'cat', limit: 2, language: 'en', cursor: 'next' }],
      ['afp_photo_search', { query: 'cat', cursor: '?' }],
      ['afp_photo_details', { photoId: 'p1' }],
      ['afp_collection_list', {}],
      ['afp_collection_items', { collectionId: 'shared', limit: 2 }],
      ['afp_photo_selection', { photoIds: ['p2', 'p1'], criteria: 'Cat captions; metadata only', basis: 'metadata', runId: null }],
      ['afp_photo_selection', { photoIds: ['not-searched'], criteria: 'Reject absent evidence', basis: 'metadata', runId: null }],
      ['afp_report', { kind: 'run', id: '4a8b7032-fc24-4a8c-85fb-6c3a3c108b8f' }],
      ['afp_refresh', { mode: 'resume', categories: [], runId: '4a8b7032-fc24-4a8c-85fb-6c3a3c108b8f' }],
      ['afp_search_plan', { query: ' ' }],
      ...['schema', 'authentication', 'unknown'].map(category => ['afp_photo_search_start', { query: `fixture-${category}`, language: 'en', limit: 2 }]),
      ['todo_write', { todos: tasks.map(content => ({ content, status: 'completed' })) }],
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
      async searchPhotos(request) {
        const errors = new Map([['schema', 'GRAPHQL_VALIDATION_FAILED'], ['authentication', 'UNAUTHENTICATED'], ['unknown', 'UNRECOGNIZED']])
        const category = [...errors.keys()].find(value => request.variables.input.query === `caption="fixture-${value}"`)
        if (category) return createAfpApiClient({ accessToken: 'fixture-only', retries: 0, fetchImpl: async () =>
          new Response(JSON.stringify({ errors: [{ message: 'secret https://signed.example/?token=secret', extensions: { code: errors.get(category) } }] }), { status: 200 }) }).searchPhotos(request)
        return request.variables.input.cursor ? { docs: [photo('p2')], hasMore: false }
        : { docs: [photo('p1')], hasMore: true, cursor: 'next' } },
      async photosByIds(ids) { return ids.map(photo) },
      async listSelections() { return [{ id: 'shared', name: 'Shared', isPrivate: false }] },
      async getSelection() { return { docs: ['p1', 'p2', 'p3'] } },
    }
    const service = new AfpService({ profileContext: { home, dir: join(home, 'profile') } }, resolveConfig({ pageSize: 2 }),
      { connection: { async open() { return { client } } } })
    const disable = await service.enable('read')
    const disableRefresh = await service.enable('refresh')
    await service.store.saveRun({ schema: 1, id: '4a8b7032-fc24-4a8c-85fb-6c3a3c108b8f', status: 'paused', stage: 'visual',
      categories: ['animals'], settings: service.config, pending: null, groups: { animals: { candidates: ['one', 'two', 'three'].map(photo), batches: 1, exhausted: false } }, decisions: [
        { id: 'one', category: 'animals', keep: true, confidence: .99 },
        { id: 'two', category: 'animals', keep: false, reason: 'preview or vision request failed' },
        { id: 'three', category: 'animals', keep: false, reason: 'animal body is cropped or only a partial close-up' },
      ] })
    // 模拟已准入任务；真实忙碌与准入数量由 lifecycle.test.js 检查。
    service.live.set('fixture-active', { feature: 'refresh', runId: '4a8b7032-fc24-4a8c-85fb-6c3a3c108b8f', controller: new AbortController(), done: Promise.resolve() })
    const tools = await ctx.plugin({ inject: ['tools'], apply(child) {
      registerAgentTools(child, service, 'read'); registerAgentTools(child, service, 'refresh')
    } })
    async function turn(id) {
      const agent = await ctx.agentLoop.create(SessionId(id), { provider: 'fixture', model: 'fixture' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Plan AFP search, read actual photo pages and collection metadata, and reject a blank query.' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      return agent.session.snapshotEvents()
    }
    const enabled = await turn('afp-enabled')
    await tools.dispose(); await todoPlugin.dispose(); await disable(); await disableRefresh()
    const disabled = await turn('afp-disabled')
    const offered = foldRequestHeader(enabled).tools
    const search = offered.find(tool => tool.name === 'afp_photo_search')
    assert.ok(search)
    const start = offered.find(tool => tool.name === 'afp_photo_search_start')
    assert.ok(start); assert.equal(Object.hasOwn(start.parameters.properties, 'cursor'), false)
    const refresh = offered.find(tool => tool.name === 'afp_refresh')
    assert.equal(refresh.parameters.properties.targetPerCategory.maximum, 1000)
    assert.equal(refresh.parameters.properties.minimumReviewedPerCategory.minimum, 0)
    const projection = { tools: offered.map(tool => tool.name), firstPageSchema: structuredClone(start.parameters), refreshSchema: structuredClone(refresh.parameters), cursorSchema: structuredClone(search.parameters.properties.cursor),
      calls: enabled.filter(event => event.type === 'tool/call').map(event => ({ name: event.data.name, arguments: event.data.arguments })),
      results: enabled.filter(event => event.type === 'tool/result').map(event => structuredClone(event.data)),
      todoWrites: enabled.filter(event => event.type === 'todo/write').map(event => structuredClone(event.data.todos)),
      disabledTools: (foldRequestHeader(disabled).tools ?? []).map(tool => tool.name) }
    assert.equal(projection.calls.length, scriptedCalls.length); assert.equal(projection.results.length, scriptedCalls.length)
    assert.equal(projection.calls[0].name, 'todo_write')
    assert.equal(projection.calls.some(call => call.name === 'create_goal'), false)
    assert.equal(projection.todoWrites.length, 2)
    const afpResults = projection.results.filter((_result, index) => scriptedCalls[index][0] !== 'todo_write')
    assert.equal(projection.results[0].message.isError, false)
    assert.equal(afpResults[3].message.isError, true)
    assert.equal(afpResults.at(-1).message.isError, true)
    assert.equal(Object.hasOwn(projection.cursorSchema, 'pattern'), false)
    assert.doesNotMatch(JSON.stringify(projection.results), /signed\.example|secret/)
    // 卡片从已记录输出重建；不再查询 AFP，也不依赖当前工作台搜索。
    projection.photoCards = projection.results.flatMap((result, index) => {
      const name = scriptedCalls[index][0]
      if (!['afp_photo_search_start', 'afp_photo_search', 'afp_photo_details', 'afp_collection_items'].includes(name)) return []
      return [{ tool: name, ...conversationPhotoModel({ phase: 'result', block: { content: result.message.content, isError: result.message.isError } }) }]
    })
    const rows = projection.results.map((result, index) => ({ root: { kind: 'tool-result', call: { name: scriptedCalls[index][0] }, ...result.message } }))
    projection.processCandidates = conversationCandidateModel(rows)
    projection.finalSelection = conversationSummaryPhotoModel(rows)
    assert.deepEqual(projection.finalSelection.photos.map(photo => photo.id), ['p2', 'p1'])
    assert.equal(JSON.parse(afpResults[8].message.content[0].text.slice('Error: '.length)).code, 'selection-missing-photos')
    assert.equal(JSON.parse(afpResults[10].message.content[0].text.slice('Error: '.length)).code, 'refresh-busy')
    const reportResult = JSON.parse(afpResults[9].message.content[0].text)
    const savedReport = await service.store.read(join(service.store.profile, 'conversation-results', reportResult.resultRef + '.json'))
    assert.deepEqual(savedReport.result.reviewedPhotoIds, ['one', 'three'])
    assert.deepEqual(savedReport.result.reviewedPhotos.map(photo => [photo.id, photo.keep, photo.requestFailed]), [['one', true, false], ['two', false, true], ['three', false, false]])
    assert.equal(reportResult.reviewedPhotos, undefined)
    assert.equal(reportResult.reviewedPhotoIds, undefined)
    assert.deepEqual(projection.disabledTools, [])
    // UUID 映射保留引用之间的对应关系；耗时是测量值，不进入可重放快照。
    const references = new Map()
    function normalize(value) {
      if (Array.isArray(value)) return value.map(normalize)
      if (!value || typeof value !== 'object') return value
      const entries = Object.entries(value).filter(([key]) => key !== 'durationMs').map(([key, item]) => {
        if (key === 'resultRef') {
          if (!references.has(item)) references.set(item, `00000000-0000-4000-8000-${String(references.size + 1).padStart(12, '0')}`)
          return [key, references.get(item)]
        }
        return [key, normalize(item)]
      })
      return Object.fromEntries(entries)
    }
    for (const result of projection.results) {
      delete result.message.id; delete result.durationMs
      for (const block of result.message.content) if (block.type === 'text' && (block.text.startsWith('{') || (result.message.isError && block.text.startsWith('Error: {')))) {
        const prefix = result.message.isError ? 'Error: ' : ''
        block.text = prefix + JSON.stringify(normalize(JSON.parse(block.text.slice(prefix.length))))
      }
      if (result.meta) result.meta = normalize(result.meta)
    }
    const file = new URL('./fixtures/session-search.expected.json', import.meta.url)
    if (process.env.DSH_AFP_REFRESH_SNAPSHOT === '1') await writeFile(file, JSON.stringify(projection, null, 2) + '\n', 'utf8')
    assert.deepEqual(projection, JSON.parse(await readFile(file, 'utf8')))
  })
