/** Source-specific GitHub release discovery and verified private tarball caching. */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, lstatSync } from 'node:fs'
import { mkdir, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, resolve } from 'node:path'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { gt, rcompare, valid } from 'semver'
import { Parser } from 'tar'
import z from 'zod'
import type { DshBundleUpdateSource } from '@deepseek-ai/dsh-package-manifest'
import type { ProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { ArtifactDownload, type ArtifactDownloadConfig } from './artifact-download.ts'
import type { ArtifactDownloadChoice, ArtifactDownloadProgress } from './artifact-download-types.ts'
import { UpdateMetadata, UpdateMetadataError } from './update-metadata.ts'

/** Deployment bounds for official metadata, public archive transfers and expanded content. */
export interface UpdateLimits {
  /** Deadline for one official metadata response. */
  timeoutMs: number
  /** Maximum JSON document bytes. */
  jsonBytes: number
  /** Maximum compressed archive bytes. */
  archiveBytes: number
  /** Maximum expanded archive bytes, including padding. */
  expandedBytes: number
  /** Maximum release-list pages before refusing an incomplete result. */
  releasePages: number
  /** Network controls for verified public archive bytes. */
  download: Omit<ArtifactDownloadConfig, 'directory'> & {
    /** Public byte route, independent from official metadata requests. */
    source: ArtifactDownloadChoice
  }
}

/** Public bytes use HTTPS without account headers, cookies or HTTPS-to-HTTP redirects. */
async function publicArchiveFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  let url = new URL(input instanceof Request ? input.url : input)
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') throw new Error('Plugin archive redirects require public HTTPS')
    const response = await fetch(url, { ...init, credentials: 'omit', redirect: 'manual' })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    await response.body?.cancel()
    const target = response.headers.get('location')
    if (target === null) throw new Error('Plugin archive redirect has no destination')
    url = new URL(target, url)
  }
  throw new Error('Too many plugin archive redirects')
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
const indexSchema = z.object({ schemaVersion: z.literal(1), repository: z.string(), generatedAt: z.iso.datetime(),
  plugins: z.array(metadataSchema).max(1000) }).strict()

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

function exactDownload(source: DshBundleUpdateSource, tag: string, name: string, url: string): void {
  if (url !== `https://github.com/${source.repository}/releases/download/${tag}/${name}`) throw new Error('Release asset URL does not match the declared source')
}

/** Find the newest stable release in one bundle family and validate newer metadata.
 * @param name Declared package name.
 * @param version Installed package version.
 * @param source Validated package-owned GitHub source.
 * @param limits Deployment network bounds.
 * @param signal Owner cancellation signal.
 * @param metadata Profile-owned request sharing, cache and persisted cooldowns.
 * @returns A verified newer release, or undefined when no newer version exists.
 */
