/** Read an OPPO rating window and attach selected server originals to a collection. */
import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { z } from 'zod'
import type { CuratorDomain } from '../domain/curator.ts'
import { contentDigest } from '../domain/repository.ts'
import { rasterMime, type AssetFiles } from '../media/assets.ts'
import { SafeHttpClient, type HttpClient } from '../media/network.ts'
import { CuratorError } from '../shared/errors.ts'
import { referenceSchema, type DomainActor } from '../shared/model.ts'
import { serverReferenceCredential, serverReferenceImportSchema, type ServerReferenceCatalog, type ServerReferenceImage, type ServerReferenceKey, type ServerReferenceReceipt } from '../shared/server-references.ts'
import type { CuratorConfig } from './config.ts'
import { importedRecords } from './imports.ts'
import { safeFailure } from './runtime.ts'

const apiOrigin = 'https://api.palmmobi.com'
const mediaOrigin = 'https://shengbo-xjp.oss-ap-southeast-1.aliyuncs.com'
const providerId = 'oppo-customer-feedback'
const language = 'en'
const pageSize = 200
const maxPage = 500
const purpose = 'server-reference'
const responseSchema = z.object({ code: z.number().int(), data: z.unknown() })
const pageSchema = z.object({
  language: z.literal(language), start_time: z.string().max(32), end_time: z.string().max(32),
  page: z.number().int().positive(), pageSize: z.literal(pageSize), total: z.number().int().nonnegative(),
  rows: z.array(z.unknown()).max(pageSize),
})
const itemSchema = z.object({
  item_id: z.string().trim().min(1).max(128),
  type_name: z.string().trim().max(128).nullish(),
  img_url: z.string().max(2048).url(),
  grade: z.string().trim().max(32).nullish(),
  avg_score: z.union([z.string().trim().max(32), z.number()]).nullish(),
})
const savedImageSchema = z.object({ imageId: z.string() })
type Item = Omit<ServerReferenceImage, 'previewPath'> & { url: string }
interface RatingSnapshot { sessionId: string | undefined; expiresAt: number; items: Map<ServerReferenceKey, Item> }

/** Keep the remote URL on the Host and bind selection and previews to the reading Session. */
export class ServerReferences {
  private readonly snapshots = new Map<string, RatingSnapshot>()
  private readonly importing = new Set<string>()

  constructor(
    private readonly getDomain: () => CuratorDomain,
    private readonly files: AssetFiles,
    private readonly credentials: Pick<CredentialProvider, 'resolve'>,
    private readonly config: () => CuratorConfig,
    private readonly http: HttpClient = new SafeHttpClient({ allowedOrigins: [apiOrigin, mediaOrigin] }),
  ) {}

