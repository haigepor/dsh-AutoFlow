/** Mandatory-update policy, independent of local business traffic and updater artifacts. */

import { lt, valid } from 'semver'
import { platformClientHeaders, type AccountClientMetadata } from '@deepseek-ai/dsh-deepseek-account'
import { parseDesktopStaticUpdatePolicy } from './static-update-policy.ts'

/** Installed release identity; no field is supplied by a renderer. */
export interface DesktopPolicyIdentity {
  readonly platform: 'win32' | 'darwin'
  readonly bundledDshVersion: string
  readonly arch: 'x64' | 'arm64'
}

/** Validated deployment choices; test authentication is explicitly enabled, never inferred from a redirect. */
interface DesktopPolicyOptions {
  readonly origin: string
  readonly allowedPageOrigins: readonly string[]
  readonly allowedAuthOrigins: readonly string[]
  readonly intervalMs: number
  readonly timeoutMs: number
  readonly maxBackoffMs: number
  readonly jitter: number
  readonly authentication: 'anonymous' | 'feishu-test'
}

/** A static source requires a complete URL; API deployments retain origin-based requests. */
export type DesktopPolicyConfig = DesktopPolicyOptions & (
  { readonly source?: 'api'; readonly policyUrl?: never }
  | { readonly source: 'static-json'; readonly policyUrl: string }
)

/** A known block survives transport and parsing failures, but not a fresh no-force success. */
export interface DesktopPolicyState {
  readonly blocking: boolean
  readonly checking: boolean
  readonly title?: string
  readonly detail?: string
  readonly page?: string
  readonly error?: 'unavailable' | 'authentication-required'
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function origin(value: unknown, local: boolean): string {
  if (typeof value !== 'string') throw new Error('desktop policy: origin must be a URL')
  const url = new URL(value)
  if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== ''
    || (url.protocol !== 'https:' && !(local && url.protocol === 'http:' && url.hostname === '127.0.0.1'))) {
    throw new Error('desktop policy: expected an HTTPS origin without credentials, path, query, or fragment')
  }
  return url.origin
}

/**
 * Resolve deployment JSON without guessing a production service or download destination.
 * @param input - Parsed configuration with origin and allowedPageOrigins; absent configuration disables policy queries.
 * @param allowLoopback - Explicit unpackaged/test permission for an HTTP 127.0.0.1 policy origin only.
 * @returns Validated polling options, or undefined when unconfigured.
 */
export function resolveDesktopPolicyConfig(input: unknown, allowLoopback = false): DesktopPolicyConfig | undefined {
  if (input === undefined) return undefined
  const value = record(input)
  if (value === undefined || !Array.isArray(value.allowedPageOrigins) || value.allowedPageOrigins.length === 0) {
    throw new Error('desktop policy: configure origin and a nonempty allowedPageOrigins list')
  }
  const fields = value
  const source = value.source ?? 'api'
  if (source !== 'api' && source !== 'static-json') throw new Error('desktop policy: source must be api or static-json')
  let policyUrl: URL | undefined
  if (source === 'static-json') {
    if (typeof value.policyUrl !== 'string') throw new Error('desktop policy: static-json requires policyUrl')
    policyUrl = new URL(value.policyUrl)
    if (policyUrl.username || policyUrl.password || policyUrl.search || policyUrl.hash
      || (policyUrl.protocol !== 'https:' && !(allowLoopback && policyUrl.protocol === 'http:' && policyUrl.hostname === '127.0.0.1'))) {
      throw new Error('desktop policy: policyUrl must use HTTPS without credentials, query, or fragment')
    }
  } else if (value.policyUrl !== undefined) throw new Error('desktop policy: API source must not configure policyUrl')
  function duration(key: string, fallback: number): number {
    const duration = fields[key] ?? fallback
    if (typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration < 1_000 || duration > 2_147_483_647) {
      throw new Error(`desktop policy: ${key} must be an integer from 1000 through 2147483647`)
    }
    return duration
  }
  const intervalMs = duration('intervalMs', 600_000)
  const maxBackoffMs = duration('maxBackoffMs', 3_600_000)
  const jitter = value.jitter ?? 0.2
  const authentication = value.authentication ?? 'anonymous'
  if (authentication !== 'anonymous' && authentication !== 'feishu-test') {
    throw new Error('desktop policy: authentication must be anonymous or feishu-test')
  }
  if (source === 'static-json' && authentication !== 'anonymous') throw new Error('desktop policy: static-json must be anonymous')
  const authOrigins = value.allowedAuthOrigins
  if (authentication === 'feishu-test' && (!Array.isArray(authOrigins) || authOrigins.length === 0)) {
    throw new Error('desktop policy: test authentication requires nonempty allowedAuthOrigins')
  }
  if (authentication === 'anonymous' && authOrigins !== undefined) {
    throw new Error('desktop policy: anonymous policy must not configure allowedAuthOrigins')
  }
  if (typeof jitter !== 'number' || !Number.isFinite(jitter) || jitter < 0 || jitter > 1 || maxBackoffMs < intervalMs) {
    throw new Error('desktop policy: jitter must be in [0, 1] and maxBackoffMs must cover intervalMs')
  }
  const resolved: DesktopPolicyOptions = {
    origin: origin(policyUrl?.origin ?? value.origin, authentication === 'anonymous' && allowLoopback),
    allowedPageOrigins: value.allowedPageOrigins.map(item => origin(item, false)),
    allowedAuthOrigins: authentication === 'feishu-test' ? (authOrigins as unknown[]).map(item => origin(item, false)) : [],
    intervalMs, timeoutMs: duration('timeoutMs', 15_000), maxBackoffMs, jitter, authentication,
  }
  return policyUrl === undefined ? resolved : { ...resolved, source: 'static-json', policyUrl: policyUrl.href }
}

