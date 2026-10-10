import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { dump } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupMacOSCI, collectMacOSCIDiagnostics, initializeMacOSCI, prepareMacOSCI, stageMacOSCIArtifacts, validateMacOSCIBuild } from '../scripts/desktop-macos-ci.mjs'
import { writeMacOSUnsignedRecord } from '../scripts/macos-unsigned-artifacts.ts'
// 预加载真实校验模块，避免把源码冷转换时间计入单条配置测试的超时。
import '../scripts/desktop-package-environment.mjs'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const version = '0.2.0-rc.2.20261010.7'
const productVersion = '0.2.0-rc.2'
const commit = 'a'.repeat(40)
const confirmed = { deployment: 'test', signing: 'signed', version, productVersion, expectedCommit: commit, actualCommit: commit, dirty: false }
const environment = {
  DEPLOYMENT: 'test', SIGNING_MODE: 'signed', DESKTOP_APP_ID: 'com.example.desktop.test',
  DESKTOP_GITHUB_PAGES_URL: 'https://owner.github.io/repository/desktop/macos-test/', GITHUB_REPOSITORY: 'owner/repository',
  MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)', MACOS_TEAM_ID: 'TEAMID1234',
  MACOS_CERTIFICATE_P12_BASE64: Buffer.from('fixture P12 bytes').toString('base64'), MACOS_CERTIFICATE_PASSWORD: 'fixture-password',
  APPLE_API_KEY_BASE64: Buffer.from('-----BEGIN PRIVATE KEY-----\nfixture-only\n-----END PRIVATE KEY-----\n').toString('base64'),
  APPLE_API_KEY_ID: 'fixture-key-id', APPLE_API_ISSUER: 'fixture-issuer',
}

async function fixture() {
  const runnerTemp = await mkdtemp(join(tmpdir(), 'desktop-macos-spec-'))
  directories.push(runnerTemp)
  const appRoot = join(runnerTemp, 'desktop')
  mkdirSync(appRoot)
  const calls: string[][] = []
  const runSecurity = (args: string[]) => {
    calls.push(args)
    return args.length === 3 ? '"/existing/login.keychain-db"\n' : ''
  }
  const directory = initializeMacOSCI(runnerTemp, appRoot)
  const options = { directory, runnerTemp, appRoot, runSecurity }
  return { ...options, options, calls }
}

async function completedFixture() {
  const item = await fixture()
  await prepareMacOSCI({ ...item.options, environment })
  const artifacts = join(item.appRoot, '.desktop-build', 'targets', 'mac-arm64', 'artifacts')
  mkdirSync(artifacts, { recursive: true })
  const base = `deepseek-harness-${version}-mac-arm64`
  const payload = Buffer.from('fixture signed ZIP')
  writeFileSync(join(artifacts, `${base}.zip`), payload)
  writeFileSync(join(artifacts, `${base}.zip.blockmap`), 'fixture blockmap')
  writeFileSync(join(artifacts, `${base}.dmg`), 'fixture signed DMG')
  const metadata = { version, files: [{ url: `${base}.zip`, size: payload.length, sha512: createHash('sha512').update(payload).digest('base64') }], path: `${base}.zip` }
  writeFileSync(join(artifacts, 'nightly-mac.yml'), dump(metadata))
  const record = { schemaVersion: 1, provider: 'github', repository: environment.GITHUB_REPOSITORY,
    target: 'mac-arm64', version, environment: 'test', signing: 'signed', commit, dirty: false,
    pagesUrl: environment.DESKTOP_GITHUB_PAGES_URL, publicUrl: `${environment.DESKTOP_GITHUB_PAGES_URL}feeds/mac-arm64/` }
  writeFileSync(join(artifacts, 'mac-arm64-release.json'), JSON.stringify(record))
  const stageOptions = { ...item.options, version, productVersion, deployment: 'test', signing: 'signed', expectedCommit: commit }
  return { ...item, artifacts, base, metadata, record, stageOptions }
}

