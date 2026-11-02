/** Permanent removal uses real files and the backend's normal writer exclusion. */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import * as Jsonl from '../src/index.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

async function setup(compression: Jsonl.JsonlCompression = 'none') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-erase-'))
  const ctx = new Context()
  await ctx.plugin(Jsonl, { root, compression }).await()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const save = async (name: string) => {
    const id = SessionId(name)
    const handle = await ctx.sessionPersistence.create(meta(id))
    await handle.append(oneTurnLog())
    await handle.close()
    return id
  }
  return { ctx, root, save }
}

it.each(['none', 'zstd'] as const)('erases every generation of only the selected %s record, including after reopening', async (compression) => {
  const { ctx, root, save } = await setup(compression)
  const removed = await save('removed')
  const kept = await save('kept')
  const source = (await ctx.sessionPersistence.stat(removed))!.location!.path
  await writeFile(join(dirname(source), compression === 'none' ? 'log.jsonl' : 'log.jsonl.zstd'), 'old generation that must not reappear\n', 'utf8')
  await writeFile(join(dirname(source), 'migration-tmp'), 'old private content\n', 'utf8')
  expect(await ctx.sessionErasure.erase(removed)).toBe(true)
  expect(await ctx.sessionPersistence.stat(removed)).toBeUndefined()
  await expect(ctx.sessionPersistence.open(removed, 'read')).rejects.toThrow()
  expect((await ctx.sessionPersistence.list()).map(row => row.header.id)).toEqual([kept])
  expect(await ctx.sessionErasure.erase(removed)).toBe(false)
  expect(await readdir(join(root, '.deleted-sessions'))).toEqual([])
  const reopened = new Context()
  onTestFinished(() => reopened.fiber.dispose())
  await reopened.plugin(Jsonl, { root, compression }).await()
  expect(await reopened.sessionPersistence.stat(removed)).toBeUndefined()
  expect((await reopened.sessionPersistence.list()).map(row => row.header.id)).toEqual([kept])
})

it('refuses local and foreign write ownership without removing any record', async () => {
  const { ctx, root, save } = await setup()
  const id = await save('owned')
  const writer = await ctx.sessionPersistence.open(id, 'write')
  await expect(ctx.sessionErasure.erase(id)).rejects.toMatchObject({ name: 'SessionAlreadyOwnedError' })
  const foreign = new Context()
  onTestFinished(() => foreign.fiber.dispose())
  await foreign.plugin(Jsonl, { root, compression: 'none' }).await()
  await expect(foreign.sessionErasure.erase(id)).rejects.toMatchObject({ committed: false })
  expect(await ctx.sessionPersistence.stat(id)).toBeDefined()
  await writer.close()
  expect(await foreign.sessionErasure.erase(id)).toBe(true)
})

it('rejects an erasure staging path outside the configured root', async () => {
  const { ctx, root, save } = await setup()
  const id = await save('protected')
  const outside = await mkdtemp(join(tmpdir(), 'dsh-erase-outside-'))
  onTestFinished(() => rm(outside, { recursive: true, force: true }))
  const sentinel = join(outside, 'keep.txt')
  await writeFile(sentinel, 'keep', 'utf8')
  await symlink(outside, join(root, '.deleted-sessions'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(ctx.sessionErasure.erase(id)).rejects.toThrow()
  expect(await readFile(sentinel, 'utf8')).toBe('keep')
  expect(await ctx.sessionPersistence.stat(id)).toBeDefined()
})

it('finishes an interrupted committed removal without returning it in the corpus', async () => {
  const { root, save } = await setup()
  await save('survivor')
  const staging = join(root, '.deleted-sessions', `session-${'a'.repeat(32)}`)
  await mkdir(staging, { recursive: true })
  await writeFile(join(staging, 'log.jsonl'), 'private content pending cleanup', 'utf8')
  const restarted = new Context()
  onTestFinished(() => restarted.fiber.dispose())
  await restarted.plugin(Jsonl, { root, compression: 'none' }).await()
  expect((await restarted.sessionPersistence.list()).map(row => row.header.id)).toEqual(['survivor'])
  expect(await readdir(join(root, '.deleted-sessions'))).toEqual([])
})
