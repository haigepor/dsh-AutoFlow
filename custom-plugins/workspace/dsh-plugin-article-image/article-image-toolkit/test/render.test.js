/** Browser renderer behavior and its use as a retrieval fallback. */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Renderer } from '../src/render.js'
import { ArticleService } from '../src/service.js'
import { resolveConfig } from '../src/config.js'

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1qggSoBOoLrdHOM-Y3YGaMUTQ3BwphWohVeDtOABWRCg/edit#gid=461869238'
const sampleCsv = readFileSync(fileURLToPath(new URL('./fixtures/sample-sheet.csv', import.meta.url)), 'utf8')
const ARTICLE_HTML = `<html lang="pt-BR"><head><title>Roteiro de 36 horas</title></head><body><article><h1>Roteiro de 36 horas</h1>${
  Array.from({ length: 14 }, (_, index) => `<p>Parágrafo ${index + 1} do roteiro com conteúdo suficiente para passar do limite mínimo de extração configurado.</p>`).join('')
}</article></body></html>`
const NO_TEXT_HTML = '<html><head><title>App</title></head><body><main><div></div></main></body></html>'
const SKELETON_HTML = '<html><head><title>App</title></head><body><main><p>Loading</p></main></body></html>'
const PAYWALL_HTML = '<html><head><title>Notícia</title></head><body><main><div class="paywall"><p>Este conteúdo é exclusivo para assinantes. Assine para continuar.</p></div><p>Short.</p></main></body></html>'
const CHALLENGE_HTML = '<html><head><title>Just a moment...</title></head><body><main><div id="cf-challenge-running">Checking your browser</div></main></body></html>'
const LOGIN_HTML = '<html><head><title>Sign in</title></head><body><main><h1>Sign in</h1><input type="password"></main></body></html>'

const pageOf = content => ({ url: 'https://example.com/a', statusCode: 200, truncated: false, body: { kind: 'html', content } })

/** Minimal browser double: records lifecycle calls and serves a fixed document. */
function fakeLauncher(options = {}) {
  const calls = { launched: 0, closed: 0, routed: 0, order: [] }
  const page = {
    goto: options.goto ?? (async url => ({ url: () => options.finalUrl ?? url, status: () => options.status ?? 200 })),
    waitForLoadState: options.waitForLoadState ?? (async () => { calls.order.push('waitForLoadState') }),
    waitForFunction: options.waitForFunction ?? (async () => { calls.order.push('waitForFunction') }),
    evaluate: options.evaluate ?? (async fn => { calls.order.push(`evaluate:${fn?.name}`) }),
    content: async () => { calls.order.push('content'); return options.html ?? ARTICLE_HTML },
    close: async () => {},
  }
  const context = { newPage: async () => page, route: async () => { calls.routed++ }, close: async () => {} }
  const browser = { newContext: async () => context, close: async () => { calls.closed++ } }
  return { calls, loadChromium: async () => {
    const start = async () => { calls.launched++; if (options.launchError) throw options.launchError; return options.persistent ? context : browser }
    return { launch: start, launchPersistentContext: start }
  } }
}

const cleanups = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

