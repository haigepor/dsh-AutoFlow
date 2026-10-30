/** Raw transport tests prove request normalization and one-account streaming ownership. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexResponsesTransport, codexRequest } from '../src/host/relay/transport.ts'
import type { AccountLease, AccountRequest } from '../src/host/accounts/types.ts'

test('Codex normalization retains the caller instruction and removes rejected sampling fields', () => {
  const original = { model: 'codex-test', input: 'hello', instructions: 'User owned system text', temperature: 0.3, max_output_tokens: 99, tools: [{ type: 'web_search' }], store: true, stream: false }
  const normalized = codexRequest(original)
  assert.equal(normalized.instructions, original.instructions)
  assert.equal(normalized.store, false)
  assert.equal(normalized.stream, true)
  assert.equal(normalized.temperature, undefined)
  assert.equal(normalized.max_output_tokens, undefined)
  assert.deepEqual(normalized.tools, original.tools)
  assert.deepEqual(normalized.input, [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }])
  assert.equal(original.store, true)
  assert.equal(codexRequest({ model: 'x', input: [] }).instructions, '')
  assert.throws(() => codexRequest({ model: 'x', input: [], previous_response_id: 'private-response' }), /previous_response_id is not supported/)
  assert.throws(() => codexRequest({ model: 'x', input: [], context_management: [{ type: 'compaction' }] }), /context_management is not supported/)
  assert.equal(codexRequest({ model: 'x', input: [], previous_response_id: null, background: false }).previous_response_id, undefined)
})

test('Codex replay normalizes foreign tool IDs, stored references and message status without changing caller data', () => {
  const call = 'foreign-'.repeat(12)
  const input = [
    { type: 'message', id: 'stored-message', status: 'completed', role: 'system', content: 'policy' },
    { type: 'function_call', id: 'stored-call', call_id: call, name: 'lookup', arguments: '{}' },
    { type: 'function_call_output', call_id: call, output: 'paired' },
    { type: 'function_call_output', call_id: 'missing', output: 'orphan' },
    { type: 'item_reference', id: 'stored-only' },
    { type: 'function_call_output', id: 'notification', name: 'notice', output: 'standalone' },
    { type: 'message', role: 'user', content: 'hello' },
  ]
  const original = structuredClone(input)
  const normalized = codexRequest({ model: 'x', input, prompt_cache_options: { mode: 'explicit' }, safety_identifier: 'private' })
  const items = normalized.input
  assert.ok(Array.isArray(items))
  assert.equal(items[0].role, 'developer')
  assert.equal(items[0].id, undefined)
  assert.equal(items[0].status, undefined)
  assert.equal(items[1].call_id.length, 64)
  assert.equal(items[1].call_id, items[2].call_id)
  assert.equal(items[3].role, 'assistant')
  assert.match(items[3].content, /orphan/)
  assert.equal(items[4].id, 'notification')
  assert.equal(items.length, 6)
  assert.equal(normalized.prompt_cache_options, undefined)
  assert.equal(normalized.safety_identifier, undefined)
  assert.deepEqual(input, original)
})

test('Codex cache follows the first user turn while reasoning and service tiers follow subscription rules', () => {
  const first = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first' }] }
  const a = codexRequest({ model: 'x', input: [first], instructions: 'policy', reasoning: { effort: 'ultra' }, service_tier: 'flex' })
  const b = codexRequest({ model: 'x', input: [first, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'next' }], instructions: 'policy' })
  assert.equal(a.prompt_cache_key, b.prompt_cache_key)
  assert.notEqual(a.prompt_cache_key, codexRequest({ model: 'x', input: 'different', instructions: 'policy' }).prompt_cache_key)
  assert.deepEqual(a.reasoning, { effort: 'max', summary: 'auto' })
  assert.deepEqual(a.include, ['reasoning.encrypted_content'])
  assert.equal(a.service_tier, undefined)
  for (const service_tier of ['priority', 'ultrafast']) assert.equal(codexRequest({ model: 'x', input: [], service_tier }).service_tier, service_tier)
  assert.equal(codexRequest({ model: 'x', input: [], reasoning: { effort: 'none' } }).include, undefined)
  assert.deepEqual(codexRequest({ model: 'x', input: [], reasoning: { effort: 'none' }, include: ['reasoning.encrypted_content', 'web_search_call.action.sources'] }).include, ['web_search_call.action.sources'])
  const searched = codexRequest({ model: 'x', input: [{ type: 'web_search_call', id: 'search' }] })
  assert.deepEqual(searched.tools, [{ type: 'web_search', external_web_access: false }])
  assert.equal(searched.tool_choice, 'none')
  const nativeSearch = [{ type: 'function', name: 'web.run' }]
  assert.deepEqual(codexRequest({ model: 'x', input: [{ type: 'web_search_call' }], tools: nativeSearch }).tools, nativeSearch)
  const additional = codexRequest({ model: 'x', input: [{ type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'first' }] }, { type: 'web_search_call' }, { type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'second' }] }] }).input
  assert.ok(Array.isArray(additional))
  assert.deepEqual(additional[2].tools, [{ type: 'function', name: 'second' }])
})

test('raw transport keeps its scheduler lease until the body finishes and sends Codex headers', async () => {
  let released = false
  let calls = 0
  const source = Promise.withResolvers<void>()
  const options = {
    accounts: { withAccount: async <T>(_request: AccountRequest, run: (lease: AccountLease) => Promise<T>): Promise<T> => {
      assert.equal(_request.reasoningEffort, 'max'); assert.equal(_request.serviceTier, 'priority')
      try { return await run({ accountKey: 'a', accountId: 'account-id', accessToken: 'private-token', headers: {}, signal: new AbortController().signal }) }
      finally { released = true }
    } },
    endpoint: 'https://chatgpt.com/backend-api/codex/responses', originator: 'autoflow', userAgent: 'autoflow-test', clientVersion: 'test-version',
    fetch: async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls++
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('chatgpt-account-id'), 'account-id')
      assert.equal(headers.get('authorization'), 'Bearer private-token')
      assert.equal(headers.get('OpenAI-Beta'), 'responses=experimental')
      assert.equal(headers.get('originator'), 'autoflow')
      assert.equal(headers.get('version'), 'test-version')
      assert.equal(headers.get('session-id'), 'conversation-fixture')
      assert.equal(headers.get('thread-id'), 'conversation-fixture')
      return new Response(new ReadableStream<Uint8Array>({ async start(controller) { controller.enqueue(new TextEncoder().encode('data: first\n\n')); await source.promise; controller.enqueue(new TextEncoder().encode('data: final\n\n')); controller.close() } }), { headers: { 'content-type': 'text/event-stream', 'set-cookie': 'private=secret' } })
    },
  }
  const transport = new CodexResponsesTransport(options)
  try {
    const response = await transport.request({ model: 'x', input: [], instructions: 'retained', prompt_cache_key: 'conversation-fixture', reasoning: { effort: 'ultra' }, service_tier: 'priority' }, new AbortController().signal)
    assert.equal(released, false)
    assert.equal(response.headers.get('set-cookie'), null)
    const pending = response.text()
    source.resolve()
    assert.match(await pending, /first[\s\S]*final/)
    await transport.dispose()
    assert.equal(released, true)
    assert.equal(calls, 1)
  } finally { source.resolve(); await transport.dispose() }
})

test('abandoning a body releases the account without fetching a replacement', async () => {
  let calls = 0
  let released = false
  const transport = new CodexResponsesTransport({
    endpoint: 'https://chatgpt.com/backend-api/codex/responses', originator: 'autoflow', userAgent: 'test', clientVersion: 'test',
    accounts: { withAccount: async (_request, run) => { try { return await run({ accountKey: 'a', accountId: 'a', accessToken: 'secret', headers: {}, signal: new AbortController().signal }) } finally { released = true } } },
    fetch: async () => { calls++; return new Response(new ReadableStream({ pull() { /* Upstream has not delivered another event. */ } })) },
  })
  const result = await transport.request({ model: 'x', input: [] }, new AbortController().signal)
  await result.body?.cancel()
  await transport.dispose()
  assert.equal(calls, 1)
  assert.equal(released, true)
})
