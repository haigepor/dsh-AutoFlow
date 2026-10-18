/** Explicit public captions preserve source placement, bounded text and capture ownership. */
import { test, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { createCapture, resolveCaptureConfig } from '../src/capture.js'
import { captureEmbeds } from '../src/capture-embeds.js'
import { CookieJar } from '../src/session.js'

const url = 'https://articles.example.test/report'
const captionUrl = 'https://captions.example.test/published.vtt'
const imageUrl = 'https://articles.example.test/original.png'
const rule = { selector: 'video track', hosts: ['captions.example.test'] }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVQImWP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64')
const track = (source = captionUrl, kind = 'subtitles') => `<track kind="${kind}" src="${source}" srclang="en">`
const video = tracks => `<video controls>${tracks}</video>`
const parent = embeds => `<title>Parent report</title><article><p>Parent opening.</p><ol><li>First choice<ul><li>Nested detail.</li></ul></li></ol>${embeds}<figure><img src="${imageUrl}" alt="Published original"><figcaption>Original caption.</figcaption></figure><p>Parent ending.</p></article>`
const vtt = text => `WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n${text}\n`
const textOf = block => block.inline?.map(run => run.text).join('') ?? ''
function response(target, body, fields = {}) { return { url: target, statusCode: 200, mime: 'text/vtt', headers: { 'content-type': 'text/vtt; charset=utf-8' }, bytes: Buffer.from(body, 'utf8'), ...fields } }

async function direct(t, { markup = parent(video(track())), routes = {}, overrides = {}, request, siteFields = {} } = {}) {
  const dom = new JSDOM(markup, { url })
  t.onTestFinished(() => dom.window.close())
  const document = dom.window.document, root = document.querySelector('article'), requested = []
  const config = { ...resolveCaptureConfig({ minArticleChars: 1 }), maxCaptionCues: 2000, ...overrides }
  const result = await captureEmbeds({ document, root, url, html: markup, site: { captionSources: [rule], ...siteFields }, config, jar: new CookieJar(), signal: new AbortController().signal,
    inspectGates() {}, onProgress: async () => {}, request: async (target, options) => {
      requested.push(target)
      if (request) return request(target, options)
      if (!(target in routes)) throw new Error('Unexpected caption request')
      return typeof routes[target] === 'string' ? response(target, routes[target]) : routes[target]
    } })
  return { result, requested, root }
}

function captureFixture(t, { markup = parent(video(track())), body = vtt('Published spoken facts.'), overrides = {}, request } = {}) {
  const requested = [], settings = resolveCaptureConfig({ minArticleChars: 1, adapters: [{ id: 'caption-fixture-v1', hosts: ['articles.example.test'], articleSelector: 'article', captionSources: [rule] }], ...overrides })
  const capture = createCapture(settings, {
    renderer: { render: async () => ({ html: markup, url, statusCode: 200, diagnostics: [] }), dispose: async () => {} },
    inspectImage: async () => ({ width: 2, height: 2, mime: 'image/png' }),
    request: async (target, options) => {
      requested.push(target)
      if (request) return request(target, options)
      if (target === imageUrl) return { url: target, statusCode: 200, mime: 'image/png', headers: {}, bytes: png }
      if (target === captionUrl) return response(target, body)
      throw new Error('Unexpected capture request')
    },
  })
  t.onTestFinished(() => capture.dispose())
  return { capture, requested }
}

test('a declared subtitle track is fetched and inserted at the video position without requiring schema resolution', async t => {
  const { root, requested } = await direct(t, { routes: { [captionUrl]: vtt('Public subtitle facts.') } })
  expect(requested).toEqual([captionUrl])
  expect(root.textContent).toContain('Public subtitle facts.')
  expect(root.querySelector(`a[href="${captionUrl}"]`)).not.toBeNull()
  expect(root.textContent.indexOf('Parent opening.')).toBeLessThan(root.textContent.indexOf('Public subtitle facts.'))
  expect(root.textContent.indexOf('Public subtitle facts.')).toBeLessThan(root.textContent.indexOf('Original caption.'))
  expect(root.textContent.indexOf('Public subtitle facts.')).toBeLessThan(root.textContent.indexOf('Parent ending.'))
  expect(root.querySelector('video')).not.toBeNull()
})

test('a visible player may declare captions on its visibility-hidden native video without exposing hidden ancestor content', async t => {
  const hidden = 'https://captions.example.test/hidden-container.vtt'
  const markup = parent(`<div class="player"><video style="visibility:hidden">${track()}</video></div><div style="visibility:hidden">${video(track(hidden))}</div>`)
  const { root, requested } = await direct(t, { markup, routes: { [captionUrl]: vtt('Public captions of the visible player.') } })
  expect(requested).toEqual([captionUrl])
  expect(root.textContent).toContain('Public captions of the visible player.')
})

test('capture retains parent text, nested lists and original bytes while adding timed source-linked captions and remaining partial', async t => {
  expect(resolveCaptureConfig().maxCaptionCues).toBe(2000)
  const { capture, requested } = captureFixture(t)
  const { snapshot, assets } = await capture.capture(url)
  const text = snapshot.blocks.map(textOf).join('\n')
  expect(text).toContain('Parent opening.'); expect(text).toContain('Parent ending.')
  expect(text).toContain('Published spoken facts.')
  expect(text).toContain('00:00:01.000'); expect(text).toContain('00:00:02.500')
  expect(text.indexOf('Parent opening.')).toBeLessThan(text.indexOf('Published spoken facts.'))
  expect(text.indexOf('Published spoken facts.')).toBeLessThan(text.indexOf('Parent ending.'))
  const cueIndex = snapshot.blocks.findIndex(block => textOf(block).includes('Published spoken facts.'))
  expect(snapshot.blocks.findIndex(block => block.type === 'list')).toBeLessThan(cueIndex)
  expect(cueIndex).toBeLessThan(snapshot.blocks.findIndex(block => block.type === 'figure'))
  expect(snapshot.blocks.find(block => block.type === 'list').items[0].children[0].items[0].inline).toEqual([{ text: 'Nested detail.' }])
  expect(snapshot.blocks.flatMap(block => block.inline ?? []).map(run => run.href)).toContain(captionUrl)
  expect(snapshot.blocks.find(block => block.type === 'figure')).toMatchObject({ alt: 'Published original', caption: 'Original caption.' })
  expect(assets).toHaveLength(1); expect(assets[0].bytes).toEqual(png)
  expect(requested).toEqual(expect.arrayContaining([captionUrl, imageUrl]))
  expect(snapshot.quality.status).toBe('partial')
  expect(snapshot.quality.reasons).toContain('unsupported-graphic')
})

test('only declared subtitle or caption tracks outside hidden and advertising containers are requested', async t => {
  const accepted = 'https://captions.example.test/captions.vtt'
  const markup = parent(video(track(captionUrl) + track(accepted, 'captions') + track('https://captions.example.test/thumbs.vtt', 'thumbnails') + track('https://captions.example.test/metadata.vtt', 'metadata') + track('https://unapproved.example.test/secret.vtt'))
    + `<div hidden>${video(track('https://captions.example.test/hidden.vtt'))}</div><aside>${video(track('https://captions.example.test/aside.vtt'))}</aside><div data-ad>${video(track('https://captions.example.test/ad.vtt'))}</div><div class="excluded">${video(track('https://captions.example.test/excluded.vtt'))}</div><video aria-label="Advertisement">${track('https://captions.example.test/player-ad.vtt')}</video>`)
  const { requested, root } = await direct(t, { markup, siteFields: { excludeSelector: '.excluded' }, routes: { [captionUrl]: vtt('Subtitles accepted.'), [accepted]: vtt('Captions accepted.') } })
  expect(requested).toEqual([captionUrl, accepted])
  expect(root.textContent).toContain('Subtitles accepted.'); expect(root.textContent).toContain('Captions accepted.')
})

test('a CSS advertisement cannot consume the only caption source slot before the published video', async t => {
  const ad = 'https://captions.example.test/advertisement.vtt'
  const markup = parent(`<div class="advertisement">${video(track(ad))}</div>${video(track())}`)
  const { requested, root } = await direct(t, { markup, overrides: { maxEmbeddedSources: 1 }, routes: { [ad]: vtt('Unrelated advertising words.'), [captionUrl]: vtt('Published main video facts.') } })
  expect(requested).toEqual([captionUrl])
  expect(root.textContent).toContain('Published main video facts.')
  expect(root.textContent).not.toContain('Unrelated advertising words.')
})

test('the shared element budget counts the caption section, source paragraph, source anchor and cue paragraph', async t => {
  const markup = parent(video(track()) + '<span></span>'.repeat(100)), initial = new JSDOM(markup)
  const originalElements = initial.window.document.getElementsByTagName('*').length
  initial.window.close()
  const { requested, root, result } = await direct(t, { markup, overrides: { maxArticleElements: originalElements + 3 }, routes: { [captionUrl]: vtt('A four-element caption projection must not fit.') } })
  expect(requested).toEqual([captionUrl])
  expect(root.textContent).not.toContain('A four-element caption projection must not fit.')
  expect(root.querySelector(`a[href="${captionUrl}"]`)).toBeNull()
  expect(result.reasons.size).toBeGreaterThan(0)
})

test('WebVTT cue ids, settings and markup never import NOTE, STYLE, REGION or executable markup as article text', async t => {
  const body = '\uFEFFWEBVTT published English subtitles\n\nNOTE private annotation\nUnrelated note content.\n\nSTYLE\n::cue { color: lime; }\n\nREGION\nid:region-1\nwidth:40%\n\nreporter-1\n00:00:01.000 --> 00:00:02.500 align:start\n<v Reporter><b>First</b> &amp; &lt;fact&gt;</v>\nSecond line.\n\n00:03.000 --> 00:04.000\n<c.editorial>Next public cue.</c>\n'
  const { root, requested } = await direct(t, { routes: { [captionUrl]: body } })
  expect(requested).toEqual([captionUrl])
  expect(root.textContent).toContain('First & <fact>')
  expect(root.textContent).toContain('Second line.'); expect(root.textContent).toContain('Next public cue.')
  expect(root.textContent).not.toMatch(/private annotation|Unrelated note|color: lime|region-1|width:40|reporter-1|align:start/)
  expect(root.querySelector('script,v,c')).toBeNull()
})

test('refused or malformed caption files never publish an accepted prefix as a partial transcript', async t => {
  const prefix = vtt('Prefix must not be imported.')
  const invalid = [
    response(captionUrl, prefix, { statusCode: 403 }),
    response(captionUrl, prefix, { mime: 'text/html', headers: { 'content-type': 'text/html' } }),
    response(captionUrl, '00:00:01.000 --> 00:00:02.000\nMissing WebVTT header.\n'),
    response(captionUrl, prefix + '\n00:xx:03.000 --> 00:00:04.000\nMalformed timing.\n'),
    response(captionUrl, prefix + '\n00:00:05.000 --> 00:00:04.000\nEnd before start.\n'),
    response(captionUrl, prefix + '\n00:00:03.000 --> 00:00:04.000\n\n'),
  ]
  for (const value of invalid) {
    const { root, requested, result } = await direct(t, { routes: { [captionUrl]: value } })
    expect(requested).toEqual([captionUrl])
    expect(root.textContent).not.toMatch(/Prefix must not be imported|Malformed timing|End before start|Missing WebVTT/)
    expect(root.textContent).toContain('Parent opening.'); expect(root.textContent).toContain('Parent ending.')
    expect(result.reasons.size).toBeGreaterThan(0)
  }
})

test('the cue count budget rejects the whole oversized caption source without truncating its last cue', async t => {
  const body = vtt('First cue must not leak.') + '\n00:00:03.000 --> 00:00:04.000\nSecond excess cue.\n'
  const { root, requested, result } = await direct(t, { routes: { [captionUrl]: body }, overrides: { maxCaptionCues: 1 } })
  expect(requested).toEqual([captionUrl])
  expect(root.textContent).not.toMatch(/First cue must not leak|Second excess cue/)
  expect(result.reasons.size).toBeGreaterThan(0)
})

test('caption sources share the parent character budget and retain an accepted source when the next would exceed it', async t => {
  const second = 'https://captions.example.test/second.vtt'
  const firstText = 'Accepted caption words. '.repeat(25), secondText = 'Excess caption words. '.repeat(25)
  const { root, requested, result } = await direct(t, { markup: parent(video(track() + track(second))), overrides: { maxArticleChars: 1000 }, routes: { [captionUrl]: vtt(firstText), [second]: vtt(secondText) } })
  expect(requested).toEqual([captionUrl, second])
  expect(root.textContent).toContain('Accepted caption words.')
  expect(root.textContent).not.toContain('Excess caption words.')
  expect(root.textContent).toContain('Parent ending.')
  expect(result.reasons.size).toBeGreaterThan(0)
})

for (const action of ['abort', 'dispose']) test(`caption request remains owned until it settles after ${action}`, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), controller = new AbortController()
  let childSignal, requestFinished = false
  const { capture, requested } = captureFixture(t, { request: async (target, options) => {
    if (target === imageUrl) return { url: target, statusCode: 200, mime: 'image/png', headers: {}, bytes: png }
    childSignal = options.signal; entered.resolve(); await release.promise; requestFinished = true
    return response(target, vtt('Late captions must not be published.'))
  } })
  let operation, disposing
  try {
    operation = capture.capture(url, { signal: controller.signal }).then(value => ({ value }), error => ({ error }))
    await Promise.race([entered.promise, operation.then(() => { throw new Error('Capture settled without starting its declared caption request') })])
    if (action === 'abort') controller.abort()
    let disposed = false
    disposing = capture.dispose().then(() => { disposed = true; expect(requestFinished).toBe(true) })
    expect(childSignal.aborted).toBe(true)
    await Promise.resolve(); await Promise.resolve()
    expect(disposed).toBe(false)
    release.resolve()
    expect((await operation).error).toMatchObject({ code: 'article-interrupted' })
    await disposing
    expect(requested).toEqual([captionUrl]); expect(requestFinished).toBe(true)
  } finally { release.resolve(); await Promise.allSettled([operation, disposing].filter(Boolean)); await capture.dispose() }
})
