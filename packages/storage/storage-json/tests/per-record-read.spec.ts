import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { JsonStorageBackend } from '../src/index.ts'

const hooks = vi.hoisted(() => ({ read: null as ((path: string, read: () => Promise<unknown>) => Promise<unknown>) | null }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: (...args: Parameters<typeof actual.readFile>) => {
    const read = () => actual.readFile(...args)
    return hooks.read && typeof args[0] === 'string' ? hooks.read(args[0], read) : read()
  } }
})
afterEach(() => { hooks.read = null })

async function fixture(readConcurrency?: number) {
  const root = resolve(await mkdtemp(join(tmpdir(), 'dsh-json-read-')))
  if (!root.startsWith(resolve(tmpdir()) + sep)) throw new Error('Fixture escaped its temporary root')
  const backend = new JsonStorageBackend(root, readConcurrency)
  onTestFinished(async () => { await backend.close(); await rm(root, { recursive: true, force: true }) })
  const descriptor = { name: 'reads', version: 1, layout: 'per-record' as const, tables: ['alpha', 'beta'], hasGlobal: true }
  for (const table of descriptor.tables) await mkdir(join(root, 'reads', table), { recursive: true })
  return { root, backend, descriptor, async put(table: string, key: string, record: unknown) { await writeFile(join(root, 'reads', table, key + '.json'), JSON.stringify({ version: 1, record }), 'utf8') } }
}

it('loads every record across large tables without exceeding the configured read concurrency', async () => {
  const f = await fixture(4)
  for (const table of f.descriptor.tables) for (let index = 0; index < 160; index++) await f.put(table, `record_${index}`, { index })
  await writeFile(join(f.root, 'reads', 'global.json'), JSON.stringify({ version: 1, record: 'complete' }), 'utf8')
  let active = 0, peak = 0
  hooks.read = async (_path, read) => {
    active++; peak = Math.max(active, peak)
    try {
      if (active > 4) throw Object.assign(new Error('Synthetic descriptor limit'), { code: 'EMFILE' })
      await new Promise<void>(resolve => setImmediate(resolve))
      return await read()
    } finally { active-- }
  }
  const unit = await f.backend.kv.open(f.descriptor), snapshot = await unit.loadAll()
  for (const table of f.descriptor.tables) {
    expect(Object.keys(snapshot.tables[table]!)).toHaveLength(160)
    for (let index = 0; index < 160; index++) expect(snapshot.tables[table]![`record_${index}`]).toEqual({ index })
  }
  expect(snapshot.global).toBe('complete')
  expect(peak).toBe(4)
  expect(active).toBe(0)
})

it('lists physical candidates and reads selected values without opening historical bodies', async () => {
  const f = await fixture(3)
  for (let index = 0; index < 120; index++) await f.put('alpha', `history_${index}`, { payload: 'historical'.repeat(8192) })
  await f.put('alpha', 'current', { id: 'current' })
  await f.put('beta', 'manifest', { key: 'current' })
  const reads: string[] = []
  hooks.read = (path, read) => {
    reads.push(path)
    if (path.includes('history_')) throw new Error('Unselected historical body was opened')
    return read()
  }
  const unit = await f.backend.kv.open(f.descriptor)
  expect(await unit.listKeys!('alpha')).toHaveLength(121)
  expect(reads).toEqual([])
  expect(await unit.loadSelected!({ alpha: [], beta: 'all' })).toEqual({ tables: { alpha: {}, beta: { manifest: { key: 'current' } } }, global: null })
  expect((await unit.loadSelected!({ alpha: ['current', 'missing', 'current'] })).tables['alpha']).toEqual({ current: { id: 'current' } })
  expect(reads.filter(path => path.endsWith('current.json'))).toHaveLength(1)
  expect(reads.some(path => path.includes('history_'))).toBe(false)
  const before = reads.length
  await expect(unit.loadSelected!({ alpha: ['../escape'] })).rejects.toThrow(/key/)
  expect(reads).toHaveLength(before)
})

it('refuses selective legacy bootstrap without writing and leaves eager bootstrap available', async () => {
  const f = await fixture()
  await rm(join(f.root, 'reads'), { recursive: true })
  const marker = { baseDigest: 'confirmed-base', profileId: 'profile' }
  const legacy = JSON.stringify({ unit: { name: 'reads', version: 1 }, global: marker, tables: { alpha: { saved: { id: 1 } } } })
  await writeFile(join(f.root, 'reads.json'), legacy, 'utf8')
  const unit = await f.backend.kv.open(f.descriptor)
  await expect(unit.loadSelected!({ alpha: [] })).rejects.toMatchObject({ code: 'legacy-bootstrap-required' })
  await expect(unit.listKeys!('alpha')).rejects.toMatchObject({ code: 'legacy-bootstrap-required' })
  expect(await readdir(f.root)).toEqual(['reads.json'])
  expect(await readFile(join(f.root, 'reads.json'), 'utf8')).toBe(legacy)
  expect(await unit.loadAll()).toMatchObject({ tables: { alpha: { saved: { id: 1 } } }, global: marker })
  await unit.close()
  const reopened = await f.backend.kv.open(f.descriptor)
  expect(await reopened.loadSelected!({ alpha: ['saved'] })).toMatchObject({ tables: { alpha: { saved: { id: 1 } } }, global: marker })
  expect(await readFile(join(f.root, 'reads.json'), 'utf8')).toBe(legacy)
})

