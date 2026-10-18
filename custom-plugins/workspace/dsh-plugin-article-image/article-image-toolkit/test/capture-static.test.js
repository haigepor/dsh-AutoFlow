/** Explicit static completeness evidence shares rich extraction and preserves browser fallback decisions. */
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createCapture, resolveCaptureConfig } from '../src/capture.js'
import { hashSnapshot } from '../src/capture-contracts.js'
import { failure } from '../src/contracts.js'

const url = 'https://articles.example.test/report'
const imageUrl = 'https://articles.example.test/lead-original.png'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVQImWP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64')
const start = '<span data-static-start hidden></span>', end = '<span data-static-end aria-hidden="true"></span>'
const staticSpec = { startSelector: '[data-static-start]', endSelector: '[data-static-end]', requiredSelectors: ['h1', '.body-facts', 'figure img'] }
const browserHtml = '<title>Browser report</title><article><p>Browser fallback body.</p></article>'

function richHtml(text = 'First verified static paragraph.') {
  return `<html><head><title>Static report</title><link rel="canonical" href="${url}"></head><body><article>${start}<h1>Static report</h1><p class="body-facts">${text}</p><ul><li>First editorial item<ol><li>Nested editorial detail</li></ol></li></ul><figure><img src="/preview.png" data-original="/lead-original.png" alt="Published scene"><figcaption>Published image caption.</figcaption></figure><p>Final verified static paragraph.</p>${end}</article></body></html>`
}

function htmlResponse(markup, fields = {}) {
  return { url, statusCode: 200, mime: 'text/html', headers: { 'content-type': 'text/html; charset=utf-8' }, bytes: Buffer.from(markup, 'utf8'), ...fields }
}

function fixture({ markup = richHtml(), renderedMarkup = browserHtml, optIn = true, adapter = {}, overrides = {}, request, imageRequest, response = {} } = {}) {
  const requested = [], calls = []
  const settings = resolveCaptureConfig({ minArticleChars: 1, adapters: [{ id: 'public-static-v1', hosts: ['articles.example.test'], articleSelector: 'article', ...(optIn ? { static: staticSpec } : {}), ...adapter }], ...overrides })
  const renderer = { readiness: async () => ({ available: true }), render: vi.fn(async () => ({ html: renderedMarkup, url, statusCode: 200, diagnostics: [] })), dispose: vi.fn(async () => {}) }
  const capture = createCapture(settings, { renderer, inspectImage: async () => ({ width: 2, height: 2, mime: 'image/png' }), request: async (target, options) => {
    requested.push(target); calls.push({ target, options })
    if (target === url) return request ? request(target, options) : htmlResponse(markup, response)
    if (target === imageUrl) return imageRequest ? imageRequest(target, options) : { url: target, statusCode: 200, mime: 'image/png', headers: { 'content-type': 'image/png' }, bytes: png }
    throw new Error('Unexpected fixture request: ' + target)
  } })
  return { capture, renderer, requested, calls }
}