export async function discoverBundleUpdate(
  name: string, version: string, source: DshBundleUpdateSource, limits: UpdateLimits, signal: AbortSignal, metadata: UpdateMetadata,
): Promise<BundleUpdateRelease | undefined> {
  signal.throwIfAborted()
  if (valid(version) !== version) throw new Error('Installed bundle has no valid SemVer')
  const indexUrl = metadata.indexUrl(source.repository)
  if (indexUrl !== undefined) {
    const document = await metadata.read(indexUrl)
    try {
      const index = indexSchema.parse(JSON.parse(document.bytes.toString('utf8')))
      if (index.repository !== source.repository || new Set(index.plugins.map(item => item.package)).size !== index.plugins.length) {
        throw new Error('Update index repository or package identities differ')
      }
      const entry = index.plugins.find(item => item.package === name)
      if (entry === undefined || entry.repository !== source.repository || valid(entry.version) !== entry.version
        || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(entry.version)
        || entry.tag !== `${source.tagPrefix}${entry.version}` || entry.asset.size > limits.archiveBytes
        || entry.asset.name !== `${name}-${entry.version}.tgz`) throw new Error('Update index package, tag or archive identity differs')
      exactDownload(source, entry.tag, entry.asset.name, entry.asset.url)
      await metadata.remember(source.repository, name, { checkedAt: document.checkedAt, version: entry.version })
      return gt(entry.version, version) ? { metadata: entry, releaseUrl: `https://github.com/${source.repository}/releases/tag/${entry.tag}` } : undefined
    } catch (error) {
      if (error instanceof UpdateMetadataError) throw error
      throw metadata.rejectDocument(indexUrl, error)
    }
  }
  const releases: z.infer<typeof releaseSchema>[] = []
  let exhausted = false
  let checkedAt = Date.now()
  for (let page = 1; page <= limits.releasePages; page++) {
    const document = await metadata.read(`https://api.github.com/repos/${source.repository}/releases?per_page=100&page=${page}`)
    checkedAt = Math.min(checkedAt, document.checkedAt)
    const rows = z.array(releaseSchema).parse(JSON.parse(document.bytes.toString('utf8')))
    releases.push(...rows.filter(row => !row.draft && !row.prerelease && row.tag_name.startsWith(source.tagPrefix)
      && /^\d+\.\d+\.\d+$/.test(row.tag_name.slice(source.tagPrefix.length))
      && valid(row.tag_name.slice(source.tagPrefix.length)) !== null))
    if (rows.length < 100) { exhausted = true; break }
  }
  if (!exhausted) throw new Error('GitHub release pagination exceeds its configured bound')
  releases.sort((a, b) => rcompare(a.tag_name.slice(source.tagPrefix.length), b.tag_name.slice(source.tagPrefix.length)))
  const release = releases[0]
  if (release === undefined || !gt(release.tag_name.slice(source.tagPrefix.length), version)) {
    await metadata.remember(source.repository, name, { checkedAt,
      ...(release === undefined ? {} : { version: release.tag_name.slice(source.tagPrefix.length) }) })
    return undefined
  }
  const metadataAsset = release.assets.find(asset => asset.name === source.metadataAsset)
  if (metadataAsset === undefined || metadataAsset.size > limits.jsonBytes) throw new Error('Release has no bounded update metadata asset')
  exactDownload(source, release.tag_name, metadataAsset.name, metadataAsset.browser_download_url)
  const metadataBytes = (await metadata.read(metadataAsset.browser_download_url)).bytes
  if (metadataBytes.length !== metadataAsset.size
    || metadataAsset.digest !== `sha256:${createHash('sha256').update(metadataBytes).digest('hex')}`) {
    throw new Error('Update metadata bytes differ from the release asset')
  }
  const entry = metadataSchema.parse(JSON.parse(metadataBytes.toString('utf8')))
  const archive = release.assets.find(asset => asset.name === entry.asset.name)
  if (entry.package !== name || entry.repository !== source.repository || entry.tag !== release.tag_name
    || entry.tag !== `${source.tagPrefix}${entry.version}` || valid(entry.version) !== entry.version
    || archive === undefined || entry.asset.size !== archive.size || archive.size > limits.archiveBytes
    || archive.digest !== `sha256:${entry.asset.sha256}` || !/^[A-Za-z0-9_.-]+\.tgz$/.test(entry.asset.name)) {
    throw new Error('Release metadata or archive identity does not match')
  }
  exactDownload(source, entry.tag, archive.name, entry.asset.url)
  if (entry.asset.url !== archive.browser_download_url || release.html_url !== `https://github.com/${source.repository}/releases/tag/${entry.tag}`) {
    throw new Error('Release URL does not match the declared source')
  }
  const reference = z.object({ object: z.object({ type: z.string(), sha: z.string() }) })
  let target = reference.parse(JSON.parse((await metadata.read(`https://api.github.com/repos/${source.repository}/git/ref/tags/${encodeURIComponent(entry.tag)}`)).bytes.toString('utf8'))).object
  for (let depth = 0; target.type === 'tag' && depth < 4; depth++) {
    target = reference.parse(JSON.parse((await metadata.read(`https://api.github.com/repos/${source.repository}/git/tags/${target.sha}`)).bytes.toString('utf8'))).object
  }
  if (target.type !== 'commit' || target.sha !== entry.sourceCommit) throw new Error('Update source commit does not match its Git tag')
  await metadata.remember(source.repository, name, { checkedAt, version: entry.version })
  return { metadata: entry, releaseUrl: release.html_url }
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
  return validateBundleArchive(file, release.metadata.package, release.metadata.version, limits, signal)
}

