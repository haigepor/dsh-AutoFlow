/** Browser-safe native-search capability matching, separate from ordinary function calling. */
import { NATIVE_WEB_SEARCH_MODELS } from './native-web-search-data.ts'

/** Provider request formats for native web search. */
export type NativeWebSearchMode = 'responses' | 'messages' | 'google' | 'completions'

/**
 * Resolve the native-search request format from the selected wire protocol.
 * @param api Configured or discovered model protocol.
 * @returns Supported request format, or undefined when no integration exists.
 */
export function nativeWebSearchMode(api: string | undefined): NativeWebSearchMode | undefined {
  switch (api) {
    case 'openai-responses': case 'openai-codex-responses': return 'responses'
    case 'anthropic-messages': case 'deepseek-messages': return 'messages'
    case 'google-generative-ai': case 'google-vertex': return 'google'
    case 'openai-completions': return 'completions'
    default: return undefined
  }
}

/**
 * Match a model without treating ordinary tool calling as native search support.
 * Explicit user choices win over server metadata; unknown catalog entries stay off.
 * @param id Exact model ID, optionally prefixed by a gateway namespace.
 * @param api Selected wire protocol.
 * @param configured Explicit per-model override; omission uses automatic matching.
 * @param reported Provider-reported native-search support, including explicit denial.
 * @returns Whether this model should use its own native search service.
 */
export function nativeWebSearchEnabled(id: string, api: string | undefined, configured?: boolean, reported?: boolean): boolean {
  const mode = nativeWebSearchMode(api)
  if (mode === undefined) return false
  if (configured !== undefined) return configured
  if (reported !== undefined) return reported
  const name = (id.split('/').at(-1) ?? id).replace(/\[1m\]$/i, '').toLowerCase()
  const has = (models: readonly string[]): boolean => models.includes(name)
  const searchChatModel = /(?:-search-api|-search-preview)(?:-|$)/.test(name)
  switch (mode) {
    // OpenAI 的搜索专用模型只走 Chat Completions，不能按 Responses 自动匹配。
    case 'responses': return !searchChatModel && (has(NATIVE_WEB_SEARCH_MODELS.openai) || has(NATIVE_WEB_SEARCH_MODELS.xai))
    case 'messages': return has(NATIVE_WEB_SEARCH_MODELS.anthropic)
      // DeepSeek's documented Messages server tool also covers the current explicit aliases.
      || ['deepseek-flash', 'deepseek-pro', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4.1-flash'].includes(name)
    case 'google': return has(NATIVE_WEB_SEARCH_MODELS.google)
    // 普通 GPT 的 Chat Completions 不提供此能力，只有专用搜索模型自动匹配。
    case 'completions': return has(NATIVE_WEB_SEARCH_MODELS.openai) && searchChatModel
  }
}
