/** Codex quota parsing and the upstream composer's held-account policy. */
import { z } from 'zod'
import type { AccountUsage } from '../../shared/accounts.ts'

const windowSchema = z.object({ used_percent: z.number().finite(), reset_at: z.number().finite().optional(),
  reset_after_seconds: z.number().finite().nonnegative().optional(), limit_window_seconds: z.number().positive().optional() })
const usageSchema = z.object({ plan_type: z.string().max(128).optional(),
  rate_limit: z.object({ allowed: z.boolean().nullish(), primary_window: windowSchema.nullable().optional(), secondary_window: windowSchema.nullable().optional() }).optional(),
  credits: z.object({ has_credits: z.boolean().optional(), unlimited: z.boolean().optional(), balance: z.union([z.string().max(128), z.number().finite()]).nullish(), overage_limit_reached: z.boolean().nullish() }).nullish(),
  spend_control: z.object({ reached: z.boolean().optional() }).nullish(), rate_limit_reached_type: z.object({ type: z.string().max(128).nullish() }).nullish(),
  rate_limit_reset_credits: z.object({ available_count: z.number().int().nonnegative() }).nullable().optional() })
const resetSchema = z.object({ credits: z.array(z.object({ status: z.string(), expires_at: z.string().nullable().optional() })).max(4096) })
// Magpie 的 workspace/reserve 列表仅参与已知额度结果的 composer 状态，不从套餐名推断模型或生图权限。
const workspaces = new Set(['free_workspace', 'team', 'self_serve_business_prolite', 'self_serve_business_usage_based', 'business', 'ent26',
  'enterprise_cbp_automation', 'enterprise_cbp_trial', 'enterprise_cbp_usage_based', 'enterprise_cbp_view_only', 'enterprise', 'hc', 'finserv', 'law', 'sci',
  'education', 'edu', 'edu_plus', 'edu_pro', 'quorum', 'k12'])
const reserves = new Set(['team', 'self_serve_business_prolite'])

/** Parse safe account usage fields without treating a token's expiry as subscription expiry.
 * @param raw Bounded upstream usage JSON.
 * @param now Receiving clock in milliseconds.
 * @returns A successful quota observation and its upstream held state.
 */
export function parseAccountUsage(raw: unknown, now: number): AccountUsage {
  const value = usageSchema.parse(raw)
  const window = (item: z.infer<typeof windowSchema> | null | undefined) => item === undefined || item === null ? undefined : {
    usedPercent: item.used_percent,
    ...(item.reset_at !== undefined && item.reset_at > 0 ? { resetAt: item.reset_at * 1000 }
      : item.reset_after_seconds === undefined ? {} : { resetAt: now + item.reset_after_seconds * 1000 }),
    ...(item.limit_window_seconds === undefined ? {} : { windowSeconds: item.limit_window_seconds }) }
  const primary = window(value.rate_limit?.primary_window), secondary = window(value.rate_limit?.secondary_window)
  const rawBalance = value.credits?.balance
  const amount = typeof rawBalance === 'number' ? rawBalance : typeof rawBalance === 'string' && rawBalance.trim() !== '' ? Number(rawBalance) : NaN
  const credits = value.credits == null ? undefined : {
    ...(value.credits.has_credits === undefined ? {} : { hasCredits: value.credits.has_credits }),
    ...(value.credits.unlimited === undefined ? {} : { unlimited: value.credits.unlimited }),
    // Team 套餐可返回 null；未知积分不等于零，也不能让整份额度响应失效。
    ...(value.credits.balance == null ? {} : { balance: String(value.credits.balance) }),
    ...(value.credits.overage_limit_reached == null ? {} : { overageLimitReached: value.credits.overage_limit_reached }),
    // 余额未报告时保留上游 has_credits；明确的零余额只取消续用提示，不改写 composer 的 allowed 状态。
    usable: value.credits.unlimited === true || value.credits.has_credits === true && (!Number.isFinite(amount) || amount > 0) }
  const limitReason = value.rate_limit_reached_type?.type ?? undefined, plan = value.plan_type?.toLowerCase()
  const workspaceOverage = plan !== undefined && workspaces.has(plan) && !reserves.has(plan) && credits?.overageLimitReached === false
    && value.spend_control?.reached !== true && (limitReason === undefined || limitReason === 'rate_limit_reached')
  const held = value.rate_limit?.allowed === false && credits?.hasCredits !== true && credits?.unlimited !== true && !workspaceOverage
  return { status: 'ready', freshness: 'fresh', fetchedAt: now, attemptedAt: now, lastSuccessfulAt: now,
    ...(value.plan_type === undefined ? {} : { plan: value.plan_type }), ...(primary === undefined ? {} : { primary }), ...(secondary === undefined ? {} : { secondary }),
    ...(value.rate_limit?.allowed == null ? {} : { allowed: value.rate_limit.allowed }), ...(credits === undefined ? {} : { credits }),
    ...(value.spend_control?.reached === undefined ? {} : { spendControlReached: value.spend_control.reached }), ...(limitReason === undefined ? {} : { limitReason }),
    ...(value.rate_limit_reset_credits == null ? {} : { resetCredits: { availableCount: value.rate_limit_reset_credits.available_count } }),
    held, ...(held ? { heldReason: value.spend_control?.reached === true || credits?.overageLimitReached === true ? 'spending-limit'
      : limitReason !== undefined && limitReason !== 'rate_limit_reached' ? 'workspace-limit' : 'usage-limit' } : {}) }
}

/** Extract expiry only from available reset credits; credit identifiers never leave the Host.
 * @param raw Bounded, optional reset-details response.
 * @param count Count from the successful usage response.
 * @param now Receiving clock in milliseconds.
 * @returns Earliest future expiry when the detail list agrees with the usage count.
 */
export function resetCreditExpiry(raw: unknown, count: number, now: number): number | undefined {
  const parsed = resetSchema.safeParse(raw)
  if (!parsed.success) return undefined
  const available = parsed.data.credits.filter(credit => credit.status === 'available')
  if (available.length !== count) return undefined
  const dates = available.map(credit => Date.parse(credit.expires_at ?? '')).filter(date => Number.isFinite(date) && date > now)
  return dates.length === 0 ? undefined : Math.min(...dates)
}

/** Protect known spent allowance through failed polls, while respecting an explicit credits opt-in.
 * @param usage Latest successful values, including any failed-attempt marker.
 * @param allowCredits Owner's credits-spending policy.
 * @param now Scheduler clock in milliseconds.
 * @returns Whether text dispatch must wait for quota recovery.
 */
export function quotaBlocks(usage: AccountUsage | undefined, allowCredits: boolean, now: number): boolean {
  if (usage === undefined) return false
  const windows = [usage.primary, usage.secondary].filter(window => window !== undefined)
  const exhausted = windows.some(window => window.usedPercent >= 100 && (window.resetAt ?? Infinity) > now)
  if (!allowCredits && exhausted) return true
  if (usage.held !== true && (allowCredits || usage.allowed !== false)) return false
  if (usage.heldReason === 'workspace-limit' || usage.heldReason === 'spending-limit') return true
  return windows.length === 0 || windows.some(window => (window.resetAt ?? Infinity) > now)
}
