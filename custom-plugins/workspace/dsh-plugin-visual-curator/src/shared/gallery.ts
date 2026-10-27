/** Gallery account configuration contains references to credentials, never session material. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

export type GalleryAccountId = Branded<'VisualCurator.GalleryAccountId'>
export type GalleryPhotoId = Branded<'VisualCurator.GalleryPhotoId'>
export type GalleryCollectionId = Branded<'VisualCurator.GalleryCollectionId'>
export const galleryAccountIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).transform(value => brandString<GalleryAccountId>(value))
export const galleryAccountSchema = z.strictObject({
  id: galleryAccountIdSchema, label: z.string().trim().min(1).max(80),
  credentialRef: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  userId: z.string().min(1).max(128), username: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), name: z.string().max(200),
})
export type GalleryAccount = z.infer<typeof galleryAccountSchema>

/** Host-owned sign-in status contains no Cookie, browser profile or password. */
export interface GalleryLoginView {
  id: string
  state: 'opening' | 'waiting' | 'validating' | 'retrying' | 'retry-paused' | 'ready' | 'saving' | 'saved' | 'cancelled' | 'failed'
  account?: GalleryAccount
  errorCode?: string
  validation?: { attempt: number; limit: number; elapsedMs: number; curlExitCode?: number | null }
}

/** Public display fields exclude private collection share keys and account session values. */
export interface GalleryCollection {
  id: GalleryCollectionId; title: string; description: string; private: boolean; totalPhotos: number; coverUrl?: string; coverPath?: string
}
/** Provider previews may become explicit URL references; only byte imports claim verified pixels. */
export interface GalleryPhoto {
  id: GalleryPhotoId; title: string; width: number; height: number; thumbnailUrl: string; referenceUrl: string
  originalUrl?: string; pageUrl: string; photographer: string; photographerUrl: string; premium: boolean
  /** Authenticated Host display paths; original provider URLs remain available for registration. */
  thumbnailPath?: string; previewPath?: string
}
/** @param url Unsigned public provider media URL. @returns Stable path through the authenticated, origin-limited Host resource reader. */
export function galleryPreviewPath(url: string): string { return `/api/visual-curator/resource?galleryUrl=${encodeURIComponent(url)}` }
/** A continuation pins provider page identity and the offset within a server-sized page. */
export interface GalleryPage<T> { items: T[]; nextCursor: string | null; total?: number }
/** Bookmarks are distinct from named collection folders. Search defaults to all Unsplash photos. */
export type GalleryPhotoScope = { kind: 'bookmarks' } | { kind: 'collection'; collectionId: string } | { kind: 'search'; query: string }

/** Public Unsplash media locations never include account credentials or arbitrary origins. */
export const galleryMediaUrlSchema = z.string().url().refine(value => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && ['images.unsplash.com', 'plus.unsplash.com'].includes(url.hostname) && !url.port && !url.username && !url.password && !url.hash && ![...url.searchParams.keys()].some(key => /token|secret|signature|authorization|cookie/i.test(key))
  } catch (error) { return false }
}, 'Use an unsigned public Unsplash media URL.')
/** A remote reference pins a descriptor, not a checksum of unobserved image bytes. */
export const remoteImageSourceSchema = z.strictObject({ providerId: z.literal('unsplash'), photoId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), accountId: z.string().min(1).max(128), url: galleryMediaUrlSchema, thumbnailUrl: galleryMediaUrlSchema })
export type RemoteImageSource = z.infer<typeof remoteImageSourceSchema>
