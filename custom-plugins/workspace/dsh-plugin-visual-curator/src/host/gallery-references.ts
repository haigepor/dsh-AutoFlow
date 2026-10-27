/** Collection references register public links; pixel imports retain their separate implementation. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { CuratorDomain } from '../domain/curator.ts'
import { contentDigest } from '../domain/repository.ts'
import { remoteReferenceBlob } from '../media/remote-reference.ts'
import type { UnsplashApi } from '../media/unsplash.ts'
import type { RequestBounds } from '../media/network.ts'
import type { GalleryPhoto } from '../shared/gallery.ts'
import { assetSchema, imageVersionSchema, type DomainActor, type Json } from '../shared/model.ts'
import { CuratorError } from '../shared/errors.ts'
import type { CuratorConfig } from './config.ts'
import { safeFailure, toJson } from './runtime.ts'

interface Row { name: string; ok: boolean; imageVersionId?: string; referenceId?: string; error?: Json }
interface Active { owner: string; accountId: string; controller: AbortController; phase: 'verifying' | 'referencing' | 'saving'; rows: Row[] }
const owner = (actor: DomainActor) => contentDigest({ profileId: actor.profileId, sessionId: actor.sessionId ?? null })
const transferSchema = z.object({ transferId: z.string().min(1).max(128), accountId: z.string().optional() })
const inputSchema = transferSchema.extend({ operationId: z.string().min(1), styleId: z.string(), expectedRevision: z.number().int().positive(), photoIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)).min(1), role: z.enum(['positive', 'negative', 'undecided']).default('positive') })

/** Caller-owned progress and cancellation never expose credentials or share metadata across accounts. */
export class RemoteGalleryReferences {
  private readonly active = new Map<string, Active>()
  private readonly cancelled = new Map<string, number>()
  private readonly photos = new WeakMap<UnsplashApi, Map<string, { photo: GalleryPhoto; at: number }>>()
  constructor(private readonly config: CuratorConfig, private readonly domain: CuratorDomain, private readonly invalidateIdentity: (api: UnsplashApi) => void) {}

  /** @param api Credential-version-isolated client. @param accountId Verified account or public scope. @param photos Parsed provider page. */
  remember(api: UnsplashApi, accountId: string | undefined, photos: GalleryPhoto[]): void {
    let saved = this.photos.get(api)
    if (!saved) { saved = new Map(); this.photos.set(api, saved) }
    for (const photo of photos) {
      const key = `${accountId ?? 'public'}:${photo.id}`
      saved.delete(key); saved.set(key, { photo, at: Date.now() })
      while (saved.size > this.config.limits.maxGalleryReferenceFiles) saved.delete(saved.keys().next().value!)
    }
  }

  /** @param operation Progress read or explicit cancellation. @param args Transfer and account scope. @param actor Trusted workbench owner. @returns Current registration state without image bytes. */
  control(operation: string, args: Record<string, Json>, actor: DomainActor): Json {
    const { transferId, accountId } = transferSchema.parse(args), work = this.active.get(transferId)
    if (work && (work.owner !== owner(actor) || work.accountId !== (accountId ?? 'public'))) throw new CuratorError('owner-denied', 'gallery-reference', 'This reference operation belongs to another account or Session.')
    const cancellationKey = `${owner(actor)}:${accountId ?? 'public'}:${transferId}`
    if (operation === 'gallery-import-cancel') {
      // 取消可能先于原始 POST 到达；有界标记阻止稍后到达的同次请求继续登记。
      this.cancelled.delete(cancellationKey); this.cancelled.set(cancellationKey, Date.now() + this.config.limits.deadlineMs)
      while (this.cancelled.size > this.config.limits.maxGalleryReferenceFiles) this.cancelled.delete(this.cancelled.keys().next().value!)
    }
    if (!work) return { state: this.cancelled.has(cancellationKey) ? 'cancelled' : 'idle', rows: [] }
    if (operation === 'gallery-import-cancel') work.controller.abort()
    return toJson({ state: work.controller.signal.aborted ? 'cancelling' : 'active', phase: work.phase, rows: work.rows })
  }

