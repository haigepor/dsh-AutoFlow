/** Codex compatibility version selection from configured, installed, cached and authenticated-client facts. */
import { open, realpath } from 'node:fs/promises'
import { dirname, delimiter, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'

const cacheSchema = z.object({ client_version: z.string() })
const packageSchema = z.object({ name: z.literal('@openai/codex'), version: z.string() })

function parsedVersion(value: string): { value: string; parts: number[] } | undefined {
  const matched = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(value.slice(0, 512))
  if (matched === null) return undefined
  const parts = [Number(matched[1]), Number(matched[2]), Number(matched[3])]
  return parts.every(Number.isSafeInteger) ? { value: parts.join('.'), parts } : undefined
}

/** Select the newer numeric Codex version, ignoring invalid client hints.
 * @param current Valid configured or previously selected version.
 * @param candidate Header, CLI package or cache version string.
 * @returns The version with greater major/minor/patch values, without prerelease suffixes, as Magpie selects it.
 */
export function newerCodexVersion(current: string, candidate: string): string {
  const old = parsedVersion(current), next = parsedVersion(candidate)
  if (old === undefined) throw new Error('The configured Codex compatibility version must contain major.minor.patch.')
  if (next === undefined) return old.value
  for (const index of [0, 1, 2]) {
    if (next.parts[index]! > old.parts[index]!) return next.value
    if (next.parts[index]! < old.parts[index]!) return old.value
  }
  return old.value
}

/** Local probes are optional; omitted paths resolve launch-owned locations and never credential files. */
export interface CodexVersionOptions {
  minimum: string
  discoverLocal: boolean
  probeIntervalMs: number
  maxCacheBytes: number
  cachePath?: string
  packagePaths?: readonly string[]
  now?: () => number
}

async function jsonFile(path: string, limit: number): Promise<unknown> {
  let file: Awaited<ReturnType<typeof open>>
  try { file = await open(path, 'r') } catch (_error) { return undefined /* 可选的本地版本信息不存在时使用已知版本。 */ }
  try {
    const data = Buffer.alloc(limit + 1)
    const { bytesRead } = await file.read(data, 0, data.length, 0)
    if (bytesRead > limit) return undefined
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, bytesRead)))
  } catch (_error) { return undefined /* 损坏或不可读的缓存不能阻止显式版本发起请求。 */ }
  finally { await file.close() }
}

async function installedPackages(): Promise<string[]> {
  const candidates = new Set<string>()
  for (const base of [process.env.APPDATA, process.env.PNPM_HOME, dirname(process.execPath)]) {
    if (base !== undefined) candidates.add(join(base, base === process.env.APPDATA ? 'npm/node_modules' : 'node_modules', '@openai/codex/package.json'))
  }
  const names = process.platform === 'win32' ? ['codex.cmd', 'codex.exe', 'codex'] : ['codex']
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(isAbsolute).slice(0, 128)) {
    candidates.add(join(directory, 'node_modules/@openai/codex/package.json'))
    for (const name of names) {
      let target: string
      try { target = await realpath(join(directory, name)) } catch (_error) { continue /* 只解析存在的 CLI 路径，不执行其内容。 */ }
      let parent = dirname(target)
      for (let depth = 0; depth < 7; depth++) {
        candidates.add(join(parent, 'package.json'))
        const next = dirname(parent)
        if (next === parent) break
        parent = next
      }
    }
  }
  return [...candidates]
}

/** One profile's monotonic version owner; probes and pending callers drain during disposal. */
export class CodexVersion {
  private readonly now: () => number
  private pending: Promise<void> | undefined
  private probeAt = -Infinity
  private closed = false
  private installed: string | undefined
  private cached: string | undefined
  private client: string | undefined
  private effective: string

  constructor(private options: CodexVersionOptions) {
    this.now = options.now ?? Date.now
    this.effective = newerCodexVersion(options.minimum, options.minimum)
  }

  /** Read only authenticated gateway client hints; unrelated user agents do not participate.
   * @param headers Headers after owner/gateway authentication.
   * @returns Whether the selected version increased.
   */
  observeClient(headers: Headers): boolean {
    if (this.closed) return false
    const ua = headers.get('user-agent') ?? ''
    if (!headers.get('originator') && !ua.toLowerCase().startsWith('codex')) return false
    const candidate = headers.get('version') ?? ua.slice(ua.indexOf('/') + 1)
    const next = newerCodexVersion(this.effective, candidate)
    if (next === this.effective) return false
    this.client = next; this.effective = next; return true
  }

  /** Resolve bounded local metadata at the configured cadence and combine all known versions.
   * @returns Current compatibility version; rejected after disposal begins.
   */
  async current(): Promise<string> {
    if (this.closed) throw new Error('Codex version negotiation is stopping.')
    if (this.options.discoverLocal && this.now() - this.probeAt >= this.options.probeIntervalMs) {
      this.pending ??= this.probe().finally(() => { this.pending = undefined })
    }
    await this.pending
    if (this.closed) throw new Error('Codex version negotiation is stopping.')
    return this.effective
  }

  /** Apply probe settings to future reads without lowering the selected version.
   * @param settings Validated local discovery settings.
   */
  update(settings: Pick<CodexVersionOptions, 'discoverLocal' | 'probeIntervalMs' | 'maxCacheBytes'>): void {
    if (settings.discoverLocal !== this.options.discoverLocal || settings.probeIntervalMs !== this.options.probeIntervalMs || settings.maxCacheBytes !== this.options.maxCacheBytes) this.probeAt = -Infinity
    this.options = { ...this.options, ...settings }
  }

  private async probe(): Promise<void> {
    this.probeAt = this.now()
    const cachePath = this.options.cachePath ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'models_cache.json')
    const cached = cacheSchema.safeParse(await jsonFile(cachePath, this.options.maxCacheBytes))
    const cachedVersion = cached.success ? parsedVersion(cached.data.client_version)?.value : undefined
    if (cachedVersion !== undefined) { this.cached = cachedVersion; this.effective = newerCodexVersion(this.effective, cachedVersion) }
    const paths = this.options.packagePaths ?? await installedPackages()
    for (const path of paths) {
      if (this.closed) return
      const pkg = packageSchema.safeParse(await jsonFile(path, Math.min(this.options.maxCacheBytes, 65536)))
      if (!pkg.success) continue
      const installedVersion = parsedVersion(pkg.data.version)?.value
      if (installedVersion === undefined) continue
      this.installed = this.installed === undefined ? installedVersion : newerCodexVersion(this.installed, installedVersion)
      this.effective = newerCodexVersion(this.effective, this.installed)
    }
  }

  /** Safe owner diagnostics contain versions only, never local metadata contents or paths.
   * @returns Last known version sources and the effective value without performing I/O.
   */
  status() { return { effective: this.effective, configured: this.options.minimum, ...(this.installed === undefined ? {} : { installed: this.installed }),
    ...(this.cached === undefined ? {} : { cached: this.cached }), ...(this.client === undefined ? {} : { client: this.client }) } }

  /** Stop discovery and drain its current file reads.
   * @returns Completion after the active probe settles.
   */
  async dispose(): Promise<void> { this.closed = true; await this.pending }
}
