/** Opt-in owner-local transport measurements; fresh files, shared OS/CDN caches, no installer execution. */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { DesktopDownloadPaused, DesktopUpdateDownload, desktopDownloadConfig,
  type DesktopDownloadArtifact, type DesktopDownloadMeasurement } from '../src/update-download.ts'

const root = process.env.DSH_DESKTOP_DOWNLOAD_PERF_ROOT
if (root === undefined) throw new Error('Set DSH_DESKTOP_DOWNLOAD_PERF_ROOT to an isolated evidence directory')
await mkdir(root, { recursive: true })
let fetcher: typeof fetch = globalThis.fetch
if (process.versions.electron !== undefined) {
  const { app, session } = await import('electron')
  app.setPath('userData', join(root, 'userData'))
  app.setPath('sessionData', join(root, 'chromium'))
  await mkdir(join(root, 'chromium'), { recursive: true })
  await app.whenReady()
  const { createDesktopUpdateFetch } = await import('../src/update-fetch.ts')
  fetcher = createDesktopUpdateFetch(session.fromPartition('desktop-update-performance', { cache: false }))
}
const publicFile = process.env.DSH_DESKTOP_DOWNLOAD_PERF_ARTIFACT
const payload = publicFile === undefined ? Buffer.alloc(64 * 1024 * 1024, 0x5a) : undefined
const server = createServer((request, response) => {
  if (payload === undefined) { response.writeHead(404).end(); return }
  const match = /^bytes=(\d+)-(\d*)$/u.exec(request.headers.range ?? '')
  const start = Number(match?.[1] ?? 0), end = match?.[2] ? Number(match[2]) : payload.length - 1
  response.writeHead(match === null ? 200 : 206, { 'Content-Length': end - start + 1,
    'Cache-Control': 'no-store', ...(match === null ? {} : { 'Content-Range': `bytes ${start}-${end}/${payload.length}` }) })
  response.end(payload.subarray(start, end + 1))
})
if (payload !== undefined) await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
const address = server.address()
const checked = publicFile === undefined ? undefined : JSON.parse(await readFile(publicFile, 'utf8')) as {
  url: string
  version: string
  size: number
  sha512: string
}
const artifact: DesktopDownloadArtifact = checked === undefined ? {
  url: new URL(`http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}/payload.exe`),
  version: '2.0.0', size: payload!.length, sha512: createHash('sha512').update(payload!).digest('base64'),
} : { ...checked, url: new URL(checked.url) }
const cases: object[] = []
const limitMs = Number(process.env.DSH_DESKTOP_DOWNLOAD_PERF_LIMIT_MS ?? '0')
const rounds = Number(process.env.DSH_DESKTOP_DOWNLOAD_PERF_ROUNDS ?? '2')
const order = (process.env.DSH_DESKTOP_DOWNLOAD_PERF_CONNECTIONS ?? '1,4,8,16').split(',').map(Number)
try {
  for (let round = 0; round < rounds; round++) {
    for (const connections of round % 2 === 0 ? order : [...order].reverse()) {
      const directory = join(root, `round-${round}-connections-${connections}`)
      const measurements: DesktopDownloadMeasurement[] = []
      const sources = new Set<string>()
      const config = desktopDownloadConfig(directory, { ...process.env, DSH_DESKTOP_UPDATE_CONNECTIONS: String(connections) })
      const download = new DesktopUpdateDownload(config, fetcher, (value) => { if (value.source !== undefined) sources.add(value.source) },
        value => measurements.push(value))
      await download.select({ source: process.env.DSH_DESKTOP_DOWNLOAD_PERF_SOURCE ?? 'github' })
      const cpu = process.cpuUsage(), loop = monitorEventLoopDelay({ resolution: 10 })
      loop.enable()
      let peakRss = process.memoryUsage().rss
      const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 25)
      const timeout = limitMs > 0 ? setTimeout(() => { download.pause() }, limitMs) : undefined
      const started = performance.now()
      let complete = false
      let failure: string | undefined
      try { await download.download(artifact, join(root, `verified-${round}-${connections}.exe`)); complete = true }
      catch (error) { if (!(error instanceof DesktopDownloadPaused)) failure = error instanceof Error ? error.message : String(error) }
      finally { clearInterval(sample); clearTimeout(timeout); loop.disable() }
      const durationMs = performance.now() - started
      const transferred = complete ? artifact.size : download.state.transferred
      const restoredBytes = measurements.find(value => value.phase === 'restore')?.bytes ?? 0
      const result = { round, connections, pieceBytes: config.pieceBytes, complete, failure, durationMs, transferred,
        restoredBytes, sources: [...sources], receivedBytes: transferred - restoredBytes,
        mibPerSecond: (transferred - restoredBytes) / 1024 ** 2 / (durationMs / 1000), mainCpu: process.cpuUsage(cpu), peakMainRss: peakRss,
        finalMainRss: process.memoryUsage().rss, eventLoopP99Ms: loop.percentile(99) / 1e6, eventLoopMaxMs: loop.max / 1e6,
        measurements }
      cases.push(result)
      await writeFile(join(root, 'results.json'), `${JSON.stringify({ runtime: process.versions, fileBytes: artifact.size,
        source: process.env.DSH_DESKTOP_DOWNLOAD_PERF_SOURCE ?? 'github',
        conditions: 'Fresh app-owned cache per case; shared OS and CDN caches uncontrolled; no same-source retries; startup, resume validation and final verification included; CPU/RSS/event loop cover main process only', cases }, null, 2)}\n`, 'utf8')
      console.log(JSON.stringify({ ...result, measurements: measurements.reduce<Record<string, number>>((sum, value) => {
        sum[value.phase] = (sum[value.phase] ?? 0) + value.durationMs; return sum
      }, {}) }))
    }
  }
} finally {
  server.closeAllConnections()
  if (server.listening) await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve() })
  })
}
