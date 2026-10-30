import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { NativeWebSearchRequest } from '@deepseek-ai/dsh-llm'
import * as PiAi from '../src/index.ts'
import { nativeSearchCapture } from '../src/native-search.ts'
import { discoverModels } from '../src/discovery.ts'
import { anthropicFrame, anthropicMessageStart, closeMockServers, mockServer } from './mock-server.ts'

afterEach(async () => { vi.unstubAllEnvs(); await closeMockServers() })
const request = (): NativeWebSearchRequest => ({ provider: 'fixture', model: 'gpt-6.1-sol', query: 'GitHub trending', maxResults: 2,
  signal: new AbortController().signal, recordRequest: vi.fn() })

describe('model-native web search', () => {
  it('exposes the installed protocol without persisting local matching as a provider declaration', async () => {
    const models = await discoverModels({ provider: 'openai' })
    const model = models.find(model => model.id === 'gpt-6.1-sol')
    expect(model).toMatchObject({ api: 'openai-responses' })
    expect(model).not.toHaveProperty('nativeWebSearch')
  })

  it('reads explicit search metadata without inferring it from ordinary tool calling', async () => {
    const server = await mockServer([{ body: JSON.stringify({ data: [
      { id: 'known-denial', supports_web_search: false }, { id: 'private-model', supports_search_tool: true },
      { id: 'nested', capabilities: { web_search: { supported: true } } }, { id: 'tools-only', supports_function_calling: true },
    ] }) }])
    const models = await discoverModels({ baseURL: `${server.url}/v1`, api: 'openai-responses' })
    expect(models.map(model => [model.id, model.nativeWebSearch])).toEqual([
      ['known-denial', false], ['private-model', true], ['nested', true], ['tools-only', undefined],
    ])
  })

  it('keeps discovered defaults and explicit opt-outs in resolved model metadata', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(PiAi, { providers: { fixture: { api: 'openai-responses', baseURL: 'https://fixture.invalid', models: [
        { id: 'private-model', nativeWebSearchDefault: true },
        { id: 'gpt-6.1-sol', nativeWebSearch: false, nativeWebSearchDefault: true },
        { id: 'gpt-6.1-terra', nativeWebSearchDefault: false },
      ] } } })
      const capabilities = await Promise.all(['private-model', 'gpt-6.1-sol', 'gpt-6.1-terra'].map(id => ctx.llm.resolveModelInfo('fixture', id)))
      expect(capabilities.map(model => model.nativeWebSearch)).toEqual([true, false, false])
    } finally { await ctx.fiber.dispose() }
  })

  it('reports the authentication failure when a native search is rejected', async () => {
    const server = await mockServer([{ status: 401, body: JSON.stringify({ error: { message: 'Fixture authentication rejected', type: 'invalid_request_error' } }) }])
    const ctx = new Context()
    vi.stubEnv('NATIVE_SEARCH_TEST_KEY', 'fixture-current-route-key')
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(PiAi, { providers: { fixture: { api: 'openai-responses', baseURL: `${server.url}/v1`, apiKeyEnv: 'NATIVE_SEARCH_TEST_KEY', models: [{ id: 'gpt-6.1-sol' }] } } })
      const result = ctx.llm.searchNative(request())
      await expect(result).rejects.toHaveProperty('failure.code', 'AUTH')
      await expect(result).rejects.toHaveProperty('failure.message', expect.stringContaining('401'))
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['anthropic-messages', 'google-generative-ai', 'openai-completions'])('completes a real %s SDK request with native sources', async (api) => {
    const model = api === 'anthropic-messages' ? 'claude-sonnet-4-6' : api === 'google-generative-ai' ? 'gemini-2.5-flash' : 'gpt-5-search-api'
    const source = { url: 'https://example.com/current', title: 'Current source' }
    const events = api === 'anthropic-messages' ? [anthropicMessageStart,
      anthropicFrame({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 's1', name: 'web_search', input: {} } }),
      anthropicFrame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"current projects"}' } }),
      anthropicFrame({ type: 'content_block_stop', index: 0 }),
      anthropicFrame({ type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', ...source, encrypted_content: 'fixture' }] } }),
      anthropicFrame({ type: 'content_block_stop', index: 1 }),
      anthropicFrame({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }),
      anthropicFrame({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Current answer' } }),
      anthropicFrame({ type: 'content_block_stop', index: 2 }),
      anthropicFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }), anthropicFrame({ type: 'message_stop' }),
    ] : api === 'google-generative-ai' ? [JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Current answer' }] }, finishReason: 'STOP',
      groundingMetadata: { groundingChunks: [{ web: { uri: source.url, title: source.title } }], webSearchQueries: ['current projects'] } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 } })]
      : [JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Current answer', annotations: [{ type: 'url_citation', url_citation: source }] }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2 } }), '[DONE]']
    const server = await mockServer([{ events }]), ctx = new Context()
    const provider = api === 'google-generative-ai' ? 'google' : 'fixture'
    vi.stubEnv('NATIVE_SEARCH_TEST_KEY', 'fixture-current-route-key')
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(PiAi, { providers: { [provider]: { ...api === 'google-generative-ai' ? {} : { api }, baseURL: `${server.url}/v1`, apiKeyEnv: 'NATIVE_SEARCH_TEST_KEY', models: [{ id: model }] } } })
      const result = await ctx.llm.searchNative({ ...request(), provider, model })
      expect(result).toMatchObject({ content: 'Current answer', sources: [source] })
      expect(server.requests).toHaveLength(1)
    } finally { await ctx.fiber.dispose() }
  })
  it('sends a native Responses tool with the current route key and returns persisted sources', async () => {
    const search = { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', sources: [{ url: 'https://github.com/trending', type: 'url' }] } }
    const message = { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Trending projects', annotations: [] }] }
    const frames = [{ type: 'response.created', response: { id: 'resp_1' } },
      ...[search, message].flatMap((item, output_index) => [{ type: 'response.output_item.added', output_index, item }, { type: 'response.output_item.done', output_index, item }]),
      { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [search, message], usage: { input_tokens: 2, output_tokens: 2 } } }]
    const server = await mockServer([{ events: frames.map(frame => JSON.stringify(frame)) }])
    vi.stubEnv('NATIVE_SEARCH_TEST_KEY', 'fixture-current-route-key')
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(PiAi, { providers: { fixture: { api: 'openai-responses', baseURL: `${server.url}/v1`, apiKeyEnv: 'NATIVE_SEARCH_TEST_KEY', models: [{ id: 'gpt-6.1-sol' }] } } })
      const input = request()
      input.recordRequest = vi.fn(() => { expect(server.requests).toHaveLength(0) })
      const result = await ctx.llm.searchNative(input)
      expect(result.sources).toEqual([{ url: 'https://github.com/trending' }])
      expect(server.requests[0]).toMatchObject({ tools: [{ type: 'web_search' }], tool_choice: 'required' })
      expect(server.headers[0]?.authorization).toBe('Bearer fixture-current-route-key')
      expect(input.recordRequest).toHaveBeenCalledOnce()
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['anthropic-messages', 'google-generative-ai', 'openai-completions'])('uses the %s native declaration and its source format', (api) => {
    const input = request(), capture = nativeSearchCapture(api, input)
    const body = capture.onPayload({ model: input.model, config: {} })
    if (api === 'anthropic-messages') {
      expect(body).toMatchObject({ tools: [{ type: 'web_search_20250305', name: 'web_search' }] })
      capture.onProviderStreamEvent({ type: 'content_block_start', content_block: { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://example.com', title: 'Source' }] } })
    } else if (api === 'google-generative-ai') {
      expect(body).toMatchObject({ config: { tools: [{ googleSearch: {} }] } })
      capture.onProviderStreamEvent({ candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com', title: 'Source' } }] } }] })
    } else {
      expect(body).toMatchObject({ web_search_options: {} })
      capture.onProviderStreamEvent({ choices: [{ delta: { annotations: [{ type: 'url_citation', url_citation: { url: 'https://example.com', title: 'Source' } }] } }] })
    }
    expect(capture.result('Answer')).toMatchObject({ content: 'Answer', sources: [{ url: 'https://example.com', title: 'Source' }] })
  })

  it('refuses an answer without search evidence and prevents dispatch when recording fails', () => {
    const input = request(), capture = nativeSearchCapture('openai-responses', input)
    expect(() => capture.result('A remembered answer')).toThrow(/no native-search sources/)
    input.recordRequest = () => { throw new Error('log unavailable') }
    expect(() => nativeSearchCapture('openai-responses', input).onPayload({ input: 'query' })).toThrow('log unavailable')
  })

  it('retains a completed search with zero results and excludes SDK transport headers from the log', () => {
    const input = request(), capture = nativeSearchCapture('google-generative-ai', input)
    capture.onPayload({ model: 'fixture', config: { httpOptions: { headers: { authorization: 'private-fixture' } } } })
    expect(JSON.stringify(vi.mocked(input.recordRequest).mock.calls)).not.toContain('private-fixture')
    capture.onProviderStreamEvent({ candidates: [{ groundingMetadata: { webSearchQueries: ['no matching pages'], groundingChunks: [] } }] })
    expect(capture.result('No matching pages')).toEqual({ content: 'No matching pages', sources: [], truncated: false })
  })
})
