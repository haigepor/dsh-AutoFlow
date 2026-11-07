/** Static display previews reuse source admission, normalization and private atomic image caching. */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { AttachmentError, type ImageAttachmentLimits, type ImagePreviewAttachment, type ImagePreviewSource } from '@deepseek-ai/dsh-attachment'
import type { NormalizationPolicy } from './normalization.ts'
import { prepareImageFile } from './store.ts'
import { probeImage } from './image.ts'
import { REQUEST_IMAGE_TRANSFORM_VERSION, writeImageCache } from './request-image.ts'

/**
 * Identify the display transform and its source admission policy.
 * @param limits Source admission bounds.
 * @param policy Static display bounds.
 * @returns Stable version including every admission, normalization and encoding choice.
 */
export function imagePreviewVersion(limits: ImageAttachmentLimits, policy: NormalizationPolicy): string {
  return createHash('sha256').update(JSON.stringify({ transform: 'display-image-v1', encoding: REQUEST_IMAGE_TRANSFORM_VERSION, limits, policy })).digest('hex')
}

/**
 * Read a verified display preview or regenerate it from the authorized source.
 * @param root Private attachment cache.
 * @param version Resolved encoding/policy version.
 * @param source Authorized immutable source.
 * @param limits Source admission bounds.
 * @param policy Static display bounds.
 * @param signal Shared operation cancellation.
 * @returns Cached or newly normalized static preview pixels.
 */
export async function readPreviewImage(
  root: string, version: string, source: ImagePreviewSource,
  limits: ImageAttachmentLimits, policy: NormalizationPolicy, signal: AbortSignal,
): Promise<ImagePreviewAttachment> {
  signal.throwIfAborted()
  const key = createHash('sha256').update(JSON.stringify([version, source.cacheKey])).digest('hex'), path = join(root, 'display-images', key.slice(0, 2), key)
  try {
    if ((await stat(path)).size <= policy.maxBytes) {
      const data = new Uint8Array(await readFile(path, { signal }))
      if (data.byteLength <= policy.maxBytes) {
        const image = await probeImage(data)
        signal.throwIfAborted()
        if (image.depth === 'uchar' && image.space === 'srgb' && image.width * image.height <= policy.maxPixels && Math.max(image.width, image.height) <= policy.maxDimension) return { data, mediaType: image.mediaType, width: image.width, height: image.height, bytes: data.byteLength }
      }
    }
  } catch (error) {
    signal.throwIfAborted()
    // A missing or damaged derived cache is regenerated from the freshly authorized source.
    if (!(error instanceof Error)) throw error
  }
  const input = await source.load(signal)
  signal.throwIfAborted()
  const prepared = await prepareImageFile(input, limits, policy)
  signal.throwIfAborted()
  if (prepared.data.byteLength > policy.maxBytes) throw new AttachmentError('Display preview exceeds its encoded byte limit.', 'IMAGE_TOO_LARGE')
  await writeImageCache(path, prepared.data, signal)
  return {
    data: prepared.data, mediaType: prepared.ref.mediaType,
    width: prepared.ref.width, height: prepared.ref.height, bytes: prepared.data.byteLength,
  }
}
