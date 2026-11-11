/** Replacements use original pixels, the frozen source queries and the same full style review. */
import { z } from 'zod'
import type { CuratorDomain } from '../domain/curator.ts'
import type { AssetFiles, HttpClient, ImageSourceProvider, SourceItem, StructuredVisionProvider, VisionInput } from '../media/index.ts'
import { MediaError } from '../media/index.ts'
import type { CuratorRecord, DomainActor, ImageVersion } from '../shared/model.ts'
import { styleStandardSchema } from '../shared/model.ts'
import type { WallpaperItem, WallpaperState } from '../shared/wallpaper.ts'
import { wallpaperSourceRestricted } from '../shared/wallpaper.ts'
import { CuratorError } from '../shared/errors.ts'
import { dataOf, specOf, toJson, safeFailure, type WorkContext } from './runtime.ts'
import { executionStandard } from './style-execution.ts'
import { reviewImage } from './review.ts'
import { importedRecords } from './imports.ts'
import { sourceIdentity, requestBounds } from './providers.ts'
import { freezeSearchExclusions, searchExclusionsSchema, searchSourceKey } from './search-exclusions.ts'
import { wallpaperVisionInput } from './wallpaper-vision.ts'

const checkpointSchema = z.object({ query: z.number().int().nonnegative(), cursor: z.string().nullable(), pageCursor: z.string().nullable().optional(), viewVersion: z.literal(1).optional(), seenCursors: z.array(z.string()), pending: z.array(z.string()), exhausted: z.boolean(), seen: z.array(z.string()), imported: z.record(z.string(), z.string()), issues: z.array(z.object({ sourceId: z.string(), code: z.string() })) })

