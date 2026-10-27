/** Account-isolated curl transport preserves the supplied client's TLS behavior without Python or a shared cookie file. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
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

/** Curl failures retain only the numeric exit status; stderr may contain private URLs. */
export class CurlRequestError extends MediaError {
  /** @param exitCode Process exit status, or null after a signal. @param unavailable The configured executable could not be found. */
  constructor(readonly exitCode: number | null, unavailable = false) {
    const code = unavailable ? 'source-client-unavailable' : exitCode === 28 ? 'source-request-timeout' : exitCode === 5 || exitCode === 6 ? 'source-dns-failed'
      : exitCode !== null && [35, 51, 58, 60, 77, 83, 90, 91].includes(exitCode) ? 'source-tls-failed'
      : exitCode === 18 ? 'source-response-incomplete' : 'source-network-failed'
    const retryable = !unavailable && exitCode !== null && [5, 6, 7, 16, 18, 28, 52, 55, 56, 92, 95, 96].includes(exitCode)
    super(code, 'gallery', retryable, `Unable to read the Unsplash gallery (curl exit ${exitCode ?? 'none'}).`, 'Check the connection and retry; certificate errors require correcting the local trust configuration.')
  }
}

/** Retry only transient, read-only curl failures within the caller's lifetime.
 * @param read One attempt using the indicated validated address index. @param maxRetries Configured extra attempts.
 * @param signal Shared request deadline and cancellation. @returns The first complete response; terminal failures remain failures.
 */
export async function retryCurlRead<T>(read: (attempt: number) => Promise<T>, maxRetries: number, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    try { return await read(attempt) }
    catch (error) {
      if (signal.aborted || !(error instanceof CurlRequestError) || !error.retryable || attempt >= maxRetries) throw error
    }
  }
}

/** @param hostname Fixed provider hostname. @param addresses Nonempty public records already checked by the caller. @param offset First candidate for this attempt. @returns curl's pinned address set, retaining native connection fallback and hostname TLS. */
export function curlResolveArgument(hostname: string, addresses: readonly LookupAddress[], offset: number): string {
  const ordered = [...addresses.slice(offset), ...addresses.slice(0, offset)]
  return `${hostname}:443:${ordered.map(item => item.family === 6 ? `[${item.address}]` : item.address).join(',')}`
}

/** Secret values remain in memory and private temporary files, never subprocess arguments or logs. */
export class CurlUnsplashTransport implements UnsplashTransport {
  private cookies: string
  private nextAddress: string | undefined
  /** @param secret Account Cookie header or Netscape cookie content; absent permits public search. @param options Validated executable, user agent, connection timeout and read retry budget. */
  constructor(secret: string | undefined, private readonly options: { curlBinary: string; userAgent: string; connectTimeoutMs: number; maxRetryAttempts: number }) {
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
      let addresses: LookupAddress[]
      try { addresses = await lookup(url.hostname, { all: true, verbatim: true }) }
      catch (error) {
        signal.throwIfAborted()
        if (error instanceof Error && 'code' in error && ['ENOTFOUND', 'EAI_AGAIN'].includes(String(error.code))) throw failed('source-dns-failed', true)
        throw error
      }
      if (!addresses.length || addresses.some(address => !isPublicAddress(address.address))) throw failed('invalid-input')
      const candidates = [...addresses.filter(address => address.family === 4), ...addresses.filter(address => address.family !== 4)]
      const preferred = candidates.findIndex(address => address.address === this.nextAddress)
      if (preferred > 0) candidates.push(...candidates.splice(0, preferred))
      const bodyPath = join(directory, 'body.bin'), headerPath = join(directory, 'headers.txt')
      const config = [
        `url = ${quote(url.href)}`, `cookie = ${quote(jar)}`, `cookie-jar = ${quote(jar)}`, `output = ${quote(bodyPath)}`, `dump-header = ${quote(headerPath)}`,
        `user-agent = ${quote(this.options.userAgent)}`, 'header = "Accept: application/json, text/plain, */*"', 'header = "accept-language: en-US"', 'header = "Referer: https://unsplash.com/"',
      ].join('\n') + '\n'
      // 连接层接收全部已检查地址；某个节点不可达时由 curl 回退，HTTP 请求只发到胜出的连接。
      await retryCurlRead(async attempt => {
        const index = attempt % candidates.length
        this.nextAddress = candidates[(attempt + 1) % candidates.length]!.address
        const args = ['-q', '--silent', '--show-error', '--compressed', '--proto', '=https', '--connect-timeout', String(Math.min(this.options.connectTimeoutMs, bounds.timeoutMs) / 1000), '--max-time', String(Math.ceil(bounds.timeoutMs / 1000)), '--max-filesize', String(bounds.maxBytes), '--resolve', curlResolveArgument(url.hostname, candidates, index), '--config', '-']
        await new Promise<void>((resolve, reject) => {
          const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => environmentNames.has(key.toUpperCase())))
          const child = spawn(this.options.curlBinary, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], signal, env })
          let spawnError: Error | undefined
          child.on('error', error => { spawnError = error })
          child.stdin.on('error', error => { /* 提前退出的 curl 会关闭输入管道；最终状态由 close 统一报告。 */ spawnError ??= error })
          child.on('close', code => { if (spawnError || code !== 0) reject(new CurlRequestError(code, !!spawnError && 'code' in spawnError && spawnError.code === 'ENOENT')); else resolve() })
          child.stdin.end(config)
        })
      }, url.pathname.startsWith('/napi/') ? this.options.maxRetryAttempts : 0, signal)
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
