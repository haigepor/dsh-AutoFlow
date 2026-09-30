/** Protocol-independent model capabilities and reasoning choices. */
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo, LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import type { DeepSeekCatalogModel, DeepSeekConnectionOptions } from './types.ts'

const OFF_REASONING_EFFORT = ReasoningEffortId('off')
const LOW_REASONING_EFFORT = ReasoningEffortId('low')
const HIGH_REASONING_EFFORT = ReasoningEffortId('high')
const MAX_REASONING_EFFORT = ReasoningEffortId('max')
/** Protocol effort identifiers shared by configuration validation and model metadata. */
export const DEEPSEEK_REASONING_EFFORTS = ['off', 'low', 'high', 'max'] as const
const REASONING_EFFORTS = [
  {
    id: OFF_REASONING_EFFORT,
    name: 'Off',
    description: 'Use for simple tasks that do not need reasoning.',
  },
  {
    id: LOW_REASONING_EFFORT,
    name: 'Low',
    description: 'Prefer for routine or latency-sensitive tasks.',
  },
  {
    id: HIGH_REASONING_EFFORT,
    name: 'High',
    description: 'The default balance for most tasks.',
  },
  {
    id: MAX_REASONING_EFFORT,
    name: 'Max',
    description: 'Reserve for the hardest quality-first tasks.',
  },
] as const
const OFF_ONLY_REASONING_EFFORTS = [
  {
    id: OFF_REASONING_EFFORT,
    name: 'Off',
    description: 'Use for simple tasks that do not need reasoning.',
  },
] as const

/**
 * Resolve the same supported efforts and default for metadata and request execution.
 * @param connection - validated connection configuration.
 * @param model - exact model id.
 * @returns model reasoning metadata, restricted by deployment thinking policy.
 */
export function resolveModelReasoning(connection: DeepSeekConnectionOptions, model: string): LlmModelReasoningInfo {
  const configured = connection.models.find(entry => entry.id === model)
  const allowed = connection.defaults.thinking === 'disabled' ? OFF_ONLY_REASONING_EFFORTS : REASONING_EFFORTS
  const efforts = configured?.reasoningEfforts === undefined
    ? [...allowed] : allowed.filter(effort => configured.reasoningEfforts?.some(id => id === effort.id))
  const id = configured?.defaultReasoningEffort ?? connection.defaults.reasoningEffort
    ?? (connection.defaults.thinking === 'disabled' ? 'off' : 'high')
  const selected = efforts.find(effort => effort.id === id)
  if (selected === undefined) throw new Error(`llm-deepseek: model "${model}" defaultReasoningEffort "${id}" is not supported`)
  return { efforts, defaultEffort: selected.id }
}

/** Advertise one catalog entry.
 * @param provider - registered provider id.
 * @param model - advisory catalog entry.
 * @returns selector metadata.
 */
export function catalogModelInfo(provider: string, model: DeepSeekCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: model.inputModalities ?? ['text'],
  }
}

/** Resolve model capabilities against one configuration generation.
 * @param connection - validated connection facts.
 * @param provider - registered provider id.
 * @param model - requested wire model id.
 * @returns effective model metadata for this operation.
 */
export function modelInfo(
  connection: DeepSeekConnectionOptions,
  provider: string,
  model: string,
): LlmResolvedModelInfo {
  const configured = connection.models.find(entry => entry.id === model)
  const contextWindow = configured?.contextWindow
    ?? connection.defaultContextWindow
  return {
    // An uncatalogued endpoint is safely treated as text-only. Declaring an
    // unverified image capability would let the host persist input that the
    // endpoint may reject on every later turn.
    ...configured === undefined
      ? { provider, id: model, name: model, inputModalities: ['text' as const] }
      : catalogModelInfo(provider, configured),
    context: { contextWindow },
    defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
    ...configured?.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: configured.systemPromptUpdate },
    ...configured?.toolUpdate === undefined ? {} : { toolUpdate: configured.toolUpdate },
    reasoning: resolveModelReasoning(connection, model),
  }
}
