/** Release family selection, verified archive contents and explicit persisted installation permission. */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished } from 'vitest'
import { cacheBundleUpdate, discoverBundleUpdate, updateCacheDirectory } from '../src/github-updates.ts'
import { backupUpdateEntry, readAutomaticUpdates, writeAutomaticUpdate } from '../src/update-state.ts'
import { githubFixture, limits, source } from './update-fixture.ts'

function profile(): string {
  const root = mkdtempSync(join(tmpdir(), 'plugin-updates-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  return root
}

it('normalizes absolute directory separators before traversing cache owners', () => {
  const root = profile()
  expect(updateCacheDirectory(root.replaceAll('\\', '/'))).toBe(join(root, '.plugin-updates', 'packages'))
  expect(() => updateCacheDirectory('relative')).toThrow('absolute')
})

it('selects its own stable family and retains verified bytes for pnpm file dependencies', async () => {
  const { bytes, release } = githubFixture()
  const signal = new AbortController().signal
  expect(await discoverBundleUpdate('extra', '1.0.0', source, limits, signal)).toEqual(release)
  expect(await discoverBundleUpdate('extra', '1.1.0', source, limits, signal)).toBeUndefined()
  const cached = await cacheBundleUpdate(profile(), release, limits, signal)
  expect(readFileSync(cached.file)).toEqual(bytes)
  expect(cached.manifest.version).toBe('1.1.0')
})

it('rejects corrupted release digests', async () => {
  const { fetchMock, releaseRow } = githubFixture()
  fetchMock.mockResolvedValueOnce(Response.json([{ ...releaseRow, assets: releaseRow.assets.map(asset => ({ ...asset, digest: 'sha256:wrong' })) }]))
  await expect(discoverBundleUpdate('extra', '1.0.0', source, limits, new AbortController().signal)).rejects.toThrow('metadata bytes')
})

it('rejects moved tags, offline responses and stopped requests', async () => {
  const { fetchMock } = githubFixture()
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => (input instanceof Request ? input.url : input.toString()).includes('/git/ref/tags/')
    ? Response.json({ object: { type: 'commit', sha: 'b'.repeat(40) } }) : original(input, init))
  await expect(discoverBundleUpdate('extra', '1.0.0', source, limits, new AbortController().signal)).rejects.toThrow('source commit')
  fetchMock.mockRejectedValueOnce(new Error('offline'))
  await expect(discoverBundleUpdate('extra', '1.0.0', source, limits, new AbortController().signal)).rejects.toThrow('offline')
  const stopped = new AbortController(); stopped.abort()
  await expect(discoverBundleUpdate('extra', '1.0.0', source, limits, stopped.signal)).rejects.toThrow()
})

it('rejects requests outside official GitHub endpoints', async () => {
  const { release } = githubFixture()
  await expect(cacheBundleUpdate(profile(), { ...release, metadata: { ...release.metadata, asset: { ...release.metadata.asset, url: 'https://localhost/private' } } }, limits, new AbortController().signal)).rejects.toThrow('official GitHub')
})

it.each(['package/../outside', '/outside', 'package/link'])('rejects escaping or linked tar entry %s before installation', async (path) => {
  const { release } = githubFixture([{ path, body: '', ...path === 'package/link' ? { type: 'SymbolicLink' as const } : {} }])
  await expect(cacheBundleUpdate(profile(), release, limits, new AbortController().signal)).rejects.toThrow('archive entry')
})

it('refuses oversized compressed bytes and mismatched package identity', async () => {
  const { release } = githubFixture()
  await expect(cacheBundleUpdate(profile(), release, { ...limits, archiveBytes: 1 }, new AbortController().signal)).rejects.toThrow('byte bound')
  await expect(cacheBundleUpdate(profile(), release, { ...limits, expandedBytes: 1 }, new AbortController().signal)).rejects.toThrow('byte bound')
  await expect(cacheBundleUpdate(profile(), { ...release, metadata: { ...release.metadata, package: 'another' } }, limits, new AbortController().signal)).rejects.toThrow()
})

it('defaults automatic installation to off, preserves other choices and rejects corrupted settings', async () => {
  const root = profile()
  expect(readAutomaticUpdates(root)).toEqual({})
  await writeAutomaticUpdate(root, 'extra', true)
  await writeAutomaticUpdate(root, 'another', false)
  expect(readAutomaticUpdates(root)).toEqual({ extra: true, another: false })
  writeFileSync(join(root, '.plugin-updates/settings.json'), '{broken', 'utf8')
  expect(() => readAutomaticUpdates(root)).toThrow()
})

it('restores an originally absent node_modules entry after failed installation', async () => {
  const root = profile()
  const backup = await backupUpdateEntry(root, 'extra')
  await backup.restore()
  await backup.discard()
  await expect(backupUpdateEntry(root, '../escape')).rejects.toThrow()
})

it.each(['directory', 'broken-junction'])('restores a package junction after a failed %s replacement', async (replacement) => {
  const root = profile()
  const source = join(root, 'original-package')
  const target = join(root, 'node_modules', 'extra')
  mkdirSync(source)
  mkdirSync(join(root, 'node_modules'))
  writeFileSync(join(source, 'sentinel.txt'), 'original', 'utf8')
  symlinkSync(source, target, 'junction')
  const link = readlinkSync(target)
  const backup = await backupUpdateEntry(root, 'extra')
  onTestFinished(async () => { await backup.discard() })
  unlinkSync(target)
  if (replacement === 'directory') {
    mkdirSync(target)
    writeFileSync(join(target, 'replacement.txt'), 'replacement', 'utf8')
  } else symlinkSync(join(root, 'missing-package'), target, 'junction')
  await backup.restore()
  expect(lstatSync(target).isSymbolicLink()).toBe(true)
  expect(readlinkSync(target)).toBe(link)
  expect(readFileSync(join(source, 'sentinel.txt'), 'utf8')).toBe('original')
})
