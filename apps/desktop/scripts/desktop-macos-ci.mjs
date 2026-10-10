/** Assemble private CI configuration and retain verified artifacts without publishing them. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const TARGET = 'mac-arm64'
const LOG_FILES = ['run.json', 'events.jsonl', 'result.json', 'stdout.log', 'stderr.log', 'fatal.json']

/**
 * Reject implicit environments, automatic versions and a checkout different from the confirmed commit.
 * @param {{deployment: string, version: string, productVersion: string, expectedCommit: string, actualCommit: string, dirty: boolean}} input Confirmed dispatch values and observed checkout.
 * @returns {void}
 */
export function validateMacOSCIBuild(input) {
  if (!['test', 'production'].includes(input.deployment)) throw new Error('desktop macOS CI: explicitly select test or production')
  if (!/^[0-9a-f]{40}$/u.test(input.expectedCommit) || input.expectedCommit !== input.actualCommit || input.dirty) {
    throw new Error('desktop macOS CI: expected_commit must match the clean checkout')
  }
  if (input.deployment === 'production') {
    if (input.version !== input.productVersion) throw new Error('desktop macOS CI: production version must equal the complete product version')
    return
  }
  const prefix = input.productVersion.includes('-') ? `${input.productVersion}.` : `${input.productVersion}-test.`
  if (!input.version.startsWith(prefix)) throw new Error('desktop macOS CI: test version must extend the complete product version')
  const suffix = input.version.slice(prefix.length)
  if (!/^\d{8}\.[1-9]\d*$/u.test(suffix)) throw new Error('desktop macOS CI: test version requires YYYYMMDD.index; auto is forbidden')
  const date = suffix.slice(0, 8)
  const parsed = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10).replaceAll('-', '') !== date) {
    throw new Error('desktop macOS CI: test version contains an invalid calendar date')
  }
}

function required(environment, name) {
  const value = environment[name]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`desktop macOS CI: missing ${name}`)
  return value
}

function checkedRoot(directory, runnerTemp) {
  const root = realpathSync(directory)
  if (lstatSync(directory).isSymbolicLink() || dirname(root) !== realpathSync(runnerTemp)
    || !/^desktop-macos-ci-[A-Za-z0-9]+$/u.test(basename(root))) {
    throw new Error('desktop macOS CI: temporary directory is outside the owned runner root')
  }
  return root
}

function regularFile(path) {
  if (!lstatSync(path).isFile()) throw new Error('desktop macOS CI: expected a regular file, not a link or directory')
  return lstatSync(path)
}

function plainFile(path) {
  regularFile(path)
  return readFileSync(path)
}

/**
 * Allocate one run's private credentials, temporary files and non-hidden artifact staging directories.
 * @param {string} runnerTemp Existing GitHub runner temporary directory.
 * @param {string} appRoot Desktop checkout directory.
 * @returns {string} Owned root; never cache or upload it wholesale.
 */
export function initializeMacOSCI(runnerTemp, appRoot) {
  const root = mkdtempSync(join(realpathSync(runnerTemp), 'desktop-macos-ci-'))
  for (const name of ['credentials', 'temporary', 'diagnostics']) mkdirSync(join(root, name), { mode: 0o700 })
  const runs = join(appRoot, '.desktop-build', 'packaging-runs')
  writeFileSync(join(root, 'state.json'), JSON.stringify({ appRoot: realpathSync(appRoot), previousRuns: existsSync(runs) ? readdirSync(runs) : [] }), { flag: 'wx', mode: 0o600 })
  return root
}

function state(directory, runnerTemp, appRoot) {
  const root = checkedRoot(directory, runnerTemp)
  const stored = JSON.parse(plainFile(join(root, 'state.json')).toString('utf8'))
  if (stored.appRoot !== realpathSync(appRoot) || !Array.isArray(stored.previousRuns) || !stored.previousRuns.every(name => typeof name === 'string')) {
    throw new Error('desktop macOS CI: temporary state does not match the checkout')
  }
  return { root, previousRuns: stored.previousRuns }
}

function decodeCredential(value, name) {
  const normalized = value.replace(/\s/gu, '')
  const bytes = Buffer.from(normalized, 'base64')
  if (bytes.length === 0 || bytes.toString('base64') !== normalized) throw new Error(`desktop macOS CI: invalid Base64 in ${name}`)
  return bytes
}

