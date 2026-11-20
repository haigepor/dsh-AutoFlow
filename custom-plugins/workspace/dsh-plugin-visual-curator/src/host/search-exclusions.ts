/** Exact reference and collection-scoped search-history identities are fixed before a new search is accepted. */
import { z } from 'zod'
import { contentDigest } from '../domain/repository.ts'
import type { CuratorDomain } from '../domain/curator.ts'
import { recipeSchema, styleStandardSchema, usageSchema, type Assessment, type Asset, type DomainActor, type ImageVersion, type RunRecord, type StyleStandard } from '../shared/model.ts'
import { searchOutputSchema } from '../shared/search-launch.ts'
import { effectiveReviewReferenceRole } from './review-references.ts'
import { searchScreeningCheckpointSchema } from './search-screening-state.ts'
import { reviewerRevision, searchScreeningPolicySchema, settingsSchema } from './config.ts'
import { sourceIdentity } from './providers.ts'
import type { ExecutionSpec } from './runtime.ts'

/** Exact sources can be current references, returned images, or previously rejected photos; no prior verdict is applied to a new image. */
export const searchExclusionReasonSchema = z.enum(['negative-reference', 'reference', 'previous-selection', 'previous-rejection'])
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

function confirmedRejection(assessment: Assessment): boolean {
  return assessment.technicalStatus === 'completed' && assessment.verdict === 'reject'
}

const screeningHistorySchema = z.object({ checkpoint: z.object({ searchScreening: searchScreeningCheckpointSchema }) })
function coarseRejections(run: RunRecord): string[] {
  const saved = screeningHistorySchema.safeParse(run.data)
  return saved.success ? Object.entries(saved.data.checkpoint.searchScreening.screened).flatMap(([id, result]) => result.decision === 'obvious-reject' ? [id] : []) : []
}

const reviewScopeSchema = z.object({
  config: settingsSchema, input: z.object({ taskBrief: z.string().min(1) }),
  fixed: z.object({ release: styleStandardSchema, executionRecipe: recipeSchema.optional(), output: searchOutputSchema.optional(), usage: usageSchema.optional(),
    wallpaperAuto: z.boolean().optional(), cropReviewPolicy: z.string().optional(), cropModelViews: z.string().optional(), searchScreening: searchScreeningPolicySchema.optional(), searchHardScreening: z.literal(1).optional(), previewPixelIdentity: z.literal(1).optional() }),
})
function reviewScope(spec: unknown) {
  const saved = reviewScopeSchema.safeParse(spec)
  if (!saved.success || saved.data.config.source.provider !== 'unsplash') return undefined
  const { config, input, fixed } = saved.data
  const output = fixed.output ?? (fixed.usage && { kind: 'usage' as const, usageRevisionId: fixed.usage.id })
  if (!output || output.kind === 'usage' && fixed.usage?.id !== output.usageRevisionId) return undefined
  const standard = fixed.executionRecipe ? { ...fixed.release, recipe: fixed.executionRecipe } : fixed.release
  return { standard, output: output.kind, screening: fixed.searchScreening && contentDigest({ policy: fixed.searchScreening, hardScreening: fixed.searchHardScreening ?? null }),
    digest: contentDigest({ standard, reviewer: reviewerRevision(config), input, output, usage: fixed.usage, wallpaperAuto: fixed.wallpaperAuto === true, cropReviewPolicy: fixed.cropReviewPolicy, cropModelViews: fixed.cropModelViews, previewPixelIdentity: fixed.previewPixelIdentity ?? null }) }
}

function matchesRejection(assessment: Assessment, scope: NonNullable<ReturnType<typeof reviewScope>>): boolean {
  const { standard, output } = scope
  const saved = assessment.standard
  const sameStandard = saved ? saved.kind === standard.kind && saved.id === standard.id && saved.contentDigest === standard.contentDigest : assessment.releaseId === standard.id && standard.kind === 'release'
  return sameStandard && assessment.recipeId === standard.recipe.id && (output === 'original' || assessment.stage === (output === 'preview' ? 'final' : 'source'))
}

