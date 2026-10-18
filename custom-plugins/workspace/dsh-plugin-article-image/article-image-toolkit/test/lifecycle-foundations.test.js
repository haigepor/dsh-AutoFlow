/** Disposal waits for owned retrieval, durable writes and browser shutdown. */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArticleService } from '../src/service.js'
import { Renderer } from '../src/render.js'
import { Store } from '../src/store.js'
import { resolveConfig } from '../src/config.js'
import { createCapture, resolveCaptureConfig } from '../src/capture.js'

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/lifecycle-fixture/edit'
const CSV = 'category,url,language,notes\nTravel,https://example.com/article,en,\n'
const TEXT = Array.from({ length: 8 }, (_, index) => `Section ${index + 1} describes the published article and its editorial context in enough detail for complete extraction.`).join('\n\n')
const HTML = `<html><head><title>Published article</title></head><body><article><h1>Published article</h1>${TEXT.split('\n\n').map(text => `<p>${text}</p>`).join('')}</article></body></html>`
const cleanups = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

/** Observe settlement without allowing rejected test work to become unhandled. */
function outcome(promise) {
  return promise.then(value => ({ value }), error => ({ error }))
}

/** A turn boundary drains immediate completion, without any elapsed-time threshold. */
async function expectPending(promise) {
  const result = await Promise.race([
    promise.then(() => 'settled', () => 'settled'),
    new Promise(resolve => setImmediate(() => resolve('pending'))),
  ])
  expect(result).toBe('pending')
}

async function serviceFixture(dependencies = {}) {
  const root = await mkdtemp(join(tmpdir(), 'article-image-lifecycle-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const config = resolveConfig({ dataDir: root, renderMode: 'never', mapping: { link: 'url', category: 'category', language: 'language', notes: 'notes' } })
  const store = new Store(root, config)
  const service = new ArticleService(config, {
    store,
    download: async () => CSV,
    fetchPage: async (settings, url) => ({ url, statusCode: 200, truncated: false, body: { kind: 'html', content: HTML } }),
    ...dependencies,
  })
  cleanups.push(() => service.dispose())
  await service.importSource({ url: SHEET_URL })
  const { items } = await service.list()
  return { service, store, item: items[0] }
}

function rendererFixture(close = async () => {}) {
  let launches = 0
  const page = {
    goto: async url => ({ url: () => url, status: () => 200 }),
    evaluate: async () => ({ text: TEXT, contentRoot: true, title: 'Published article' }),
    content: async () => HTML,
    close: async () => {},
  }
  const context = { newPage: async () => page, close: async () => {} }
  const browser = { newContext: async () => context, close }
  const renderer = new Renderer(resolveConfig({ renderWaitMs: 0, renderBlockAssets: false }), {
    loadChromium: async () => ({ launch: async () => { launches++; return browser } }),
  })
  cleanups.push(() => renderer.dispose())
  return { renderer, launches: () => launches }
}

describe('ArticleService lifecycle foundations', () => {
  it('returns interrupted results for queued batch ids without fetching them after cancellation', async () => {
    const { service, store } = await serviceFixture()
    const ids = ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)]
    await store.update(state => { const item = state.items[0]; state.items = ids.map((id, index) => ({ ...item, id, url: `https://example.com/${index}` })) })
    service.config.fetchConcurrency = 1
    const controller = new AbortController(), seen = []
    const result = await service.fetchMany({ ids }, controller.signal, event => { if (event.event === 'article-finished') { seen.push(event); controller.abort() } })
    expect(result, JSON.stringify(result)).toMatchObject({ completed: 1, total: 3, results: [
      { id: ids[0], ok: true },
      { id: ids[1], ok: false, code: 'article-interrupted' },
      { id: ids[2], ok: false, code: 'article-interrupted' },
    ] })
    expect(seen).toHaveLength(1)
    expect((await store.read()).items.slice(1).every(value => value.article === null)).toBe(true)
  })

  it('waits for an in-flight static retrieval to settle before disposal completes', async () => {
    const entered = deferred(), release = deferred(), events = []
    const { service, store } = await serviceFixture({ fetchPage: async (settings, url) => {
      entered.resolve()
      await release.promise
      events.push('retrieval-finished')
      return { url, statusCode: 200, truncated: false, body: { kind: 'html', content: HTML } }
    } })
    cleanups.push(() => release.resolve())
    const { items } = await service.list()
    const retrieval = outcome(service.fetchArticle(items[0].id))
    await entered.promise
    const disposal = service.dispose().then(() => { events.push('disposed') })
    try {
      await expectPending(disposal)
    } finally {
      release.resolve()
      await Promise.all([retrieval, disposal])
    }
    expect(events).toEqual(['retrieval-finished', 'disposed'])
    expect((await retrieval).error).toBeDefined()
    expect((await store.read()).items[0].article).toBeNull()
  })

  it('waits for an already-started durable write before disposal completes', async () => {
    const entered = deferred(), release = deferred(), events = []
    const { service, store, item } = await serviceFixture()
    cleanups.push(() => release.resolve())
    const update = store.update.bind(store)
    // Keep the real writer lock and atomic commit, pausing after mutation and before persistence.
    store.update = mutation => update(async state => {
      const value = await mutation(state)
      entered.resolve()
      await release.promise
      return value
    }).then(value => { events.push('write-finished'); return value })
    const writing = outcome(service.manualArticle({ id: item.id, revision: item.revision, title: 'Published article', text: TEXT, language: 'en' }))
    await entered.promise
    const disposal = service.dispose().then(() => { events.push('disposed') })
    try {
      await expectPending(disposal)
    } finally {
      release.resolve()
      await Promise.all([writing, disposal])
    }
    expect((await writing).error).toBeUndefined()
    expect((await store.read()).items[0].article.title).toBe('Published article')
    expect(events).toEqual(['write-finished', 'disposed'])
  })

  it('makes repeated disposal wait for one shared dependency shutdown', async () => {
    const entered = deferred(), release = deferred()
    let shutdowns = 0
    const { service } = await serviceFixture({ renderer: { dispose: async () => {
      shutdowns++
      entered.resolve()
      await release.promise
    } } })
    cleanups.push(() => release.resolve())
    const first = service.dispose()
    await entered.promise
    const second = service.dispose()
    try {
      await expectPending(second)
      expect(shutdowns).toBe(1)
    } finally {
      release.resolve()
      await Promise.all([first, second])
    }
    await service.dispose()
    expect(shutdowns).toBe(1)
  })

  it.each(['status', 'list', 'detail', 'fetchArticle', 'manualArticle'])('rejects a new %s operation after disposal', async method => {
    const { service, item } = await serviceFixture()
    await service.dispose()
    const call = () => {
      if (method === 'detail' || method === 'fetchArticle') return service[method](item.id)
      if (method === 'manualArticle') return service.manualArticle({ id: item.id, revision: item.revision, title: 'Published article', text: TEXT })
      return service[method]()
    }
    await expect(call()).rejects.toThrow('tools-unavailable')
  })
})