function dotenv(settings) {
  const text = Object.entries(settings).map(([name, value]) => {
    const quote = ["'", '"', '`'].find(delimiter => !value.includes(delimiter))
    if (quote === undefined || value.includes('\0')) throw new Error(`desktop macOS CI: ${name} cannot be represented safely in dotenv`)
    return `${name}=${quote}${value}${quote}`
  }).join('\n') + '\n'
  const parsed = parseEnv(text)
  if (Object.entries(settings).some(([name, value]) => parsed[name] !== value)) throw new Error('desktop macOS CI: dotenv round-trip failed')
  return text
}

function security(args) {
  try { return execFileSync('/usr/bin/security', args, { encoding: 'utf8', stdio: 'pipe', timeout: 120_000 }) }
  catch (error) { throw new Error('desktop macOS CI: keychain operation failed') }
}

function header(root) { return `# Generated by desktop-macos-ci: ${basename(root)}\n` }

/**
 * Decode P12/API credentials and exclusively create the required platform dotenv; never overwrite local settings.
 * @param {{directory: string, runnerTemp: string, appRoot: string, environment: NodeJS.ProcessEnv, runSecurity?: (args: string[]) => string}} options Owned paths and Environment secrets. The security adapter observes only search-list operations.
 * @returns {Promise<void>} Resolves after existing package configuration validation, without signing or contacting Apple.
 */
export async function prepareMacOSCI(options) {
  const { root } = state(options.directory, options.runnerTemp, options.appRoot)
  const env = options.environment
  const config = join(options.appRoot, '.env.macos')
  if (existsSync(config)) throw new Error('desktop macOS CI: refusing to overwrite existing .env.macos')
  if (env.MACOS_CERTIFICATE_PASSWORD === undefined) throw new Error('desktop macOS CI: missing MACOS_CERTIFICATE_PASSWORD')
  const keychains = (options.runSecurity ?? security)(['list-keychains', '-d', 'user'])
    .split('\n').map(line => line.trim().replace(/^"|"$/gu, '')).filter(Boolean)
  writeFileSync(join(root, 'keychains.json'), JSON.stringify(keychains), { flag: 'wx', mode: 0o600 })
  const certificate = join(root, 'credentials', 'developer-id.p12')
  const apiKey = join(root, 'credentials', 'notary.p8')
  writeFileSync(certificate, decodeCredential(required(env, 'MACOS_CERTIFICATE_P12_BASE64'), 'MACOS_CERTIFICATE_P12_BASE64'), { flag: 'wx', mode: 0o600 })
  writeFileSync(apiKey, decodeCredential(required(env, 'APPLE_API_KEY_BASE64'), 'APPLE_API_KEY_BASE64'), { flag: 'wx', mode: 0o600 })
  const settings = {
    DSH_DESKTOP_APP_ID: required(env, 'DESKTOP_APP_ID'),
    DSH_DESKTOP_AUTO_UPDATE_ENV: required(env, 'DEPLOYMENT'),
    DSH_DESKTOP_UPDATE_PROVIDER: 'github',
    DSH_DESKTOP_GITHUB_REPOSITORY: required(env, 'GITHUB_REPOSITORY'),
    DSH_DESKTOP_GITHUB_PAGES_URL: required(env, 'DESKTOP_GITHUB_PAGES_URL'),
    DSH_DESKTOP_MANDATORY_UPDATE_SOURCE: 'static-json',
    DSH_DESKTOP_MANDATORY_UPDATE_URL: `${required(env, 'DESKTOP_GITHUB_PAGES_URL')}policy.json`,
    DSH_DESKTOP_MACOS_SIGNING_IDENTITY: required(env, 'MACOS_SIGNING_IDENTITY'),
    DSH_DESKTOP_MACOS_TEAM_ID: required(env, 'MACOS_TEAM_ID'),
    DSH_DESKTOP_MACOS_PACK_CONCURRENCY: '2',
    CSC_LINK: certificate,
    CSC_KEY_PASSWORD: env.MACOS_CERTIFICATE_PASSWORD,
    APPLE_API_KEY: apiKey,
    APPLE_API_KEY_ID: required(env, 'APPLE_API_KEY_ID'),
    APPLE_API_ISSUER: required(env, 'APPLE_API_ISSUER'),
  }
  writeFileSync(config, header(root) + dotenv(settings), { flag: 'wx', mode: 0o600 })
  const { loadDesktopPackageEnvironment, validateDesktopPackageEnvironment } = await import('./desktop-package-environment.mjs')
  validateDesktopPackageEnvironment(loadDesktopPackageEnvironment('darwin', {}, options.appRoot), { platform: 'darwin', arch: 'arm64' })
}

