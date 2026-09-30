/** Schema-owned reasoning choices and lossless model draft edits. */
import type { SettingsNamespaceView, LlmModelReasoningInfo } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import type { ModelsKey } from './locales.ts'

/** Adapter fields needed by the reasoning controls; no client-owned level list. */
export interface ModelReasoningOptions {
  levels: readonly string[]
  formats: readonly string[]
  inheritedMapping?: Readonly<Record<string, string | null>> | undefined
  defaultEffort?: string | undefined
  disabledByPolicy?: boolean | undefined
}

/** The five shared effort identifiers shown in the capability editor. */
export const DEFAULT_REASONING_LEVELS = ['off', 'low', 'medium', 'high', 'max'] as const

/**
 * Return schema-supported extensions not declared by this model.
 * @param options - adapter-owned identifiers from its settings schema.
 * @param selected - current model capability identifiers.
 * @returns identifiers for the Add level menu.
 */
export function additionalReasoningLevels(options: ModelReasoningOptions, selected: readonly string[]): string[] {
  return options.levels.filter(level => !DEFAULT_REASONING_LEVELS.includes(level as typeof DEFAULT_REASONING_LEVELS[number])
    && !selected.includes(level))
}

/**
 * Read selectable identifiers from the owning adapter's configuration schema.
 * @param namespace - settings schema and effective deployment configuration.
 * @param schema - settings schema operations.
 * @param path - provider profile path.
 * @param profile - live provider draft, including unsaved deployment policy.
 * @returns accepted levels and protocol formats.
 */
export function modelReasoningOptions(namespace: SettingsNamespaceView, schema: SettingsSchemaOperations,
  path: readonly string[], profile: unknown): ModelReasoningOptions {
  const root = schema.rehydrate(namespace.schema)
  const identifiers = (suffix: readonly string[]): string[] => {
    const node = schema.nodeAtPath(root, [...path, ...suffix])
    const union = node as { type?: string; list?: readonly { value?: unknown }[] } | undefined
    return union?.type === 'union' ? (union.list ?? []).flatMap(entry => typeof entry.value === 'string' ? [entry.value] : []) : []
  }
  const record = typeof profile === 'object' && profile !== null ? profile as Record<string, unknown> : {}
  const disabledByPolicy = record['thinking'] === 'disabled'
  const defaultEffort = record['reasoning'] ?? record['reasoningEffort']
  return {
    levels: identifiers(['models', '0', 'defaultReasoningEffort']).filter(level => !disabledByPolicy || level === 'off'),
    formats: identifiers(['models', '0', 'compat', 'thinkingFormat']),
    defaultEffort: typeof defaultEffort === 'string' ? defaultEffort : undefined,
    disabledByPolicy,
  }
}

/**
 * Resolve the draft's supported efforts without changing inherited configuration.
 * @param model - edited model.
 * @param options - schema choices used for canonical ordering.
 * @param inherited - installed catalog metadata, if available.
 * @param direct - whether this is the direct DeepSeek adapter.
 * @returns supported identifiers in adapter order.
 */
export function modelReasoningLevels(model: DeepSeekModelDraft, options: ModelReasoningOptions,
  inherited: LlmModelReasoningInfo | undefined, direct: boolean): string[] {
  const declared = model['reasoningEfforts']
  const ids = declared === undefined ? (direct ? options.levels : inherited?.efforts.map(effort => effort.id) ?? [])
    : declared === false ? options.levels.includes('off') ? ['off'] : []
      : Array.isArray(declared) ? declared.filter((id): id is string => typeof id === 'string')
        : typeof declared === 'object' && declared !== null ? Object.keys(declared) : []
  return [...options.levels.filter(level => ids.includes(level)), ...ids.filter(id => !options.levels.includes(id))]
}

/**
 * Reject a default removed by a capability edit and malformed manual maps before saving.
 * @param model - live model draft.
 * @param direct - whether supported efforts are stored as a protocol subset.
 * @returns localized failure key, or undefined for a valid local declaration.
 */
export function validateModelReasoning(model: DeepSeekModelDraft, direct: boolean):
  'reasoningNeedsLevel' | 'reasoningDefaultInvalid' | 'reasoningWireInvalid' | undefined {
  const declared = model['reasoningEfforts']
  if (declared === undefined) return undefined
  const levels = declared === false ? [] : Array.isArray(declared) ? declared
    : typeof declared === 'object' && declared !== null ? Object.keys(declared) : []
  if (declared !== false && (levels.length === 0 || (!direct && !levels.some(level => level !== 'off')))) return 'reasoningNeedsLevel'
  const defaultEffort = model['defaultReasoningEffort']
  if (defaultEffort !== undefined && !levels.includes(defaultEffort)) return 'reasoningDefaultInvalid'
  if (!direct && typeof declared === 'object' && declared !== null && !Array.isArray(declared)
    && Object.entries(declared).some(([id, wire]) => wire === null ? id !== 'off' : typeof wire !== 'string' || wire.trim() === '')) return 'reasoningWireInvalid'
  return undefined
}

const LABELS: Readonly<Record<string, ModelsKey>> = {
  off: 'reasoningOff', minimal: 'reasoningMinimal', low: 'reasoningLow', medium: 'reasoningMedium',
  high: 'reasoningHigh', xhigh: 'reasoningXhigh', max: 'reasoningMax',
}

/**
 * Name known levels through locale-owned copy, preserving adapter extension names.
 * @param id - effort identifier.
 * @param t - section copy.
 * @param inherited - optional provider-owned display metadata.
 * @returns localized label with its stable identifier.
 */
export function reasoningLabel(id: string, t: (key: ModelsKey) => string, inherited?: LlmModelReasoningInfo): string {
  const key = LABELS[id]
  return key === undefined ? inherited?.efforts.find(level => level.id === id)?.name ?? id : `${t(key)} · ${id}`
}
