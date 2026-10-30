import { afterEach, expect, it } from 'vitest'
import { adapter, server } from './helpers.ts'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

it('uses the selected DeepSeek model and its chat credential for native search', async () => {
  const http = await server((response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ content: [{ type: 'web_search_tool_result', tool_use_id: 's1', content: [
      { type: 'web_search_result', url: 'https://example.com/current', title: 'Current source', encrypted_content: 'fixture' },
    ] }] }))
  })
  cleanup.push(() => http.close())
  const llm = adapter({ baseURL: http.url, models: [{ id: 'deepseek-v4.1-flash' }] })
  const recorded: unknown[] = []
  const result = await llm.searchNative({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash', query: 'current projects', maxResults: 2,
    signal: new AbortController().signal, recordRequest: (request) => { expect(http.requests).toHaveLength(0); recorded.push(request) } })
  expect(http.requests[0]).toMatchObject({ headers: { 'x-api-key': 'test-key' }, body: { model: 'deepseek-v4.1-flash', tools: [{ type: 'web_search_20250305', name: 'web_search' }] } })
  expect(result.sources).toMatchObject([{ url: 'https://example.com/current', title: 'Current source' }])
  expect(recorded).toHaveLength(1)
})
