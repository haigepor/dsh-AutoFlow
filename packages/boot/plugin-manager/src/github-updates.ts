/** Source-specific GitHub release discovery and verified private tarball caching. */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, lstatSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, resolve } from 'node:path'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { gt, rcompare, valid } from 'semver'
import { Parser } from 'tar'
import z from 'zod'
import type { DshBundleUpdateSource } from '@deepseek-ai/dsh-package-manifest'
import type { ProfileManifest } from '@deepseek-ai/dsh-app-boot'

/** Deployment bounds applied to complete remote responses and expanded archives. */
export interface UpdateLimits {
  timeoutMs: number
  jsonBytes: number
  archiveBytes: number
  expandedBytes: number
  releasePages: number
}

const assetSchema = z.object({ name: z.string(), browser_download_url: z.string(),
  size: z.number().int().nonnegative(), digest: z.string().nullable() })
const releaseSchema = z.object({ tag_name: z.string(), draft: z.boolean(), prerelease: z.boolean(),
  html_url: z.string(), assets: z.array(assetSchema) })
const metadataSchema = z.object({
  schemaVersion: z.literal(1), package: z.string(), version: z.string(), repository: z.string(),
  channel: z.literal('stable'), tag: z.string(), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), sourceDirty: z.literal(false),
  asset: z.object({ name: z.string(), url: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive() }),
})

/** Identity verified against the declared source, release assets and tag commit. */
export interface BundleUpdateRelease {
  metadata: z.infer<typeof metadataSchema>
  releaseUrl: string
}

function allowedUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== ''
    || !['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) {
    throw new Error('Update request must use an official GitHub HTTPS endpoint')
  }
  return url
}

async function fetchBytes(value: string, maximum: number, limits: UpdateLimits, signal: AbortSignal): Promise<Buffer> {
  const abort = AbortSignal.any([signal, AbortSignal.timeout(limits.timeoutMs)])
  let url = allowedUrl(value)
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, { signal: abort, redirect: 'manual', headers: { 'User-Agent': 'dsh-plugin-updates', Accept: 'application/vnd.github+json' } })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const target = response.headers.get('location')
      if (target === null) throw new Error('GitHub redirect has no destination')
      url = allowedUrl(new URL(target, url).href)
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`GitHub update request failed: HTTP ${response.status}`)
    }
    if (Number(response.headers.get('content-length') ?? 0) > maximum) {
      await response.body?.cancel()
      throw new Error('Update response exceeds its byte bound')
    }
    if (response.body === null) throw new Error('Empty GitHub update response')
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let size = 0
    try {
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        abort.throwIfAborted()
        size += next.value.length
        if (size > maximum) throw new Error('Update response exceeds its byte bound')
        chunks.push(Buffer.from(next.value))
      }
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
    return Buffer.concat(chunks, size)
  }
  throw new Error('Too many GitHub update redirects')
}

async function json(value: string, limits: UpdateLimits, signal: AbortSignal): Promise<unknown> {
  return JSON.parse((await fetchBytes(value, limits.jsonBytes, limits, signal)).toString('utf8'))
}

function exactDownload(source: DshBundleUpdateSource, tag: string, name: string, url: string): void {
  if (url !== `https://github.com/${source.repository}/releases/download/${tag}/${name}`) throw new Error('Release asset URL does not match the declared source')
}

/** Find the newest stable release in one bundle family and validate newer metadata.
 * @param name Declared package name.
 * @param version Installed package version.
 * @param source Validated package-owned GitHub source.
 * @param limits Deployment network bounds.
 * @param signal Owner cancellation signal.
 * @returns A verified newer release, or undefined when no newer version exists.
 */