describe('confirmed macOS CI inputs', () => {
  it('accepts exact prerelease/stable test versions and an exact production version', () => {
    expect(() =>{  validateMacOSCIBuild(confirmed) }).not.toThrow()
    expect(() =>{  validateMacOSCIBuild({ ...confirmed, productVersion: '1.0.0', version: '1.0.0-test.20261010.1' }) }).not.toThrow()
    expect(() =>{  validateMacOSCIBuild({ ...confirmed, deployment: 'production', version: productVersion }) }).not.toThrow()
  })

  it.each(['', 'auto', '0.2.0-rc.2', '0.2.0-rc.2.20260230.1', '0.2.0-rc.2.20261010.0', '0.2.0-rc.2.20261010.01', '0.2.0-rc.2.20261010.1+build', '0.2.0-rc.1.20261010.1'])('rejects an unconfirmed or malformed test version %s', (value) => {
    expect(() =>{  validateMacOSCIBuild({ ...confirmed, version: value }) }).toThrow()
  })

  it('rejects implicit environments, changed commits, dirty checkouts and derived production versions', () => {
    expect(() =>{  validateMacOSCIBuild({ ...confirmed, deployment: 'unconfirmed' }) }).toThrow('explicitly select')
    expect(() =>{  validateMacOSCIBuild({ ...confirmed, actualCommit: 'b'.repeat(40) }) }).toThrow('clean checkout')
    expect(() =>{  validateMacOSCIBuild({ ...confirmed, expectedCommit: 'main' }) }).toThrow('clean checkout')
    expect(() =>{  validateMacOSCIBuild({ ...confirmed, dirty: true }) }).toThrow('clean checkout')
    expect(() =>{  validateMacOSCIBuild({ ...confirmed, deployment: 'production' }) }).toThrow('production version')
    expect(() =>{  validateMacOSCIBuild({ ...confirmed, signing: 'unconfirmed' }) }).toThrow('explicitly select signed')
    expect(() =>{  validateMacOSCIBuild({ ...confirmed, signing: 'unsigned' }) }).not.toThrow()
    expect(() =>{  validateMacOSCIBuild({ ...confirmed, signing: 'unsigned', deployment: 'production', version: productVersion }) }).toThrow('test deployment')
  })
})

