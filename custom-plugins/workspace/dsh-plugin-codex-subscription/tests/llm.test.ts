/** Native Responses protocol fixtures exercise the public adapter, account pool and replay together. */
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { zstdDecompressSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { createAssistantMessage, createToolResultMessage, createUserMessage, expandAssistantStream, BlockAssembler, ReasoningEffortId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { CodexAccounts, ACCOUNTS_KEY, type AccountsOptions, type PoolAdapterOptions } from '../src/host/accounts/index.ts'
import { CodexPoolAdapter, commonCapabilities } from '../src/host/llm/index.ts'
import { nativeRequest, wrapReplay } from '../src/host/llm/replay.ts'
import { CodexUpstream } from '../src/host/upstream.ts'
import { resolveOptions } from '../src/host/config.ts'

const provider = 'autoflow-codex', model = 'gpt-6.1-sol'
const accountKey = (id: string) => `acct-${createHash('sha256').update(id).digest('hex').slice(0, 24)}`
const token = (id: string) => `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: id, chatgpt_plan_type: 'plus' } })).toString('base64url')}.fixture`
const items = [
  { type: 'reasoning', id: 'rs_fixture', encrypted_content: 'encrypted-fixture', summary: [{ type: 'summary_text', text: 'fixture reasoning' }] },
  { type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'output_text', text: 'fixture answer', annotations: [] }] },
  ...[0, 1].map(index => ({ type: 'function_call', id: `fc_${index}`, call_id: `call_${index}`, name: 'lookup', arguments: JSON.stringify({ index }) })),
]
const frames = [ { type: 'response.created', response: { id: 'resp_fixture' } },
  ...items.flatMap((item, output_index) => [{ type: 'response.output_item.added', output_index, item }, { type: 'response.output_item.done', output_index, item }]),
  { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: items,
    usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 3 }, output_tokens: 4, total_tokens: 14 } } },
]
const response = () => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })

function fixture(reply?: (headers: Headers) => Response, directory?: (headers: Headers) => object[], responseFetch?: typeof fetch) {
  let record: CredentialRecord | undefined, tail: Promise<void> = Promise.resolve()
  const requests: { headers: Headers; payload: Record<string, unknown>; signal?: AbortSignal | null }[] = []
  const options: AccountsOptions = { credentials: {
    readRecord: async () => structuredClone(record),
    modifyRecord: async (_key, mutate) => {
      const operation = tail.then(async () => { const next = await mutate(structuredClone(record)); if (next !== undefined) record = next; return structuredClone(record) })
      tail = operation.then(() => {}, () => {}); return operation
    },
  }, authorization: { registerFlow: () => () => {}, begin: async () => ({ status: 'authorized' }), cancel() {} },
    fetch: async (input, init) => {
      if (String(input).includes('/codex/models')) return Response.json({ models: directory?.(new Headers(init?.headers)) ?? [{ slug: model }] })
      if (String(input).includes('/wham/usage')) return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } })
      const headers = new Headers(init?.headers), raw = init?.body
      assert.ok(typeof raw === 'string' || raw instanceof Uint8Array)
      const body = typeof raw === 'string' ? raw : (headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(raw) : Buffer.from(raw)).toString('utf8')
      requests.push({ headers, payload: JSON.parse(body), ...(init?.signal === undefined ? {} : { signal: init.signal }) })
      return responseFetch === undefined ? reply?.(headers) ?? response() : responseFetch(input, init)
    }, clientId: 'fixture', authorizeUrl: 'https://auth.fixture.invalid/authorize', tokenUrl: 'https://auth.fixture.invalid/token', callbackPorts: [0],
    loginTimeoutMs: 1000, tokenTimeoutMs: 1000, sessionAffinityLimit: 8, modelCooldownLimit: 8, cooldownMs: 1000, baseUrl: 'https://chatgpt.fixture.invalid/backend-api', clientVersion: 'fixture', discoveryTtlMs: 5000 }
  const accounts = new CodexAccounts(options)
  const poolOptions: PoolAdapterOptions = { provider, displayName: 'Fixture subscription', baseUrl: options.baseUrl, timeoutMs: 1000, streamIdleTimeoutMs: 1000,
    maxRequestImageBytes: 1000000, requestImagePixelBudget: 1000000, requestImageMaxBytes: 1000000 }
  const adapter = new CodexPoolAdapter(accounts, poolOptions)
  const seed = async (ids: string[]) => {
    const now = Date.now()
    await options.credentials.modifyRecord(ACCOUNTS_KEY, async () => ({ kind: 'grant', payload: { version: 1, revision: 1,
      accounts: Object.fromEntries(ids.map(id => [accountKey(id), { accountKey: accountKey(id), accountId: id, label: id, enabled: true, priority: 0,
        revision: 1, createdAt: now, updatedAt: now, credential: { type: 'oauth', access: token(id), refresh: `fixture-refresh-${id}`, expires: now + 3600000, accountId: id } }])) } }))
  }
  return { accounts, adapter, requests, seed, options, poolOptions }
}

