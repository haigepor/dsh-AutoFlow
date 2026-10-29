/** Cursor search keeps stable source identities; media URLs live only during an attempt. */
import { executionStandard } from './style-execution.ts'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { styleStandardSchema, usageSchema, assessmentSchema, selectionSchema, type Json, type CuratorRecord } from '../shared/model.ts'
import { contentDigest } from '../domain/repository.ts'
import type { CuratorDomain } from '../domain/curator.ts'
import type { AssetFiles, ImageSourceProvider, SourcePage, HttpClient, StructuredVisionProvider } from '../media/index.ts'
import type { CuratorConfig } from './config.ts'
import { dataOf, toJson, safeFailure, type Worker, type WorkContext } from './runtime.ts'
import { requestBounds, sourceIdentity } from './providers.ts'
import { importedRecords } from './imports.ts'
import { reviewImage, runActor } from './review.ts'
import { CuratorError } from '../shared/errors.ts'
import { searchOutputSchema } from '../shared/search-launch.ts'

const searchStateSchema = z.strictObject({
  queryIndex: z.number().int().nonnegative(), cursor: z.string().nullable(), seenCursors: z.array(z.string()),
  seenIds: z.array(z.string()), seenDigests: z.array(z.string()), pageIds: z.array(z.string()), pageDone: z.array(z.string()),
  nextCursor: z.string().nullable(), pageLoaded: z.boolean(), failedQueries: z.number().int().nonnegative(), successfulPages: z.number().int().nonnegative(),
  importedImages: z.record(z.string(), z.string()),
  duplicateIds: z.array(z.string()),
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
    const release = executionStandard(styleStandardSchema.parse(ctx.spec.fixed.release), ctx.spec.fixed.executionRecipe)
    const output = ctx.spec.fixed.output === undefined ? undefined : searchOutputSchema.parse(ctx.spec.fixed.output), original = output?.kind === 'original'
    // 未声明输出的新旧任务仍必须携带原有用途，不能隐式切换交付方式。
    if (!original) usageSchema.parse(ctx.spec.fixed.usage)
    const input = z.object({ taskBrief: z.string().min(1), queries: z.array(z.string().min(1).max(4096)).min(1), targetCount: z.number().int().positive() }).parse(ctx.spec.input)
    const source = await deps.source(ctx.spec.config), vision = await deps.vision(ctx.spec.config), media = deps.media(ctx.spec.config), actor = runActor(ctx)
    const sourceOwner = sourceIdentity(ctx.spec.config)
    const checkpoint = dataOf(ctx.current()).checkpoint
    const state = searchStateSchema.parse(checkpoint.search ?? initialState)
    const warnings = dataOf(ctx.current()).warnings
    const selections = () => deps.domain.repository.list('selection').filter(item => item.runId === ctx.runId && item.qualification === 'auto-qualified')
    const save = async (records: CuratorRecord[] = []) => {
      const current = dataOf(ctx.current())
      await ctx.save('retrieving', { checkpoint: { ...current.checkpoint, search: toJson(state) }, counts: { ...current.counts, candidates: state.seenIds.length, distinct: state.seenDigests.length, qualified: selections().length, failedQueries: state.failedQueries }, warnings }, records)
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
    while (state.queryIndex < input.queries.length) {
      ctx.signal.throwIfAborted()
      if (selections().length >= input.targetCount) return 'target-met'
      if (state.seenIds.length >= ctx.spec.config.limits.maxCandidates && !state.pageLoaded) return 'budget-exhausted'
      const query = input.queries[state.queryIndex]!
      let page: SourcePage
      try {
        if (state.pageLoaded) {
          page = { items: state.pageIds.map(providerAssetId => ({ providerAssetId, previewUrl: '' })), nextCursor: state.nextCursor }
        } else {
          page = await ctx.request('search', toJson({ query, cursor: state.cursor, providerId: sourceOwner.providerId }), signal => source.search({ query, pageSize: ctx.spec.config.limits.pageSize }, state.cursor, { ...requestBounds(ctx.spec.config, ctx), signal, seenCursors: state.seenCursors }), pageSummary)
          state.pageLoaded = true; state.pageIds = page.items.map(item => item.providerAssetId); state.pageDone = []; state.nextCursor = page.nextCursor; state.successfulPages++
          await save()
        }
      } catch (error) {
        if (ctx.signal.aborted || error instanceof CuratorError && error.code === 'budget-exhausted') throw error
        const failure = safeFailure(error)
        state.failedQueries++; warnings.push(`Source query ${state.queryIndex + 1} failed: ${failure.code}.`)
        state.queryIndex++; state.cursor = null; state.seenCursors = []; state.pageLoaded = false; await save(); continue
      }
      for (const item of page.items) {
        ctx.signal.throwIfAborted()
        if (state.pageDone.includes(item.providerAssetId)) continue
        const identity = `${sourceOwner.providerId}:${sourceOwner.accountIdentity}:${item.providerAssetId}`
        const previouslyImported = state.importedImages[identity]
        if (previouslyImported && !state.duplicateIds.includes(identity)) {
          await qualify(previouslyImported)
        } else if (!state.seenIds.includes(identity)) {
          if (state.seenIds.length >= ctx.spec.config.limits.maxCandidates) return 'budget-exhausted'
          state.seenIds.push(identity)
          try {
            // 未提供原图时保留明确失败，缩略图不能作为可交付的原图。
            let location = item
            if (!location.originalUrl && source.config.lookup) location = { ...item, ...await ctx.request('search', toJson({ providerAssetId: item.providerAssetId, operation: 'lookup' }), signal => source.lookup(item.providerAssetId, { ...requestBounds(ctx.spec.config, ctx), signal }), () => ({ refreshed: true })) }
            if (!location.originalUrl) throw new CuratorError('reference-unavailable', 'download', 'The source did not provide an original image.')
            const response = await ctx.request('download', toJson({ providerAssetId: item.providerAssetId }), async signal => {
              const reserved = Math.min(ctx.spec.config.limits.maxImportBytes, ctx.ledger.remainingBytes())
              if (reserved < 1) throw new CuratorError('budget-exhausted', 'download', 'The image byte budget is exhausted.')
              await ctx.ledger.reserve('download', reserved)
              await ctx.save('retrieving', {})
              const result = await media.request(location.originalUrl!, { ...requestBounds(ctx.spec.config, ctx), maxBytes: reserved, signal, method: 'GET', headers: { accept: 'image/jpeg,image/png,image/webp' } })
              ctx.ledger.settleDownload(reserved, result.bytes.length)
              return result
            }, result => ({ status: result.status, byteLength: result.bytes.length }))
            if (response.status < 200 || response.status >= 300) throw new CuratorError('reference-unavailable', 'download', 'The original image is unavailable.')
            const imported = await deps.files.importBytes(response.bytes, response.headers['content-type'], ctx.signal)
            const duplicate = state.seenDigests.includes(imported.normalized.blob.digest)
            const created = importedRecords(actor.profileId, actor, imported, { kind: 'provider', providerId: sourceOwner.providerId, providerAssetId: item.providerAssetId, accountIdentity: sourceOwner.accountIdentity, description: item.providerAssetId, obtainedAt: new Date().toISOString() })
            state.importedImages[identity] = created.image.id
            if (duplicate) state.duplicateIds.push(identity)
            else state.seenDigests.push(imported.normalized.blob.digest)
            await save(created.records)
            if (!duplicate) {
              try {
                await ctx.save('screening', {})
                await qualify(created.image.id)
              } catch (error) {
                if (ctx.signal.aborted || error instanceof CuratorError && error.code === 'budget-exhausted') throw error
                const assessment = assessmentSchema.parse({ schemaVersion: 1, profileId: actor.profileId, id: randomUUID(), createdAt: new Date().toISOString(), kind: 'assessment', imageVersionId: created.image.id, runId: ctx.runId, stage: original && ctx.current().stage === 'reviewing' ? 'final' : 'source', releaseId: release.id, recipeId: release.recipe.id, reviewBundleId: randomUUID(), technicalStatus: 'failed', ruleResults: [], cropPotential: 'unknown', preferenceScores: Object.fromEntries(Object.keys(release.recipe.preferenceScale.weights).map(key => [key, 0])), data: toJson({ error: safeFailure(error), reviewQueueReasons: ['technical-failure'] }) })
                await save([assessment]); warnings.push(`Candidate review failed: ${safeFailure(error).code}.`)
              }
            }
          } catch (error) {
            if (ctx.signal.aborted || error instanceof CuratorError && error.code === 'budget-exhausted') throw error
            warnings.push(`Candidate ${item.providerAssetId}: ${safeFailure(error).code}.`)
          }
        }
        state.pageDone.push(item.providerAssetId); await save()
        if (selections().length >= input.targetCount) return 'target-met'
      }
      if (state.nextCursor === null) { state.queryIndex++; state.cursor = null; state.seenCursors = [] }
      else { state.cursor = state.nextCursor; state.seenCursors.push(state.nextCursor) }
      state.pageLoaded = false; state.pageIds = []; state.pageDone = []; state.nextCursor = null; await save()
    }
    if (state.successfulPages === 0 && state.failedQueries > 0) throw new CuratorError('capability-unavailable', 'retrieving', 'All source queries failed. Saved results remain available.')
    return selections().length >= input.targetCount ? 'target-met' : state.failedQueries > 0 ? 'partial-failure' : 'source-exhausted'
  }
}
