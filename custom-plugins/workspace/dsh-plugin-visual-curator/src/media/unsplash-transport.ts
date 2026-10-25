/** Account-isolated curl transport preserves the supplied client's TLS behavior without Python or a shared cookie file. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename, resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { z } from 'zod'
import { isPublicAddress, type RequestBounds } from './network.ts'
import { MediaError, invalidInput } from './errors.ts'
import { normalizeCookie, type UnsplashTransport } from './unsplash.ts'

const origin = 'https://unsplash.com'
const environmentNames = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'LANG', 'LC_ALL'])
const quote = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
const failed = (code = 'source-network-failed', retryable = false) => new MediaError(code, 'gallery', retryable, 'Unable to read the Unsplash gallery.', 'Check the account session and connection, then retry.')
const challengeSchema = z.object({ challenge: z.object({ id: z.string().min(1).max(256), randomData: z.string().min(1).max(4096), difficulty: z.number().int().min(1).max(8) }) })

/** Secret values remain in memory and private temporary files, never subprocess arguments or logs. */
export class CurlUnsplashTransport implements UnsplashTransport {
  private cookies: string
  /** @param secret Account Cookie header or Netscape cookie content; absent permits public search. @param options Validated deployment executable and user agent. */
  constructor(secret: string | undefined, private readonly options: { curlBinary: string; userAgent: string }) {
    this.cookies = secret ? normalizeCookie(secret) : ''
  }

