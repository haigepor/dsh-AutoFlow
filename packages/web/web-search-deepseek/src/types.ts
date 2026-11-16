/** Wire types shared with the model-native Messages search parser. */
export type { AnthropicResponse, ContentBlock, TextBlock, WebSearchToolResultBlock, WebSearchResultItem, CitationLocation } from '@deepseek-ai/dsh-llm-deepseek'

/** DeepSeek's error response envelope (best-effort; fields vary). */
export interface AnthropicError {
  error?: { message?: string } | string
  message?: string
}
