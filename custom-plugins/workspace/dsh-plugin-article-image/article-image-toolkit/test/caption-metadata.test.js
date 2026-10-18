/** Exact current-article metadata can supply declared captions without selecting recommendations. */
import { test, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { createCapture, resolveCaptureConfig } from '../src/capture.js'
import { captureEmbeds } from '../src/capture-embeds.js'
import { CookieJar } from '../src/session.js'

const url = 'https://articles.example.test/report'
const captionUrl = 'https://captions.example.test/published.vtt'
const metadata = { globalPath: ['Fusion', 'globalContent'], identityPath: ['canonical_url'], tracksPath: ['subtitles', 'urls'], formatKey: 'format', formatValue: 'WEB_VTT', urlKey: 'url', anchorSelector: '.wrapper-video', language: 'pt-br' }
const rule = { selector: 'video track', hosts: ['captions.example.test'], metadata }
const declaration = { ruleIndex: 0, identity: url, sources: [captionUrl] }
const video = '<div class="wrapper-video"><video controls></video></div>'
const parent = inner => `<title>Current report</title><article><p>Parent opening.</p>${inner}<p>Parent ending.</p></article>`
const vtt = Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nCurrent article spoken facts.\n', 'utf8')
const response = target => ({ url: target, statusCode: 200, mime: 'text/vtt', headers: { 'content-type': 'text/vtt' }, bytes: vtt })

async function direct(t, { markup = parent(video), declarations = [declaration] } = {}) {
  const dom = new JSDOM(markup, { url }), requested = []
  t.onTestFinished(() => dom.window.close())
  const document = dom.window.document, root = document.querySelector('article')
  const result = await captureEmbeds({ document, root, url, html: markup, site: { captionSources: [rule] }, config: resolveCaptureConfig({ minArticleChars: 1 }),
    captionDeclarations: declarations, jar: new CookieJar(), signal: new AbortController().signal, inspectGates() {}, onProgress: async () => {},
    request: async target => { requested.push(target); return response(target) } })
  return { root, result, requested }
}

test('declared metadata captions enter the direct embed pipeline even when the video exposes no DOM track', async t => {
  const { root, requested } = await direct(t)
  expect(root.querySelectorAll('track')).toHaveLength(0)
  expect(requested).toEqual([captionUrl])
  expect(root.textContent).toContain('Current article spoken facts.')
  expect(root.querySelector(`a[href="${captionUrl}"]`)).not.toBeNull()
  expect(root.textContent.indexOf('Parent opening.')).toBeLessThan(root.textContent.indexOf('Current article spoken facts.'))
  expect(root.textContent.indexOf('Current article spoken facts.')).toBeLessThan(root.textContent.indexOf('Parent ending.'))
})

test('createCapture consumes renderer declarations for the current article and retains unresolved video quality', async t => {
  const config = resolveCaptureConfig({ minArticleChars: 1, adapters: [{ id: 'metadata-caption-fixture-v1', hosts: ['articles.example.test'], articleSelector: 'article', captionSources: [rule] }] })
  const requested = [], capture = createCapture(config, {
    renderer: { render: async () => ({ html: parent(video), url, statusCode: 200, diagnostics: [], captionDeclarations: [declaration] }), dispose: async () => {} },
    request: async target => { requested.push(target); return response(target) },
  })
  t.onTestFinished(() => capture.dispose())
  const { snapshot } = await capture.capture(url)
  expect(requested).toEqual([captionUrl])
  const texts = snapshot.blocks.flatMap(block => block.inline?.map(run => run.text) ?? [])
  expect(texts.join(' ')).toContain('Current article spoken facts.')
  expect(texts.join(' ')).toContain('Parent opening.'); expect(texts.join(' ')).toContain('Parent ending.')
  expect(snapshot.blocks.flatMap(block => block.inline ?? []).map(run => run.href)).toContain(captionUrl)
  expect(snapshot.quality.status).toBe('partial')
  expect(snapshot.quality.reasons).toContain('unsupported-graphic')
})

test('mismatched article identities, unknown hosts and ambiguous or hidden anchors cannot authorize caption requests', async t => {
  const denied = [
    { declarations: [{ ...declaration, identity: 'https://articles.example.test/recommended-report' }] },
    { declarations: [{ ...declaration, identity: 'https://recommended.example.test/report' }] },
    { declarations: [{ ...declaration, ruleIndex: 1 }] },
    { declarations: [{ ...declaration, sources: ['https://unapproved.example.test/secret.vtt'] }] },
    { markup: parent(video + video) },
    { markup: parent('<div hidden>' + video + '</div>') },
    { markup: parent('<div class="wrapper-video" style="visibility:hidden"><video></video></div>') },
    { markup: parent('<div class="advertisement">' + video + '</div>') },
  ]
  for (const input of denied) {
    const { root, requested } = await direct(t, input)
    expect(requested).toEqual([])
    expect(root.textContent).not.toContain('Current article spoken facts.')
    expect(root.textContent).toContain('Parent opening.'); expect(root.textContent).toContain('Parent ending.')
  }
})

test('a DOM track and an exact metadata declaration for the same subtitle URL produce only one transcript', async t => {
  const markup = parent(`<div class="wrapper-video"><video controls><track kind="subtitles" src="${captionUrl}"></video></div>`)
  const { root, requested } = await direct(t, { markup })
  expect(requested).toEqual([captionUrl])
  expect(root.textContent.match(/Current article spoken facts\./g)).toHaveLength(1)
  expect(root.querySelectorAll(`a[href="${captionUrl}"]`)).toHaveLength(1)
})

test('an article without a matching player does not acquire caption failure reasons from a site-wide rule', async t => {
  const { result, requested } = await direct(t, { markup: parent(''), declarations: [{ ruleIndex: 0, code: 'article-extraction', sources: [] }] })
  expect(requested).toEqual([])
  expect([...result.reasons]).toEqual([])
})

test('current-article poster metadata fills a single uninitialized player without replacing its published attributes', async t => {
  const poster = { url: 'https://images.example.test/current.jpg', title: 'Current report' }
  const metadataRule = { ...rule, metadata: { ...metadata, poster: { urlPath: ['promo_image', 'url'], titlePath: ['promo_image', 'caption'], hosts: ['images.example.test'] } } }
  const run = async (markup, declaredPoster) => {
    const dom = new JSDOM(markup, { url }); t.onTestFinished(() => dom.window.close())
    const document = dom.window.document, root = document.querySelector('article')
    await captureEmbeds({ document, root, url, html: markup, site: { captionSources: [metadataRule] }, config: resolveCaptureConfig({ minArticleChars: 1 }),
      captionDeclarations: [{ ...declaration, poster: declaredPoster }], jar: new CookieJar(), signal: new AbortController().signal, inspectGates() {}, onProgress: async () => {}, request: async target => response(target) })
    return root
  }
  const fresh = await run(parent(video), poster)
  expect(fresh.querySelector('video').getAttribute('poster')).toBe(poster.url)
  expect(fresh.querySelector('video').getAttribute('title')).toBe(poster.title)
  const existing = await run(parent('<div class="wrapper-video"><video poster="https://images.example.test/original.jpg" title="Original title"></video></div>'), poster)
  expect(existing.querySelector('video').getAttribute('poster')).toBe('https://images.example.test/original.jpg')
  expect(existing.querySelector('video').getAttribute('title')).toBe('Original title')
  const denied = await run(parent(video), { ...poster, url: 'https://unapproved.example.test/poster.jpg' })
  expect(denied.querySelector('video').hasAttribute('poster')).toBe(false)
  const duplicate = await run(parent(`<div class="wrapper-video"><video poster="${poster.url}"></video><div class="ima-ad-container"><video></video></div></div><img src="${poster.url}">`), poster)
  expect(duplicate.querySelector('video').getAttribute('title')).toBe(poster.title)
  expect(duplicate.querySelector('.ima-ad-container video').hasAttribute('poster')).toBe(false)
  expect(duplicate.querySelector('img').getAttribute('alt')).toBe(poster.title)
})

test('caption metadata paths reject prototype traversal while ordinary exact paths remain configurable', () => {
  const resolve = value => resolveCaptureConfig({ adapters: [{ id: 'metadata-caption-fixture-v1', hosts: ['articles.example.test'], articleSelector: 'article', captionSources: [{ ...rule, metadata: value }] }] })
  expect(() => resolve(metadata)).not.toThrow()
  for (const field of ['globalPath', 'identityPath', 'tracksPath']) for (const segment of ['__proto__', 'constructor']) {
    expect(() => resolve({ ...metadata, [field]: [segment] })).toThrow()
  }
})
