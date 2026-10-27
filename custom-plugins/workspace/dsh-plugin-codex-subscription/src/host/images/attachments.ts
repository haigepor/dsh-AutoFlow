/** Preserve provider originals separately from normalized AttachmentStore image previews. */
import { randomUUID } from 'node:crypto'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ImageAsset, ImageAssetRecord, ImageBytes } from './types.ts'
import { parseImageAssetId } from './ids.ts'

/** Adapt the public attachment seam without depending on provider filesystem paths.
 * @param attachments Host attachment provider, alive until image-service disposal finishes.
 * @param maxImageBytes Configured bound applied to original reads.
 * @returns Batch write and original read operations for ImageServiceOptions.
 */
export function imageAttachmentAdapter(attachments: Pick<AttachmentStore, 'validateImage' | 'saveFile' | 'saveImage' | 'readFileStream'>, maxImageBytes: number) {
  return {
    async validateReference(image: ImageBytes): Promise<void> {
      await attachments.validateImage({ data: image.data, mediaType: image.mimeType, ...(image.name === undefined ? {} : { name: image.name }) })
    },
    async saveAssets(images: readonly ImageBytes[]): Promise<ImageAssetRecord[]> {
      // 先验证整个批次，避免第一个附件已保存后才发现另一个不是有效图片。
      for (const image of images) await attachments.validateImage({ data: image.data, mediaType: image.mimeType, ...(image.name === undefined ? {} : { name: image.name }) })
      const assets: ImageAssetRecord[] = []
      for (const image of images) {
        const name = image.name ?? `codex-${randomUUID()}.${extension(image.mimeType)}`
        const original = await attachments.saveFile({ data: image.data, name })
        const preview = await attachments.saveImage({ data: image.data, mediaType: image.mimeType, name })
        assets.push({ id: parseImageAssetId(randomUUID()), mimeType: image.mimeType, original, preview })
      }
      return assets
    },
    async readAsset(asset: ImageAsset, signal?: AbortSignal): Promise<ImageBytes> {
      if (asset.original.bytes > maxImageBytes) throw new Error('Image original exceeds the configured read limit.')
      const chunks: Uint8Array[] = []
      let bytes = 0
      for await (const chunk of attachments.readFileStream(asset.original, signal)) {
        bytes += chunk.byteLength
        if (bytes > maxImageBytes) throw new Error('Image original exceeds the configured read limit.')
        chunks.push(chunk)
      }
      return { data: Buffer.concat(chunks), mimeType: asset.mimeType, name: asset.original.name }
    },
  }
}

function extension(mimeType: ImageBytes['mimeType']): string {
  return mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length)
}
