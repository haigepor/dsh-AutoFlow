import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it, onTestFinished, vi } from 'vitest'
import { DesktopDownloadPaused, DesktopUpdateDownload, desktopDownloadConfig, type DesktopDownloadProgress, type DesktopDownloadConfig } from '../src/update-download.ts'
import { ArtifactDownloadRangeCache as DesktopUpdateRangeCache } from '@deepseek-ai/dsh-plugin-manager/src/artifact-download-cache.ts'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-update-resume-'))
  const bytes = Buffer.alloc(3 * 1024 * 1024)
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251
  const artifact = { url: new URL('https://github.com/example/application/releases/download/v2/setup.exe'), version: '2.0.0',
    size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') }
  const requests: { source: string; range: string }[] = []
  let slow = true
  let ignoreRange = false
  let corrupt = false
  let corruptSource: string | undefined
  let fault = ''
  let faultSource: string | undefined
  let active = 0
  let maximumActive = 0
  const handlers = new Set<Promise<void>>()
  const server = createServer((request, response) => {
    const handler = (async () => {
      const source = decodeURIComponent(request.url!.slice(1))
      const failingSource = faultSource === undefined || source.startsWith(faultSource)
      const range = request.headers.range ?? ''
      requests.push({ source, range })
      const [, rawStart, rawEnd] = /^bytes=(\d+)-(\d*)$/u.exec(range) ?? []
      const start = Number(rawStart ?? 0)
      const end = rawEnd ? Number(rawEnd) : bytes.length - 1
      const probe = end - start + 1 <= 16 * 1024
      if (probe && !source.startsWith('https://github.com/')) await delay(50)
      if (response.destroyed) return
      if (!probe && failingSource && ['403', '429'].includes(fault)) { response.writeHead(Number(fault)).end(); return }
      if (!probe && failingSource && fault === 'disconnect') { response.destroy(); return }
      const from = ignoreRange ? 0 : start
      const to = ignoreRange ? bytes.length - 1 : end
      response.writeHead(ignoreRange ? 200 : 206, { 'Content-Length': to - from + 1,
        ...ignoreRange ? {} : { 'Content-Range': `bytes ${failingSource && fault === 'wrong-range' && !probe ? start + 1 : start}-${end}/${bytes.length}` } })
      let released = false
      const release = (): void => { if (!released) { released = true; active-- } }
      if (!probe) { active++; maximumActive = Math.max(maximumActive, active); response.once('close', release) }
      if (!probe && failingSource && fault === 'stall') { response.write(bytes.subarray(from, from + 1024)); return }
      for (let offset = from; offset <= to; offset += 64 * 1024) {
        if (response.destroyed) return
        const chunk = Buffer.from(bytes.subarray(offset, Math.min(offset + 64 * 1024, to + 1)))
        if (corrupt && !probe) {
          corruptSource ??= source
          if (source === corruptSource) chunk.fill(7)
        }
        response.write(chunk)
        if (!probe && offset + chunk.length > to) release()
        if (!probe && failingSource && fault === 'truncate') { response.destroy(); return }
        if (slow && !probe) await delay(failingSource && fault === 'slow' ? 500 : 15)
      }
      response.end()
    })().catch((error: unknown) => { response.destroy(error instanceof Error ? error : new Error('Fixture response failed', { cause: error })) })
    handlers.add(handler)
    void handler.finally(() => { handlers.delete(handler) })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected local test port')
  const config = { ...desktopDownloadConfig(directory, {}), probeBytes: 16 * 1024, slowWindowMs: 10_000 }
  const make = (
    publish: (value: DesktopDownloadProgress) => void = () => {},
    overrides: Partial<DesktopDownloadConfig> = {},
  ): DesktopUpdateDownload => new DesktopUpdateDownload({ ...config, ...overrides },
    (url, options) => fetch(`http://127.0.0.1:${address.port}/${encodeURIComponent(
      typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)}`, options), publish)
  onTestFinished(async () => {
    const closed = new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    server.closeAllConnections()
    await closed
    await Promise.all(handlers)
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, bytes, artifact, requests, make,
    fast: () => { slow = false }, ignoreRange: () => { ignoreRange = true }, corrupt: () => { corrupt = true },
    fault: (value: string, source?: string) => { fault = value; faultSource = source }, maximumActive: () => maximumActive }
}

const parallel = { connections: 4, pieceBytes: 256 * 1024 }

async function rangeJournal(directory: string) {
  const name = (await readdir(directory)).find(value => /^ranges-.*\.json$/u.test(value))
  assert.ok(name)
  const journal = JSON.parse(await readFile(join(directory, name), 'utf8')) as {
    pieceBytes: number
    pieces: {
      index: number
      bytes: number
      sha256: string
    }[]
  }
  return { ...journal, payload: join(directory, name.replace(/\.json$/u, '.part')) }
}

it('continues from flushed bytes after recreating the download owner, retaining the selected source', async () => {
  const f = await fixture()
  const first = f.make((progress) => { if (progress.stage === 'downloading' && progress.transferred >= 512 * 1024) first.pause() })
  await first.select({ source: 'github' })
  await expect(first.download(f.artifact, join(f.directory, 'first.exe'))).rejects.toBeInstanceOf(DesktopDownloadPaused)
  const checkpoint = JSON.parse(await readFile(join(f.directory, 'checkpoint.json'), 'utf8')) as { bytes: number }
  expect(checkpoint.bytes).toBeGreaterThan(0)
  expect(checkpoint.bytes).toBeLessThan(f.bytes.length)
  f.fast()
  const next = f.make()
  await next.initialize()
  expect(next.state.choice.source).toBe('github')
  await next.download(f.artifact, join(f.directory, 'complete.exe'))
  expect(f.requests.at(-1)?.range).toBe(`bytes=${checkpoint.bytes}-`)
  assert.deepEqual(await readFile(join(f.directory, 'complete.exe')), f.bytes)
})

it('switches a running transfer to another source without requesting its completed prefix again', async () => {
  const f = await fixture()
  let switched: Promise<void> | undefined
  const download = f.make((progress) => {
    if (progress.stage === 'downloading' && progress.transferred >= 512 * 1024 && switched === undefined) {
      switched = download.select({ source: 'ghfast' })
    }
  })
  await download.select({ source: 'github' })
  await download.download(f.artifact, join(f.directory, 'complete.exe'))
  await switched
  const resumed = f.requests.find(item => item.source.startsWith('https://ghfast.top/'))
  expect(resumed?.range).toMatch(/^bytes=[1-9]\d*-$/u)
  assert.deepEqual(await readFile(join(f.directory, 'complete.exe')), f.bytes)
})

it('does not append a full HTTP 200 response when resuming a partial file', async () => {
  const f = await fixture()
  const download = f.make((progress) => { if (progress.stage === 'downloading' && progress.transferred >= 512 * 1024) download.pause() })
  await download.select({ source: 'github' })
  await expect(download.download(f.artifact, join(f.directory, 'unused.exe'))).rejects.toBeInstanceOf(DesktopDownloadPaused)
  const saved = await readFile(join(f.directory, 'payload.part'))
  f.ignoreRange()
  f.fast()
  const resumed = f.make()
  await resumed.initialize()
  await expect(resumed.download(f.artifact, join(f.directory, 'unused.exe'))).rejects.toThrow(/rejected download/u)
  assert.deepEqual(await readFile(join(f.directory, 'payload.part')), saved)
})

it('discards changed cached bytes before restarting from byte zero', async () => {
  const f = await fixture()
  const download = f.make((progress) => { if (progress.stage === 'downloading' && progress.transferred >= 512 * 1024) download.pause() })
  await download.select({ source: 'github' })
  await expect(download.download(f.artifact, join(f.directory, 'unused.exe'))).rejects.toBeInstanceOf(DesktopDownloadPaused)
  const cached = await readFile(join(f.directory, 'payload.part'))
  cached[0] = 255
  await writeFile(join(f.directory, 'payload.part'), cached)
  f.fast()
  const resumed = f.make()
  await resumed.initialize()
  await resumed.download(f.artifact, join(f.directory, 'complete.exe'))
  expect(f.requests.at(-1)?.range).toBe('bytes=0-')
  assert.deepEqual(await readFile(join(f.directory, 'complete.exe')), f.bytes)
})

it('rejects corrupt whole-file content, switches sources, and verifies the replacement before returning', async () => {
  const f = await fixture()
  f.fast()
  f.corrupt()
  const download = f.make()
  await download.download(f.artifact, join(f.directory, 'complete.exe'))
  const transfers = f.requests.filter(item => item.range.endsWith('-'))
  expect(transfers.length).toBeGreaterThanOrEqual(2)
  expect(transfers[1]?.source).not.toBe(transfers[0]?.source)
  assert.deepEqual(await readFile(join(f.directory, 'complete.exe')), f.bytes)
})

it('validates custom HTTPS proxies without accepting credentials or arbitrary source IDs', async () => {
  const f = await fixture()
  const download = f.make()
  for (const value of [{ source: 'unknown' }, { source: 'custom', customPrefix: 'http://proxy.example/' },
    { source: 'custom', customPrefix: 'https://user:password@proxy.example/' }]) {
    expect(() => download.select(value)).toThrow()
  }
  await download.select({ source: 'custom', customPrefix: 'https://proxy.example/path' })
  expect(download.state.choice).toEqual({ source: 'custom', customPrefix: 'https://proxy.example/path/' })
})

it.each([1, 4, 8, 16])('downloads exact bounded segments with %i configured connections and verifies the complete artifact', async (connections) => {
  const f = await fixture()
  const download = f.make(() => {}, { ...parallel, connections })
  await download.select({ source: 'github' })
  await download.download(f.artifact, join(f.directory, 'complete.exe'))
  if (connections > 1) {
    expect(f.maximumActive()).toBeGreaterThan(1)
    expect(f.maximumActive()).toBeLessThanOrEqual(connections)
    expect(f.requests.every(request => /^bytes=\d+-\d+$/u.test(request.range))).toBe(true)
  }
  assert.deepEqual(await readFile(join(f.directory, 'complete.exe')), f.bytes)
})

it('retains partial intervals across pause and owner recreation without counting sparse allocation as received bytes', async () => {
  const f = await fixture()
  const first = f.make((progress) => { if (progress.stage === 'downloading' && progress.transferred > 0) first.pause() }, parallel)
  await first.select({ source: 'github' })
  await expect(first.download(f.artifact, join(f.directory, 'unused.exe'))).rejects.toBeInstanceOf(DesktopDownloadPaused)
  const journal = await rangeJournal(f.directory)
  const saved = journal.pieces.reduce((sum, entry) => sum + entry.bytes, 0)
  expect(saved).toBeGreaterThan(0)
  const file = await open(journal.payload, 'r+')
  await file.truncate(f.artifact.size)
  await file.close()
  f.requests.length = 0
  f.fast()
  const states: DesktopDownloadProgress[] = []
  // Changing concurrency and piece settings must not reinterpret an existing interval journal.
  const next = f.make(progress => states.push(progress), { connections: 1, pieceBytes: 1024 * 1024 })
  await next.initialize()
  await next.download(f.artifact, join(f.directory, 'complete.exe'))
  expect(states.find(state => state.stage === 'downloading')?.transferred).toBe(saved)
  const entry = journal.pieces[0]!
  expect(f.requests.some(request => request.range.startsWith(`bytes=${entry.index * journal.pieceBytes + entry.bytes}-`))).toBe(true)
  assert.deepEqual(await readFile(join(f.directory, 'complete.exe')), f.bytes)
})

it('imports a digest-checked legacy prefix without overwriting its files or requesting the prefix again', async () => {
  const f = await fixture()
  const legacy = f.make((progress) => { if (progress.stage === 'downloading' && progress.transferred > 0) legacy.pause() })
  await legacy.select({ source: 'github' })
  await expect(legacy.download(f.artifact, join(f.directory, 'unused.exe'))).rejects.toBeInstanceOf(DesktopDownloadPaused)
  const original = await readFile(join(f.directory, 'payload.part'))
  const checkpoint = await readFile(join(f.directory, 'checkpoint.json'))
  f.requests.length = 0
  f.fast()
  const next = f.make(() => {}, parallel)
  await next.initialize()
  await next.download(f.artifact, join(f.directory, 'complete.exe'))
  expect(f.requests.some(request => request.range.startsWith(`bytes=${original.length}-`))).toBe(true)
  assert.deepEqual(await readFile(join(f.directory, 'payload.part')), original)
  assert.deepEqual(await readFile(join(f.directory, 'checkpoint.json')), checkpoint)
  assert.deepEqual(await readFile(join(f.directory, 'complete.exe')), f.bytes)
})

it('drains all interval writers before changing source and continues from verified offsets', async () => {
  const f = await fixture()
  let change: Promise<void> | undefined
  const download = f.make((progress) => {
    if (progress.stage === 'downloading' && progress.transferred > 0 && change === undefined) change = download.select({ source: 'ghfast' })
  }, parallel)
  await download.select({ source: 'github' })
  await download.download(f.artifact, join(f.directory, 'complete.exe'))
  await change
  expect(f.requests.some(request => request.source.startsWith('https://ghfast.top/') && !request.range.startsWith('bytes=0-'))).toBe(true)
  assert.deepEqual(await readFile(join(f.directory, 'complete.exe')), f.bytes)
})

it('falls back to one full request when a fresh source ignores Range', async () => {
  const f = await fixture()
  f.ignoreRange(); f.fast()
  const download = f.make(() => {}, parallel)
  await download.select({ source: 'github' })
  await download.download(f.artifact, join(f.directory, 'complete.exe'))
  expect(f.requests).toHaveLength(2)
  expect(f.requests.at(-1)?.range).toBe('bytes=0-')
  assert.deepEqual(await readFile(join(f.directory, 'complete.exe')), f.bytes)
})

it('retains sparse intervals when a resumed source starts ignoring Range', async () => {
  const f = await fixture()
  const first = f.make((progress) => { if (progress.stage === 'downloading' && progress.transferred > 0) first.pause() }, parallel)
  await first.select({ source: 'github' })
  await expect(first.download(f.artifact, join(f.directory, 'unused.exe'))).rejects.toBeInstanceOf(DesktopDownloadPaused)
  const journal = await rangeJournal(f.directory)
  const original = await readFile(journal.payload)
  f.ignoreRange(); f.fast()
  const next = f.make(() => {}, parallel)
  await next.initialize()
  await expect(next.download(f.artifact, join(f.directory, 'unused.exe'))).rejects.toThrow('does not support Range')
  assert.deepEqual(await readFile(journal.payload), original)
})

it.each(['wrong-range', 'truncate', '403', '429', 'disconnect', 'stall'])('bounds failed %s segment attempts and permits explicit recovery', async (fault) => {
  const f = await fixture()
  f.fault(fault)
  const download = f.make(() => {}, { ...parallel, idleTimeoutMs: 1000 })
  await download.select({ source: 'github' })
  await expect(download.download(f.artifact, join(f.directory, 'unused.exe'))).rejects.toThrow()
  expect(f.requests.length).toBeLessThanOrEqual(parallel.connections)
  f.fault(''); f.fast()
  await download.download(f.artifact, join(f.directory, 'complete.exe'))
  assert.deepEqual(await readFile(join(f.directory, 'complete.exe')), f.bytes)
})

it.each(['429', 'slow'])('automatically leaves a %s source without retrying it or losing verified intervals', async (fault) => {
  const f = await fixture()
  f.fault(fault, 'https://github.com/')
  const download = f.make(() => {}, { ...parallel, slowWindowMs: 80, minimumBytesPerSecond: 1024 * 1024 })
  await download.download(f.artifact, join(f.directory, 'complete.exe'))
  const sources = f.requests.filter(request => request.range !== 'bytes=0-16383').map(request => request.source)
  expect(new Set(sources).size).toBeGreaterThan(1)
  const lastOriginal = sources.lastIndexOf(f.artifact.url.href)
  expect(sources.slice(lastOriginal + 1).every(source => source !== f.artifact.url.href)).toBe(true)
  assert.deepEqual(await readFile(join(f.directory, 'complete.exe')), f.bytes)
})

it('does not retry another source on a disk checkpoint failure or return an unverified destination', async () => {
  const f = await fixture()
  f.fast()
  const save = vi.spyOn(DesktopUpdateRangeCache.prototype, 'save').mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
  try {
    const download = f.make(() => {}, parallel)
    await expect(download.download(f.artifact, join(f.directory, 'unused.exe'))).rejects.toThrow('disk full')
    expect(new Set(f.requests.filter(request => !request.range.endsWith('16383')).map(request => request.source)).size).toBe(1)
    await expect(readFile(join(f.directory, 'unused.exe'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { save.mockRestore() }
})

it('rejects a corrupted full segmented download and verifies a replacement source', async () => {
  const f = await fixture()
  f.fast(); f.corrupt()
  const download = f.make(() => {}, parallel)
  await download.download(f.artifact, join(f.directory, 'complete.exe'))
  expect(new Set(f.requests.filter(request => request.range !== 'bytes=0-16383').map(request => request.source)).size).toBeGreaterThan(1)
  assert.deepEqual(await readFile(join(f.directory, 'complete.exe')), f.bytes)
})

it('re-downloads a changed interval while retaining other digest-checked intervals', async () => {
  const f = await fixture()
  f.fast()
  const first = f.make(() => {}, parallel)
  await first.select({ source: 'github' })
  await first.download(f.artifact, join(f.directory, 'first.exe'))
  const journal = await rangeJournal(f.directory)
  const file = await open(journal.payload, 'r+')
  await file.write(Buffer.from([255]), 0, 1, 0)
  await file.close()
  f.requests.length = 0
  const resumed = f.make(() => {}, parallel)
  await resumed.initialize()
  await resumed.download(f.artifact, join(f.directory, 'complete.exe'))
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0]?.range).toBe(`bytes=0-${parallel.pieceBytes - 1}`)
  assert.deepEqual(await readFile(join(f.directory, 'complete.exe')), f.bytes)
})

it('rejects overlapping requests from one owner while allowing its first download to finish', async () => {
  const f = await fixture()
  const download = f.make(() => {}, parallel)
  await download.select({ source: 'github' })
  const pending = download.download(f.artifact, join(f.directory, 'complete.exe'))
  await expect(download.download(f.artifact, join(f.directory, 'other.exe'))).rejects.toThrow('another full download')
  await pending
  assert.deepEqual(await readFile(join(f.directory, 'complete.exe')), f.bytes)
})

it.each(['0', '17', '1.5', 'NaN'])('rejects invalid connection configuration %s', (value) => {
  expect(() => desktopDownloadConfig('unused', { DSH_DESKTOP_UPDATE_CONNECTIONS: value })).toThrow('DSH_DESKTOP_UPDATE_CONNECTIONS')
})