/**
 * Validate the fallback page immediately before browser or clipboard use.
 * @param value - Policy-provided page, never an updater feed or shell command.
 * @param allowedOrigins - Exact HTTPS origins from deployment configuration.
 * @returns Normalized allowed URL, or undefined for a missing/disallowed destination.
 */
export function desktopPolicyPage(value: unknown, allowedOrigins: readonly string[]): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined
  let url: URL
  try { url = new URL(value) } catch { return undefined }
  return url.protocol === 'https:' && url.username === '' && url.password === '' && allowedOrigins.includes(url.origin)
    ? url.href : undefined
}

function text(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value.trim() !== '' && value.length <= limit ? value : undefined
}

function parsePolicy(body: unknown, ok: boolean, config: DesktopPolicyConfig): DesktopPolicyState {
  const root = record(body)
  const data = record(root?.data)
  if (root?.code === 40005) {
    const content = record(data?.show_content)
    const title = text(content?.title, 256)
    const detail = text(content?.detail, 16_384)
    const page = desktopPolicyPage(data?.desktop_app_link, config.allowedPageOrigins)
    return { blocking: true, checking: false,
      ...(title === undefined ? {} : { title }), ...(detail === undefined ? {} : { detail }), ...(page === undefined ? {} : { page }) }
  }
  if (ok && root?.code === 0 && data?.biz_code === 0 && data.biz_data === null) return { blocking: false, checking: false }
  throw new Error('desktop policy: response does not contain a valid mandatory or no-force decision')
}

/** Owns one installed-client context, its in-flight request, and polling schedule. */
export class DesktopMandatoryUpdatePolicy {
  private current: DesktopPolicyState = { blocking: false, checking: false }
  private pending: Promise<DesktopPolicyState> | undefined
  private controller: AbortController | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private failures = 0
  private nextCheck = -Infinity

  /**
   * @param config - Resolved deployment settings.
   * @param identity - Installed software identity, fixed for this application build.
   * @param publish - Receives policy changes without controlling downloads or existing tasks.
   * @param request - Anonymous Fetch or the dedicated test-authentication Session transport.
   * @param client - UI build version, language, and UTC offset, sampled for every check.
   * @param random - Jitter source, replaceable for clock-driven tests.
   */
  constructor(
    private readonly config: DesktopPolicyConfig,
    private readonly identity: DesktopPolicyIdentity,
    private readonly publish: (state: DesktopPolicyState) => void,
    private readonly request: typeof fetch = fetch,
    private readonly client: () => AccountClientMetadata,
    private readonly random: () => number = Math.random,
  ) {
    if (valid(this.client().version) === null || valid(identity.bundledDshVersion) === null
      || (identity.platform === 'win32' && identity.arch !== 'x64')) throw new Error('desktop policy: invalid installed client identity')
  }

