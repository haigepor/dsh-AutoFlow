/** One Run owns the downloaded preview evidence and the exact pixels already selected from it. */
import { z } from 'zod'
import { contentDigest } from '../domain/repository.ts'
import { MediaError } from '../media/errors.ts'
import { remoteReferenceSource } from '../media/remote-reference.ts'
import type { VisionImage } from '../media/vision.ts'
import { CuratorError } from '../shared/errors.ts'
import { blobRefSchema, type ImageVersion } from '../shared/model.ts'
import { requestBounds } from './providers.ts'
import { toJson, type WorkContext } from './runtime.ts'
import type { SearchDependencies } from './search-workflow.ts'

const receiptSchema = z.object({
  bundle: z.strictObject({ operation: z.literal('review-preview-pixels-v1'), imageVersionId: z.string(), sourceDigest: z.string() }),
  output: z.object({ blob: blobRefSchema, pixelDigest: z.string().regex(/^[a-f0-9]{64}$/) }),
})
type PreviewEvidence = Awaited<ReturnType<SearchDependencies['files']['savePreviewEvidence']>>

/** @param deps Profile storage and media routing. @param ctx Accepted preview search. @returns A verified subject reader and source-order selection admission for that Run. */
export function createSearchPreviewPixels(deps: Pick<SearchDependencies, 'domain' | 'files' | 'media'>, ctx: WorkContext) {
  const media = deps.media(ctx.spec.config), saved = new Map<string, PreviewEvidence>()
  const downloading = new Set<Promise<void>>()
  for (const request of deps.domain.repository.list('request')) {
    if (request.runId !== ctx.runId || request.state !== 'committed') continue
    const receipt = receiptSchema.safeParse(request.data)
    if (!receipt.success || contentDigest(receipt.data.bundle) !== request.requestDigest) continue
    const { imageVersionId, sourceDigest } = receipt.data.bundle
    if (deps.domain.repository.get('imageVersion', imageVersionId)?.blob.digest !== sourceDigest) throw new CuratorError('reference-unavailable', 'preview-review', 'The stored preview pixels belong to a different source descriptor.')
    saved.set(imageVersionId, receipt.data.output)
  }
  const fingerprint = (imageVersionId: string) => {
    const evidence = saved.get(imageVersionId)
    if (!evidence) throw new CuratorError('reference-unavailable', 'preview-review', 'The selected preview has no committed pixel evidence.')
    return evidence.pixelDigest
  }
  const selected = new Set(deps.domain.repository.list('selection').filter(item => item.runId === ctx.runId && item.qualification === 'auto-qualified').map(item => fingerprint(item.imageVersionId)))
  return {
    async subject(image: ImageVersion): Promise<VisionImage | undefined> {
      let evidence = saved.get(image.id)
      if (!evidence) {
        const source = remoteReferenceSource(image.blob)
        if (!source) throw new CuratorError('reference-unavailable', 'preview-review', 'The authorized public preview address is unavailable.')
        const bundle = toJson({ operation: 'review-preview-pixels-v1', imageVersionId: image.id, sourceDigest: image.blob.digest })
        evidence = await ctx.request('download', bundle, async signal => {
          const limits = ctx.spec.config.limits, perImage = Math.min(limits.maxImportBytes, limits.maxReferenceBytes)
          // A pending transfer can return unused bytes before the next preview needs them.
          while (ctx.ledger.remainingBytes() < perImage && downloading.size) {
            await Promise.race(downloading)
            signal.throwIfAborted()
          }
          const maxBytes = Math.min(perImage, ctx.ledger.remainingBytes())
          if (maxBytes <= 0) throw new CuratorError('budget-exhausted', 'preview-review', 'The saved image download budget is exhausted.')
          const settled = Promise.withResolvers<void>()
          downloading.add(settled.promise)
          let response
          try {
            await ctx.ledger.reserve('download', maxBytes)
            await ctx.save('reviewing', {})
            response = await media.request(source.url, { ...requestBounds(ctx.spec.config, ctx), signal, method: 'GET', maxBytes, headers: { accept: 'image/jpeg,image/png,image/webp' } })
            ctx.ledger.settleDownload(maxBytes, response.bytes.byteLength)
          } finally {
            downloading.delete(settled.promise)
            settled.resolve()
          }
          if (response.status < 200 || response.status >= 300) throw new MediaError('source-download-http', 'preview-review', response.status === 429 || response.status >= 500, 'The preview image could not be downloaded.', 'Continue within the saved retry budget.')
          return deps.files.savePreviewEvidence(response.bytes, response.headers['content-type'], signal)
        })
        saved.set(image.id, evidence)
      }
      if (selected.has(evidence.pixelDigest)) return undefined
      const { blob } = evidence
      return { imageVersionId: image.id, digest: blob.digest, mime: blob.mime, role: 'subject', bytes: await deps.files.read(blob, ctx.signal), storedImage: { storageRef: blob.storageRef, byteLength: blob.byteLength } }
    },
    admit(imageVersionId: string): boolean {
      const digest = fingerprint(imageVersionId)
      if (selected.has(digest)) return false
      selected.add(digest)
      return true
    },
  }
}