  /** @param path Fixed relative napi path selected by the Host adapter. @param params Validated read parameters. @param bounds Shared logical request limits. @returns JSON after at most one access-check exchange. */
  async request(path: string, params: Readonly<Record<string, string | number>>, bounds: RequestBounds): Promise<unknown> {
    if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(path)) throw invalidInput('The Unsplash API path is invalid.')
    const url = new URL(`/napi${path}`, origin)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
    if (!Number.isSafeInteger(bounds.maxBytes) || bounds.maxBytes < 1 || !Number.isSafeInteger(bounds.timeoutMs) || bounds.timeoutMs < 1) throw invalidInput('The gallery request limits are invalid.')
    const signal = AbortSignal.any([...(bounds.signal ? [bounds.signal] : []), AbortSignal.timeout(bounds.timeoutMs)])
    const directory = await mkdtemp(join(tmpdir(), 'visual-unsplash-')), jar = join(directory, 'cookies.txt')
    try {
      const lines = this.cookies.split('; ').filter(Boolean).map(pair => { const index = pair.indexOf('='); return `unsplash.com\tFALSE\t/\tTRUE\t0\t${pair.slice(0, index)}\t${pair.slice(index + 1)}` })
      await writeFile(jar, '# Netscape HTTP Cookie File\n' + lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 })
      let response = await this.read(url, jar, directory, bounds, signal)
      if (response.status === 401 || response.status === 200 && !/json/i.test(response.headers['content-type'] ?? '')) {
        const text = response.bytes.toString('utf8'), match = /<script[^>]*id="anubis_challenge"[^>]*>([\s\S]*?)<\/script>/.exec(text)
        if (match) {
          const { challenge } = challengeSchema.parse(JSON.parse(match[1]!)), digestPrefix = '0'.repeat(challenge.difficulty)
          const started = performance.now()
          let nonce = 0, digest = ''
          for (;;) {
            signal.throwIfAborted()
            digest = createHash('sha256').update(challenge.randomData + nonce).digest('hex')
            if (digest.startsWith(digestPrefix)) break
            nonce++
            if (nonce % 2048 === 0) await setImmediate(undefined, { signal })
          }
          const pass = new URL('/.within.website/x/cmd/anubis/api/pass-challenge', origin)
          for (const [name, value] of Object.entries({ id: challenge.id, response: digest, nonce: String(nonce), elapsedTime: String(Math.max(1, Math.round(performance.now() - started))), redir: url.pathname + url.search, responseMode: 'ok' })) pass.searchParams.set(name, value)
          const admitted = await this.read(pass, jar, directory, bounds, signal)
          if (admitted.status !== 200) throw failed('source-access-check')
          response = await this.read(url, jar, directory, bounds, signal)
        }
      }
      if (response.status === 401) throw failed('source-auth-required')
      if (response.status === 429) throw failed('source-rate-limited', true)
      if (response.status === 403) throw failed('source-access-denied')
      if (response.status < 200 || response.status >= 300 || !/^(application\/json|application\/[A-Za-z0-9.+-]+\+json)(?:;|$)/i.test(response.headers['content-type'] ?? '')) throw failed('source-protocol-error')
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes))
    } catch (error) {
      if (bounds.signal?.aborted) throw new MediaError('cancelled', 'gallery', false, 'Gallery request cancelled.', 'Open the gallery again to retry.')
      if (signal.aborted) throw failed('source-request-timeout', true)
      if (error instanceof MediaError) throw error
      throw failed()
    } finally {
      // mkdtemp 返回的私有目录仅含本请求创建的固定文件；等待子进程关闭后再清理。
      if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('visual-unsplash-')) throw failed('invalid-input')
      await rm(directory, { recursive: true, force: true })
    }
  }

  private async read(initial: URL, jar: string, directory: string, bounds: RequestBounds, signal: AbortSignal): Promise<{ status: number; headers: Record<string, string>; bytes: Buffer }> {
    let url = initial
    for (let redirects = 0; ; redirects++) {
      signal.throwIfAborted()
      if (url.origin !== origin || url.username || url.password || url.hash) throw failed('invalid-input')
      const addresses = await lookup(url.hostname, { all: true, verbatim: true })
      if (!addresses.length || addresses.some(address => !isPublicAddress(address.address))) throw failed('invalid-input')
      const address = addresses.find(address => address.family === 4) ?? addresses[0]!
      const bodyPath = join(directory, 'body.bin'), headerPath = join(directory, 'headers.txt')
      const config = [
        `url = ${quote(url.href)}`, `cookie = ${quote(jar)}`, `cookie-jar = ${quote(jar)}`, `output = ${quote(bodyPath)}`, `dump-header = ${quote(headerPath)}`,
        `user-agent = ${quote(this.options.userAgent)}`, 'header = "Accept: application/json, text/plain, */*"', 'header = "accept-language: en-US"', 'header = "Referer: https://unsplash.com/"',
      ].join('\n') + '\n'
      const args = ['-q', '--silent', '--show-error', '--proto', '=https', '--max-time', String(Math.ceil(bounds.timeoutMs / 1000)), '--max-filesize', String(bounds.maxBytes), '--resolve', `${url.hostname}:443:${address.family === 6 ? `[${address.address}]` : address.address}`, '--config', '-']
      await new Promise<void>((resolve, reject) => {
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => environmentNames.has(key.toUpperCase())))
        const child = spawn(this.options.curlBinary, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], signal, env })
        let spawnError: Error | undefined
        child.on('error', error => { spawnError = error })
        child.stdin.on('error', error => { /* 提前退出的 curl 会关闭输入管道；最终状态由 close 统一报告。 */ spawnError ??= error })
        child.on('close', code => { if (spawnError || code !== 0) reject(failed(spawnError && 'code' in spawnError && spawnError.code === 'ENOENT' ? 'source-client-unavailable' : 'source-network-failed')); else resolve() })
        child.stdin.end(config)
      })
      if ((await stat(bodyPath)).size > bounds.maxBytes || (await stat(headerPath)).size > bounds.maxBytes) throw failed('source-protocol-error')
      const bytes = await readFile(bodyPath), rawHeaders = await readFile(headerPath, 'utf8')
      const blocks = rawHeaders.split(/\r?\n\r?\n/).filter(block => /^HTTP\/\S+\s+\d{3}/.test(block)), block = blocks.at(-1)
      if (!block) throw failed('source-protocol-error')
      const rows = block.split(/\r?\n/), status = Number(rows.shift()?.split(/\s+/)[1]), headers: Record<string, string> = {}
      for (const row of rows) { const index = row.indexOf(':'); if (index > 0) headers[row.slice(0, index).toLowerCase()] = row.slice(index + 1).trim() }
      const saved = await readFile(jar, 'utf8')
      try { this.cookies = normalizeCookie(saved) } catch (error) { if (saved.split(/\r?\n/).some(line => line && !line.startsWith('#'))) throw error }
      if ([301, 302, 303, 307, 308].includes(status)) {
        if (redirects >= bounds.maxRedirects || !headers.location) throw failed('source-protocol-error')
        url = new URL(headers.location, url)
        continue
      }
      return { status, headers, bytes }
    }
  }
}