describe('Renderer', () => {
  it('renders a page into an HTML result carrying the final URL and status', async () => {
    const fake = fakeLauncher({ finalUrl: 'https://example.com/final', status: 200 })
    const renderer = new Renderer(resolveConfig({}), { loadChromium: fake.loadChromium })
    const page = await renderer.render('https://example.com/a', undefined)
    expect(page).toMatchObject({ url: 'https://example.com/final', statusCode: 200, truncated: false })
    expect(page.body.kind).toBe('html')
    expect(page.body.content).toContain('Parágrafo 1')
    await renderer.dispose()
  })

  it('launches one shared browser across concurrent renders and closes it on dispose', async () => {
    const fake = fakeLauncher()
    const renderer = new Renderer(resolveConfig({}), { loadChromium: fake.loadChromium })
    await Promise.all([renderer.render('https://example.com/a', undefined), renderer.render('https://example.com/b', undefined)])
    expect(fake.calls.launched).toBe(1)
    expect(fake.calls.routed).toBe(2)
    await renderer.dispose()
    expect(fake.calls.closed).toBe(1)
  })

  it('keeps the persistent profile when one is configured', async () => {
    const fake = fakeLauncher({ persistent: true })
    const renderer = new Renderer(resolveConfig({ renderUserDataDir: '/profiles/one' }), { loadChromium: fake.loadChromium })
    const page = await renderer.render('https://example.com/a', undefined)
    expect(page.body.kind).toBe('html')
    await renderer.dispose()
    expect(fake.calls.launched).toBe(1)
  })

  it('skips every wait phase when renderWaitMs is zero', async () => {
    let waits = 0
    let settles = 0
    const immediate = fakeLauncher({ waitForLoadState: async () => { waits++ }, waitForFunction: async () => { settles++ } })
    const renderer = new Renderer(resolveConfig({ renderWaitMs: 0 }), { loadChromium: immediate.loadChromium })
    await renderer.render('https://example.com/a', undefined)
    expect(waits).toBe(0)
    expect(settles).toBe(0)
    await renderer.dispose()
  })

  it('waits for network idle, content and DOM stability in order before snapshotting', async () => {
    const fake = fakeLauncher()
    const renderer = new Renderer(resolveConfig({}), { loadChromium: fake.loadChromium })
    await renderer.render('https://example.com/a', undefined)
    // 剪枝后依次取两份投影：序列化 DOM 与正文区域的可见文本。
    expect(fake.calls.order).toEqual(['waitForLoadState', 'waitForFunction', 'waitForFunction', 'evaluate:pruneDocument', 'content', 'evaluate:visibleArticle'])
    await renderer.dispose()
  })

  it('reports visible text only when the page has its own article region', async () => {
    const withRoot = fakeLauncher({ evaluate: async fn => fn?.name === 'visibleArticle' ? { text: 'Corpo visible', contentRoot: true } : undefined })
    const first = new Renderer(resolveConfig({}), { loadChromium: withRoot.loadChromium })
    await expect(first.render('https://example.com/a', undefined)).resolves.toMatchObject({ visible: 'Corpo visible', visibleIsArticle: true })
    await first.dispose()

    // 没有正文区域的页面：整页文本只是站点框架，不能当文章首段。
    const withoutRoot = fakeLauncher({ evaluate: async fn => fn?.name === 'visibleArticle' ? { text: 'Menu Acessibilidade Cookies', contentRoot: false } : undefined })
    const second = new Renderer(resolveConfig({}), { loadChromium: withoutRoot.loadChromium })
    await expect(second.render('https://example.com/a', undefined)).resolves.toMatchObject({ visible: '', visibleIsArticle: false })
    await second.dispose()
  })

  it('maps a navigation timeout to article-timeout and other failures to article-render', async () => {
    const timedOut = fakeLauncher({ goto: async () => { throw Object.assign(new Error('Timeout 60000ms exceeded.'), { name: 'TimeoutError' }) } })
    const renderer = new Renderer(resolveConfig({}), { loadChromium: timedOut.loadChromium })
    await expect(renderer.render('https://example.com/a', undefined)).rejects.toThrow('article-timeout')
    await renderer.dispose()

    const crashed = fakeLauncher({ goto: async () => { throw new Error('net::ERR_CONNECTION_RESET') } })
    const second = new Renderer(resolveConfig({}), { loadChromium: crashed.loadChromium })
    await expect(second.render('https://example.com/a', undefined)).rejects.toThrow('article-render')
    await second.dispose()
  })

  it('reports an absent launcher or failed start as article-render-unavailable', async () => {
    const missing = new Renderer(resolveConfig({}), { loadChromium: async () => { throw new Error('Cannot find package patchright') } })
    await expect(missing.render('https://example.com/a', undefined)).rejects.toThrow('article-render-unavailable')

    const broken = fakeLauncher({ launchError: new Error('Executable does not exist') })
    const renderer = new Renderer(resolveConfig({}), { loadChromium: broken.loadChromium })
    await expect(renderer.render('https://example.com/a', undefined)).rejects.toThrow('article-render-unavailable')
  })

  it('marks a snapshot above the character limit as truncated', async () => {
    const fake = fakeLauncher({ html: `<html><body>${'x'.repeat(120000)}</body></html>` })
    const renderer = new Renderer(resolveConfig({ maxArticleHtmlChars: 100000 }), { loadChromium: fake.loadChromium })
    const page = await renderer.render('https://example.com/a', undefined)
    expect(page.truncated).toBe(true)
    expect(page.body.content).toHaveLength(100000)
    await renderer.dispose()
  })

  it('refuses to render for an already aborted caller', async () => {
    const controller = new AbortController()
    controller.abort()
    const fake = fakeLauncher()
    const renderer = new Renderer(resolveConfig({}), { loadChromium: fake.loadChromium })
    await expect(renderer.render('https://example.com/a', controller.signal)).rejects.toThrow('article-interrupted')
    expect(fake.calls.launched).toBe(0)
  })

  it('reports an in-flight render as interrupted when the caller aborts', async () => {
    let release
    const gate = new Promise(resolve => { release = resolve })
    const fake = fakeLauncher({ goto: async () => { await gate; throw new Error('Target closed') } })
    const controller = new AbortController()
    const renderer = new Renderer(resolveConfig({}), { loadChromium: fake.loadChromium })
    const pending = renderer.render('https://example.com/a', controller.signal)
    controller.abort()
    release()
    await expect(pending).rejects.toThrow('article-interrupted')
    await renderer.dispose()
  })

  it('closes the owned context when cancellation interrupts navigation', async () => {
    let entered, rejectNavigation, closes = 0
    const started = new Promise(resolve => { entered = resolve })
    const navigation = new Promise((resolve, reject) => { rejectNavigation = reject })
    const page = { goto: () => { entered(); return navigation }, close: async () => {} }
    const context = { newPage: async () => page, close: async () => { closes++; rejectNavigation(new Error('Target closed')) } }
    const renderer = new Renderer(resolveConfig({ renderBlockAssets: false }), {
      loadChromium: async () => ({ launch: async () => ({ newContext: async () => context, close: async () => {} }) }),
    })
    const controller = new AbortController()
    const pending = renderer.render('https://example.com/a', controller.signal).catch(error => error)
    try {
      await started
      controller.abort()
      await new Promise(resolve => setImmediate(resolve))
      expect(closes).toBeGreaterThan(0)
      expect((await pending).message).toBe('article-interrupted')
    } finally {
      rejectNavigation(new Error('Fixture cleanup'))
      await pending
      await renderer.dispose()
    }
  })
})

