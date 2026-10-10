/** Public Desktop policy files shared by the client and GitHub publication validator. */
import { gt, valid } from 'semver'

/** Supported platform and architecture keys in a public Desktop policy. */
export type DesktopPolicyTarget = 'win-x64' | 'mac-x64' | 'mac-arm64'

/** Version thresholds and a manual download page for one platform. */
export interface DesktopStaticPolicyTarget {
  readonly latestVersion: string
  readonly minimumSupportedVersion: string
  readonly downloadPage: string
  readonly title?: string
  readonly detail?: string
}

/** Public Nightly policy; absent targets never authorize an installed target. */
export interface DesktopStaticUpdatePolicy {
  readonly schemaVersion: 1
  readonly channel: 'nightly'
  readonly targets: Partial<Record<DesktopPolicyTarget, DesktopStaticPolicyTarget>>
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('desktop static policy: expected an object')
  return value as Record<string, unknown>
}

function version(value: unknown): string {
  if (typeof value !== 'string' || valid(value) !== value || value.includes('+')) {
    throw new Error('desktop static policy: expected a canonical semantic version without build metadata')
  }
  return value
}

/**
 * Validate public JSON before comparing versions or publishing thresholds.
 * @param input Untrusted parsed policy file.
 * @returns Validated platform policies; malformed thresholds or navigation URLs reject the entire file.
 */
export function parseDesktopStaticUpdatePolicy(input: unknown): DesktopStaticUpdatePolicy {
  const root = object(input)
  if (root.schemaVersion !== 1 || root.channel !== 'nightly') throw new Error('desktop static policy: unsupported schema or channel')
  const entries = Object.entries(object(root.targets))
  if (entries.length === 0) throw new Error('desktop static policy: targets must not be empty')
  const targets: DesktopStaticUpdatePolicy['targets'] = {}
  for (const [name, inputTarget] of entries) {
    if (name !== 'win-x64' && name !== 'mac-x64' && name !== 'mac-arm64') throw new Error('desktop static policy: unsupported target')
    const target = object(inputTarget)
    const latestVersion = version(target.latestVersion)
    const minimumSupportedVersion = version(target.minimumSupportedVersion)
    if (gt(minimumSupportedVersion, latestVersion)) throw new Error('desktop static policy: minimum version exceeds latest version')
    if (typeof target.downloadPage !== 'string' || target.downloadPage.length > 2048) throw new Error('desktop static policy: missing download page')
    const page = new URL(target.downloadPage)
    if (page.protocol !== 'https:' || page.username || page.password) throw new Error('desktop static policy: download page must use HTTPS without credentials')
    for (const [key, limit] of [['title', 256], ['detail', 16384]] as const) {
      const value = target[key]
      if (value !== undefined && (typeof value !== 'string' || value.trim() === '' || value.length > limit)) {
        throw new Error(`desktop static policy: invalid ${key}`)
      }
    }
    targets[name] = { latestVersion, minimumSupportedVersion, downloadPage: page.href,
      ...(typeof target.title === 'string' ? { title: target.title } : {}),
      ...(typeof target.detail === 'string' ? { detail: target.detail } : {}) }
  }
  return { schemaVersion: 1, channel: 'nightly', targets }
}
