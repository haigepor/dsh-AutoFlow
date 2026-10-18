/** Publication failures preserve the last complete index and a retryable legacy source. */
import { test, expect, vi } from 'vitest'
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Store, storageDirectory } from '../src/host/store.js'
import { ArtifactStore } from '../src/host/artifact-store.js'
import { resolveConfig } from '../config-schema.js'

const fault = vi.hoisted(() => ({ suffix: null, asset: false }))
vi.mock('node:fs/promises', async original => {
  const actual = await original()
  return { ...actual, rename: async (source, target) => {
    if (fault.asset && target.endsWith('.bin')) throw new Error('injected-asset-failure')
    return actual.rename(source, target)
  } }
})
vi.mock('@deepseek-ai/dsh-atomic-write', async original => {
  const actual = await original()
  return { ...actual, writeFileAtomic: async (path, value, options) => {
    if (fault.suffix && path.endsWith(fault.suffix)) throw new Error('injected-publication-failure')
    return actual.writeFileAtomic(path, value, options)
  } }
})

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'article-publication-')), config = resolveConfig()
  t.onTestFinished(async () => { fault.suffix = null; fault.asset = false; await rm(home, { recursive: true, force: true }) })
  const store = new Store(home, join(home, 'profile'), config)
  await storageDirectory(store.root)
  return { store, artifacts: new ArtifactStore(store.root, config) }
}

test('migration can retry after a failed successor publication without altering the source', async t => {
  const { store } = await fixture(t), original = '{"schema":1,"source":null,"items":[]}\n'
  await writeFile(store.legacyFile, original, 'utf8')
  fault.suffix = 'state.v2.json'
  await expect(store.read()).rejects.toThrow('injected-publication-failure')
  expect(await readFile(store.legacyFile, 'utf8')).toBe(original)
  expect(await readdir(store.root)).not.toContain('state.v2.json')
  expect(await readdir(join(store.root, 'legacy'))).toHaveLength(1)
  fault.suffix = null
  expect((await store.read()).schema).toBe(2)
})

test('a failed index commit leaves complete immutable documents unreferenced and preserves the prior index', async t => {
  const { store, artifacts } = await fixture(t)
  await store.update(() => {})
  const prior = await readFile(store.file, 'utf8'), id = await artifacts.put('snapshots', { title: 'Complete record' })
  fault.suffix = 'state.v2.json'
  await expect(store.update(state => { state.source = { url: 'https://example.com', importedAt: id, mapping: { link: 'Links', category: '', language: '', notes: '' } } })).rejects.toThrow('injected-publication-failure')
  expect(await readFile(store.file, 'utf8')).toBe(prior)
  expect(await artifacts.get('snapshots', id)).toEqual({ title: 'Complete record' })
  expect((await store.read()).source).toBe(null)
})

test('an interrupted asset publication exposes no partial image and removes its temporary bytes', async t => {
  const { store, artifacts } = await fixture(t), bytes = Buffer.from('fixture image bytes')
  const contentHash = createHash('sha256').update(bytes).digest('hex')
  fault.asset = true
  await expect(artifacts.putAsset({ bytes, contentHash })).rejects.toThrow('injected-asset-failure')
  await expect(artifacts.getAsset(contentHash)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await readdir(join(store.root, 'assets'))).some(file => file.endsWith('.tmp') || file.endsWith('.bin'))).toBe(false)
  fault.asset = false
  await artifacts.putAsset({ bytes, contentHash })
  expect(await artifacts.getAsset(contentHash)).toEqual(bytes)
})

test('a failed snapshot publication leaves no readable document or index reference', async t => {
  const { store, artifacts } = await fixture(t)
  await store.update(() => {})
  fault.suffix = '.json'
  await expect(artifacts.put('snapshots', { title: 'Not published' })).rejects.toThrow('injected-publication-failure')
  expect(await readdir(join(store.root, 'snapshots'))).toEqual([])
  expect((await store.read()).items).toEqual([])
})
