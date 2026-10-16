import { test, expect } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSheet, downloadSheet } from '../src/host/sheets.js'
import { ArticleService } from '../src/host/service.js'
import { resolveConfig } from '../config-schema.js'
import { errorCode } from '../src/shared/contracts.js'

const source = 'https://docs.google.com/spreadsheets/d/fixture-sheet/edit#gid=461869238'
const csv = ',Category,,Links,Image ID,备注,语言\n,Travel,,https://example.com/one,,"a,b",pt\n,,,https://example.com/two?edition=2,,,\n,,,javascript:alert(1),,,\n'
async function fixture(t, fetchPage, config = {}) {
  const home = await mkdtemp(join(tmpdir(), 'article-image-'))
  const tasks = []
  const ctx = { profileContext: { home, dir: join(home, 'profile') }, web: { fetch: fetchPage }, jobs: {
    start(spec) { const id = `job-${tasks.length}`; tasks.push(spec.run({ append() {}, updateProgress() {} })); return id },
  } }
  const service = new ArticleService(ctx, resolveConfig({ retryLargeHtml: false, ...config }), { download: async () => csv })
  const disableTools = await service.enable('tools')
  t.onTestFinished(async () => { await service.dispose(); await Promise.all(tasks.map(task => task.done)); await rm(home, { recursive: true, force: true }) })
  return { service, ctx, home, tasks, disableTools }
}
function plan(article) {
  return { sourceHash: article.hash, brief: { theme: '家庭旅行', facts: ['Families travel together'], subjects: ['families'], scenes: ['A family walking outdoors'] },
    shots: [{ purpose: 'cover', paragraphs: [1], rationale: 'Illustrates family travel', subject: 'A family', action: 'walking', environment: 'a park', composition: 'wide shot', lighting: 'daylight', colors: 'natural', style: 'realistic editorial photography', details: 'Natural expressions', avoid: 'No text or invented event claims', prompt: 'A realistic editorial photograph of a family walking in a park.', ratio: '16:9' }] }
}
const body = 'Families can enjoy a relaxed trip together. Parents plan outdoor activities and rest breaks for children. '.repeat(7)

test('imports grouped CSV with business query parameters and invalid-row diagnostics', () => {
  const parsed = parseSheet(csv, source, { link: 'Links', category: 'Category', language: '语言', notes: '备注' })
  expect(parsed.items).toHaveLength(2)
  expect(parsed.items[1].category).toBe('Travel')
  expect(parsed.items[1].url).toBe('https://example.com/two?edition=2')
  expect(parsed.items[0].raw['备注']).toBe('a,b')
  expect(parsed.rejected.map(row => row.row)).toEqual([4])
  expect(() => parseSheet('<html>Login</html>', source, { link: 'Links' })).toThrow()
})

test('current source fixture contains 28 distinct article links', async () => {
  const text = await readFile(fileURLToPath(new URL('./fixtures/source.csv', import.meta.url)), 'utf8')
  const parsed = parseSheet(text, source, resolveConfig({}).mapping)
  expect(parsed.items).toHaveLength(28)
  expect(new Set(parsed.items.map(item => item.url)).size).toBe(28)
})

test('Google download follows only sheet download destinations and rejects login HTML', async () => {
  const signal = new AbortController().signal
  let calls = 0
  const fetch = async () => ++calls === 1 ? new Response(null, { status: 302, headers: { location: 'https://doc-00-34-sheets.googleusercontent.com/export/file' } })
    : new Response(csv, { headers: { 'content-type': 'text/csv' } })
  expect(await downloadSheet(source, resolveConfig({}), signal, fetch)).toBe(csv)
  await expect(downloadSheet(source, resolveConfig({}), signal, async () => new Response(null, { status: 302, headers: { location: 'https://example.com/' } }))).rejects.toThrow('sheet-redirect')
  await expect(downloadSheet(source, resolveConfig({}), signal, async () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }))).rejects.toThrow('sheet-auth')
})