const request = (sessionId = 'fixture-session'): GenerateOptions => ({ provider, model, system: 'AutoFlow logged system prompt',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture question' }] }], sessionId: brandString<Branded<'SessionId'>>(sessionId),
  tools: [{ name: 'lookup', description: 'fixture lookup', parameters: { type: 'object', properties: { index: { type: 'number' } } } }] })
async function collect(stream: AsyncIterable<StreamChunk>) { const assembler = new BlockAssembler(); for await (const chunk of stream) assembler.push(chunk); return assembler }

test('native search uses a scheduled Codex account and exposes source URLs without a DeepSeek credential', async () => {
  const search = { type: 'web_search_call', id: 'ws_native_fixture', status: 'completed', action: { type: 'search', sources: [{ type: 'url', url: 'https://github.com/trending' }] } }
  const answer = { type: 'message', id: 'msg_native_fixture', role: 'assistant', content: [{ type: 'output_text', text: 'Current projects', annotations: [] }] }
  const events = [{ type: 'response.created', response: { id: 'resp_native_fixture' } },
    ...[search, answer].flatMap((item, output_index) => [{ type: 'response.output_item.added', output_index, item }, { type: 'response.output_item.done', output_index, item }]),
    { type: 'response.completed', response: { id: 'resp_native_fixture', status: 'completed', output: [search, answer], usage: { input_tokens: 2, output_tokens: 2 } } }]
  const f = fixture(() => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }))
  try {
    await f.seed(['a'])
    const recorded: unknown[] = []
    const result = await f.adapter.searchNative({ provider, model, query: 'current projects', maxResults: 2, signal: new AbortController().signal,
      recordRequest: input => { recorded.push(input) } })
    assert.deepEqual(result.sources, [{ url: 'https://github.com/trending' }])
    assert.deepEqual(f.requests[0]?.payload.tools, [{ type: 'web_search' }])
    assert.equal(f.requests[0]?.headers.get('authorization'), `Bearer ${token('a')}`)
    assert.equal(recorded.length, 1)
    assert.equal(await f.accounts.withAccount({ kind: 'usage', accountKey: accountKey('a') }, async lease => lease.accountId), 'a')
  } finally { await f.accounts.dispose() }
})

test('a manual native-search opt-out prevents a Codex search request', async () => {
  const f = fixture()
  try {
    await f.seed(['a'])
    const optedOut = new CodexPoolAdapter(f.accounts, { ...f.poolOptions,
      listModels: async () => (await f.accounts.models()).map(model => ({ ...model, nativeWebSearch: false })) })
    await assert.rejects(optedOut.searchNative({ provider, model, query: 'current projects', maxResults: 2,
      signal: new AbortController().signal, recordRequest: () => {} }), /disabled/)
    assert.equal(f.requests.length, 0)
  } finally { await f.accounts.dispose() }
})

