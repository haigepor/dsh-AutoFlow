/** Verify public plugin releases before atomically merging the official Pages index. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const INDEX_PATH = 'plugins/stable/index.json'
const PAGES_BRANCH = 'desktop-updates'
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u

function compare(a, b) {
  const left = a.split('.').map(BigInt), right = b.split('.').map(BigInt)
  for (let i = 0; i < 3; i++) { if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1 }
  return 0
}

function validateEntry(value, repository) {
  assert.equal(value.schemaVersion, 1)
  assert.equal(value.repository, repository)
  assert.equal(value.channel, 'stable')
  assert.equal(value.sourceDirty, false)
  assert.match(value.package, /^[a-z0-9][a-z0-9._-]*$/u)
  assert.match(value.version, STABLE)
  assert(value.version.split('.').every(part => Number.isSafeInteger(Number(part))), 'Unsupported package version')
  assert.match(value.sourceCommit, /^[a-f0-9]{40}$/u)
  assert.equal(typeof value.tag, 'string')
  assert(value.tag.endsWith(value.version))
  assert.match(value.asset.sha256, /^[a-f0-9]{64}$/u)
  assert(Number.isSafeInteger(value.asset.size) && value.asset.size > 0 && value.asset.size <= 67108864)
  assert.equal(value.asset.name, `${value.package}-${value.version}.tgz`)
  assert.equal(value.asset.url, `https://github.com/${repository}/releases/download/${value.tag}/${value.asset.name}`)
  return { schemaVersion: 1, package: value.package, version: value.version, repository, channel: 'stable',
    tag: value.tag, sourceCommit: value.sourceCommit, sourceDirty: false,
    asset: { name: value.asset.name, url: value.asset.url, sha256: value.asset.sha256, size: value.asset.size } }
}

/** Merge verified families without downgrading versions or replacing different bytes under an existing identity.
 * @param {object|undefined} previous Existing official index.
 * @param {object[]} candidates Verified published release metadata.
 * @param {string} repository GitHub owner/repository.
 * @param {string} generatedAt New index timestamp.
 * @returns {object} Complete index retaining other plugin families.
 */
export function mergeUpdateIndex(previous, candidates, repository, generatedAt) {
  assert(Number.isFinite(Date.parse(generatedAt)), 'Invalid index timestamp')
  const entries = new Map()
  if (previous !== undefined) {
    assert.equal(previous.schemaVersion, 1)
    assert.equal(previous.repository, repository)
    assert.equal(typeof previous.generatedAt, 'string')
    assert(Number.isFinite(Date.parse(previous.generatedAt)), 'Invalid existing index timestamp')
    assert(Array.isArray(previous.plugins) && previous.plugins.length <= 1000)
    for (const value of previous.plugins) {
      const entry = validateEntry(value, repository)
      assert(!entries.has(entry.package), 'Duplicate package in existing index')
      entries.set(entry.package, entry)
    }
  }
  for (const value of candidates) {
    const entry = validateEntry(value, repository)
    const old = entries.get(entry.package)
    if (old !== undefined && compare(old.version, entry.version) > 0) continue
    if (old !== undefined && old.version === entry.version) assert.deepEqual(entry, old, 'Published plugin identity is immutable')
    entries.set(entry.package, entry)
  }
  assert(entries.size > 0 && entries.size <= 1000, 'No bounded published plugin families')
  const plugins = [...entries.values()].sort((a, b) => a.package.localeCompare(b.package, 'en'))
  const unchanged = previous !== undefined && JSON.stringify(plugins) === JSON.stringify(previous.plugins)
  return { schemaVersion: 1, repository, generatedAt: unchanged ? previous.generatedAt : generatedAt, plugins }
}

async function publicResponse(url, request) {
  let target = new URL(url)
  for (let count = 0; count <= 5; count++) {
    assert(target.protocol === 'https:' && !target.username && !target.password && !target.port)
    assert(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname))
    const response = await request(target, { credentials: 'omit', redirect: 'manual', signal: AbortSignal.timeout(60000) })
    if (![301, 302, 303, 307, 308].includes(response.status)) { assert(response.ok, `Public attachment unavailable: HTTP ${response.status}`); return response }
    await response.body?.cancel()
    const next = response.headers.get('location')
    assert(next, 'Public attachment redirect has no destination')
    target = new URL(next, target)
  }
  throw new Error('Too many public attachment redirects')
}

async function publicBytes(url, maximum, request) {
  const response = await publicResponse(url, request)
  assert(response.body, 'Empty public attachment')
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    assert(size <= maximum, 'Public attachment exceeds its bound')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, size)
}