it.each(['EMFILE', 'EACCES', 'EIO'])('rejects %s from a record read without bootstrapping legacy data', async (code) => {
  const f = await fixture()
  await f.put('alpha', 'kept', { value: 'current' })
  const legacy = JSON.stringify({ unit: { name: 'reads', version: 1 }, global: null, tables: { alpha: { legacy: 'must not appear' } } })
  await writeFile(join(f.root, 'reads.json'), legacy, 'utf8')
  const failure = Object.assign(new Error('Injected read failure'), { code })
  hooks.read = (path, read) => path.endsWith('kept.json') ? Promise.reject(failure) : read()
  const unit = await f.backend.kv.open(f.descriptor)
  await expect(unit.loadAll()).rejects.toBe(failure)
  hooks.read = null
  expect(await readFile(join(f.root, 'reads.json'), 'utf8')).toBe(legacy)
  expect(await readdir(join(f.root, 'reads', 'alpha'))).toEqual(['kept.json'])
  expect((await unit.loadAll()).tables['alpha']).toEqual({ kept: { value: 'current' } })
})

it('propagates a global document I/O failure instead of publishing tables with an absent global', async () => {
  const f = await fixture()
  await f.put('alpha', 'kept', 1)
  await writeFile(join(f.root, 'reads', 'global.json'), JSON.stringify({ version: 1, record: 2 }), 'utf8')
  const failure = Object.assign(new Error('Injected global read failure'), { code: 'EACCES' })
  hooks.read = (path, read) => path.endsWith('global.json') ? Promise.reject(failure) : read()
  const unit = await f.backend.kv.open(f.descriptor)
  await expect(unit.loadAll()).rejects.toBe(failure)
})

it('continues to treat a disappeared file as absent while retaining other records', async () => {
  const f = await fixture()
  await f.put('alpha', 'gone', 1); await f.put('alpha', 'kept', 2)
  hooks.read = (path, read) => path.endsWith('gone.json') ? Promise.reject(Object.assign(new Error('Disappeared'), { code: 'ENOENT' })) : read()
  const unit = await f.backend.kv.open(f.descriptor)
  expect((await unit.loadAll()).tables['alpha']).toEqual({ kept: 2 })
})

it('waits for admitted reads before rejecting a failed load', async () => {
  const f = await fixture(2)
  await f.put('alpha', 'a_blocked', 1); await f.put('alpha', 'b_failed', 2)
  let enter = () => {}, release = () => {}
  const entered = new Promise<void>((resolve) => { enter = resolve }), gate = new Promise<void>((resolve) => { release = resolve })
  onTestFinished(() => { release() })
  const failure = Object.assign(new Error('Injected read failure'), { code: 'EMFILE' })
  hooks.read = async (path, read) => {
    if (path.endsWith('a_blocked.json')) { enter(); await gate; return read() }
    if (path.endsWith('b_failed.json')) { await entered; throw failure }
    return read()
  }
  const unit = await f.backend.kv.open(f.descriptor)
  let settled = false
  const loading = unit.loadAll().finally(() => { settled = true })
  const rejected = expect(loading).rejects.toBe(failure)
  await entered; await new Promise<void>(resolve => setImmediate(resolve))
  expect(settled).toBe(false)
  release(); await rejected
})

it('defaults the read limit and rejects nonpositive or fractional deployment values', async () => {
  const f = await fixture()
  for (let index = 0; index < 64; index++) await f.put('alpha', `record_${index}`, index)
  let active = 0, peak = 0
  hooks.read = async (_path, read) => {
    active++; peak = Math.max(active, peak)
    try { await new Promise<void>(resolve => setImmediate(resolve)); return await read() }
    finally { active-- }
  }
  const unit = await f.backend.kv.open(f.descriptor)
  expect(Object.keys((await unit.loadAll()).tables['alpha']!)).toHaveLength(64)
  expect(peak).toBe(32)
  for (const readConcurrency of [0, -1, 1.5, Infinity]) expect(() => new JsonStorageBackend('/configured', readConcurrency)).toThrow()
})
