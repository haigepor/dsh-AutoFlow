/** Fixed public interface artwork stays outside the executable Client bundle. */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

/** @returns A GET/HEAD handler serving unchanged packaged artwork with conditional caching. */
export function createExecutionArtwork(): (request: Request) => Promise<Response> {
  const root = dirname(createRequire(import.meta.url).resolve('dsh-plugin-visual-curator/package.json'))
  let artwork: Promise<{ bytes: Uint8Array<ArrayBuffer>; etag: string }> | undefined
  return async request => {
    const image = await (artwork ??= readFile(join(root, 'assets/execution-empty-v1.webp')).then(buffer => ({
      bytes: new Uint8Array(buffer), etag: `"${createHash('sha256').update(buffer).digest('hex')}"`,
    })))
    const headers = { 'content-type': 'image/webp', 'cache-control': 'public, max-age=86400', etag: image.etag, 'x-content-type-options': 'nosniff' }
    if (request.headers.get('if-none-match') === image.etag) return new Response(null, { status: 304, headers })
    return new Response(request.method === 'HEAD' ? null : image.bytes, { headers: { ...headers, 'content-length': String(image.bytes.length) } })
  }
}
