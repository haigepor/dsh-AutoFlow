/** Rich capture invariants and quality diagnostics independent of a browser binary. */
import { describe, it, expect } from 'vitest'
import { createCapture, resolveCaptureConfig } from '../src/capture.js'
import { hashSnapshot, blocksToParagraphs, snapshotSchema } from '../src/capture-contracts.js'
import { publicNetworkPolicy } from '../src/capture-media.js'

const url = 'https://articles.example.test/story'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVQImWP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64')
const html = `<html lang="zh-CN"><title>文章标题</title><body><nav>导航</nav><article><h1>文章标题</h1><p>正文的<strong>重要观点</strong>与<a href="javascript:alert(1)">危险链接</a>及<a href="/evidence">依据</a>。</p><h2>详情</h2><ul><li>一级<ul><li>二级</li></ul></li></ul><blockquote>引用观点</blockquote><table><tr><th>名称</th><th>数量</th></tr><tr><td>方案</td><td>3</td></tr></table><figure class="media"><picture><source srcset="/small.png 300w, /large.png?sig=a 1200w"><img src="/small.png" alt="场景"></picture><figcaption>说明 <span class="credit">摄影：作者</span></figcaption></figure><p>正文结束。</p><aside>推荐文章</aside></article><footer>页脚</footer></body></html>`

function fixtureCapture(markup = html, image = png, overrides = {}) {
  const requested = []
  const renderer = { readiness: async () => ({ available: true }), dispose: async () => {},
    async render() { return { html: markup, url, statusCode: 200, diagnostics: [] } } }
  const capture = createCapture(resolveCaptureConfig({ minArticleChars: 1, ...overrides }), { renderer,
    request: async target => { requested.push(target); return { bytes: image, statusCode: 200, mime: 'image/png', url: target } },
    inspectImage: async () => ({ width: 800, height: 600, mime: 'image/png' }) })
  return { capture, requested }
}

