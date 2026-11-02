/** Host-owned completion cache preferences projected through Settings. */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { CandidateCacheFields } from './config.ts'

/** Live cache bounds for the browser completion pipeline. */
export interface Config {
  /** Maximum retained queries per Client Session; zero disables caching. */
  candidateCacheMaxEntries: Volatile<number>
  /** Freshness interval in milliseconds; zero refreshes each open. */
  candidateCacheMaxAgeMs: Volatile<number>
}

/** Cache settings accepted by cordis.yml and the shared settings service. */
export const Config = z.object({
  candidateCacheMaxEntries: CandidateCacheFields.candidateCacheMaxEntries.volatile(),
  candidateCacheMaxAgeMs: CandidateCacheFields.candidateCacheMaxAgeMs.volatile(),
})

/**
 * Expose cache preferences without adding an automatically generated settings page.
 * @param ctx - Host plugin context.
 * @param _config - validated live cache preferences.
 */
export function apply(ctx: Context, _config: Config): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}