/** @param deps Existing task services. @param ctx Owning wallpaper task and shared request budget. @param state Saved image slots. @param actor Original-image reader. @param save Atomic wallpaper checkpoint writer. @returns Qualified replacements; unavailable slots and all successful processing artifacts remain intact. */
export async function recoverWallpaperSources(deps: { domain: CuratorDomain; files: AssetFiles; source: ImageSourceProvider; media: HttpClient; vision(): Promise<StructuredVisionProvider> }, ctx: WorkContext, state: WallpaperState, actor: DomainActor, save: (records?: CuratorRecord[]) => Promise<void>): Promise<WallpaperItem[]> {
  const slots = state.items.filter(wallpaperSourceRestricted)
  if (!slots.length) return []
  const parent = deps.domain.require('run', state.sourceRunId), spec = specOf(parent)
  const planned = z.object({ queries: z.array(z.string().min(1)).min(1) }).safeParse(dataOf(parent).checkpoint.searchPlan)
  const queries = planned.success ? planned.data.queries : z.array(z.string().min(1)).min(1).parse(spec.input.queries)
  const standard = executionStandard(styleStandardSchema.parse(ctx.spec.fixed.release), ctx.spec.fixed.executionRecipe)
  const reviewContext: WorkContext = { ...ctx, spec: { ...ctx.spec, fixed: { ...ctx.spec.fixed, ...(spec.fixed.output ? { output: spec.fixed.output } : {}) } } }
  const frozen = spec.fixed.searchExclusions === undefined ? undefined : searchExclusionsSchema.parse(spec.fixed.searchExclusions)
  const sourceHistory = freezeSearchExclusions(deps.domain, standard, actor, [{ run: parent, actor }], String(spec.input.taskBrief))
  const owner = sourceIdentity(ctx.spec.config), excluded = new Set([...Object.keys(frozen?.sources ?? {}), ...Object.keys(sourceHistory.sources)]), digests = new Set([...Object.keys(frozen?.digests ?? {}), ...Object.keys(sourceHistory.digests)])
  for (const item of state.items) {
    const image = deps.domain.require('imageVersion', item.originalId ?? item.imageVersionId), asset = deps.domain.require('asset', image.assetId)
    if (asset.source.kind === 'provider') excluded.add(searchSourceKey(asset.source))
    if (!image.blob.remoteSource) digests.add(image.blob.digest)
  }
  const saved = dataOf(ctx.current()).checkpoint.wallpaperReplacementSearch ?? ctx.spec.fixed.initialReplacementSearch
  const search = checkpointSchema.parse(saved ?? { query: 0, cursor: null, seenCursors: [], pending: [], exhausted: false, seen: [], imported: {}, issues: [] })
  const persist = async (records: CuratorRecord[] = []) => {
    await ctx.save('retrieving', { checkpoint: { ...dataOf(ctx.current()).checkpoint, wallpaper: toJson(state), wallpaperReplacementSearch: toJson(search) } }, records)
  }
  const replacements: WallpaperItem[] = []
  const locations = new Map<string, SourceItem>()
  if (search.viewVersion === undefined) {
    const oversized = new Set(search.issues.filter(issue => issue.code === 'vision-image-too-large').map(issue => issue.sourceId))
    search.seen = search.seen.filter(id => !oversized.has(id)); search.pending = [...new Set([...oversized, ...search.pending])]; search.viewVersion = 1
    await persist()
  }
  while (slots.length && search.query < queries.length && search.seen.length < ctx.spec.config.limits.maxCandidates) {
    ctx.signal.throwIfAborted()
    if (!search.pending.length) {
      if (search.exhausted) { search.query++; search.cursor = null; search.seenCursors = []; search.exhausted = false; await persist(); continue }
      if (ctx.ledger.snapshot().search >= ctx.spec.config.limits.maxSearchPages) { state.budgetStopped = true; await persist(); break }
      const cursor = search.cursor
      const page = await ctx.request('search', toJson({ operation: 'wallpaper-replacement-search', query: queries[search.query], cursor }), signal => deps.source.search({ query: queries[search.query]!, pageSize: ctx.spec.config.limits.pageSize }, cursor, { ...requestBounds(ctx.spec.config, ctx), signal, seenCursors: search.seenCursors }), page => ({ ids: page.items.map(item => item.providerAssetId), nextCursor: page.nextCursor }))
      if (page.nextCursor && (page.nextCursor === cursor || search.seenCursors.includes(page.nextCursor))) throw new CuratorError('source-continuation-invalid', 'wallpaper-replacement', 'The source repeated a replacement-search page.')
      if (cursor) search.seenCursors.push(cursor)
      search.pageCursor = cursor; search.cursor = page.nextCursor; search.exhausted = page.nextCursor === null; search.pending = page.items.map(item => item.providerAssetId)
      for (const item of page.items) locations.set(item.providerAssetId, item)
      await persist()
      continue
    }
    const sourceId = search.pending[0]!, identity = searchSourceKey({ ...owner, providerAssetId: sourceId })
    if (search.seen.includes(sourceId) || excluded.has(identity)) { search.pending.shift(); await persist(); continue }
    try {
      let image: ImageVersion | undefined = search.imported[sourceId] ? deps.domain.require('imageVersion', search.imported[sourceId]!) : undefined
      if (!image) {
        let location = locations.get(sourceId)
        if (!location || !location.originalUrl && !location.originalUnavailable) {
          if (ctx.ledger.snapshot().search >= ctx.spec.config.limits.maxSearchPages) { state.budgetStopped = true; await persist(); break }
          location = await ctx.request('search', toJson({ operation: 'wallpaper-replacement-lookup', providerAssetId: sourceId }), signal => deps.source.lookup(sourceId, { ...requestBounds(ctx.spec.config, ctx), signal }), value => ({ originalAvailable: !!value.originalUrl, restricted: !!value.originalUnavailable }))
        }
        if (location.originalUnavailable || !location.originalUrl) throw new MediaError('original-source-restricted', 'wallpaper-replacement', false, 'The replacement source has no accessible original.', 'Use another original source.')
        const originalUrl = location.originalUrl
        const bytes = await ctx.request('download', toJson({ operation: 'wallpaper-replacement-download', providerAssetId: sourceId }), async signal => {
          const bound = Math.min(ctx.ledger.remainingBytes(), deps.files.limits.maxFileBytes)
          if (bound <= 0) throw new CuratorError('budget-exhausted', 'wallpaper-replacement', 'The replacement download budget is exhausted.')
          await ctx.ledger.reserve('download', bound)
          const response = await deps.media.request(originalUrl, { ...requestBounds(ctx.spec.config, ctx), method: 'GET', maxBytes: bound, signal })
          ctx.ledger.settleDownload(bound, response.bytes.length)
          if (response.status !== 200) throw new MediaError(`original-download-http-${response.status}`, 'wallpaper-replacement', [408, 425, 429].includes(response.status) || response.status >= 500, 'The replacement original could not be downloaded.', 'Check the original source or network.')
          return response
        }, response => ({ status: response.status, byteLength: response.bytes.length }))
        const imported = await deps.files.importBytes(bytes.bytes, bytes.headers['content-type'], ctx.signal)
        if (digests.has(imported.normalized.blob.digest) || digests.has(imported.originalBlob.digest)) throw new MediaError('replacement-duplicate', 'wallpaper-replacement', false, 'The replacement duplicates an existing source.', 'Use another source.')
        const created = importedRecords(actor.profileId, actor, imported, { kind: 'provider', ...owner, providerAssetId: sourceId, description: sourceId, obtainedAt: new Date().toISOString() })
        image = created.image; search.imported[sourceId] = image.id; await persist(created.records)
      }
      let assessment = deps.domain.repository.list('assessment').find(row => row.runId === ctx.runId && row.imageVersionId === image.id && row.stage === 'final' && row.technicalStatus === 'completed')
      if (!assessment) {
        const vision = await deps.vision()
        const prepareInput = async (input: VisionInput): Promise<VisionInput> => {
          const view = await wallpaperVisionInput({ ...input, images: input.images.filter(image => !!image.bytes) }, deps.files, vision, ctx.spec.config.limits.previewMaxDimension, ctx.signal)
          return { ...view, images: input.images.map(image => view.images.find(view => view.imageVersionId === image.imageVersionId) ?? image) }
        }
        const reviewed = await reviewImage({ domain: deps.domain, files: deps.files, vision, prepareInput }, reviewContext, image, standard, 'final')
        assessment = reviewed.assessment; await persist([assessment])
      }
      if (assessment.verdict === 'pass' && assessment.technicalStatus === 'completed') {
        const old = slots.shift()!, index = state.items.indexOf(old), asset = deps.domain.require('asset', image.assetId)
        const replacement: WallpaperItem = { imageVersionId: image.id, originalId: image.id, familyId: deps.domain.familyOf(asset.familyId), status: 'queued', edits: 0, attempts: [], replacementOf: { imageVersionId: old.imageVersionId, errorCode: old.errorCode!, reason: old.reason ?? old.errorCode! } }
        state.items[index] = replacement; replacements.push(replacement); digests.add(image.blob.digest); excluded.add(identity)
        await save()
      }
    } catch (error) {
      if (ctx.signal.aborted || error instanceof CuratorError && ['storage-commit-failed', 'owner-denied'].includes(error.code)) throw error
      if (safeFailure(error).code === 'budget-exhausted') { state.budgetStopped = true; await persist(); break }
      search.issues.push({ sourceId, code: safeFailure(error).code })
    }
    search.seen.push(sourceId); search.pending.shift(); await persist()
  }
  return replacements
}
