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

const stateSchema = z.strictObject({
  nextQuery: z.number().int().nonnegative(),
  pages: z.array(z.strictObject({ cursor: z.string().nullable(), seenCursors: z.array(z.string()), ids: z.array(z.string()), offset: z.number().int().nonnegative(), exhausted: z.boolean() })),
  seenIds: z.array(z.string()), importedImages: z.record(z.string(), z.string()), issues: z.array(searchIssueSchema), failedQueries: z.number().int().nonnegative(), searchLimited: z.boolean().default(false),
})

/** @param deps Existing source, vision, storage and owner services. @returns Resumable URL-only search with one candidate per query turn. */
export function createPreviewSearchWorker(deps: SearchDependencies): Worker {
  return async ctx => {
    if (ctx.spec.config.source.provider !== 'unsplash') throw new CuratorError('capability-unavailable', 'preview-search', 'Preview link searches currently require the Unsplash source.')
    const input = z.object({ queries: z.array(z.string().min(1)).min(1), targetCount: z.number().int().positive() }).parse(ctx.spec.input)
    const standard = executionStandard(styleStandardSchema.parse(ctx.spec.fixed.release), ctx.spec.fixed.executionRecipe)
    const source = await deps.source(ctx.spec.config), vision = await deps.vision(ctx.spec.config), owner = sourceIdentity(ctx.spec.config), actor = runActor(ctx)
    const state = stateSchema.parse(dataOf(ctx.current()).checkpoint.previewSearch ?? { nextQuery: 0, pages: input.queries.map(() => ({ cursor: null, seenCursors: [], ids: [], offset: 0, exhausted: false })), seenIds: [], importedImages: {}, issues: [], failedQueries: 0 })
    if (state.pages.length !== input.queries.length) throw new CuratorError('reference-unavailable', 'preview-search', 'The saved preview query plan changed.')
    const locations = new Map<string, SourceItem>()
    const selections = () => deps.domain.repository.list('selection').filter(item => item.runId === ctx.runId && item.qualification === 'auto-qualified')
    const save = async (records: CuratorRecord[] = []) => {
      const data = dataOf(ctx.current())
      await ctx.save('screening', { checkpoint: { ...data.checkpoint, previewSearch: toJson(state) }, counts: { candidates: state.seenIds.length, distinct: Object.keys(state.importedImages).length, qualified: selections().length, failedQueries: state.failedQueries, technicalFailed: state.issues.filter(issue => issue.category === 'technical').length, unavailable: 0 } }, records)
    }
    while (selections().length < input.targetCount) {
      ctx.signal.throwIfAborted()
      if (state.seenIds.length >= ctx.spec.config.limits.maxCandidates) return 'budget-exhausted'
      const index = input.queries.map((_, offset) => (state.nextQuery + offset) % input.queries.length).find(index => {
        const page = state.pages[index]!
        return page.offset < page.ids.length || !page.exhausted
      })
      if (index === undefined) return state.searchLimited ? 'budget-exhausted' : state.issues.length ? 'partial-failure' : 'source-exhausted'
      const page = state.pages[index]!, query = input.queries[index]!
      if (page.offset >= page.ids.length) {
        if (ctx.ledger.snapshot().search >= ctx.spec.config.limits.maxSearchPages) { page.exhausted = true; state.searchLimited = true; state.nextQuery = (index + 1) % input.queries.length; await save(); continue }
        try {
          const found = await ctx.request('search', toJson({ query, cursor: page.cursor, providerId: owner.providerId }), signal => source.search({ query, pageSize: ctx.spec.config.limits.pageSize }, page.cursor, { ...requestBounds(ctx.spec.config, ctx), signal, seenCursors: page.seenCursors }), result => toJson({ providerAssetIds: result.items.map(item => item.providerAssetId), nextCursor: result.nextCursor }))
          if (found.nextCursor && (found.nextCursor === page.cursor || page.seenCursors.includes(found.nextCursor))) throw new CuratorError('source-continuation-invalid', 'preview-search', 'The source repeated its preview continuation.')
          if (page.cursor) page.seenCursors.push(page.cursor)
          page.cursor = found.nextCursor; page.ids = found.items.map(item => item.providerAssetId); page.offset = 0; page.exhausted = found.nextCursor === null || !found.items.length
          for (const item of found.items) locations.set(item.providerAssetId, item)
          await save()
        } catch (error) {
          if (ctx.signal.aborted || error instanceof CuratorError && ['budget-exhausted', 'storage-commit-failed', 'owner-denied'].includes(error.code)) throw error
          page.exhausted = true; page.ids = []; page.offset = 0; state.failedQueries++
          state.issues.push({ candidateId: query, stage: 'lookup', category: 'technical', code: safeFailure(error).code })
          state.nextQuery = (index + 1) % input.queries.length; await save(); continue
        }
      }
      const photoId = page.ids[page.offset]
      if (!photoId) { state.nextQuery = (index + 1) % input.queries.length; await save(); continue }
      const identity = `${owner.providerId}:${owner.accountIdentity}:${photoId}`
      if (!state.seenIds.includes(identity)) state.seenIds.push(identity)
      let imageId = state.importedImages[identity]
      try {
        if (!imageId) {
          const item = locations.get(photoId) ?? await ctx.request('search', toJson({ providerAssetId: photoId, operation: 'lookup' }), signal => source.lookup(photoId, { ...requestBounds(ctx.spec.config, ctx), signal }), () => ({ refreshed: true }))
          const dimensions = z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).parse(item)
          // 只保存经公开 URL 校验的预览引用；原图权限、下载结果和像素摘要均不冒充已核验。
          const blob = remoteReferenceBlob({ providerId: 'unsplash', photoId, accountId: owner.accountIdentity, url: item.previewUrl, thumbnailUrl: item.previewUrl })
          const base = { schemaVersion: 1, profileId: actor.profileId, createdAt: new Date().toISOString() }
          const asset = assetSchema.parse({ ...base, id: randomUUID(), kind: 'asset', familyId: `remote-unsplash:${contentDigest(photoId).slice(10)}`, source: { kind: 'provider', providerId: owner.providerId, providerAssetId: photoId, accountIdentity: owner.accountIdentity, description: photoId, obtainedAt: base.createdAt }, access: actor.sessionId ? { kind: 'session-run', sessionId: actor.sessionId } : { kind: 'profile-library' }, exportPermission: 'references-only', groupingStatus: 'unreviewed' })
          const image = imageVersionSchema.parse({ ...base, id: randomUUID(), kind: 'imageVersion', assetId: asset.id, versionKind: 'remote-reference', blob, geometry: { ...dimensions, colorSpace: 'unverified', processorVersion: 'unsplash-url-reference-v1' } })
          imageId = image.id; state.importedImages[identity] = image.id; await save([asset, image])
        }
        const image = deps.domain.authorizedImage(imageId, actor).image
        const previous = deps.domain.repository.list('assessment').find(item => item.runId === ctx.runId && item.imageVersionId === image.id && item.stage === 'final')
        const assessment = previous ?? (await reviewImage({ domain: deps.domain, files: deps.files, vision }, ctx, image, standard, 'final')).assessment
        const records: CuratorRecord[] = previous ? [] : [assessment]
        if (assessment.verdict === 'pass' && assessment.technicalStatus === 'completed' && !selections().some(item => item.imageVersionId === image.id)) records.push(selectionSchema.parse({ ...{ schemaVersion: 1, profileId: actor.profileId, createdAt: new Date().toISOString() }, kind: 'selection', id: `selection-${contentDigest({ runId: ctx.runId, imageId: image.id, output: 'preview' }).slice(10, 50)}`, runId: ctx.runId, imageVersionId: image.id, assessmentId: assessment.id, qualification: 'auto-qualified', rank: selections().length, warnings: [] }))
        if (records.length) await save(records)
      } catch (error) {
        if (ctx.signal.aborted || error instanceof CuratorError && ['budget-exhausted', 'storage-commit-failed', 'owner-denied'].includes(error.code)) throw error
        const issue: SearchIssue = { candidateId: photoId, stage: imageId ? 'final' : 'lookup', category: 'technical', code: safeFailure(error).code, ...(imageId ? { imageVersionId: imageId } : {}) }
        state.issues.push(issue)
        if (imageId) await save([assessmentSchema.parse({ schemaVersion: 1, profileId: actor.profileId, id: randomUUID(), createdAt: new Date().toISOString(), kind: 'assessment', imageVersionId: imageId, runId: ctx.runId, stage: 'final', standard: { kind: standard.kind, id: standard.id, contentDigest: standard.contentDigest }, recipeId: standard.recipe.id, reviewBundleId: randomUUID(), technicalStatus: 'failed', ruleResults: [], cropPotential: 'unknown', preferenceScores: {}, data: toJson({ error: safeFailure(error), reviewQueueReasons: ['technical-failure'] }) })])
      }
      // 持久化候选结果后才推进队列；中断恢复会继续同一图片，不遗漏尚未完成的复核。
      page.offset++; state.nextQuery = (index + 1) % input.queries.length; await save()
    }
    return 'target-met'
  }
}