describe('Renderer lifecycle foundations', () => {
  it('waits for browser close to complete before disposal resolves', async () => {
    const entered = deferred(), release = deferred(), events = []
    const { renderer } = rendererFixture(async () => {
      entered.resolve()
      await release.promise
      events.push('browser-closed')
    })
    cleanups.push(() => release.resolve())
    await renderer.render('https://example.com/article')
    const disposal = renderer.dispose().then(() => { events.push('disposed') })
    await entered.promise
    try {
      await expectPending(disposal)
    } finally {
      release.resolve()
      await disposal
    }
    expect(events).toEqual(['browser-closed', 'disposed'])
  })

  it('makes repeated disposal wait for the same browser close', async () => {
    const entered = deferred(), release = deferred()
    let closes = 0
    const { renderer } = rendererFixture(async () => {
      closes++
      entered.resolve()
      await release.promise
    })
    cleanups.push(() => release.resolve())
    await renderer.render('https://example.com/article')
    const first = renderer.dispose()
    await entered.promise
    const second = renderer.dispose()
    try {
      await expectPending(second)
      expect(closes).toBe(1)
    } finally {
      release.resolve()
      await Promise.all([first, second])
    }
    await renderer.dispose()
    expect(closes).toBe(1)
  })

  it('rejects rendering after disposal without relaunching the browser', async () => {
    const { renderer, launches } = rendererFixture()
    await renderer.render('https://example.com/article')
    await renderer.dispose()
    await expect(renderer.render('https://example.com/another')).rejects.toThrow('article-interrupted')
    expect(launches()).toBe(1)
  })
})

describe('shared rich capture shutdown', () => {
  it('awaits active capture even when renderer shutdown fails, and releases the renderer once', async () => {
    const entered = deferred(), release = deferred()
    let closes = 0
    const capture = createCapture(resolveCaptureConfig({ minArticleChars: 1 }), { renderer: {
      async render() { entered.resolve(); await release.promise; return { url: 'https://example.com/a', statusCode: 200, html: HTML } },
      async dispose() { closes++; throw new Error('Fixture close failure') },
    } })
    const work = outcome(capture.capture('https://example.com/a'))
    await entered.promise
    const first = capture.dispose(), second = capture.dispose()
    const closed = outcome(first), repeated = outcome(second)
    try {
      await expectPending(first)
      expect(closes).toBe(1)
    } finally {
      release.resolve()
      await Promise.all([closed, repeated, work])
    }
    expect((await closed).error.message).toBe('Fixture close failure')
    expect((await repeated).error).toBe((await closed).error)
    expect((await work).error.code).toBe('article-interrupted')
  })
})
