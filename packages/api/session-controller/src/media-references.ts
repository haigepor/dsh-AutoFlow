/**
 * Authenticated GET/HEAD /api/file reads bounded file responses through
 * the composed filesystem provider. Original reads do not restrict access by MIME type;
 * the connection service authenticates requests before this handler. A request
 * without the current `v` version is redirected, uncached, to the versioned URL,
 * whose response is cacheable indefinitely. Explicit `preview=1` reads derive a
 * bounded static raster in the attachment provider and retain the preview policy
 * in the versioned URL; unsupported previews never fall back to original bytes.
 * @module @deepseek-ai/dsh-api-session-controller/media-references
 */

import { isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { isAttachmentError, type AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { FsError, type FileSystem } from '@deepseek-ai/dsh-fs'
import mime from 'mime-types'

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  // HTML and SVG files may be opened directly on the authenticated API origin.
  'Content-Security-Policy': "sandbox; default-src 'none'",
}
const NO_STORE = { ...BASE_HEADERS, 'Cache-Control': 'private, no-store' }
// A versioned URL names one file version, so its response never changes.
const VERSIONED = { ...BASE_HEADERS, 'Cache-Control': 'private, max-age=31536000, immutable' }

async function serveFile(request: Request, fs: FileSystem, attachments: AttachmentStore, namespace: string): Promise<Response> {
  const maxBytes = attachments.imageLimits.maxImageBytes
  const fail = (status: number, text: string): Response =>
    new Response(request.method === 'HEAD' ? null : text, { status, headers: NO_STORE })
  const params = new URL(request.url).searchParams
  const path = params.get('path')
  const preview = params.get('preview')
  if (preview !== null && preview !== '1') return fail(400, 'unsupported preview mode')
  if (path === null || path.length === 0) return fail(400, 'missing path')
  if (path.includes('\0') || !isAbsolute(path)) return fail(400, 'absolute path required')
  try {
    const target = await fs.resolve(path, { signal: request.signal })
    const info = await fs.stat(target, request.signal)
    if (info === undefined) return fail(404, 'not found')
    if (info.type !== 'file') return fail(403, 'not a regular file')
    if (info.size !== undefined && info.size > maxBytes) return fail(413, 'file exceeds byte limit')
    const previewVersion = preview === '1' && attachments.imagePreviewVersion ? `${namespace}.${attachments.imagePreviewVersion}` : undefined
    if (preview === '1' && previewVersion === undefined) return fail(501, 'image previews unavailable')
    if (params.get('v') !== info.version || previewVersion !== undefined && params.get('pv') !== previewVersion) {
      // Relative to the request URL, so deployment prefixes and the Desktop scheme are kept.
      const location = `?${new URLSearchParams({ path, v: info.version, ...(previewVersion ? { preview: '1', pv: previewVersion } : {}) }).toString()}`
      return new Response(null, { status: 302, headers: { ...NO_STORE, Location: location } })
    }
    const headers: Record<string, string> = {
      ...VERSIONED,
      'Content-Type': mime.lookup(target.displayPath) || 'application/octet-stream',
    }
    if (preview === '1') {
      const mediaType = attachments.imageLimits.mediaTypes.find(type => type === mime.lookup(target.displayPath))
      if (!mediaType) return fail(415, 'unsupported preview image type')
      // A cached derivative still requires the current provider's read permission, without loading the source raster.
      await fs.readByteRange(target, { offset: 0, length: 1 }, request.signal)
      const image = await attachments.readImagePreview({
        cacheKey: JSON.stringify([namespace, fs.fileUrl(target), target.targetKey, info.version]),
        load: async (signal) => {
          const data = await fs.readBytes(target, signal, maxBytes)
          if ((await fs.stat(target, signal))?.version !== info.version) throw new FsError('Image changed while preparing its preview.', 'FS_STALE_VERSION')
          return { data, mediaType }
        },
      }, request.signal)
      headers['Content-Type'] = image.mediaType
      headers['Content-Length'] = String(image.bytes)
      return new Response(request.method === 'HEAD' ? null : image.data.slice(), { headers })
    }
    if (request.method === 'HEAD') {
      if (info.size !== undefined) headers['Content-Length'] = String(info.size)
      return new Response(null, { headers })
    }
    const bytes = await fs.readBytes(target, request.signal, maxBytes)
    headers['Content-Length'] = String(bytes.byteLength)
    return new Response(bytes.slice(), { headers })
  } catch (error: unknown) {
    if (request.signal.aborted) return fail(499, 'request aborted')
    if (isAttachmentError(error)) {
      const status = ['IMAGE_TOO_LARGE', 'IMAGE_TOO_MANY_PIXELS', 'IMAGE_DIMENSION_TOO_LARGE'].includes(error.code) ? 413
        : error.code === 'ATTACHMENT_PROJECTION_UNSUPPORTED' ? 501
          : ['INVALID_IMAGE', 'IMAGE_TYPE_MISMATCH', 'UNSUPPORTED_IMAGE_TYPE'].includes(error.code) ? 415 : 500
      return fail(status, error.code)
    }
    if (!(error instanceof FsError)) throw error
    const statuses: Partial<Record<FsError['code'], number>> = {
      FS_NOT_FOUND: 404,
      FS_NOT_REGULAR_FILE: 403,
      FS_PERMISSION_DENIED: 403,
      FS_SANDBOX_DENIED: 403,
      FS_TOO_LARGE: 413,
      FS_ABORTED: 499,
      FS_STALE_VERSION: 409,
    }
    return fail(statuses[error.code] ?? 500, error.code)
  }
}

/**
 * File-display contribution. The connection service supplies authentication;
 * `ctx.fs` supplies the execution world's paths, reads, and access policy.
 */
export const SessionMediaReferences = {
  inject: ['connection', 'fs', 'attachments'],
  apply(ctx: Context): void {
    const namespace = randomUUID()
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/file',
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: request => serveFile(request, ctx.fs, ctx.attachments, namespace),
    }), 'session-controller: /api/file')
  },
}