test('deduplicates imports, persists plans, rejects stale saves and binds review to a revision', async t => {
  const { service } = await fixture(t, async () => ({ url: 'https://example.com/one', statusCode: 200, truncated: false, body: { kind: 'text', content: body } }))
  const imported = await service.importSource({ url: source })
  expect(imported.added).toBe(2)
  expect((await service.importSource({ url: source })).added).toBe(0)
  const id = (await service.list({})).items[0].id
  await service.fetchArticle(id, new AbortController().signal)
  const detail = await service.detail(id)
  const saved = await service.savePlan({ id, revision: detail.revision, plan: plan(detail.article) })
  await expect(service.savePlan({ id, revision: detail.revision, plan: plan(detail.article) })).rejects.toThrow('stale-revision')
  const approved = await service.approve({ id, revision: saved.revision })
  expect(approved.state).toBe('approved')
  const edited = await service.savePlan({ id, revision: approved.revision, plan: { ...approved.plan, shots: [{ ...approved.plan.shots[0], ratio: '4:3' }] } })
  expect(edited.state).toBe('review')
  expect(edited.approval).toBeNull()
  expect((await service.detail(id)).plan.shots[0].ratio).toBe('4:3')
})

test('does not create prompts from truncated or insufficient article bodies', async t => {
  const { service } = await fixture(t, async () => ({ statusCode: 200, truncated: true, body: { kind: 'text', content: body } }))
  await service.importSource({ url: source })
  const id = (await service.list({})).items[0].id
  await expect(service.fetchArticle(id, new AbortController().signal)).rejects.toThrow('article-truncated')
  expect((await service.detail(id)).state).toBe('failed')
  const detail = await service.detail(id)
  await expect(service.manualArticle({ id, revision: detail.revision, title: 'Title', text: 'Tiny text' })).rejects.toThrow('article-short')
})

test('manual text is usable and invalid paragraph references are refused', async t => {
  const { service } = await fixture(t)
  await service.importSource({ url: source })
  const item = (await service.list({})).items[0]
  const detail = await service.manualArticle({ id: item.id, revision: item.revision, title: 'Family travel', text: body })
  const draft = plan(detail.article); draft.shots[0].paragraphs = [999]
  await expect(service.savePlan({ id: item.id, revision: detail.revision, plan: draft })).rejects.toThrow('paragraph-reference')
  const page = await service.articlePage({ id: item.id, sourceHash: detail.article.hash, offset: 0 })
  expect(page.paragraphs[0].text).toContain('Families')
  expect(page.sourceHash).toBe(detail.article.hash)
})

test('native fetch timeout is a failed retrieval rather than user cancellation', async t => {
  const { service } = await fixture(t, async () => { throw Object.assign(new Error('private network information'), { code: 'WEB_FETCH_TIMEOUT' }) })
  await service.importSource({ url: source })
  const id = (await service.list({})).items[0].id
  await expect(service.fetchArticle(id, new AbortController().signal)).rejects.toThrow('article-timeout')
  expect(await service.detail(id)).toMatchObject({ state: 'failed', error: 'article-timeout' })
})

test('the whole retrieval deadline records timeout without labelling it a user stop', async t => {
  const { service } = await fixture(t, async (_request, signal) => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted()
  }, { requestTimeoutMs: 1000 })
  await service.importSource({ url: source })
  const id = (await service.list({})).items[0].id
  await expect(service.fetchArticle(id, new AbortController().signal)).rejects.toThrow('article-timeout')
  expect(await service.detail(id)).toMatchObject({ state: 'failed', error: 'article-timeout', fetching: null })
})

for (const stopped of [false, true]) test(`a ${stopped ? 'cancelled' : 'timed out'} fetch waiting for its first write reports its cause without changing the article`, async t => {
  const { service } = await fixture(t, async () => { throw new Error('Must not fetch') }, { requestTimeoutMs: 1000 })
  await service.importSource({ url: source })
  const item = (await service.list({})).items[0], controller = new AbortController()
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), update = service.store.update.bind(service.store)
  let first = true
  service.store.update = write => update(async state => {
    if (first) { first = false; entered.resolve(); await release.promise }
    return write(state)
  })
  const result = service.fetchArticle(item.id, controller.signal).catch(error => error)
  try {
    await entered.promise
    if (stopped) controller.abort()
    else await new Promise(resolve => setTimeout(resolve, 1100))
    release.resolve()
    expect((await result).code).toBe(stopped ? 'article-interrupted' : 'article-timeout')
    expect(await service.detail(item.id)).toMatchObject({ state: 'imported', error: null, fetching: null, revision: item.revision })
  } finally { release.resolve(); await result }
})