  /** @param actor Authenticated workbench reader. @param signal Listing lifetime. @returns Complete groups can be derived from this single rating window. */
  async list(actor: DomainActor, signal: AbortSignal): Promise<ServerReferenceCatalog> {
    const credential = await this.credentials.resolve(credentialRef(serverReferenceCredential))
    if (!credential?.value) throw new CuratorError('configuration-required', purpose, 'Enter the OPPO feedback token to load server images.')
    const limits = this.config().limits
    const linked = AbortSignal.any([signal, AbortSignal.timeout(limits.deadlineMs)])
    const items = new Map<ServerReferenceKey, Item>()
    let window: { total: number; startDate: string; endDate: string } | undefined
    let ignored = 0
    for (let page = 1; !window || (page - 1) * pageSize < window.total; page++) {
      const url = new URL('/Customerfeedback/index.html', apiOrigin)
      url.search = new URLSearchParams({ token: credential.value, language, page: String(page), pageSize: String(pageSize) }).toString()
      const response = await this.http.request(url.href, { method: 'GET', headers: { accept: 'application/json' }, maxBytes: limits.maxResponseBytes, timeoutMs: limits.requestTimeoutMs, maxRedirects: 0, signal: linked })
      const data = this.feedbackPage(response.bytes)
      window ??= { total: data.total, startDate: data.start_time, endDate: data.end_time }
      if (window.total > Math.min(limits.maxGalleryReferenceFiles, pageSize * maxPage)) throw new CuratorError('budget-exhausted', purpose, 'The rating window exceeds the configured gallery browsing limit.')
      if (data.page !== page || data.total !== window.total || data.start_time !== window.startDate || data.end_time !== window.endDate || data.rows.length !== Math.min(pageSize, window.total - (page - 1) * pageSize)) {
        throw new CuratorError('source-protocol-error', purpose, 'The rating window changed during loading. Reload it before selecting images.')
      }
      for (const raw of data.rows) {
        const row = itemSchema.safeParse(raw)
        if (!row.success) { ignored++; continue }
        const value = row.data, image = new URL(value.img_url)
        if (image.origin !== mediaOrigin || image.username || image.password || image.search || image.hash) { ignored++; continue }
        const key = brandString<ServerReferenceKey>(contentDigest({ itemId: value.item_id, url: image.href }).slice(10))
        if (items.has(key)) continue
        const score = value.avg_score === '' || value.avg_score == null ? NaN : Number(value.avg_score)
        items.set(key, { key, url: image.href, itemId: value.item_id, name: value.type_name || value.item_id, grade: value.grade || null, score: Number.isFinite(score) ? score : null })
      }
    }
    linked.throwIfAborted()
    const snapshotId = randomUUID()
    this.snapshots.set(snapshotId, { sessionId: actor.sessionId, expiresAt: Date.now() + limits.sessionGrantTtlMs, items })
    while (this.snapshots.size > Math.max(1, limits.batchCacheMaxViews)) {
      for (const id of this.snapshots.keys()) { this.snapshots.delete(id); break }
    }
    return { snapshotId, startDate: window.startDate, endDate: window.endDate, ignored, items: [...items.values()].map(({ url, ...item }) => ({
      ...item, previewPath: '/api/visual-curator/resource?' + new URLSearchParams({ serverReferenceSnapshot: snapshotId, serverReferenceKey: item.key }),
    })) }
  }

  private feedbackPage(bytes: Buffer) {
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch (error) { throw new CuratorError('source-protocol-error', purpose, 'The feedback service did not return valid JSON.', { cause: error }) }
    const response = responseSchema.safeParse(value)
    if (response.success && [401, 403].includes(response.data.code)) throw new CuratorError('configuration-required', purpose, 'The OPPO feedback token was rejected.')
    const page = response.success && response.data.code === 200 ? pageSchema.safeParse(response.data.data) : undefined
    if (!page?.success) throw new CuratorError('source-protocol-error', purpose, 'The feedback service did not return a usable rating page.')
    return page.data
  }

  private snapshot(id: string, actor: DomainActor): RatingSnapshot {
    const snapshot = this.snapshots.get(id)
    if (!snapshot || snapshot.expiresAt <= Date.now() || snapshot.sessionId !== actor.sessionId) throw new CuratorError('reference-unavailable', purpose, 'Reload the server image listing before using this selection.')
    return snapshot
  }

  /** @param snapshotId Issued catalog identity. @param key Listed image key. @param actor Authenticated catalog reader. @param signal Preview lifetime. @returns Supported raster bytes. */
  async preview(snapshotId: string, key: string, actor: DomainActor, signal: AbortSignal) {
    const image = this.snapshot(snapshotId, actor).items.get(brandString<ServerReferenceKey>(key))
    if (!image) throw new CuratorError('reference-unavailable', purpose, 'This image does not belong to the active server listing.')
    const bytes = await this.readImage(image.url, this.config().limits.maxImportBytes, signal)
    return { bytes, mime: rasterMime(bytes) }
  }

  private async readImage(url: string, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
    const response = await this.http.request(url, { method: 'GET', headers: { accept: 'image/jpeg,image/png,image/webp' }, maxBytes, timeoutMs: this.config().limits.requestTimeoutMs, maxRedirects: 0, signal })
    return response.bytes
  }

