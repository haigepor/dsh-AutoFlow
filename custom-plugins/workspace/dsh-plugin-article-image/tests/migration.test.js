/** Legacy files remain unchanged while a validated successor becomes authoritative. */
import { test, expect } from 'vitest'
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, storageDirectory } from '../src/host/store.js'
import { resolveConfig } from '../config-schema.js'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'article-migrate-'))
  t.onTestFinished(() => rm(home, { recursive: true, force: true }))
  const store = new Store(home, join(home, 'profile'), resolveConfig())
  await storageDirectory(store.root)
  return store
}

test('publishes a successor without changing or deleting the original schema:1 file', async t => {
  const store = await fixture(t), legacy = '{"schema":1,"source":null,"items":[]}\n'
  await writeFile(join(store.root, 'state.json'), legacy, 'utf8')
  expect((await store.read()).schema).toBe(2)
  expect(await readFile(join(store.root, 'state.json'), 'utf8')).toBe(legacy)
  expect((await readdir(join(store.root, 'legacy'))).length).toBe(1)
  await store.update(state => { state.source = { url: 'https://example.com', mapping: { link: 'Links', category: '', language: '', notes: '' }, importedAt: 'now' } })
  expect((await store.read()).source.importedAt).toBe('now')
  expect(await readFile(join(store.root, 'state.json'), 'utf8')).toBe(legacy)
})

test('rejects corrupt source records without publishing a successor', async t => {
  const store = await fixture(t), legacy = '{"schema":1,"items":[{"id":"bad"}]}\n'
  await writeFile(join(store.root, 'state.json'), legacy, 'utf8')
  await expect(store.read()).rejects.toThrow()
  expect(await readFile(join(store.root, 'state.json'), 'utf8')).toBe(legacy)
  expect(await readdir(store.root)).not.toContain('state.v2.json')
})

test('concurrent migration reads agree on one validated successor', async t => {
  const store = await fixture(t)
  await writeFile(join(store.root, 'state.json'), '{"schema":1,"source":null,"items":[]}\n', 'utf8')
  const results = await Promise.all([store.read(), store.read(), store.read()])
  expect(results.every(value => value.schema === 2)).toBe(true)
  expect((await readdir(join(store.root, 'legacy'))).length).toBe(1)
})

test('retains legacy article, plan, identifiers and historical approval while requiring recapture', async t => {
  const store = await fixture(t), digest = 'a'.repeat(64)
  const shot = { purpose: 'cover', paragraphs: [1], ratio: '16:9', ...Object.fromEntries(['rationale', 'subject', 'action', 'environment', 'composition', 'lighting', 'colors', 'style', 'details', 'avoid', 'prompt'].map(key => [key, key])) }
  const item = { id: 'b'.repeat(32), url: 'https://example.com/a', sourceKey: 'legacy-source', category: 'Travel', language: 'en', notes: '', rows: [2], raw: {}, revision: 7, state: 'approved',
    article: { title: 'Legacy article', url: 'https://example.com/a', language: 'en', paragraphs: [{ id: 1, text: 'Saved original text' }], hash: digest, fetchedAt: 'before', basis: 'web' },
    plan: { sourceHash: digest, brief: { theme: 'Travel', facts: ['A saved fact'], subjects: ['Family'], scenes: ['Park'] }, shots: [shot] },
    approval: { revision: 7, sourceHash: digest, planHash: 'c'.repeat(64), at: 'before' }, error: null, fetching: null }
  const original = JSON.stringify({ schema: 1, source: null, items: [item] }) + '\n'
  await writeFile(store.legacyFile, original, 'utf8')
  const migrated = (await store.read()).items[0]
  expect(migrated).toMatchObject({ ...item, legacy: true, snapshotRef: null, analysisRef: null, planRef: null })
  expect(await readFile(store.legacyFile, 'utf8')).toBe(original)
  const [backup] = await readdir(join(store.root, 'legacy'))
  expect(await readFile(join(store.root, 'legacy', backup), 'utf8')).toBe(original)
})
