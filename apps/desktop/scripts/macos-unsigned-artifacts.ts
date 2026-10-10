/** Record and verify certificate-free macOS test installers without creating an update feed. */
import { createHash } from 'node:crypto'
import { createReadStream, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { desktopBuildRecordFilename } from './desktop-auto-update-environment.mjs'
import { validateDesktopBuildVersion } from './desktop-build-version.mjs'
import { resolveDesktopBuildCommit } from './desktop-build-commit.mjs'

/** Source/version evidence required to retain certificate-free macOS installers. */
export interface MacOSUnsignedArtifacts {
  readonly target: 'mac-arm64' | 'mac-x64'
  readonly artifactsRoot: string
  readonly version: string
  readonly productVersion: string
}

function names(options: MacOSUnsignedArtifacts): string[] {
  validateDesktopBuildVersion(options.version, options.productVersion)
  const base = `deepseek-harness-${options.version}-${options.target}-unsigned`
  return [`${base}.dmg`, `${base}.zip`]
}

async function inspect(path: string): Promise<{ size: number; sha256: string }> {
  const details = lstatSync(path)
  if (!details.isFile() || details.size === 0) throw new Error('desktop macOS test: missing nonempty regular installer')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return { size: details.size, sha256: hash.digest('hex') }
}

/**
 * Write completion only after the application signature and runtime smoke have succeeded.
 * @param options Fixed target, version, destination and observed source environment.
 * @returns Resolves after recording nonempty DMG/ZIP hashes; no update/publication metadata is generated.
 */
export async function writeMacOSUnsignedRecord(options: MacOSUnsignedArtifacts & { environment: NodeJS.ProcessEnv }): Promise<void> {
  const source = resolveDesktopBuildCommit(options.environment)
  if (source === undefined) throw new Error('desktop macOS test: missing source commit')
  const assets = []
  for (const name of names(options)) assets.push({ name, ...await inspect(join(options.artifactsRoot, name)) })
  const record = { schemaVersion: 1, target: options.target, version: options.version, environment: 'test',
    distribution: 'local-test', signing: 'ad-hoc', notarized: false, autoUpdate: false, ...source, assets }
  const destination = join(options.artifactsRoot, desktopBuildRecordFilename(options.target))
  writeFileSync(`${destination}.tmp`, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' })
  renameSync(`${destination}.tmp`, destination)
}

/**
 * Reject altered or mismatched test installers before Actions upload.
 * @param options Confirmed target, version and clean source commit.
 * @returns Exact DMG/ZIP/record allowlist after hashing every installer; never allows an update feed.
 */
export async function verifyMacOSUnsignedArtifacts(options: MacOSUnsignedArtifacts & { expectedCommit: string }): Promise<string[]> {
  const recordName = desktopBuildRecordFilename(options.target)
  const recordPath = join(options.artifactsRoot, recordName)
  if (!lstatSync(recordPath).isFile()) throw new Error('desktop macOS test: completion record must be a regular file')
  const record: unknown = JSON.parse(readFileSync(recordPath, 'utf8'))
  if (typeof record !== 'object' || record === null || !('schemaVersion' in record) || record.schemaVersion !== 1
    || !('target' in record) || record.target !== options.target || !('version' in record) || record.version !== options.version
    || !('environment' in record) || record.environment !== 'test' || !('distribution' in record) || record.distribution !== 'local-test'
    || !('signing' in record) || record.signing !== 'ad-hoc' || !('notarized' in record) || record.notarized !== false
    || !('autoUpdate' in record) || record.autoUpdate !== false || !('commit' in record) || record.commit !== options.expectedCommit
    || !('dirty' in record) || record.dirty !== false || !('assets' in record) || !Array.isArray(record.assets)
    || record.assets.length !== 2 || 'publicUrl' in record || 'provider' in record || 'pagesUrl' in record) {
    throw new Error('desktop macOS test: completion differs from the confirmed certificate-free test build')
  }
  const files = names(options)
  for (const [index, name] of files.entries()) {
    const asset: unknown = record.assets[index]
    const actual = await inspect(join(options.artifactsRoot, name))
    if (typeof asset !== 'object' || asset === null || !('name' in asset) || asset.name !== name
      || !('size' in asset) || asset.size !== actual.size || !('sha256' in asset) || asset.sha256 !== actual.sha256) {
      throw new Error('desktop macOS test: installer SHA-256 or file list differs from completion')
    }
  }
  return [...files, recordName]
}