function expectBrowser(snapshot, renderer) {
  expect(renderer.render).toHaveBeenCalledTimes(1)
  expect(snapshot.blocks.some(block => block.type === 'paragraph' && block.inline.some(run => run.text === 'Browser fallback body.'))).toBe(true)
  expect(snapshot.quality.checks).toContain('rendered-dom')
  expect(snapshot.quality.checks).not.toContain('static-site-verified')
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

describe('verified static article capture', () => {
  it('preserves generic browser capture on a different template path of the same publisher', async () => {
    const { capture, renderer, requested } = fixture({ adapter: { pathPrefixes: ['/aqui/'], articleSelector: '.verified-template-only' } })
    try {
      const { snapshot } = await capture.capture(url)
      expectBrowser(snapshot, renderer)
      expect(requested).toEqual([])
      expect(snapshot.quality.status).toBe('needs-review')
      expect(snapshot.quality.reasons).toContain('unknown-article-scope')
      expect(snapshot.quality.reasons).not.toContain('adapter-article-scope')
    } finally { await capture.dispose() }
  })

  it('accepts a verified prefix and rejects a controlled redirect outside that template', async () => {
    const inside = fixture({ adapter: { pathPrefixes: ['/report'] } })
    try {
      expect((await inside.capture.capture(url)).snapshot.quality.checks).toContain('static-site-verified')
      expect(inside.renderer.render).not.toHaveBeenCalled()
    } finally { await inside.capture.dispose() }
    const outside = 'https://articles.example.test/another-template'
    const redirected = fixture({ adapter: { pathPrefixes: ['/report'] }, markup: richHtml().replace(`href="${url}"`, `href="${outside}"`), response: { url: outside } })
    try { expectBrowser((await redirected.capture.capture(url)).snapshot, redirected.renderer) }
    finally { await redirected.capture.dispose() }
  })

  it.each([[], ['relative'], ['//another-host/path'], ['/aqui?query'], ['/aqui#fragment'], ['/aqui\\other'], ['/aqui/../other'], ['/%2e%2e/other']].map(pathPrefixes => ({ pathPrefixes })))('rejects ambiguous adapter pathname prefixes $pathPrefixes', ({ pathPrefixes }) => {
    expect(() => resolveCaptureConfig({ adapters: [{ id: 'scoped-site', hosts: ['articles.example.test'], articleSelector: 'article', pathPrefixes }] })).toThrow()
  })

  it('uses bounded HTTP and shared rich extraction only after explicit completeness verification', async () => {
    const { capture, renderer, requested } = fixture()
    try {
      const { snapshot, assets } = await capture.capture(url)
      expect(renderer.render).not.toHaveBeenCalled()
      expect(requested).toEqual([url, imageUrl])
      expect(snapshot.blocks.map(block => block.type)).toEqual(['heading', 'paragraph', 'list', 'figure', 'paragraph'])
      expect(snapshot.blocks[2].items[0].children[0].items[0].inline).toEqual([{ text: 'Nested editorial detail' }])
      expect(snapshot.blocks[3]).toMatchObject({ alt: 'Published scene', caption: 'Published image caption.' })
      const contentHash = createHash('sha256').update(png).digest('hex')
      expect(assets).toHaveLength(1)
      expect(assets[0]).toMatchObject({ bytes: png, contentHash, status: 'ready', sourceUrl: imageUrl })
      expect(snapshot.assets[0]).toMatchObject({ contentHash, positions: [snapshot.blocks[3].id] })
      expect(snapshot.sourceHash).toBe(hashSnapshot(snapshot))
      expect(snapshot.quality.checks).toEqual(expect.arrayContaining(['static-dom', 'static-site-verified', 'ordered-blocks', 'decoded-assets']))
      expect(snapshot.quality.checks).not.toContain('rendered-dom')
    } finally { await capture.dispose() }
  })

  it('decodes a declared Windows-1252 response before validating and extracting its text', async () => {
    const paragraph = 'O caf\u00e9 apresenta informa\u00e7\u00f5es p\u00fablicas.'
    const { capture, renderer } = fixture({ response: { bytes: Buffer.from(richHtml(paragraph), 'latin1'), headers: { 'content-type': 'text/html; charset=windows-1252' } } })
    try {
      const { snapshot } = await capture.capture(url)
      expect(renderer.render).not.toHaveBeenCalled()
      expect(snapshot.blocks.some(block => block.type === 'paragraph' && block.inline.some(run => run.text === paragraph))).toBe(true)
      expect(JSON.stringify(snapshot.blocks)).not.toContain('\ufffd')
    } finally { await capture.dispose() }
  })

  it.each([
    ['missing end marker', html => html.replace(end, '')],
    ['duplicate start marker', html => html.replace(start, start + start)],
    ['reversed markers', html => html.replace(start, '__START__').replace(end, start).replace('__START__', end)],
    ['missing required content', html => html.replace('class="body-facts"', 'class="other-facts"')],
    ['duplicate article roots', html => html.replace('</body>', '<article><p>Another article root.</p></article></body>')],
    ['missing canonical', html => html.replace(`<link rel="canonical" href="${url}">`, '')],
    ['duplicate canonical', html => html.replace('</head>', `<link rel="canonical" href="${url}"></head>`)],
    ['mismatched canonical', html => html.replace(`href="${url}"`, 'href="https://articles.example.test/other"')],
    ['text before start marker', html => html.replace(start, '<p>Unverified leading text.</p>' + start)],
    ['text after end marker', html => html.replace(end, end + '<p>Unverified trailing text.</p>')],
    ['list after end marker', html => html.replace(end, end + '<ul><li>Unverified trailing item.</li></ul>')],
    ['image after end marker', html => html.replace(end, end + '<img src="/unverified.png">')],
    ['long text without completeness markers', html => html.replace(start, '').replace(end, '').replace('First verified static paragraph.', 'A long public teaser is still not completeness evidence. '.repeat(50))],
  ])('falls back once for %s instead of accepting a word count as completeness', async (_kind, transform) => {
    const { capture, renderer, requested } = fixture({ markup: transform(richHtml()) })
    try {
      const { snapshot } = await capture.capture(url)
      expectBrowser(snapshot, renderer)
      expect(requested).toEqual([url])
    } finally { await capture.dispose() }
  })

  it('allows explicitly excluded trailing noise without treating it as unverified article content', async () => {
    const markup = richHtml().replace(end, end + '<div class="publisher-extra"><p>Publisher promotion.</p><img src="/promotion.png"><svg></svg></div>')
    const { capture, renderer, requested } = fixture({ markup, adapter: { excludeSelector: '.publisher-extra' } })
    try {
      const { snapshot } = await capture.capture(url)
      expect(renderer.render).not.toHaveBeenCalled()
      expect(requested).toEqual([url, imageUrl])
      expect(JSON.stringify(snapshot.blocks)).not.toContain('Publisher promotion.')
      expect(snapshot.quality.checks).toContain('static-site-verified')
    } finally { await capture.dispose() }
  })

  it('does not prefetch a page when its adapter has no explicit static opt-in', async () => {
    const { capture, renderer, requested } = fixture({ optIn: false })
    try {
      const { snapshot } = await capture.capture(url)
      expectBrowser(snapshot, renderer)
      expect(requested).toEqual([])
    } finally { await capture.dispose() }
  })

  it.each([
    ['pagination', { pagination: { nextSelector: 'a[rel="next"]', identitySelector: 'article', identityAttribute: 'data-report', maxPages: 2 } }],
    ['embeddedSources', { embeddedSources: [{ selector: 'iframe.story', hosts: ['stories.example.test'], kind: 'story', rootSelector: 'main', pageSelector: '.page' }] }],
    ['captionSources', { captionSources: [{ selector: 'video', hosts: ['media.example.test'] }] }],
    ['expandSelector', { expandSelector: 'button.expand' }],
    ['pendingSelector', { pendingSelector: '.gallery-pending' }],
  ])('skips the static prefetch for an adapter requiring %s', async (_kind, adapter) => {
    const { capture, renderer, requested } = fixture({ adapter })
    try {
      const { snapshot } = await capture.capture(url)
      expectBrowser(snapshot, renderer)
      expect(requested).toEqual([])
    } finally { await capture.dispose() }
  })

  it.each([
    ['iframe', '<iframe src="https://media.example.test/embed"></iframe>'],
    ['video', '<video src="https://media.example.test/report.mp4"></video>'],
    ['audio', '<audio src="https://media.example.test/report.mp3"></audio>'],
    ['canvas', '<canvas></canvas>'],
    ['SVG chart', '<svg role="img"><text>Reported measurement</text></svg>'],
    ['busy content', '<div aria-busy="true">Loading report detail.</div>'],
    ['loading content', '<div data-loading="true">Loading report detail.</div>'],
    ['skeleton', '<div class="skeleton">Loading report detail.</div>'],
    ['image without a source', '<figure><img alt="Unresolved published scene"></figure>'],
    ['AMP image', '<amp-img src="/published.png" width="1200" height="800"></amp-img>'],
    ['AMP animation', '<amp-anim src="/published.gif" width="1200" height="800"></amp-anim>'],
    ['picture without an image', '<picture><source srcset="/published.png 1200w"></picture>'],
    ['empty loading attribute', '<div data-loading>Loading remaining report.</div>'],
    ['hidden potential article content', '<section hidden><p>Unloaded article section.</p></section>'],
    ['aria-hidden potential article content', '<section aria-hidden="true"><p>Unloaded article section.</p></section>'],
  ])('falls back when otherwise complete static markup contains %s', async (_kind, dynamic) => {
    const { capture, renderer, requested } = fixture({ markup: richHtml().replace(end, dynamic + end) })
    try {
      const { snapshot } = await capture.capture(url)
      expectBrowser(snapshot, renderer)
      expect(requested).toEqual([url])
    } finally { await capture.dispose() }
  })

  it.each([
    ['root display none', html => html.replace('<article>', '<article style="display:none">')],
    ['ancestor visibility hidden', html => html.replace('<body>', '<body style="visibility:hidden">')],
    ['root loading state', html => html.replace('<article>', '<article data-loading>')],
    ['ancestor loading state', html => html.replace('<body>', '<body data-loading>')],
  ])('falls back when %s prevents static visibility verification', async (_kind, transform) => {
    const { capture, renderer, requested } = fixture({ markup: transform(richHtml()) })
    try {
      const { snapshot } = await capture.capture(url)
      expectBrowser(snapshot, renderer)
      expect(requested).toEqual([url])
    } finally { await capture.dispose() }
  })

  it('lets the browser handle a static 403 decision', async () => {
    const { capture, renderer, requested } = fixture({ response: { statusCode: 403 } })
    try { const { snapshot } = await capture.capture(url); expectBrowser(snapshot, renderer); expect(requested).toEqual([url]) }
    finally { await capture.dispose() }
  })

  it.each([[404, 'article-not-found'], [429, 'article-rate-limit'], [500, 'article-server'], [503, 'article-server']])('preserves HTTP %s as %s without browser fallback', async (statusCode, code) => {
    const { capture, renderer } = fixture({ response: { statusCode } })
    try { await expect(capture.capture(url)).rejects.toMatchObject({ code }); expect(renderer.render).not.toHaveBeenCalled() }
    finally { await capture.dispose() }
  })

  it.each(['article-network', 'article-timeout', 'article-url-blocked', 'article-interrupted', 'article-unsupported'])('preserves %s from the static request without browser fallback', async code => {
    const { capture, renderer } = fixture({ request: async () => { throw failure(code) } })
    try { await expect(capture.capture(url)).rejects.toMatchObject({ code }); expect(renderer.render).not.toHaveBeenCalled() }
    finally { await capture.dispose() }
  })

  it.each([
    ['subscription', 'article-restricted', html => html.replace('</head>', '<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script></head>').replace(end, '<div class="gate metering__paywall-container"></div>' + end)],
    ['login', 'article-login', html => html.replaceAll('Static report', 'Sign in').replace(end, '<div class="gate"><input type="password"></div>' + end)],
  ])('checks the original %s gate before applying an exclusion', async (_kind, code, transform) => {
    const { capture, renderer } = fixture({ markup: transform(richHtml()), adapter: { excludeSelector: '.gate' } })
    try { await expect(capture.capture(url)).rejects.toMatchObject({ code }); expect(renderer.render).not.toHaveBeenCalled() }
    finally { await capture.dispose() }
  })

  it.each([
    ['byte', { maxArticleHtmlBytes: 1000, maxArticleHtmlChars: 4000 }],
    ['character', { maxArticleHtmlBytes: 4000, maxArticleHtmlChars: 1000 }],
  ])('falls back without enlarging the configured HTML %s budget', async (_kind, overrides) => {
    const markup = richHtml().replace('</head>', '<!--' + 'x'.repeat(1500) + '--></head>')
    const { capture, renderer, calls } = fixture({ markup, overrides })
    try {
      const { snapshot } = await capture.capture(url)
      expectBrowser(snapshot, renderer)
      expect(calls[0].options.maxBytes).toBe(overrides.maxArticleHtmlBytes)
    } finally { await capture.dispose() }
  })

  it('keeps failed static image bytes charged when falling back to the browser', async () => {
    const budget = 100, received = []
    const { capture, renderer, requested } = fixture({ renderedMarkup: richHtml(), overrides: { maxImageBytes: budget, maxTotalImageBytes: budget }, imageRequest: async target => {
      const bytes = received.length ? png : Buffer.alloc(budget)
      received.push(bytes.length)
      return { url: target, statusCode: 200, mime: 'image/png', headers: { 'content-type': 'image/png' }, bytes }
    } })
    try {
      const { snapshot, assets } = await capture.capture(url)
      expect(renderer.render).toHaveBeenCalledTimes(1)
      expect(received.reduce((total, bytes) => total + bytes, 0)).toBeLessThanOrEqual(budget)
      expect(requested.filter(target => target === imageUrl)).toHaveLength(1)
      expect(assets).toHaveLength(0)
      expect(snapshot.blocks.some(block => block.type === 'paragraph' && block.inline.some(run => run.text === 'First verified static paragraph.'))).toBe(true)
      expect(snapshot.assets).toHaveLength(1)
      expect(snapshot.assets[0]).toMatchObject({ status: 'failed', error: 'image-byte-limit', sourceUrl: imageUrl })
      expect(snapshot.quality.status).toBe('partial')
      expect(snapshot.quality.checks).toContain('rendered-dom')
      expect(snapshot.quality.checks).not.toContain('static-site-verified')
    } finally { await capture.dispose() }
  })

  it.each(['abort', 'dispose'])('owns an in-flight static request until it settles after %s', async action => {
    const entered = deferred(), release = deferred(), controller = new AbortController()
    let requestSignal, finished = false
    const { capture, renderer, requested } = fixture({ request: async (_target, options) => {
      requestSignal = options.signal; entered.resolve()
      await release.promise
      finished = true
      return htmlResponse(richHtml())
    } })
    let operation, disposing
    try {
      operation = capture.capture(url, { signal: controller.signal }).then(value => ({ value }), error => ({ error }))
      await Promise.race([entered.promise, operation.then(() => { throw new Error('Capture settled without its static request') })])
      if (action === 'abort') controller.abort()
      let disposed = false
      disposing = capture.dispose().then(() => { disposed = true; expect(finished).toBe(true) })
      expect(requestSignal.aborted).toBe(true)
      await Promise.resolve(); await Promise.resolve()
      expect(disposed).toBe(false)
      release.resolve()
      expect((await operation).error).toMatchObject({ code: 'article-interrupted' })
      await disposing
      expect(renderer.render).not.toHaveBeenCalled()
      expect(requested).toEqual([url])
    } finally {
      release.resolve()
      await Promise.allSettled([operation, disposing].filter(Boolean))
      await capture.dispose()
    }
  })
})