describe('rich article capture', () => {
  it('preserves image content negotiation while scoping anonymous cookies to the image destination', async () => {
    const calls = [], renderer = { render: async () => ({ html: '<article><p>Public reporting.</p><img src="https://photos.example.test/lead.png"></article>', url, statusCode: 200 }), dispose: async () => {} }
    const capture = createCapture(resolveCaptureConfig({ minArticleChars: 1 }), { renderer,
      jar: { header: target => target.startsWith('https://photos.example.test/') ? 'anonymous=photo-session' : '', store: () => {} },
      request: async (target, options) => { calls.push({ target, headers: options.headers }); return { bytes: png, statusCode: 200, mime: 'image/png', url: target } }, inspectImage: async () => ({ width: 800, height: 600 }) })
    try {
      await capture.capture(url)
      expect(calls).toEqual([{ target: 'https://photos.example.test/lead.png', headers: { referer: 'https://articles.example.test/', cookie: 'anonymous=photo-session' } }])
    } finally { await capture.dispose() }
  })

  it('excludes explicitly labelled advertisement blocks regardless of class capitalization', async () => {
    const { capture, requested } = fixtureCapture('<!doctype html><title>Report</title><article><p>Independent public reporting.</p><div class="FreeStar Advertisement"><img src="https://ads.example.test/video-cover.png"><p>Paid video promotion</p></div><div data-primis-wrapper="1"><img src="https://ads.example.test/player-cover.png"></div><iframe aria-label="Advertisement" title="3rd party ad content"></iframe></article>')
    try {
      const { snapshot } = await capture.capture(url)
      expect(requested).toEqual([])
      expect(JSON.stringify(snapshot.blocks)).not.toContain('Paid video promotion')
      expect(snapshot.quality.reasons).not.toContain('unsupported-graphic')
    } finally { await capture.dispose() }
  })

  it('ignores interaction SVG icons while retaining article paragraphs, the photo and its caption', async () => {
    const paragraphs = ['Opening facts from the public report.', 'Closing context from the public report.']
    const markup = `<title>Public report</title><article><p>${paragraphs[0]}</p><div class="fullScreenButton"><svg></svg></div><figure class="media"><img src="/reporting.png" alt="Reported scene"><figcaption class="responsive-img-caption"><svg><path d="M0 0h1"></path></svg>Published photo caption.</figcaption><div class="carousel-arrow" role="button" aria-label="Next photo"><svg><path d="M0 0h1"></path></svg></div></figure><a href="https://api.whatsapp.com/send?text=Public%20report" aria-label="Share report"><svg><path d="M0 0h1"></path></svg></a><p>${paragraphs[1]}</p></article>`
    const { capture, requested } = fixtureCapture(markup)
    try {
      const { snapshot } = await capture.capture(url)
      expect(snapshot.blocks.filter(block => block.type === 'paragraph').map(block => block.inline.map(run => run.text).join(''))).toEqual(paragraphs)
      expect(snapshot.blocks.filter(block => block.type === 'figure')).toMatchObject([{ alt: 'Reported scene', caption: 'Published photo caption.' }])
      expect(requested).toEqual(['https://articles.example.test/reporting.png'])
      expect(snapshot.quality.reasons).not.toContain('unsupported-graphic')
    } finally { await capture.dispose() }
  })

  it('excludes role-based control lists and empty control items while retaining a real nested editorial list', async () => {
    const paragraph = 'Public reporting includes the following editorial recommendations.'
    const markup = `<title>Public report</title><article><p>${paragraph}</p><ul role="toolbar"><li role="button"><a href="https://api.whatsapp.com/send?text=Public%20report">Share report</a></li></ul><ul class="vjs-menu-content" role="menu"><li class="vjs-menu-item" role="menuitemradio">Normal playback speed</li></ul><ul><li><button aria-label="Next slide"><svg></svg></button></li></ul><ul><li>First editorial recommendation<ol><li>Nested reporting detail</li></ol></li><li>Second editorial recommendation</li></ul><figure class="media"><img src="/reporting.png" alt="Reported scene"></figure></article>`
    const { capture, requested } = fixtureCapture(markup)
    try {
      const { snapshot } = await capture.capture(url)
      const lists = snapshot.blocks.filter(block => block.type === 'list')
      expect(lists).toHaveLength(1)
      expect(lists[0].items.map(item => item.inline.map(run => run.text).join(''))).toEqual(['First editorial recommendation', 'Second editorial recommendation'])
      expect(lists[0].items[0].children[0]).toMatchObject({ ordered: true, items: [{ inline: [{ text: 'Nested reporting detail' }] }] })
      expect(snapshot.blocks.filter(block => block.type === 'paragraph').map(block => block.inline.map(run => run.text).join(''))).toEqual([paragraph])
      expect(snapshot.blocks.filter(block => block.type === 'figure')).toMatchObject([{ alt: 'Reported scene' }])
      expect(requested).toEqual(['https://articles.example.test/reporting.png'])
      expect(snapshot.quality.reasons).not.toContain('unsupported-graphic')
      expect(JSON.stringify(snapshot.blocks)).not.toMatch(/Share report|Normal playback speed/)
    } finally { await capture.dispose() }
  })

  it.each([
    ['SVG chart', '<svg role="img" aria-label="Reported measurements"><title>Reported measurements</title><text x="0" y="10">Reported value: 12</text></svg>'],
    ['reporting video iframe', '<iframe title="Recorded reporting interview" src="https://media.example.test/interview"></iframe>'],
  ])('keeps a real %s as an unresolved graphic instead of classifying it as an interaction icon', async (_kind, graphic) => {
    const { capture } = fixtureCapture(`<title>Public report</title><article><p>Public reporting includes the source visual below.</p>${graphic}</article>`)
    try {
      const { snapshot } = await capture.capture(url)
      expect(snapshot.blocks.filter(block => block.type === 'paragraph').map(block => block.inline.map(run => run.text).join(''))).toContain('Public reporting includes the source visual below.')
      expect(snapshot.quality.status).toBe('partial')
      expect(snapshot.quality.reasons).toContain('unsupported-graphic')
    } finally { await capture.dispose() }
  })

  it('excludes an explicitly labelled advertisement video while retaining the reporting image', async () => {
    const { capture, requested } = fixtureCapture('<article><p>Independent public reporting.</p><video title="Advertisement" poster="/advert.png"></video><figure><img src="/report.png" alt="Reported scene"></figure></article>')
    try {
      const { snapshot } = await capture.capture(url)
      expect(requested).toEqual(['https://articles.example.test/report.png'])
      expect(snapshot.blocks.filter(block => block.type === 'figure')).toMatchObject([{ alt: 'Reported scene' }])
      expect(snapshot.quality.reasons).not.toContain('unsupported-graphic')
    } finally { await capture.dispose() }
  })

  it('excludes a Notsy mapped video slot without discarding the real editorial video poster', async () => {
    const { capture, requested } = fixtureCapture('<article><p>Independent public reporting.</p><div class="CLT_VIDEO" data-notsy-container-index="1" data-notsy-mapped-container="1"><div class="ym-video--player-container"><video class="vjs-tech" poster="/promoted.webp"></video><svg></svg><ul><li>Next promoted video</li></ul></div></div><figure><img src="/report.png" alt="Reported scene"></figure><video poster="/interview.png" title="Reported interview"></video></article>', png, { adapters: [{ id: 'publisher-ad-slot-v1', hosts: ['articles.example.test'], articleSelector: 'article', excludeSelector: '.CLT_VIDEO[data-notsy-container-index][data-notsy-mapped-container]' }] })
    try {
      const { snapshot } = await capture.capture(url)
      expect(requested).toEqual(['https://articles.example.test/report.png', 'https://articles.example.test/interview.png'])
      expect(JSON.stringify(snapshot.blocks)).not.toContain('Next promoted video')
      expect(snapshot.quality.reasons).toContain('unsupported-graphic')
    } finally { await capture.dispose() }
  })

  it('retains an editorial video from the same provider when no publisher ad-slot rule identifies it', async () => {
    const { capture, requested } = fixtureCapture('<article><p>Independent public reporting.</p><div data-notsy-container-index="1" data-notsy-mapped-container="1"><video poster="/reported-interview.png" title="Reported interview"></video><p>The reporter explains the interview.</p></div></article>')
    try {
      const { snapshot } = await capture.capture(url)
      expect(requested).toEqual(['https://articles.example.test/reported-interview.png'])
      expect(JSON.stringify(snapshot.blocks)).toContain('The reporter explains the interview.')
      expect(snapshot.quality.reasons).toContain('unsupported-graphic')
    } finally { await capture.dispose() }
  })

  it('ignores whitespace-only blocks and list controls while retaining spaces between marked words', async () => {
    const { capture } = fixtureCapture('<article><p> <span> </span> <em> </em> </p><ul><li> <span> </span> <em> </em> </li></ul><p><strong>Separated</strong> <em>words.</em></p></article>')
    try {
      const { snapshot } = await capture.capture(url)
      expect(snapshot.blocks).toHaveLength(1)
      expect(snapshot.blocks[0]).toMatchObject({ type: 'paragraph', inline: [{ text: 'Separated', bold: true }, { text: ' ' }, { text: 'words.', italic: true }] })
    } finally { await capture.dispose() }
  })

  it('captures an explicit video poster without claiming that the reporting video was captured', async () => {
    const { capture, requested } = fixtureCapture('<article><p>Public reporting about the recorded event.</p><video poster="/cover.png" title="Recorded event"></video><p>The final reporting paragraph.</p></article>')
    try {
      const { snapshot } = await capture.capture(url)
      expect(requested).toEqual(['https://articles.example.test/cover.png'])
      expect(snapshot.blocks.filter(block => block.type === 'figure')).toMatchObject([{ alt: 'Recorded event' }])
      expect(snapshot.assets).toMatchObject([{ status: 'ready' }])
      expect(snapshot.quality.status).toBe('partial')
      expect(snapshot.quality.reasons).toContain('unsupported-graphic')
    } finally { await capture.dispose() }
  })

  it('reuses a visible player poster instead of duplicating its figure', async () => {
    const { capture, requested } = fixtureCapture('<article><p>Public reporting.</p><div><video poster="/cover.png"></video><picture><img src="/cover.png" alt="Published video cover"></picture></div></article>')
    try {
      const { snapshot } = await capture.capture(url)
      expect(requested).toEqual(['https://articles.example.test/cover.png'])
      expect(snapshot.blocks.filter(block => block.type === 'figure')).toHaveLength(1)
      expect(snapshot.quality.reasons).toContain('unsupported-graphic')
    } finally { await capture.dispose() }
  })

  it('reports unresolved embed types by origin without persisting iframe queries or treating ads as reporting', async () => {
    const { capture } = fixtureCapture('<article><p>Independent public reporting.</p><iframe src="https://media.example.test/interview?token=secret"></iframe><iframe src="https://stories.example.test/visual?auth=private"></iframe><iframe src="https://stories.example.test/other"></iframe><video title="Recorded event"></video><iframe aria-label="Advertisement" src="https://ads.example.test/promotion"></iframe></article>')
    const events = []
    try {
      await capture.capture(url, { onProgress: event => events.push(event) })
      const unresolved = events.filter(event => event.event === 'unsupported-graphic')
      expect(unresolved.map(event => event.details)).toEqual([
        { code: 'unsupported-iframe', total: 1, origin: 'https://media.example.test' },
        { code: 'unsupported-iframe', total: 2, origin: 'https://stories.example.test' },
        { code: 'unsupported-video', total: 1 },
      ])
      expect(JSON.stringify(events)).not.toMatch(/secret|private|\/interview|\/visual|ads\.example/)
    } finally { await capture.dispose() }
  })

  it('keeps editorial continuation and a captioned chart inside a clickable wrapper', async () => {
    const { capture } = fixtureCapture('<article><div class="read-more"><p>The continued reporting includes these independent facts.</p><ul><li>The editorial recommendation.</li></ul></div><div role="button"><svg><title>Measurements</title><text>Reported value: 12</text></svg></div></article>')
    try {
      const { snapshot } = await capture.capture(url)
      expect(JSON.stringify(snapshot.blocks)).toContain('continued reporting')
      expect(snapshot.blocks.find(block => block.type === 'list').items[0].inline).toEqual([{ text: 'The editorial recommendation.' }])
      expect(snapshot.quality.reasons).toContain('unsupported-graphic')
    } finally { await capture.dispose() }
  })

  it('preserves separate block paragraphs and links inside a custom announcement wrapper', async () => {
    const { capture } = fixtureCapture('<title>Public announcement</title><main><promise><div class="ExternalClass"><div>First paragraph with an <a href="/announcement">announcement link</a>.<br></div><div>&nbsp;</div><div>Second paragraph of the public announcement.</div></div></promise></main>', png, { adapters: [{ id: 'announcement-v1', hosts: ['articles.example.test'], articleSelector: 'main', endSelector: 'promise' }] })
    try {
      const { snapshot } = await capture.capture(url)
      const paragraphs = snapshot.blocks.filter(block => block.type === 'paragraph')
      expect(paragraphs.map(block => block.inline.map(run => run.text).join(''))).toEqual(['First paragraph with an announcement link.', 'Second paragraph of the public announcement.'])
      expect(paragraphs[0].inline).toContainEqual({ text: 'announcement link', href: 'https://articles.example.test/announcement' })
      expect(snapshot.quality.reasons).not.toContain('adapter-end-order')
    } finally { await capture.dispose() }
  })

  it('excludes publisher footer and follow promotions while retaining reporting about messaging and real photos', async () => {
    const paragraph = 'The campaign used WhatsApp to publish public transport updates.'
    const markup = `<title>Public reporting</title><article><p>${paragraph}</p><figure class="media"><img src="/reporting.png" alt="Public transport"></figure><img src="/campaign.png" alt="campaign avatar"><div class="footer-vsn"><img src="/footer.svg" alt="Publisher brand"></div><div class="promo-box"><svg><path></path></svg><img src="/promotion.svg" alt="Message icon"><p>Join our WhatsApp channel for more stories.</p></div><div id="publisher-follow-cta"><svg><path></path></svg><p>Follow the publisher for daily updates.</p></div></article>`
    const { capture, requested } = fixtureCapture(markup)
    try {
      const { snapshot } = await capture.capture(url)
      expect(requested).toEqual(['https://articles.example.test/reporting.png', 'https://articles.example.test/campaign.png'])
      expect(snapshot.blocks.filter(block => block.type === 'paragraph').map(block => block.inline.map(run => run.text).join(''))).toEqual([paragraph])
      expect(snapshot.blocks.filter(block => block.type === 'figure').map(block => block.alt)).toEqual(['Public transport', 'campaign avatar'])
      expect(snapshot.quality.reasons).not.toContain('unsupported-graphic')
    } finally { await capture.dispose() }
  })

  it('applies an adapter excludeSelector to recommendations and channel promotions inside the article root', async () => {
    const paragraphs = ['Independent reporting opens with the public facts.', 'The final paragraph explains the reported findings.']
    const markup = `<title>Public report</title><main>${paragraphs.map(text => `<p>${text}</p>`).join('')}<figure><img src="/reporting.png" alt="Reported scene"></figure><div class="article-recommendations"><p>Another article preview.</p><img src="/recommended.png"><iframe src="/embedded-player"></iframe></div><div class="channel-promotion"><p>Join the publisher channel.</p><img src="/channel.png"><svg><path></path></svg></div></main>`
    const adapter = { id: 'article-fixture-v1', hosts: ['articles.example.test'], articleSelector: 'main', excludeSelector: 'main > .article-recommendations:has(img),main > .channel-promotion:has(img)' }
    const { capture, requested } = fixtureCapture(markup, png, { adapters: [adapter] })
    try {
      const { snapshot } = await capture.capture(url)
      expect(snapshot.blocks.filter(block => block.type === 'paragraph').map(block => block.inline.map(run => run.text).join(''))).toEqual(paragraphs)
      expect(snapshot.blocks.filter(block => block.type === 'figure').map(block => block.alt)).toEqual(['Reported scene'])
      expect(requested).toEqual(['https://articles.example.test/reporting.png'])
      expect(snapshot.quality.reasons).not.toContain('unsupported-graphic')
    } finally { await capture.dispose() }
  })

  it('checks original subscription declarations before an adapter excludeSelector can remove a paywall', async () => {
    const markup = `<title>Subscriber report</title><script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script><main><p>${'A public subscriber teaser describes the reporting. '.repeat(8)}</p><div class="metering__paywall-container"></div></main>`
    const adapter = { id: 'restricted-fixture-v1', hosts: ['articles.example.test'], articleSelector: 'main', excludeSelector: '.metering__paywall-container' }
    const { capture } = fixtureCapture(markup, png, { adapters: [adapter] })
    try { await expect(capture.capture(url)).rejects.toThrow('article-restricted') }
    finally { await capture.dispose() }
  })

  it('rejects a declared subscription teaser even when its teaser exceeds the character threshold', async () => {
    const markup = `<title>Subscriber story</title><script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":"False"}</script><article><p>${'Public teaser. '.repeat(30)}</p><div class="metering__paywall-container"></div></article>`
    const { capture } = fixtureCapture(markup)
    try { await expect(capture.capture(url)).rejects.toThrow('article-restricted') }
    finally { await capture.dispose() }
  })

  it('narrows a page-wide main role to the article body instead of menu and recommendation text', async () => {
    const paragraphs = Array.from({ length: 8 }, (_, index) => `Reporting paragraph ${index}, containing independent facts, context and detailed explanation for readers.`)
    const markup = `<title>Reporting</title><div role="main"><div class="site-navigation">Account Settings Newsletter</div><div class="article__body">${paragraphs.map(text => `<p>${text}</p>`).join('')}</div><div class="related-posts">${Array.from({ length: 10 }, () => '<a href="/other">Another recommended headline</a>').join('')}</div></div>`
    const { capture } = fixtureCapture(markup)
    try {
      const { snapshot } = await capture.capture(url)
      expect(snapshot.blocks.filter(block => block.type === 'paragraph').map(block => block.inline.map(run => run.text).join(''))).toEqual(paragraphs)
    } finally { await capture.dispose() }
  })

  it('selects main reporting instead of article cards inside recommendation landmarks', async () => {
    const paragraphs = ['The first public reporting paragraph.', 'The final public reporting paragraph.']
    const markup = `<title>Reporting</title><main>${paragraphs.map(text => `<p>${text}</p>`).join('')}</main><aside><article>Recommended headline</article></aside>`
    const { capture } = fixtureCapture(markup)
    try {
      const { snapshot } = await capture.capture(url)
      expect(snapshot.blocks.filter(block => block.type === 'paragraph').map(block => block.inline.map(run => run.text).join(''))).toEqual(paragraphs)
    } finally { await capture.dispose() }
  })

  it('restores the declared story lead photo discarded by Readability without adding unrelated pictures', async () => {
    const original = 'https://images.example.test/lead.jpg', transformed = `https://images.example.test/dims4/default/resize/320/?url=${encodeURIComponent(original)}`
    const schema = { '@type': 'NewsArticle', url, image: [{ '@type': 'ImageObject', url: original }] }
    const paragraphs = Array.from({ length: 5 }, (_, index) => `<p>Public reporting paragraph ${index}, with independent facts and explanatory background.</p>`).join('')
    const markup = `<title>Story</title><script type="application/ld+json">${JSON.stringify(schema)}</script><main><figure><img src="${transformed}" alt="The lead scene"><figcaption>Original credit</figcaption></figure><div class="story-body">${paragraphs}</div><aside><img src="/unrelated.png"></aside><article class="comments"><button>All comments</button></article></main>`
    const { capture, requested } = fixtureCapture(markup)
    try {
      const { snapshot } = await capture.capture(url)
      expect(snapshot.blocks.filter(block => block.type === 'figure')).toHaveLength(1)
      expect(snapshot.blocks[0]).toMatchObject({ type: 'figure', alt: 'The lead scene', caption: 'Original credit' })
      expect(requested).toEqual([original])
      expect(snapshot.blocks.filter(block => block.type === 'paragraph')).toHaveLength(5)
    } finally { await capture.dispose() }
  })

  it('preserves paragraph boundaries introduced inside a Readability wrapper', async () => {
    const paragraphs = Array.from({ length: 12 }, (_, index) => `第${index + 1}段公开报道，介绍独立的事实与背景，保留段落顺序和完整内容。`)
    const { capture } = fixtureCapture(`<title>公开报道</title><div><span id="detailContent">${paragraphs.map(text => `<p>${text}</p>`).join('')}</span></div>`)
    try {
      const { snapshot } = await capture.capture(url)
      expect(snapshot.blocks.filter(block => block.type === 'paragraph').map(block => block.inline.map(run => run.text).join(''))).toEqual(paragraphs)
    } finally { await capture.dispose() }
  })

  it.each(['figure', 'picture'])('restores a declared lead photo linked from a visible %s outside semantic landmarks', async container => {
    const original = 'https://images.example.test/lead.jpg', thumbnail = 'https://images.example.test/lead-750x375.jpg'
    const schema = { '@type': 'NewsArticle', url, image: { '@type': 'ImageObject', url: original } }
    const paragraphs = Array.from({ length: 6 }, (_, index) => `<p>Public reporting paragraph ${index}, with independent facts and explanatory background.</p>`).join('')
    const photo = container === 'picture' ? `<a href="${original}"><picture><img src="${thumbnail}" alt="The lead scene"></picture></a>` : `<figure><a href="${original}"><img src="${thumbnail}" alt="The lead scene"></a><figcaption>Published credit</figcaption></figure>`
    const markup = `<title>Story</title><script type="application/ld+json">${JSON.stringify(schema)}</script><div>${photo}<div class="story-body">${paragraphs}</div></div><aside><img src="${original}" alt="Recommendation"></aside>`
    const { capture, requested } = fixtureCapture(markup)
    try {
      const { snapshot } = await capture.capture(url)
      expect(snapshot.blocks[0]).toMatchObject({ type: 'figure', alt: 'The lead scene', caption: container === 'figure' ? 'Published credit' : '' })
      expect(requested).toEqual([original])
      expect(snapshot.blocks.filter(block => block.type === 'paragraph')).toHaveLength(6)
      expect(JSON.stringify(snapshot.blocks)).not.toContain('Recommendation')
    } finally { await capture.dispose() }
  })

  it.each(['hidden', 'unmatched-link', 'other-article'])('does not restore an outside photo with %s evidence', async condition => {
    const original = 'https://images.example.test/lead.jpg'
    const schema = { '@type': 'NewsArticle', url: condition === 'other-article' ? `${url}/other` : url, image: original }
    const paragraphs = Array.from({ length: 6 }, (_, index) => `<p>Public reporting paragraph ${index}, with independent facts and explanatory background.</p>`).join('')
    const markup = `<title>Story</title><script type="application/ld+json">${JSON.stringify(schema)}</script><div ${condition === 'hidden' ? 'data-ai-hidden="true"' : ''}><a href="${condition === 'unmatched-link' ? '/other' : original}"><img src="https://images.example.test/thumbnail.jpg"></a></div><div class="story-body">${paragraphs}</div>`
    const { capture, requested } = fixtureCapture(markup)
    try {
      const { snapshot } = await capture.capture(url)
      expect(snapshot.blocks.filter(block => block.type === 'figure')).toEqual([])
      expect(requested).toEqual([])
    } finally { await capture.dispose() }
  })

  it('restores a declared lead photo exactly matched in srcset outside an adapter body root', async () => {
    const lead = 'https://images.example.test/published-original.png', small = 'https://images.example.test/preview.png'
    const paragraphs = ['Opening facts from the public report.', 'Closing context from the public report.']
    const schema = { '@type': 'NewsArticle', url, image: { '@type': 'ImageObject', url: lead } }
    const markup = `<title>Public report</title><script type="application/ld+json">${JSON.stringify(schema)}</script><main><aside><img src="${lead}" alt="Recommended scene"></aside><figure><img src="${small}" srcset="${small} 300w, ${lead} 1200w" alt="Reported lead scene"><figcaption>Published scene caption.</figcaption></figure><div class="story-body">${paragraphs.map(text => `<p>${text}</p>`).join('')}</div></main>`
    const adapter = { id: 'responsive-fixture-v1', hosts: ['articles.example.test'], articleSelector: 'main .story-body' }
    const { capture, requested } = fixtureCapture(markup, png, { adapters: [adapter] })
    try {
      const { snapshot } = await capture.capture(url)
      expect(requested).toEqual([lead])
      expect(snapshot.blocks.map(block => block.type)).toEqual(['figure', 'paragraph', 'paragraph'])
      expect(snapshot.blocks[0]).toMatchObject({ type: 'figure', alt: 'Reported lead scene', caption: 'Published scene caption.' })
      expect(snapshot.blocks.slice(1).map(block => block.inline.map(run => run.text).join(''))).toEqual(paragraphs)
      expect(snapshot.assets[0]).toMatchObject({ sourceUrl: lead, positions: [snapshot.blocks[0].id] })
      expect(JSON.stringify(snapshot.blocks)).not.toContain('Recommended scene')
    } finally { await capture.dispose() }
  })

  it('restores a declared lead photo with different display parameters and requests its original declared URL', async () => {
    const declared = 'https://images.example.test/photo.jpg?width=1600&quality=90'
    const preview = 'https://images.example.test/photo.jpg?width=640&quality=75'
    const paragraphs = ['Opening facts from the public report.', 'Closing context from the public report.']
    const schema = { '@type': 'NewsArticle', url, image: declared }
    const markup = `<title>Public report</title><script type="application/ld+json">${JSON.stringify(schema)}</script><main><figure><img src="${preview.replaceAll('&', '&amp;')}" alt="Published lead"><figcaption>Published photo caption.</figcaption></figure><div class="story-body">${paragraphs.map(text => `<p>${text}</p>`).join('')}</div></main>`
    const adapter = { id: 'display-parameters-fixture-v1', hosts: ['articles.example.test'], articleSelector: 'main .story-body' }
    const { capture, requested } = fixtureCapture(markup, png, { adapters: [adapter] })
    try {
      const { snapshot } = await capture.capture(url)
      expect(requested).toEqual([declared])
      expect(snapshot.blocks.map(block => block.type)).toEqual(['figure', 'paragraph', 'paragraph'])
      expect(snapshot.blocks[0]).toMatchObject({ type: 'figure', alt: 'Published lead', caption: 'Published photo caption.' })
      expect(snapshot.assets[0]).toMatchObject({ sourceUrl: declared })
      expect(snapshot.blocks.slice(1).map(block => block.inline.map(run => run.text).join(''))).toEqual(paragraphs)
    } finally { await capture.dispose() }
  })

  it('keeps image identity parameters and excludes hidden or aside matches when restoring a declared lead', async () => {
    const declared = 'https://images.example.test/photo.jpg?id=lead&width=1600'
    const other = 'https://images.example.test/photo.jpg?id=other&width=640'
    const paragraphs = ['Opening facts from the public report.', 'Closing context from the public report.']
    const schema = { '@type': 'NewsArticle', url, image: declared }
    const markup = `<title>Public report</title><script type="application/ld+json">${JSON.stringify(schema)}</script><main><aside><img src="${declared.replaceAll('&', '&amp;')}" alt="Recommended lead"></aside><div hidden><img src="${declared.replaceAll('&', '&amp;')}" alt="Hidden lead"></div><figure><img src="${other.replaceAll('&', '&amp;')}" alt="Different photo identity"></figure><div class="story-body">${paragraphs.map(text => `<p>${text}</p>`).join('')}</div></main>`
    const adapter = { id: 'identity-parameters-fixture-v1', hosts: ['articles.example.test'], articleSelector: 'main .story-body' }
    const { capture, requested } = fixtureCapture(markup, png, { adapters: [adapter] })
    try {
      const { snapshot } = await capture.capture(url)
      expect(requested).toEqual([])
      expect(snapshot.assets).toEqual([])
      expect(snapshot.blocks.map(block => block.type)).toEqual(['paragraph', 'paragraph'])
      expect(snapshot.blocks.map(block => block.inline.map(run => run.text).join(''))).toEqual(paragraphs)
    } finally { await capture.dispose() }
  })

  it('requests the exact declared original instead of its published Plone image rendition', async () => {
    const declared = 'https://images.example.test/photo.jpeg'
    const preview = `${declared}/@@images/00000000-0000-4000-8000-000000000001.jpeg`
    const schema = { '@type': 'NewsArticle', url, image: declared }
    const markup = `<title>Public report</title><script type="application/ld+json">${JSON.stringify(schema)}</script><article><p>Opening facts from the public report.</p><figure><img src="${preview}" alt="Published lead"><figcaption>Original published caption.</figcaption></figure><p>Closing context from the public report.</p></article>`
    const adapter = { id: 'plone-image-fixture-v1', hosts: ['articles.example.test'], articleSelector: 'article' }
    const { capture, requested } = fixtureCapture(markup, png, { adapters: [adapter] })
    try {
      const { snapshot } = await capture.capture(url)
      expect(requested).toEqual([declared])
      expect(snapshot.blocks.map(block => block.type)).toEqual(['paragraph', 'figure', 'paragraph'])
      expect(snapshot.blocks[1]).toMatchObject({ type: 'figure', alt: 'Published lead', caption: 'Original published caption.' })
      expect(snapshot.assets[0]).toMatchObject({ status: 'ready', sourceUrl: declared })
    } finally { await capture.dispose() }
  })

  it('requests the declared Arc rendition signature without matching another resource or ordinary auth parameter', async () => {
    const declared = 'https://images.example.test/resizer/v2/OPAQUEID.jpg?width=1600&auth=large-signature'
    const preview = 'https://images.example.test/resizer/v2/OPAQUEID.jpg?width=640&auth=small-signature'
    const other = 'https://images.example.test/resizer/v2/OTHERID.jpg?width=640&auth=small-signature'
    const ordinaryDeclared = 'https://images.example.test/photo.jpg?width=1600&auth=large-signature'
    const ordinaryPreview = 'https://images.example.test/photo.jpg?width=640&auth=small-signature'
    const schema = { '@type': 'NewsArticle', url, image: [declared, ordinaryDeclared] }
    const escaped = value => value.replaceAll('&', '&amp;')
    const markup = `<title>Public report</title><script type="application/ld+json">${JSON.stringify(schema)}</script><main><figure><img src="${escaped(other)}" alt="Different resource"></figure><figure><img src="${escaped(ordinaryPreview)}" alt="Different ordinary signature"></figure><article><p>Opening facts from the public report.</p><figure><img src="${escaped(preview)}" alt="Published lead"><figcaption>Published Arc caption.</figcaption></figure><p>Closing context from the public report.</p></article></main>`
    const adapter = { id: 'arc-image-fixture-v1', hosts: ['articles.example.test'], articleSelector: 'article' }
    const { capture, requested } = fixtureCapture(markup, png, { adapters: [adapter] })
    try {
      const { snapshot } = await capture.capture(url)
      expect(requested).toEqual([declared])
      expect(snapshot.blocks.map(block => block.type)).toEqual(['paragraph', 'figure', 'paragraph'])
      expect(snapshot.blocks[1]).toMatchObject({ type: 'figure', alt: 'Published lead', caption: 'Published Arc caption.' })
      expect(snapshot.assets).toHaveLength(1)
      expect(snapshot.assets[0]).toMatchObject({ status: 'ready', sourceUrl: declared })
      expect(JSON.stringify(snapshot.blocks)).not.toMatch(/Different resource|Different ordinary signature/)
    } finally { await capture.dispose() }
  })

  it('keeps separate paragraphs and inline marks inside a multi-paragraph quotation', async () => {
    const { capture } = fixtureCapture('<title>Quote</title><article><blockquote>Opening <strong>statement</strong>.<p>First <em>paragraph</em>.</p><p>Second paragraph.</p>Closing statement.</blockquote></article>')
    try {
      const { snapshot } = await capture.capture(url)
      expect(snapshot.blocks.map(block => block.type)).toEqual(['quote', 'quote', 'quote', 'quote'])
      expect(snapshot.blocks[0].inline).toContainEqual({ text: 'statement', bold: true })
      expect(snapshot.blocks[1].inline).toContainEqual({ text: 'paragraph', italic: true })
      expect(snapshot.blocks.map(block => block.inline.map(run => run.text).join(''))).toEqual(['Opening statement.', 'First paragraph.', 'Second paragraph.', 'Closing statement.'])
    } finally { await capture.dispose() }
  })

  it('recovers the story when a nested comment widget is the only article element', async () => {
    const paragraphs = Array.from({ length: 6 }, (_, index) => `Public reporting paragraph ${index + 1}, with independent facts and sufficient explanatory background.`)
    const markup = `<title>Public story</title><main><h1>Public story</h1><div class="story-body">${paragraphs.map(text => `<p>${text}</p>`).join('')}</div><article class="comments"><button>All comments</button><div role="tablist">Newest</div></article></main>`
    const renderer = { render: async () => ({ html: markup, url, statusCode: 200 }), inspectImage: async () => { throw new Error('No images expected') }, dispose: async () => {} }
    const capture = createCapture(resolveCaptureConfig({ minArticleChars: 100 }), { renderer })
    try {
      const { snapshot } = await capture.capture(url)
      expect(snapshot.blocks.filter(block => block.type === 'paragraph').map(block => block.inline.map(run => run.text).join(''))).toEqual(paragraphs)
      expect(JSON.stringify(snapshot.blocks)).not.toContain('All comments')
    } finally { await capture.dispose() }
  })

  it('does not extend a short article with text from elsewhere in main', async () => {
    const markup = `<title>Short note</title><main><article><p>Short public note.</p></article><div class="related"><p>${'Unrelated reporting. '.repeat(30)}</p></div></main>`
    const renderer = { render: async () => ({ html: markup, url, statusCode: 200 }), dispose: async () => {} }
    const capture = createCapture(resolveCaptureConfig({ minArticleChars: 100 }), { renderer })
    try { await expect(capture.capture(url)).rejects.toThrow('article-short') }
    finally { await capture.dispose() }
  })

  it('reads reporting outside main when article elements are paragraph-free sidebar cards', async () => {
    const paragraphs = Array.from({ length: 6 }, (_, index) => `Public reporting paragraph ${index + 1}, with independent facts and sufficient explanatory background.`)
    const markup = `<title>Public story</title><div class="post-wrap"><h1>Public story</h1><div class="content-inner">${paragraphs.map(text => `<p>${text}</p>`).join('')}</div></div><div class="sidebar"><article><h3><a href="/other">Another destination</a></h3><time>Yesterday</time></article></div>`
    const renderer = { render: async () => ({ html: markup, url, statusCode: 200 }), inspectImage: async () => { throw new Error('No images expected') }, dispose: async () => {} }
    const capture = createCapture(resolveCaptureConfig({ minArticleChars: 100 }), { renderer })
    try {
      const { snapshot } = await capture.capture(url)
      expect(snapshot.title).toBe('Public story')
      expect(blocksToParagraphs(snapshot.blocks).map(block => block.text)).toEqual(paragraphs)
      expect(JSON.stringify(snapshot.blocks)).not.toContain('Another destination')
    } finally { await capture.dispose() }
  })

  it('reads the full story outside main when a product article card contains only a short paragraph', async () => {
    const paragraphs = Array.from({ length: 6 }, (_, index) => `Detailed public reporting paragraph ${index + 1} includes verified transport conditions, context and relevant explanations for the reader.`)
    const markup = `<title>Public report</title><div class="story-body">${paragraphs.map(text => `<p>${text}</p>`).join('')}</div><article class="product-card"><h3><a href="/offer">Travel accessory offer</a></h3><p>Offer ends today.</p></article>`
    const renderer = { render: async () => ({ html: markup, url, statusCode: 200 }), inspectImage: async () => { throw new Error('No images expected') }, dispose: async () => {} }
    const capture = createCapture(resolveCaptureConfig({ minArticleChars: 100 }), { renderer })
    try {
      const { snapshot } = await capture.capture(url)
      expect(snapshot.blocks.filter(block => block.type === 'paragraph').map(block => block.inline.map(run => run.text).join(''))).toEqual(paragraphs)
      expect(JSON.stringify(snapshot.blocks)).not.toContain('Travel accessory offer')
      expect(JSON.stringify(snapshot.blocks)).not.toContain('Offer ends today.')
    } finally { await capture.dispose() }
  })

  it('keeps a distinct section heading similar to the article title between reporting and an ordered list', async () => {
    const title = '7 destinos na Argentina para fugir da alta do dólar e aproveitar'
    const heading = 'Destinos na Argentina para aproveitar o câmbio'
    const paragraphs = [
      'Este guia compara sete cidades argentinas, com informações públicas sobre transporte, hospedagem e atividades culturais para organizar uma viagem.',
      'As opções seguem de norte a sul, e cada cidade apresenta condições diferentes de deslocamento, clima e acesso aos passeios descritos abaixo.',
    ]
    const destinations = Array.from({ length: 7 }, (_, index) => `Destino ${index + 1}: consulte os horários do transporte local e reserve tempo para conhecer os espaços culturais da cidade.`)
    const markup = `<title>${title}</title><div class="post-wrap"><div class="entry-header"><h1>${title}</h1></div><div class="content-inner">${paragraphs.map(text => `<p>${text}</p>`).join('')}<h2 class="wp-block-heading">${heading}</h2><ol class="wp-block-list">${destinations.map(text => `<li>${text}</li>`).join('')}</ol></div></div><aside><h2>Outra viagem recomendada</h2><a href="/other">Veja outro destino</a></aside>`
    const { capture } = fixtureCapture(markup)
    try {
      const { snapshot } = await capture.capture(url)
      expect(snapshot.blocks.map(block => block.type)).toEqual(['paragraph', 'paragraph', 'heading', 'list'])
      expect(snapshot.blocks.slice(0, 2).map(block => block.inline.map(run => run.text).join(''))).toEqual(paragraphs)
      expect(snapshot.blocks[2]).toMatchObject({ type: 'heading', level: 2, inline: [{ text: heading }] })
      expect(snapshot.blocks[3]).toMatchObject({ type: 'list', ordered: true })
      expect(snapshot.blocks[3].items.map(item => item.inline.map(run => run.text).join(''))).toEqual(destinations)
      expect(JSON.stringify(snapshot.blocks)).not.toContain('Outra viagem recomendada')
    } finally { await capture.dispose() }
  })

  it('reports cancellation between extraction and image acquisition with the owned interruption code', async () => {
    const { capture } = fixtureCapture(), controller = new AbortController()
    try {
      await expect(capture.capture(url, { signal: controller.signal, onProgress: progress => { if (progress.phase === 'extracting' && progress.completed === 1) controller.abort() } })).rejects.toThrow('article-interrupted')
    } finally { await capture.dispose() }
  })
  it('fails closed when IPv6 translation-prefix verification cannot complete', async () => {
    const lookups = [], resolver = async host => {
      lookups.push(host)
      if (host === 'ipv4only.arpa') throw new Error('resolver unavailable')
      return [{ address: '2606:4700:4700::1111', family: 6 }]
    }
    await expect(publicNetworkPolicy(new URL('https://public.example.test'), { resolver })).rejects.toThrow('resolver unavailable')
    expect(lookups).toEqual(['public.example.test', 'ipv4only.arpa'])
  })
  it('cannot report a browser ready after concurrent disposal has taken ownership of its launch', async () => {
    let release, closed = 0
    const gate = new Promise(resolve => { release = resolve })
    const browser = { close: async () => { closed++ }, newContext: async () => { throw new Error('no page expected') } }
    const capture = createCapture(resolveCaptureConfig({ minArticleChars: 1 }), { loadChromium: async () => ({ launch: async () => { await gate; return browser } }) })
    const ready = capture.readiness(), disposing = capture.dispose()
    release()
    await disposing
    expect(await ready).toEqual({ available: false, code: 'article-interrupted' })
    expect(closed).toBe(1)
    expect(await capture.readiness()).toEqual({ available: false, code: 'article-interrupted' })
  })
  it('preserves rich block numbers in the read-only paragraph projection', () => {
    expect(blocksToParagraphs([{ id: 'b1', type: 'paragraph', inline: [{ text: '开头' }] }, { id: 'b2', type: 'figure', alt: '', caption: '', credit: '' }, { id: 'b3', type: 'paragraph', inline: [{ text: '结尾' }] }])).toEqual([{ id: 1, text: '开头' }, { id: 3, text: '结尾' }])
  })
  it('keeps semantic order and image metadata while removing surrounding furniture and unsafe URLs', async () => {
    const { capture, requested } = fixtureCapture()
    try {
      const result = await capture.capture(url, { language: '' })
      const value = snapshotSchema.parse(result.snapshot)
      expect(value.blocks.map(block => block.type)).toEqual(['heading', 'paragraph', 'heading', 'list', 'quote', 'table', 'figure', 'paragraph'])
      expect(JSON.stringify(value.blocks)).not.toMatch(/导航|推荐文章|页脚|javascript:|alert\(1\)/)
      expect(value.blocks[1].inline).toContainEqual(expect.objectContaining({ text: '重要观点', bold: true }))
      expect(value.blocks[3].items[0].children[0].items[0].inline[0].text).toBe('二级')
      expect(value.blocks[5].rows[0].cells[0]).toMatchObject({ header: true, inline: [{ text: '名称' }] })
      expect(requested).toEqual(['https://articles.example.test/large.png?sig=a'])
      expect(value.blocks[6]).toMatchObject({ type: 'figure', alt: '场景', caption: '说明 摄影：作者', credit: '摄影：作者' })
      expect(result.assets[0]).toMatchObject({ bytes: png, width: 800, height: 600, mime: 'image/png', status: 'ready' })
      expect(value.assets[0]).not.toHaveProperty('bytes')
      expect(value.quality).toMatchObject({ status: 'needs-review', reasons: ['unknown-article-scope'] })
      expect(blocksToParagraphs(value.blocks).map(block => block.text).join(' ')).toContain('正文结束')
    } finally { await capture.dispose() }
  })

  it('deduplicates asset bytes while retaining occurrence positions and different captions', async () => {
    const { capture } = fixtureCapture(html.replace('<p>正文结束。</p>', '<figure><img src="/duplicate.png"><figcaption>第二次出现</figcaption></figure><p>正文结束。</p>'))
    try {
      const { snapshot, assets } = await capture.capture(url)
      expect(assets).toHaveLength(1)
      const figures = snapshot.blocks.filter(block => block.type === 'figure')
      expect(figures[0].assetId).toBe(figures[1].assetId)
      expect(figures[1].caption).toBe('第二次出现')
      expect(snapshot.assets[0].positions).toEqual(figures.map(block => block.id))
    } finally { await capture.dispose() }
  })

  it('resolves responsive sources within each picture and preserves inline image position', async () => {
    const markup = '<title>Pictures</title><article><h1>Pictures</h1><p>Before <span><img src="/inline.png"></span> after.</p><picture><source srcset="/one.png 800w"><img src="/one-small.png"></picture><picture><source srcset="/two.png 1600w"><img src="/two-small.png"></picture></article>'
    const { capture, requested } = fixtureCapture(markup)
    try {
      const { snapshot } = await capture.capture(url)
      expect(requested).toEqual(['https://articles.example.test/inline.png', 'https://articles.example.test/one.png', 'https://articles.example.test/two.png'])
      expect(snapshot.blocks.map(block => block.type)).toEqual(['heading', 'paragraph', 'figure', 'paragraph', 'figure', 'figure'])
      expect(snapshot.blocks[1].inline).toEqual([{ text: 'Before' }])
      expect(snapshot.blocks[3].inline).toEqual([{ text: 'after.' }])
    } finally { await capture.dispose() }
  })

  it('retains every image in a multi-image figure and a safe noscript fallback', async () => {
    const markup = '<title>Gallery</title><article><h1>Gallery</h1><p>完整正文。</p><figure><img src="/first.png"><img src="/second.png"><figcaption>一组图片</figcaption></figure><noscript><img src="/fallback.png" alt="备用原图"></noscript></article>'
    const { capture, requested } = fixtureCapture(markup)
    try {
      const { snapshot } = await capture.capture(url)
      expect(requested).toEqual(['https://articles.example.test/first.png', 'https://articles.example.test/second.png', 'https://articles.example.test/fallback.png'])
      expect(snapshot.blocks.filter(block => block.type === 'figure')).toHaveLength(3)
    } finally { await capture.dispose() }
  })

  it('hashes bytes and figure relationships but ignores signatures and capture timestamps', async () => {
    const first = fixtureCapture(), second = fixtureCapture(html.replace('sig=a', 'sig=b'))
    try {
      const a = (await first.capture.capture(url)).snapshot, b = (await second.capture.capture(url)).snapshot
      expect(a.sourceHash).toBe(b.sourceHash)
      expect(hashSnapshot({ ...a, capturedAt: 'later', id: '0'.repeat(32) })).toBe(a.sourceHash)
      expect(hashSnapshot({ ...a, assets: a.assets.map(asset => ({ ...asset, contentHash: 'f'.repeat(64) })) })).not.toBe(a.sourceHash)
      expect(hashSnapshot({ ...a, blocks: [...a.blocks].reverse() })).not.toBe(a.sourceHash)
    } finally { await first.capture.dispose(); await second.capture.dispose() }
  })

  it('retains a canonical semantic hash after schema parsing reorders inline properties', async () => {
    const { capture } = fixtureCapture(html.replace('正文的<strong>重要观点</strong>', '正文的<a href="/source"><strong>重要观点</strong></a>'))
    try {
      const { snapshot } = await capture.capture(url)
      expect(hashSnapshot(snapshotSchema.parse(snapshot))).toBe(snapshot.sourceHash)
    } finally { await capture.dispose() }
  })

  it('retains failed figures and identifies pagination and unsupported informative graphics', async () => {
    const broken = createCapture(resolveCaptureConfig({ minArticleChars: 1 }), {
      renderer: { render: async () => ({ html: html.replace('</article>', '<canvas></canvas><a rel="next" href="?page=2">下一页</a></article>'), url, statusCode: 200 }), readiness: async () => ({ available: true }), dispose: async () => {} },
      request: async () => ({ bytes: Buffer.from('broken'), statusCode: 200, mime: 'text/html', url }),
      inspectImage: async () => { throw new Error('must not decode HTML') },
    })
    try {
      const { snapshot, assets } = await broken.capture(url)
      expect(snapshot.quality.status).toBe('partial')
      expect(snapshot.quality.reasons).toEqual(expect.arrayContaining(['image-invalid', 'unhandled-pagination', 'unsupported-graphic']))
      expect(snapshot.assets[0]).toMatchObject({ status: 'failed', error: 'image-invalid' })
      expect(snapshot.blocks.some(block => block.type === 'figure')).toBe(true)
      expect(assets).toHaveLength(0)
    } finally { await broken.dispose() }
  })

  it('rejects MIME-spoofed bytes and excessive raster dimensions before decoding', async () => {
    let decodes = 0
    const renderer = { render: async () => ({ html, url, statusCode: 200 }), readiness: async () => ({ available: true }), dispose: async () => {} }
    const request = async () => ({ bytes: Buffer.from('<svg onload="danger()"/>'), statusCode: 200, mime: 'image/png', url })
    const capture = createCapture(resolveCaptureConfig({ minArticleChars: 1 }), { renderer, request, inspectImage: async () => { decodes++; return { width: 1, height: 1 } } })
    const hugePng = Buffer.from(png); hugePng.writeUInt32BE(100000, 16); hugePng.writeUInt32BE(100000, 20)
    const huge = createCapture(resolveCaptureConfig({ minArticleChars: 1 }), { renderer, request: async () => ({ bytes: hugePng, statusCode: 200, mime: 'image/png', url }), inspectImage: async () => { decodes++; return { width: 1, height: 1 } } })
    try {
      expect((await capture.capture(url)).snapshot.assets[0].error).toBe('image-invalid')
      expect((await huge.capture(url)).snapshot.assets[0].error).toBe('image-dimensions')
      expect(decodes).toBe(0)
    } finally { await capture.dispose(); await huge.dispose() }
  })

  it('passes only configured unique article scopes whose declared end and images were captured', async () => {
    const markup = html.replace('<article>', '<article id="story">').replace('<p>正文结束。</p>', '<p id="end">正文结束。</p>')
    const configured = resolveCaptureConfig({ minArticleChars: 1, adapters: [{ id: 'publisher-v1', hosts: ['articles.example.test'], articleSelector: '#story', endSelector: '#end', expectedMinImages: 1 }] })
    const dependencies = { renderer: { render: async () => ({ html: markup, url, statusCode: 200 }), readiness: async () => ({ available: true }), dispose: async () => {} },
      request: async target => ({ bytes: png, statusCode: 200, mime: 'image/png', url: target }), inspectImage: async () => ({ width: 2, height: 2 }) }
    const capture = createCapture(configured, dependencies)
    const incomplete = createCapture(configured, { ...dependencies, renderer: { ...dependencies.renderer, render: async () => ({ html: markup.replace('id="end"', 'id="missing"'), url, statusCode: 200 }) } })
    try {
      expect((await capture.capture(url)).snapshot.quality).toMatchObject({ status: 'passed', reasons: [], adapter: 'publisher-v1' })
      expect((await incomplete.capture(url)).snapshot.quality).toMatchObject({ status: 'partial', reasons: ['adapter-missing-end'] })
      expect(() => resolveCaptureConfig({ adapters: [{ id: 'broken', hosts: ['articles.example.test'], articleSelector: '[' }] })).toThrow()
      expect(() => resolveCaptureConfig({ adapters: [{ id: 'a', hosts: ['articles.example.test'], articleSelector: 'article' }, { id: 'b', hosts: ['articles.example.test'], articleSelector: 'article' }] })).toThrow()
    } finally { await capture.dispose(); await incomplete.dispose() }
  })

  it('merges configured same-article pages and excludes pagination controls and next-story links', async () => {
    const visited = []
    const pages = {
      [url]: '<title>分页文章</title><article data-story="42"><h1>分页文章</h1><p>第一部分正文。</p><a id="next-page" href="?page=2">继续翻页</a></article><aside><a href="/another-story">下一篇</a></aside>',
      [`${url}?page=2`]: '<title>分页文章</title><article data-story="42"><h1>分页文章</h1><p id="end">第二部分结尾。</p></article><aside><a href="/another-story">下一篇</a></aside>',
    }
    const capture = createCapture(resolveCaptureConfig({ minArticleChars: 1, adapters: [{ id: 'pages-v1', hosts: ['articles.example.test'], articleSelector: 'article', endSelector: '#end', pagination: { nextSelector: '#next-page', identitySelector: 'article', identityAttribute: 'data-story', maxPages: 3 } }] }), {
      renderer: { readiness: async () => ({ available: true }), dispose: async () => {}, render: async target => { visited.push(target); return { html: pages[target], url: target, statusCode: 200 } } },
      request: async () => { throw new Error('no images') }, inspectImage: async () => { throw new Error('no images') },
    })
    try {
      const { snapshot } = await capture.capture(url)
      expect(visited).toEqual([url, `${url}?page=2`])
      expect(snapshot.quality).toMatchObject({ status: 'passed', reasons: [] })
      expect(snapshot.blocks.map(block => block.type)).toEqual(['heading', 'paragraph', 'paragraph'])
      expect(JSON.stringify(snapshot.blocks)).not.toMatch(/继续翻页|下一篇/)
      expect(snapshot.pages).toEqual([{ url, blockIds: ['b1', 'b2'] }, { url: `${url}?page=2`, blockIds: ['b3'] }])
    } finally { await capture.dispose() }
  })

  it.each(['identity', 'loop'])('does not complete pagination with a mismatched %s', async mode => {
    const visited = []
    const capture = createCapture(resolveCaptureConfig({ minArticleChars: 1, adapters: [{ id: 'pages-v1', hosts: ['articles.example.test'], articleSelector: 'article', pagination: { nextSelector: '#next', identitySelector: 'article', identityAttribute: 'data-story', maxPages: 3 } }] }), {
      renderer: { readiness: async () => ({ available: true }), dispose: async () => {}, render: async target => {
        visited.push(target)
        return { statusCode: 200, url: target, html: target === url ? '<title>Article</title><article data-story="42"><h1>Article</h1><p>First page.</p><a id="next" href="?page=2">Next</a></article>'
          : `<title>Article</title><article data-story="${mode === 'identity' ? '99' : '42'}"><h1>Article</h1><p>Second page.</p>${mode === 'loop' ? `<a id="next" href="${url}">Next</a>` : ''}</article>` }
      } }, request: async () => { throw new Error('no images') }, inspectImage: async () => { throw new Error('no images') },
    })
    try {
      const { snapshot } = await capture.capture(url)
      expect(visited).toEqual([url, `${url}?page=2`])
      expect(snapshot.quality).toMatchObject({ status: 'partial', reasons: [mode === 'identity' ? 'adapter-pagination-identity' : 'adapter-pagination-budget'] })
      if (mode === 'identity') expect(JSON.stringify(snapshot.blocks)).not.toContain('Second page')
    } finally { await capture.dispose() }
  })

  it.each([
    ['article-challenge', '<title>Just a moment</title><div id="challenge-form">Verify you are human</div>'],
    ['article-login', '<title>Sign in</title><main><h1>Sign in</h1><input type="password"></main>'],
    ['article-restricted', '<article><h1>Title</h1><p>Intro</p><div class="paywall">Subscribe to continue reading</div></article>'],
  ])('rejects recognized %s gates without using their text as an article', async (code, markup) => {
    const { capture } = fixtureCapture(markup)
    try { await expect(capture.capture(url)).rejects.toThrow(code) } finally { await capture.dispose() }
  })
  it.each([
    '<div id="paywall-content"><article><h1>Title</h1><p>Public body.</p></article><aside>Assine a Folha</aside></div>',
    '<article><h1>Title</h1><p>Public body.</p><div class="paywall" data-ai-hidden="true">Subscribe to continue reading</div></article>',
  ])('does not classify subscription promotions or hidden gate templates as a restricted article', async markup => {
    const { capture } = fixtureCapture(markup)
    try { const { snapshot } = await capture.capture(url); expect(JSON.stringify(snapshot.blocks)).toContain('Public body.'); expect(JSON.stringify(snapshot.blocks)).not.toContain('Subscribe') }
    finally { await capture.dispose() }
  })
  it('recognizes a visible Portuguese reading quota restriction', async () => {
    const { capture } = fixtureCapture('<article><h1>Title</h1><p>Intro.</p></article><div id="paywall-screen">Você atingiu seu limite de matérias livres. Assine com acesso ilimitado!</div>')
    try { await expect(capture.capture(url)).rejects.toThrow('article-restricted') } finally { await capture.dispose() }
  })
})
