/** Explicit embedded sources preserve parent order, public access decisions and bounded teardown. */
import { describe, expect, it } from 'vitest'
import { createCapture, resolveCaptureConfig } from '../src/capture.js'

const url = 'https://articles.example.test/report'
const storyUrl = 'https://stories.example.test/series/story.html'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVQImWP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64')
const storyRule = { selector: 'iframe.public-story', hosts: ['stories.example.test'], kind: 'story', rootSelector: 'main', pageSelector: '.story-page', excludeSelector: '.story-recommendations', pageIndexAttribute: 'data-slide' }
const parent = embeds => `<title>Parent report</title><article><p>Parent opening.</p>${embeds}<p>Parent ending.</p></article>`
const frame = source => `<iframe class="public-story" src="${source}"></iframe>`
const story = text => `<main><section class="story-page" data-slide="1"><p>${text}</p></section></main>`
const blockText = block => block.inline?.map(run => run.text).join('') ?? ''

function response(target, body, fields = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
  const mime = Buffer.isBuffer(body) ? 'image/png' : 'text/html'
  return { url: target, statusCode: 200, mime, headers: { 'content-type': mime }, bytes, ...fields }
}

function fixture({ markup = parent(frame(storyUrl)), routes = {}, embeddedSources = [storyRule], overrides = {}, request } = {}) {
  const requested = [], settings = resolveCaptureConfig({ minArticleChars: 1, adapters: [{ id: 'embedded-fixture-v1', hosts: ['articles.example.test'], articleSelector: 'article', embeddedSources }], ...overrides })
  const capture = createCapture(settings, {
    renderer: { render: async () => ({ html: markup, url, statusCode: 200, diagnostics: [] }), dispose: async () => {} },
    inspectImage: async () => ({ width: 2, height: 2, mime: 'image/png' }),
    request: async (target, options) => {
      requested.push(target)
      if (request) return request(target, options)
      if (!(target in routes)) throw new Error('Unexpected fixture request: ' + target)
      const value = routes[target]
      return typeof value === 'string' || Buffer.isBuffer(value) ? response(target, value) : value
    },
  })
  return { capture, requested }
}

