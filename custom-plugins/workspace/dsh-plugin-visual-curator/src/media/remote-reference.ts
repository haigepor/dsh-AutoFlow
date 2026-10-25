/** URL identities are deliberately separate from verified pixel digests. */
import { createHash } from 'node:crypto'
import { remoteImageSourceSchema, type RemoteImageSource } from '../shared/gallery.ts'
import type { BlobRef } from './assets.ts'
import { invalidInput } from './errors.ts'

/** @param source Public provider descriptor. @returns A versioned descriptor digest, never an image-byte checksum. */
export function remoteReferenceDigest(source: RemoteImageSource): string {
  return 'remote-url-v1:' + createHash('sha256').update(JSON.stringify({ providerId: source.providerId, photoId: source.photoId, accountId: source.accountId, url: source.url, thumbnailUrl: source.thumbnailUrl })).digest('hex')
}

/** @param source Host-verified gallery descriptor. @returns A reference with no local file or claimed byte count. */
export function remoteReferenceBlob(source: RemoteImageSource): BlobRef {
  const remoteSource = remoteImageSourceSchema.parse(source), digest = remoteReferenceDigest(remoteSource)
  return { digest, byteLength: 0, mime: 'image/jpeg', storageRef: `remote-links/${digest.slice(14)}`, remoteSource }
}

/** @param blob Authorized saved descriptor. @returns Validated remote source or absence for byte-backed media. */
export function remoteReferenceSource(blob: BlobRef): RemoteImageSource | undefined {
  if (!blob.remoteSource) return undefined
  const source = remoteImageSourceSchema.parse(blob.remoteSource)
  if (blob.localSource || blob.byteLength !== 0 || blob.digest !== remoteReferenceDigest(source) || blob.storageRef !== `remote-links/${blob.digest.slice(14)}`) throw invalidInput('The remote reference descriptor changed.')
  return source
}
