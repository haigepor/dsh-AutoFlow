/** Public image URL loading with per-hop DNS validation and pinned IPv4 connections. */
import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import ipaddr from 'ipaddr.js'
import { ImageServiceError } from './errors.ts'
import type { ImageBytes } from './types.ts'

/** Decode bounded data URLs or validate and download public HTTP(S) references.
 * @param value Public URL or base64 image data URL; local paths are rejected.
 * @param options Explicit download limits.
 * @param signal Generation-wide cancellation and deadline.
 * @returns Verified image bytes, never an unverified MIME label.
 */
export async function loadImageReference(value: string, options: { maxImageBytes: number; maxRedirects: number }, signal: AbortSignal): Promise<ImageBytes> {
  if (value.startsWith('data:')) return decodeImageDataUrl(value, options.maxImageBytes)
  let url: URL
  try { url = new URL(value) } catch (_error) { throw new ImageServiceError('invalid-image-reference', 'An image reference must be a public HTTP(S) URL or image data URL.') }
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted()
    assertPublicImageUrl(url)
    // 仅连接已检查的公有 IPv4，避免 DNS 重绑定和 DNS64/NAT64 的私网映射。
    const records = await abortable(lookup(url.hostname, { all: true, family: 4 }), signal)
    if (records.length === 0 || records.some(record => !isPublicIpv4(record.address))) {
      throw new ImageServiceError('blocked-image-url', 'Image URLs must resolve exclusively to public IPv4 addresses. IPv6-only sources are unsupported.')
    }
    const address = records[0]!
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const start = url.protocol === 'https:' ? httpsRequest : httpRequest
      const req = start(url, {
        method: 'GET', signal, headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif' },
        lookup: (_hostname, lookupOptions, callback) => {
          if (lookupOptions.all) callback(null, records)
          else callback(null, address.address, 4)
        },
      }, resolve)
      req.on('error', reject)
      req.end()
    })
    const status = response.statusCode ?? 0
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location
      response.destroy()
      if (location === undefined || redirects >= options.maxRedirects) throw new ImageServiceError('image-redirect-limit', 'The image URL exceeded the allowed redirects.')
      url = new URL(location, url)
      continue
    }
    if (status < 200 || status >= 300) { response.destroy(); throw new ImageServiceError('image-download-failed', 'The image source returned an unsuccessful response.', status) }
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of response) {
      const bytes: Uint8Array = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += bytes.byteLength
      if (size > options.maxImageBytes) { response.destroy(); throw new ImageServiceError('image-too-large', 'An image exceeds the configured byte limit.') }
      chunks.push(bytes)
    }
    const data = Buffer.concat(chunks)
    return { data, mimeType: detectImageMediaType(data) }
  }
}

/** Check URL syntax and literal addresses before any request is admitted.
 * @param url Parsed URL.
 */
export function assertPublicImageUrl(url: URL): void {
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.hostname === ''
    || url.hostname.includes(':') || url.hostname === 'localhost'
    || ((url.port !== '') && url.port !== '80' && url.port !== '443')) {
    throw new ImageServiceError('blocked-image-url', 'Image URLs must use public HTTP(S) without credentials or custom ports.')
  }
  if (ipaddr.isValid(url.hostname) && !isPublicIpv4(url.hostname)) throw new ImageServiceError('blocked-image-url', 'Private image destinations are blocked.')
}

/** Decode strict canonical base64 and inspect the raster signature.
 * @param value Base64 image data URL.
 * @param maxBytes Configured decoded limit.
 * @returns Bounded image bytes.
 */
export function decodeImageDataUrl(value: string, maxBytes: number): ImageBytes {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/.exec(value)
  if (match === null || match[2]!.length === 0 || match[2]!.length > Math.ceil(maxBytes / 3) * 4) throw new ImageServiceError('invalid-image-data', 'An image data URL is invalid or exceeds the configured limit.')
  const encoded = match[2]!
  const data = Buffer.from(encoded, 'base64')
  if (data.byteLength > maxBytes || data.toString('base64') !== encoded) throw new ImageServiceError('invalid-image-data', 'Image base64 must be canonical and within the configured limit.')
  const mimeType = detectImageMediaType(data)
  if (mimeType !== match[1]) throw new ImageServiceError('invalid-image-data', 'The image MIME type does not match its bytes.')
  return { data, mimeType }
}

/** Inspect supported raster signatures; full decoding remains AttachmentStore's responsibility.
 * @param bytes Provider or reference bytes.
 * @returns A supported image media type.
 */
export function detectImageMediaType(bytes: Uint8Array): ImageBytes['mimeType'] {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg'
  if (data.toString('ascii', 0, 4) === 'GIF8') return 'image/gif'
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  throw new ImageServiceError('invalid-image-bytes', 'The response is not a supported raster image.')
}

function isPublicIpv4(address: string): boolean {
  if (!ipaddr.isValid(address)) return false
  const parsed = ipaddr.parse(address)
  return parsed.kind() === 'ipv4' && parsed.range() === 'unicast'
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try { return await Promise.race([operation, cancelled]) }
  finally { signal.removeEventListener('abort', abort) }
}
