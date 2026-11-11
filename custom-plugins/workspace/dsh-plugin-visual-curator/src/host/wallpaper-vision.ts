/** Persist bounded, reproducible model views while retaining full-size pixels for wallpaper rendering. */
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import type { AssetFiles, StructuredVisionProvider, VisionImage, VisionInput } from '../media/index.ts'
import { MediaError } from '../media/index.ts'
import type { BlobRef } from '../media/assets.ts'

/** Prepare all wallpaper review inputs under the existing vision and preview limits.
 * @param input Canonical image identities, verified source pixels and frozen task instructions.
 * @param files Private content-addressed file owner.
 * @param provider Selected route and its image limits.
 * @param maxDimension Preview dimension frozen in the owning task.
 * @param signal Task cancellation.
 * @param persistDetail Registers each derived view under its original asset before it can reach the model.
 * @returns Request containing saved model-view bytes and explicit original-to-view geometry.
 */
export async function wallpaperVisionInput(input: VisionInput, files: AssetFiles, provider: StructuredVisionProvider, maxDimension: number, signal: AbortSignal, persistDetail?: (sourceId: string, blob: BlobRef, geometry: { width: number; height: number }, rect: { x: number; y: number; width: number; height: number }) => Promise<string>): Promise<VisionInput> {
  const images: VisionImage[] = [], representations = []
  let totalBytes = 0
  for (const image of input.images) {
    signal.throwIfAborted()
    if (!image.bytes || createHash('sha256').update(image.bytes).digest('hex') !== image.digest) throw new MediaError('vision-image-digest-mismatch', 'wallpaper-vision', false, 'The wallpaper source does not match its saved digest.', 'Restore the saved source before continuing.')
    const source = sharp(image.bytes, { limitInputPixels: files.limits.maxPixels }), geometry = await source.metadata()
    const view = await source.resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true }).webp({ lossless: true }).toBuffer({ resolveWithObject: true })
    totalBytes += view.data.length
    if (view.data.length > provider.config.maxImageBytes || totalBytes > provider.config.maxImageBytes) throw new MediaError('vision-image-too-large', 'wallpaper-vision', false, 'The saved wallpaper model views exceed the configured vision byte limit.', 'Reduce previewMaxDimension or increase the route image limit before starting a new task.')
    const stored = await files.importBytes(view.data, 'image/webp', signal)
    images.push({ imageVersionId: image.imageVersionId, role: image.role, bytes: view.data, mime: stored.originalBlob.mime, digest: stored.originalBlob.digest, storedImage: { storageRef: stored.originalBlob.storageRef, byteLength: stored.originalBlob.byteLength } })
    representations.push({ imageVersionId: image.imageVersionId, sourceDigest: image.digest, sourceWidth: geometry.width, sourceHeight: geometry.height, viewWidth: view.info.width, viewHeight: view.info.height, encoding: 'image/webp', processorVersion: `${files.processorVersion}/wallpaper-model-view-v1` })
  }
  for (const detail of input.detailRegions ?? []) {
    signal.throwIfAborted()
    if (!persistDetail || images.length >= provider.config.maxImages) throw new MediaError('vision-detail-unavailable', 'wallpaper-vision', false, 'The required subject detail view cannot fit this vision route.', 'Use a route with enough image slots for the original, final and subject detail views.')
    const source = input.images.find(image => image.imageVersionId === detail.imageVersionId)
    if (!source?.bytes) throw new MediaError('vision-detail-unavailable', 'wallpaper-vision', false, 'The subject detail view has no verified local source.', 'Restore the saved full-size source before review.')
    const metadata = await sharp(source.bytes, { limitInputPixels: files.limits.maxPixels }).metadata()
    const width = metadata.width!, height = metadata.height!, left = Math.floor(detail.rect.x * width), top = Math.floor(detail.rect.y * height)
    const crop = { left, top, width: Math.min(width, Math.ceil((detail.rect.x + detail.rect.width) * width)) - left, height: Math.min(height, Math.ceil((detail.rect.y + detail.rect.height) * height)) - top }
    const view = await sharp(source.bytes, { limitInputPixels: files.limits.maxPixels }).extract(crop).resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true }).webp({ lossless: true }).toBuffer({ resolveWithObject: true })
    totalBytes += view.data.length
    if (totalBytes > provider.config.maxImageBytes) throw new MediaError('vision-image-too-large', 'wallpaper-vision', false, 'The subject detail views exceed the frozen vision byte limit.', 'Reduce previewMaxDimension or use a larger image-byte limit in a new task.')
    const stored = await files.importBytes(view.data, 'image/webp', signal)
    const sourceRect = { x: crop.left / width, y: crop.top / height, width: crop.width / width, height: crop.height / height }
    const imageVersionId = await persistDetail(source.imageVersionId, stored.originalBlob, { width: view.info.width, height: view.info.height }, sourceRect)
    images.push({ imageVersionId, role: `${source.role}-detail-only`, bytes: view.data, mime: 'image/webp', digest: stored.originalBlob.digest, storedImage: { storageRef: stored.originalBlob.storageRef, byteLength: stored.originalBlob.byteLength } })
    representations.push({ imageVersionId, sourceImageVersionId: source.imageVersionId, sourceDigest: source.digest, sourceWidth: width, sourceHeight: height, sourceRect, viewWidth: view.info.width, viewHeight: view.info.height, encoding: 'image/webp', processorVersion: `${files.processorVersion}/wallpaper-detail-view-v1` })
  }
  signal.throwIfAborted()
  const usage = typeof input.usage === 'object' && input.usage !== null && !Array.isArray(input.usage) ? input.usage : { context: input.usage }
  return { ...input, images, usage: { ...usage, imageRepresentations: representations, coordinateInstructions: 'Regions use normalized EXIF-oriented source coordinates. Placement scale uses sourceWidth/sourceHeight, never the reduced model-view dimensions. Model views are resized representations; rendering uses the saved full-size original. Detail-only images are crops of sourceRect, not independent whole frames; map local coordinates through sourceRect and use the canonical whole frame for subject extent.' } }
}
