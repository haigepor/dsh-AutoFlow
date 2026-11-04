/** Search pools conserve full reviews while keeping every final decision on actual deep-review pixels. */
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { z } from 'zod'
import { contentDigest } from '../domain/repository.ts'
import { assetSchema, imageVersionSchema, assessmentSchema, selectionSchema, styleStandardSchema, usageSchema, type Assessment, type CuratorRecord, type ImageVersion } from '../shared/model.ts'
import { CuratorError } from '../shared/errors.ts'
import { searchOutputSchema } from '../shared/search-launch.ts'
import { MediaError } from '../media/errors.ts'
import { remoteReferenceBlob } from '../media/remote-reference.ts'
import { decodeVisionScreening, type VisionImage, type VisionInput, type VisionScreening } from '../media/vision.ts'
import type { SourceItem } from '../media/source.ts'
import { searchScreeningPolicySchema } from './config.ts'
import { requestBounds, sourceIdentity, visionBounds } from './providers.ts'
import { dataOf, safeFailure, toJson, type Worker } from './runtime.ts'
import { reviewImage, runActor, styleReviewBrief } from './review.ts'
import { executionStandard } from './style-execution.ts'
import { searchExclusionsSchema, sourceExclusion, imageExclusion, exclusionCounts } from './search-exclusions.ts'
import { importedRecords } from './imports.ts'
import { chooseSearchQuery } from './search-query-plan.ts'
import { searchScreeningCheckpointSchema, searchScreeningState, type SearchScreeningCheckpoint } from './search-screening-state.ts'
import type { SearchDependencies } from './search-workflow.ts'

type Candidate = NonNullable<SearchScreeningCheckpoint['pool']>['candidates'][number]

