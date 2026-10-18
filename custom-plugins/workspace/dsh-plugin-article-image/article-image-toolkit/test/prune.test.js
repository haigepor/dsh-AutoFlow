/** Pre-serialization pruning must shrink page scaffolding without changing the extracted article. */
import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { pruneDocument } from '../src/prune.js'
import { extractArticle } from '../src/articles.js'
import { resolveConfig } from '../src/config.js'

const config = resolveConfig({})
const pageOf = content => ({ url: 'https://example.com/a', statusCode: 200, truncated: false, body: { kind: 'html', content } })
const item = { url: 'https://example.com/a', language: '' }

const pruneToHtml = html => {
  const document = new JSDOM(html).window.document
  pruneDocument(document)
  return document.documentElement.outerHTML
}

describe('pruneDocument', () => {
  it('removes display:none, hidden and aria-hidden subtrees but keeps visibility:hidden content', () => {
    const document = new JSDOM(`<body><div style="display:none">inline hidden</div><div style="visibility:hidden">hidden body text</div>
      <div hidden>attribute hidden</div><div aria-hidden="true">screen-reader hidden</div>
      <span aria-hidden="true" class="fallback-image">formula</span><p>kept</p></body>`).window.document
    pruneDocument(document)
    const text = document.body.textContent
    expect(text).not.toContain('inline hidden')
    // 页面在加载后隐藏正文容器（付费墙/延迟渲染）；删掉它会丢掉整篇正文。
    expect(text).toContain('hidden body text')
    expect(text).not.toContain('attribute hidden')
    expect(text).not.toContain('screen-reader hidden')
    expect(text).toContain('formula')
    expect(text).toContain('kept')
  })

  it('keeps a large article body hidden only by visibility', () => {
    const body = Array.from({ length: 40 }, (_, index) => `<p>Hidden article paragraph ${index + 1} carrying the real story text.</p>`).join('')
    const document = new JSDOM(`<body><article><div class="container j-paywall" data-paywall-box style="visibility: hidden">${body}</div></article></body>`).window.document
    pruneDocument(document)
    expect(document.querySelector('.j-paywall')).not.toBeNull()
    expect(document.body.textContent).toContain('Hidden article paragraph 40')
  })

  it('removes unlikely candidates but keeps the tag and name exceptions', () => {
    const document = new JSDOM(`<body><div class="sidebar-widget">side</div><div id="comments">c</div>
      <div class="comment-article">kept by name</div><a class="sidebar-link" href="/x">anchor kept</a>
      <div class="related">related</div><table><tr><td><div class="related-cell">in table</div></td></tr></table>
      <div class="main-content">main</div></body>`).window.document
    pruneDocument(document)
    const text = document.body.textContent
    expect(text).not.toContain('side')
    expect(text).not.toContain('c</div>')
    expect(document.querySelector('#comments')).toBeNull()
    expect(text).toContain('kept by name')
    expect(text).toContain('anchor kept')
    expect(document.querySelector('.related')).toBeNull()
    expect(text).toContain('in table')
    expect(text).toContain('main')
  })

  it('removes unlikely roles and modal dialogs', () => {
    const document = new JSDOM(`<body><div role="navigation">nav</div><div role="complementary">aside</div>
      <div role="alert">alert</div><div aria-modal="true" role="dialog">modal</div><div role="dialog">dialog role</div>
      <div role="region">region kept</div></body>`).window.document
    pruneDocument(document)
    const text = document.body.textContent
    expect(text).not.toContain('nav')
    expect(text).not.toContain('aside')
    expect(text).not.toContain('alert')
    expect(text).not.toContain('modal')
    expect(text).not.toContain('dialog role')
    expect(text).toContain('region kept')
  })

  it('removes empty containers only for the tags Readability checks', () => {
    const document = new JSDOM(`<body><div></div><div><br></div><section></section><h2></h2>
      <span></span><p></p><div>text</div></body>`).window.document
    pruneDocument(document)
    expect(document.body.children).toHaveLength(3)
    expect(document.querySelector('span')).not.toBeNull()
    expect(document.querySelector('p')).not.toBeNull()
    expect(document.body.textContent).toContain('text')
  })

  it('strips inert assets while keeping gate markers and JSON-LD', () => {
    const html = `<html><head><title>T</title><script src="/app.js"></script>
      <script type="application/ld+json">{"headline":"T"}</script><style>.a{color:red}</style>
      <link rel="stylesheet" href="/a.css"></head><body><svg><circle></circle></svg><canvas></canvas>
      <template><p>template text</p></template><noscript><p>noscript text</p></noscript><img src="/x.png" alt="pic">
      <script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=1"></script>
      <div id="challenge-form" style="display:none"><input name="cf-turnstile-response"></div></body></html>`
    const document = new JSDOM(html).window.document
    pruneDocument(document)
    expect(document.querySelector('script[src="/app.js"]')).toBeNull()
    expect(document.querySelector('script[type="application/ld+json"]')).not.toBeNull()
    expect(document.querySelector('script[src*="/cdn-cgi/challenge-platform/"]')).not.toBeNull()
    expect(document.querySelector('style')).toBeNull()
    expect(document.querySelector('link')).toBeNull()
    expect(document.querySelector('svg')).toBeNull()
    expect(document.querySelector('canvas')).toBeNull()
    expect(document.querySelector('template')).toBeNull()
    expect(document.querySelector('noscript')).toBeNull()
    expect(document.querySelector('img')).not.toBeNull()
    expect(document.querySelector('#challenge-form')).not.toBeNull()
    expect(document.querySelector('[name="cf-turnstile-response"]')).not.toBeNull()
  })

  it('drops oversized attribute values while keeping short ones', () => {
    const document = new JSDOM(`<body><img src="data:image/png;base64,${'A'.repeat(900)}" alt="pic">
      <div class="article-note" data-state="${'b'.repeat(700)}" small="${'c'.repeat(400)}">kept</div></body>`).window.document
    pruneDocument(document)
    const img = document.querySelector('img')
    expect(img.getAttribute('src')).toBeNull()
    expect(img.getAttribute('alt')).toBe('pic')
    const note = document.querySelector('.article-note')
    expect(note.getAttribute('data-state')).toBeNull()
    expect(note.getAttribute('small')).toHaveLength(400)
    expect(note.textContent).toContain('kept')
  })

  it('keeps the extracted article identical while cutting scaffolding by an order of magnitude', () => {
    const paragraphs = Array.from({ length: 12 }, (_, index) => `<p>Paragraph number ${index + 1} with enough words to clear the extraction threshold comfortably.</p>`).join('')
    const noise = ['menu', 'sidebar', 'comments', 'footer', 'banner'].map(name =>
      Array.from({ length: 60 }, (_, index) => `<div class="${name}-${index}"><span>scaffolding text ${name} ${index} with some length</span></div>`).join('')).join('')
    const html = `<html lang="en"><head><title>Story</title><style>${'.a{color:red}'.repeat(2000)}</style></head><body>${noise}<div style="display:none">hidden marketing</div><article><h1>Story</h1>${paragraphs}</article></body></html>`

    const original = extractArticle(pageOf(html), item, config)
    const prunedHtml = pruneToHtml(html)
    const pruned = extractArticle(pageOf(prunedHtml), item, config)
    expect(pruned.title).toBe(original.title)
    expect(pruned.paragraphs).toEqual(original.paragraphs)
    expect(prunedHtml.length).toBeLessThan(html.length * 0.2)
  })
})
