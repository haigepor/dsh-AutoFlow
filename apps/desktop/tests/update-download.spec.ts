import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it, onTestFinished } from 'vitest'
import { DesktopDownloadPaused, DesktopUpdateDownload, desktopDownloadConfig, type DesktopDownloadProgress } from '../src/update-download.ts'

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
  const handlers = new Set<Promise<void>>()
  const server = createServer((request, response) => {
    const handler = (async () => {
      const source = decodeURIComponent(request.url!.slice(1))
      const range = request.headers.range ?? ''
      requests.push({ source, range })
      const [, rawStart, rawEnd] = /^bytes=(\d+)-(\d*)$/u.exec(range) ?? []
      const start = Number(rawStart ?? 0)
      const end = rawEnd ? Number(rawEnd) : bytes.length - 1
      const probe = rawEnd !== '' && rawEnd !== undefined
      if (probe && !source.startsWith('https://github.com/')) await delay(50)
      if (response.destroyed) return
      const from = ignoreRange ? 0 : start
      const to = ignoreRange ? bytes.length - 1 : end
      response.writeHead(ignoreRange ? 200 : 206, { 'Content-Length': to - from + 1,
        ...ignoreRange ? {} : { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } })
      for (let offset = from; offset <= to; offset += 64 * 1024) {
        if (response.destroyed) return
        const chunk = Buffer.from(bytes.subarray(offset, Math.min(offset + 64 * 1024, to + 1)))
        if (corrupt && !probe) {
          corruptSource ??= source
          if (source === corruptSource) chunk.fill(7)
        }
        response.write(chunk)
        if (slow && !probe) await delay(15)
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
  const make = (publish: (value: DesktopDownloadProgress) => void = () => {}): DesktopUpdateDownload => new DesktopUpdateDownload(config,
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
    fast: () => { slow = false }, ignoreRange: () => { ignoreRange = true }, corrupt: () => { corrupt = true } }
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
