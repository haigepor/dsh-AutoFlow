/** Preview searches retain public URL descriptors; original download and delivery remain separate workflows. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { contentDigest } from '../domain/repository.ts'
import { remoteReferenceBlob } from '../media/remote-reference.ts'
import type { SourceItem } from '../media/source.ts'
import { assetSchema, imageVersionSchema, assessmentSchema, selectionSchema, styleStandardSchema, type CuratorRecord } from '../shared/model.ts'
import { searchIssueSchema, type SearchIssue } from '../shared/search-feedback.ts'
import { CuratorError } from '../shared/errors.ts'
import { requestBounds, sourceIdentity } from './providers.ts'
import { dataOf, safeFailure, toJson, type Worker } from './runtime.ts'
import { executionStandard } from './style-execution.ts'
import { reviewImage, runActor } from './review.ts'
import type { SearchDependencies } from './search-workflow.ts'
import { chooseSearchQuery } from './search-query-plan.ts'
import { searchExclusionsSchema, searchExclusionReasonSchema, sourceExclusion, exclusionCounts } from './search-exclusions.ts'
import { createScreenedSearchWorker } from './search-screening.ts'
import { createSearchCheckpointWriter, removeUncommittedSearchImports } from './search-checkpoint.ts'

const stateSchema = z.strictObject({
  nextQuery: z.number().int().nonnegative(),
  pages: z.array(z.strictObject({ cursor: z.string().nullable(), seenCursors: z.array(z.string()), ids: z.array(z.string()), offset: z.number().int().nonnegative(), exhausted: z.boolean() })),
  seenIds: z.array(z.string()), importedImages: z.record(z.string(), z.string()), issues: z.array(searchIssueSchema), failedQueries: z.number().int().nonnegative(), searchLimited: z.boolean().default(false),
  excluded: z.record(z.string(), searchExclusionReasonSchema).optional(),
})

/** @param deps Existing source, vision, storage and owner services. @returns Resumable URL-only search whose query turns follow committed review quality. */
export function createPreviewSearchWorker(deps: SearchDependencies): Worker {
  return async ctx => {
    if (ctx.spec.fixed.searchScreening !== undefined) return createScreenedSearchWorker(deps)(ctx)
    if (ctx.spec.config.source.provider !== 'unsplash') throw new CuratorError('capability-unavailable', 'preview-search', 'Preview link searches currently require the Unsplash source.')
    const input = z.object({ queries: z.array(z.string().min(1)).min(1), targetCount: z.number().int().positive() }).parse(ctx.spec.input)
    const standard = executionStandard(styleStandardSchema.parse(ctx.spec.fixed.release), ctx.spec.fixed.executionRecipe)
    const source = await deps.source(ctx.spec.config), vision = await deps.vision(ctx.spec.config), owner = sourceIdentity(ctx.spec.config), actor = runActor(ctx)
    const state = stateSchema.parse(dataOf(ctx.current()).checkpoint.previewSearch ?? { nextQuery: 0, pages: input.queries.map(() => ({ cursor: null, seenCursors: [], ids: [], offset: 0, exhausted: false })), seenIds: [], importedImages: {}, issues: [], failedQueries: 0 })
    const exclusions = ctx.spec.fixed.searchExclusions === undefined ? undefined : searchExclusionsSchema.parse(ctx.spec.fixed.searchExclusions)
    if (exclusions && !state.excluded) state.excluded = {}
    if (state.pages.length !== input.queries.length) throw new CuratorError('reference-unavailable', 'preview-search', 'The saved preview query plan changed.')
    const uncommitted = new Set(removeUncommittedSearchImports(deps.domain, state.importedImages))
    for (const page of state.pages) {
      const offset = page.ids.findIndex(id => uncommitted.has(`${owner.providerId}:${owner.accountIdentity}:${id}`))
      if (offset >= 0) page.offset = Math.min(page.offset, offset)
    }
    const locations = new Map<string, SourceItem>()
    const selections = () => deps.domain.repository.list('selection').filter(item => item.runId === ctx.runId && item.qualification === 'auto-qualified')
    const save = createSearchCheckpointWriter(state, async (snapshot, records, stage) => {
      const data = dataOf(ctx.current())
      const selected = records.flatMap(record => record.kind === 'selection' && record.runId === ctx.runId && record.qualification === 'auto-qualified' ? [record.imageVersionId] : [])
      const qualified = new Set([...selections().map(record => record.imageVersionId), ...selected]).size
      await ctx.save(stage, { checkpoint: { ...data.checkpoint, previewSearch: toJson(snapshot) }, counts: { candidates: snapshot.seenIds.length, distinct: Object.keys(snapshot.importedImages).length, qualified, failedQueries: snapshot.failedQueries, technicalFailed: snapshot.issues.filter(issue => issue.category === 'technical').length, unavailable: 0, ...(snapshot.excluded ? exclusionCounts(snapshot.excluded) : {}) } }, records)
    })
    while (selections().length < input.targetCount) {
      ctx.signal.throwIfAborted()
      const searchAvailable = ctx.ledger.snapshot().search < ctx.spec.config.limits.maxSearchPages
      const index = chooseSearchQuery({
        pages: state.pages.flatMap((page, index) => page.offset < page.ids.length || !page.exhausted && searchAvailable ? [{ index, ids: page.ids, done: page.ids.slice(0, page.offset), empty: !page.ids.length && (page.cursor !== null || page.seenCursors.length > 0) }] : []),
        nextQuery: state.nextQuery, queryCount: input.queries.length,
        imageId: id => state.importedImages[`${owner.providerId}:${owner.accountIdentity}:${id}`],
        assessments: deps.domain.repository.list('assessment').filter(item => item.runId === ctx.runId), selections: selections(),
      })
      if (index === undefined) return !searchAvailable && state.pages.some(page => !page.exhausted) || state.searchLimited ? 'budget-exhausted' : state.issues.length ? 'partial-failure' : 'source-exhausted'
      const page = state.pages[index]!, query = input.queries[index]!
      if (page.offset >= page.ids.length) {
        try {
          const found = await ctx.request('search', toJson({ query, cursor: page.cursor, providerId: owner.providerId }), signal => source.search({ query, pageSize: ctx.spec.config.limits.pageSize }, page.cursor, { ...requestBounds(ctx.spec.config, ctx), signal, seenCursors: page.seenCursors }), result => toJson({ providerAssetIds: result.items.map(item => item.providerAssetId), nextCursor: result.nextCursor }))
          if (found.nextCursor && (found.nextCursor === page.cursor || page.seenCursors.includes(found.nextCursor))) throw new CuratorError('source-continuation-invalid', 'preview-search', 'The source repeated its preview continuation.')
          if (page.cursor) page.seenCursors.push(page.cursor)
          page.cursor = found.nextCursor; page.ids = found.items.filter(item => !state.seenIds.includes(`${owner.providerId}:${owner.accountIdentity}:${item.providerAssetId}`)).map(item => item.providerAssetId); page.offset = 0; page.exhausted = found.nextCursor === null
          for (const item of found.items) locations.set(item.providerAssetId, item)
          await save()
        } catch (error) {
          if (ctx.signal.aborted || error instanceof CuratorError && ['budget-exhausted', 'storage-commit-failed', 'owner-denied'].includes(error.code)) throw error
          page.exhausted = true; page.ids = []; page.offset = 0; state.failedQueries++
          state.issues.push({ candidateId: query, stage: 'lookup', category: 'technical', code: safeFailure(error).code })
          state.nextQuery = (index + 1) % input.queries.length; await save(); continue
        }
      }
      if (!page.ids[page.offset]) { state.nextQuery = (index + 1) % input.queries.length; await save(); continue }
      const capacity = Math.min(ctx.spec.config.limits.maxConcurrentRequests, input.targetCount - selections().length)
      const candidates: { photoId: string; identity: string }[] = []
      for (const photoId of page.ids.slice(page.offset, page.offset + capacity)) {
        const identity = `${owner.providerId}:${owner.accountIdentity}:${photoId}`
        if (!state.seenIds.includes(identity)) {
          if (state.seenIds.length >= ctx.spec.config.limits.maxCandidates) break
          state.seenIds.push(identity)
        }
        candidates.push({ photoId, identity })
      }
      if (!candidates.length) return 'budget-exhausted'
      const results = await Promise.allSettled(candidates.map(async ({ photoId, identity }) => {
        const excluded = sourceExclusion(exclusions, { ...owner, providerAssetId: photoId })
        if (excluded) { state.excluded![identity] = excluded; return }
        let imageId = state.importedImages[identity]
        try {
          if (!imageId) {
            const item = locations.get(photoId) ?? await ctx.request('search', toJson({ providerAssetId: photoId, operation: 'lookup' }), signal => source.lookup(photoId, { ...requestBounds(ctx.spec.config, ctx), signal }), () => ({ refreshed: true }))
            if (ctx.spec.fixed.wallpaperAuto === true && (item.originalUnavailable || !item.originalUrl)) {
              state.issues.push({ candidateId: photoId, stage: 'download', category: 'unavailable', code: item.originalUnavailable ? 'source-original-restricted' : 'source-original-unavailable' }); await save(); return
            }
            const dimensions = z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).parse(item)
            // Only verified public descriptors enter preview searches; original bytes remain a separate operation.
            const blob = remoteReferenceBlob({ providerId: 'unsplash', photoId, accountId: owner.accountIdentity, url: item.previewUrl, thumbnailUrl: item.thumbnailUrl ?? item.previewUrl })
            const base = { schemaVersion: 1, profileId: actor.profileId, createdAt: new Date().toISOString() }
            const asset = assetSchema.parse({ ...base, id: randomUUID(), kind: 'asset', familyId: `remote-unsplash:${contentDigest(photoId).slice(10)}`, source: { kind: 'provider', providerId: owner.providerId, providerAssetId: photoId, accountIdentity: owner.accountIdentity, description: photoId, obtainedAt: base.createdAt }, access: actor.sessionId ? { kind: 'session-run', sessionId: actor.sessionId } : { kind: 'profile-library' }, exportPermission: 'references-only', groupingStatus: 'unreviewed' })
            const image = imageVersionSchema.parse({ ...base, id: randomUUID(), kind: 'imageVersion', assetId: asset.id, versionKind: 'remote-reference', blob, geometry: { ...dimensions, colorSpace: 'unverified', processorVersion: 'unsplash-url-reference-v1' } })
            imageId = image.id; state.importedImages[identity] = image.id; await save([asset, image])
          }
          const image = deps.domain.authorizedImage(imageId, actor).image
          const previous = deps.domain.repository.list('assessment').find(item => item.runId === ctx.runId && item.imageVersionId === image.id && item.stage === 'final')
          const assessment = previous ?? (await reviewImage({ domain: deps.domain, files: deps.files, vision }, ctx, image, standard, 'final')).assessment
          if (!previous) await save([assessment])
          return { imageId: image.id, assessment }
        } catch (error) {
          if (ctx.signal.aborted || error instanceof CuratorError && ['budget-exhausted', 'storage-commit-failed', 'owner-denied'].includes(error.code)) throw error
          const issue: SearchIssue = { candidateId: photoId, stage: imageId ? 'final' : 'lookup', category: 'technical', code: safeFailure(error).code, ...(imageId ? { imageVersionId: imageId } : {}) }
          state.issues.push(issue)
          if (imageId) await save([assessmentSchema.parse({ schemaVersion: 1, profileId: actor.profileId, id: randomUUID(), createdAt: new Date().toISOString(), kind: 'assessment', imageVersionId: imageId, runId: ctx.runId, stage: 'final', standard: { kind: standard.kind, id: standard.id, contentDigest: standard.contentDigest }, recipeId: standard.recipe.id, reviewBundleId: randomUUID(), technicalStatus: 'failed', ruleResults: [], cropPotential: 'unknown', preferenceScores: {}, data: toJson({ error: safeFailure(error), reviewQueueReasons: ['technical-failure'] }) })])
        }
      }))
      ctx.signal.throwIfAborted()
      const selected = new Set(selections().map(item => item.imageVersionId)), records: CuratorRecord[] = []
      let rank = selected.size
      // Selection ranks follow source order even when model responses complete out of order.
      for (const result of results) {
        if (result.status !== 'fulfilled' || !result.value) continue
        const { assessment, imageId } = result.value
        if (assessment.verdict !== 'pass' || assessment.technicalStatus !== 'completed' || selected.has(imageId)) continue
        selected.add(imageId)
        records.push(selectionSchema.parse({ schemaVersion: 1, profileId: actor.profileId, createdAt: new Date().toISOString(), kind: 'selection', id: `selection-${contentDigest({ runId: ctx.runId, imageId, output: 'preview' }).slice(10, 50)}`, runId: ctx.runId, imageVersionId: imageId, assessmentId: assessment.id, qualification: 'auto-qualified', rank: rank++, warnings: [] }))
      }
      if (records.length) await save(records)
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      // Leave the page offset unchanged until every admitted result settles; replay reuses committed reviews.
      page.offset += candidates.length; state.nextQuery = (index + 1) % input.queries.length; await save()
    }
    return 'target-met'
  }
}
