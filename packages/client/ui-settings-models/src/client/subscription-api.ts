/** Safe projections of the optional subscription plugin's owner-authorized management action. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'

/** One displayed quota window; absence is unknown, not an unused allowance. */
export interface SubscriptionWindow { usedPercent: number; resetAt?: number; windowSeconds?: number }
/** Credential-free fields consumed by the Models page. */
export interface SubscriptionAccount {
  accountKey: string
  accountId: string
  label: string
  email?: string
  plan?: string
  workspace?: string
  enabled: boolean
  allowCredits: boolean
  priority: number
  revision: number
  tokenExpiresAt: number
  subscriptionUntil?: number
  auth: 'ready' | 'refreshing' | 'refresh-required' | 'needs-login' | 'unknown'
  modelsStatus: 'unfetched' | 'ready' | 'error'
  usage?: {
    status: 'ready' | 'error'
    freshness: 'fresh' | 'stale' | 'unknown'
    primary?: SubscriptionWindow
    secondary?: SubscriptionWindow
    held?: boolean
    credits?: string
    resetCount?: number
    fetchedAt: number
  }
}
/** Progress contains an authorization challenge, never a verifier or token. */
export interface SubscriptionLogin { loginId: string; state: 'waiting' | 'exchanging' | 'authorized' | 'cancelled' | 'failed'; authorizationUrl: string; expiresAt: number }
/** Model membership shown as a count; the model directory owns its full capability rendering. */
export interface SubscriptionModel { id: string; name: string }
/** The subscription feature can be present while its optional Host bundle is disabled. */
export type SubscriptionAvailability = 'active' | 'disabled' | 'missing' | 'restart-required'
/** Narrow Host callbacks; components do not receive a Remote or context. */
export interface SubscriptionOperations {
  availability(signal: AbortSignal): Promise<SubscriptionAvailability>
  activate(signal: AbortSignal): Promise<SubscriptionAvailability>
  invoke(operation: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
}
/** Stable codes are localized by the owning page; upstream exception text is never rendered. */
export class SubscriptionFailure extends Error {
  constructor(readonly code: string) { super(code) }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SubscriptionFailure('INVALID_RESPONSE')
  return value as Record<string, unknown>
}
function text(value: unknown): string { if (typeof value !== 'string') throw new SubscriptionFailure('INVALID_RESPONSE'); return value }
function number(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value)) throw new SubscriptionFailure('INVALID_RESPONSE'); return value }
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') throw new SubscriptionFailure('INVALID_RESPONSE'); return value }
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  const found = choices.find(item => item === value)
  if (found === undefined) throw new SubscriptionFailure('INVALID_RESPONSE')
  return found
}
function list(value: unknown): unknown[] { if (!Array.isArray(value) || value.length > 10000) throw new SubscriptionFailure('INVALID_RESPONSE'); return value }
function window(value: unknown): SubscriptionWindow {
  const record = object(value)
  return { usedPercent: number(record['usedPercent']), ...record['resetAt'] === undefined ? {} : { resetAt: number(record['resetAt']) },
    ...record['windowSeconds'] === undefined ? {} : { windowSeconds: number(record['windowSeconds']) } }
}

/** Validate JSON and project only fields that this page displays.
 * @param value Untrusted action result.
 * @returns Account display records with all credential fields omitted.
 */