function redact(text, secrets) {
  for (const secret of [...new Set(secrets.filter(Boolean))].sort((left, right) => right.length - left.length)) text = text.replaceAll(secret, '[REDACTED]')
  return text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, '[REDACTED PRIVATE KEY]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gu, '$1[REDACTED]@')
    .replace(/([?&][\w-]*(?:token|secret|password|api_key|authorization)[\w-]*=)[^&\s"'\\]+/giu, '$1[REDACTED]')
}

/**
 * Retain only new packaging journals, with a second credential and URL-token redaction pass.
 * @param {{directory: string, runnerTemp: string, appRoot: string}} options Owned CI directories.
 * @returns {void} Copies no config, certificate, keychain or runtime preparation files.
 */
export function collectMacOSCIDiagnostics(options) {
  const { root, previousRuns } = state(options.directory, options.runnerTemp, options.appRoot)
  const config = join(options.appRoot, '.env.macos')
  const settings = existsSync(config) && plainFile(config).toString('utf8').startsWith(header(root)) ? parseEnv(plainFile(config).toString('utf8')) : {}
  const secrets = Object.entries(settings).filter(([name]) => /PASSWORD|SECRET|TOKEN|APPLE_API_/u.test(name)).map(([, value]) => value)
  const runs = join(options.appRoot, '.desktop-build', 'packaging-runs')
  if (!existsSync(runs)) return
  for (const name of readdirSync(runs).filter(name => !previousRuns.includes(name))) {
    const source = join(runs, name)
    if (!lstatSync(source).isDirectory()) throw new Error('desktop macOS CI: unexpected packaging run entry')
    const destination = join(root, 'diagnostics', name)
    mkdirSync(destination, { mode: 0o700 })
    for (const file of LOG_FILES) {
      if (existsSync(join(source, file))) writeFileSync(join(destination, file), redact(plainFile(join(source, file)).toString('utf8'), secrets), { flag: 'wx' })
    }
  }
}

/**
 * Verify signed completion/feed hashes using the publication validator, then stage an explicit file list.
 * @param {{directory: string, runnerTemp: string, appRoot: string, version: string, productVersion: string, deployment: string, expectedCommit: string}} options Confirmed dispatch and owned paths.
 * @returns {Promise<void>} Produces deliverables/SHA256SUMS; performs no network or publication operation.
 */
export async function stageMacOSCIArtifacts(options) {
  const { root } = state(options.directory, options.runnerTemp, options.appRoot)
  const { loadDesktopPackageEnvironment } = await import('./desktop-package-environment.mjs')
  const { prepareDesktopGithubPublication } = await import('./desktop-github-publication.ts')
  const artifactsRoot = join(options.appRoot, '.desktop-build', 'targets', TARGET, 'artifacts')
  const environment = loadDesktopPackageEnvironment('darwin', {}, options.appRoot)
  const publication = await prepareDesktopGithubPublication(TARGET, { environment, artifactsRoot, productVersion: options.productVersion })
  const recordName = `${TARGET}-release.json`
  const record = JSON.parse(plainFile(join(artifactsRoot, recordName)).toString('utf8'))
  if (publication.version !== options.version || publication.commit !== options.expectedCommit || publication.dirty
    || record.environment !== options.deployment || publication.signing !== 'signed') {
    throw new Error('desktop macOS CI: completed package differs from the confirmed build')
  }
  const names = [...publication.assets.map(asset => asset.name), publication.feedName, recordName]
  for (const name of names) if (regularFile(join(artifactsRoot, name)).size === 0) throw new Error('desktop macOS CI: empty artifact')
  const pending = join(root, 'deliverables-pending')
  mkdirSync(pending, { mode: 0o700 })
  const sums = []
  for (const name of names) {
    const destination = join(pending, name)
    copyFileSync(join(artifactsRoot, name), destination)
    const hash = createHash('sha256')
    // 安装包可能很大；流式计算摘要，避免同时把 DMG 和 ZIP 放入 runner 内存。
    for await (const chunk of createReadStream(destination)) hash.update(chunk)
    sums.push(`${hash.digest('hex')}  ${name}`)
  }
  writeFileSync(join(pending, 'SHA256SUMS'), sums.join('\n') + '\n', { flag: 'wx' })
  renameSync(pending, join(root, 'deliverables'))
}

function removeOwnedDirectory(path) {
  if (!existsSync(path)) return
  if (lstatSync(path).isSymbolicLink()) { unlinkSync(path); return }
  for (const name of readdirSync(path)) {
    const child = join(path, name)
    if (lstatSync(child).isDirectory()) removeOwnedDirectory(child)
    else unlinkSync(child)
  }
  rmdirSync(path)
}

/**
 * Restore the original keychain search list and remove only this run's credentials/configuration.
 * @param {{directory: string, runnerTemp: string, appRoot: string, runSecurity?: (args: string[]) => string}} options Owned paths; real Apple commands are required on the runner.
 * @returns {void} Preserves staged logs/installers and any pre-existing dotenv; cleanup errors fail the job.
 */
export function cleanupMacOSCI(options) {
  const { root } = state(options.directory, options.runnerTemp, options.appRoot)
  const failures = []
  const attempt = action => { try { action() } catch (error) { failures.push(error) } }
  if (existsSync(join(root, 'keychains.json'))) attempt(() => {
    const paths = JSON.parse(plainFile(join(root, 'keychains.json')).toString('utf8'))
    if (!Array.isArray(paths) || !paths.every(path => typeof path === 'string')) throw new Error('desktop macOS CI: invalid saved keychain list')
    const run = options.runSecurity ?? security
    run(['list-keychains', '-d', 'user', '-s', ...paths])
    const temporary = join(root, 'temporary')
    for (const name of readdirSync(temporary)) {
      if (!name.startsWith('dsh-macos-signing-')) continue
      const keychain = join(temporary, name, 'signing.keychain-db')
      if (existsSync(keychain)) run(['delete-keychain', keychain])
    }
  })
  const config = join(options.appRoot, '.env.macos')
  attempt(() => { if (existsSync(config) && plainFile(config).toString('utf8').startsWith(header(root))) unlinkSync(config) })
  attempt(() => removeOwnedDirectory(join(root, 'credentials')))
  attempt(() => removeOwnedDirectory(join(root, 'temporary')))
  // 上传动作仍使用本次 TMPDIR；删除凭据后保留一个空目录供后续步骤使用。
  attempt(() => mkdirSync(join(root, 'temporary'), { mode: 0o700 }))
  if (failures.length > 0) throw new AggregateError(failures, 'desktop macOS CI: cleanup failed')
}

async function main() {
  const command = process.argv[2]
  const appRoot = APP_ROOT
  const runnerTemp = required(process.env, 'RUNNER_TEMP')
  if (command === 'init') {
    const { readDesktopBuildCommit } = await import('./desktop-build-commit.mjs')
    const checkout = readDesktopBuildCommit(resolve(appRoot, '..', '..'))
    const productVersion = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')).version
    if (productVersion !== JSON.parse(readFileSync(join(appRoot, '..', '..', 'package.json'), 'utf8')).version) throw new Error('desktop macOS CI: product versions differ')
    validateMacOSCIBuild({ deployment: required(process.env, 'DEPLOYMENT'), version: required(process.env, 'BUILD_VERSION'),
      productVersion, expectedCommit: required(process.env, 'EXPECTED_COMMIT'), actualCommit: checkout.commit, dirty: checkout.dirty })
    const root = initializeMacOSCI(runnerTemp, appRoot)
    appendFileSync(required(process.env, 'GITHUB_ENV'), `DESKTOP_MACOS_CI_ROOT=${root}\nTMPDIR=${join(root, 'temporary')}${sep}\nDESKTOP_MACOS_DELIVERABLES=${join(root, 'deliverables')}\nDESKTOP_MACOS_DIAGNOSTICS=${join(root, 'diagnostics')}\n`)
    return
  }
  const options = { directory: required(process.env, 'DESKTOP_MACOS_CI_ROOT'), runnerTemp, appRoot }
  if (command === 'prepare') await prepareMacOSCI({ ...options, environment: process.env })
  else if (command === 'diagnostics') collectMacOSCIDiagnostics(options)
  else if (command === 'cleanup') cleanupMacOSCI(options)
  else if (command === 'stage') await stageMacOSCIArtifacts({ ...options, version: required(process.env, 'BUILD_VERSION'),
    productVersion: JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')).version,
    deployment: required(process.env, 'DEPLOYMENT'), expectedCommit: required(process.env, 'EXPECTED_COMMIT') })
  else throw new Error('desktop macOS CI: unknown command')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // 配置和 Apple 工具异常可能含凭据；仅初始化阶段允许输出未注入 Secrets 的输入校验错误。
    console.error(process.argv[2] === 'init' ? error.message : `desktop macOS CI: ${process.argv[2]} failed; inspect configuration and the retained packaging diagnostics`)
    process.exitCode = 1
  })
}