test('batch size respects the full one-time job result budget and bounds foreign error codes', async t => {
  const code = 'article-' + 'x'.repeat(56)
  const { service, tasks } = await fixture(t, async () => { throw Object.assign(new Error('private text'), { code }) }, { toolResultBytes: 8000 })
  service.download = async () => 'Category,Links,语言,备注\n' + Array.from({ length: 100 }, (_, index) => `Travel,https://example.com/${index},pt,\n`).join('')
  await service.importSource({ url: source })
  const ids = (await service.store.read()).items.map(item => item.id), limit = service.fetchBatchLimit()
  expect((await service.status()).retrievalPolicy.maxFetchBatch).toBe(limit)
  expect(limit).toBeLessThan(100)
  await expect(service.startFetch(ids)).rejects.toThrow('fetch-batch-limit')
  await service.startFetch(ids.slice(0, limit))
  const result = await tasks[0].done
  expect(Buffer.byteLength(result.result)).toBeLessThan(8000 - 256)
  expect(JSON.parse(result.result).results).toHaveLength(limit)
  expect(JSON.parse(result.result).results.every(item => item.code === code)).toBe(true)
  expect(errorCode(Object.assign(new Error('remote details'), { code: 'a-'.repeat(100) + 'a' }))).toBe('operation-failed')
})

test('large HTML recovery is explicit in job results and leaves durable article fields unchanged', async t => {
  const { service, tasks } = await fixture(t, async () => ({ statusCode: 200, truncated: true, body: { kind: 'html', content: '<article>partial' } }), { retryLargeHtml: true })
  service.largeFetch = async () => ({ url: 'https://example.com/one', statusCode: 200, truncated: false, body: { kind: 'html', content: `<html><title>Family travel</title><article><p>${body}</p></article></html>` } })
  await service.importSource({ url: source })
  const id = (await service.list({})).items[0].id
  await service.startFetch([id])
  const result = await tasks[0].done
  expect(result.status).toBe('completed')
  expect(JSON.parse(result.result).results).toEqual([{ id, ok: true, transport: 'anonymous-http-size-retry', retried: true }])
  expect((await service.detail(id)).article).not.toHaveProperty('retrieval')
})

test('Chinese article pages fit both character and complete JSON byte limits without losing text', async t => {
  const { service } = await fixture(t, undefined, { articlePageChars: 2000, toolResultBytes: 8000 })
  await service.importSource({ url: source })
  const item = (await service.list({})).items[0], text = '中文正文内容。'.repeat(700)
  const detail = await service.manualArticle({ id: item.id, revision: item.revision, title: '中文文章', text })
  let offset = 0
  const paragraphs = []
  do {
    const page = await service.articlePage({ id: item.id, sourceHash: detail.article.hash, offset })
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(8000)
    expect(page.paragraphs.reduce((total, paragraph) => total + paragraph.text.length, 0)).toBeLessThanOrEqual(2000)
    expect(page.source).toEqual({ url: item.url, fetchedAt: detail.article.fetchedAt })
    expect(page.state).toBe('ready')
    paragraphs.push(...page.paragraphs)
    offset = page.nextOffset
  } while (offset !== null)
  expect(paragraphs).toEqual(detail.article.paragraphs)
  expect(paragraphs.map(paragraph => paragraph.text).join('')).toBe(text)
})

