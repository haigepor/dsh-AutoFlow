/** Read-only Chat composer metadata supplies feature counts separately from Work quota. */
import { z } from 'zod'
import type { AccountChatUsage } from '../../shared/accounts.ts'

const metadataSchema = z.object({
  type: z.literal('conversation_detail_metadata'),
  limits_progress: z.array(z.object({ feature_name: z.string().max(128), remaining: z.number().int().nonnegative().nullish(),
    reset_after: z.string().datetime({ offset: true }).nullish() })).max(128).optional(),
})

/** Project only the image counter; absent model limits never imply unlimited Chat messages.
 * @param raw Bounded response from the composer's metadata endpoint.
 * @param now Observation clock in milliseconds.
 * @returns Reported remaining count and estimated reset, without inferring a total or fixed period.
 */
export function parseChatUsage(raw: unknown, now: number): AccountChatUsage {
  const value = metadataSchema.parse(raw), image = value.limits_progress?.find(item => item.feature_name === 'image_gen')
  return { status: 'ready', freshness: 'fresh', fetchedAt: now, attemptedAt: now, lastSuccessfulAt: now,
    ...(image?.remaining == null ? {} : { imageGeneration: { remaining: image.remaining,
      ...(image.reset_after == null ? {} : { resetAt: Date.parse(image.reset_after) }) } }) }
}
