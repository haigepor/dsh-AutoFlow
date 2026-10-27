/** Materialize account model capabilities from the Codex catalog rather than model-name guesses. */
import { z } from 'zod'
import type { Model, ModelThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai'
import type { CodexModelView } from './accounts/types.ts'
import { ReasoningEffortId, type LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const entrySchema = z.object({ slug: z.string().min(1).max(256).optional(), id: z.string().min(1).max(256).optional(),
  display_name: z.string().max(512).optional(), visibility: z.string().optional(), priority: z.number().finite().optional(),
  context_window: positive.optional(), max_context_window: positive.optional(), max_output_tokens: positive.optional(), max_tokens: positive.optional(),
  input_modalities: z.array(z.string()).optional(), supported_reasoning_levels: z.array(z.object({ effort: z.string() })).optional(),
  default_reasoning_level: z.string().optional(), service_tiers: z.array(z.object({ id: z.string().min(1).max(128) })).optional() })
const directorySchema = z.object({ models: z.array(z.unknown()).max(4096) })
const settingsSchema = z.strictObject({ fallbackMaxTokens: positive.default(8192) })
const levels: readonly ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Deployment-owned output budget for models whose server catalog omits that field. */
export type ModelSettings = z.infer<typeof settingsSchema>

/** Frozen per-account discovery result; defaults belong to this same directory generation. */
export interface CodexModelSnapshot {
  readonly views: readonly CodexModelView[]
  readonly models: readonly Model<'openai-codex-responses'>[]
  readonly defaults: ReadonlyMap<string, ModelThinkingLevel>
}

/** Resolve deployment defaults before discovery or dispatch.
 * @param input Optional validated configuration; omitted uses the documented local output budget.
 * @returns Detached model settings.
 */
export function resolveModelSettings(input?: unknown): ModelSettings { return settingsSchema.parse(input ?? {}) }

/** Preserve dynamic subscription metadata in the shared Models settings discovery API.
 * @param model One complete, routable capability group.
 * @returns Browser-safe model metadata without account keys or credentials.
 */
export function codexDiscoveryView(model: CodexModelView): LlmDiscoveredModel {
  const efforts = model.reasoningEfforts ?? []
  return { id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens, inputModalities: [...model.input],
    ...(efforts.some(effort => effort !== 'off') ? { reasoning: { efforts: efforts.map(effort => ({ id: ReasoningEffortId(effort), name: effort })),
      ...(model.defaultReasoningEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(model.defaultReasoningEffort) }) } } : {}) }
}

function levelOf(value: string): ModelThinkingLevel | undefined {
  switch (value) {
    case 'none': case 'off': return 'off'
    case 'ultra': case 'max': return 'max'
    case 'minimal': case 'low': case 'medium': case 'high': case 'xhigh': return value
    default: return undefined
  }
}

/** Validate each wire entry independently so one unknown or malformed entry cannot remove good models.
 * @param value Untrusted Codex models response.
 * @param native Installed model catalog, used only when the server omits a capability.
 * @param settings Resolved local output budget.
 * @param baseUrl Account's fixed Codex API base.
 * @returns Native model descriptors, safe metadata and declared reasoning defaults from one generation.
 */
export function resolveCodexModels(value: unknown, native: readonly Model<'openai-codex-responses'>[], settings: ModelSettings, baseUrl: string): CodexModelSnapshot {
  const entries = directorySchema.parse(value).models.flatMap(raw => { const parsed = entrySchema.safeParse(raw); return parsed.success ? [parsed.data] : [] })
    .filter(entry => entry.visibility !== 'hide').sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
  const models: Model<'openai-codex-responses'>[] = [], views: CodexModelView[] = [], defaults = new Map<string, ModelThinkingLevel>(), seen = new Set<string>()
  for (const entry of entries) {
    const id = entry.slug ?? entry.id
    if (id === undefined || seen.has(id)) continue
    const base = native.find(model => model.id === id)
    const contextWindow = entry.context_window ?? base?.contextWindow ?? entry.max_context_window
    const input = entry.input_modalities === undefined ? base?.input : entry.input_modalities.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
    // 新模型须具备明确的上下文和输入能力；没有从名字推断的通配模型。
    if (contextWindow === undefined || input === undefined || input.length === 0) continue
    const maxTokens = Math.min(contextWindow, entry.max_output_tokens ?? entry.max_tokens ?? base?.maxTokens ?? settings.fallbackMaxTokens)
    const map: ThinkingLevelMap = {}, declared = entry.supported_reasoning_levels?.flatMap(item => {
      const level = levelOf(item.effort)
      return level === undefined ? [] : [level]
    })
    let reasoning = base?.reasoning ?? false
    if (declared !== undefined) {
      reasoning = declared.some(level => level !== 'off')
      for (const level of levels) map[level] = declared.includes(level) ? level === 'off' ? 'none' : level : null
    }
    const model: Model<'openai-codex-responses'> = { ...base, id, name: entry.display_name ?? base?.name ?? id,
      api: 'openai-codex-responses', provider: 'openai-codex', baseUrl, input: [...new Set(input)],
      contextWindow, maxTokens, reasoning, cost: base?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(declared === undefined ? {} : { thinkingLevelMap: map }) }
    const defaultLevel = entry.default_reasoning_level === undefined ? undefined : levelOf(entry.default_reasoning_level)
    if (defaultLevel !== undefined && reasoning && (declared === undefined || declared.includes(defaultLevel))) defaults.set(id, defaultLevel)
    const reasoningEfforts = declared === undefined ? !model.reasoning ? []
      : levels.filter(level => model.thinkingLevelMap?.[level] !== null && (model.thinkingLevelMap?.[level] !== undefined || !['xhigh', 'max'].includes(level))) : [...new Set(declared)]
    views.push({ id, name: model.name, input: [...model.input], contextWindow, maxTokens,
      ...(entry.max_context_window === undefined ? {} : { maxContextWindow: Math.max(contextWindow, entry.max_context_window) }),
      ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }), ...(defaults.get(id) === undefined ? {} : { defaultReasoningEffort: defaults.get(id)! }),
      ...(entry.service_tiers === undefined ? {} : { serviceTiers: [...new Set(entry.service_tiers.map(tier => tier.id))] }) })
    seen.add(id); models.push(model)
  }
  return { views, models, defaults }
}
