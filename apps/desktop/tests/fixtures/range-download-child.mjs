/** Isolated Electron transport crash/restart fixture; downloads inert bytes and never loads the application Host. */
import { join } from 'node:path'
import { app, session } from 'electron'
import { DesktopUpdateDownload, desktopDownloadConfig } from '../../lib/types/update-download.js'
import { createDesktopUpdateFetch } from '../../lib/types/update-fetch.js'

const root = process.env.DSH_RANGE_TEST_ROOT
const url = process.env.DSH_RANGE_TEST_URL
if (!root || !url) throw new Error('The parent must supply a private root and loopback artifact')
app.setPath('userData', join(root, 'userData'))
app.setPath('sessionData', join(root, 'chromium'))
async function main() {
  await app.whenReady()
  const artifact = { url: new URL(url), version: '1.0.1-nightly.1',
    size: Number(process.env.DSH_RANGE_TEST_SIZE), sha512: process.env.DSH_RANGE_TEST_SHA512 }
  const download = new DesktopUpdateDownload(desktopDownloadConfig(join(root, 'cache'), {
    DSH_DESKTOP_UPDATE_CONNECTIONS: '16', DSH_DESKTOP_UPDATE_PIECE_BYTES: '131072',
  }), createDesktopUpdateFetch(session.fromPartition('range-download-child', { cache: false })),
  progress => { process.send?.({ kind: 'progress', transferred: progress.transferred }) },
  value => { if (value.phase === 'checkpoint') process.send?.({ kind: 'checkpoint' }) })
  await download.select({ source: 'github' })
  await download.download(artifact, join(root, 'verified.exe'))
  process.send?.({ kind: 'complete' })
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
