/** Run the owner-local benchmark through the production Electron adapter, preserving isolated evidence and logs. */
import { build } from 'tsdown'
import electron from 'electron'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { packagedImportsPlugin } from './desktop-bundle-imports.mjs'

const { values } = parseArgs({ options: { artifact: { type: 'string' }, source: { type: 'string', default: 'github' },
  connections: { type: 'string', default: '1,4,8,16' }, rounds: { type: 'string', default: '2' },
  'budget-ms': { type: 'string', default: '0' } } })
const appRoot = fileURLToPath(new URL('../', import.meta.url))
const evidence = join(appRoot, '.desktop-build', 'qualification')
await mkdir(evidence, { recursive: true })
const root = await mkdtemp(join(evidence, 'download-performance-'))
console.log(`Download measurement evidence: ${root}`)
await build({ config: false, entry: [join(appRoot, 'tests', 'update-download.perf.ts')], outDir: root,
  format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, clean: false, dts: false, codeSplitting: false,
  deps: { neverBundle: ['electron'], alwaysBundle: [/^@deepseek-ai\//] },
  plugins: [packagedImportsPlugin({ packages: new Set(['electron']), nodeBuiltins: true })] })
const bootstrap = join(root, 'bootstrap.cjs')
await writeFile(bootstrap, "const {app} = require('electron'); import('./update-download.perf.js').then(() => app.exit(0), error => { console.error(error); app.exit(1) });\n", 'utf8')
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$|^DSH_DESKTOP_DOWNLOAD_PERF_/iu.test(name)))
const log = await open(join(root, 'electron.log'), 'w')
const child = spawn(electron, [bootstrap], { windowsHide: true, stdio: ['ignore', log.fd, log.fd], env: {
  ...env, DSH_DESKTOP_DOWNLOAD_PERF_ROOT: root, DSH_DESKTOP_DOWNLOAD_PERF_SOURCE: values.source,
  DSH_DESKTOP_DOWNLOAD_PERF_CONNECTIONS: values.connections, DSH_DESKTOP_DOWNLOAD_PERF_ROUNDS: values.rounds,
  DSH_DESKTOP_DOWNLOAD_PERF_LIMIT_MS: values['budget-ms'],
  ...(values.artifact === undefined ? {} : { DSH_DESKTOP_DOWNLOAD_PERF_ARTIFACT: resolve(values.artifact) }),
} })
let timedOut = false
const timeout = setTimeout(() => { timedOut = true; child.kill() }, 30 * 60 * 1000)
try {
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  if (timedOut || result.code !== 0 || result.signal !== null) throw new Error(`Measurement runner failed: ${JSON.stringify({ timedOut, ...result })}; see ${root}`)
  const data = JSON.parse(await readFile(join(root, 'results.json'), 'utf8'))
  for (const { round, connections, complete, failure, receivedBytes, mibPerSecond } of data.cases) {
    console.log(JSON.stringify({ round, connections, complete, failure, receivedBytes, mibPerSecond }))
  }
} finally { clearTimeout(timeout); await log.close() }