describe('service retrieval with the render fallback', () => {
  const setup = async (overrides, dependencies) => {
    const dir = await mkdtemp(join(tmpdir(), 'article-image-render-'))
    const service = new ArticleService(resolveConfig({ dataDir: dir, ...overrides }), { download: async () => sampleCsv, ...dependencies })
    cleanups.push(async () => { await service.dispose(); await rm(dir, { recursive: true, force: true }) })
    await service.importSource({ url: SHEET_URL })
    const { items } = await service.list({})
    return { service, id: items[0].id }
  }
  const rendererDouble = () => ({ rendered: 0, dispose: async () => {},
    async render() { this.rendered++; return pageOf(ARTICLE_HTML) } })

  it('keeps static failures untouched when renderMode is never', async () => {
    const renderer = rendererDouble()
    const { service, id } = await setup({ renderMode: 'never' }, { fetchPage: async (config, url) => ({ ...pageOf(NO_TEXT_HTML), url }), renderer })
    await expect(service.fetchArticle(id, undefined)).rejects.toThrow('article-extraction')
    expect(renderer.rendered).toBe(0)
  })

  it('renders after an extraction failure and saves the rendered article', async () => {
    const renderer = rendererDouble()
    const { service, id } = await setup({ renderMode: 'fallback' }, { fetchPage: async (config, url) => ({ ...pageOf(NO_TEXT_HTML), url }), renderer })
    const item = await service.fetchArticle(id, undefined)
    expect(renderer.rendered).toBe(1)
    expect(item.state).toBe('ready')
    expect(item.article.paragraphs.length).toBeGreaterThan(3)
  })

  it('renders after a human-verification challenge', async () => {
    const renderer = rendererDouble()
    const { service, id } = await setup({ renderMode: 'fallback' }, { fetchPage: async (config, url) => ({ ...pageOf(CHALLENGE_HTML), url }), renderer })
    const item = await service.fetchArticle(id, undefined)
    expect(renderer.rendered).toBe(1)
    expect(item.state).toBe('ready')
  })

  it('renders after a short skeleton page that only scripts can fill', async () => {
    const renderer = rendererDouble()
    const { service, id } = await setup({ renderMode: 'fallback' }, { fetchPage: async (config, url) => ({ ...pageOf(SKELETON_HTML), url }), renderer })
    const item = await service.fetchArticle(id, undefined)
    expect(renderer.rendered).toBe(1)
    expect(item.state).toBe('ready')
  })

  it('renders after a non-browser user agent is refused', async () => {
    const renderer = rendererDouble()
    const { service, id } = await setup({ renderMode: 'fallback' },
      { fetchPage: async (config, url) => ({ url, statusCode: 403, truncated: false, body: { kind: 'text', content: '' } }), renderer })
    const item = await service.fetchArticle(id, undefined)
    expect(renderer.rendered).toBe(1)
    expect(item.state).toBe('ready')
  })

  it('does not render for a paywall, which rendering cannot pass', async () => {
    const renderer = rendererDouble()
    const { service, id } = await setup({ renderMode: 'fallback' }, { fetchPage: async (config, url) => ({ ...pageOf(PAYWALL_HTML), url }), renderer })
    await expect(service.fetchArticle(id, undefined)).rejects.toThrow('article-restricted')
    expect(renderer.rendered).toBe(0)
  })

  it('does not render for a login wall, which rendering cannot pass', async () => {
    const renderer = rendererDouble()
    const { service, id } = await setup({ renderMode: 'fallback' }, { fetchPage: async (config, url) => ({ ...pageOf(LOGIN_HTML), url }), renderer })
    await expect(service.fetchArticle(id, undefined)).rejects.toThrow('article-login')
    expect(renderer.rendered).toBe(0)
  })

  it('keeps the challenge code when the rendered page is still gated', async () => {
    const renderer = rendererDouble()
    renderer.render = async () => { renderer.rendered++; return pageOf(CHALLENGE_HTML) }
    const { service, id } = await setup({ renderMode: 'fallback' }, { fetchPage: async (config, url) => ({ ...pageOf(CHALLENGE_HTML), url }), renderer })
    await expect(service.fetchArticle(id, undefined)).rejects.toThrow('article-challenge')
    expect(renderer.rendered).toBe(1)
  })

  it('renders every page in always mode without static retrieval', async () => {
    const renderer = rendererDouble()
    let staticCalls = 0
    const { service, id } = await setup({ renderMode: 'always' }, { fetchPage: async () => { staticCalls++; return pageOf(NO_TEXT_HTML) }, renderer })
    const item = await service.fetchArticle(id, undefined)
    expect(staticCalls).toBe(0)
    expect(renderer.rendered).toBe(1)
    expect(item.state).toBe('ready')
  })

  it('reports an unavailable renderer across a batch instead of falling back silently', async () => {
    const renderer = { dispose: async () => {}, async render() { throw Object.assign(new Error('article-render-unavailable'), { code: 'article-render-unavailable' }) } }
    const { service, id } = await setup({ renderMode: 'fallback' }, { fetchPage: async (config, url) => ({ ...pageOf(NO_TEXT_HTML), url }), renderer })
    const batch = await service.fetchMany({ ids: [id] })
    expect(batch.completed).toBe(0)
    expect(batch.results[0].code).toBe('article-render-unavailable')
  })

  it('reports renderMode in the status retrieval policy', async () => {
    const { service } = await setup({ renderMode: 'fallback' }, { renderer: rendererDouble() })
    const status = await service.status()
    expect(status.retrievalPolicy.renderMode).toBe('fallback')
  })
})
