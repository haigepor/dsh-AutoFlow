/** Real Electron fixed proxy, PAC, proxy challenges, and TLS rejection with isolated sessions. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { session } from 'electron'
import { createDesktopUpdateFetch } from '../../lib/types/update-fetch.js'
import { DesktopUpdateDownload, desktopDownloadConfig } from '../../lib/types/update-download.js'

/** @param root - Private qualification directory. @returns Passed network scenarios; no system proxy or CA store is modified. */
export async function qualifyUpdateNetwork(root) {
  const payload = Buffer.alloc(512 * 1024, 0x63)
  const sha512 = createHash('sha512').update(payload).digest('base64')
  const headers = []
  const cases = []
  const expectedAuth = `Basic ${Buffer.from('fixture:private-proxy').toString('base64')}`
  let requireAuth = false
  let origin
  const proxy = createServer((request, response) => {
    if (request.url === '/proxy.pac') {
      response.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig' })
      response.end(`function FindProxyForURL(url, host) { return "PROXY 127.0.0.1:${proxy.address().port}"; }`)
      return
    }
    headers.push(request.headers)
    if (requireAuth && request.headers['proxy-authorization'] !== expectedAuth) {
      response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="desktop-fixture"', 'Content-Length': '0' }).end()
      return
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
    const start = Number(match?.[1] ?? 0), end = match?.[2] ? Number(match[2]) : payload.length - 1
    response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${payload.length}`, 'Content-Length': end - start + 1 })
    response.end(payload.subarray(start, end + 1))
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${proxy.address().port}`
  try {
    for (const mode of ['fixed', 'pac', 'authenticated']) {
      const scope = session.fromPartition(`desktop-update-network-${mode}-${Date.now()}`, { cache: false })
      requireAuth = mode === 'authenticated'
      await scope.setProxy(mode === 'pac' ? { mode: 'pac_script', pacScript: `${origin}/proxy.pac` }
        : { mode: 'fixed_servers', proxyRules: `127.0.0.1:${proxy.address().port}` })
      await scope.cookies.set({ url: 'http://desktop-update.invalid', name: 'account', value: 'private-account' })
      let challenges = 0
      const fetch = createDesktopUpdateFetch(scope, (auth, callback) => {
        assert.equal(auth.isProxy, true)
        challenges++
        callback('fixture', 'private-proxy')
      })
      const directory = join(root, `network-${mode}`)
      const download = new DesktopUpdateDownload(desktopDownloadConfig(directory, {
        DSH_DESKTOP_UPDATE_CONNECTIONS: '4', DSH_DESKTOP_UPDATE_PIECE_BYTES: '65536',
      }), fetch, () => {})
      try {
        await download.select({ source: 'github' })
        await download.download({ url: new URL('http://desktop-update.invalid/payload.exe'), version: '2.0.0', size: payload.length, sha512 },
          join(directory, 'verified.exe'))
        assert.deepEqual(await readFile(join(directory, 'verified.exe')), payload)
        if (requireAuth) assert.ok(challenges > 0)
        cases.push(`electron-${mode}-proxy-segmented-integrity`)
      } finally { await scope.closeAllConnections() }
    }
    assert.ok(headers.every(value => value.cookie === undefined && value.authorization === undefined))
    cases.push('public-artifact-requests-omit-account-cookies-and-origin-authorization')
  } finally {
    proxy.closeAllConnections()
    await new Promise((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()))
  }
  const tlsRoot = join(root, 'untrusted-tls')
  await mkdir(tlsRoot, { recursive: true })
  const key = join(tlsRoot, 'test.key'), cert = join(tlsRoot, 'test.pem'), config = join(tlsRoot, 'openssl.cnf')
  await writeFile(config, '[req]\ndistinguished_name=dn\n[dn]\n', 'utf8')
  const openssl = process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl'
  await promisify(execFile)(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-config', config, '-keyout', key, '-out', cert], { windowsHide: true })
  const tls = createTlsServer({ key: await readFile(key), cert: await readFile(cert) }, (_request, response) => response.end(payload))
  tls.on('tlsClientError', () => { /* The test deliberately refuses this self-signed certificate. */ })
  await new Promise(resolve => tls.listen(0, '127.0.0.1', resolve))
  const scope = session.fromPartition(`desktop-update-untrusted-tls-${Date.now()}`, { cache: false })
  await scope.setProxy({ mode: 'direct' })
  try {
    await assert.rejects(createDesktopUpdateFetch(scope)(`https://127.0.0.1:${tls.address().port}/payload.exe`), /CERT_/)
    cases.push('electron-rejects-untrusted-certificate-without-a-tls-override')
  } finally {
    await scope.closeAllConnections()
    tls.closeAllConnections()
    await new Promise((resolve, reject) => tls.close(error => error ? reject(error) : resolve()))
  }
  return cases
}
