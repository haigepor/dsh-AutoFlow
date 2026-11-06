/** Cursor search keeps stable source identities; media URLs live only during an attempt. */
import { executionStandard } from './style-execution.ts'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { styleStandardSchema, usageSchema, assessmentSchema, selectionSchema, type Json, type CuratorRecord } from '../shared/model.ts'
import { contentDigest } from '../domain/repository.ts'
import type { CuratorDomain } from '../domain/curator.ts'
import type { AssetFiles, ImageSourceProvider, SourcePage, SourceItem, HttpClient, StructuredVisionProvider } from '../media/index.ts'
import type { CuratorConfig } from './config.ts'
import { dataOf, toJson, safeFailure, type Worker, type WorkContext } from './runtime.ts'
import { requestBounds, sourceIdentity } from './providers.ts'
import { importedRecords } from './imports.ts'
import { reviewImage, runActor } from './review.ts'
import { CuratorError } from '../shared/errors.ts'
import { searchOutputSchema } from '../shared/search-launch.ts'
import { searchIssueSchema, type SearchIssue } from '../shared/search-feedback.ts'
import { createPreviewSearchWorker } from './preview-search-workflow.ts'
import { chooseSearchQuery } from './search-query-plan.ts'
import { searchExclusionsSchema, searchExclusionReasonSchema, sourceExclusion, imageExclusion, exclusionCounts } from './search-exclusions.ts'
import { createScreenedSearchWorker } from './search-screening.ts'
import { planSearch } from './search-planning.ts'

const queryPageFields = { cursor: z.string().nullable(), seenCursors: z.array(z.string()), pageIds: z.array(z.string()), pageDone: z.array(z.string()), nextCursor: z.string().nullable(), pageLoaded: z.boolean(), pageRestrictedIds: z.array(z.string()).default([]) }
const queryRemainderSchema = z.strictObject({ queryIndex: z.number().int().nonnegative(), ...queryPageFields })
const searchStateSchema = z.strictObject({
  queryIndex: z.number().int().nonnegative(), ...queryPageFields,
  seenIds: z.array(z.string()), seenDigests: z.array(z.string()),
  failedQueries: z.number().int().nonnegative(), successfulPages: z.number().int().nonnegative(),
  importedImages: z.record(z.string(), z.string()),
  duplicateIds: z.array(z.string()),
  excluded: z.record(z.string(), searchExclusionReasonSchema).optional(),
  issues: z.array(searchIssueSchema).default([]),
  // Without remainders, the legacy index has already finished all earlier queries.
  queryRemainders: z.array(queryRemainderSchema).optional(),
})
const initialState = { queryIndex: 0, cursor: null, seenCursors: [], seenIds: [], seenDigests: [], pageIds: [], pageDone: [], nextCursor: null, pageLoaded: false, failedQueries: 0, successfulPages: 0, importedImages: {}, duplicateIds: [] }
export interface SearchDependencies {
  domain: CuratorDomain
  files: AssetFiles
  source(config: CuratorConfig): Promise<ImageSourceProvider>
  media(config: CuratorConfig): HttpClient
  vision(config: CuratorConfig): Promise<StructuredVisionProvider>
  crop(ctx: WorkContext, imageVersionIds: string[]): Promise<void>
}

