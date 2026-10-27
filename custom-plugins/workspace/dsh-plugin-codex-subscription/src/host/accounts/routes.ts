/** Stable capability routes keep advertised model limits aligned with every fallback account. */
import { createHash } from 'node:crypto'
import type { Model, ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { CodexModelSnapshot } from '../models.ts'
import type { CodexModelRouteView, CodexModelView } from './types.ts'

const levels: readonly ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
type NativeModel = Model<'openai-codex-responses'>
interface Entry { accountKey: string; view: CodexModelView; model: NativeModel; defaultEffort?: ModelThinkingLevel }
/** Host-owned route generation; its descriptors contain no credential values. */
export interface CodexModelRoute { readonly view: CodexModelRouteView; readonly snapshot: CodexModelSnapshot }

function supported(model: NativeModel): readonly ModelThinkingLevel[] {
  if (!model.reasoning) return ['off']
  return levels.filter(level => model.thinkingLevelMap?.[level] !== null && (!['xhigh', 'max'].includes(level) || model.thinkingLevelMap?.[level] !== undefined))
}

function capabilities(entry: Entry): string {
  return JSON.stringify([entry.model.contextWindow, entry.model.maxTokens, [...entry.model.input].sort(), supported(entry.model),
    levels.map(level => entry.model.thinkingLevelMap?.[level]), entry.defaultEffort, entry.view.serviceTiers?.slice().sort(), entry.model.compat])
}

function supports(have: Entry, need: Entry): boolean {
  return have.model.contextWindow >= need.model.contextWindow && have.model.maxTokens >= need.model.maxTokens
    && need.model.input.every(input => have.model.input.includes(input))
    && supported(need.model).every(level => supported(have.model).includes(level)
      && have.model.thinkingLevelMap?.[level] === need.model.thinkingLevelMap?.[level])
    && (need.view.serviceTiers === undefined || need.view.serviceTiers.every(tier => have.view.serviceTiers?.includes(tier)))
    && JSON.stringify(have.model.compat) === JSON.stringify(need.model.compat)
}

/** Build deterministic routes from one captured discovery generation, independent of login order.
 * @param accounts Enabled, authorized accounts and their detached model snapshots.
 * @returns Default model routes and stable aliases for other complete capability groups.
 */
export function buildModelRoutes(accounts: readonly { accountKey: string; snapshot: CodexModelSnapshot }[]): readonly CodexModelRoute[] {
  const byModel = new Map<string, Entry[]>()
  for (const account of accounts) for (const view of account.snapshot.views) {
    const model = account.snapshot.models.find(model => model.id === view.id)
    if (model === undefined) continue
    const entries = byModel.get(view.id) ?? [], defaultEffort = account.snapshot.defaults.get(view.id)
    entries.push({ accountKey: account.accountKey, view, model, ...(defaultEffort === undefined ? {} : { defaultEffort }) }); byModel.set(view.id, entries)
  }
  const routes: CodexModelRoute[] = []
  for (const [baseModelId, entries] of byModel) {
    const groups = [...new Map(entries.slice().sort((a, b) => a.accountKey.localeCompare(b.accountKey)).map(entry => [capabilities(entry), entry])).entries()]
      .sort(([aKey, a], [bKey, b]) => b.model.contextWindow - a.model.contextWindow
        || Math.max(...supported(b.model).map(level => levels.indexOf(level))) - Math.max(...supported(a.model).map(level => levels.indexOf(level)))
        || b.model.input.length - a.model.input.length || b.model.maxTokens - a.model.maxTokens || aKey.localeCompare(bKey))
    for (const [index, [key, entry]] of groups.entries()) {
      const capabilityId = `dsh-cap:${createHash('sha256').update(baseModelId).update('\0').update(key).digest('hex').slice(0, 32)}`
      if (byModel.has(capabilityId)) throw new Error('The upstream catalog collides with a reserved capability route ID.')
      const id = index === 0 ? baseModelId : capabilityId
      const view: CodexModelRouteView = { ...structuredClone(entry.view), id, baseModelId, capabilityId, routeKind: index === 0 ? 'default' : 'capability',
        accountKeys: entries.filter(have => supports(have, entry)).map(entry => entry.accountKey).sort() }
      const model = structuredClone({ ...entry.model, id })
      routes.push({ view, snapshot: { views: [view], models: [model], defaults: new Map(entry.defaultEffort === undefined ? [] : [[id, entry.defaultEffort]]) } })
    }
  }
  return routes
}

/** Honor explicit raw-request effort and tier without constructing a union no account can serve.
 * @param routes Captured routes for the current pool.
 * @param model Public model ID or capability alias.
 * @param effort Explicit upstream reasoning effort, if supplied.
 * @param tier Explicit service tier, if supplied.
 * @returns One complete compatible route; an alias never silently selects another group.
 */
export function selectModelRoute(routes: readonly CodexModelRoute[], model: string, effort?: string, tier?: string): CodexModelRoute | undefined {
  const base = routes.find(route => route.view.id === model || route.view.capabilityId === model)?.view.baseModelId ?? model
  const declaredTiers = routes.some(route => route.view.baseModelId === base && route.view.serviceTiers !== undefined)
  const compatible = (route: CodexModelRoute) => (effort === undefined || route.view.reasoningEfforts === undefined
    || route.view.reasoningEfforts.some(level => level === (effort === 'none' ? 'off' : effort))
    || effort === 'none' && route.view.reasoningEfforts.length === 0)
    && (tier === undefined || !declaredTiers || route.view.serviceTiers?.includes(tier) === true)
  const exact = routes.find(route => route.view.id === model || route.view.capabilityId === model)
  if (exact !== undefined && compatible(exact)) {
    if (exact.view.id === model) return exact
    // 能力组变为默认组后，已保存的能力 ID 仍解析到相同的限制，不依赖账号排序或内存别名表。
    const view: CodexModelRouteView = { ...exact.view, id: model, routeKind: 'capability' }
    const defaultEffort = exact.snapshot.defaults.get(exact.view.id)
    return { view, snapshot: { views: [view], models: exact.snapshot.models.map(value => ({ ...value, id: model })),
      defaults: new Map(defaultEffort === undefined ? [] : [[model, defaultEffort]]) } }
  }
  return exact?.view.routeKind === 'capability' || exact?.view.capabilityId === model ? undefined : routes.find(route => route.view.baseModelId === model && compatible(route))
}
