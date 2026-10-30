import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { NativeWebSearchRequest } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as ToolWeb from '../src/index.ts'

describe('web tool native model routing', () => {
  it('uses the initiating model, records its input before dispatch and keeps source-card metadata', async () => {
    const ctx = new Context(), dispatched = vi.fn()
    try {
      await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(ToolRuntime)
      await ctx.plugin(NativeToolExecutor)
      await ctx.plugin(SystemPrompt); await ctx.plugin(WebRuntime)
      const session = ctx.sessions.create(SessionId('native-search-fixture'))
      session.append('turn/start', { turn: 1 })
      session.append('request/context', { provider: 'fixture', model: 'native-model' })
      class NativeAdapter extends LlmAdapter {
        override resolveModel(provider: string, model: string) {
          return Promise.resolve({ provider, id: model, name: model, nativeWebSearch: true })
        }
        override async searchNative(request: NativeWebSearchRequest) {
          request.recordRequest({ api: 'openai-responses', body: { model: request.model, input: request.query, tools: [{ type: 'web_search' }] } })
          expect(session.snapshotEvents().at(-1)?.type).toBe('web/native-search-llm-request')
          dispatched(request.provider, request.model)
          return { content: 'Current result', sources: [{ url: 'https://example.com/current', title: 'Current source' }], truncated: false }
        }
        override stream(): never { throw new Error('The conversation stream is not a search backend') }
      }
      ctx.llm.registerAdapter(['fixture'], new NativeAdapter())
      await ctx.plugin(ToolWeb)
      const agent = { id: session.id, ctx, session } as Agent
      const signal = new AbortController().signal
      const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'fixture', model: 'native-model' }, signal })
      let result
      try {
        const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: ToolCallId('native-search-call'), name: 'web_search',
          arguments: JSON.stringify({ queries: ['current projects'] }) }], agent, toolSet, signal })
        result = batch.results[0]?.result
      } finally { toolSet.dispose() }
      expect(result, JSON.stringify(result)).toMatchObject({ isError: false })
      expect(dispatched).toHaveBeenCalledWith('fixture', 'native-model')
      expect(result).toMatchObject({ isError: false, meta: { sources: [{ url: 'https://example.com/current', title: 'Current source' }] } })
      const recorded = session.snapshotEvents().filter(event => event.type === 'web/native-search-llm-request').map(event => ({ type: event.type, data: event.data }))
      await expect(`${JSON.stringify(recorded, null, 2)}\n`).toMatchFileSnapshot('./expected/native-search-request.expected.json')
    } finally { await ctx.fiber.dispose() }
  })
})
