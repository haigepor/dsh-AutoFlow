/** Safe account projections shared by Host methods and authenticated management. */
import { z } from 'zod'

/** Terminal authorization failures; provider messages and credential values are never projected. */
export const authFailureCodeSchema = z.enum(['INVALID_GRANT', 'TOKEN_REVOKED', 'TOKEN_INVALIDATED', 'REFRESH_TOKEN_REUSED', 'REFRESH_TOKEN_EXPIRED', 'REFRESH_TOKEN_INVALIDATED', 'ACCOUNT_DEACTIVATED'])
/** Stable authorization failure usable by caller-owned localization. */
export type AuthFailureCode = z.infer<typeof authFailureCodeSchema>

const quotaWindow = z.object({ usedPercent: z.number().finite(), resetAt: z.number().finite().optional(), windowSeconds: z.number().positive().optional() })
/** Last successful quota values retain independent attempt and freshness metadata. */
export const accountUsageSchema = z.object({
  status: z.enum(['ready', 'error']), freshness: z.enum(['fresh', 'stale', 'unknown']), fetchedAt: z.number(), attemptedAt: z.number().optional(), lastSuccessfulAt: z.number().optional(),
  errorCode: z.enum(['USAGE_POLL_FAILED', 'USAGE_STORAGE_FAILED']).optional(),
  plan: z.string().optional(), primary: quotaWindow.optional(), secondary: quotaWindow.optional(), allowed: z.boolean().optional(),
  credits: z.object({ hasCredits: z.boolean().optional(), unlimited: z.boolean().optional(), balance: z.string().optional(), overageLimitReached: z.boolean().optional() }).optional(),
  spendControlReached: z.boolean().optional(), limitReason: z.string().optional(),
  resetCredits: z.object({ availableCount: z.number().int().nonnegative(), earliestExpiresAt: z.number().optional() }).optional(),
  held: z.boolean().optional(), heldReason: z.enum(['usage-limit', 'workspace-limit', 'spending-limit']).optional(),
})

/** One metadata schema prevents snapshot parsing from dropping fields exposed by account-list. */
export const accountViewSchema = z.object({
  accountKey: z.string(), accountId: z.string(), label: z.string(), email: z.string().optional(), userId: z.string().optional(),
  identityStatus: z.enum(['identified', 'legacy']), plan: z.string().optional(), claimPlan: z.string().optional(), planSource: z.enum(['usage', 'token', 'unknown']),
  planUpdatedAt: z.number().optional(), workspace: z.string().optional(), subscriptionUntil: z.number().optional(),
  enabled: z.boolean(), allowCredits: z.boolean(), priority: z.number(), revision: z.number(), createdAt: z.number(), updatedAt: z.number(),
  expiresAt: z.number(), tokenExpiresAt: z.number(), metadataAt: z.number(), lastRefreshAt: z.number().optional(),
  auth: z.object({ state: z.enum(['ready', 'refreshing', 'refresh-required', 'needs-login', 'unknown']), errorCode: authFailureCodeSchema.optional(), changedAt: z.number().optional() }),
  cooldowns: z.partialRecord(z.enum(['text', 'image', 'models', 'usage']), z.number()),
  modelsStatus: z.enum(['unfetched', 'ready', 'error']), modelsFetchedAt: z.number().optional(), usage: accountUsageSchema.optional(),
})

/** Detached, credential-free account state. */
export type AccountView = z.infer<typeof accountViewSchema>
/** Quota success and last-attempt status are separate so transient failures cannot restore spent allowance. */
export type AccountUsage = z.infer<typeof accountUsageSchema>
