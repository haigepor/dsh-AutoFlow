/** Route/account projection of adapter-owned replay metadata; message content stays unchanged. */
import { z } from 'zod'
import type { GenerateOptions, ReplayEnvelope } from '@deepseek-ai/dsh-llm'

const envelopeSchema = z.object({ response: z.object({ kind: z.literal('codex-subscription'), version: z.literal(1),
  accountKey: z.string(), provider: z.string(), nativeResponse: z.unknown() }), blocks: z.array(z.unknown()).optional() })

/** Wrap native signatures with the account and public route that produced them. */
export function wrapReplay(native: ReplayEnvelope, accountKey: string, provider: string): ReplayEnvelope {
  return { response: { kind: 'codex-subscription', version: 1, accountKey, provider, nativeResponse: native.response },
    ...(native.blocks === undefined ? {} : { blocks: native.blocks }) }
}

/** Restore matching native replay, degrading foreign accounts to ordinary logged content. */
export function nativeRequest(options: GenerateOptions, accountKey: string, provider: string): GenerateOptions {
  return { ...options, provider: 'openai-codex', messages: options.messages.map(message => {
    if (message.role !== 'assistant' || message.source.provider !== provider) return message
    const { replayState, ...source } = message.source
    const parsed = envelopeSchema.safeParse(replayState)
    const matching = parsed.success && parsed.data.response.accountKey === accountKey && parsed.data.response.provider === provider
    return { ...message, source: { ...source, provider: 'openai-codex', ...(matching ? { replayState: {
      response: parsed.data.response.nativeResponse, ...(parsed.data.blocks === undefined ? {} : { blocks: parsed.data.blocks }),
    } } : {}) } }
  }) }
}
