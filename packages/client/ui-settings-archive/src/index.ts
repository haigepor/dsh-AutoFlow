/** Loader entry serving the archived session settings browser contribution. */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Host-persisted archive browsing preferences. */
export interface Config {
  /** Session bookmarks independent of sidebar pin and archive state. */
  favoriteSessionIds: Volatile<SessionId[]>
}

/** Accepted bookmark identities are stored through the shared settings document. */
export const Config = z.object({ favoriteSessionIds: z.array(z.string().min(1)).default([]).volatile() })

/** Mount the browser contribution through the client module system. */
export function apply(): void {}
