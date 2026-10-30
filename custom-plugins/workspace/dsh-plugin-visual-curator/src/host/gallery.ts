/** Human gallery browsing and selected-photo imports share the production source adapter. */
import { z } from 'zod'
import type { CuratorDomain } from '../domain/curator.ts'
import { contentDigest } from '../domain/repository.ts'
import type { AssetFiles, HttpClient, RequestBounds } from '../media/index.ts'
import type { UnsplashApi } from '../media/unsplash.ts'
import { galleryAccountIdSchema, galleryPreviewPath } from '../shared/gallery.ts'
import { jsonSchema, type DomainActor, type Json } from '../shared/model.ts'
import { CuratorError } from '../shared/errors.ts'
import type { CuratorConfig } from './config.ts'
import { importedRecords } from './imports.ts'
import { safeFailure, toJson } from './runtime.ts'
import { GalleryIdentityVerifier } from './gallery-identity.ts'
import { RemoteGalleryReferences } from './gallery-references.ts'
import { importedGalleryReference } from './reference-state.ts'

const photoScope = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('search'), query: z.string().trim().min(1).max(4096) }), z.strictObject({ kind: z.literal('bookmarks') }), z.strictObject({ kind: z.literal('collection'), collectionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) })])
const listingSchema = z.object({ accountId: galleryAccountIdSchema.optional(), cursor: z.string().max(8192).nullable().default(null), pageSize: z.number().int().positive().max(100).optional(), refreshIdentity: z.boolean().optional() })
type ApiFactory = (config: CuratorConfig, accountId?: string, provisionalRef?: string, provisionalCookie?: string) => Promise<UnsplashApi>

/** No gallery operation sends a remote mutation or exposes the account secret to the browser. */
export class GalleryService {
  private readonly identities: GalleryIdentityVerifier
  private readonly remote: RemoteGalleryReferences
  private readonly importingStyles = new Set<string>()
  /** @param config Validated profile settings. @param domain Authorized record owner. @param files Private pixel storage. @param api Account-isolated API factory. @param media Approved image transport. */
  constructor(private readonly config: CuratorConfig, private readonly domain: CuratorDomain, private readonly files: AssetFiles, private readonly api: ApiFactory, private readonly media: HttpClient) {
    this.identities = new GalleryIdentityVerifier(config.source.unsplash.identityCacheTtlMs)
    this.remote = new RemoteGalleryReferences(config, domain, api => this.identities.invalidate(api))
  }

