/** Complete decompression bounds and cancellation of real update archive streams. */
import { randomBytes, randomUUID } from 'node:crypto'
import { ReadStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { Parser } from 'tar'
import { expect, it, onTestFinished, vi } from 'vitest'
import { validateUpdateArchive } from '../src/github-updates.ts'
import { githubFixture, limits } from './update-fixture.ts'

function archiveFile(bytes: Buffer): string {
  const root = mkdtempSync(join(tmpdir(), 'plugin-update-archive-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const file = join(root, 'extra-1.1.0.tgz')
  writeFileSync(file, bytes)
  return file
}

it('bounds gzip output including zero padding after the tar EOF blocks', async () => {
  const { bytes, release } = githubFixture()
  const expanded = Buffer.concat([gunzipSync(bytes), Buffer.alloc(limits.expandedBytes + 512)])
  const padded = gzipSync(expanded)
  expect(padded.length).toBeLessThan(limits.archiveBytes)
  const result = validateUpdateArchive(archiveFile(padded), release, limits, new AbortController().signal)
  await expect(result).rejects.toThrow(/oversized|bound/i)
})

it('rejects an archive parse whose owner has already cancelled', async () => {
  const { bytes, release } = githubFixture()
  const controller = new AbortController()
  const reason = new Error('Stopped before archive parsing')
  controller.abort(reason)
  await expect(validateUpdateArchive(archiveFile(bytes), release, limits, controller.signal)).rejects.toBe(reason)
})

it('cancels during real entry parsing and closes the owned file stream', async () => {
  const ownedPath = `package/owned-${randomUUID()}.txt`
  const { bytes, release } = githubFixture([
    { path: 'package/package.json', body: JSON.stringify({ name: 'extra', version: '1.1.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }) },
    { path: 'package/cordis.patch.yml', body: '[]' },
    { path: ownedPath, body: randomBytes(256 * 1024).toString('hex') },
  ])
  const file = archiveFile(bytes)
  const controller = new AbortController()
  const reason = new Error('Stopped during archive entry parsing')
  let ownedStream: ReadStream | undefined
  let closed: Promise<void> | undefined
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply below supplies the original stream receiver
  const originalStreamEmit = ReadStream.prototype.emit
  const streamEmit = vi.spyOn(ReadStream.prototype, 'emit').mockImplementation(function (
    this: ReadStream, event: string | symbol, ...args: unknown[]
  ) {
    if (this.path === file && ownedStream === undefined) {
      // oxlint-disable-next-line typescript/no-this-alias -- retain the actual owned stream to verify quiescent teardown
      ownedStream = this
      closed = new Promise<void>((resolve) => { this.once('close', resolve) })
    }
    return Reflect.apply(originalStreamEmit, this, [event, ...args])
  })
  onTestFinished(() => { streamEmit.mockRestore() })
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply below supplies the original parser receiver
  const originalParserEmit = Parser.prototype.emit
  const parserEmit = vi.spyOn(Parser.prototype, 'emit').mockImplementation(function (
    this: Parser, event: string | symbol, ...args: unknown[]
  ) {
    const result = Reflect.apply(originalParserEmit, this, [event, ...args])
    // This unique entry belongs only to this test's actual temporary archive.
    if (event === 'entry' && typeof args[0] === 'object' && args[0] !== null && 'path' in args[0] && args[0].path === ownedPath) {
      controller.abort(reason)
    }
    return result
  })
  onTestFinished(() => { parserEmit.mockRestore() })
  onTestFinished(async () => {
    ownedStream?.destroy()
    await closed
  })
  const outcome = await validateUpdateArchive(file, release, limits, controller.signal).then(
    manifest => ({ manifest, error: undefined }),
    (error: unknown) => ({ manifest: undefined, error }),
  )
  expect(controller.signal.aborted).toBe(true)
  expect(ownedStream).toBeDefined()
  await closed
  expect(ownedStream?.closed).toBe(true)
  expect(outcome.error).toBe(reason)
  expect(outcome.manifest).toBeUndefined()
})
