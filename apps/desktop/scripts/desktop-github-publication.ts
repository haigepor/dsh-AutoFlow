/** Validate Desktop artifacts and produce Pages files pointing to explicit GitHub Releases. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'
import { gt } from 'semver'
import { parseDesktopStaticUpdatePolicy, type DesktopStaticUpdatePolicy, type DesktopPolicyTarget } from '../src/static-update-policy.ts'
import { desktopBuildRecordFilename, desktopUpdateMetadataFilename, resolveDesktopAutoUpdateConfig } from './desktop-auto-update-environment.mjs'
import { validateDesktopBuildVersion } from './desktop-build-version.mjs'

/** One immutable Release attachment, verified before any upload. */
export interface DesktopGithubAsset {
  readonly path: string
  readonly name: string
  readonly size: number
  readonly sha256: string
}

/** Validated local publication; policy and feed files are committed only after assets are public. */
export interface DesktopGithubPublication {
  readonly repository: string
  readonly version: string
  readonly tag: string
  readonly commit: string
  readonly dirty: boolean
  readonly pagesUrl: string
  readonly signing: 'signed' | 'unsigned'
  readonly assets: readonly DesktopGithubAsset[]
  readonly feed: string
  readonly feedName: string
  readonly policy: DesktopStaticUpdatePolicy
  readonly target: DesktopPolicyTarget
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`desktop GitHub publication: invalid ${label}`)
  return value as Record<string, unknown>
}

async function hashes(path: string): Promise<{ sha256: string; sha512: string }> {
  const sha256 = createHash('sha256')
  const sha512 = createHash('sha512')
  for await (const chunk of createReadStream(path)) { sha256.update(chunk); sha512.update(chunk) }
  return { sha256: sha256.digest('hex'), sha512: sha512.digest('base64') }
}

/**
 * Read a completion record and verify local assets before constructing policy and feed content.
 * @param target Supported Desktop target.
 * @param options File-owned deployment settings, artifact directory, product version and optional preceding policy.
 * @returns Immutable Release assets and merged Pages content; mismatches and channel downgrades reject.
 */
export async function prepareDesktopGithubPublication(target: DesktopPolicyTarget, options: {
  environment: NodeJS.ProcessEnv
  artifactsRoot: string
  productVersion: string
  previousPolicy?: unknown
  minimumSupportedVersion?: string
}): Promise<DesktopGithubPublication> {
  const platform = target === 'win-x64' ? 'win32' : 'darwin'
  const arch = target === 'mac-arm64' ? 'arm64' : 'x64'
  const update = resolveDesktopAutoUpdateConfig(options.environment, platform, arch)
  if (update.provider !== 'github' || update.repository === undefined || update.pagesUrl === undefined) {
    throw new Error('desktop GitHub publication: configure the GitHub provider')
  }
  const record = object(JSON.parse(await readFile(join(options.artifactsRoot, desktopBuildRecordFilename(target)), 'utf8')), 'completion record')
  if (typeof record.version !== 'string') throw new Error('desktop GitHub publication: missing version')
  const version = validateDesktopBuildVersion(record.version, options.productVersion)
  const unsigned = options.environment.DSH_DESKTOP_UNSIGNED_UPDATES === '1'
  const signing = unsigned ? 'unsigned' : 'signed'
  if (record.schemaVersion !== 1 || record.target !== target || record.provider !== 'github'
    || record.repository !== update.repository || record.publicUrl !== update.publicUrl || record.pagesUrl !== update.pagesUrl
    || record.signing !== signing || (unsigned && target !== 'win-x64') || typeof record.commit !== 'string'
    || !/^[0-9a-f]{40}$/u.test(record.commit) || typeof record.dirty !== 'boolean') {
    throw new Error('desktop GitHub publication: completion record does not match the selected release')
  }
  const tag = `desktop-v${version}${unsigned ? '-unsigned' : ''}`
  const feedName = desktopUpdateMetadataFilename(version, platform)
  const feed = object(load(await readFile(join(options.artifactsRoot, feedName), 'utf8')), 'update metadata')
  if (feed.version !== version || !Array.isArray(feed.files) || feed.files.length !== 1) throw new Error('desktop GitHub publication: invalid feed version or files')
  const file = object(feed.files[0], 'update file')
  const base = `deepseek-harness-${version}-${target}${unsigned ? '-unsigned' : ''}`
  const payloadName = `${base}.${platform === 'win32' ? 'exe' : 'zip'}`
  if (file.url !== payloadName || (feed.path !== undefined && feed.path !== payloadName)) throw new Error('desktop GitHub publication: unexpected payload filename')
  const payloadPath = join(options.artifactsRoot, payloadName)
  const payloadStat = await stat(payloadPath)
  const payloadHashes = await hashes(payloadPath)
  if (!payloadStat.isFile() || payloadStat.size === 0 || payloadStat.size !== file.size || payloadHashes.sha512 !== file.sha512) {
    throw new Error('desktop GitHub publication: payload size or SHA-512 mismatch')
  }
  const assets: DesktopGithubAsset[] = [{ path: payloadPath, name: payloadName, size: payloadStat.size, sha256: payloadHashes.sha256 }]
  const additional = [`${payloadName}.blockmap`, ...(platform === 'darwin' ? [`${base}.dmg`] : [])]
  for (const name of additional) {
    const path = join(options.artifactsRoot, name)
    const details = await stat(path)
    if (!details.isFile() || details.size === 0) throw new Error('desktop GitHub publication: missing or empty attachment')
    assets.push({ path, name, size: details.size, sha256: (await hashes(path)).sha256 })
  }
  const previous = options.previousPolicy === undefined ? undefined : parseDesktopStaticUpdatePolicy(options.previousPolicy)
  const old = previous?.targets[target]
  if (old !== undefined && gt(old.latestVersion, version)) throw new Error('desktop GitHub publication: refusing a feed downgrade')
  const minimum = options.minimumSupportedVersion ?? old?.minimumSupportedVersion ?? version
  if (old !== undefined && gt(old.minimumSupportedVersion, minimum)) {
    throw new Error('desktop GitHub publication: refusing to lower the minimum supported version')
  }
  const policy = parseDesktopStaticUpdatePolicy({ schemaVersion: 1, channel: 'nightly', targets: {
    ...previous?.targets, [target]: { ...old, latestVersion: version, minimumSupportedVersion: minimum,
      downloadPage: `https://github.com/${update.repository}/releases/tag/${tag}` } } })
  const payloadUrl = `https://github.com/${update.repository}/releases/download/${tag}/${encodeURIComponent(payloadName)}`
  return { repository: update.repository, version, tag, commit: record.commit, dirty: record.dirty,
    pagesUrl: update.pagesUrl, signing, assets, feedName, target, policy,
    feed: dump({ ...feed, files: [{ ...file, url: payloadUrl }],
      ...(feed.path === undefined ? {} : { path: payloadUrl }) }, { lineWidth: -1 }) }
}
