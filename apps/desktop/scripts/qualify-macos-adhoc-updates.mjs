/** Exercise Squirrel download, signature validation, replacement and relaunch using private fixture apps. */
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createReadStream, existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { signMacOSAdHocUpdateBundle } from './verify-macos-signature.mjs'

assert.equal(process.platform, 'darwin', 'Native macOS qualification requires a macOS host')
const require = createRequire(import.meta.url)
const electron = require('electron')
const original = dirname(dirname(dirname(electron)))
assert(original.endsWith('/Electron.app'))
const root = await mkdtemp(join(tmpdir(), 'autoflow-macos-update-'))
const resultFile = join(root, 'result.json')
const identifier = 'com.autoflow.update-probe.unsigned'
const zip = join(root, 'update.zip')
let child
let installedPid
let completed = false
const server = createServer((request, response) => {
  if (request.url?.startsWith('/feed')) {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ url: `http://localhost:${server.address().port}/update.zip`,
      name: '1.0.2', notes: 'Private updater qualification', pub_date: new Date().toISOString() }))
  } else if (request.url === '/update.zip') {
    response.setHeader('content-type', 'application/zip')
    createReadStream(zip).pipe(response)
  } else { response.writeHead(404); response.end() }
})

try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  await mkdir(join(root, 'user-data'))
  const base = join(root, 'installed', 'Probe.app'), next = join(root, 'candidate', 'Probe.app')
  const appScript = `const { app, autoUpdater } = require('electron');
    const fs = require('node:fs');
    app.setPath('userData', ${JSON.stringify(join(root, 'user-data'))});
    app.disableHardwareAcceleration();
    const save = value => fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(value));
    app.whenReady().then(() => {
      if (app.getVersion() === '1.0.2') { save({ installed: true, version: app.getVersion(), pid: process.pid }); app.quit(); return; }
      autoUpdater.once('error', error => { save({ error: String(error) }); app.exit(1); });
      autoUpdater.once('update-downloaded', () => { save({ downloaded: true }); autoUpdater.quitAndInstall(); });
      autoUpdater.setFeedURL({ url: ${JSON.stringify(`http://localhost:${server.address().port}/feed`)} });
      autoUpdater.checkForUpdates();
    });`
  for (const [bundle, version] of [[base, '1.0.1'], [next, '1.0.2']]) {
    await mkdir(dirname(bundle), { recursive: true })
    await cp(original, bundle, { recursive: true, verbatimSymlinks: true })
    const app = join(bundle, 'Contents', 'Resources', 'app')
    await mkdir(app)
    await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'update-probe', version, main: 'main.cjs' }))
    await writeFile(join(app, 'main.cjs'), appScript)
    const plist = join(bundle, 'Contents', 'Info.plist')
    for (const [key, value] of [['CFBundleIdentifier', identifier], ['CFBundleVersion', version], ['CFBundleShortVersionString', version]]) {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist])
    }
    // This private fixture serves only localhost; product HTTPS and ATS settings are unchanged.
    const transport = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :NSAppTransportSecurity', plist])
    if (transport.status !== 0) execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :NSAppTransportSecurity dict', plist])
    execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true', plist])
    // Raw Electron distributions need their nested frameworks sealed before the enclosing fixture app.
    execFileSync('/usr/bin/codesign', ['--deep', '--force', '--sign', '-', '--identifier', identifier, '--timestamp=none', bundle])
  }
  const shown = spawnSync('/usr/bin/codesign', ['--display', '-r-', base], { encoding: 'utf8' })
  assert.equal(shown.status, 0)
  const displayed = shown.stdout + shown.stderr
  const defaultRequirement = displayed.split('designated => ')[1]?.trim()
  assert(defaultRequirement?.includes('cdhash'), 'Negative control must use the default per-build ad-hoc requirement')
  assert.throws(() => execFileSync('/usr/bin/codesign', ['--verify', '--strict', '-R', `=${defaultRequirement}`, next], { stdio: 'pipe' }),
    'A different build must fail the default ad-hoc requirement')
  await signMacOSAdHocUpdateBundle(base, identifier)
  await signMacOSAdHocUpdateBundle(next, identifier)
  const requirement = `=identifier "${identifier}"`
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', requirement, next])
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', next, zip])
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:PATH|HOME|TMPDIR|LANG|LC_ALL)$/u.test(name)))
  child = spawn(join(base, 'Contents', 'MacOS', 'Electron'), [], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
  let diagnostic = ''
  child.stdout.on('data', data => { diagnostic = (diagnostic + data.toString()).slice(-8192) })
  child.stderr.on('data', data => { diagnostic = (diagnostic + data.toString()).slice(-8192) })
  const exited = once(child, 'exit')
  const deadline = Date.now() + 120000
  let result
  while (Date.now() < deadline) {
    if (existsSync(resultFile)) {
      result = JSON.parse(await readFile(resultFile, 'utf8'))
      if (result.error || result.installed) break
    }
    await delay(100)
  }
  assert.equal(result?.installed, true, `Native update failed: ${JSON.stringify(result)} ${diagnostic}`)
  installedPid = result.pid
  assert.equal(result.version, '1.0.2')
  assert.equal(execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleVersion', join(base, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim(), '1.0.2')
  await exited
  completed = true
  console.log(JSON.stringify({ nativeMacOSUpdate: true, arch: process.arch, negativeControlRejected: true,
    download: true, replacedVersion: result.version, relaunched: true, certificate: false }))
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit') }
  if (installedPid) {
    const deadline = Date.now() + 10000
    for (;;) {
      try { process.kill(installedPid, 0) } catch (_error) { break }
      if (Date.now() >= deadline) throw new Error('Private relaunched fixture did not exit; retain its temporary files')
      await delay(100)
    }
  }
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  if (completed) await rm(root, { recursive: true, force: true })
  else console.error(`Private updater qualification retained at ${root}`)
}