  /** @param args Bounded explicit selection. @param api Account-isolated client. @param actor Trusted owner. @param bounds Caller lifetime and network limits. @param verify Account check with independent cancellation. @returns Confirmed per-photo outcomes, including cancelled undispatched items. */
  async import(args: Record<string, Json>, api: UnsplashApi, actor: DomainActor, bounds: RequestBounds, verify: (signal: AbortSignal) => Promise<void>): Promise<Json> {
    const input = inputSchema.parse(args), accountId = input.accountId ?? 'public'
    if (input.photoIds.length > this.config.limits.maxImportFiles || new Set(input.photoIds).size !== input.photoIds.length) throw new CuratorError('invalid-input', 'gallery-reference', 'Select a bounded set of distinct gallery photos.')
    const request = { ...input, mode: 'remote-reference', accountId }, aggregateId = `gallery-reference:${contentDigest({ profileId: actor.profileId, sessionId: actor.sessionId ?? null, operationId: input.operationId })}`
    const prior = this.domain.repository.manifest(aggregateId)
    if (prior) {
      if ((prior.receipts[input.operationId] ?? prior.receipts[`${input.operationId}:prepared`])?.requestDigest !== contentDigest(request)) throw new CuratorError('operation-conflict', 'gallery-reference', 'This operation already describes another selection.')
      await verify(bounds.signal ?? new AbortController().signal)
      if (prior.receipts[input.operationId]) return prior.state
      const prepared = z.object({ results: z.array(z.json()), draftInput: z.json().nullable(), cancelled: z.boolean() }).parse(prior.state)
      if (prepared.draftInput) await this.domain.action('draft-save', prepared.draftInput, actor)
      const state = { results: prepared.results, cancelled: prepared.cancelled }
      await this.domain.repository.commit({ aggregateId, expectedRevision: prior.revision, operationId: input.operationId, request, records: [], state })
      return state
    }
    if (this.active.has(input.transferId)) throw new CuratorError('operation-conflict', 'gallery-reference', 'This transfer is already active.')
    const style = this.domain.require('style', input.styleId), draft = this.domain.require('draft', style.draftId)
    if (style.archived || style.revision !== input.expectedRevision) throw new CuratorError('revision-conflict', 'gallery-reference', 'The image collection changed; refresh before referencing.')
    let expectedRevision = input.expectedRevision
    const work: Active = { owner: owner(actor), accountId, controller: new AbortController(), phase: 'verifying', rows: [] }
    const cancellationKey = `${work.owner}:${accountId}:${input.transferId}`, cancelledUntil = this.cancelled.get(cancellationKey)
    if (cancelledUntil !== undefined && cancelledUntil > Date.now()) work.controller.abort()
    else this.cancelled.delete(cancellationKey)
    this.active.set(input.transferId, work)
    const signal = AbortSignal.any([work.controller.signal, ...(bounds.signal ? [bounds.signal] : [])]), references: string[] = []
    try {
      try { await verify(signal) } catch (error) { if (!signal.aborted) throw error }
      work.phase = 'referencing'
      for (const photoId of input.photoIds) {
        if (signal.aborted) break
        try {
          const fileOp = `${aggregateId}:${photoId}`, imageAggregate = `gallery-url:${fileOp}`, savedImage = this.domain.repository.manifest(imageAggregate)?.state
          let imageId: string
          if (savedImage && typeof savedImage === 'object' && !Array.isArray(savedImage) && typeof savedImage.imageId === 'string') imageId = savedImage.imageId
          else {
            const key = `${accountId}:${photoId}`, cached = this.photos.get(api)?.get(key)
            const photo = cached && Date.now() - cached.at < this.config.source.unsplash.cache.ttlMs ? cached.photo : await api.photo(photoId, { ...bounds, signal })
            signal.throwIfAborted()
            const blob = remoteReferenceBlob({ providerId: 'unsplash', photoId, accountId, url: photo.referenceUrl, thumbnailUrl: photo.thumbnailUrl })
            const base = { schemaVersion: 1, profileId: actor.profileId, createdAt: new Date().toISOString() }
            // Unsplash+ 的公开预览可作为分析引用，品牌标记保留在来源描述中。
            const asset = assetSchema.parse({ ...base, kind: 'asset', id: randomUUID(), familyId: `remote-unsplash:${contentDigest(photoId).slice(10)}`, source: { kind: 'provider', providerId: 'unsplash', providerAssetId: photoId, accountIdentity: accountId, description: `${photo.title} · ${photo.premium ? 'Unsplash+' : 'Unsplash'} / ${photo.photographer}`, obtainedAt: base.createdAt }, access: { kind: 'profile-library' }, exportPermission: 'references-only', groupingStatus: 'unreviewed' })
            const image = imageVersionSchema.parse({ ...base, kind: 'imageVersion', id: randomUUID(), assetId: asset.id, versionKind: 'remote-reference', blob, geometry: { width: photo.width, height: photo.height, colorSpace: 'unverified', processorVersion: 'unsplash-url-reference-v1' } })
            imageId = image.id
            await this.domain.repository.commit({ aggregateId: imageAggregate, expectedRevision: 0, operationId: fileOp, request: { photoId, accountId }, records: [asset, image], state: { imageId } })
          }
          // 已开始的原子提交完成后才响应取消；成功前缀仍会加入当前素材集。
          const image = this.domain.authorizedImage(imageId, actor).image
          this.domain.assertLearningFamily(this.domain.familyOf(this.domain.require('asset', image.assetId).familyId))
          const reference = z.object({ id: z.string() }).parse(await this.domain.action('reference-confirm', { operationId: `${fileOp}:reference`, styleId: style.id, imageVersionId: image.id, role: input.role, intent: { kind: 'overall' }, context: {}, viewEvidence: [{ imageVersionId: image.id, versionKind: image.versionKind }] }, actor))
          // 逐张提交素材集关联后才公布成功，关闭或取消窗口不会丢失已显示的前缀。
          await this.domain.action('draft-save', toJson({ operationId: `${fileOp}:draft`, styleId: style.id, expectedRevision, rules: draft.rules, referenceIds: [...new Set([...draft.referenceIds, ...references, reference.id])], feedbackIds: draft.feedbackIds, conflicts: draft.conflicts }), actor)
          expectedRevision++
          references.push(reference.id); work.rows.push({ name: photoId, ok: true, imageVersionId: image.id, referenceId: reference.id })
        } catch (error) {
          if (signal.aborted) break
          if (error instanceof CuratorError && ['storage-commit-failed', 'revision-conflict'].includes(error.code)) throw error
          if (error && typeof error === 'object' && 'code' in error && ['source-auth-required', 'source-access-denied', 'owner-denied'].includes(String(error.code))) { this.photos.delete(api); this.invalidateIdentity(api) }
          work.rows.push({ name: photoId, ok: false, error: toJson(safeFailure(error)) })
        }
      }
      const cancelled = signal.aborted
      for (const photoId of input.photoIds.slice(work.rows.length)) work.rows.push({ name: photoId, ok: false, error: { code: 'cancelled' } })
      work.phase = 'saving'
      // 保留旧批次回执格式；新引用已逐张写入，不再等待批次结束才保存草稿。
      await this.domain.repository.commit({ aggregateId, expectedRevision: 0, operationId: `${input.operationId}:prepared`, request, records: [], state: toJson({ results: work.rows, draftInput: null, cancelled }) })
      const state = toJson({ results: work.rows, cancelled })
      await this.domain.repository.commit({ aggregateId, expectedRevision: 1, operationId: input.operationId, request, records: [], state })
      return state
    } finally { if (this.active.get(input.transferId) === work) this.active.delete(input.transferId) }
  }

  /** Stop pending registration and let the owning service drain already-admitted commits. */
  dispose(): void { for (const work of this.active.values()) work.controller.abort(); this.cancelled.clear() }
}