test('native Codex emits reasoning, parallel tool IDs, usage and account-wrapped replay while preserving AutoFlow instructions', async () => {
  const f = fixture(); await f.seed(['a', 'b'])
  const first = await collect(f.adapter.stream(request())), wire = f.requests[0]
  assert.ok(wire); assert.equal(wire.payload.instructions, 'AutoFlow logged system prompt')
  assert.equal(wire.payload.store, false); assert.equal(wire.payload.stream, true)
  assert.equal(wire.headers.get('thread-id'), wire.headers.get('session-id'))
  assert.equal(wire.headers.get('version'), 'fixture')
  assert.equal(wire.headers.get('chatgpt-account-id'), 'a'); assert.equal(wire.headers.get('authorization'), `Bearer ${token('a')}`)
  assert.deepEqual(first.blocks().map(block => block.type), ['reasoning', 'text', 'tool-call', 'tool-call'])
  assert.deepEqual(first.blocks().filter(block => block.type === 'tool-call').map(block => block.id), ['call_0|fc_0', 'call_1|fc_1'])
  assert.deepEqual(first.usage, { inputTokens: 7, outputTokens: 4, cacheReadTokens: 3, totalTokens: 14 })
  assert.equal(first.finish?.kind, 'tool-calls')
  const replay = first.replayState; assert.ok(replay)
  const history = createAssistantMessage({ content: first.blocks(), source: { provider, model, replayState: replay } })
  const next = request(); next.messages.push(history)
  for (const block of first.blocks()) if (block.type === 'tool-call') next.messages.push(createToolResultMessage({ callId: block.id, isError: false, content: [{ type: 'text', text: 'fixture result' }] }))
  await collect(f.adapter.stream(next))
  assert.equal(f.requests[1]?.headers.get('chatgpt-account-id'), 'a')
  const inputs = f.requests[1]?.payload.input; assert.ok(Array.isArray(inputs))
  assert.ok(inputs.some(item => item.type === 'reasoning' && item.encrypted_content === 'encrypted-fixture'))
  assert.deepEqual(inputs.filter(item => item.type === 'function_call').map(item => item.call_id), ['call_0', 'call_1'])
  assert.deepEqual(inputs.filter(item => item.type === 'function_call_output').map(item => item.call_id), ['call_0', 'call_1'])
})

test('prepare captures every account prepared stream and a later catalog mutation cannot change dispatch capabilities', async () => {
  const f = fixture(); await f.seed(['a', 'b'])
  const prepare = mock.method(PiAiAdapter.prototype, 'prepareCall'), dynamicStream = mock.method(PiAiAdapter.prototype, 'stream', () => { throw new Error('unprepared dispatch') })
  try {
    const prepared = await f.adapter.prepareCall(provider, model)
    assert.equal(prepare.mock.callCount(), 2)
    for (const id of ['a', 'b']) f.accounts.nativeFor(accountKey(id)).provider.getModels = () => []
    const answer = await collect(prepared.stream(request()))
    assert.equal(answer.finish?.kind, 'tool-calls'); assert.equal(dynamicStream.mock.callCount(), 0)
    assert.ok(prepared.model.context?.contextWindow)
  } finally { prepare.mock.restore(); dynamicStream.mock.restore() }
})

test('account/provider replay mapping is paired and drops encrypted metadata when the account changes', () => {
  const native = { response: { kind: 'pi-ai', version: 2, provider: 'openai-codex', model, api: 'openai-codex-responses', stopReason: 'stop' }, blocks: [{ type: 'reasoning', thinkingSignature: 'encrypted-fixture' }] }
  const message = createAssistantMessage({ content: [{ type: 'reasoning', text: 'logged reasoning' }], source: { provider, model, replayState: wrapReplay(native, accountKey('a'), provider) } })
  const options = { ...request(), messages: [message] }
  const matching = nativeRequest(options, accountKey('a'), provider).messages[0]
  assert.ok(matching?.role === 'assistant'); assert.equal(matching.source.provider, 'openai-codex'); assert.deepEqual(matching.source.replayState, native)
  const switched = nativeRequest(options, accountKey('b'), provider).messages[0]
  assert.ok(switched?.role === 'assistant'); assert.equal(switched.source.replayState, undefined); assert.deepEqual(switched.content, message.content)
  assert.equal(message.source.provider, provider)
})

test('common capabilities intersect modalities/reasoning and use the smallest context capacity', () => {
  const base: LlmResolvedModelInfo = { provider: 'openai-codex', id: model, name: 'fixture', inputModalities: ['text', 'image'], context: { contextWindow: 10000 }, systemPromptUpdate: 'in-history', toolUpdate: 'in-history' }
  const shared = commonCapabilities([base, { ...base, inputModalities: ['text'], context: { contextWindow: 4000 }, toolUpdate: 'addition-only' }], provider)
  assert.deepEqual(shared.inputModalities, ['text']); assert.equal(shared.context?.contextWindow, 4000); assert.equal(shared.toolUpdate, 'addition-only')
})

