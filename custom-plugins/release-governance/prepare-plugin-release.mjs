/** Exact-source release assets for independently updated custom plugin bundles. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'

/** Validate the source identity and construct one exact-version download record.
 * @param {object} manifest Packed plugin manifest.
 * @param {object} config Owning plugin's release configuration.
 * @param {object} asset Frozen tag, source commit, digest, size and cleanliness.
 * @param {string} expectedPackage Package identity declared by the release adapter.
 * @returns {object} Metadata understood by the existing GitHub bundle updater.
 */
export function releaseMetadata(manifest, config, asset, expectedPackage) {
  assert.equal(config.schemaVersion, 1, 'Unsupported release configuration')
  assert.equal(manifest.name, expectedPackage, 'Unexpected package name')
  assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Stable release requires a stable package version')
  assert.match(config.repository, /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/, 'Invalid GitHub repository')
  assert.match(config.tagPrefix, /^[a-z0-9-]+$/, 'Invalid tag prefix')
  assert.match(config.metadataAsset, /^[a-z0-9-]+\.json$/, 'Invalid metadata asset')
  assert.equal(config.channel, 'stable', 'Unsupported release channel')
  assert.equal(config.makeLatest, false, 'Plugins must not replace the application latest release')
  assert.deepEqual(manifest.dsh?.bundle?.update, { provider: 'github', repository: config.repository, tagPrefix: config.tagPrefix, metadataAsset: config.metadataAsset }, 'Bundle update source and release configuration differ')
  assert.equal(asset.tag, `${config.tagPrefix}${manifest.version}`, 'Tag and package version differ')
  assert.match(asset.sourceCommit, /^[a-f0-9]{40}$/, 'Invalid source commit')
  assert.match(asset.sha256, /^[a-f0-9]{64}$/, 'Invalid artifact digest')
  assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0, 'Invalid artifact size')
  assert.equal(typeof asset.sourceDirty, 'boolean', 'Missing source cleanliness')
  const name = `${manifest.name}-${manifest.version}.tgz`
  return { schemaVersion: 1, package: manifest.name, version: manifest.version, repository: config.repository, channel: config.channel,
    tag: asset.tag, sourceCommit: asset.sourceCommit, sourceDirty: asset.sourceDirty,
    asset: { name, url: `https://github.com/${config.repository}/releases/download/${asset.tag}/${name}`, sha256: asset.sha256, size: asset.size } }
}

/** Validate declared entrypoints, feature assets and release documentation in a tarball.
 * @param {object} manifest Packed manifest; Host-only plugins need no Client entry.
 * @param {string[]} entries Archive paths including the package/ prefix.
 * @returns {void} Throws for unsafe, private or missing published files.
 */
export function verifyPackedEntries(manifest, entries) {
  const files = new Set(entries)
  for (const entry of entries) {
    assert.ok(entry.startsWith('package/') && !entry.split('/').includes('..') && !entry.includes('\\'), `Unsafe archive path: ${entry}`)
    assert.ok(!/(?:^|\/)(?:node_modules|tests|\.env(?:\.[^/]*)?|pnpm-lock\.yaml)(?:\/|$)/.test(entry), `Unwanted archive file: ${entry}`)
  }
  const leaves = value => typeof value === 'string' ? [value] : Object.values(value).flatMap(leaves)
  const bundle = manifest.dsh.bundle
  const required = ['package.json', 'README.md', 'README.zh.md', 'THIRD_PARTY_NOTICES.md', 'release/README.md', 'release/README.zh.md', 'release.config.json',
    manifest.icon, ...[bundle.patch].flat(), ...leaves(manifest.exports), ...bundle.featureConfig === undefined ? [] : [bundle.featureConfig],
    ...(bundle.features ?? []).flatMap(feature => feature.icon === undefined ? [] : [feature.icon])]
  for (const path of required) {
    assert.equal(typeof path, 'string', 'Missing declared file path')
    const entry = `package/${path.replace(/^\.\//, '')}`
    if (entry.includes('*')) {
      const [prefix, suffix] = entry.split('*')
      assert.ok(entries.some(file => file.startsWith(prefix) && file.endsWith(suffix)), `Missing export: ${path}`)
    } else assert.ok(files.has(entry), `Missing packed file: ${path}`)
  }
}

