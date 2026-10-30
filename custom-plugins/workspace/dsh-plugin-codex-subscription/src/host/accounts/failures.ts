/** Bounded upstream failures retain retry/auth semantics while discarding response text. */
import { z } from 'zod'
import { AccountRejected, type AccountFailureDetails } from './record.ts'
import { readBoundedJson } from './json.ts'
import type { AuthFailureCode } from '../../shared/accounts.ts'

const errorSchema = z.object({ error: z.union([z.string(), z.object({ code: z.string().optional(), type: z.string().optional(), param: z.string().nullable().optional(), message: z.string().optional() })]).optional(), error_description: z.string().optional() })

/** Parse the vendor's seconds or HTTP-date hint without allowing an invalid/unbounded date.
 * @param value Retry-After header, when present.
 * @param now Receiving clock in milliseconds.
 * @returns A future retry instant, or undefined when no valid future hint exists.
 */
export function retryAtOf(value: string | null, now: number): number | undefined {
  if (value === null || value.length > 512 || value.trim() === '') return undefined
  const numeric = /^\d+(?:\.\d+)?$/.test(value.trim()) ? now + Number(value) * 1000 : Date.parse(value)
  return Number.isFinite(numeric) && numeric > now && numeric <= Number.MAX_SAFE_INTEGER ? numeric : undefined
}

function authCodeOf(code: string, message: string): AuthFailureCode | undefined {
  for (const [pattern, result] of [
    [/\binvalid_grant\b/i, 'INVALID_GRANT'], [/\btoken_revoked\b|invalidated oauth token|(?:token|sign-in) (?:has been|was) revoked/i, 'TOKEN_REVOKED'],
    [/\btoken_invalidated\b/i, 'TOKEN_INVALIDATED'], [/\brefresh_token_reused\b/i, 'REFRESH_TOKEN_REUSED'],
    [/\brefresh_token_expired\b/i, 'REFRESH_TOKEN_EXPIRED'], [/\brefresh_token_invalidated\b/i, 'REFRESH_TOKEN_INVALIDATED'],
    [/\baccount_deactivated\b/i, 'ACCOUNT_DEACTIVATED'],
  ] satisfies readonly (readonly [RegExp, AuthFailureCode])[]) if (pattern.test(code) || pattern.test(message)) return result
  return undefined
}

/** Read a rejected response using the caller's deadline, exposing only recognized codes and safe headers.
 * @param response Unsuccessful upstream response whose body is consumed here.
 * @param now Receiving clock in milliseconds.
 * @param signal Existing request cancellation and deadline.
 * @returns Safe failure fields; malformed bodies retain the HTTP status semantics.
 */
export async function failureDetails(response: Response, now: number, signal: AbortSignal): Promise<AccountFailureDetails> {
  const details: AccountFailureDetails = {}
  const ms = response.headers.get('retry-after-ms')
  const msAt = ms !== null && /^\d+(?:\.\d+)?$/.test(ms) && ms.length <= 32 ? now + Number(ms) : NaN
  const retryAt = Number.isSafeInteger(Math.ceil(msAt)) && msAt > now ? msAt : retryAtOf(response.headers.get('retry-after'), now)
  if (retryAt !== undefined) details.retryAt = retryAt
  const requestId = response.headers.get('x-request-id')
  if (requestId !== null && /^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) details.requestId = requestId
  let raw: unknown
  try { raw = await readBoundedJson(response, 65_536, signal) }
  catch (_error) { signal.throwIfAborted(); return details /* 拒绝正文损坏不改变已收到的 HTTP 状态，也不回显原文。 */ }
  const parsed = errorSchema.safeParse(raw)
  if (!parsed.success) return details
  const error = parsed.data.error, code = typeof error === 'string' ? error : error?.code ?? error?.type ?? ''
  const message = typeof error === 'object' ? error.message ?? '' : parsed.data.error_description ?? ''
  if ([400, 401, 403].includes(response.status)) {
    const authCode = authCodeOf(code, message)
    if (authCode !== undefined) details.authCode = authCode
  }
  if (/^(rate_limit_exceeded|usage_limit_reached|insufficient_quota|permission_denied|model_not_found|model_not_supported|model_access_denied|token_expired)$/.test(code)) details.upstreamCode = code
  if (details.authCode === undefined && response.status !== 401 && (['model_not_found', 'model_not_supported', 'model_access_denied'].includes(code)
    || typeof error === 'object' && ['model', 'reasoning.effort', 'service_tier'].includes(error?.param ?? '') && ['permission_denied', 'rate_limit_exceeded', 'usage_limit_reached'].includes(code))) {
    details.scope = 'model'
    if (typeof error === 'object' && error?.param === 'reasoning.effort') details.variant = 'reasoning'
    if (typeof error === 'object' && error?.param === 'service_tier') details.variant = 'serviceTier'
  }
  return details
}

/** Classify a complete pre-output refusal consistently across native text, raw Responses and images.
 * @param response Explicit account refusal, or a 404 identifying an unavailable model.
 * @param now Receiving clock in milliseconds.
 * @param signal Request deadline and cancellation.
 * @returns A typed account refusal with no raw provider text.
 */
export async function accountRefusal(response: Response, now: number, signal: AbortSignal): Promise<AccountRejected> {
  const status = response.status
  const details = await failureDetails(response, now, signal)
  if (status !== 401 && status !== 402 && status !== 403 && status !== 429 && !(status === 404 && details.scope === 'model')) throw new Error('Only explicit account refusals can be classified for account fallback.')
  return new AccountRejected(status, details)
}
