/** Unsplash Web API adapter, derived from the supplied client's read operations and live response probes. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { GalleryCollection, GalleryCollectionId, GalleryPage, GalleryPhoto, GalleryPhotoId, GalleryPhotoScope } from '../shared/gallery.ts'
import type { ImageSourceProvider, SourceItem, SourcePage, SourceQuery } from './source.ts'
import type { RequestBounds } from './network.ts'
import { invalidInput, MediaError } from './errors.ts'

/** All transport requests are read-only and relative to the fixed Unsplash Web API origin. */
export interface UnsplashTransport { request(path: string, params: Readonly<Record<string, string | number>>, bounds: RequestBounds): Promise<unknown> }

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const urls = z.object({ small: z.string(), regular: z.string().optional(), raw: z.string().optional() })
const photoSchema = z.object({ id: identity, width: z.number().int().positive(), height: z.number().int().positive(), urls,
  alt_description: z.string().nullish(), description: z.string().nullish(), premium: z.boolean().optional(), plus: z.boolean().optional(),
  user: z.object({ name: z.string().nullish(), username: identity }).optional() })
const collectionSchema = z.object({ id: identity, title: z.string(), description: z.string().nullish(), private: z.boolean().default(false), total_photos: z.number().int().nonnegative(), cover_photo: z.object({ urls }).nullish() })
const cursorSchema = z.strictObject({ v: z.literal(1), key: z.string(), page: z.number().int().positive(), offset: z.number().int().nonnegative(), digest: z.string().optional(), seen: z.number().int().nonnegative().optional(), priorDigest: z.string().optional() })
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const encode = (value: z.infer<typeof cursorSchema>) => Buffer.from(JSON.stringify(value)).toString('base64url')
const failure = (continuation = false) => new MediaError(continuation ? 'source-continuation-invalid' : 'source-protocol-error', 'gallery', false, continuation ? 'The saved gallery continuation changed; restart this listing.' : 'The gallery returned unsupported image or collection data.', 'Refresh this gallery listing and retry.')

/** @param raw Cookie header or Netscape cookie-file content. @returns A single validated Cookie header; values never appear in failures. */
export function normalizeCookie(raw: string): string {
  const pairs: [string, string][] = []
  if (raw.includes('\t')) {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim() || line.startsWith('#') && !line.startsWith('#HttpOnly_')) continue
      const fields = line.replace(/^#HttpOnly_/, '').split('\t')
      if (fields.length !== 7 || !/^\.?unsplash\.com$/i.test(fields[0]!)) throw invalidInput('Use an Unsplash Cookie header or cookie file.')
      pairs.push([fields[5]!, fields[6]!])
    }
  } else {
    if (/[\r\n\0]/.test(raw)) throw invalidInput('The gallery session contains invalid header characters.')
    for (const part of raw.replace(/^Cookie:\s*/i, '').split(';')) {
      const separator = part.indexOf('=')
      if (separator < 1) { if (part.trim()) throw invalidInput('Use an Unsplash Cookie header or cookie file.'); continue }
      pairs.push([part.slice(0, separator).trim(), part.slice(separator + 1).trim()])
    }
  }
  if (!pairs.length || pairs.some(([name, value]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || !value || /[\x00-\x20\x7f;]/.test(value))) throw invalidInput('The gallery session contains invalid cookies.')
  return [...new Map(pairs)].map(([name, value]) => `${name}=${value}`).join('; ')
}

/** @param raw Public image URL returned by Unsplash. @returns Approved transient location. */
export function unsplashMediaUrl(raw: string): string {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || !['images.unsplash.com', 'plus.unsplash.com'].includes(url.hostname) || url.port || url.username || url.password || url.hash) throw failure()
  return url.href
}

function photoView(raw: unknown): GalleryPhoto {
  const value = photoSchema.parse(raw), premium = value.premium === true || value.plus === true
  const regular = unsplashMediaUrl(value.urls.regular ?? value.urls.small)
  return { id: brandString<GalleryPhotoId>(value.id), title: value.alt_description || value.description || value.id, width: value.width, height: value.height,
    thumbnailUrl: unsplashMediaUrl(value.urls.small), referenceUrl: regular, ...(!premium ? { originalUrl: unsplashMediaUrl(value.urls.raw ?? regular) } : {}),
    pageUrl: `https://unsplash.com/photos/${encodeURIComponent(value.id)}`, photographer: value.user?.name ?? value.user?.username ?? '', photographerUrl: value.user ? `https://unsplash.com/@${encodeURIComponent(value.user.username)}` : 'https://unsplash.com', premium }
}

/** Typed operations share one read transport; no API body or cookie jar is exposed to Client code. */
export class UnsplashApi {
  /** @param transport Host-owned, account-isolated request transport. */
  constructor(private readonly transport: UnsplashTransport) {}

  /** @param bounds One bounded account check. @returns Authenticated identity without email or session fields. */
  async me(bounds: RequestBounds): Promise<{ userId: string; username: string; name: string; totalCollections: number }> {
    const me = z.object({ id: identity, username: identity, name: z.string().nullish(), total_collections: z.number().int().nonnegative() }).parse(await this.transport.request('/me', {}, bounds))
    return { userId: me.id, username: me.username, name: me.name ?? me.username, totalCollections: me.total_collections }
  }

