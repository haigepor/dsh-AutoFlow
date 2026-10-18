/** Workbench polling and concurrent writers retain complete, profile-isolated records. */
import { test, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { ArticleWorkflowService } from '../src/host/workflow-service.js'
import { Store } from '../src/host/store.js'
import { resolveConfig } from '../config-schema.js'
import { hashSnapshot } from 'article-image-toolkit/capture-contracts'

const claims = vi.hoisted(() => new Map())
vi.mock('@deepseek-ai/dsh-atomic-write', async original => {
  const actual = await original()
  return { ...actual, withFileLock: (file, operation, options) => {
    claims.get(file)?.()
    return actual.withFileLock(file, operation, options)
  } }
})

const source = { url: 'https://example.com/sheet', importedAt: '0', mapping: { link: 'Links', category: '', language: '', notes: '' } }
async function fixture(t, count = 28) {
  const home = await mkdtemp(join(tmpdir(), 'article-workbench-io-'))
  const config = resolveConfig({ pageSize: 30, mapping: { link: 'Links', category: 'Category', language: '', notes: '' } })
  const ctx = { profileContext: { home, dir: join(home, 'profile') }, jobs: { start() { throw new Error('unexpected-job') } } }
  const service = new ArticleWorkflowService(ctx, config, {
    capture: { readiness: async () => ({ available: true }), dispose: async () => {}, capture() { throw new Error('unexpected-network') } },
    analysis: { readiness: async () => ({ available: true }), run() { throw new Error('unexpected-model') } },
    download: async () => `Links,Category\n${Array.from({ length: count }, (_, i) => `https://example.com/article-${i},${i % 2 ? 'News' : 'Travel'}`).join('\n')}\n`,
  })
  t.onTestFinished(async () => { claims.delete(service.store.file); await service.dispose(); vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }) })
  await service.enable('tools')
  await service.importSource({ url: 'https://docs.google.com/spreadsheets/d/fixture/edit#gid=0' })
  return { service, store: service.store, home, config, ctx }
}

function snapshot(url) {
  const value = { schemaVersion: 2, id: randomUUID().replaceAll('-', ''), title: 'A complete article', requestedUrl: url, url, language: 'en', capturedAt: new Date().toISOString(), extractorVersion: 'fixture',
    blocks: [{ id: 'b1', type: 'paragraph', inline: [{ text: 'The complete published article.' }] }], assets: [], quality: { status: 'needs-review', reasons: ['unsettled-resources'] } }
  return { ...value, sourceHash: hashSnapshot(value) }
}

test('one 28-article list response reads one complete index rather than rereading it per article', async t => {
  const { service, store } = await fixture(t)
  const read = vi.spyOn(store, 'read')
  const page = await service.list()
  expect(page).toMatchObject({ total: 28, offset: 0, nextOffset: null, previousOffset: 0, categories: ['Travel', 'News'] })
  expect(page.items).toHaveLength(28)
  expect(read).toHaveBeenCalledTimes(1)
})

test('list summaries preserve captured and legacy source metadata without opening unrelated analysis records', async t => {
  const { service, store } = await fixture(t, 3)
  const state = await store.read(), captured = state.items[0], manual = state.items[1]
  const capturedSource = snapshot(captured.url)
  const snapshotRef = await service.artifacts.put('snapshots', capturedSource)
  // An unreadable analysis must not prevent users from selecting the article to diagnose it.
  const analysisRef = await service.artifacts.put('analyses', { damaged: true })
  await store.update(value => {
    value.items[0].snapshotRef = snapshotRef; value.items[0].analysisRef = analysisRef; value.items[0].state = 'needs-source-review'
    value.items[1].legacy = true
    value.items[1].article = { title: 'Saved manual text', url: manual.url, language: 'en', paragraphs: [{ id: 1, text: 'Keep the saved source.' }], hash: 'a'.repeat(64), fetchedAt: '2026-10-18T00:00:00.000Z', basis: 'manual' }
  })
  const get = vi.spyOn(service.artifacts, 'get')
  const page = await service.list()
  expect(page.items[0]).toMatchObject({ id: captured.id, title: capturedSource.title, sourceHash: capturedSource.sourceHash, quality: capturedSource.quality, shots: 0, legacy: false, stage: null, state: 'needs-source-review' })
  expect(page.items[1]).toMatchObject({ id: manual.id, title: 'Saved manual text', sourceHash: 'a'.repeat(64), quality: null, shots: 0, legacy: true })
  expect(get.mock.calls.some(([kind]) => kind === 'analyses' || kind === 'inputs')).toBe(false)
  expect((await service.list({ category: 'Travel', offset: 1 })).items.map(item => item.id)).toEqual([state.items[2].id])
})