test('a failed refresh exposes the failure alongside retained earlier text and refuses a new plan', async t => {
  const { service } = await fixture(t, async () => { throw Object.assign(new Error('remote details'), { code: 'WEB_PROVIDER_ERROR' }) })
  await service.importSource({ url: source })
  const item = (await service.list({})).items[0]
  const saved = await service.manualArticle({ id: item.id, revision: item.revision, title: 'Earlier text', text: body })
  await expect(service.fetchArticle(item.id, new AbortController().signal)).rejects.toThrow('article-network')
  const detail = await service.detail(item.id)
  const page = await service.articlePage({ id: item.id, sourceHash: saved.article.hash, offset: 0 })
  expect(page).toMatchObject({ state: 'failed', error: 'article-network', basis: 'manual', sourceHash: saved.article.hash })
  await expect(service.savePlan({ id: item.id, revision: detail.revision, plan: plan(saved.article) })).rejects.toThrow('stale-source')
})

test('cancellation drains fetch jobs and records an interruption', async t => {
  let enter
  const entered = new Promise(resolve => { enter = resolve })
  const { service, tasks } = await fixture(t, async (_request, signal) => {
    enter(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted()
  })
  await service.importSource({ url: source })
  const id = (await service.list({})).items[0].id
  await service.startFetch([id])
  await entered
  await service.dispose()
  expect((await tasks[0].done).status).toBe('killed')
  expect((await service.detail(id)).state).toBe('interrupted')
})

for (const operation of ['manual', 'save-plan', 'approve', 'skip']) test(`unloading drains a queued ${operation} write without committing it`, async t => {
  const { service } = await fixture(t)
  await service.importSource({ url: source })
  const imported = (await service.list({})).items[0]
  const ready = await service.manualArticle({ id: imported.id, revision: imported.revision, title: 'Family travel', text: body })
  const before = await service.savePlan({ id: ready.id, revision: ready.revision, plan: plan(ready.article) })
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const update = service.store.update.bind(service.store)
  service.store.update = write => update(async state => {
    entered.resolve(); await release.promise
    return write(state)
  })
  const args = operation === 'manual' ? { id: before.id, revision: before.revision, title: 'Changed title', text: body }
    : operation === 'save-plan' ? { id: before.id, revision: before.revision, plan: before.plan } : { id: before.id, revision: before.revision }
  const result = service.action(operation, args).catch(error => error)
  let disposed = false
  try {
    await entered.promise
    const disposing = service.dispose().then(() => { disposed = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(disposed).toBe(false)
    release.resolve()
    expect(await result).toBeInstanceOf(Error)
    await disposing
    expect(await service.detail(before.id)).toEqual(before)
  } finally { release.resolve(); await result }
})

test('disabling tools rejects an old queued write even when tools are enabled again', async t => {
  const { service, disableTools } = await fixture(t)
  await service.importSource({ url: source })
  const before = await service.detail((await service.list({})).items[0].id)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const update = service.store.update.bind(service.store)
  service.store.update = write => update(async state => {
    entered.resolve(); await release.promise
    return write(state)
  })
  const result = service.manualArticle({ id: before.id, revision: before.revision, title: 'Family travel', text: body }).catch(error => error)
  try {
    await entered.promise
    const disabling = disableTools()
    await service.enable('tools')
    release.resolve()
    expect(await result).toBeInstanceOf(Error)
    await disabling
    expect(await service.detail(before.id)).toEqual(before)
  } finally { release.resolve(); await result }
})

test('unloading before retrieval registration leaves no background job', async t => {
  const { service, tasks } = await fixture(t)
  await service.importSource({ url: source })
  const id = (await service.list({})).items[0].id
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const read = service.store.read.bind(service.store)
  service.store.read = async () => { entered.resolve(); await release.promise; return read() }
  const result = service.startFetch([id]).catch(error => error)
  try {
    await entered.promise
    const disposing = service.dispose()
    release.resolve()
    expect(await result).toBeInstanceOf(Error)
    await disposing
    expect(tasks).toHaveLength(0)
  } finally { release.resolve(); await result }
})

test('unloading rejects a CSV import waiting to commit', async t => {
  const { service } = await fixture(t)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const update = service.store.update.bind(service.store)
  service.store.update = write => update(async state => {
    entered.resolve(); await release.promise
    return write(state)
  })
  const result = service.importSource({ url: source }).catch(error => error)
  try {
    await entered.promise
    const disposing = service.dispose()
    release.resolve()
    expect(await result).toBeInstanceOf(Error)
    await disposing
    expect(await service.store.read()).toEqual({ schema: 1, source: null, items: [] })
  } finally { release.resolve(); await result }
})

test('unloading before article commit records interruption without accepting late text', async t => {
  const { service } = await fixture(t, async () => ({ url: 'https://example.com/one', statusCode: 200, truncated: false, body: { kind: 'text', content: body } }))
  await service.importSource({ url: source })
  const id = (await service.list({})).items[0].id
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const update = service.store.update.bind(service.store)
  let writes = 0
  service.store.update = write => update(async state => {
    if (++writes === 2) { entered.resolve(); await release.promise }
    return write(state)
  })
  const result = service.fetchArticle(id, new AbortController().signal).catch(error => error)
  try {
    await entered.promise
    const disposing = service.dispose()
    release.resolve()
    expect(await result).toBeInstanceOf(Error)
    await disposing
    expect(await service.detail(id)).toMatchObject({ state: 'interrupted', article: null, fetching: null, error: 'article-interrupted' })
  } finally { release.resolve(); await result }
})

test('HTTP rejects an oversized chunked body before reading its tail and releases the reader', async t => {
  const { service } = await fixture(t)
  let pulls = 0, cancelled = false
  const stream = new ReadableStream({
    pull(controller) {
      pulls++
      if (pulls === 1) controller.enqueue(new Uint8Array(service.config.maxWireBytes).fill(32))
      else if (pulls < 4) controller.enqueue(new TextEncoder().encode('extra'))
      else controller.close()
    },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 })
  const request = new Request('http://dsh.internal/api/article-image/data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' })
  const response = await service.dataResponse(request)
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ ok: false, error: { code: 'request-size' } })
  expect(pulls).toBe(2)
  expect(cancelled).toBe(true)
  expect(stream.locked).toBe(false)
})