export function subscriptionAccounts(value: unknown): SubscriptionAccount[] {
  return list(value).map((item) => {
    const record = object(item), usage = record['usage'] === undefined ? undefined : object(record['usage'])
    const credits = usage?.['credits'] === undefined ? undefined : object(usage['credits'])
    const resets = usage?.['resetCredits'] === undefined ? undefined : object(usage['resetCredits'])
    return { accountKey: text(record['accountKey']), accountId: text(record['accountId']), label: text(record['label']),
      ...record['email'] === undefined ? {} : { email: text(record['email']) }, ...record['plan'] === undefined ? {} : { plan: text(record['plan']) },
      ...record['workspace'] === undefined ? {} : { workspace: text(record['workspace']) },
      enabled: boolean(record['enabled']), allowCredits: boolean(record['allowCredits']), priority: number(record['priority']), revision: number(record['revision']),
      tokenExpiresAt: number(record['tokenExpiresAt']), ...record['subscriptionUntil'] === undefined ? {} : { subscriptionUntil: number(record['subscriptionUntil']) },
      auth: choice(object(record['auth'])['state'], ['ready', 'refreshing', 'refresh-required', 'needs-login', 'unknown']),
      modelsStatus: choice(record['modelsStatus'], ['unfetched', 'ready', 'error']),
      ...usage === undefined ? {} : { usage: { status: choice(usage['status'], ['ready', 'error']), freshness: choice(usage['freshness'], ['fresh', 'stale', 'unknown']),
        fetchedAt: number(usage['fetchedAt']), ...usage['primary'] === undefined ? {} : { primary: window(usage['primary']) },
        ...usage['secondary'] === undefined ? {} : { secondary: window(usage['secondary']) },
        ...usage['held'] === undefined ? {} : { held: boolean(usage['held']) }, ...credits?.['balance'] === undefined ? {} : { credits: text(credits['balance']) },
        ...resets?.['availableCount'] === undefined ? {} : { resetCount: number(resets['availableCount']) } } },
    }
  })
}

/** Validate a login destination before rendering any external link.
 * @param value Untrusted login progress.
 * @returns Safe browser authorization progress.
 */
export function subscriptionLogin(value: unknown): SubscriptionLogin {
  const record = object(value), authorizationUrl = text(record['authorizationUrl']), url = new URL(authorizationUrl)
  if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/oauth/authorize' || url.username || url.password) throw new SubscriptionFailure('INVALID_RESPONSE')
  return { loginId: text(record['loginId']), authorizationUrl, expiresAt: number(record['expiresAt']),
    state: choice(record['state'], ['waiting', 'exchanging', 'authorized', 'cancelled', 'failed']) }
}

/** Project model membership from the optional plugin.
 * @param value Untrusted model list.
 * @returns Detached model names and IDs.
 */
export function subscriptionModels(value: unknown): SubscriptionModel[] {
  return list(value).map((item) => { const record = object(item); return { id: text(record['id']), name: text(record['name']) } })
}

/** Bind the optional bundle through the existing generated Remote, without a browser dependency on its Host code.
 * @param ctx Scope that declares remote.pluginManager.
 * @returns The owner action callbacks and explicit feature activation.
 */
export function createSubscriptionOperations(ctx: Context): SubscriptionOperations {
  const name = 'dsh-plugin-codex-subscription'
  return {
    availability: async (signal) => {
      signal.throwIfAborted()
      const result = await ctx.remote.pluginManager.listBundles(); signal.throwIfAborted()
      if (!result.ok) throw new SubscriptionFailure('UNAVAILABLE')
      const bundle = result.value.find(bundle => bundle.name === name)
      return bundle === undefined || bundle.availability === 'missing' ? 'missing' : bundle.enabled ? 'active' : 'disabled'
    },
    activate: async (signal) => {
      signal.throwIfAborted()
      const result = await ctx.remote.pluginManager.setBundleEnabled(name, true)
      if (!result.ok) throw new SubscriptionFailure('UNAVAILABLE')
      if (result.value.application === 'restart-required') return 'restart-required'
      if (result.value.application !== 'applied') throw new SubscriptionFailure('ACTIVATION_FAILED')
      return 'active'
    },
    invoke: async (operation, args, signal) => {
      const response = await ctx.remote.pluginManager.invokeAction(name, 'manage', { operation, args: JSON.stringify(args) }, signal)
      if (!response.ok) throw new SubscriptionFailure('UNAVAILABLE')
      let value: unknown
      try { value = JSON.parse(response.value.output) } catch { throw new SubscriptionFailure('INVALID_RESPONSE') }
      const envelope = object(value)
      if (envelope['ok'] !== true) {
        const code = text(object(envelope['error'])['code'])
        throw new SubscriptionFailure(/^[A-Z_]{1,80}$/.test(code) ? code : 'UNAVAILABLE')
      }
      return envelope['value']
    },
  }
}