function command(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
  assert.equal(result.error, undefined, `Could not start ${executable}: ${result.error?.message}`)
  assert.equal(result.signal, null, `${executable} ended by signal`)
  assert.equal(result.status, 0, `${executable} failed:\n${result.stderr}\n${result.stdout}`)
  return result.stdout.trim()
}

/** Run the owning package's tests and prepack, then write verified release assets.
 * @param {object} options Exact package directory and adapter-owned package identity.
 * @param {string[]} args Developer command arguments; defaults to the current invocation.
 * @returns {Promise<object>} Exact source and artifact metadata; no network publication occurs.
 */
export async function prepareRelease({ packageRoot, expectedPackage, packageManager }, args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { out: { type: 'string' }, tag: { type: 'string' }, 'allow-dirty': { type: 'boolean', default: false } } })
  assert.ok(values.out, 'Supply --out <repository-relative or absolute directory>')
  assert.ok(packageManager, 'Run with pnpm run release:prepare')
  const repositoryRoot = command('git', ['rev-parse', '--show-toplevel'], packageRoot)
  const sourceDirty = command('git', ['status', '--porcelain'], repositoryRoot) !== ''
  // 正式资产拒绝未提交源码；演练产物带脏树标记，发布器不会接收。
  assert.ok(!sourceDirty || values['allow-dirty'], 'Commit the intended changes before preparing a release; --allow-dirty is rehearsal only')
  const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'))
  const config = JSON.parse(await readFile(resolve(packageRoot, 'release.config.json'), 'utf8'))
  const sourceCommit = command('git', ['rev-parse', 'HEAD'], repositoryRoot), tag = values.tag ?? `${config.tagPrefix}${manifest.version}`
  const candidate = releaseMetadata(manifest, config, { tag, sourceCommit, sourceDirty, sha256: '0'.repeat(64), size: 1 }, expectedPackage)
  const output = resolve(repositoryRoot, values.out)
  await mkdir(output, { recursive: true })
  const tests = command(process.execPath, [packageManager, 'run', 'test'], packageRoot)
  console.log(tests.split('\n').filter(line => /^(?:#|ℹ) (?:tests|pass|fail)\b/.test(line)).join('\n'))
  command(process.execPath, [packageManager, 'pack', '--pack-destination', output], packageRoot)
  assert.equal(command('git', ['rev-parse', 'HEAD'], repositoryRoot), sourceCommit, 'Source commit changed during packaging')
  if (!values['allow-dirty']) assert.equal(command('git', ['status', '--porcelain'], repositoryRoot), '', 'Build changed committed source')
  const artifact = resolve(output, candidate.asset.name)
  const packed = JSON.parse(command('tar', ['-xOf', artifact, 'package/package.json'], packageRoot))
  assert.equal(packed.name, manifest.name); assert.equal(packed.version, manifest.version)
  verifyPackedEntries(packed, command('tar', ['-tzf', artifact], packageRoot).split(/\r?\n/))
  const bytes = await readFile(artifact), sha256 = createHash('sha256').update(bytes).digest('hex')
  const metadata = releaseMetadata(packed, config, { tag, sourceCommit, sourceDirty, sha256, size: bytes.length }, expectedPackage)
  await writeFile(resolve(output, config.metadataAsset), JSON.stringify(metadata, null, 2) + '\n', 'utf8')
  await writeFile(resolve(output, 'SHA256SUMS'), `${sha256}  ${candidate.asset.name}\n`, 'utf8')
  await writeFile(resolve(output, 'release-notes.md'), await readFile(resolve(packageRoot, 'release/notes.md'), 'utf8'), 'utf8')
  console.log(JSON.stringify({ output, ...metadata }, null, 2))
  return metadata
}