/** @param deps Shared owner services and crop subflow. @returns Search worker using the parent's quotas and snapshots. */
export function createSearchWorker(deps: SearchDependencies): Worker {
  return async ctx => {
    if (ctx.spec.fixed.workflowExecution === true) ctx = await planSearch(ctx, deps.domain, await deps.vision(ctx.spec.config))
    if (ctx.spec.fixed.searchScreening !== undefined) return createScreenedSearchWorker(deps)(ctx)
    const release = executionStandard(styleStandardSchema.parse(ctx.spec.fixed.release), ctx.spec.fixed.executionRecipe)
    const output = ctx.spec.fixed.output === undefined ? undefined : searchOutputSchema.parse(ctx.spec.fixed.output), original = output?.kind === 'original'
    if (output?.kind === 'preview') return createPreviewSearchWorker(deps)(ctx)
    // 未声明输出的新旧任务仍必须携带原有用途，不能隐式切换交付方式。
    if (!original) usageSchema.parse(ctx.spec.fixed.usage)
    const input = z.object({ taskBrief: z.string().min(1), queries: z.array(z.string().min(1).max(4096)).min(1), targetCount: z.number().int().positive() }).parse(ctx.spec.input)
    const source = await deps.source(ctx.spec.config), vision = await deps.vision(ctx.spec.config), media = deps.media(ctx.spec.config), actor = runActor(ctx)
    const sourceOwner = sourceIdentity(ctx.spec.config)
    const checkpoint = dataOf(ctx.current()).checkpoint
    const state = searchStateSchema.parse(checkpoint.search ?? initialState)
    const exclusions = ctx.spec.fixed.searchExclusions === undefined ? undefined : searchExclusionsSchema.parse(ctx.spec.fixed.searchExclusions)
    if (exclusions && !state.excluded) state.excluded = {}
    const emptyPage = () => ({ cursor: null, seenCursors: [], pageIds: [], pageDone: [], nextCursor: null, pageLoaded: false, pageRestrictedIds: [] })
    const remainders = state.queryRemainders ?? input.queries.flatMap((_, queryIndex) => queryIndex > state.queryIndex ? [{ queryIndex, ...emptyPage() }] : [])
    state.queryRemainders = remainders
    const queryIndices = new Set([state.queryIndex])
    for (const remainder of remainders) {
      if (remainder.queryIndex >= input.queries.length || queryIndices.has(remainder.queryIndex)) throw new CuratorError('reference-unavailable', 'retrieving', 'The saved search query positions are invalid.')
      queryIndices.add(remainder.queryIndex)
    }
    const activePage = () => ({ queryIndex: state.queryIndex, cursor: state.cursor, seenCursors: state.seenCursors, pageIds: state.pageIds, pageDone: state.pageDone, nextCursor: state.nextCursor, pageLoaded: state.pageLoaded, pageRestrictedIds: state.pageRestrictedIds })
    const exhausted = (page: z.infer<typeof queryRemainderSchema>) => page.pageLoaded && page.nextCursor === null && page.pageIds.every(id => page.pageDone.includes(id))
    const locations = new Map<string, SourceItem>()
    const warnings = dataOf(ctx.current()).warnings
    const selections = () => deps.domain.repository.list('selection').filter(item => item.runId === ctx.runId && item.qualification === 'auto-qualified')
    const save = async (records: CuratorRecord[] = []) => {
      const current = dataOf(ctx.current())
      await ctx.save('retrieving', { checkpoint: { ...current.checkpoint, search: toJson(state) }, counts: { ...current.counts, candidates: state.seenIds.length, distinct: state.seenDigests.length, qualified: selections().length, failedQueries: state.failedQueries, unavailable: state.issues.filter(issue => issue.category === 'unavailable').length, technicalFailed: state.issues.filter(issue => issue.category === 'technical').length, ...(state.excluded ? exclusionCounts(state.excluded) : {}) }, warnings }, records)
    }
    const qualify = async (imageId: string) => {
      const { image, asset } = deps.domain.authorizedImage(imageId, actor)
      if (original && !asset.originalBlob) throw new CuratorError('reference-unavailable', 'reviewing', 'The verified source original is unavailable.')
      const subject = original ? { ...image, blob: asset.originalBlob! } : image
      const previous = deps.domain.repository.list('assessment').find(a => a.runId === ctx.runId && a.imageVersionId === imageId && a.stage === 'source')
      const sourceAssessment = previous ?? (await reviewImage({ domain: deps.domain, files: deps.files, vision }, ctx, subject, release, 'source')).assessment
      if (!previous) await save([sourceAssessment])
      if (sourceAssessment.technicalStatus !== 'completed' || sourceAssessment.verdict !== 'pass') return
      if (!original) { if (sourceAssessment.cropPotential !== 'infeasible') await deps.crop(ctx, [imageId]); return }
      if (selections().some(selection => selection.imageVersionId === imageId)) return
      await ctx.save('reviewing', {})
      const final = deps.domain.repository.list('assessment').find(a => a.runId === ctx.runId && a.imageVersionId === imageId && a.stage === 'final')
        ?? (await reviewImage({ domain: deps.domain, files: deps.files, vision }, ctx, subject, release, 'final')).assessment
      const records: CuratorRecord[] = [final]
      if (final.technicalStatus === 'completed' && final.verdict === 'pass') records.push(selectionSchema.parse({ schemaVersion: 1, profileId: actor.profileId, id: `selection-${contentDigest({ runId: ctx.runId, imageId, output: 'original' }).slice(10, 50)}`, createdAt: new Date().toISOString(), kind: 'selection', runId: ctx.runId, imageVersionId: imageId, assessmentId: final.id, qualification: 'auto-qualified', rank: selections().length, warnings: [] }))
      await save(records)
    }
    const pageSummary = (page: SourcePage): Json => toJson({ providerAssetIds: page.items.map(item => item.providerAssetId), nextCursor: page.nextCursor })
    while (true) {
      ctx.signal.throwIfAborted()
      if (selections().length >= input.targetCount) return 'target-met'
      const pages = [...(state.queryIndex < input.queries.length ? [activePage()] : []), ...remainders]
      const searchAvailable = ctx.ledger.snapshot().search < ctx.spec.config.limits.maxSearchPages && state.seenIds.length < ctx.spec.config.limits.maxCandidates
      const index = chooseSearchQuery({
        pages: pages.filter(page => !exhausted(page) && (page.pageLoaded && page.pageIds.some(id => !page.pageDone.includes(id)) || searchAvailable))
          .map(page => ({ index: page.queryIndex, ids: page.pageIds, done: page.pageDone, empty: !page.pageIds.length && (page.pageLoaded || page.cursor !== null || page.seenCursors.length > 0) })),
        nextQuery: (state.queryIndex + (state.pageDone.length ? 1 : 0)) % input.queries.length, queryCount: input.queries.length,
        imageId: id => state.importedImages[`${sourceOwner.providerId}:${sourceOwner.accountIdentity}:${id}`],
        assessments: deps.domain.repository.list('assessment').filter(item => item.runId === ctx.runId), selections: selections(),
      })
      if (index === undefined) {
        if (pages.some(page => !exhausted(page))) return 'budget-exhausted'
        break
      }
      if (index !== state.queryIndex) {
        const position = remainders.findIndex(page => page.queryIndex === index), next = remainders.splice(position, 1)[0]!
        if (state.queryIndex < input.queries.length && !exhausted(activePage())) remainders.push(activePage())
        Object.assign(state, next)
        await save()
      }
      const query = input.queries[state.queryIndex]!
      let page: SourcePage
      try {
        if (state.pageLoaded) {
          page = { items: state.pageIds.map(providerAssetId => locations.get(providerAssetId) ?? { providerAssetId, previewUrl: '', ...(state.pageRestrictedIds.includes(providerAssetId) ? { originalUnavailable: 'restricted' as const } : {}) }), nextCursor: state.nextCursor }
        } else {
          page = await ctx.request('search', toJson({ query, cursor: state.cursor, providerId: sourceOwner.providerId }), signal => source.search({ query, pageSize: ctx.spec.config.limits.pageSize }, state.cursor, { ...requestBounds(ctx.spec.config, ctx), signal, seenCursors: state.seenCursors }), pageSummary)
          page = { ...page, items: page.items.filter(item => !state.seenIds.includes(`${sourceOwner.providerId}:${sourceOwner.accountIdentity}:${item.providerAssetId}`)) }
          state.pageLoaded = true; state.pageIds = page.items.map(item => item.providerAssetId); state.pageDone = []; state.nextCursor = page.nextCursor; state.successfulPages++
          state.pageRestrictedIds = page.items.filter(item => item.originalUnavailable === 'restricted').map(item => item.providerAssetId)
          for (const item of page.items) locations.set(item.providerAssetId, item)
          await save()
        }
      } catch (error) {
        if (ctx.signal.aborted || error instanceof CuratorError && ['budget-exhausted', 'storage-commit-failed', 'owner-denied'].includes(error.code)) throw error
        const failure = safeFailure(error)
        state.failedQueries++; warnings.push(`Source query ${state.queryIndex + 1} failed: ${failure.code}.`)
        Object.assign(state, { queryIndex: input.queries.length, ...emptyPage() }); await save(); continue
      }
      for (const item of page.items) {
        ctx.signal.throwIfAborted()
        if (state.pageDone.includes(item.providerAssetId)) continue
        const identity = `${sourceOwner.providerId}:${sourceOwner.accountIdentity}:${item.providerAssetId}`
        const excluded = sourceExclusion(exclusions, { ...sourceOwner, providerAssetId: item.providerAssetId })
        if (excluded) {
          if (!state.seenIds.includes(identity)) {
            if (state.seenIds.length >= ctx.spec.config.limits.maxCandidates) return 'budget-exhausted'
            state.seenIds.push(identity)
          }
          state.excluded![identity] = excluded; state.pageDone.push(item.providerAssetId); await save(); break
        }
        const previouslyImported = state.importedImages[identity]
        if (previouslyImported && !state.duplicateIds.includes(identity)) {
          const { image, asset } = deps.domain.authorizedImage(previouslyImported, actor), excluded = imageExclusion(exclusions, image, asset)
          if (excluded) { state.excluded![identity] = excluded; state.duplicateIds.push(identity) }
          else await qualify(previouslyImported)
        } else if (!state.seenIds.includes(identity)) {
          if (state.seenIds.length >= ctx.spec.config.limits.maxCandidates) return 'budget-exhausted'
          state.seenIds.push(identity)
          let failedStage: SearchIssue['stage'] = 'lookup', unavailable: string | undefined, httpStatus: number | undefined
          try {
            // 未提供原图时保留明确失败，缩略图不能作为可交付的原图。
            let location = item
            if (!location.originalUrl && !location.originalUnavailable && source.config.lookup) location = { ...item, ...await ctx.request('search', toJson({ providerAssetId: item.providerAssetId, operation: 'lookup' }), signal => source.lookup(item.providerAssetId, { ...requestBounds(ctx.spec.config, ctx), signal }), result => ({ refreshed: true, originalAvailable: !!result.originalUrl, ...(result.originalUnavailable ? { originalUnavailable: result.originalUnavailable } : {}) })) }
            if (location.originalUnavailable || !location.originalUrl) {
              unavailable = location.originalUnavailable === 'restricted' ? 'source-original-restricted' : 'source-original-unavailable'
              throw new CuratorError('reference-unavailable', 'download', 'The source did not provide a deliverable original.')
            }
            failedStage = 'download'
            const response = await ctx.request('download', toJson({ providerAssetId: item.providerAssetId }), async signal => {
              const reserved = Math.min(ctx.spec.config.limits.maxImportBytes, ctx.ledger.remainingBytes())
              if (reserved < 1) throw new CuratorError('budget-exhausted', 'download', 'The image byte budget is exhausted.')
              await ctx.ledger.reserve('download', reserved)
              await ctx.save('retrieving', {})
              const result = await media.request(location.originalUrl!, { ...requestBounds(ctx.spec.config, ctx), maxBytes: reserved, signal, method: 'GET', headers: { accept: 'image/jpeg,image/png,image/webp' } })
              ctx.ledger.settleDownload(reserved, result.bytes.length)
              return result
            }, result => ({ status: result.status, byteLength: result.bytes.length }))
            if (response.status < 200 || response.status >= 300) { httpStatus = response.status; throw new CuratorError('reference-unavailable', 'download', 'The original image download returned an unsuccessful status.') }
            failedStage = 'import'
            const imported = await deps.files.importBytes(response.bytes, response.headers['content-type'], ctx.signal)
            const duplicate = state.seenDigests.includes(imported.normalized.blob.digest)
            const created = importedRecords(actor.profileId, actor, imported, { kind: 'provider', providerId: sourceOwner.providerId, providerAssetId: item.providerAssetId, accountIdentity: sourceOwner.accountIdentity, description: item.providerAssetId, obtainedAt: new Date().toISOString() })
            const excluded = imageExclusion(exclusions, created.image, created.asset)
            if (excluded) {
              state.excluded![identity] = excluded; state.duplicateIds.push(identity); state.pageDone.push(item.providerAssetId); await save(); break
            }
            state.importedImages[identity] = created.image.id
            if (duplicate) state.duplicateIds.push(identity)
            else state.seenDigests.push(imported.normalized.blob.digest)
            await save(created.records)
            if (!duplicate) {
              try {
                await ctx.save('screening', {})
                await qualify(created.image.id)
              } catch (error) {
                if (ctx.signal.aborted || error instanceof CuratorError && ['budget-exhausted', 'storage-commit-failed', 'owner-denied'].includes(error.code)) throw error
                const assessment = assessmentSchema.parse({ schemaVersion: 1, profileId: actor.profileId, id: randomUUID(), createdAt: new Date().toISOString(), kind: 'assessment', imageVersionId: created.image.id, runId: ctx.runId, stage: original && ctx.current().stage === 'reviewing' ? 'final' : 'source', releaseId: release.id, recipeId: release.recipe.id, reviewBundleId: randomUUID(), technicalStatus: 'failed', ruleResults: [], cropPotential: 'unknown', preferenceScores: Object.fromEntries(Object.keys(release.recipe.preferenceScale.weights).map(key => [key, 0])), data: toJson({ error: safeFailure(error), reviewQueueReasons: ['technical-failure'] }) })
                state.issues.push({ candidateId: item.providerAssetId, stage: assessment.stage === 'final' ? 'final' : 'source', category: 'technical', code: safeFailure(error).code, imageVersionId: created.image.id })
                await save([assessment]); warnings.push(`Candidate review failed: ${safeFailure(error).code}.`)
              }
            }
          } catch (error) {
            if (ctx.signal.aborted || error instanceof CuratorError && ['budget-exhausted', 'storage-commit-failed', 'owner-denied'].includes(error.code)) throw error
            const code = unavailable ?? (httpStatus ? 'source-download-http' : safeFailure(error).code)
            state.issues.push({ candidateId: item.providerAssetId, stage: failedStage, category: unavailable ? 'unavailable' : 'technical', code, ...(httpStatus ? { httpStatus } : {}) })
            warnings.push(`Candidate ${item.providerAssetId} (${failedStage}): ${code}.`)
          }
        }
        state.pageDone.push(item.providerAssetId); await save()
        if (selections().length >= input.targetCount) return 'target-met'
        break
      }
      if (state.pageIds.every(id => state.pageDone.includes(id))) {
        if (state.nextCursor === null) Object.assign(state, { queryIndex: input.queries.length, ...emptyPage() })
        else { state.cursor = state.nextCursor; state.seenCursors.push(state.nextCursor); state.pageLoaded = false }
        await save()
      }
    }
    if (state.successfulPages === 0 && state.failedQueries > 0) throw new CuratorError('capability-unavailable', 'retrieving', 'All source queries failed. Saved results remain available.')
    const technicalFailure = state.issues.some(issue => issue.category === 'technical') || deps.domain.repository.list('assessment').some(item => item.runId === ctx.runId && item.technicalStatus === 'failed')
    return selections().length >= input.targetCount ? 'target-met' : state.failedQueries > 0 || technicalFailure ? 'partial-failure' : 'source-exhausted'
  }
}