test('HTTP accepts small chunked JSON split within a UTF-8 character', async t => {
  const { service } = await fixture(t)
  const bytes = new TextEncoder().encode(JSON.stringify({ operation: 'list', args: { category: '旅行' } }))
  const split = bytes.indexOf(0xe6) + 1
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(bytes.slice(0, split)); controller.enqueue(bytes.slice(split)); controller.close()
  } })
  const response = await service.dataResponse(new Request('http://dsh.internal/api/article-image/data', {
    method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: stream, duplex: 'half',
  }))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ ok: true, value: { total: 0, items: [] } })
  expect(stream.locked).toBe(false)
})

test('HTTP reports invalid JSON as a safe request error and releases its reader', async t => {
  const { service } = await fixture(t)
  const request = new Request('http://dsh.internal/api/article-image/data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"operation":' })
  const response = await service.dataResponse(request)
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ ok: false, error: { code: 'invalid-request' } })
  expect(request.body.locked).toBe(false)
})

test('HTTP cancels an unsupported content type without reading its body', async t => {
  const { service } = await fixture(t)
  let pulls = 0, cancelled = false
  const stream = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array([1])) }, cancel() { cancelled = true } }, { highWaterMark: 0 })
  const response = await service.dataResponse(new Request('http://dsh.internal/api/article-image/data', {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: stream, duplex: 'half',
  }))
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ ok: false, error: { code: 'invalid-request' } })
  expect(pulls).toBe(0)
  expect(cancelled).toBe(true)
  expect(stream.locked).toBe(false)
})

test('HTTP withholds stream failure text and releases an errored reader', async t => {
  const { service } = await fixture(t)
  const stream = new ReadableStream({ start(controller) { controller.error(new Error('private upstream detail')) } })
  const response = await service.dataResponse(new Request('http://dsh.internal/api/article-image/data', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half',
  }))
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ ok: false, error: { code: 'operation-failed' } })
  expect(stream.locked).toBe(false)
})
