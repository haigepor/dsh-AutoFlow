/** Browser metadata cache policy is shared with Host configuration and older live Client projections. */
/** Configurable freshness and memory/storage ceilings for gallery metadata. */
export type GalleryCachePolicy = { ttlMs: number; maxPages: number; maxBytes: number }
/** Default cache limits applied by both the Host parser and the Client projection resolver. */
export const galleryCacheDefaults: GalleryCachePolicy = { ttlMs: 5 * 60_000, maxPages: 120, maxBytes: 2 * 1024 * 1024 }
/** Default UI preview slots; accepted Run network budgets remain independent. */
export const defaultPreviewConcurrency = 2
/** Owner-scoped file cache; entries retain the complete authorized URL. */
export type PreviewCachePolicy = { ttlMs: number; maxEntries: number; maxBytes: number }
/** Bounded image cache; no image bytes are written to browser storage. */
export const previewCacheDefaults: PreviewCachePolicy = { ttlMs: 5 * 60_000, maxEntries: 96, maxBytes: 64 * 1024 * 1024 }
/** @param policy Host-validated optional image policy. @returns Explicit memory-cache limits. */
export function resolvePreviewCachePolicy(policy: PreviewCachePolicy | undefined): PreviewCachePolicy { return policy ?? previewCacheDefaults }

/** Resolve the optional projection before constructing a cache; an older Host can remain live during Client HMR.
 * @param policy Host-validated cache policy, when present. @returns Explicit metadata-cache limits.
 */
export function resolveGalleryCachePolicy(policy: GalleryCachePolicy | undefined): GalleryCachePolicy { return policy ?? galleryCacheDefaults }