/** Verify Release visibility, metadata digest, immutable tag source and the complete public archive.
 * @param {string} repository GitHub owner/repository.
 * @param {object} source Package-owned name and GitHub family declaration.
 * @param {object} release Public Release API response.
 * @param {Function} api Authenticated GitHub API transport, used only inside the publisher.
 * @param {Function} request Public attachment transport without account headers.
 * @returns {Promise<object>} Metadata safe to merge into the official index.
 */
export async function verifyPublishedPlugin(repository, source, release, api, request = fetch) {
  assert.equal(release.draft, false)
  assert.equal(release.prerelease, false)
  const metadataAsset = release.assets.find(asset => asset.name === source.metadataAsset)
  assert(metadataAsset && metadataAsset.state === 'uploaded', 'Missing public update metadata')
  const metadataUrl = `https://github.com/${repository}/releases/download/${release.tag_name}/${source.metadataAsset}`
  assert.equal(metadataAsset.browser_download_url, metadataUrl)
  const bytes = await publicBytes(metadataUrl, 1048576, request)
  assert.equal(bytes.length, metadataAsset.size)
  assert.equal(metadataAsset.digest, `sha256:${createHash('sha256').update(bytes).digest('hex')}`)
  const entry = validateEntry(JSON.parse(bytes.toString('utf8')), repository)
  assert.equal(entry.package, source.name)
  assert.equal(entry.tag, `${source.tagPrefix}${entry.version}`)
  assert.equal(entry.tag, release.tag_name)
  assert.equal(release.html_url, `https://github.com/${repository}/releases/tag/${entry.tag}`)
  const asset = release.assets.find(asset => asset.name === entry.asset.name)
  assert(asset && asset.state === 'uploaded', 'Missing public plugin archive')
  assert.equal(asset.browser_download_url, entry.asset.url)
  assert.equal(asset.size, entry.asset.size)
  assert.equal(asset.digest, `sha256:${entry.asset.sha256}`)
  let target = (await api(`/repos/${repository}/git/ref/tags/${encodeURIComponent(entry.tag)}`))?.object
  for (let depth = 0; target?.type === 'tag' && depth < 4; depth++) {
    assert.match(target.sha, /^[a-f0-9]{40}$/u)
    target = (await api(`/repos/${repository}/git/tags/${target.sha}`))?.object
  }
  assert(target?.type === 'commit' && target.sha === entry.sourceCommit, 'Release tag source differs from metadata')
  const response = await publicResponse(entry.asset.url, request)
  assert(response.body)
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    assert(size <= entry.asset.size, 'Public archive exceeds its declared size')
    hash.update(chunk)
  }
  assert.equal(size, entry.asset.size)
  assert.equal(hash.digest('hex'), entry.asset.sha256)
  return entry
}

/** Read the workspace's independently published plugin families without a second package inventory.
 * @param {string} workspace Absolute custom-plugins/workspace directory.
 * @param {string} repository Publication repository.
 * @returns {Promise<object[]>} Declared sources belonging to this repository.
 */