/** Inspect one verified npm archive without extracting or executing its code.
 * @param file Local compressed archive whose integrity was checked by its source owner.
 * @param name Expected npm package name.
 * @param version Expected exact package version.
 * @param limits Expanded-content and JSON bounds.
 * @param signal Operation lifetime.
 * @returns Package declaration with matching identity and present bundle patch.
 */
export async function validateBundleArchive(
  file: string, name: string, version: string, limits: UpdateLimits, signal: AbortSignal,
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
  const identity = z.object({ name: z.literal(name), version: z.literal(version),
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
 * @param publish Measured archive progress; metadata and package installation have no byte percentage.
 * @returns Persistent tarball path and validated manifest.
 */
export async function cacheBundleUpdate(
  profileDir: string, release: BundleUpdateRelease, limits: UpdateLimits, signal: AbortSignal,
  publish: (progress: ArtifactDownloadProgress) => void = () => {},
): Promise<{ file: string; manifest: ProfileManifest }> {
  allowedUrl(release.metadata.asset.url)
  if (release.metadata.asset.size > limits.archiveBytes) throw new Error('Plugin archive exceeds its byte bound')
  const cache = updateCacheDirectory(profileDir)
  await mkdir(cache, { recursive: true, mode: 0o700 })
  const directory = join(cache, release.metadata.asset.sha256)
  if (existsSync(directory) && !lstatSync(directory).isDirectory()) throw new Error('Invalid plugin archive cache directory')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, release.metadata.asset.name)
  return withFileLock(file, async () => {
    const transferDirectory = join(directory, 'transfer')
    if (existsSync(transferDirectory) && (!lstatSync(transferDirectory).isDirectory() || lstatSync(transferDirectory).isSymbolicLink())) {
      throw new Error('Invalid plugin transfer cache directory')
    }
    const download = new ArtifactDownload({ ...limits.download, directory: transferDirectory }, publicArchiveFetch, publish)
    await download.initialize()
    await download.select(limits.download.source)
    const staged = join(directory, 'verified-download.tmp')
    let manifest: ProfileManifest
    try {
      if (existsSync(file)) {
        const stat = lstatSync(file)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== release.metadata.asset.size) throw new Error('Invalid cached plugin archive')
        const hash = createHash('sha256')
        for await (const chunk of createReadStream(file, { signal })) {
          if (!Buffer.isBuffer(chunk)) throw new Error('Invalid plugin archive stream')
          hash.update(chunk)
        }
        if (hash.digest('hex') !== release.metadata.asset.sha256) throw new Error('Plugin update SHA-256 verification failed')
        publish({ ...download.state, stage: 'verifying', transferred: stat.size, total: stat.size })
        manifest = await validateUpdateArchive(file, release, limits, signal)
      } else {
        if (existsSync(staged) && (!lstatSync(staged).isFile() || lstatSync(staged).isSymbolicLink())) {
          throw new Error('Invalid plugin staging file')
        }
        await download.download({ url: new URL(release.metadata.asset.url), version: release.metadata.version,
          size: release.metadata.asset.size,
          checksum: { algorithm: 'sha256', value: release.metadata.asset.sha256 } }, staged, signal)
        manifest = await validateUpdateArchive(staged, release, limits, signal)
        signal.throwIfAborted()
        await rename(staged, file)
      }
      await download.complete()
      return { file, manifest }
    } finally {
      download.dispose()
      try { await unlink(staged) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }, { signal, waitMs: limits.timeoutMs })
}
