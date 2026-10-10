import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { verifyMacOSUnsignedArtifacts, writeMacOSUnsignedRecord } from '../scripts/macos-unsigned-artifacts.ts'
import { prepareDesktopGithubPublication } from '../scripts/desktop-github-publication.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const commit = 'a'.repeat(40)
const version = '0.2.0-rc.2.20261010.3'

async function fixture(target: 'mac-arm64' | 'mac-x64' = 'mac-arm64') {
  const artifactsRoot = await mkdtemp(join(tmpdir(), 'macos-unsigned-record-'))
  roots.push(artifactsRoot)
  const options = { target, artifactsRoot, version, productVersion: '0.2.0-rc.2', expectedCommit: commit }
  const base = `deepseek-harness-${version}-${target}-unsigned`
  for (const suffix of ['dmg', 'zip']) await writeFile(join(artifactsRoot, `${base}.${suffix}`), `fixture ${suffix}`)
  const recordPath = join(artifactsRoot, `${target}-release.json`)
  const write = () => writeMacOSUnsignedRecord({ ...options, environment: { DSH_DESKTOP_BUILD_COMMIT: commit, DSH_DESKTOP_BUILD_DIRTY: '0' } })
  return { options, artifactsRoot, base, recordPath, write }
}

it.each(['mac-arm64', 'mac-x64'] as const)('records both %s installers with explicit ad-hoc identity and no online update metadata', async (target) => {
  const item = await fixture(target)
  await item.write()
  const record = JSON.parse(readFileSync(item.recordPath, 'utf8')) as { signing: string; autoUpdate: boolean; notarized: boolean }
  expect(record).toMatchObject({ signing: 'ad-hoc', autoUpdate: false, notarized: false })
  expect(await verifyMacOSUnsignedArtifacts(item.options)).toEqual([`${item.base}.dmg`, `${item.base}.zip`, `${target}-release.json`])
  await expect(prepareDesktopGithubPublication(target, {
    artifactsRoot: item.artifactsRoot, productVersion: item.options.productVersion,
    environment: { DSH_DESKTOP_AUTO_UPDATE_ENV: 'test', DSH_DESKTOP_UPDATE_PROVIDER: 'github',
      DSH_DESKTOP_GITHUB_REPOSITORY: 'owner/repository',
      DSH_DESKTOP_GITHUB_PAGES_URL: 'https://owner.github.io/repository/desktop/test/' },
  })).rejects.toThrow('completion')
})

it.each(['version', 'commit', 'dirty', 'environment', 'signing', 'distribution', 'autoUpdate', 'notarized', 'target', 'publicUrl'])
('rejects a changed completion field %s', async (field) => {
  const item = await fixture()
  await item.write()
  const record = JSON.parse(readFileSync(item.recordPath, 'utf8')) as Record<string, unknown>
  await writeFile(item.recordPath, JSON.stringify({ ...record, [field]: field === 'dirty' || field === 'autoUpdate' || field === 'notarized' ? true : 'wrong' }))
  await expect(verifyMacOSUnsignedArtifacts(item.options)).rejects.toThrow('completion differs')
})

it('rejects same-size payload tampering and file-list substitution', async () => {
  const item = await fixture()
  await item.write()
  const payload = join(item.artifactsRoot, `${item.base}.zip`)
  await writeFile(payload, 'fixture bad')
  await expect(verifyMacOSUnsignedArtifacts(item.options)).rejects.toThrow('SHA-256')
  await writeFile(payload, 'fixture zip')
  const record = JSON.parse(readFileSync(item.recordPath, 'utf8')) as { assets: Array<{ name: string }> }
  record.assets[0]!.name = '../private.p12'
  await writeFile(item.recordPath, JSON.stringify(record))
  await expect(verifyMacOSUnsignedArtifacts(item.options)).rejects.toThrow('file list')
})

it('creates no completion record for missing, empty or failed-source evidence', async () => {
  const item = await fixture()
  await writeFile(join(item.artifactsRoot, `${item.base}.zip`), '')
  await expect(item.write()).rejects.toThrow('nonempty')
  expect(existsSync(item.recordPath)).toBe(false)
  await rm(join(item.artifactsRoot, `${item.base}.zip`))
  await expect(item.write()).rejects.toThrow()
  await expect(writeMacOSUnsignedRecord({ ...item.options, environment: {} })).rejects.toThrow('source commit')
})
