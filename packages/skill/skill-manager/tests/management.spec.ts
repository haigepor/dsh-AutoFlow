/** Real temporary files exercise management policy, editor conflicts and recoverable operations. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Skills from '@deepseek-ai/dsh-skill'
import * as FileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { expect, it, onTestFinished, vi } from 'vitest'
import { zipSync } from 'fflate'
import Management from '../src/index.ts'
import { decodeArchive } from '../src/repositories.ts'
import { containedPath, skillId } from '../src/files.ts'

const document = (name: string, body: string, userOnly = false) =>
  `---\nname: ${name}\ndescription: Test workflow\n${userOnly ? 'disable-model-invocation: true\n' : ''}---\n\n${body}\n`
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-skills-management-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    if (!home.startsWith(join(tmpdir(), 'dsh-skills-management-'))) throw new Error('Unexpected test directory')
    await rm(home, { recursive: true, force: true })
  })
  ctx.provide('profileContext', { dir: join(home, 'profile'), home } as never)
  ctx.provide('workspaceRegistry', { list: () => [] } as never)
  await ctx.plugin(Skills)
  await ctx.plugin(FileSystem, { dshHome: home, agentsHome: join(home, 'agents'), watch: false })
  await ctx.plugin(Management)
  return { home, ctx, manager: ctx.skillManagement }
}
it('provides the packaged skill creator through the native registry as a read-only skill', async () => {
  const { manager, ctx } = await fixture()
  const row = (await manager.list('')).skills.find(item => item.name === 'skill-creator')!
  expect(row).toMatchObject({ writable: false, valid: true, modelInvocable: false, userInvocable: true })
  expect((await ctx.skills.get('skill-creator'))?.content).toContain('## Validate and deliver')
  expect((await manager.detail(row.id, '')).tree.entries).toContainEqual({ path: 'SKILL.md', kind: 'file' })
})
it('restricts a concrete copy and preserves declared invocation when re-enabled', async () => {
  const { home, ctx, manager } = await fixture()
  const path = join(home, 'skills', 'manual', 'SKILL.md')
  await mkdir(join(home, 'skills', 'manual'), { recursive: true })
  await writeFile(path, document('manual', 'Use manual instructions.', true), 'utf8')
  const snapshot = await manager.list('')
  const row = snapshot.skills.find(item => item.name === 'manual')!
  expect(row).toMatchObject({ valid: true, modelInvocable: false, userInvocable: true, writable: true })
  expect(await manager.setEnabled(row.id, false, '')).toEqual({ status: 'saved' })
  expect(await ctx.skills.get('manual')).toBeUndefined()
  expect(await manager.setEnabled(row.id, true, '')).toEqual({ status: 'saved' })
  expect((await ctx.skills.get('manual'))?.invocation).toEqual({ modelInvocable: false, userInvocable: true })
})
it('imports resources, rejects stale edits and preserves complete content through trash and restore', async () => {
  const { manager } = await fixture()
  const snapshot = await manager.list('')
  const root = snapshot.directories.find(item => item.source === 'user-dsh')!
  const encode = (path: string, text: string) => ({ path, base64: Buffer.from(text).toString('base64') })
  expect(
    await manager.importFiles(
      root.id,
      [
        encode('pack/SKILL.md', document('example', 'Original')),
        encode('pack/scripts/helper.js', 'export const value = 1\n'),
      ],
      false,
      '',
    ),
  ).toEqual({ status: 'saved' })
  const row = (await manager.list('')).skills.find(item => item.name === 'example')!
  expect((await manager.detail(row.id, '')).tree).toEqual({
    complete: true,
    entries: [
      { path: 'scripts', kind: 'directory' },
      { path: 'SKILL.md', kind: 'file' },
      { path: 'scripts/helper.js', kind: 'file' },
    ],
  })
  await writeFile(row.path, document('example', 'Edited externally'), 'utf8')
  expect(await manager.save(row.id, document('example', 'Stale edit'), row.revision, '')).toEqual({
    status: 'rejected',
    code: 'conflict',
  })
  expect(await manager.trash(row.id, '')).toEqual({ status: 'saved' })
  expect((await manager.list('')).skills.some(item => item.id === row.id)).toBe(false)
  const backup = (await manager.backups()).find(item => item.kind === 'trash')!
  expect(await manager.restore(backup.id, false, '')).toEqual({ status: 'saved' })
  expect(await readFile(row.path, 'utf8')).toContain('Edited externally')
  expect(await readFile(join(root.path, 'example/scripts/helper.js'), 'utf8')).toContain('value = 1')
})
it('reads invalid and third-party skills while refusing writes and unregistered projects', async () => {
  const { home, manager } = await fixture()
  const external = join(home, 'external')
  await mkdir(join(external, 'broken'), { recursive: true })
  await writeFile(join(external, 'broken/SKILL.md'), 'Missing metadata', 'utf8')
  expect(await manager.source(external, false)).toEqual({ status: 'saved' })
  const snapshot = await manager.list('')
  const row = snapshot.skills.find(item => item.id === skillId(join(external, 'broken/SKILL.md')))!
  expect(row).toMatchObject({ writable: false, valid: false })
  expect(await manager.trash(row.id, '')).toEqual({ status: 'rejected', code: 'read-only' })
  await expect(manager.list(join(home, 'unregistered'))).rejects.toThrow('unsafe-path')
})
it('rejects traversal, device names and malformed archives before creating files', () => {
  for (const path of ['../escape', 'nested/../../escape', 'C:/escape', 'nested\\escape', 'NUL', 'name.'])
    expect(() => containedPath(tmpdir(), path)).toThrow('unsafe-path')
  expect(() => decodeArchive(new Uint8Array([1, 2, 3]), 1024, 10)).toThrow('invalid')
})
it('falls back to the next enabled copy and makes runtime-only restrictions reversible', async () => {
  const { home, ctx, manager } = await fixture()
  for (const [root, body] of [
    [join(home, 'skills'), 'Project choice'],
    [join(home, 'agents/skills'), 'Shared fallback'],
  ]) {
    await mkdir(join(root!, 'duplicate'), { recursive: true })
    await writeFile(join(root!, 'duplicate/SKILL.md'), document('duplicate', body!), 'utf8')
  }
  const row = (await manager.list('')).skills.find(item => item.path === join(home, 'skills/duplicate/SKILL.md'))!
  expect(await manager.setEnabled(row.id, false, '')).toEqual({ status: 'saved' })
  expect((await ctx.skills.get('duplicate'))?.content).toBe('Shared fallback')
  const release = ctx.skills.register({
    name: 'virtual-skill',
    description: 'Runtime contribution',
    source: 'runtime',
    content: 'Virtual body',
  })
  const virtual = (await manager.list('')).skills.find(item => item.name === 'virtual-skill')!
  await manager.setEnabled(virtual.id, false, '')
  expect(await ctx.skills.get('virtual-skill')).toBeUndefined()
  await manager.setEnabled(virtual.id, true, '')
  expect((await ctx.skills.get('virtual-skill'))?.content).toBe('Virtual body')
  release()
})
it('pins repository installs and refuses stale or unaccepted local changes before recoverable updates', async () => {
  const { manager } = await fixture()
  let commit = 'a'.repeat(40)
  const fetchMock: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('https://api.github.com/')) return new Response(JSON.stringify({ sha: commit }))
    const archive = zipSync({
      [`repo-${commit}/skills/remote/SKILL.md`]: Buffer.from(document('remote', commit)),
      [`repo-${commit}/skills/remote/assets/value.txt`]: Buffer.from(commit),
    })
    return new Response(archive)
  }
  vi.stubGlobal('fetch', fetchMock)
  onTestFinished(() => {
    vi.unstubAllGlobals()
  })
  const root = (await manager.list('')).directories.find(item => item.source === 'user-dsh')!
  const candidate = (await manager.discover('example/workflows', 'HEAD'))[0]!
  expect(await manager.installSkill(candidate, root.id, false, '')).toEqual({ status: 'saved' })
  const row = (await manager.list('')).skills.find(item => item.name === 'remote')!
  commit = 'b'.repeat(40)
  const preview = await manager.preview(row.id, 'HEAD', '')
  await writeFile(row.path, document('remote', 'Local edits'), 'utf8')
  expect(await manager.update(preview.token, true)).toEqual({ status: 'rejected', code: 'conflict' })
  const latest = await manager.preview(row.id, 'HEAD', '')
  expect(latest.localModified).toBe(true)
  expect(await manager.update(latest.token, false)).toEqual({ status: 'rejected', code: 'conflict' })
  expect(await manager.update(latest.token, true)).toEqual({ status: 'saved' })
  expect(await readFile(row.path, 'utf8')).toContain(commit)
  const backup = (await manager.backups()).find(item => item.kind === 'update')!
  expect(await manager.restore(backup.id, false, '')).toEqual({ status: 'saved' })
  expect(await readFile(row.path, 'utf8')).toContain('Local edits')
})
