/** Versioned account grants with JSON validation and explicit revision conflicts. */
import { z } from 'zod'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import { accountUsageSchema, authFailureCodeSchema, type AuthFailureCode } from '../../shared/accounts.ts'
import { createHash } from 'node:crypto'

const accountSchema = z.object({
  accountKey: z.string().regex(/^acct-[a-f0-9]{24}$/), accountId: z.string().min(1),
  label: z.string().min(1).max(200), email: z.string().optional(), plan: z.string().optional(), workspace: z.string().optional(),
  userId: z.string().optional(), subscriptionUntil: z.number().finite().optional(), lastRefreshAt: z.number().finite().optional(),
  authFailure: z.object({ credentialTag: z.string().regex(/^[a-f0-9]{64}$/), code: authFailureCodeSchema, at: z.number().finite() }).optional(),
  lastUsage: accountUsageSchema.optional(),
  enabled: z.boolean(), allowCredits: z.boolean().default(true), priority: z.number().int().min(-1000).max(1000).default(0), revision: z.number().int().positive(), createdAt: z.number().finite(), updatedAt: z.number().finite(), metadataAt: z.number().finite().optional(),
  credential: z.object({ type: z.literal('oauth'), access: z.string().min(1), refresh: z.string().min(1), expires: z.number().finite(),
    accountId: z.string().min(1), idToken: z.string().optional() }),
})
const grantSchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), accounts: z.record(z.string(), accountSchema) })

/** Plugin-owned stored credential. Never expose this value through Remote. */
export type StoredAccount = z.infer<typeof accountSchema>
/** Validated account-pool generation kept in the credentials grant. */
export type AccountsGrant = z.infer<typeof grantSchema>

/** Safe details that survive HTTP error classification without retaining its body. */
export interface AccountFailureDetails {
  retryAt?: number
  requestId?: string
  authCode?: AuthFailureCode
  upstreamCode?: string
}

/** Digest identifies one credential generation without exposing its values.
 * @param credential Current Host-only OAuth credential.
 * @returns A stable generation tag used only by the durable Host record.
 */
export function credentialTag(credential: StoredAccount['credential']): string {
  return createHash('sha256').update(credential.access).update('\0').update(credential.refresh).digest('hex')
}

/** Structured failures contain actionable context, never token endpoint response bodies. */
export class AccountError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number, readonly details: AccountFailureDetails = {}) { super(message); this.name = 'AccountError' }
}

/** A complete upstream refusal before output; only this error permits another account attempt. */
export class AccountRejected extends AccountError {
  constructor(status: 401 | 402 | 403 | 429, details: AccountFailureDetails = {}) { super(`HTTP ${status}: The subscription account rejected this request. Check access or quota.`, 'ACCOUNT_REJECTED', status, details) }
}

/** Recover the original typed failure when the native OAuth resolver wraps it as an Error cause.
 * @param error Failure from the native credential resolver.
 * @returns The account failure, if one is present in the cause chain.
 */
export function accountErrorCause(error: unknown): AccountError | undefined {
  const seen = new Set<Error>()
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof AccountError) return error
    seen.add(error); error = error.cause
  }
  return undefined
}

/** Read a durable grant; malformed or foreign records fail without overwriting them. */
export function readGrant(record: CredentialRecord | undefined): AccountsGrant {
  if (record === undefined) return { version: 1, revision: 0, accounts: {} }
  if (record.kind !== 'grant') throw new AccountError('订阅账号凭据格式不匹配。', 'INVALID_RECORD')
  const parsed = grantSchema.safeParse(record.payload)
  if (!parsed.success) throw new AccountError('订阅账号凭据损坏或版本不受支持。', 'INVALID_RECORD')
  for (const [key, account] of Object.entries(parsed.data.accounts)) {
    if (key !== account.accountKey || account.accountId !== account.credential.accountId) {
      throw new AccountError('订阅账号身份与凭据不匹配。', 'INVALID_RECORD')
    }
  }
  return parsed.data
}

/** Normalize OAuth extension fields after a provider refresh while retaining account metadata. */
export function readCredential(value: OAuthCredential): StoredAccount['credential'] {
  const parsed = accountSchema.shape.credential.safeParse(value)
  if (!parsed.success) throw new AccountError('OAuth 返回的凭据字段不完整。', 'INVALID_TOKEN')
  return parsed.data
}
