/** Build and run a private Windows x64 ASAR transport fixture without signing, publication, or installation. */
import { build as bundle } from 'tsdown'
import { build, Platform, Arch } from 'electron-builder'
import electron from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, mkdtemp, readFile, writeFile, open } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { packagedImportsPlugin } from './desktop-bundle-imports.mjs'

if (process.platform !== 'win32') throw new Error('Packaged update transport qualification requires Windows')
const appRoot = fileURLToPath(new URL('../', import.meta.url))
const evidence = join(appRoot, '.desktop-build', 'qualification')
await mkdir(evidence, { recursive: true })
const root = await mkdtemp(join(evidence, 'download-package-'))
const project = join(root, 'project'), runtime = join(root, 'runtime')
await mkdir(project, { recursive: true })
await mkdir(join(runtime, 'chromium'), { recursive: true })
await writeFile(join(project, 'package.json'), `${JSON.stringify({ name: 'dsh-update-transport-qualification', version: '0.0.0',
  private: true, type: 'module', main: 'packaged-download.js', description: 'Inert desktop download qualification', author: 'DeepSeek', license: 'MIT' })}\n`, 'utf8')
await bundle({ config: false, entry: [join(appRoot, 'tests', 'fixtures', 'packaged-download.mjs')], outDir: project,
  format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, clean: false, dts: false, codeSplitting: false,
  deps: { neverBundle: ['electron'], alwaysBundle: [/^@deepseek-ai\//, 'js-yaml'] },
  plugins: [packagedImportsPlugin({ packages: new Set(['electron']), nodeBuiltins: true })] })
const version = JSON.parse(await readFile(join(dirname(dirname(electron)), 'package.json'), 'utf8')).version
await build({ projectDir: project, targets: Platform.WINDOWS.createTarget('dir', Arch.x64), publish: 'never', config: {
  appId: 'app.deepseek.update-transport-qualification', productName: 'DSH update transport qualification',
  executableName: 'dsh-update-transport-qualification', electronVersion: version, electronDist: dirname(electron),
  asar: true, npmRebuild: false, nodeGypRebuild: false, files: ['packaged-download.js', 'package.json'],
  directories: { output: join(root, 'output') }, win: { signAndEditExecutable: false }, publish: null,
} })
const log = await open(join(root, 'runtime.log'), 'w')
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$/iu.test(name)))
const child = spawn(join(root, 'output', 'win-unpacked', 'dsh-update-transport-qualification.exe'), [], {
  env: { ...env, DSH_UPDATE_PACKAGE_TEST_ROOT: runtime }, stdio: ['ignore', log.fd, log.fd], windowsHide: true,
})
let timedOut = false
const timeout = setTimeout(() => { timedOut = true; child.kill() }, 60000)
try {
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  if (timedOut || result.code !== 0 || result.signal !== null) throw new Error(`Packaged download failed: ${JSON.stringify({ timedOut, ...result })}; evidence: ${root}`)
  console.log(`PACKAGED_DOWNLOAD_RESULT=${await readFile(join(runtime, 'result.json'), 'utf8')}`)
  console.log(`Packaged update transport evidence: ${root}`)
} finally { clearTimeout(timeout); await log.close() }