test('a rejected transaction cannot poison later writes or publish its partially modified state', async t => {
  const { store } = await fixture(t, 1), entered = Promise.withResolvers(), release = Promise.withResolvers()
  const error = new Error('controlled-transaction-failure'), pending = []
  t.onTestFinished(async () => { release.resolve(); await Promise.allSettled(pending) })
  const first = store.update(async state => { state.source.importedAt = 'uncommitted'; entered.resolve(); await release.promise; throw error })
  pending.push(first); const rejected = expect(first).rejects.toBe(error)
  await entered.promise
  const next = store.update(state => { expect(state.source.importedAt).not.toBe('uncommitted'); state.source.importedAt = 'committed'; return 'saved' })
  pending.push(next)
  release.resolve()
  await rejected; await expect(next).resolves.toBe('saved')
  expect((await store.read()).source.importedAt).toBe('committed')
})

test('separate Store instances retain the cross-process lock and read their predecessors complete commits', async t => {
  const { store, ctx, config } = await fixture(t, 1), other = new Store(ctx.profileContext.home, ctx.profileContext.dir, config)
  await store.update(state => { state.source = structuredClone(source) })
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), contender = Promise.withResolvers(), pending = []
  t.onTestFinished(async () => { claims.delete(store.file); release.resolve(); await Promise.allSettled(pending) })
  const first = store.update(async state => { entered.resolve(); await release.promise; state.source.importedAt = '1' })
  pending.push(first); await entered.promise
  claims.set(store.file, () => contender.resolve())
  let ran = false
  const second = other.update(state => { ran = true; expect(state.source.importedAt).toBe('1'); state.source.importedAt = '2' })
  pending.push(second); await contender.promise
  expect(ran).toBe(false)
  expect((await other.read()).source.importedAt).toBe('0')
  release.resolve(); await Promise.all(pending)
  expect((await store.read()).source.importedAt).toBe('2')
})

test('a Store writer waits for an independent process and retains that processes committed change', async t => {
  const { store } = await fixture(t, 1)
  await store.update(state => { state.source = structuredClone(source) })
  const atomicSource = new URL('../../../../packages/util/atomic-write/src/index.ts', import.meta.url).href
  // This OS fixture loads only the zero-dependency lock primitive, not a Cordis application.
  const code = `import { withFileLock, writeFileAtomic } from ${JSON.stringify(atomicSource)}; import { readFile } from 'node:fs/promises'; const path = process.argv[1]; await withFileLock(path, async () => { const release = new Promise(resolve => process.once('message', resolve)); process.send('locked'); await release; const value = JSON.parse(await readFile(path, 'utf8')); value.source.importedAt = 'child'; await writeFileAtomic(path, JSON.stringify(value) + '\\n', { mode: 0o600, dirMode: 0o700 }); }); process.disconnect();`
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code, store.file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let stderr = '', childExited = false
  child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { stderr += text })
  const exited = once(child, 'exit').then(value => { childExited = true; return value }), contender = Promise.withResolvers(), pending = []
  t.onTestFinished(async () => { claims.delete(store.file); if (!childExited) child.kill(); await exited; await Promise.allSettled(pending) })
  const ready = await Promise.race([once(child, 'message').then(([message]) => message), exited.then(([code, signal]) => { throw new Error(`child exited before readiness: ${code}/${signal}: ${stderr}`) })])
  expect(ready).toBe('locked')
  expect((await readFile(`${store.file}.lock`, 'utf8')).trim()).toBe(String(child.pid))
  claims.set(store.file, () => contender.resolve())
  let ran = false
  const mutation = store.update(state => { ran = true; expect(state.source.importedAt).toBe('child'); state.source.importedAt = 'parent' })
  pending.push(mutation); await contender.promise
  expect(ran).toBe(false)
  child.send('release')
  await mutation
  const [exitCode, signal] = await exited
  expect(signal, stderr).toBe(null); expect(exitCode, stderr).toBe(0)
  expect((await store.read()).source.importedAt).toBe('parent')
})