/** @param deps Existing source, media, model and storage services. @returns A resumable two-stage search; absent policy remains the legacy worker's responsibility. */
export function createScreenedSearchWorker(deps: SearchDependencies): Worker {
  return async ctx => {
    const policy = searchScreeningPolicySchema.parse(ctx.spec.fixed.searchScreening)
    const input = z.object({ taskBrief: z.string().min(1), queries: z.array(z.string().min(1)).min(1), targetCount: z.number().int().positive() }).parse(ctx.spec.input)
    const output = ctx.spec.fixed.output === undefined ? undefined : searchOutputSchema.parse(ctx.spec.fixed.output)
    const preview = output?.kind === 'preview', original = output?.kind === 'original'
    if (!preview && !original) usageSchema.parse(ctx.spec.fixed.usage)
    if (preview && ctx.spec.config.source.provider !== 'unsplash') throw new CuratorError('capability-unavailable', 'preview-search', 'Preview link searches currently require the Unsplash source.')
    const standard = executionStandard(styleStandardSchema.parse(ctx.spec.fixed.release), ctx.spec.fixed.executionRecipe)
    const source = await deps.source(ctx.spec.config), vision = await deps.vision(ctx.spec.config), media = deps.media(ctx.spec.config)
    const actor = runActor(ctx), owner = sourceIdentity(ctx.spec.config)
    const exclusions = ctx.spec.fixed.searchExclusions === undefined ? undefined : searchExclusionsSchema.parse(ctx.spec.fixed.searchExclusions)
    const state = searchScreeningState(ctx.current()) ?? searchScreeningCheckpointSchema.parse({ version: 1, nextQuery: 0, nextPool: 0, pages: input.queries.map(() => ({ cursor: null, pageCursor: null, seenCursors: [], ids: [], exhausted: false })), queryCandidates: input.queries.map(() => []), seenIds: [], candidateCount: 0, seenDigests: [], excluded: {}, screened: {}, fallbacks: {}, importedImages: {}, deepDone: [], deepReviewed: 0, failedQueries: 0, sourceLimited: false, issues: [] })
    if (state.pages.length !== input.queries.length || state.queryCandidates.length !== input.queries.length || state.pool?.candidates.some(item => item.queryIndex >= input.queries.length)) throw new CuratorError('reference-unavailable', 'screening', 'The saved candidate pool does not match its query plan.')
    const locations = new Map<string, SourceItem>()
    const selections = () => deps.domain.repository.list('selection').filter(item => item.runId === ctx.runId && item.qualification === 'auto-qualified')
    let saving = Promise.resolve()
    const save = (records: CuratorRecord[] = [], stage: 'retrieving' | 'screening' | 'reviewing' = 'screening'): Promise<void> => {
      const pending = saving.then(async () => {
        const data = dataOf(ctx.current())
        state.deepReviewed = new Set([...deps.domain.repository.list('assessment'), ...records.filter((record): record is Assessment => record.kind === 'assessment')].filter(item => item.runId === ctx.runId && item.technicalStatus === 'completed').map(item => item.imageVersionId)).size
        const newSelections = records.flatMap(record => record.kind === 'selection' && record.runId === ctx.runId && record.qualification === 'auto-qualified' ? [record.imageVersionId] : [])
        const qualified = new Set([...selections().map(record => record.imageVersionId), ...newSelections]).size
        const counts = { ...data.counts, candidates: state.seenIds.length, distinct: state.candidateCount, qualified,
          screeningReviewed: Object.keys(state.screened).length, screeningRejected: Object.values(state.screened).filter(item => item.decision === 'obvious-reject').length,
          screeningFallback: Object.keys(state.fallbacks).length, deepReviewed: state.deepReviewed, failedQueries: state.failedQueries,
          technicalFailed: state.issues.filter(issue => issue.category === 'technical').length, unavailable: state.issues.filter(issue => issue.category === 'unavailable').length, ...exclusionCounts(state.excluded) }
        await ctx.save(stage, { checkpoint: { ...data.checkpoint, searchScreening: toJson(state) }, counts }, records)
      })
      saving = pending.catch(error => { void error /* Only restore queue admission; the original pending promise still rejects its caller. */ })
      return pending
    }
    const fatal = (error: unknown) => ctx.signal.aborted || ['budget-exhausted', 'storage-commit-failed', 'owner-denied', 'reference-unavailable'].includes(safeFailure(error).code)
    const locate = async (candidate: Candidate): Promise<SourceItem> => {
      const cached = locations.get(candidate.providerAssetId)
      if (cached) return cached
      const bounds = requestBounds(ctx.spec.config, ctx)
      const found = source.config.lookup
        ? await ctx.request('search', toJson({ operation: 'lookup', providerAssetId: candidate.providerAssetId }), signal => source.lookup(candidate.providerAssetId, { ...bounds, signal }), () => ({ refreshed: true }))
        : await ctx.request('search', toJson({ operation: 'restore-screening-page', query: input.queries[candidate.queryIndex], cursor: candidate.pageCursor }), async signal => {
          const page = await source.search({ query: input.queries[candidate.queryIndex]!, pageSize: ctx.spec.config.limits.pageSize }, candidate.pageCursor, { ...bounds, signal })
          for (const item of page.items) locations.set(item.providerAssetId, item)
          const item = page.items.find(item => item.providerAssetId === candidate.providerAssetId)
          if (!item) throw new MediaError('source-item-unavailable', 'lookup', false, 'A saved source candidate is unavailable.', 'Continue with the remaining candidates.')
          return item
        }, () => ({ refreshed: true }))
      if (found.providerAssetId !== candidate.providerAssetId) throw new MediaError('source-protocol-error', 'lookup', false, 'The source lookup returned another image.', 'Check the source lookup mapping.')
      locations.set(found.providerAssetId, found)
      return found
    }
    const download = async (candidate: Candidate, location: string, purpose: 'screening-preview' | 'source-original') => ctx.request('download', toJson({ operation: purpose, providerAssetId: candidate.providerAssetId }), async signal => {
      const reserved = Math.min(purpose === 'screening-preview' ? ctx.spec.config.limits.maxReferenceBytes : ctx.spec.config.limits.maxImportBytes, ctx.ledger.remainingBytes())
      if (reserved <= 0) throw new CuratorError('budget-exhausted', 'download', 'The image byte budget is exhausted.')
      await ctx.ledger.reserve('download', reserved); await save([], 'retrieving')
      const response = await media.request(location, { ...requestBounds(ctx.spec.config, ctx), signal, method: 'GET', maxBytes: reserved, headers: { accept: 'image/jpeg,image/png,image/webp' } })
      ctx.ledger.settleDownload(reserved, response.bytes.byteLength)
      if (response.status < 200 || response.status >= 300) throw new MediaError('source-download-http', 'download', response.status === 429 || response.status >= 500, 'A source image could not be downloaded.', 'Continue within the saved retry budget.')
      return response
    }, response => ({ status: response.status, byteLength: response.bytes.byteLength }))
    const screeningId = (id: string) => `screening-${contentDigest({ runId: ctx.runId, ...owner, providerAssetId: id }).slice(10, 50)}`
    const screen = async (candidates: Candidate[], sequence: number): Promise<VisionScreening> => {
      const ids = candidates.map(item => screeningId(item.providerAssetId))
      const taskBrief = styleReviewBrief(standard, input.taskBrief)
      const rules = standard.rules.filter(rule => rule.check.kind === 'visual')
      const requestId = `screen-${contentDigest({ runId: ctx.runId, sequence, ids, standard: standard.contentDigest, taskBrief, rules, policy, promptVersion: 'visual-curator-screening-v1' }).slice(10, 50)}`
      const saved = deps.domain.repository.list('request').find(request => {
        if (request.runId !== ctx.runId || request.state !== 'committed') return false
        return z.object({ bundle: z.object({ requestId: z.literal(requestId), operation: z.literal('screen') }) }).safeParse(request.data).success
      })
      if (saved) {
        const stored = z.object({ bundle: z.json(), output: z.json() }).parse(saved.data)
        if (contentDigest(stored.bundle) !== saved.requestDigest) throw new CuratorError('reference-unavailable', 'screening', 'The committed screening response does not match its request.')
        return decodeVisionScreening(stored.output, ids)
      }
      const images: VisionImage[] = []
      for (const candidate of candidates) {
        ctx.signal.throwIfAborted()
        const item = await locate(candidate), response = await download(candidate, item.thumbnailUrl ?? item.previewUrl, 'screening-preview')
        const image = sharp(response.bytes, { limitInputPixels: ctx.spec.config.limits.maxPixels, animated: true })
        const metadata = await image.metadata()
        if (metadata.pages !== undefined && metadata.pages !== 1 || !['jpeg', 'png', 'webp'].includes(metadata.format ?? '')) throw new MediaError('invalid-input', 'screening', false, 'A screening preview is not a supported static image.', 'Use a supported image source.')
        const bytes = await image.autoOrient().resize({ width: policy.maxScreeningImageEdge, height: policy.maxScreeningImageEdge, fit: 'inside', withoutEnlargement: true }).toColourspace('srgb').png().toBuffer()
        ctx.signal.throwIfAborted()
        const stored = await deps.files.importBytes(bytes, 'image/png', ctx.signal)
        images.push({ imageVersionId: screeningId(candidate.providerAssetId), digest: stored.originalBlob.digest, mime: 'image/png', role: 'screening-candidate', bytes, storedImage: { storageRef: stored.originalBlob.storageRef, byteLength: stored.originalBlob.byteLength } })
      }
      const bundleInput: VisionInput = { requestId, taskBrief, rules, images }
      const bundle = toJson(vision.describeRequest(bundleInput, 'screen'))
      return ctx.request('vision', bundle, (signal, recordMetadata) => vision.screen(bundleInput, visionBounds(ctx.spec.config, ctx, signal, recordMetadata)))
    }
    const fillPool = async () => {
      if (!state.pool) { state.pool = { sequence: state.nextPool++, candidates: [], filled: false }; await save([], 'retrieving') }
      const pool = state.pool
      const latestReviews = new Map<string, Assessment>()
      for (const assessment of deps.domain.repository.list('assessment')) {
        if (assessment.runId === ctx.runId && (assessment.stage === 'final' || !latestReviews.has(assessment.imageVersionId))) latestReviews.set(assessment.imageVersionId, assessment)
      }
      const assessments = [...latestReviews.values()].filter(item => item.technicalStatus === 'completed' && item.verdict !== 'needs-review')
      const reviewedImages = new Set(assessments.map(item => item.imageVersionId)), qualified = selections()
      while (pool.candidates.length < policy.candidatePoolSize) {
        ctx.signal.throwIfAborted()
        const canSearch = ctx.ledger.snapshot().search < ctx.spec.config.limits.maxSearchPages
        const index = chooseSearchQuery({ pages: state.pages.flatMap((page, index) => page.ids.length || !page.exhausted && canSearch ? [{ index, ids: [...new Set([...state.queryCandidates[index]!, ...page.ids])], done: state.queryCandidates[index]!.filter(id => state.screened[id]?.decision === 'obvious-reject' || reviewedImages.has(state.importedImages[id] ?? '')), empty: !page.ids.length && page.seenCursors.length > 0 }] : []), nextQuery: state.nextQuery, queryCount: input.queries.length, imageId: id => state.importedImages[id], assessments, selections: qualified })
        if (index === undefined) { if (state.pages.some(page => !page.exhausted)) state.sourceLimited = true; break }
        const page = state.pages[index]!
        if (!page.ids.length) {
          try {
            const cursor = page.cursor
            const found = await ctx.request('search', toJson({ query: input.queries[index], cursor, providerId: owner.providerId }), signal => source.search({ query: input.queries[index]!, pageSize: ctx.spec.config.limits.pageSize }, cursor, { ...requestBounds(ctx.spec.config, ctx), signal, seenCursors: page.seenCursors }), result => ({ providerAssetIds: result.items.map(item => item.providerAssetId), nextCursor: result.nextCursor }))
            if (found.nextCursor && (found.nextCursor === cursor || page.seenCursors.includes(found.nextCursor))) throw new MediaError('source-continuation-invalid', 'retrieving', false, 'The source repeated its continuation.', 'Start a new search after checking the source.')
            if (cursor) page.seenCursors.push(cursor)
            page.pageCursor = cursor; page.cursor = found.nextCursor; page.exhausted = found.nextCursor === null
            page.ids = found.items.map(item => item.providerAssetId)
            for (const item of found.items) locations.set(item.providerAssetId, item)
            // Persist the returned page identities and next cursor before consuming any candidate.
            await save([], 'retrieving')
          } catch (error) {
            if (fatal(error)) throw error
            page.exhausted = true; page.ids = []; state.failedQueries++
            state.issues.push({ candidateId: input.queries[index]!, stage: 'lookup', category: 'technical', code: safeFailure(error).code })
            state.nextQuery = (index + 1) % input.queries.length; await save([], 'retrieving'); continue
          }
        }
        const id = page.ids[0]
        if (id === undefined) { state.nextQuery = (index + 1) % input.queries.length; continue }
        if (!state.seenIds.includes(id)) {
          if (state.seenIds.length >= ctx.spec.config.limits.maxCandidates) { state.sourceLimited = true; break }
          state.seenIds.push(id)
          const excluded = sourceExclusion(exclusions, { ...owner, providerAssetId: id })
          const location = locations.get(id)
          if (excluded) state.excluded[id] = excluded
          else if (!preview && location && (location.originalUnavailable || !location.originalUrl && !source.config.lookup)) {
            state.issues.push({ candidateId: id, stage: 'download', category: 'unavailable', code: location.originalUnavailable ? 'source-original-restricted' : 'source-original-unavailable' })
          } else { pool.candidates.push({ providerAssetId: id, queryIndex: index, pageCursor: page.pageCursor }); state.queryCandidates[index]!.push(id); state.candidateCount++ }
        }
        page.ids.shift(); state.nextQuery = (index + 1) % input.queries.length
        await save([], 'retrieving')
      }
      pool.filled = true; await save()
    }
    const importCandidate = async (candidate: Candidate): Promise<ImageVersion | undefined> => {
      const existing = state.importedImages[candidate.providerAssetId]
      if (existing) return deps.domain.authorizedImage(existing, actor).image
      let item = await locate(candidate)
      if (preview) {
        const dimensions = z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).parse(item)
        const base = { schemaVersion: 1, profileId: actor.profileId, createdAt: new Date().toISOString() }
        const asset = assetSchema.parse({ ...base, id: randomUUID(), kind: 'asset', familyId: `remote-unsplash:${contentDigest(candidate.providerAssetId).slice(10)}`, source: { kind: 'provider', ...owner, providerAssetId: candidate.providerAssetId, description: candidate.providerAssetId, obtainedAt: base.createdAt }, access: actor.sessionId ? { kind: 'session-run', sessionId: actor.sessionId } : { kind: 'profile-library' }, exportPermission: 'references-only', groupingStatus: 'unreviewed' })
        const image = imageVersionSchema.parse({ ...base, id: randomUUID(), kind: 'imageVersion', assetId: asset.id, versionKind: 'remote-reference', blob: remoteReferenceBlob({ providerId: 'unsplash', photoId: candidate.providerAssetId, accountId: owner.accountIdentity, url: item.previewUrl, thumbnailUrl: item.thumbnailUrl ?? item.previewUrl }), geometry: { ...dimensions, colorSpace: 'unverified', processorVersion: 'unsplash-url-reference-v1' } })
        state.importedImages[candidate.providerAssetId] = image.id; await save([asset, image], 'reviewing')
        return image
      }
      if (!item.originalUrl && !item.originalUnavailable && source.config.lookup) {
        locations.delete(candidate.providerAssetId); item = await locate(candidate)
      }
      if (!item.originalUrl || item.originalUnavailable) {
        state.issues.push({ candidateId: candidate.providerAssetId, stage: 'download', category: 'unavailable', code: item.originalUnavailable ? 'source-original-restricted' : 'source-original-unavailable' })
        return undefined
      }
      const response = await download(candidate, item.originalUrl, 'source-original')
      const imported = await deps.files.importBytes(response.bytes, response.headers['content-type'], ctx.signal)
      const created = importedRecords(actor.profileId, actor, imported, { kind: 'provider', ...owner, providerAssetId: candidate.providerAssetId, description: candidate.providerAssetId, obtainedAt: new Date().toISOString() })
      const excluded = imageExclusion(exclusions, created.image, created.asset)
      if (excluded) { state.excluded[candidate.providerAssetId] = excluded; return undefined }
      if (state.seenDigests.includes(created.image.blob.digest)) return undefined
      state.seenDigests.push(created.image.blob.digest); state.importedImages[candidate.providerAssetId] = created.image.id
      await save(created.records, 'reviewing')
      return created.image
    }
    const deepReview = async (candidate: Candidate): Promise<{ image: ImageVersion; assessment: Assessment } | undefined> => {
      let image: ImageVersion | undefined
      try {
        image = await importCandidate(candidate)
        if (!image) return undefined
        const asset = deps.domain.authorizedImage(image.id, actor).asset
        const subject = original ? { ...image, blob: asset.originalBlob! } : image
        if (!preview) {
          const prior = deps.domain.repository.list('assessment').find(item => item.runId === ctx.runId && item.imageVersionId === image!.id && item.stage === 'source')
          const sourceReview = prior ?? (await reviewImage({ ...deps, vision }, ctx, subject, standard, 'source')).assessment
          if (!prior) await save([sourceReview], 'reviewing')
          if (sourceReview.technicalStatus !== 'completed' || sourceReview.verdict !== 'pass') return undefined
          if (!original) { if (sourceReview.cropPotential !== 'infeasible') await deps.crop(ctx, [image.id]); return undefined }
        }
        const prior = deps.domain.repository.list('assessment').find(item => item.runId === ctx.runId && item.imageVersionId === image!.id && item.stage === 'final')
        const assessment = prior ?? (await reviewImage({ ...deps, vision }, ctx, subject, standard, 'final')).assessment
        if (!prior) await save([assessment], 'reviewing')
        return { image, assessment }
      } catch (error) {
        if (fatal(error)) throw error
        const failure = safeFailure(error)
        state.issues.push({ candidateId: candidate.providerAssetId, stage: image ? 'final' : 'import', category: 'technical', code: failure.code, ...(image ? { imageVersionId: image.id } : {}) })
        if (image) await save([assessmentSchema.parse({ schemaVersion: 1, profileId: actor.profileId, id: randomUUID(), createdAt: new Date().toISOString(), kind: 'assessment', imageVersionId: image.id, runId: ctx.runId, stage: 'final', standard: { kind: standard.kind, id: standard.id, contentDigest: standard.contentDigest }, recipeId: standard.recipe.id, reviewBundleId: randomUUID(), technicalStatus: 'failed', ruleResults: [], cropPotential: 'unknown', preferenceScores: {}, data: toJson({ error: failure, reviewQueueReasons: ['technical-failure'] }) })], 'reviewing')
        return undefined
      }
    }
    await save([], 'retrieving')
    while (selections().length < input.targetCount) {
      ctx.signal.throwIfAborted()
      if (!state.pool?.filled) await fillPool()
      const pool = state.pool!
      if (!pool.candidates.length) return state.sourceLimited ? 'budget-exhausted' : state.issues.some(issue => issue.category === 'technical') ? 'partial-failure' : 'source-exhausted'
      const batchSize = Math.min(policy.batchSize, vision.config.supportsMultiImage ? vision.config.maxImages : 1)
      const batches: Candidate[][] = []
      for (let offset = 0; offset < pool.candidates.length; offset += batchSize) {
        const batch = pool.candidates.slice(offset, offset + batchSize).filter(item => !state.screened[item.providerAssetId] && !state.fallbacks[item.providerAssetId])
        if (batch.length) batches.push(batch)
      }
      let nextBatch = 0, stopScreening = false
      const screening = await Promise.allSettled(Array.from({ length: Math.min(ctx.spec.config.limits.maxConcurrentRequests, batches.length) }, async () => {
        while (!stopScreening && nextBatch < batches.length) {
          const batch = batches[nextBatch++]!
          try {
            const result = await screen(batch, pool.sequence)
            for (let index = 0; index < batch.length; index++) {
              const item = result.items[index]!
              state.screened[batch[index]!.providerAssetId] = { decision: item.decision, reason: item.reason }
            }
          } catch (error) {
            if (fatal(error)) { stopScreening = true; throw error }
            for (const candidate of batch) state.fallbacks[candidate.providerAssetId] = safeFailure(error).code
          }
          await save()
        }
      }))
      const failedScreen = screening.find(result => result.status === 'rejected')
      if (failedScreen?.status === 'rejected') throw failedScreen.reason
      const pending = pool.candidates.filter(item => !state.deepDone.includes(item.providerAssetId) && state.screened[item.providerAssetId]?.decision !== 'obvious-reject')
      while (pending.length && selections().length < input.targetCount) {
        const capacity = preview || original ? Math.min(ctx.spec.config.limits.maxConcurrentRequests, input.targetCount - selections().length) : 1
        const admitted = pending.splice(0, capacity)
        const results = await Promise.allSettled(admitted.map(deepReview))
        ctx.signal.throwIfAborted()
        const selected = new Set(selections().map(item => item.imageVersionId)), records: CuratorRecord[] = []
        let rank = selected.size
        for (let index = 0; index < results.length; index++) {
          const result = results[index]!
          if (result.status !== 'fulfilled') continue
          state.deepDone.push(admitted[index]!.providerAssetId)
          const value = result.value
          if (!value || value.assessment.technicalStatus !== 'completed' || value.assessment.verdict !== 'pass' || selected.has(value.image.id)) continue
          selected.add(value.image.id)
          records.push(selectionSchema.parse({ schemaVersion: 1, profileId: actor.profileId, id: `selection-${contentDigest({ runId: ctx.runId, imageId: value.image.id, output: preview ? 'preview' : 'original' }).slice(10, 50)}`, createdAt: new Date().toISOString(), kind: 'selection', runId: ctx.runId, imageVersionId: value.image.id, assessmentId: value.assessment.id, qualification: 'auto-qualified', rank: rank++, warnings: [] }))
        }
        await save(records, 'reviewing')
        const failed = results.find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      }
      if (selections().length >= input.targetCount) return 'target-met'
      for (const candidate of pool.candidates) locations.delete(candidate.providerAssetId)
      delete state.pool; await save()
      if (state.sourceLimited) return 'budget-exhausted'
    }
    return 'target-met'
  }
}