test('a model route advertises and prepares one complete capability group and never falls back to a smaller account', async () => {
  let rejectPro = false
  const f = fixture(headers => rejectPro && headers.get('chatgpt-account-id') === 'pro' ? Response.json({ error: 'insufficient_quota' }, { status: 402 }) : response(), headers => [{
    slug: model, input_modalities: ['text'], context_window: headers.get('chatgpt-account-id') === 'pro' ? 65536 : 4096,
    max_output_tokens: headers.get('chatgpt-account-id') === 'pro' ? 8192 : 1024,
    supported_reasoning_levels: headers.get('chatgpt-account-id') === 'pro' ? [{ effort: 'high' }] : [],
  }])
  try {
    await f.seed(['pro', 'free']); await f.accounts.update(accountKey('free'), { priority: 100, revision: 1 })
    const directory = await f.accounts.models(), advertised = directory.find(item => item.id === model)!
    assert.equal(advertised.contextWindow, 65536)
    const prepared = await f.adapter.prepareCall(provider, model)
    assert.equal(prepared.model.context?.contextWindow, advertised.contextWindow)
    assert.deepEqual(prepared.model.reasoning?.efforts.map(effort => String(effort.id)), ['high'])
    await collect(prepared.stream(request())); assert.deepEqual(f.requests.map(item => item.headers.get('chatgpt-account-id')), ['pro'])
    const basic = directory.find(item => item.id !== model)!
    assert.equal(basic.contextWindow, 4096)
    const low = await f.adapter.prepareCall(provider, basic.id)
    assert.equal(low.model.context?.contextWindow, 4096)
    await collect(low.stream({ ...request(), model: basic.id }))
    assert.equal(f.requests.at(-1)?.headers.get('chatgpt-account-id'), 'free')
    assert.equal(f.requests.at(-1)?.payload.model, model)
    rejectPro = true; f.requests.length = 0
    const failed = await collect(prepared.stream(request()))
    assert.equal(failed.finish?.kind, 'error'); assert.deepEqual(f.requests.map(item => item.headers.get('chatgpt-account-id')), ['pro'])
  } finally { await f.accounts.dispose() }
})

test('consumer return settles the selected request without dispatching or replaying another request', async () => {
  const f = fixture(); await f.seed(['a'])
  const stream = f.adapter.stream(request())[Symbol.asyncIterator](), first = await stream.next()
  assert.equal(first.done, false)
  await stream.return?.(undefined)
  assert.equal(f.requests.length, 1)
  assert.equal(await f.accounts.withAccount({ kind: 'usage', accountKey: accountKey('a') }, async lease => lease.accountId), 'a')
})

test('a newly added higher-priority account cannot enter an already prepared request', async () => {
  const f = fixture(); await f.seed(['a'])
  const prepared = await f.adapter.prepareCall(provider, model)
  await f.seed(['a', 'b']); await f.accounts.update(accountKey('b'), { priority: 100, revision: 1 })
  await collect(prepared.stream(request()))
  assert.equal(f.requests[0]?.headers.get('chatgpt-account-id'), 'a')
})

test('disabling every prepared candidate rejects before dispatch without an unhandled completion promise', async () => {
  const f = fixture(); await f.seed(['a'])
  const prepared = await f.adapter.prepareCall(provider, model)
  await f.accounts.update(accountKey('a'), { enabled: false, revision: 1 })
  await assert.rejects(collect(prepared.stream(request())), { code: 'NO_AVAILABLE_ACCOUNT' })
  assert.equal(f.requests.length, 0)
})

for (const status of [402, 429]) test(`native text switches accounts after a complete HTTP ${status} refusal before any output`, async () => {
  const f = fixture(headers => headers.get('chatgpt-account-id') === 'a' ? Response.json({ error: { message: 'quota exhausted', type: 'rate_limit_exceeded' } }, { status }) : response())
  try {
    await f.seed(['a', 'b'])
    const answer = await collect(f.adapter.stream(request()))
    assert.equal(answer.finish?.kind, 'tool-calls', JSON.stringify(answer.finish))
    assert.deepEqual(f.requests.map(request => request.headers.get('chatgpt-account-id')), ['a', 'b'])
  } finally { await f.accounts.dispose() }
})