export async function readIndexSources(workspace, repository) {
  const sources = []
  for (const directory of await readdir(workspace, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue
    const manifest = JSON.parse(await readFile(resolve(workspace, directory.name, 'package.json'), 'utf8'))
    const source = manifest.dsh?.bundle?.update
    if (source?.provider === 'github' && source.repository === repository) {
      assert.match(source.tagPrefix, /^[a-z0-9-]+$/u)
      assert.match(source.metadataAsset, /^[a-z0-9-]+\.json$/u)
      sources.push({ name: manifest.name, ...source })
    }
  }
  assert(sources.length > 0, 'No independently published plugin sources')
  return sources
}

/** Resolve each family's newest public stable Release and verify all selected bytes.
 * @param {string} repository Publication repository.
 * @param {object[]} sources Declared plugin release families.
 * @param {Function} api Authenticated GitHub API transport.
 * @param {Function} request Anonymous public attachment transport.
 * @returns {Promise<object[]>} Independently verified newest metadata entries.
 */
export async function collectPublishedPlugins(repository, sources, api, request = fetch) {
  const releases = []
  let exhausted = false
  for (let page = 1; page <= 100; page++) {
    const rows = await api(`/repos/${repository}/releases?per_page=100&page=${page}`)
    assert(Array.isArray(rows), 'Invalid public Release list')
    releases.push(...rows.filter(row => !row.draft && !row.prerelease))
    if (rows.length < 100) { exhausted = true; break }
  }
  assert(exhausted, 'Release pagination exceeds its bound')
  const entries = []
  for (const source of sources) {
    const matches = releases.filter(row => row.tag_name.startsWith(source.tagPrefix) && STABLE.test(row.tag_name.slice(source.tagPrefix.length)))
      .sort((a, b) => compare(b.tag_name.slice(source.tagPrefix.length), a.tag_name.slice(source.tagPrefix.length)))
    if (matches[0] !== undefined) entries.push(await verifyPublishedPlugin(repository, source, matches[0], api, request))
  }
  assert(entries.length > 0, 'No verified public plugin releases')
  return entries
}

/** Atomically merge verified plugin entries into the existing Pages tree, retrying bounded concurrent movement.
 * @param {object} options Repository, verified entries and optional retry budget/time.
 * @param {Function} api Authenticated Git data API transport.
 * @returns {Promise<object>} Public index URL and committed metadata; unrelated tree paths are retained.
 */
export async function publishUpdateIndex({ repository, entries, attempts = 3, generatedAt = new Date().toISOString() }, api) {
  assert.match(repository, /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u)
  assert(Number.isInteger(attempts) && attempts >= 1 && attempts <= 10)
  const prefix = `/repos/${repository}`
  assert.equal((await api(prefix))?.private, false, 'Plugin updates require a public repository')
  const pages = await api(`${prefix}/pages`)
  assert(pages?.source?.branch === PAGES_BRANCH && pages.source.path === '/', 'Refusing to replace another Pages site')
  const refPath = `${prefix}/git/refs/heads/${PAGES_BRANCH}`
  for (let attempt = 0; attempt < attempts; attempt++) {
    const head = (await api(refPath))?.object?.sha
    assert.match(head ?? '', /^[a-f0-9]{40}$/u)
    const old = await api(`${prefix}/contents/${INDEX_PATH}?ref=${head}`)
    assert(old === undefined || old.encoding === 'base64', 'Invalid existing index encoding')
    const previous = old === undefined ? undefined : JSON.parse(Buffer.from(old.content, 'base64').toString('utf8'))
    const index = mergeUpdateIndex(previous, entries, repository, generatedAt)
    if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(index)) {
      await api(`${prefix}/pages/builds`, 'POST')
      return { url: `https://${repository.split('/')[0]}.github.io/${repository.split('/')[1]}/${INDEX_PATH}`, index, commit: head }
    }
    const base = await api(`${prefix}/git/commits/${head}`)
    assert.match(base?.tree?.sha ?? '', /^[a-f0-9]{40}$/u)
    const blob = await api(`${prefix}/git/blobs`, 'POST', { content: JSON.stringify(index, null, 2) + '\n', encoding: 'utf-8' })
    const tree = await api(`${prefix}/git/trees`, 'POST', { base_tree: base.tree.sha,
      tree: [{ path: INDEX_PATH, mode: '100644', type: 'blob', sha: blob.sha }] })
    const commit = await api(`${prefix}/git/commits`, 'POST', { message: 'Publish verified custom plugin update index', tree: tree.sha, parents: [head] })
    try { await api(refPath, 'PATCH', { sha: commit.sha, force: false }) }
    catch (error) {
      if (![409, 422].includes(error.status) || attempt + 1 === attempts) throw error
      continue
    }
    await api(`${prefix}/pages/builds`, 'POST')
    return { url: `https://${repository.split('/')[0]}.github.io/${repository.split('/')[1]}/${INDEX_PATH}`, index, commit: commit.sha }
  }
  throw new Error('Plugin index publication exhausted its concurrent-update budget')
}

async function main() {
  const { values } = parseArgs({ options: { repository: { type: 'string' }, 'prepare-only': { type: 'boolean' } } })
  const repository = values.repository ?? process.env.GITHUB_REPOSITORY
  assert.match(repository ?? '', /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u)
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  assert(token, 'Publisher requires an Actions or explicit publishing token')
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(`https://api.github.com${path}`, { method, signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (response.status === 404 && method === 'GET') return undefined
    if (!response.ok) throw Object.assign(new Error(`GitHub publication failed: HTTP ${response.status} ${method} ${path}`), { status: response.status })
    return response.status === 204 ? undefined : response.json()
  }
  const sources = await readIndexSources(resolve(import.meta.dirname, '../workspace'), repository)
  const entries = await collectPublishedPlugins(repository, sources, api)
  const result = values['prepare-only'] ? mergeUpdateIndex(undefined, entries, repository, new Date().toISOString())
    : await publishUpdateIndex({ repository, entries }, api)
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
