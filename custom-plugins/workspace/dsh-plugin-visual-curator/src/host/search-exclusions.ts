/** Exact reference and prior-selection identities are fixed before a new search is accepted. */
import { z } from 'zod'
import { contentDigest } from '../domain/repository.ts'
import type { CuratorDomain } from '../domain/curator.ts'
import type { Asset, DomainActor, ImageVersion, RunRecord, StyleStandard } from '../shared/model.ts'
import { effectiveReviewReferenceRole } from './review-references.ts'

/** The exact source was a negative, another current reference, or a prior returned image. */
export const searchExclusionReasonSchema = z.enum(['negative-reference', 'reference', 'previous-selection'])
/** Exclusive reason retained with each skipped candidate. */
export type SearchExclusionReason = z.infer<typeof searchExclusionReasonSchema>
/** Missing policies on older specs retain their original search behavior. */
export const searchExclusionsSchema = z.strictObject({ version: z.literal(1), sources: z.record(z.string().min(1), searchExclusionReasonSchema), digests: z.record(z.string().min(1), searchExclusionReasonSchema) })
/** Detached exact-source and verified-byte identities for one admitted search. */
export type SearchExclusions = z.infer<typeof searchExclusionsSchema>

interface SourceIdentity { providerId: string; providerAssetId: string; accountIdentity: string }
/** @param source Stable source identity, never a media URL. @returns Account-independent Unsplash photo identity, or an account-scoped identity for other providers. */
export function searchSourceKey(source: SourceIdentity): string {
  return contentDigest({ providerId: source.providerId, providerAssetId: source.providerAssetId, ...(source.providerId === 'unsplash' ? {} : { accountIdentity: source.accountIdentity }) })
}

/** @param domain Profile records. @param styleId Exact collection. @returns Existing search Runs with saved automatically qualified selections in that collection. */
export function searchHistoryRuns(domain: CuratorDomain, styleId: string): RunRecord[] {
  const selected = new Set(domain.repository.list('selection').filter(row => row.qualification === 'auto-qualified').map(row => row.runId))
  const scope = z.object({ kind: z.literal('search'), fixed: z.object({ release: z.object({ styleId: z.literal(styleId) }) }) })
  return domain.repository.list('run').filter(run => selected.has(run.id) && scope.safeParse(run.spec).success)
}

/** @param domain Authorized records. @param standard Frozen references and rules. @param actor Reference reader. @param history Verified original readers for prior search Runs. @returns Detached exact identities; no private paths, pixels or historical task text enter the policy. */
export function freezeSearchExclusions(domain: CuratorDomain, standard: StyleStandard, actor: DomainActor, history: readonly { run: RunRecord; actor: DomainActor }[]): SearchExclusions {
  const sources = new Map<string, SearchExclusionReason>(), digests = new Map<string, SearchExclusionReason>()
  const rank = { 'negative-reference': 0, reference: 1, 'previous-selection': 2 }
  const put = (target: Map<string, SearchExclusionReason>, key: string, reason: SearchExclusionReason) => { const prior = target.get(key); if (prior === undefined || rank[reason] < rank[prior]) target.set(key, reason) }
  const add = (image: ImageVersion, asset: Asset, reason: SearchExclusionReason) => {
    if (image.blob.remoteSource) {
      const source = image.blob.remoteSource
      put(sources, searchSourceKey({ providerId: source.providerId, providerAssetId: source.photoId, accountIdentity: source.accountId }), reason)
    } else put(digests, image.blob.digest, reason)
    if (asset.source.kind === 'provider') put(sources, searchSourceKey(asset.source), reason)
    if (asset.originalBlob && !asset.originalBlob.remoteSource) put(digests, asset.originalBlob.digest, reason)
  }
  for (const reference of standard.references) {
    const { image, asset } = domain.authorizedImage(reference.reference.imageVersionId, actor)
    add(image, asset, effectiveReviewReferenceRole(standard, reference) === 'negative' ? 'negative-reference' : 'reference')
  }
  const readers = new Map<string, DomainActor>(history.map(item => [item.run.id, item.actor]))
  for (const selection of domain.repository.list('selection')) {
    const reader = readers.get(selection.runId)
    if (!reader || selection.qualification !== 'auto-qualified') continue
    const { image, asset } = domain.authorizedImage(selection.imageVersionId, reader)
    add(image, asset, 'previous-selection')
  }
  const entries = (items: Map<string, SearchExclusionReason>) => Object.fromEntries([...items].sort(([left], [right]) => left.localeCompare(right, 'en')))
  return searchExclusionsSchema.parse({ version: 1, sources: entries(sources), digests: entries(digests) })
}

/** @param policy Optional accepted policy. @param source Current candidate identity. @returns Exact source exclusion, independent of URL parameters. */
export function sourceExclusion(policy: SearchExclusions | undefined, source: SourceIdentity): SearchExclusionReason | undefined { return policy?.sources[searchSourceKey(source)] }

/** @param policy Optional accepted policy. @param image Actual normalized version. @param asset Authorized source asset. @returns Exact source or byte-digest exclusion; remote descriptor hashes never claim pixel equivalence. */
export function imageExclusion(policy: SearchExclusions | undefined, image: ImageVersion, asset: Asset): SearchExclusionReason | undefined {
  if (!policy) return undefined
  const source = asset.source.kind === 'provider' ? sourceExclusion(policy, asset.source) : undefined
  const reasons = [source, !image.blob.remoteSource ? policy.digests[image.blob.digest] : undefined, asset.originalBlob && !asset.originalBlob.remoteSource ? policy.digests[asset.originalBlob.digest] : undefined]
  return (['negative-reference', 'reference', 'previous-selection'] as const).find(reason => reasons.includes(reason))
}

/** @param excluded Saved per-candidate decisions. @returns Nonoverlapping exclusion counters, without changing technical or visual-failure counts. */
export function exclusionCounts(excluded: Readonly<Record<string, SearchExclusionReason>>) {
  const reasons = Object.values(excluded)
  return { excludedNegative: reasons.filter(reason => reason === 'negative-reference').length, excludedReference: reasons.filter(reason => reason === 'reference').length, excludedPrevious: reasons.filter(reason => reason === 'previous-selection').length }
}