  /** @param operation Human workbench operation. @param args Wire parameters; unsaved sessions are consumed only by connection validation. @param actor Authenticated owner. @param signal Caller and plugin lifetime. @returns Safe gallery data or a committed import receipt. */
  async action(operation: string, args: Record<string, Json>, actor: DomainActor, signal: AbortSignal): Promise<Json> {
    if (actor.kind !== 'human') throw new CuratorError('owner-denied', 'gallery', 'Gallery account management requires the authenticated workbench.')
    if (operation === 'gallery-import-progress' || operation === 'gallery-import-cancel') return this.remote.control(operation, args, actor)
    const bounds: RequestBounds = { maxBytes: this.config.limits.maxResponseBytes, timeoutMs: this.config.limits.requestTimeoutMs, maxRedirects: this.config.limits.maxRedirects, signal: AbortSignal.any([signal, AbortSignal.timeout(operation === 'gallery-import' ? this.config.limits.deadlineMs : this.config.limits.requestTimeoutMs)]) }
    if (operation === 'gallery-validate') {
      const { credentialRef, cookie } = z.object({ credentialRef: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), cookie: z.string().min(1).max(this.config.limits.maxClientRequestBytes).optional() }).parse(args)
      return toJson(await (await this.api(this.config, undefined, credentialRef, cookie)).me(bounds))
    }
    const listing = listingSchema.parse(args), api = await this.api(this.config, listing.accountId)
    try {
    if (operation === 'gallery-collections') {
      const me = await this.verifyAccount(api, listing.accountId, bounds, listing.refreshIdentity)
      const page = await api.collections(me.username, listing.cursor, listing.pageSize ?? this.config.limits.pageSize, bounds)
      return toJson({ account: me, ...page, items: page.items.map(folder => ({ ...folder, ...(folder.coverUrl && this.config.source.unsplash.previewTransport === 'host' ? { coverPath: galleryPreviewPath(folder.coverUrl) } : {}) })) })
    }
    if (operation === 'gallery-photos') {
      const { scope } = z.object({ scope: photoScope }).parse(args)
      if (scope.kind !== 'search') await this.verifyAccount(api, listing.accountId, bounds, listing.refreshIdentity)
      const page = await api.photos(scope, listing.cursor, listing.pageSize ?? this.config.limits.pageSize, bounds)
      // 注册缓存保留原始 CDN 描述，展示路径不能进入引用记录或导出资料。
      this.remote.remember(api, listing.accountId, page.items)
      return toJson({ ...page, items: page.items.map(photo => ({ ...photo, ...(this.config.source.unsplash.previewTransport === 'host' ? { thumbnailPath: galleryPreviewPath(photo.thumbnailUrl), previewPath: galleryPreviewPath(photo.referenceUrl) } : {}) })) })
    }
    if (operation === 'gallery-import') {
      const mode = z.enum(['with-bytes', 'remote-reference']).default('with-bytes').parse(args.mode)
      const { styleId } = z.object({ styleId: z.string() }).parse(args)
      // 两种引入方式共用素材集锁；并行请求不能在关联提交前各自创建同一图片。
      if (this.importingStyles.has(styleId)) throw new CuratorError('constraint-conflict', 'gallery-import', 'An import into this collection is already active; wait before retrying.')
      this.importingStyles.add(styleId)
      try {
      if (mode === 'remote-reference') return await this.remote.import(args, api, actor, bounds, async signal => { if (listing.accountId) await this.verifyAccount(api, listing.accountId, { ...bounds, signal }) })
      if (listing.accountId) await this.verifyAccount(api, listing.accountId, bounds, true)
      return await this.import(args, actor, api, listing.accountId, bounds)
      } finally { this.importingStyles.delete(styleId) }
    }
    throw new CuratorError('invalid-input', 'gallery', 'The gallery operation is unavailable.')
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && ['source-auth-required', 'source-access-denied', 'owner-denied'].includes(String(error.code))) this.identities.invalidate(api)
      throw error
    }
  }

  private async verifyAccount(api: UnsplashApi, id: string | undefined, bounds: RequestBounds, forceFresh = false) {
    const saved = this.config.source.unsplash.accounts.find(item => item.id === id)
    if (!saved) throw new CuratorError('configuration-required', 'gallery', 'Select a connected gallery account.')
    return await this.identities.verify(api, saved, bounds, { forceFresh })
  }

  /** Stop remote registration and drain shared identity checks before provider disposal. */
  async dispose(): Promise<void> { this.remote.dispose(); await this.identities.dispose() }

  /** @param args Transfer and account identity. @param actor Authenticated owner. @returns Current in-memory batch progress without network access. */
  referenceProgress(args: Record<string, Json>, actor: DomainActor): Json { return this.remote.control('gallery-import-progress', args, actor) }

  private async import(args: Record<string, Json>, actor: DomainActor, api: UnsplashApi, selectedAccount: string | undefined, bounds: RequestBounds): Promise<Json> {
    const accountId = selectedAccount ?? 'public'
    const input = z.object({ operationId: z.string().min(1), styleId: z.string(), expectedRevision: z.number().int().positive(), photoIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)).min(1), role: z.enum(['positive', 'negative', 'undecided']).default('positive') }).parse(args)
    if (input.photoIds.length > this.config.limits.maxImportFiles || new Set(input.photoIds).size !== input.photoIds.length) throw new CuratorError('invalid-input', 'gallery-import', 'Select a bounded set of distinct gallery photos.')
    const request = { ...input, accountId }, aggregateId = `gallery-import:${contentDigest({ profileId: actor.profileId, sessionId: actor.sessionId ?? null, operationId: input.operationId })}`, prior = this.domain.repository.manifest(aggregateId)
    if (prior) {
      if ((prior.receipts[input.operationId] ?? prior.receipts[`${input.operationId}:prepared`])?.requestDigest !== contentDigest(request)) throw new CuratorError('operation-conflict', 'gallery-import', 'This import identity already describes a different selection.')
      if (prior.receipts[input.operationId]) return prior.state
      const prepared = z.object({ results: z.array(jsonSchema), draftInput: jsonSchema.nullable() }).parse(prior.state)
      if (prepared.draftInput) await this.domain.action('draft-save', prepared.draftInput, actor)
      const state = { results: prepared.results }
      await this.domain.repository.commit({ aggregateId, expectedRevision: prior.revision, operationId: input.operationId, request, records: [], state })
      return state
    }
    const style = this.domain.require('style', input.styleId), draft = this.domain.require('draft', style.draftId)
    if (style.revision !== input.expectedRevision) throw new CuratorError('revision-conflict', 'gallery-import', 'The image collection changed; refresh before importing.')
    const results: Json[] = [], references: string[] = []
    let downloaded = 0
    for (const photoId of input.photoIds) {
      bounds.signal?.throwIfAborted()
      try {
        const existing = importedGalleryReference(this.domain, style.id, photoId, actor)
        if (existing) { results.push({ name: photoId, ok: true, skipped: 'already-imported', imageVersionId: existing.imageVersionId, referenceId: existing.id }); continue }
        const fileOp = `${aggregateId}:${photoId}`, imageAggregate = `gallery-image:${fileOp}`, saved = this.domain.repository.manifest(imageAggregate)?.state
        let imageId: string
        if (saved && typeof saved === 'object' && !Array.isArray(saved) && typeof saved.imageId === 'string') imageId = saved.imageId
        else {
          const photo = await api.photo(photoId, bounds)
          const maxBytes = Math.min(this.config.limits.maxImportBytes, this.config.limits.maxDownloadBytes - downloaded)
          if (maxBytes < 1) throw new CuratorError('budget-exhausted', 'gallery-import', 'The gallery import byte budget is exhausted.')
          const response = await this.media.request(photo.referenceUrl, { ...bounds, maxBytes, method: 'GET', headers: { accept: 'image/jpeg,image/png,image/webp' } })
          downloaded += response.bytes.length
          if (response.status < 200 || response.status >= 300) throw new CuratorError('reference-unavailable', 'gallery-import', 'The selected gallery image is unavailable.')
          const files = await this.files.importBytes(response.bytes, response.headers['content-type'], bounds.signal)
          const created = importedRecords(actor.profileId, actor, files, { kind: 'provider', providerId: 'unsplash', providerAssetId: photoId, accountIdentity: accountId, description: `${photo.title} · Unsplash / ${photo.photographer}`, obtainedAt: new Date().toISOString() })
          imageId = created.image.id
          await this.domain.repository.commit({ aggregateId: imageAggregate, expectedRevision: 0, operationId: fileOp, request: { photoId, accountId }, records: created.records, state: { imageId } })
        }
        const image = this.domain.authorizedImage(imageId, actor).image
        this.domain.assertLearningFamily(this.domain.familyOf(this.domain.require('asset', image.assetId).familyId))
        const reference = await this.domain.action('reference-confirm', { operationId: `${fileOp}:reference`, styleId: style.id, imageVersionId: image.id, role: input.role, intent: { kind: 'overall' }, context: {}, viewEvidence: [{ imageVersionId: image.id, versionKind: image.versionKind }] }, actor)
        const referenceId = z.object({ id: z.string() }).parse(reference).id
        references.push(referenceId); results.push({ name: photoId, ok: true, imageVersionId: image.id, referenceId })
      } catch (error) { bounds.signal?.throwIfAborted(); results.push({ name: photoId, ok: false, error: toJson(safeFailure(error)) }) }
    }
    const draftInput = references.length ? toJson({ operationId: `${aggregateId}:draft`, styleId: style.id, expectedRevision: input.expectedRevision, rules: draft.rules, referenceIds: [...new Set([...draft.referenceIds, ...references])], feedbackIds: draft.feedbackIds, conflicts: draft.conflicts }) : null
    await this.domain.repository.commit({ aggregateId, expectedRevision: 0, operationId: `${input.operationId}:prepared`, request, records: [], state: { results, draftInput } })
    if (draftInput) await this.domain.action('draft-save', draftInput, actor)
    const state = { results }
    await this.domain.repository.commit({ aggregateId, expectedRevision: 1, operationId: input.operationId, request, records: [], state })
    return state
  }
}
