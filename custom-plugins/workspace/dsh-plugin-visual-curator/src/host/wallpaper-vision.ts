/** Persist bounded, reproducible model views while retaining full-size pixels for wallpaper rendering. */
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import type { AssetFiles, StructuredVisionProvider, VisionImage, VisionInput } from '../media/index.ts'
import { MediaError } from '../media/index.ts'

/** Prepare all wallpaper review inputs under the existing vision and preview limits.
 * @param input Canonical image identities, verified source pixels and frozen task instructions.
 * @param files Private content-addressed file owner.
 * @param provider Selected route and its image limits.
 * @param maxDimension Preview dimension frozen in the owning task.
 * @param signal Task cancellation.
 * @returns Request containing saved model-view bytes and explicit original-to-view geometry.
 */
export async function wallpaperVisionInput(input: VisionInput, files: AssetFiles, provider: StructuredVisionProvider, maxDimension: number, signal: AbortSignal): Promise<VisionInput> {
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
  signal.throwIfAborted()
  const usage = typeof input.usage === 'object' && input.usage !== null && !Array.isArray(input.usage) ? input.usage : { context: input.usage }
  return { ...input, images, usage: { ...usage, imageRepresentations: representations, coordinateInstructions: 'Regions use normalized EXIF-oriented source coordinates. Placement scale uses sourceWidth/sourceHeight, never the reduced model-view dimensions. Model views are resized representations; rendering uses the saved full-size original.' } }
}
