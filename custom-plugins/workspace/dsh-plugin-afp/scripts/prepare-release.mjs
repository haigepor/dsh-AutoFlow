/** Build and verify AFP Release assets without writing to GitHub or npm. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))

/** Construct version-specific download metadata from validated publication inputs.
 * @param {object} manifest Package manifest read from the tarball.
 * @param {object} config Release configuration from the source checkout.
 * @param {object} asset Exact tag, source commit, digest, size and source cleanliness.
 * @returns {object} Exact-version metadata consumed by the bundle GitHub updater.
 */
export function releaseMetadata(manifest, config, asset) {
  assert.equal(config.schemaVersion, 1, 'Unsupported release configuration')
  assert.equal(manifest.name, 'dsh-plugin-afp', 'Unexpected package name')
  assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Stable release requires a stable package version')
  assert.match(config.repository, /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/, 'Invalid GitHub repository')
  assert.match(config.tagPrefix, /^[a-z0-9-]+$/, 'Invalid tag prefix')
  assert.equal(config.channel, 'stable', 'Unsupported release channel')
  assert.equal(config.makeLatest, false, 'AFP must not replace the application latest release')
  assert.equal(asset.tag, `${config.tagPrefix}${manifest.version}`, 'Tag and package version differ')
  assert.match(asset.sourceCommit, /^[a-f0-9]{40}$/, 'Invalid source commit')
  assert.match(asset.sha256, /^[a-f0-9]{64}$/, 'Invalid artifact digest')
  assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0, 'Invalid artifact size')
  assert.equal(typeof asset.sourceDirty, 'boolean', 'Missing source cleanliness')
  const name = `${manifest.name}-${manifest.version}.tgz`
  return {
    schemaVersion: 1, package: manifest.name, version: manifest.version,
    repository: config.repository, channel: config.channel, tag: asset.tag,
    sourceCommit: asset.sourceCommit, sourceDirty: asset.sourceDirty,
    asset: { name, url: `https://github.com/${config.repository}/releases/download/${asset.tag}/${name}`, sha256: asset.sha256, size: asset.size },
  }
}

/** Verify published entries and configuration against the packed package file list.
 * @param {object} manifest Manifest extracted from the npm tarball.
 * @param {string[]} entries Paths reported by tar, including the package/ prefix.
 * @returns {void} Throws if package contents cannot supply the declared bundle.
 */
export function verifyPackedEntries(manifest, entries) {
  const files = new Set(entries)
  for (const entry of entries) {
    assert.ok(entry.startsWith('package/') && !entry.split('/').includes('..') && !entry.includes('\\'), `Unsafe archive path: ${entry}`)
    assert.ok(!/(?:^|\/)(?:node_modules|tests|\.env(?:\.[^/]*)?|pnpm-lock\.yaml)(?:\/|$)/.test(entry), `Unwanted archive file: ${entry}`)
  }
  const required = ['package.json', 'client.js', 'UPSTREAM.md', 'release/README.md', 'release/README.zh.md', 'release.config.json', manifest.dsh.bundle.featureConfig,
    ...[manifest.dsh.bundle.patch].flat(), ...Object.values(manifest.exports),
    ...manifest.dsh.bundle.features.map(feature => feature.icon)]
  for (const path of required) {
    const entry = `package/${path.replace(/^\.\//, '')}`
    if (entry.includes('*')) {
      const [prefix, suffix] = entry.split('*')
      assert.ok(entries.some(file => file.startsWith(prefix) && file.endsWith(suffix)), `Missing export: ${path}`)
    } else assert.ok(files.has(entry), `Missing packed file: ${path}`)
  }
}

function command(executable, args, cwd = packageRoot) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  assert.equal(result.error, undefined, `Could not start ${executable}: ${result.error?.message}`)
  assert.equal(result.signal, null, `${executable} ended by signal`)
  assert.equal(result.status, 0, `${executable} failed:\n${result.stderr}\n${result.stdout}`)
  return result.stdout.trim()
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: 'string' }, tag: { type: 'string' }, 'allow-dirty': { type: 'boolean', default: false } } })
  assert.ok(values.out, 'Supply --out <repository-relative or absolute directory>')
  assert.ok(process.env.npm_execpath, 'Run with pnpm run release:prepare')
  const sourceDirty = command('git', ['status', '--porcelain'], repositoryRoot) !== ''
  // 正式产物必须来自已提交的源码；脏树产物明确标记，发布流程拒绝上传。
  assert.ok(!sourceDirty || values['allow-dirty'], 'Commit the intended changes before preparing a release; --allow-dirty is rehearsal only')
  const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'))
  const config = JSON.parse(await readFile(resolve(packageRoot, 'release.config.json'), 'utf8'))
  const sourceCommit = command('git', ['rev-parse', 'HEAD'], repositoryRoot)
  const tag = values.tag ?? `${config.tagPrefix}${manifest.version}`
  const candidate = releaseMetadata(manifest, config, { tag, sourceCommit, sourceDirty, sha256: '0'.repeat(64), size: 1 })
  const output = resolve(repositoryRoot, values.out)
  await mkdir(output, { recursive: true })
  const tests = command(process.execPath, [process.env.npm_execpath, 'run', 'test'])
  console.log(tests.split('\n').filter(line => /^(?:#|ℹ) (?:tests|pass|fail)\b/.test(line)).join('\n'))
  command(process.execPath, [process.env.npm_execpath, 'pack', '--pack-destination', output])
  assert.equal(command('git', ['rev-parse', 'HEAD'], repositoryRoot), sourceCommit, 'Source commit changed during packaging')
  // prepack 重建的 Client 必须与提交一致，避免 tag 和下载包包含不同代码。
  if (!values['allow-dirty']) assert.equal(command('git', ['status', '--porcelain'], repositoryRoot), '', 'Build changed committed source')
  const artifact = resolve(output, candidate.asset.name)
  const packed = JSON.parse(command('tar', ['-xOf', artifact, 'package/package.json']))
  assert.equal(packed.name, manifest.name)
  assert.equal(packed.version, manifest.version)
  verifyPackedEntries(packed, command('tar', ['-tzf', artifact]).split(/\r?\n/))
  const bytes = await readFile(artifact)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const metadata = releaseMetadata(packed, config, { tag, sourceCommit, sourceDirty, sha256, size: bytes.length })
  await writeFile(resolve(output, 'afp-update.json'), JSON.stringify(metadata, undefined, 2) + '\n', 'utf8')
  await writeFile(resolve(output, 'SHA256SUMS'), `${sha256}  ${candidate.asset.name}\n`, 'utf8')
  console.log(JSON.stringify({ output, ...metadata }, undefined, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