  /** @param args Explicit selection and collection revision. @param actor Authenticated workbench writer. @param signal Import lifetime. @returns Confirmed results for each chosen image. */
  async import(args: unknown, actor: DomainActor, signal: AbortSignal): Promise<ServerReferenceReceipt> {
    const input = serverReferenceImportSchema.parse(args), limits = this.config().limits
    if (input.keys.length > limits.maxImportFiles || new Set(input.keys).size !== input.keys.length) throw new CuratorError('invalid-input', purpose, 'Choose a bounded set of distinct server images.')
    const selected = this.snapshot(input.snapshotId, actor).items
    const images = input.keys.map(key => {
      const image = selected.get(key)
      if (!image) throw new CuratorError('reference-unavailable', purpose, 'A selected image is no longer listed.')
      return image
    })
    if (this.importing.has(input.styleId)) throw new CuratorError('constraint-conflict', purpose, 'Wait for the current server image import to finish.')
    const domain = this.getDomain()
    const append = domain.beginReferenceAppend(input.styleId, input.expectedRevision, actor)
    this.importing.add(input.styleId)
    const linked = AbortSignal.any([signal, AbortSignal.timeout(limits.deadlineMs)])
    let revision = input.expectedRevision
    let remainingBytes = limits.maxDownloadBytes
    const results: ServerReferenceReceipt['results'] = []
    try {
      for (const image of images) {
        linked.throwIfAborted()
        try {
          const reference = append.findBySource(providerId, image.key)
          if (reference) {
            const judgment = input.role === 'positive' ? 'accept' : 'reject'
            if (reference.intent.kind !== 'overall' || !domain.referenceJudgments(reference).some(item => item.judgment.kind === 'style-verdict' && item.judgment.value === judgment)) throw new CuratorError('constraint-conflict', purpose, 'This image already has a different reference role.')
            results.push({ key: image.key, status: 'skipped' })
            continue
          }
          const aggregateId = 'server-reference-image:' + image.key
          const saved = domain.repository.manifest(aggregateId)
          let imageId: string
          if (saved) imageId = savedImageSchema.parse(saved.state).imageId
          else {
            if (!remainingBytes) throw new CuratorError('budget-exhausted', purpose, 'The server image import download limit was reached.')
            const bytes = await this.readImage(image.url, Math.min(remainingBytes, limits.maxImportBytes), linked)
            remainingBytes -= bytes.length
            const files = await this.files.importBytes(bytes, undefined, linked)
            const created = importedRecords(actor.profileId, { kind: 'human', id: actor.id, profileId: actor.profileId }, files, {
              kind: 'provider', providerId, providerAssetId: image.key, accountIdentity: apiOrigin,
              description: image.name + ' · ' + image.itemId, obtainedAt: new Date().toISOString(),
            })
            linked.throwIfAborted()
            const receipt = await domain.repository.commit({ aggregateId, expectedRevision: 0, operationId: aggregateId, request: { key: image.key }, records: created.records, state: { imageId: created.image.id } })
            imageId = savedImageSchema.parse(receipt.state).imageId
          }
          const original = domain.authorizedImage(imageId, actor).image
          const operation = input.operationId + ':' + image.key
          const confirmed = z.object({ id: referenceSchema.shape.id }).parse(await domain.action('reference-confirm', { operationId: operation + ':reference', styleId: input.styleId, imageVersionId: original.id, role: input.role, intent: { kind: 'overall' }, context: {}, viewEvidence: [{ imageVersionId: original.id, versionKind: original.versionKind }] }, actor))
          await append.append(confirmed.id, operation + ':draft', revision)
          revision++
          results.push({ key: image.key, status: 'added' })
        } catch (error) {
          linked.throwIfAborted()
          results.push({ key: image.key, status: 'failed', code: safeFailure(error).code })
        }
      }
      return { results }
    } finally { this.importing.delete(input.styleId) }
  }
}
