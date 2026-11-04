/** Validate the assembled application, including native Office conversion outside ASAR. */
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { load } from 'js-yaml'
import { z } from 'zod'
import { desktopArtifactOutput, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { readDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { verifyWindowsCode } from './windows-runtime-signature.mjs'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { resolveDesktopPackageTarget } from './package-target.ts'
import { resolveDesktopAppId } from './desktop-release-environment.mjs'
import { verifyMacOSAdHocUpdateSignature } from './verify-macos-signature.mjs'
import { resolveDesktopAutoUpdateConfig } from './desktop-auto-update-environment.mjs'

const paths = resolveDesktopTargetBuildPaths()
const { values } = parseArgs({ options: { unsigned: { type: 'boolean', default: false }, 'skip-notarization': { type: 'boolean', default: false } }, allowPositionals: false })
const target = resolveDesktopBuildTarget()
const windows = target === 'win-x64'
const artifacts = desktopArtifactOutput(paths, { unsigned: values.unsigned, skipNotarization: values['skip-notarization'] }).directory
const application = windows ? join(artifacts, 'win-unpacked')
  : join(artifacts, target === 'mac-arm64' ? 'mac-arm64' : 'mac', 'DeepSeek Harness.app', 'Contents')
const resources = join(application, windows ? 'resources' : 'Resources')
const executable = windows ? join(application, 'DeepSeek Harness.exe') : join(application, 'MacOS', 'DeepSeek Harness')
if (process.env.DSH_DESKTOP_UPDATE_PROVIDER === 'github'
  && (!values.unsigned || process.env.DSH_DESKTOP_UNSIGNED_UPDATES === '1')) {
  const update = resolveDesktopAutoUpdateConfig(process.env, windows ? 'win32' : 'darwin', target === 'mac-arm64' ? 'arm64' : 'x64')
  z.object({ provider: z.literal('generic'), url: z.literal(update.publicUrl), channel: z.literal(update.channel),
    useMultipleRangeRequest: z.literal(false) }).parse(load(await readFile(join(resources, 'app-update.yml'), 'utf8')))
  console.log(`Packaged ${windows ? 'Windows' : 'macOS'} GitHub update config: single Range requests verified.`)
}
const descriptor = await verifyDesktopRuntime(paths.dsh, readDesktopRuntime(paths.dsh).release.version,
  resolveDesktopPackageTarget(target))
if (windows && !values.unsigned) await verifyWindowsCode(application)
if (!windows && values.unsigned && process.env.DSH_DESKTOP_UNSIGNED_UPDATES === '1') {
  verifyMacOSAdHocUpdateSignature(dirname(application), resolveDesktopAppId(process.env))
}
await smokePreparedRuntime(join(resources, 'app.asar', 'dsh'), executable, join(resources, 'runtime'), descriptor)