export async function discoverBundleUpdate(
  name: string, version: string, source: DshBundleUpdateSource, limits: UpdateLimits, signal: AbortSignal,
): Promise<BundleUpdateRelease | undefined> {
  if (valid(version) !== version) throw new Error('Installed bundle has no valid SemVer')
  const releases: z.infer<typeof releaseSchema>[] = []
  let exhausted = false
  for (let page = 1; page <= limits.releasePages; page++) {
    const rows = z.array(releaseSchema).parse(await json(`https://api.github.com/repos/${source.repository}/releases?per_page=100&page=${page}`, limits, signal))
    releases.push(...rows.filter(row => !row.draft && !row.prerelease && row.tag_name.startsWith(source.tagPrefix)
      && /^\d+\.\d+\.\d+$/.test(row.tag_name.slice(source.tagPrefix.length))
      && valid(row.tag_name.slice(source.tagPrefix.length)) !== null))
    if (rows.length < 100) { exhausted = true; break }
  }
  if (!exhausted) throw new Error('GitHub release pagination exceeds its configured bound')
  releases.sort((a, b) => rcompare(a.tag_name.slice(source.tagPrefix.length), b.tag_name.slice(source.tagPrefix.length)))
  const release = releases[0]
  if (release === undefined || !gt(release.tag_name.slice(source.tagPrefix.length), version)) return undefined
  const metadataAsset = release.assets.find(asset => asset.name === source.metadataAsset)
  if (metadataAsset === undefined || metadataAsset.size > limits.jsonBytes) throw new Error('Release has no bounded update metadata asset')
  exactDownload(source, release.tag_name, metadataAsset.name, metadataAsset.browser_download_url)
  const metadataBytes = await fetchBytes(metadataAsset.browser_download_url, limits.jsonBytes, limits, signal)
  if (metadataBytes.length !== metadataAsset.size
    || metadataAsset.digest !== `sha256:${createHash('sha256').update(metadataBytes).digest('hex')}`) {
    throw new Error('Update metadata bytes differ from the release asset')
  }
  const metadata = metadataSchema.parse(JSON.parse(metadataBytes.toString('utf8')))
  const archive = release.assets.find(asset => asset.name === metadata.asset.name)
  if (metadata.package !== name || metadata.repository !== source.repository || metadata.tag !== release.tag_name
    || metadata.tag !== `${source.tagPrefix}${metadata.version}` || valid(metadata.version) !== metadata.version
    || archive === undefined || metadata.asset.size !== archive.size || archive.size > limits.archiveBytes
    || archive.digest !== `sha256:${metadata.asset.sha256}` || !/^[A-Za-z0-9_.-]+\.tgz$/.test(metadata.asset.name)) {
    throw new Error('Release metadata or archive identity does not match')
  }
  exactDownload(source, metadata.tag, archive.name, metadata.asset.url)
  if (metadata.asset.url !== archive.browser_download_url || release.html_url !== `https://github.com/${source.repository}/releases/tag/${metadata.tag}`) {
    throw new Error('Release URL does not match the declared source')
  }
  const reference = z.object({ object: z.object({ type: z.string(), sha: z.string() }) })
  let target = reference.parse(await json(`https://api.github.com/repos/${source.repository}/git/ref/tags/${encodeURIComponent(metadata.tag)}`, limits, signal)).object
  for (let depth = 0; target.type === 'tag' && depth < 4; depth++) {
    target = reference.parse(await json(`https://api.github.com/repos/${source.repository}/git/tags/${target.sha}`, limits, signal)).object
  }
  if (target.type !== 'commit' || target.sha !== metadata.sourceCommit) throw new Error('Update source commit does not match its Git tag')
  return { metadata, releaseUrl: release.html_url }
}

/** Reject linked cache paths before writing files managed by this profile.
 * @param profileDir Absolute owner directory.
 * @returns Contained cache directory.
 */
export function updateCacheDirectory(profileDir: string): string {
  if (!isAbsolute(profileDir)) throw new Error('Plugin update storage requires an absolute profile directory')
  const owner = resolve(profileDir)
  const path = join(owner, '.plugin-updates', 'packages')
  for (let current = path; current !== dirname(owner); current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Refusing linked plugin update storage')
    if (current === owner) break
  }
  return path
}

/** Inspect tar content without extracting or executing package code.
 * @param file Verified compressed archive.
 * @param release Expected package identity.
 * @param limits Total expanded-content bounds.
 * @param signal Owner cancellation signal.
 * @returns Parsed package declaration accepted for installation.
 */
