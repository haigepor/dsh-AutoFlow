/** Protocol-specific native-search declarations and structured source extraction for auxiliary calls. */
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { NativeWebSearchRequest, NativeWebSearchResult } from '@deepseek-ai/dsh-llm'
import { nativeWebSearchMode } from '@deepseek-ai/dsh-llm/native-web-search'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }

/** Hooks retain raw provider sources before the SDK projects ordinary assistant text. */
interface NativeSearchCapture {
  onPayload(value: unknown): unknown
  onProviderStreamEvent(event: unknown): void
  result(content: string): NativeWebSearchResult
}

/**
 * Capture one search's provider input and sources without retaining credentials or conversation history.
 * @param api Exact wire protocol.
 * @param request Current model and the owning tool's durable recorder.
 * @returns Provider callbacks and a final structured result projection.
 */
export function nativeSearchCapture(api: string, request: NativeWebSearchRequest): NativeSearchCapture {
  const mode = nativeWebSearchMode(api)
  if (mode === undefined) throw new LlmError(`Native web search is not integrated for ${api}`, 'UNSUPPORTED_OPTION')
  const sources = new Map<string, NativeWebSearchResult['sources'][number]>()
  let searched = false
  const source = (raw: unknown): void => {
    const fields = object(raw)
    const url = fields?.url ?? fields?.uri
    if (typeof url !== 'string') return
    let parsed: URL
    try { parsed = new URL(url) } catch (_invalidProviderSourceUrl) { return }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return
    if (!sources.has(url)) sources.set(url, { url,
      ...typeof fields?.title !== 'string' ? {} : { title: fields.title },
      ...typeof fields?.cited_text !== 'string' ? {} : { snippet: fields.cited_text } })
  }
  const annotations = (value: unknown): void => {
    for (const raw of array(value)) {
      const fields = object(raw)
      source(fields?.url_citation ?? raw)
    }
  }
  const item = (raw: unknown): void => {
    const fields = object(raw)
    if (fields === undefined) return
    if (fields.type === 'web_search_call') {
      searched = true
      for (const value of array(object(fields.action)?.sources)) source(value)
    }
    if (fields.type === 'web_search_tool_result') {
      searched = true
      const content = object(fields.content)
      if (content?.type === 'web_search_tool_result_error') throw new LlmError(`Native search failed: ${String(content.error_code)}`, 'NATIVE_SEARCH_FAILED')
      for (const value of array(fields.content)) source(value)
    }
    for (const value of array(fields.content)) annotations(object(value)?.annotations)
    annotations(fields.citations)
  }
  return {
    onPayload(value: unknown): unknown {
      const original = object(value)
      if (original === undefined) throw new LlmError('Native search received an invalid provider request', 'INVALID_REQUEST')
      const body = { ...original }
      switch (mode) {
        case 'responses':
          body.tools = [{ type: 'web_search' }]
          body.tool_choice = 'required'
          body.include = [...array(body.include), 'web_search_call.action.sources']
          break
        case 'messages':
          body.tools = [{ type: 'web_search_20250305', name: 'web_search' }]
          body.tool_choice = { type: 'auto' }
          break
        case 'google':
          body.config = { ...object(body.config), tools: [{ googleSearch: {} }] }
          break
        case 'completions': body.web_search_options = {}; break
      }
      const recorded = { ...body }
      // SDK 的 HTTP 选项可能含部署请求头，只记录模型输入，不记录传输凭据。
      if (mode === 'google') {
        const config = { ...object(body.config) }; delete config.httpOptions; recorded.config = config
      }
      const json = snapshotJsonValue(JSON.parse(JSON.stringify(recorded)))
      if (json === undefined) throw new LlmError('Native search request is not JSON serializable', 'INVALID_REQUEST')
      request.recordRequest({ api, body: json })
      return body
    },
    onProviderStreamEvent(raw: unknown): void {
      const event = object(raw)
      if (event === undefined) return
      item(event.item)
      item(event.content_block)
      const delta = object(event.delta)
      if (delta?.type === 'citations_delta') source(delta.citation)
      for (const output of array(object(event.response)?.output)) item(output)
      for (const candidate of array(event.candidates)) {
        const grounding = object(object(candidate)?.groundingMetadata)
        if (array(grounding?.webSearchQueries).length > 0) searched = true
        for (const chunk of array(grounding?.groundingChunks)) source(object(chunk)?.web)
      }
      for (const choice of array(event.choices)) {
        annotations(object(object(choice)?.delta)?.annotations)
        annotations(object(object(choice)?.message)?.annotations)
      }
      for (const url of array(event.citations)) if (typeof url === 'string') source({ url })
    },
    result(content: string): NativeWebSearchResult {
      const all = [...sources.values()]
      // 无来源不能证明服务端实际执行过搜索，不把模型凭记忆写的答案当作搜索结果。
      if (all.length === 0 && !searched) throw new LlmError('The provider returned no native-search sources; check model and endpoint support', 'NATIVE_SEARCH_NO_SOURCES')
      return { ...content.length === 0 ? {} : { content }, sources: all.slice(0, request.maxResults), truncated: all.length > request.maxResults }
    },
  }
}