for (const code of ['model_not_found', 'rate_limit_exceeded']) test(`native text classifies early SSE ${code} before account output`, async () => {
  const f = fixture(headers => headers.get('chatgpt-account-id') === 'a'
    ? new Response(`data: ${JSON.stringify({ type: 'error', error: { code, message: 'private-token', param: 'model' } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }) : response())
  try {
    await f.seed(['a', 'b'])
    assert.equal((await collect(f.adapter.stream(request()))).finish?.kind, 'tool-calls')
    assert.deepEqual(f.requests.map(item => item.headers.get('chatgpt-account-id')), ['a', 'b'])
    assert.equal(await f.accounts.withAccount({ kind: 'usage', accountKey: accountKey('a') }, async lease => lease.accountId), 'a')
  } finally { await f.accounts.dispose() }
})

test('native stream does not infer account replay from an error after response.created', async () => {
  const f = fixture(() => new Response('data: {"type":"response.created","response":{"id":"committed"}}\n\ndata: {"type":"error","code":"rate_limit_exceeded","message":"rate limit exceeded"}\n\n', { headers: { 'content-type': 'text/event-stream' } }))
  try {
    await f.seed(['a', 'b'])
    assert.equal((await collect(f.adapter.stream(request()))).finish?.kind, 'error')
    assert.equal(f.requests.length, 1)
  } finally { await f.accounts.dispose() }
})

test('real AgentLoop records a redacted native refusal with status, retry hint and request identity', async () => {
  const ctx = new Context(), f = fixture(() => Response.json({ error: { code: 'rate_limit_exceeded', message: 'private fixture token details' } }, {
    status: 429, headers: { 'retry-after': '120', 'x-request-id': 'req_recorded_quota' },
  }))
  try {
    await f.seed(['a']); await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    ctx.effect(() => ctx.llm.registerAdapter([provider], f.adapter), 'recorded native subscription')
    const agent = await harness.create(SessionId('subscription-quota-session'), { provider, model })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Record the quota refusal.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    const trace = events.flatMap(event => event.type !== 'assistant/attempt' ? [] : expandAssistantStream(event.data.stream).flatMap(member => {
      const chunk = member.chunk
      if (chunk.type !== 'finish' || chunk.reason.kind !== 'error') return []
      const failure = chunk.reason.failure
      return [{ code: failure.code, status: failure.status, requestId: failure.requestId, hasRetryHint: (failure.providerRetryAfterMs ?? 0) > 0, message: failure.message }]
    }))
    assert.deepEqual(trace, [{ code: 'ACCOUNT_REJECTED', status: 429, requestId: 'req_recorded_quota', hasRetryHint: true,
      message: 'HTTP 429: The subscription account rejected this request. Check access or quota.' }])
    assert.equal(events.some(event => event.type === 'assistant/message'), false)
    assert.equal(JSON.stringify(events).includes('private fixture'), false)
    assert.equal(f.requests.length, 1)
  } finally { await ctx.fiber.dispose(); await f.accounts.dispose() }
})

test('native text never switches accounts after model output begins', async () => {
  const f = fixture(() => new Response([
    { type: 'response.created', response: { id: 'partial' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg', role: 'assistant', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'partial' },
    { type: 'error', code: 'rate_limit_exceeded', message: 'quota exhausted' },
  ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }))
  try {
    await f.seed(['a', 'b'])
    const answer = await collect(f.adapter.stream(request()))
    assert.equal(answer.finish?.kind, 'error')
    assert.equal(f.requests.length, 1)
  } finally { await f.accounts.dispose() }
})

for (const source of ['headers', 'event'] as const) test(`live quota from ${source} updates routing before the polling cache expires`, async () => {
  const f = fixture(headers => {
    if (headers.get('chatgpt-account-id') !== 'a') return response()
    if (source === 'headers') {
      const answer = response()
      answer.headers.set('x-codex-primary-used-percent', '100')
      answer.headers.set('x-codex-primary-window-minutes', '300')
      answer.headers.set('x-codex-primary-reset-after-seconds', '1000')
      return answer
    }
    return new Response(`data: ${JSON.stringify({ type: 'codex.rate_limits', rate_limits: { primary: { used_percent: 100, window_minutes: 300, reset_after_seconds: 1000 } } })}\n\n${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')}`, { headers: { 'content-type': 'text/event-stream' } })
  })
  try {
    await f.seed(['a', 'b'])
    await f.accounts.update(accountKey('a'), { revision: 1, priority: 10, allowCredits: false })
    await collect(f.adapter.stream(request()))
    await collect(f.adapter.stream(request()))
    assert.deepEqual(f.requests.map(request => request.headers.get('chatgpt-account-id')), ['a', 'b'])
  } finally { await f.accounts.dispose() }
})

test('native requests without a Harness Session still align their derived cache key and both headers', async () => {
  const f = fixture()
  try {
    await f.seed(['a'])
    const { sessionId: _session, ...input } = request()
    await collect(f.adapter.stream(input))
    const wire = f.requests[0]!
    assert.equal(typeof wire.payload.prompt_cache_key, 'string')
    assert.equal(wire.headers.get('session-id'), wire.payload.prompt_cache_key)
    assert.equal(wire.headers.get('thread-id'), wire.payload.prompt_cache_key)
  } finally { await f.accounts.dispose() }
})

test('server context, modalities and reasoning replace static model capabilities on a new prepare', async () => {
  let context = 4096
  const f = fixture(undefined, () => [{ slug: model, input_modalities: ['text'], context_window: context,
    max_context_window: 32768, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }], default_reasoning_level: 'medium', service_tiers: [{ id: 'priority' }] }])
  try {
    await f.seed(['a'])
    const first = await f.adapter.prepareCall(provider, model)
    assert.equal(first.model.context?.contextWindow, 4096)
    assert.deepEqual(first.model.inputModalities, ['text'])
    assert.deepEqual(first.model.reasoning?.efforts.map(effort => effort.id), ['low', 'medium'])
    context = 8192
    f.options.discoveryTtlMs = 0
    const second = await f.adapter.prepareCall(provider, model)
    assert.equal(second.model.context?.contextWindow, 8192)
    assert.equal(first.model.context?.contextWindow, 4096)
    await collect(first.stream(request()))
    assert.deepEqual(f.requests[0]?.payload.reasoning, { effort: 'medium', summary: 'auto' })
  } finally { await f.accounts.dispose() }
})

