/** Windows packaged transport qualification with inert payloads and a private cache; never starts an installer. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, session } from 'electron'
import { DesktopDownloadPaused, DesktopUpdateDownload, desktopDownloadConfig } from '../../src/update-download.ts'
import { createDesktopUpdateFetch } from '../../src/update-fetch.ts'
import { createUpdateServer } from './update-server.mjs'

const root = process.env.DSH_UPDATE_PACKAGE_TEST_ROOT
if (!root) throw new Error('The qualification launcher must provide a private root')
app.setPath('userData', join(root, 'userData'))
app.setPath('sessionData', join(root, 'chromium'))
async function main() {
  await app.whenReady()
  assert.equal(app.isPackaged, true)
  assert.equal(process.platform, 'win32')
  assert.equal(process.arch, 'x64')
  assert.ok(app.getAppPath().endsWith('app.asar'))
  const server = await createUpdateServer()
  try {
    const artifact = { url: new URL('https://github.com/fixture/application/releases/download/v2/payload.exe'),
      version: '2.0.0', size: server.payload.length, sha512: createHash('sha512').update(server.payload).digest('base64') }
    const publicFetch = createDesktopUpdateFetch(session.fromPartition('packaged-update-test', { cache: false }))
    const fetch = (_url, options) => publicFetch(`${server.url}payload.exe`, options)
    const config = desktopDownloadConfig(join(root, 'cache'), { DSH_DESKTOP_UPDATE_CONNECTIONS: '4', DSH_DESKTOP_UPDATE_PIECE_BYTES: '65536' })
    const first = new DesktopUpdateDownload(config, fetch, state => { if (state.stage === 'downloading' && state.transferred > 0) first.pause() })
    await first.select({ source: 'github' })
    await assert.rejects(first.download(artifact, join(root, 'unused.exe')), DesktopDownloadPaused)
    const next = new DesktopUpdateDownload({ ...config, connections: 1 }, fetch, () => {})
    await next.initialize()
    await next.select({ source: 'ghfast' })
    const destination = join(root, 'verified.exe')
    await next.download(artifact, destination)
    const { readFile } = await import('node:fs/promises')
    assert.deepEqual(await readFile(destination), server.payload)
    await writeFile(join(root, 'result.json'), `${JSON.stringify({ packaged: app.isPackaged, asar: app.getAppPath(),
      platform: process.platform, arch: process.arch, electron: process.versions.electron, kernel: 'Electron',
      bytes: artifact.size, verified: true, paused: true, resumedAfterOwnerRecreation: true, switchedSource: true,
      installerExecuted: false, externalDownloadBinary: false }, null, 2)}\n`, 'utf8')
  } finally { await server.close() }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