/** @param domain Profile records. @param styleId Exact collection. @returns Search Runs with saved selections, completed rejections, or conservative coarse exclusions in that collection. */
export function searchHistoryRuns(domain: CuratorDomain, styleId: string): RunRecord[] {
  const selected = new Set(domain.repository.list('selection').filter(row => row.qualification === 'auto-qualified').map(row => row.runId))
  for (const assessment of domain.repository.list('assessment')) if (confirmedRejection(assessment)) selected.add(assessment.runId)
  const scope = z.object({ kind: z.literal('search'), fixed: z.object({ release: z.object({ styleId: z.literal(styleId) }) }) })
  return domain.repository.list('run').filter(run => scope.safeParse(run.spec).success && (selected.has(run.id) || coarseRejections(run).length > 0))
}

/** @param domain Authorized records. @param standard Effective frozen references and rules. @param actor Reference reader. @param history Verified original readers for prior search Runs. @param current New search inputs; omitted when collecting the current parent Run's already reviewed sources for wallpaper recovery. @returns Detached exact identities with quality rejections limited to equivalent Unsplash reviews. */
export function freezeSearchExclusions(domain: CuratorDomain, standard: StyleStandard, actor: DomainActor, history: readonly { run: RunRecord; actor: DomainActor }[], current?: Pick<ExecutionSpec, 'config' | 'input' | 'fixed'>): SearchExclusions {
  const sources = new Map<string, SearchExclusionReason>(), digests = new Map<string, SearchExclusionReason>()
  const rank = { 'negative-reference': 0, reference: 1, 'previous-selection': 2, 'previous-rejection': 3 }
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
  const scope = z.object({ kind: z.literal('search'), fixed: z.object({ release: z.object({ styleId: z.literal(standard.styleId) }) }) })
  const scopedHistory = history.filter(item => scope.safeParse(item.run.spec).success)
  const readers = new Map<string, DomainActor>(scopedHistory.map(item => [item.run.id, item.actor]))
  const scopedRejections = current?.config.source.provider === 'unsplash'
  const currentScope = scopedRejections ? reviewScope(current) : undefined
  const matchingReviews = new Map<string, NonNullable<ReturnType<typeof reviewScope>>>()
  if (currentScope) for (const { run } of scopedHistory) {
    const saved = reviewScope(run.spec)
    if (saved?.digest === currentScope.digest) matchingReviews.set(run.id, saved)
  }
  for (const selection of domain.repository.list('selection')) {
    const reader = readers.get(selection.runId)
    if (!reader || selection.qualification !== 'auto-qualified') continue
    const { image, asset } = domain.authorizedImage(selection.imageVersionId, reader)
    add(image, asset, 'previous-selection')
  }
  for (const assessment of domain.repository.list('assessment')) {
    const reader = readers.get(assessment.runId)
    if (!reader || !confirmedRejection(assessment)) continue
    const matching = matchingReviews.get(assessment.runId)
    if (scopedRejections && (!matching || !matchesRejection(assessment, matching))) continue
    const { image, asset } = domain.authorizedImage(assessment.imageVersionId, reader)
    if (matching && image.versionKind !== (matching.output === 'preview' ? 'remote-reference' : 'normalized')) continue
    add(image, asset, 'previous-rejection')
  }
  for (const { run } of scopedHistory) {
    if (scopedRejections && (!currentScope?.screening || matchingReviews.get(run.id)?.screening !== currentScope.screening)) continue
    const rejected = coarseRejections(run)
    if (!rejected.length) continue
    const owner = sourceIdentity(z.object({ config: settingsSchema }).parse(run.spec).config)
    for (const providerAssetId of rejected) put(sources, searchSourceKey({ ...owner, providerAssetId }), 'previous-rejection')
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
  return (['negative-reference', 'reference', 'previous-selection', 'previous-rejection'] as const).find(reason => reasons.includes(reason))
}

/** @param excluded Saved per-candidate decisions. @returns Nonoverlapping exclusion counters, without changing technical or visual-failure counts. */
export function exclusionCounts(excluded: Readonly<Record<string, SearchExclusionReason>>) {
  const reasons = Object.values(excluded)
  return { excludedNegative: reasons.filter(reason => reason === 'negative-reference').length, excludedReference: reasons.filter(reason => reason === 'reference').length, excludedPrevious: reasons.filter(reason => reason === 'previous-selection' || reason === 'previous-rejection').length }
}