test('a newly discovered Codex model with explicit capabilities runs through the public native adapter', async () => {
  const future = 'gpt-future-fixture'
  const f = fixture(undefined, () => [{ slug: future, display_name: 'Future fixture', context_window: 65536,
    max_output_tokens: 8192, input_modalities: ['text', 'image'], supported_reasoning_levels: [{ effort: 'high' }, { effort: 'ultra' }] }])
  try {
    await f.seed(['a'])
    assert.deepEqual((await f.adapter.listModels(provider)).map(model => model.id), [future])
    const prepared = await f.adapter.prepareCall(provider, future)
    assert.equal(prepared.model.context?.contextWindow, 65536)
    assert.deepEqual(prepared.model.reasoning?.efforts.map(effort => effort.id), ['high', 'max'])
    const answer = await collect(prepared.stream({ ...request(), model: future, reasoningEffort: ReasoningEffortId('max') }))
    assert.equal(answer.finish?.kind, 'tool-calls')
    assert.equal(f.requests[0]?.payload.model, future)
    assert.equal(JSON.stringify(f.requests[0]?.payload.reasoning).includes('max'), true)
  } finally { await f.accounts.dispose() }
})

test('native adapter consumes real WebSocket reasoning, tool calls, usage and replay through the shared SSE bridge', async () => {
  const server = createServer(), wss = new WebSocketServer({ server })
  const messages: Record<string, unknown>[] = []
  wss.on('connection', (socket, request) => {
    assert.equal(request.headers['openai-beta'], 'responses_websockets=2026-02-06')
    assert.equal(request.headers['chatgpt-account-id'], 'a')
    socket.on('error', () => {})
    socket.on('message', message => { messages.push(JSON.parse(message.toString())); for (const frame of frames) socket.send(JSON.stringify(frame)) })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const endpoint = `http://127.0.0.1:${address.port}/responses`
  const upstream = new CodexUpstream({ endpoint, fetch: async () => { throw new Error('This native WebSocket fixture must not use HTTP') },
    settings: resolveOptions({ upstream: { closeTimeoutMs: 50 } }).upstream })
  const f = fixture(undefined, undefined, (_input, init) => upstream.fetch(endpoint, init))
  try {
    await f.seed(['a'])
    const result = await collect(f.adapter.stream(request()))
    assert.deepEqual(result.blocks().map(block => block.type), ['reasoning', 'text', 'tool-call', 'tool-call'])
    assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 4, cacheReadTokens: 3, totalTokens: 14 })
    assert.ok(result.replayState)
    assert.equal(messages[0]?.type, 'response.create')
    assert.equal(messages[0]?.instructions, 'AutoFlow logged system prompt')
    assert.equal(upstream.status().httpFallbacks, 0)
  } finally {
    await f.accounts.dispose(); await upstream.dispose()
    for (const client of wss.clients) client.terminate()
    await new Promise<void>(resolve => wss.close(() => resolve()))
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