describe('private macOS CI configuration and cleanup', () => {
  it('generates certificate-free test configuration without requiring Secrets, keychains or update addresses', async () => {
    const { options, calls, appRoot, directory } = await fixture()
    await prepareMacOSCI({ ...options, environment: { DEPLOYMENT: 'test', SIGNING_MODE: 'unsigned', DESKTOP_APP_ID: 'com.example.desktop.unsigned' } })
    expect(parseEnv(readFileSync(join(appRoot, '.env.macos'), 'utf8'))).toEqual({
      DSH_DESKTOP_APP_ID: 'com.example.desktop.unsigned', DSH_DESKTOP_AUTO_UPDATE_ENV: 'test', DSH_DESKTOP_MACOS_PACK_CONCURRENCY: '2',
    })
    expect(readdirSync(join(directory, 'credentials'))).toEqual([])
    expect(calls).toEqual([])
    cleanupMacOSCI(options)
    expect(calls).toEqual([])
    expect(existsSync(join(appRoot, '.env.macos'))).toBe(false)
  })

  it('rejects production unsigned configuration before writing files or accessing keychains', async () => {
    const { options, appRoot, calls } = await fixture()
    await expect(prepareMacOSCI({ ...options, environment: { ...environment, SIGNING_MODE: 'unsigned', DEPLOYMENT: 'production' } })).rejects.toThrow('test deployment')
    expect(existsSync(join(appRoot, '.env.macos'))).toBe(false)
    expect(calls).toEqual([])
  })
  it.each(['spaces # 中文', 'single\' and double" quotes', 'back`tick and single\' quote', 'two\nlines', ''])('round-trips a password through dotenv: %j', async (password) => {
    const { options, directory, appRoot } = await fixture()
    await prepareMacOSCI({ ...options, environment: { ...environment, MACOS_CERTIFICATE_PASSWORD: password } })
    const settings = parseEnv(readFileSync(join(appRoot, '.env.macos'), 'utf8'))
    expect(settings.CSC_KEY_PASSWORD).toBe(password)
    expect(readFileSync(settings.CSC_LINK!, 'utf8')).toBe('fixture P12 bytes')
    expect(settings.CSC_LINK).toBe(join(directory, 'credentials', 'developer-id.p12'))
    expect(settings.DSH_DESKTOP_MANDATORY_UPDATE_URL).toBe(`${environment.DESKTOP_GITHUB_PAGES_URL}policy.json`)
    expect(settings.DSH_DESKTOP_UNSIGNED_UPDATES).toBeUndefined()
    expect(settings.APPLE_ID).toBeUndefined()
    expect(settings.DSH_DESKTOP_MACOS_PACK_CONCURRENCY).toBe('2')
    cleanupMacOSCI(options)
    expect(existsSync(join(appRoot, '.env.macos'))).toBe(false)
    expect(existsSync(join(directory, 'credentials'))).toBe(false)
  })

  it('preserves existing local configuration when setup refuses to overwrite it', async () => {
    const { options, appRoot } = await fixture()
    const local = join(appRoot, '.env.macos')
    writeFileSync(local, 'EXISTING=local\n')
    await expect(prepareMacOSCI({ ...options, environment })).rejects.toThrow('overwrite')
    cleanupMacOSCI(options)
    expect(readFileSync(local, 'utf8')).toBe('EXISTING=local\n')
  })

  it.each(['not-base64', 'a===', ''])('rejects malformed certificates and cleans partial credential files: %j', async (encoded) => {
    const { options, directory } = await fixture()
    await expect(prepareMacOSCI({ ...options, environment: { ...environment, MACOS_CERTIFICATE_P12_BASE64: encoded } })).rejects.toThrow()
    cleanupMacOSCI(options)
    expect(existsSync(join(directory, 'credentials'))).toBe(false)
  })

  it('rejects passwords that cannot round-trip without printing their contents', async () => {
    const { options } = await fixture()
    const password = 'secret\'"`#'
    await expect(prepareMacOSCI({ ...options, environment: { ...environment, MACOS_CERTIFICATE_PASSWORD: password } })).rejects.toThrow('CSC_KEY_PASSWORD')
    cleanupMacOSCI(options)
  })

  it('rejects unsigned update roots through the existing package validator', async () => {
    const { options } = await fixture()
    await expect(prepareMacOSCI({ ...options, environment: { ...environment, DESKTOP_GITHUB_PAGES_URL: 'https://owner.github.io/repository/desktop/unsigned/' } })).rejects.toThrow('unsigned')
    cleanupMacOSCI(options)
  })

  it('restores the original search list, deletes a leftover owned keychain and preserves staged evidence', async () => {
    const { options, directory, calls } = await fixture()
    await prepareMacOSCI({ ...options, environment })
    const keychain = join(directory, 'temporary', 'dsh-macos-signing-fixture', 'signing.keychain-db')
    mkdirSync(join(directory, 'temporary', 'dsh-macos-signing-fixture'))
    writeFileSync(keychain, 'fixture')
    writeFileSync(join(directory, 'diagnostics', 'toolchain.log'), 'toolchain')
    cleanupMacOSCI(options)
    expect(calls).toContainEqual(['list-keychains', '-d', 'user', '-s', '/existing/login.keychain-db'])
    expect(calls).toContainEqual(['delete-keychain', keychain])
    expect(readFileSync(join(directory, 'diagnostics', 'toolchain.log'), 'utf8')).toBe('toolchain')
    expect(existsSync(keychain)).toBe(false)
  })

  it('removes private files even when keychain restoration fails, and reports cleanup failure', async () => {
    const { options, directory, appRoot } = await fixture()
    await prepareMacOSCI({ ...options, environment })
    expect(() =>{  cleanupMacOSCI({ ...options, runSecurity: () => { throw new Error('fixture cleanup error') } }) }).toThrow('cleanup failed')
    expect(existsSync(join(directory, 'credentials'))).toBe(false)
    expect(existsSync(join(appRoot, '.env.macos'))).toBe(false)
  })

  it('refuses cleanup outside the allocated run root', async () => {
    const { options, appRoot } = await fixture()
    const preserved = join(appRoot, 'important.txt')
    writeFileSync(preserved, 'preserve')
    expect(() =>{  cleanupMacOSCI({ ...options, directory: appRoot }) }).toThrow('owned runner root')
    expect(readFileSync(preserved, 'utf8')).toBe('preserve')
  })
})