export async function validateUpdateArchive(
  file: string, release: BundleUpdateRelease, limits: UpdateLimits, signal: AbortSignal,
): Promise<ProfileManifest> {
  signal.throwIfAborted()
  const paths = new Set<string>()
  const manifest: Buffer[] = []
  let expanded = 0
  const parser = new Parser({ strict: true, maxMetaEntrySize: limits.jsonBytes, onReadEntry(entry) {
    expanded += entry.size + 512
    const path = entry.path.replace(/\/$/, '')
    if (expanded > limits.expandedBytes || !(path.startsWith('package/') || path === 'package' && entry.type === 'Directory') || path.includes('\\')
      || path.split('/').some(part => part === '..' || part === '.' || part === '')
      || posix.normalize(path) !== path || !['File', 'Directory'].includes(entry.type) || paths.has(path)) {
      parser.abort(new Error('Invalid or oversized update archive entry'))
      return
    }
    paths.add(path)
    if (path === 'package/package.json') {
      if (entry.size > limits.jsonBytes) { parser.abort(new Error('Oversized package manifest')); return }
      else entry.on('data', (chunk) => { manifest.push(chunk) })
    }
    entry.resume()
  } })
  let expandedBytes = 0
  // tar Parser 不提供 Node Writable 的销毁协议，适配层让取消同时关闭文件和解压流。
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      expandedBytes += chunk.length
      if (expandedBytes > limits.expandedBytes) { callback(new Error('Expanded update archive exceeds its byte bound')); return }
      if (parser.write(chunk)) callback()
      else parser.once('drain', callback)
    },
    final(callback) { parser.once('end', callback); parser.end() },
    destroy(error, callback) { if (error !== null) parser.abort(error); callback(error) },
  })
  parser.on('error', (error: Error) => sink.destroy(error))
  try {
    await pipeline(createReadStream(file), createGunzip(), sink, { signal })
  } catch (error) { signal.throwIfAborted(); throw error }
  const value: unknown = JSON.parse(Buffer.concat(manifest).toString('utf8'))
  const identity = z.object({ name: z.literal(release.metadata.package), version: z.literal(release.metadata.version),
    dsh: z.object({ bundle: z.object({ patch: z.union([z.string(), z.array(z.string()).min(1)]) }) }) }).parse(value)
  for (const patch of typeof identity.dsh.bundle.patch === 'string' ? [identity.dsh.bundle.patch] : identity.dsh.bundle.patch) {
    const path = patch.replace(/^\.\//, '')
    if (path.includes('..') || !paths.has(`package/${path}`)) throw new Error('Update archive has no declared bundle patch')
  }
  return value as ProfileManifest
}

/** Download exact bytes into the retained private cache and validate the package.
 * @param profileDir Owner of the file dependency.
 * @param release Verified public release.
 * @param limits Download and archive bounds.
 * @param signal Owner cancellation.
 * @returns Persistent tarball path and validated manifest.
 */
export async function cacheBundleUpdate(
  profileDir: string, release: BundleUpdateRelease, limits: UpdateLimits, signal: AbortSignal,
): Promise<{ file: string; manifest: ProfileManifest }> {
  const cache = updateCacheDirectory(profileDir)
  await mkdir(cache, { recursive: true, mode: 0o700 })
  const directory = join(cache, release.metadata.asset.sha256)
  if (existsSync(directory) && !lstatSync(directory).isDirectory()) throw new Error('Invalid plugin archive cache directory')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, release.metadata.asset.name)
  let bytes: Buffer
  if (existsSync(file)) {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.size > limits.archiveBytes) throw new Error('Invalid cached plugin archive')
    bytes = await readFile(file)
  }
  else bytes = await fetchBytes(release.metadata.asset.url, limits.archiveBytes, limits, signal)
  signal.throwIfAborted()
  if (bytes.length !== release.metadata.asset.size || createHash('sha256').update(bytes).digest('hex') !== release.metadata.asset.sha256) {
    throw new Error('Plugin update size or SHA-256 verification failed')
  }
  if (!existsSync(file)) {
    try { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  if (!lstatSync(file).isFile()) throw new Error('Invalid cached plugin archive')
  return { file, manifest: await validateUpdateArchive(file, release, limits, signal) }
}
