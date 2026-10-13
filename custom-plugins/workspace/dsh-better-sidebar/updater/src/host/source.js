/** Version discovery uses the upstream GitHub release; executable bytes come from its exact npm version. */
import { createHash, timingSafeEqual } from 'node:crypto'
import { gt, valid, satisfies } from 'semver'

export const PACKAGE = 'dsh-better-sidebar'
export const REPOSITORY = 'omdsh-dev/DSH-better-sidebar'

/** Read one bounded response; redirects are refused rather than widening the permitted source. */
export async function readBytes(url, maximum, config, signal, fetcher = fetch) {
  const response = await fetcher(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]), redirect: 'error',
    headers: { 'User-Agent': 'AutoFlow-Better-Sidebar-Updater', Accept: 'application/json' },
  })
  if (response.status === 404) { await response.body?.cancel(); return undefined }
  if (!response.ok) { await response.body?.cancel(); throw new Error('network') }
  if (Number(response.headers.get('content-length') ?? 0) > maximum || !response.body) {
    await response.body?.cancel(); throw new Error('response-size')
  }
  const reader = response.body.getReader(), chunks = []
  let size = 0
  try {
    for (let item = await reader.read(); !item.done; item = await reader.read()) {
      signal.throwIfAborted()
      size += item.value.length
      if (size > maximum) throw new Error('response-size')
      chunks.push(Buffer.from(item.value))
    }
  } finally { await reader.cancel(); reader.releaseLock() }
  return Buffer.concat(chunks, size)
}

/** Resolve an upstream stable release and validate its exact npm package without installing anything. */
export async function discoverRelease(current, runtime, config, signal, fetcher = fetch) {
  const releaseBytes = await readBytes(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, config.jsonBytes, config, signal, fetcher)
  if (!releaseBytes) throw new Error('release-unavailable')
  const release = JSON.parse(releaseBytes.toString('utf8'))
  const tag = release.tag_name
  if (typeof tag !== 'string' || !/^v\d+\.\d+\.\d+$/.test(tag) || release.draft !== false || release.prerelease !== false) throw new Error('release-source')
  const version = tag.slice(1), releaseUrl = `https://github.com/${REPOSITORY}/releases/tag/${tag}`
  if (valid(version) !== version || release.html_url !== releaseUrl) throw new Error('release-source')
  if (!gt(version, current)) return { status: 'current', latestVersion: version, releaseUrl }
  const bytes = await readBytes(`https://registry.npmjs.org/${PACKAGE}/${version}`, config.jsonBytes, config, signal, fetcher)
  if (!bytes) return { status: 'package-pending', latestVersion: version, releaseUrl }
  const manifest = JSON.parse(bytes.toString('utf8'))
  const tarball = `https://registry.npmjs.org/${PACKAGE}/-/${PACKAGE}-${version}.tgz`
  const repositoryUrls = [`https://github.com/${REPOSITORY}`, `https://github.com/${REPOSITORY}.git`, `git+https://github.com/${REPOSITORY}.git`]
  // npm 保留上游的 HTTPS 仓库写法；只接受指向同一固定仓库的规范表示。
  if (manifest.name !== PACKAGE || manifest.version !== version || manifest.dist?.tarball !== tarball
    || manifest.repository?.type !== 'git' || !repositoryUrls.includes(manifest.repository.url)
    || typeof manifest.dist?.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(manifest.dist.integrity)) throw new Error('package-source')
  if (manifest.engines?.node && !satisfies(process.versions.node, manifest.engines.node)) return { status: 'incompatible', latestVersion: version, releaseUrl }
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (name.startsWith('@deepseek-ai/dsh-') && (typeof range !== 'string' || !satisfies(runtime, range))) {
      return { status: 'incompatible', latestVersion: version, releaseUrl }
    }
  }
  return { status: 'available', latestVersion: version, releaseUrl, tarball, integrity: manifest.dist.integrity }
}

/** Check complete tarball bytes against the npm registry's SHA-512 integrity value. */
export function verifyArchiveIntegrity(bytes, integrity) {
  const expected = Buffer.from(integrity.slice('sha512-'.length), 'base64')
  const actual = createHash('sha512').update(bytes).digest()
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('integrity')
}