  /** @param username Verified account username. @param cursor Saved page offset. @param pageSize Client page size. @param bounds Request limits. @returns Owned folders, including private folders visible to that account. */
  async collections(username: string, cursor: string | null, pageSize: number, bounds: RequestBounds): Promise<GalleryPage<GalleryCollection>> {
    identity.parse(username)
    return this.page(`/users/${encodeURIComponent(username)}/collections`, {}, cursor, pageSize, bounds, raw => {
      const item = collectionSchema.parse(raw)
      return { id: brandString<GalleryCollectionId>(item.id), title: item.title, description: item.description ?? '', private: item.private, totalPhotos: item.total_photos, ...(item.cover_photo ? { coverUrl: unsplashMediaUrl(item.cover_photo.urls.small) } : {}) }
    })
  }

  /** @param scope Full-site search, ungrouped bookmarks or a named folder. @param cursor Saved page offset. @param pageSize Desired visible items. @param bounds Request limits. @returns Verified photo descriptors with exact continuations. */
  async photos(scope: GalleryPhotoScope, cursor: string | null, pageSize: number, bounds: RequestBounds): Promise<GalleryPage<GalleryPhoto>> {
    if (scope.kind === 'search' && (!scope.query.trim() || scope.query.length > 4096)) throw invalidInput('Enter a bounded image search query.')
    if (scope.kind === 'collection') identity.parse(scope.collectionId)
    const endpoint = scope.kind === 'bookmarks' ? '/me/bookmarks' : scope.kind === 'collection' ? `/collections/${encodeURIComponent(scope.collectionId)}/photos` : '/search/photos'
    return this.page(endpoint, scope.kind === 'search' ? { query: scope.query.trim() } : {}, cursor, pageSize, bounds, photoView)
  }

  /** @param id Stable photo ID. @param bounds Request limits. @returns Fresh media locations with the same identity. */
  async photo(id: string, bounds: RequestBounds): Promise<GalleryPhoto> {
    identity.parse(id)
    const value = photoView(await this.transport.request(`/photos/${encodeURIComponent(id)}`, {}, bounds))
    if (value.id !== id) throw failure()
    return value
  }

  private async page<T extends { id: string }>(endpoint: string, params: Record<string, string | number>, cursor: string | null, pageSize: number, bounds: RequestBounds, parse: (value: unknown) => T): Promise<GalleryPage<T>> {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw invalidInput('The gallery page size is invalid.')
    const key = hash({ endpoint, params, pageSize })
    let saved: z.infer<typeof cursorSchema>
    try { saved = cursor === null ? { v: 1, key, page: 1, offset: 0 } : cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))); if (saved.key !== key) throw failure(true) }
    catch (error) { throw failure(true) }
    const raw = await this.transport.request(endpoint, { ...params, page: saved.page, per_page: Math.min(pageSize, 30) }, bounds)
    const envelope = z.object({ results: z.array(z.unknown()), total: z.number().int().nonnegative().optional(), total_pages: z.number().int().nonnegative().optional() }).parse(Array.isArray(raw) ? { results: raw } : raw)
    if (envelope.results.length > 100) throw failure()
    const all = envelope.results.map(parse), digest = hash(all.map(item => item.id))
    if (new Set(all.map(item => item.id)).size !== all.length || saved.offset > all.length || saved.offset > 0 && saved.digest !== digest || saved.offset === 0 && all.length > 0 && saved.priorDigest === digest) throw failure(true)
    const items = all.slice(saved.offset, saved.offset + pageSize), offset = saved.offset + items.length
    // Web 搜索可能固定返回 20 张；页内偏移保留多出的图片，不能截断后直接翻到下一页。
    const seen = saved.seen ?? (saved.page - 1) * Math.min(pageSize, 30)
    const morePages = envelope.total_pages !== undefined ? saved.page < envelope.total_pages : envelope.total !== undefined ? seen + all.length < envelope.total : all.length >= Math.min(pageSize, 30)
    const nextCursor = offset < all.length ? encode({ ...saved, offset, digest }) : all.length && morePages ? encode({ v: 1, key, page: saved.page + 1, offset: 0, seen: seen + all.length, priorDigest: digest }) : null
    return { items, nextCursor, ...(envelope.total !== undefined ? { total: envelope.total } : {}) }
  }
}

/** Search jobs consume the same Unsplash adapter as the interactive gallery browser. */
export class UnsplashSourceProvider implements ImageSourceProvider {
  readonly config = { lookup: { endpoint: 'https://unsplash.com/napi/photos', method: 'GET' as const, idField: 'id', response: { id: '/id', previewUrl: '/urls/small' } } }
  /** @param api Frozen account-scoped API client. */
  constructor(private readonly api: UnsplashApi) {}
  /** @param query Fixed keywords and size. @param cursor Saved continuation. @param bounds Reserved request limits. @returns Stable candidate identities. */
  async search(query: SourceQuery, cursor: string | null, bounds: RequestBounds & { seenCursors?: readonly string[] }): Promise<SourcePage> {
    if (query.language || query.filter) throw invalidInput('This Unsplash source does not accept custom language or filter expressions.')
    const page = await this.api.photos({ kind: 'search', query: query.query }, cursor, query.pageSize, bounds)
    if (page.nextCursor && (page.nextCursor === cursor || bounds.seenCursors?.includes(page.nextCursor))) throw failure(true)
    return { items: page.items.map(item => this.item(item)), nextCursor: page.nextCursor }
  }
  /** @param id Stable photo identity. @param bounds Request limits. @returns Refreshed original and preview locations. */
  async lookup(id: string, bounds: RequestBounds): Promise<SourceItem> { return this.item(await this.api.photo(id, bounds)) }
  private item(photo: GalleryPhoto): SourceItem { return { providerAssetId: photo.id, previewUrl: photo.thumbnailUrl, ...(photo.originalUrl ? { originalUrl: photo.originalUrl } : {}), ...(photo.premium ? { originalUnavailable: 'restricted' as const } : {}), width: photo.width, height: photo.height } }
}