  /** Platform headers for one check; the calling UI's language and UTC offset are read now. */
  private requestHeaders(): Record<string, string> {
    return {
      ...platformClientHeaders(this.identity.platform, this.client()),
      'x-client-arch': this.identity.arch, 'x-client-update-channel': 'nightly',
      'x-client-bundled-dsh-version': this.identity.bundledDshVersion,
    }
  }

  /** Latest policy; failures never erase a known mandatory decision. */
  get state(): DesktopPolicyState { return this.current }

  /**
   * Check immediately when manual, otherwise only when due; matching concurrent callers share one request.
   * @param scenario - Trigger recorded in the query, independent of backend matching.
   * @param manual - Bypass interval/backoff without bypassing request coalescing.
   * @returns Current decision or retained decision with an error; disposed instances reject.
   */
  check(scenario: string, manual = false): Promise<DesktopPolicyState> {
    if (this.disposed) return Promise.reject(new Error('desktop policy: disposed'))
    if (this.pending !== undefined) return this.pending
    if (!manual && Date.now() < this.nextCheck) return Promise.resolve(this.current)
    clearTimeout(this.timer)
    this.pending = Promise.resolve().then(async () => {
      if (this.disposed) return this.current
      const controller = new AbortController()
      this.controller = controller
      const timeout = setTimeout(() => { controller.abort() }, this.config.timeoutMs)
      this.setState({ ...this.current, checking: true })
      try {
        const isStatic = this.config.source === 'static-json'
        const url = this.config.source === 'static-json'
          ? new URL(this.config.policyUrl) : new URL('/api/v0/check_client_update', this.config.origin)
        if (!isStatic) url.searchParams.set('scenario', scenario)
        const response = await this.request(url, { ...(isStatic ? {} : { headers: this.requestHeaders() }), signal: controller.signal,
          credentials: this.config.authentication === 'feishu-test' ? 'include' : 'omit', cache: 'no-store', redirect: 'error' })
        const body: unknown = await response.json()
        if (this.config.authentication === 'feishu-test' && response.status === 401
          && record(record(body)?.error)?.code === 'UNAUTHENTICATED') {
          this.failures++
          this.setState({ ...this.current, checking: false, error: 'authentication-required' })
          return this.current
        }
        let state: DesktopPolicyState
        if (isStatic) {
          if (!response.ok) throw new Error('desktop policy: static policy request failed')
          const policy = parseDesktopStaticUpdatePolicy(body)
          const target = policy.targets[this.identity.platform === 'win32' ? 'win-x64' : this.identity.arch === 'arm64' ? 'mac-arm64' : 'mac-x64']
          if (target === undefined) throw new Error('desktop policy: installed target is absent')
          const page = desktopPolicyPage(target.downloadPage, this.config.allowedPageOrigins)
          if (page === undefined) throw new Error('desktop policy: static download page is not approved')
          // 最低支持版本决定强制更新；普通新版本由独立的 updater 清单处理。
          state = lt(this.client().version, target.minimumSupportedVersion)
            ? { blocking: true, checking: false, page, ...(target.title === undefined ? {} : { title: target.title }),
              ...(target.detail === undefined ? {} : { detail: target.detail }) }
            : { blocking: false, checking: false }
        } else state = parsePolicy(body, response.ok, this.config)
        this.failures = 0
        this.setState(state)
      } catch {
        // Transport, JSON, and protocol failures retain any previously established block.
        this.failures++
        this.setState({ ...this.current, checking: false, error: 'unavailable' })
      } finally {
        clearTimeout(timeout)
        this.controller = undefined
      }
      return this.current
    }).finally(() => {
      this.pending = undefined
      if (this.disposed) return
      const base = Math.min(this.config.maxBackoffMs, this.config.intervalMs * 2 ** Math.min(this.failures, 20))
      const delay = Math.min(this.config.maxBackoffMs, Math.round(base * (1 + this.random() * this.config.jitter)))
      this.nextCheck = Date.now() + delay
      this.timer = setTimeout(() => { void this.check('periodic') }, delay)
    })
    return this.pending
  }

  /** Abort the owned request and await settlement; late responses cannot publish or schedule work. */
  async dispose(): Promise<void> {
    this.disposed = true
    clearTimeout(this.timer)
    this.controller?.abort()
    await this.pending
  }

  private setState(state: DesktopPolicyState): void {
    if (this.disposed) return
    this.current = state
    this.publish(state)
  }
}
