/** Browser metadata cache policy is shared with Host configuration and older live Client projections. */
/** Configurable freshness and memory/storage ceilings for gallery metadata. */
export type GalleryCachePolicy = { ttlMs: number; maxPages: number; maxBytes: number }
/** Default cache limits applied by both the Host parser and the Client projection resolver. */
export const galleryCacheDefaults: GalleryCachePolicy = { ttlMs: 5 * 60_000, maxPages: 120, maxBytes: 2 * 1024 * 1024 }

/** Resolve the optional projection before constructing a cache; an older Host can remain live during Client HMR.
 * @param policy Host-validated cache policy, when present. @returns Explicit metadata-cache limits.
 */
export function resolveGalleryCachePolicy(policy: GalleryCachePolicy | undefined): GalleryCachePolicy { return policy ?? galleryCacheDefaults }
