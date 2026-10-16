/** Prepare verified local assets; this script never pushes or publishes. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))

/** Validate source and artifact identity for the GitHub bundle updater. @param {object} manifest Packed manifest. @param {object} config Release settings. @param {object} asset Exact artifact facts. @returns {object} Update metadata. */
export function releaseMetadata(manifest, config, asset) {
  assert.equal(manifest.name, 'dsh-plugin-article-image')
  assert.equal(config.schemaVersion, 1); assert.equal(config.channel, 'stable'); assert.equal(config.makeLatest, false)
  assert.equal(config.tagPrefix, 'article-image-v')
  assert.match(config.repository, /^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/)
  assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  assert.equal(asset.tag, `${config.tagPrefix}${manifest.version}`)
  assert.match(asset.sourceCommit, /^[a-f0-9]{40}$/); assert.match(asset.sha256, /^[a-f0-9]{64}$/)
  assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0); assert.equal(typeof asset.sourceDirty, 'boolean')
  assert.deepEqual(manifest.dsh.bundle.update, { provider: 'github', repository: config.repository, tagPrefix: config.tagPrefix, metadataAsset: 'article-image-update.json' })
  const name = `${manifest.name}-${manifest.version}.tgz`
  return { schemaVersion: 1, package: manifest.name, version: manifest.version, repository: config.repository, channel: config.channel,
    tag: asset.tag, sourceCommit: asset.sourceCommit, sourceDirty: asset.sourceDirty,
    asset: { name, url: `https://github.com/${config.repository}/releases/download/${asset.tag}/${name}`, size: asset.size, sha256: asset.sha256 } }
}

/** Reject missing entries and development/private archive files. @param {object} manifest Manifest. @param {string[]} entries Tar file list. @returns {void} Throws on invalid content. */
export function verifyPackedEntries(manifest, entries) {
  for (const entry of entries) {
    assert.ok(entry.startsWith('package/') && !entry.includes('\\') && !entry.split('/').includes('..'))
    assert.ok(!/(?:^|\/)(?:node_modules|tests|\.artifacts|state\.json|\.env(?:\.[^/]*)?)(?:\/|$)/.test(entry), entry)
  }
  const required = ['package.json', 'client.js', 'cordis.patch.yml', 'config.json', 'src/host/service.js',
    'skills/article-image-workflow/SKILL.md', 'skills/article-image-editorial-prompts/SKILL.md', 'release.config.json',
    manifest.icon, ...Object.values(manifest.exports)]
  for (const path of required) {
    const target = `package/${path.replace(/^\.\//, '')}`
    assert.ok(target.includes('*') ? entries.some(entry => entry.startsWith(target.split('*')[0]) && entry.endsWith(target.split('*')[1])) : entries.includes(target), path)
  }
}
function command(executable, args, cwd = packageRoot) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 16000000 })
  assert.ifError(result.error); assert.equal(result.status, 0, result.stdout + result.stderr)
  return result.stdout.trim()
}
async function main() {
  const { values } = parseArgs({ options: { out: { type: 'string' }, tag: { type: 'string' }, 'allow-dirty': { type: 'boolean', default: false } } })
  assert.ok(values.out && process.env.npm_execpath, 'Use pnpm run release:prepare --out <directory>')
  const sourceDirty = command('git', ['status', '--porcelain'], repositoryRoot) !== ''
  assert.ok(!sourceDirty || values['allow-dirty'], 'Commit source first; --allow-dirty creates rehearsal assets only')
  const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'))
  const config = JSON.parse(await readFile(resolve(packageRoot, 'release.config.json'), 'utf8'))
  const sourceCommit = command('git', ['rev-parse', 'HEAD'], repositoryRoot), tag = values.tag ?? `${config.tagPrefix}${manifest.version}`
  const identity = { tag, sourceCommit, sourceDirty, sha256: '0'.repeat(64), size: 1 }
  const candidate = releaseMetadata(manifest, config, identity), output = resolve(repositoryRoot, values.out)
  await mkdir(output, { recursive: true })
  console.log(command(process.execPath, [process.env.npm_execpath, 'run', 'test']))
  command(process.execPath, [process.env.npm_execpath, 'pack', '--pack-destination', output])
  assert.equal(command('git', ['rev-parse', 'HEAD'], repositoryRoot), sourceCommit)
  if (!sourceDirty) assert.equal(command('git', ['status', '--porcelain'], repositoryRoot), '')
  const artifact = resolve(output, candidate.asset.name), entries = command('tar', ['-tzf', artifact]).split(/\r?\n/)
  const packed = JSON.parse(command('tar', ['-xOf', artifact, 'package/package.json']))
  assert.equal(packed.name, manifest.name); assert.equal(packed.version, manifest.version); verifyPackedEntries(packed, entries)
  const bytes = await readFile(artifact), metadata = releaseMetadata(packed, config, { ...identity, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  await writeFile(resolve(output, 'article-image-update.json'), JSON.stringify(metadata, null, 2) + '\n', 'utf8')
  await writeFile(resolve(output, 'SHA256SUMS'), `${metadata.asset.sha256}  ${metadata.asset.name}\n`, 'utf8')
  console.log(JSON.stringify({ output, ...metadata }, null, 2))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
