import { describe, expect, it } from 'vitest'
import { nativeWebSearchEnabled, nativeWebSearchMode } from '../src/native-web-search.ts'

describe('native web search model matching', () => {
  it('matches known models only on a compatible protocol', () => {
    expect(nativeWebSearchEnabled('gpt-6.1-sol', 'openai-responses')).toBe(true)
    expect(nativeWebSearchEnabled('gpt-6.1-sol', 'openai-codex-responses')).toBe(true)
    expect(nativeWebSearchEnabled('gpt-6.1-sol', 'openai-completions')).toBe(false)
    expect(nativeWebSearchEnabled('workbuddy/deepseek-v4.1-flash', 'anthropic-messages')).toBe(true)
    expect(nativeWebSearchEnabled('claude-sonnet-4-6', 'anthropic-messages')).toBe(true)
    expect(nativeWebSearchEnabled('gemini-2.5-flash', 'google-generative-ai')).toBe(true)
    expect(nativeWebSearchEnabled('a-future-gpt-model', 'openai-responses')).toBe(false)
  })

  it('keeps explicit choices ahead of server metadata and catalog rules', () => {
    expect(nativeWebSearchEnabled('gpt-6.1-sol', 'openai-responses', false, true)).toBe(false)
    expect(nativeWebSearchEnabled('gpt-6.1-sol', 'openai-responses', undefined, false)).toBe(false)
    expect(nativeWebSearchEnabled('private-model', 'openai-responses', undefined, true)).toBe(true)
    expect(nativeWebSearchEnabled('private-model', 'openai-responses', true)).toBe(true)
    expect(nativeWebSearchEnabled('private-model', 'unsupported-protocol', true)).toBe(false)
  })

  it('distinguishes Responses, Messages, Google grounding and search-specific chat models', () => {
    expect(nativeWebSearchMode('openai-responses')).toBe('responses')
    expect(nativeWebSearchMode('deepseek-messages')).toBe('messages')
    expect(nativeWebSearchMode('google-vertex')).toBe('google')
    expect(nativeWebSearchEnabled('gpt-5-search-api', 'openai-completions')).toBe(true)
    expect(nativeWebSearchEnabled('gpt-5-search-api', 'openai-responses')).toBe(false)
  })
})