function expectParent(snapshot) {
  const texts = snapshot.blocks.map(blockText)
  expect(texts).toContain('Parent opening.')
  expect(texts).toContain('Parent ending.')
  expect(texts.indexOf('Parent opening.')).toBeLessThan(texts.indexOf('Parent ending.'))
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

describe('explicit embedded article sources', () => {
  it('keeps parent identity and only uses same-origin published canonical source links', async () => {
    const child = '<title>Child title</title><link rel="canonical" href="/canonical"><main><section class="story-page" data-slide="1"><h1>Child headline</h1><p>Child facts.</p></section></main>'
    const { capture } = fixture({ routes: { [storyUrl]: child } })
    try {
      const { snapshot } = await capture.capture(url)
      expect(snapshot.title).toBe('Parent report')
      expect(snapshot.blocks.find(block => blockText(block) === 'Child headline')).toMatchObject({ type: 'heading', level: 2 })
      expect(snapshot.blocks.flatMap(block => block.inline ?? []).map(run => run.href)).toContain('https://stories.example.test/canonical')
    } finally { await capture.dispose() }
  })

  it('leaves unapproved hosts, missing story indices and hidden-only pages unresolved', async () => {
    const unknown = 'https://unapproved.example.test/story', gap = 'https://stories.example.test/gap', hidden = 'https://stories.example.test/hidden'
    const { capture, requested } = fixture({ markup: parent(frame(unknown) + frame(gap) + frame(hidden)), routes: {
      [gap]: '<main><section class="story-page" data-slide="2"><p>Incomplete sequence.</p></section></main>',
      [hidden]: '<main><section class="story-page" data-slide="1" aria-hidden="true"><p hidden>Hidden content must stay hidden.</p></section></main>',
    } })
    try {
      const { snapshot } = await capture.capture(url)
      expectParent(snapshot)
      expect(requested).toEqual([gap, hidden])
      expect(snapshot.quality.checks).not.toContain('embedded-story:1/1')
      expect(snapshot.quality.status).toBe('partial')
      expect(JSON.stringify(snapshot.blocks)).not.toMatch(/Incomplete sequence|Hidden content must stay hidden/)
    } finally { await capture.dispose() }
  })

  it('merges two story pages at the iframe position with nested lists, source links and original images', async () => {
    const firstImage = 'https://stories.example.test/photos/one-large.png', secondImage = 'https://stories.example.test/photos/two-original.png'
    const child = '<title>Public story</title><main><section class="story-page" data-slide="1"><h2>Page one</h2><p>First story paragraph. <a href="../evidence">Supporting evidence</a></p><ol><li>First choice<ul><li>Nested detail</li></ul></li></ol><figure><img src="../photos/one-small.png" srcset="../photos/one-small.png 300w, ../photos/one-large.png 1200w" alt="First story photo"><figcaption>First caption.</figcaption></figure><div class="story-recommendations"><p>Unrelated story promotion.</p></div></section><section class="story-page" data-slide="2" aria-hidden="true"><h2>Page two</h2><p>Second story paragraph.</p><p hidden>Hidden template noise.</p><figure><amp-img src="../photos/two-small.png" data-src="../photos/two-original.png" alt="Second story photo"></amp-img><figcaption>Second caption.</figcaption></figure></section></main>'
    const { capture, requested } = fixture({ routes: { [storyUrl]: child, [firstImage]: png, [secondImage]: png } }), events = []
    try {
      const { snapshot, assets } = await capture.capture(url, { onProgress: event => events.push(event) })
      expectParent(snapshot)
      const blocks = snapshot.blocks
      const positions = [
        blocks.findIndex(block => blockText(block) === 'Parent opening.'),
        blocks.findIndex(block => block.type === 'heading' && blockText(block) === 'Page one'),
        blocks.findIndex(block => blockText(block).startsWith('First story paragraph.')),
        blocks.findIndex(block => block.type === 'list'),
        blocks.findIndex(block => block.type === 'figure' && block.alt === 'First story photo'),
        blocks.findIndex(block => block.type === 'heading' && blockText(block) === 'Page two'),
        blocks.findIndex(block => blockText(block) === 'Second story paragraph.'),
        blocks.findIndex(block => block.type === 'figure' && block.alt === 'Second story photo'),
        blocks.findIndex(block => blockText(block) === 'Parent ending.'),
      ]
      for (const [index, position] of positions.entries()) { expect(position).toBeGreaterThanOrEqual(0); if (index) expect(position).toBeGreaterThan(positions[index - 1]) }
      expect(blocks.find(block => block.type === 'list').items[0].children[0].items[0].inline).toEqual([{ text: 'Nested detail' }])
      const hrefs = blocks.flatMap(block => block.inline ?? []).map(run => run.href).filter(Boolean)
      expect(hrefs).toContain(storyUrl)
      expect(hrefs).toContain('https://stories.example.test/evidence')
      expect(requested).toEqual(expect.arrayContaining([storyUrl, firstImage, secondImage]))
      expect(requested).toHaveLength(3)
      expect(blocks.filter(block => block.type === 'figure').map(block => block.caption)).toEqual(['First caption.', 'Second caption.'])
      expect(assets).toHaveLength(1)
      expect(assets[0].bytes).toEqual(png)
      expect(snapshot.assets[0].positions).toHaveLength(2)
      expect(JSON.stringify(blocks)).not.toMatch(/Unrelated story promotion|Hidden template noise/)
      expect(snapshot.quality.reasons).not.toContain('unsupported-graphic')
      expect(events.find(event => event.event === 'embedded-source-complete')).toMatchObject({ phase: 'extracting', completed: 2, total: 2, details: { origin: 'https://stories.example.test', code: 'story' } })
    } finally { await capture.dispose() }
  })

  it('does not fetch unconfigured iframes and keeps videos partial with only public metadata and a nonempty cover', async () => {
    const video = 'https://videos.example.test/watch/public', emptyVideo = 'https://videos.example.test/watch/no-cover', unknown = 'https://unknown.example.test/embed', cover = 'https://videos.example.test/covers/public.png'
    const markup = parent(`<iframe src="${unknown}"></iframe><iframe class="public-video" src="${video}"></iframe><iframe class="public-video" src="${emptyVideo}"></iframe>`)
    const metadata = '<meta property="og:title" content="Public video title"><meta property="og:description" content="Public video summary"><meta property="og:image" content="/covers/public.png"><body><p>Internal player shell text.</p></body>'
    const noCover = '<meta property="og:title" content="Video without a cover"><meta property="og:description" content="Another public video summary"><meta property="og:image" content=""><body><p>Other player internals.</p></body>'
    const rule = { selector: 'iframe.public-video', hosts: ['videos.example.test'], kind: 'video', rootSelector: 'body' }
    const { capture, requested } = fixture({ markup, embeddedSources: [rule], routes: { [video]: metadata, [emptyVideo]: noCover, [cover]: png } })
    try {
      const { snapshot } = await capture.capture(url)
      expectParent(snapshot)
      expect(requested).not.toContain(unknown)
      expect(requested).toEqual(expect.arrayContaining([video, emptyVideo, cover]))
      expect(requested).toHaveLength(3)
      expect(JSON.stringify(snapshot.blocks)).toMatch(/Public video title/)
      expect(JSON.stringify(snapshot.blocks)).toMatch(/Public video summary/)
      expect(JSON.stringify(snapshot.blocks)).not.toMatch(/Internal player shell text|Other player internals/)
      expect(snapshot.assets).toHaveLength(1)
      expect(snapshot.assets[0]).toMatchObject({ status: 'ready', sourceUrl: cover })
      expect(snapshot.quality.status).toBe('partial')
      expect(snapshot.quality.reasons).toContain('unsupported-graphic')
    } finally { await capture.dispose() }
  })

  it('retains the parent without importing refused or subscription-only child content', async () => {
    const refused = 'https://stories.example.test/refused', restricted = 'https://stories.example.test/restricted'
    const restrictedHtml = '<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script><main><section class="story-page" data-slide="1"><p>Subscriber teaser must not be merged.</p><div class="metering__paywall-container"></div></section></main>'
    const { capture } = fixture({ markup: parent(frame(refused) + frame(restricted)), routes: { [refused]: response(refused, story('Refused child must not be merged.'), { statusCode: 403 }), [restricted]: restrictedHtml } })
    try {
      const { snapshot } = await capture.capture(url)
      expectParent(snapshot)
      expect(JSON.stringify(snapshot.blocks)).not.toMatch(/Subscriber teaser must not be merged|Refused child must not be merged/)
      expect(snapshot.quality.status).toBe('partial')
    } finally { await capture.dispose() }
  })

  it('refuses a cross-origin child response URL without changing the parent content', async () => {
    const { capture, requested } = fixture({ routes: { [storyUrl]: response('https://other.example.test/redirected', story('Cross-origin child text must not be merged.')) } })
    try {
      const { snapshot } = await capture.capture(url)
      expectParent(snapshot)
      expect(requested).toEqual([storyUrl])
      expect(JSON.stringify(snapshot.blocks)).not.toContain('Cross-origin child text must not be merged.')
      expect(snapshot.quality.status).toBe('partial')
    } finally { await capture.dispose() }
  })

  it('applies one cumulative HTML budget to child sources while retaining the accepted first source', async () => {
    const first = 'https://stories.example.test/first', second = 'https://stories.example.test/second'
    const firstText = 'First public story content. '.repeat(45), secondText = 'Second public story content. '.repeat(45)
    const firstHtml = story(firstText), secondHtml = story(secondText)
    expect(Buffer.byteLength(firstHtml)).toBeLessThan(2000)
    expect(Buffer.byteLength(secondHtml)).toBeLessThan(2000)
    expect(Buffer.byteLength(firstHtml + secondHtml)).toBeGreaterThan(2000)
    const { capture } = fixture({ markup: parent(frame(first) + frame(second)), routes: { [first]: firstHtml, [second]: secondHtml }, overrides: { maxArticleHtmlBytes: 2000, maxArticleHtmlChars: 2000 } })
    try {
      const { snapshot } = await capture.capture(url)
      expectParent(snapshot)
      expect(JSON.stringify(snapshot.blocks)).toContain('First public story content.')
      expect(JSON.stringify(snapshot.blocks)).not.toContain('Second public story content.')
      expect(snapshot.quality.status).toBe('partial')
    } finally { await capture.dispose() }
  })

  it('does not request child sources beyond maxEmbeddedSources and keeps the excess unresolved', async () => {
    const first = 'https://stories.example.test/first', second = 'https://stories.example.test/second'
    const { capture, requested } = fixture({ markup: parent(frame(first) + frame(second)), routes: { [first]: story('Accepted first public story.'), [second]: story('Excess second public story.') }, overrides: { maxEmbeddedSources: 1 } })
    try {
      const { snapshot } = await capture.capture(url)
      expectParent(snapshot)
      expect(requested).toEqual([first])
      expect(JSON.stringify(snapshot.blocks)).toContain('Accepted first public story.')
      expect(JSON.stringify(snapshot.blocks)).not.toContain('Excess second public story.')
      expect(snapshot.quality.status).toBe('partial')
    } finally { await capture.dispose() }
  })

  it.each(['abort', 'dispose'])('keeps an in-flight child request owned until it settles after %s', async action => {
    const entered = deferred(), release = deferred(), controller = new AbortController()
    let childSignal, requestFinished = false
    const { capture, requested } = fixture({ request: async (target, options) => {
      childSignal = options.signal; entered.resolve()
      await release.promise
      requestFinished = true
      return response(target, story('Late child content must not be published.'))
    } })
    let operation, disposing
    try {
      operation = capture.capture(url, { signal: controller.signal }).then(value => ({ value }), error => ({ error }))
      await Promise.race([entered.promise, operation.then(() => { throw new Error('Capture settled without starting its configured child request') })])
      if (action === 'abort') controller.abort()
      let disposed = false
      disposing = capture.dispose().then(() => { disposed = true; expect(requestFinished).toBe(true) })
      expect(childSignal.aborted).toBe(true)
      await Promise.resolve(); await Promise.resolve()
      expect(disposed).toBe(false)
      release.resolve()
      expect((await operation).error).toMatchObject({ code: 'article-interrupted' })
      await disposing
      expect(requested).toEqual([storyUrl])
      expect(requestFinished).toBe(true)
    } finally {
      release.resolve()
      await Promise.allSettled([operation, disposing].filter(Boolean))
      await capture.dispose()
    }
  })
})
