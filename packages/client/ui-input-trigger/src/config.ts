/** Deployment settings for completion-result retention in each Client Session. */
import z from '@deepseek-ai/schemastery'

/** Bounds for sources that opt into the candidate cache. */
export interface Config {
  /** Maximum retained query results per Client Session; zero disables caching. */
  candidateCacheMaxEntries: number
  /** Freshness interval in milliseconds; stale rows remain visible during refresh. */
  candidateCacheMaxAgeMs: number
}

/** Shared defaults used by Host preferences and Client cache owners. */
export const CandidateCacheFields = {
  candidateCacheMaxEntries: z.natural().default(64),
  candidateCacheMaxAgeMs: z.natural().default(30_000),
}

/** Validate the completion cache bounds before creating controllers. */
export const Config: z<Config> = z.object(CandidateCacheFields)

/**
 * Resolve and validate partial cache options using the schema-owned defaults.
 * @param options - cache bounds supplied by a caller.
 * @returns complete cache limits.
 */
export function resolveCandidateCacheConfig(options: Partial<Config> = {}): Config {
  const defaults = Config()
  return Config({
    candidateCacheMaxEntries: options.candidateCacheMaxEntries ?? defaults.candidateCacheMaxEntries,
    candidateCacheMaxAgeMs: options.candidateCacheMaxAgeMs ?? defaults.candidateCacheMaxAgeMs,
  })
}