describe('macOS CI artifact evidence', () => {
  it('retains only verified certificate-free DMG/ZIP and their completion record without feeds or Secrets', async () => {
    const { options, directory, appRoot } = await fixture()
    const artifactsRoot = join(appRoot, '.desktop-build', 'targets', 'mac-arm64', 'unsigned-artifacts')
    mkdirSync(artifactsRoot, { recursive: true })
    const base = `deepseek-harness-${version}-mac-arm64-unsigned`
    for (const name of [`${base}.dmg`, `${base}.zip`, 'nightly-mac.yml', 'private.p12']) writeFileSync(join(artifactsRoot, name), 'fixture')
    await writeMacOSUnsignedRecord({ target: 'mac-arm64', version, productVersion, artifactsRoot,
      environment: { DSH_DESKTOP_BUILD_COMMIT: commit, DSH_DESKTOP_BUILD_DIRTY: '0' } })
    await stageMacOSCIArtifacts({ ...options, version, productVersion, deployment: 'test', signing: 'unsigned', expectedCommit: commit })
    expect(readdirSync(join(directory, 'deliverables')).sort()).toEqual(['SHA256SUMS', `${base}.dmg`, `${base}.zip`, 'mac-arm64-release.json'].sort())
  })
  it('stages only complete signed artifacts and hashes every retained file', async () => {
    const { stageOptions, artifacts, directory, base, metadata } = await completedFixture()
    writeFileSync(join(artifacts, 'private.p12'), 'must not upload')
    writeFileSync(join(artifacts, '.env.macos'), 'must not upload')
    await stageMacOSCIArtifacts(stageOptions)
    const staged = join(directory, 'deliverables')
    expect(readdirSync(staged).sort()).toEqual(['SHA256SUMS', `${base}.dmg`, `${base}.zip`, `${base}.zip.blockmap`, 'mac-arm64-release.json', 'nightly-mac.yml'].sort())
    for (const line of readFileSync(join(staged, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
      const [hash, name] = line.split('  ')
      expect(createHash('sha256').update(readFileSync(join(staged, name!))).digest('hex')).toBe(hash)
    }
    expect(readFileSync(join(staged, 'nightly-mac.yml'), 'utf8')).toBe(dump(metadata))
  })

  it.each(['version', 'commit', 'dirty', 'environment', 'signing'])('rejects a mismatched completion record: %s', async (field) => {
    const { stageOptions, artifacts, record, directory } = await completedFixture()
    const changed = { ...record, [field]: field === 'dirty' ? true : field === 'version' ? '0.2.0-rc.2.20261010.8' : field === 'commit' ? 'b'.repeat(40) : 'wrong' }
    writeFileSync(join(artifacts, 'mac-arm64-release.json'), JSON.stringify(changed))
    await expect(stageMacOSCIArtifacts(stageOptions)).rejects.toThrow()
    expect(existsSync(join(directory, 'deliverables'))).toBe(false)
  })

  it('rejects changed payload bytes and missing completion records without creating successful deliverables', async () => {
    const { stageOptions, artifacts, base, directory } = await completedFixture()
    writeFileSync(join(artifacts, `${base}.zip`), 'tampered')
    await expect(stageMacOSCIArtifacts(stageOptions)).rejects.toThrow('SHA-512')
    expect(existsSync(join(directory, 'deliverables'))).toBe(false)
    await rm(join(artifacts, 'mac-arm64-release.json'))
    await expect(stageMacOSCIArtifacts(stageOptions)).rejects.toThrow()
  })

  it('retains only new journals and redacts passwords, private keys and URL tokens on failures', async () => {
    const { options, appRoot, directory } = await fixture()
    await prepareMacOSCI({ ...options, environment })
    const run = join(appRoot, '.desktop-build', 'packaging-runs', 'fixture-failed-run')
    mkdirSync(run, { recursive: true })
    writeFileSync(join(run, 'stderr.log'), `failure ${environment.MACOS_CERTIFICATE_PASSWORD}\nhttps://localhost/?dsh_token=fixture-token\n-----BEGIN PRIVATE KEY-----\nprivate fixture\n-----END PRIVATE KEY-----\n`)
    writeFileSync(join(run, 'result.json'), '{"success":false}')
    writeFileSync(join(run, 'private.p12'), 'must not upload')
    collectMacOSCIDiagnostics(options)
    const output = join(directory, 'diagnostics', 'fixture-failed-run')
    expect(readdirSync(output).sort()).toEqual(['result.json', 'stderr.log'])
    const log = readFileSync(join(output, 'stderr.log'), 'utf8')
    expect(log).not.toContain(environment.MACOS_CERTIFICATE_PASSWORD)
    expect(log).not.toContain('fixture-token')
    expect(log).not.toContain('private fixture')
    expect(log).toContain('failure')
    cleanupMacOSCI(options)
    expect(existsSync(output)).toBe(true)
  })
})
