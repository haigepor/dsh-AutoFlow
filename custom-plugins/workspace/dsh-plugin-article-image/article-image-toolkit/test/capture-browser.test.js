/** Real isolated Chromium fixtures with exact per-test loopback policy and owned ephemeral ports. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'patchright'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { deflateSync } from 'node:zlib'
import { JSDOM } from 'jsdom'
import { createCapture, resolveCaptureConfig } from '../src/capture.js'
import { createPublicRequest } from '../src/capture-media.js'
import { CookieJar } from '../src/session.js'
import { failure } from '../src/contracts.js'
import { CaptureRenderer } from '../src/capture-renderer.js'

function crc(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return (value ^ 0xffffffff) >>> 0
}
function png() {
  const chunk = (type, data) => {
    const value = Buffer.concat([Buffer.from(type), data]), prefix = Buffer.alloc(4), suffix = Buffer.alloc(4)
    prefix.writeUInt32BE(data.length); suffix.writeUInt32BE(crc(value))
    return Buffer.concat([prefix, value, suffix])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(64, 0); header.writeUInt32BE(48, 4); header[8] = 8; header[9] = 2
  const pixels = Buffer.alloc((64 * 3 + 1) * 48)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}
const config = resolveCaptureConfig({ minArticleChars: 1, renderTimeoutMs: 5000, requestTimeoutMs: 5000, renderWaitMs: 1000, scrollWaitMs: 25, maxScrollSteps: 20 })
let sharedBrowser
beforeAll(async () => { sharedBrowser = await chromium.launch({ headless: true, timeout: config.renderTimeoutMs }) }, 30000)
afterAll(async () => { await sharedBrowser?.close() }, 30000)
// 文件级fixture拥有浏览器，每个capture仍独立拥有并关闭context；取消测试另外拥有真实独立浏览器。
const loadFixtureChromium = async () => ({ launch: async () => ({ newContext: options => sharedBrowser.newContext(options), close: async () => {} }) })

async function fixture(handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  return { origin, policy: async url => {
    if (url.origin !== origin) throw Object.assign(new Error('article-url-blocked'), { code: 'article-url-blocked' })
    return [{ address: '127.0.0.1', family: 4 }]
  }, close: async () => { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) } }
}

describe('capture network policy', () => {
  it('rejects loopback IPv4, IPv6 and credentialed targets in production', async () => {
    const request = createPublicRequest(config)
    await expect(request('http://127.0.0.1:1/private')).rejects.toThrow('article-url-blocked')
    await expect(request('http://[::1]:1/private')).rejects.toThrow('article-url-blocked')
    await expect(request('http://[::ffff:127.0.0.1]:1/private')).rejects.toThrow('article-url-blocked')
    await expect(request('https://user:secret@example.com')).rejects.toThrow('article-url-blocked')
    await expect(request('file:///private/file')).rejects.toThrow('article-url-blocked')
  })

  it('checks redirected targets and resource byte budgets before exposing a response', async () => {
    const owned = await fixture((req, res) => {
      if (req.url === '/redirect') { res.writeHead(302, { location: 'http://127.0.0.1:1/private' }); res.end(); return }
      if (req.url === '/same') { res.writeHead(302, { location: '/final' }); res.end(); return }
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('fixture body')
    })
    const request = createPublicRequest(config, { networkPolicy: owned.policy })
    try {
      await expect(request(`${owned.origin}/redirect`)).rejects.toThrow('article-redirect')
      await expect(request(`${owned.origin}/final`, { maxBytes: 3 })).rejects.toThrow('article-resource-limit')
      expect(await request(`${owned.origin}/same`)).toMatchObject({ url: `${owned.origin}/final`, statusCode: 200, bytes: Buffer.from('fixture body') })
    } finally { await owned.close() }
  })
})

describe('real Chromium article capture', () => {
  it('waits for an adapter pendingSelector gallery after scrolling even when renderWaitMs is zero', async () => {
    const requests = [], image = png()
    const owned = await fixture((req, res) => {
      requests.push(req.url)
      if (req.url === '/gallery') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ src: '/gallery-photo.png' })); return }
      if (req.url === '/gallery-photo.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(image); return }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<title>Gallery report</title><article style="min-height:3000px"><h1>Gallery report</h1><p>The complete public reporting is already available.</p><div data-gallery-pending>Carregando galeria.</div></article><script>window.addEventListener("scroll",async()=>{const gallery=await fetch("/gallery").then(response=>response.json());const figure=document.createElement("figure");const image=document.createElement("img");image.src=gallery.src;image.alt="Published gallery photo";figure.append(image);document.querySelector("[data-gallery-pending]").replaceWith(figure)},{once:true})</script>')
    })
    let renderer
    try {
      const settings = resolveCaptureConfig({ ...config, renderWaitMs: 0, scrollWaitMs: 0, adapters: [{ id: 'gallery-fixture-v1', hosts: ['127.0.0.1'], articleSelector: 'article', pendingSelector: '[data-gallery-pending]' }] })
      renderer = new CaptureRenderer(settings, { loadChromium: loadFixtureChromium, request: createPublicRequest(settings, { networkPolicy: owned.policy }) })
      const value = await renderer.render(`${owned.origin}/article`)
      const dom = new JSDOM(value.html)
      try {
        expect(requests.filter(target => target === '/gallery')).toHaveLength(1)
        expect(dom.window.document.querySelector('article p').textContent).toBe('The complete public reporting is already available.')
        expect(dom.window.document.querySelector('article figure img')?.getAttribute('src')).toBe('/gallery-photo.png')
        expect(dom.window.document.querySelector('[data-gallery-pending]')).toBeNull()
        expect(value.html).not.toContain('Carregando galeria.')
      } finally { dom.window.close() }
    } finally { await renderer?.dispose(); await owned.close() }
  }, 30000)

  it('retains an unresolved adapter pendingSelector with content-not-ready diagnostics after its timeout', async () => {
    const owned = await fixture((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<title>Pending gallery report</title><article><p>The complete public reporting is already available.</p><div data-gallery-pending>Gallery is still loading.</div></article>')
    })
    let renderer
    try {
      const settings = resolveCaptureConfig({ ...config, renderTimeoutMs: 1000, renderWaitMs: 0, scrollWaitMs: 0, adapters: [{ id: 'pending-gallery-fixture-v1', hosts: ['127.0.0.1'], articleSelector: 'article', pendingSelector: '[data-gallery-pending]' }] })
      renderer = new CaptureRenderer(settings, { loadChromium: loadFixtureChromium, request: createPublicRequest(settings, { networkPolicy: owned.policy }) })
      const value = await renderer.render(`${owned.origin}/article`)
      expect(value.diagnostics).toContain('content-not-ready')
      expect(value.html).toContain('The complete public reporting is already available.')
      const dom = new JSDOM(value.html)
      try { expect(dom.window.document.querySelector('[data-gallery-pending]')?.textContent).toBe('Gallery is still loading.') }
      finally { dom.window.close() }
    } finally { await renderer?.dispose(); await owned.close() }
  }, 30000)

  it('projects rendered article content within budget after discarding large application state scripts', async () => {
    const paragraphs = ['Public reporting introduces the travel options.', 'The final paragraph explains how to compare them.']
    const items = ['First destination and its public transport.', 'Second destination and its cultural spaces.']
    const metadata = { '@context': 'https://schema.org', '@type': 'NewsArticle', headline: 'Public travel report', isAccessibleForFree: true }
    const markup = `<title>Public travel report</title><script type="application/ld+json">${JSON.stringify(metadata)}</script><article><h1>Public travel report</h1>${paragraphs.map(text => `<p>${text}</p>`).join('')}<ol>${items.map(text => `<li>${text}</li>`).join('')}</ol></article><script>const state=document.createElement('script');state.id='client-state';state.type='application/json';state.textContent=JSON.stringify({cache:'x'.repeat(20000)});document.body.append(state)</script>`
    const settings = resolveCaptureConfig({ ...config, renderWaitMs: 0, scrollWaitMs: 0, maxScrollSteps: 1, maxArticleHtmlBytes: 12000, maxArticleHtmlChars: 12000 })
    expect(Buffer.byteLength(markup)).toBeLessThan(settings.maxArticleHtmlBytes)
    const owned = await fixture((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(markup) })
    const renderer = new CaptureRenderer(settings, { loadChromium: loadFixtureChromium, request: createPublicRequest(settings, { networkPolicy: owned.policy }) })
    try {
      const value = await renderer.render(`${owned.origin}/article`)
      expect(value.html.length).toBeLessThanOrEqual(settings.maxArticleHtmlChars)
      expect(Buffer.byteLength(value.html)).toBeLessThanOrEqual(settings.maxArticleHtmlBytes)
      const dom = new JSDOM(value.html)
      try {
        const document = dom.window.document
        expect([...document.querySelectorAll('article p')].map(element => element.textContent)).toEqual(paragraphs)
        expect([...document.querySelectorAll('article ol > li')].map(element => element.textContent)).toEqual(items)
        expect(JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent)).toEqual(metadata)
        expect(document.querySelector('#client-state')).toBeNull()
        expect(document.querySelector('script:not([type="application/ld+json"])')).toBeNull()
      } finally { dom.window.close() }
    } finally { await renderer.dispose(); await owned.close() }
  }, 30000)

  it('retains the main document subscription decision before page scripts hide the wall', async () => {
    const owned = await fixture((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<title>Subscriber story</title><script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":"False"}</script><article><p>Public teaser only.</p><div class="paywall"></div></article><script>document.querySelector(".paywall").hidden=true</script>')
    })
    const capture = createCapture(config, { loadChromium: loadFixtureChromium, networkPolicy: owned.policy })
    try { await expect(capture.capture(`${owned.origin}/article`)).rejects.toThrow('article-restricted') }
    finally { await capture.dispose(); await owned.close() }
  }, 30000)

  it('retains refused HTTP exchanges when recording without article extraction', async () => {
    const owned = await fixture((req, res) => { res.writeHead(403, { 'content-type': 'text/html' }); res.end('Refused') })
    const settings = resolveCaptureConfig({ ...config, renderWaitMs: 0 })
    const renderer = new CaptureRenderer(settings, { loadChromium: loadFixtureChromium, request: createPublicRequest(settings, { networkPolicy: owned.policy }) }), exchanges = []
    try {
      const value = await renderer.render(`${owned.origin}/article`, { markup: false, onExchange: exchange => exchanges.push(exchange) })
      expect(value.statusCode).toBe(403)
      expect(exchanges.some(exchange => exchange.response.status === 403)).toBe(true)
    } finally { await renderer.dispose(); await owned.close() }
  }, 30000)

  it('recognizes paragraph-based articles without a semantic main container', async () => {
    const owned = await fixture((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<title>公开报道</title><nav><p>导航</p></nav><div id="detailContent"><h1>公开报道</h1><p>第一段公开正文。</p><p>第二段公开正文。</p></div>')
    })
    const capture = createCapture(config, { loadChromium: loadFixtureChromium, networkPolicy: owned.policy }), events = []
    try {
      const { snapshot } = await capture.capture(`${owned.origin}/article`, { onProgress: event => events.push(event) })
      expect(events.some(event => event.event === 'content-ready')).toBe(true)
      expect(snapshot.quality.reasons).not.toContain('content-not-ready')
      expect(snapshot.blocks.filter(block => block.type === 'paragraph')).toHaveLength(2)
    } finally { await capture.dispose(); await owned.close() }
  }, 30000)

  it('retries one anonymous refusal and gives its scoped HttpOnly cookies to page resources', async () => {
    const requests = [], jar = new CookieJar()
    const owned = await fixture((req, res) => {
      requests.push({ url: req.url, cookie: req.headers.cookie ?? '' })
      if (req.url === '/article' && !req.headers.cookie?.includes('access=anonymous')) {
        res.writeHead(403, { 'content-type': 'text/html', 'set-cookie': ['access=anonymous; HttpOnly; Path=/', 'other=private-path; Path=/other'] }); res.end('Anonymous session required'); return
      }
      if (req.url === '/resource.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' }); res.end('document.querySelector("article").append(" Resource loaded.")'); return
      }
      res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Public article</title><article><p>Complete public article.</p></article><script src="/resource.js"></script>')
    })
    const capture = createCapture(config, { jar, loadChromium: loadFixtureChromium, networkPolicy: owned.policy }), events = []
    try {
      const { snapshot } = await capture.capture(`${owned.origin}/article`, { onProgress: event => events.push(event) })
      expect(JSON.stringify(snapshot.blocks)).toContain('Resource loaded.')
      expect(requests.filter(value => value.url === '/article')).toEqual([{ url: '/article', cookie: '' }, { url: '/article', cookie: 'access=anonymous' }])
      expect(requests.find(value => value.url === '/resource.js').cookie).toBe('access=anonymous')
      expect(jar.header(`${owned.origin}/article`)).toBe('access=anonymous')
      expect(JSON.stringify(events)).not.toContain('anonymous;')
      expect(events.some(event => event.event === 'anonymous-session-retry')).toBe(true)
    } finally { await capture.dispose(); await owned.close() }
  }, 30000)

  it('does not loop on a repeated refusal or retry HTTP decisions other than 401/403', async () => {
    const counts = new Map()
    const owned = await fixture((req, res) => {
      const count = (counts.get(req.url) ?? 0) + 1; counts.set(req.url, count)
      res.writeHead(req.url === '/refusal' ? 403 : 429, { 'content-type': 'text/html', 'set-cookie': `access=attempt-${count}; Path=/` }); res.end('Refused')
    })
    const capture = createCapture(config, { loadChromium: loadFixtureChromium, networkPolicy: owned.policy })
    try {
      await expect(capture.capture(`${owned.origin}/refusal`)).rejects.toThrow('article-access')
      await expect(capture.capture(`${owned.origin}/rate-limit`)).rejects.toThrow('article-rate-limit')
      expect(counts.get('/refusal')).toBe(2)
      expect(counts.get('/rate-limit')).toBe(1)
    } finally { await capture.dispose(); await owned.close() }
  }, 30000)

  it('seeds a fresh context from the anonymous jar while preserving cookie paths', async () => {
    const jar = new CookieJar(), requests = []
    const owned = await fixture((req, res) => {
      requests.push({ url: req.url, cookie: req.headers.cookie ?? '' })
      res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Public</title><article><p>Complete public content.</p></article>')
    })
    jar.store(`${owned.origin}/article`, { 'set-cookie': ['access=known; HttpOnly; Path=/', 'limited=other; Path=/other', 'foreign=refused; Domain=example.com; Path=/'] })
    const capture = createCapture(config, { jar, loadChromium: loadFixtureChromium, networkPolicy: owned.policy })
    try {
      await capture.capture(`${owned.origin}/article`)
      expect(requests.filter(value => value.url === '/article')).toEqual([{ url: '/article', cookie: 'access=known' }])
    } finally { await capture.dispose(); await owned.close() }
  }, 30000)

  it('retains a successful main document when unrelated resources fail', async () => {
    const capture = createCapture(config, { loadChromium: loadFixtureChromium, request: async target => {
      if (target.endsWith('/blocked.js')) throw failure('article-url-blocked')
      if (target.endsWith('/slow.js')) throw failure('article-timeout')
      return { url: target, statusCode: 200, mime: 'text/html', headers: { 'content-type': 'text/html' }, bytes: Buffer.from('<title>Article</title><article><p>Public article.</p></article><script src="/blocked.js"></script><script src="/slow.js"></script>') }
    } })
    try {
      const { snapshot } = await capture.capture('https://articles.example.test/story')
      expect(snapshot.quality.reasons).toContain('blocked-network-resource')
      expect(snapshot.quality.reasons).toContain('resource-request-failed')
    } finally { await capture.dispose() }
  }, 30000)

  it('honors a response deleting a seeded HttpOnly cookie before loading resources', async () => {
    const jar = new CookieJar(), resources = []
    const owned = await fixture((req, res) => {
      if (req.url === '/resource.js') {
        resources.push(req.headers.cookie ?? '')
        res.writeHead(200, { 'content-type': 'application/javascript' }); res.end(''); return
      }
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'access=deleted; Max-Age=0; HttpOnly; Path=/' })
      res.end('<title>Public</title><article><p>Complete public article.</p></article><script src="/resource.js"></script>')
    })
    jar.store(`${owned.origin}/article`, { 'set-cookie': 'access=known; HttpOnly; Path=/' })
    const capture = createCapture(config, { jar, loadChromium: loadFixtureChromium, networkPolicy: owned.policy })
    try {
      await capture.capture(`${owned.origin}/article`)
      expect(resources).toEqual([''])
      expect(jar.header(`${owned.origin}/article`)).toBeUndefined()
    } finally { await capture.dispose(); await owned.close() }
  }, 30000)

  it.each(['article-network', 'article-timeout', 'article-redirect', 'article-url-blocked', 'article-resource-limit'])('preserves the main-document failure %s', async code => {
    const capture = createCapture(config, { loadChromium: loadFixtureChromium, request: async () => { throw failure(code) } })
    try { await expect(capture.capture('https://articles.example.test/story')).rejects.toThrow(code) }
    finally { await capture.dispose() }
  }, 30000)

  it('waits beyond resource settling for delayed SPA content and aborts unrelated pending resources', async () => {
    let backgroundClosed = false
    const owned = await fixture((req, res) => {
      if (req.url === '/background') { res.on('close', () => { backgroundClosed = true }); return }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<title>Delayed article</title><style>.not-visible{display:none}</style><main aria-busy="true"></main><script>fetch("/background");setTimeout(()=>{document.querySelector("main").innerHTML="<h1>Delayed article</h1><p>Loaded article content.</p><p class=not-visible>Hidden promotion</p>";document.querySelector("main").removeAttribute("aria-busy")},600)</script>')
    })
    const capture = createCapture(resolveCaptureConfig({ ...config, renderWaitMs: 50 }), { loadChromium: loadFixtureChromium, networkPolicy: owned.policy })
    const events = []
    try {
      const { snapshot } = await capture.capture(`${owned.origin}/article`, { onProgress: value => events.push(value) })
      expect(JSON.stringify(snapshot.blocks)).toContain('Loaded article content.')
      expect(JSON.stringify(snapshot.blocks)).not.toContain('Hidden promotion')
      expect(events.some(value => value.event === 'content-ready')).toBe(true)
      expect(snapshot.quality.reasons).not.toContain('content-not-ready')
      await expect.poll(() => backgroundClosed).toBe(true)
    } finally { await capture.dispose(); await owned.close() }
  }, 30000)

  it('reports empty SPA content as a loading failure with diagnostic measurements', async () => {
    const owned = await fixture((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Loading</title><main></main>') })
    const capture = createCapture(resolveCaptureConfig({ ...config, renderTimeoutMs: 1000, renderWaitMs: 10 }), { loadChromium: loadFixtureChromium, networkPolicy: owned.policy })
    const events = []
    try {
      await expect(capture.capture(`${owned.origin}/article`, { onProgress: value => events.push(value) })).rejects.toThrow('article-content-not-ready')
      expect(events.find(value => value.event === 'render-complete')).toMatchObject({ details: { statusCode: 200, chars: 0, diagnostics: expect.arrayContaining(['content-not-ready']) } })
    } finally { await capture.dispose(); await owned.close() }
  }, 30000)
  it('reports a missing executable without silently falling back to static HTTP', async () => {
    let requests = 0
    const capture = createCapture(config, { loadChromium: async () => ({ launch: async () => { throw new Error('Executable missing') } }), request: async () => { requests++; throw new Error('must not fetch') } })
    try {
      expect(await capture.readiness()).toEqual({ available: false, code: 'article-render-unavailable' })
      await expect(capture.capture('https://articles.example.test/a')).rejects.toThrow('article-render-unavailable')
      expect(requests).toBe(0)
    } finally { await capture.dispose() }
  })

  it('captures delayed text, responsive and lazy originals, with quiescent browser teardown', async () => {
    const requests = [], image = png()
    const owned = await fixture((req, res) => {
      requests.push(req.url)
      if (req.url.startsWith('/image')) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(image); return }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<html lang="zh-CN"><head><title>真实浏览器文章</title></head><body><nav>导航菜单</nav><article><h1>真实浏览器文章</h1><p>静态引言本身已足够长，仍必须获取脚本加载的结尾。</p><picture><source srcset="/image-small.png 320w, /image-large.png 1280w"><img src="/image-small.png" alt="正文原图"></picture><div style="height:1500px"></div><figure><img data-src="/image-lazy.png" alt="延迟图片"><figcaption>图注</figcaption></figure><div id="tail" aria-busy="true"></div></article><footer>页脚</footer><script>setTimeout(() => {document.querySelector('#tail').innerHTML='<p>脚本异步加载的正文尾段。</p>';document.querySelector('#tail').removeAttribute('aria-busy')}, 50)</script></body></html>`)
    })
    const capture = createCapture(config, { loadChromium: loadFixtureChromium, networkPolicy: owned.policy, adapter: { id: 'owned-fixture-v1', match: url => url.startsWith(owned.origin),
      verify: ({ snapshot }) => snapshot.blocks.some(block => block.type === 'paragraph' && block.inline.some(run => run.text.includes('正文尾段'))) ? [] : ['missing-tail'] } })
    try {
      expect(await capture.readiness()).toEqual({ available: true })
      const { snapshot, assets } = await capture.capture(`${owned.origin}/article`)
      expect(snapshot.quality).toMatchObject({ status: 'passed', reasons: [], adapter: 'owned-fixture-v1' })
      expect(snapshot.blocks.filter(block => block.type === 'figure')).toHaveLength(2)
      expect(snapshot.blocks.at(-1)).toMatchObject({ type: 'paragraph', inline: [{ text: '脚本异步加载的正文尾段。' }] })
      expect(JSON.stringify(snapshot.blocks)).not.toMatch(/导航菜单|页脚/)
      expect(assets).toHaveLength(1)
      expect(assets[0]).toMatchObject({ bytes: image, width: 64, height: 48, status: 'ready' })
      expect(requests).toContain('/image-large.png')
      expect(requests).toContain('/image-lazy.png')
    } finally { await capture.dispose(); await owned.close() }
    await expect(capture.capture(`${owned.origin}/article`)).rejects.toThrow('article-interrupted')
  }, 30000)

  it('blocks local subresources even when the article fixture is expressly permitted', async () => {
    let privateRequests = 0
    const privateServer = await fixture((req, res) => { privateRequests++; res.end('must stay unread') })
    const owned = await fixture((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<html><title>Safe article</title><article><h1>Safe article</h1><p>Visible article.</p><script src="${privateServer.origin}/secret"></script><img src="${privateServer.origin}/image"></article></html>`)
    })
    const capture = createCapture(config, { loadChromium: loadFixtureChromium, networkPolicy: owned.policy })
    try {
      const result = await capture.capture(`${owned.origin}/article`)
      expect(privateRequests).toBe(0)
      expect(result.snapshot.quality.status).toBe('partial')
      expect(result.snapshot.quality.reasons).toContain('article-url-blocked')
      expect(result.assets).toHaveLength(0)
    } finally { await capture.dispose(); await owned.close(); await privateServer.close() }
  }, 30000)

  it('recovers a missing original through a responsive candidate and decodes the saved bytes', async () => {
    const image = png(), events = []
    const owned = await fixture((req, res) => {
      if (req.url === '/missing.png') { res.writeHead(404); res.end('missing'); return }
      if (req.url === '/valid.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(image); return }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><title>Original fallback</title><article><h1>Original fallback</h1><p>Complete public article.</p><figure><picture><source srcset="/valid.png 1280w"><img data-original="/missing.png" src="/valid.png" alt="Scene"></picture><figcaption>Public credit</figcaption></figure></article></html>')
    })
    const capture = createCapture(config, { loadChromium: loadFixtureChromium, networkPolicy: owned.policy })
    try {
      const result = await capture.capture(`${owned.origin}/article`, { onProgress: event => { events.push(event) } })
      expect(result.assets).toHaveLength(1)
      expect(result.assets[0]).toMatchObject({ bytes: image, width: 64, height: 48, sourceUrl: `${owned.origin}/valid.png` })
      expect(result.snapshot.quality.reasons).not.toContain('image-download')
      expect(result.snapshot.blocks.at(-1)).toMatchObject({ type: 'figure', alt: 'Scene', caption: 'Public credit' })
      expect(events.some(event => event.event === 'image-candidate-selected')).toBe(true)
    } finally { await capture.dispose(); await owned.close() }
  }, 30000)

  it('cancels and awaits an active navigation before disposal completes', async () => {
    let started
    const requestStarted = new Promise(resolve => { started = resolve })
    const owned = await fixture((req, res) => { started(); void res })
    const capture = createCapture(config, { networkPolicy: owned.policy })
    const operation = capture.capture(`${owned.origin}/slow`).then(() => 'unexpected-success', error => error.code)
    try {
      await requestStarted
      await capture.dispose()
      expect(await operation).toBe('article-interrupted')
    } finally { await capture.dispose(); await owned.close() }
  }, 30000)

  it('expands declared read-only article controls and follows only same-article pagination', async () => {
    const requests = []
    const owned = await fixture((req, res) => {
      requests.push(req.url)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      if (req.url === '/article?page=2') {
        res.end('<title>分页文章</title><article data-story="42"><h1>分页文章</h1><p id="end">第二页正文结尾。</p></article><aside><a href="/other">下一篇文章</a></aside>')
      } else res.end('<title>分页文章</title><article data-story="42"><h1>分页文章</h1><p>第一页正文。</p><button type="button" id="expand" aria-expanded="false" aria-controls="more" onclick="document.querySelector(\'#more\').hidden=false;this.setAttribute(\'aria-expanded\',\'true\')">展开全文</button><div id="more" hidden><p>展开后可见的正文。</p></div><a id="next-page" href="?page=2">下一页</a></article><aside><a href="/other">下一篇文章</a></aside>')
    })
    const capture = createCapture(resolveCaptureConfig({ ...config, adapters: [{ id: 'owned-pages-v1', hosts: ['127.0.0.1'], articleSelector: 'article', endSelector: '#end', expandSelector: '#expand', pagination: { nextSelector: '#next-page', identitySelector: 'article', identityAttribute: 'data-story', maxPages: 3 } }] }), { loadChromium: loadFixtureChromium, networkPolicy: owned.policy })
    try {
      const { snapshot } = await capture.capture(`${owned.origin}/article`)
      expect(snapshot.quality).toMatchObject({ status: 'passed', reasons: [] })
      expect(snapshot.pages).toHaveLength(2)
      expect(snapshot.blocks.filter(block => block.type === 'paragraph').map(block => block.inline.map(value => value.text).join(''))).toEqual(['第一页正文。', '展开后可见的正文。', '第二页正文结尾。'])
      expect(requests).not.toContain('/other')
    } finally { await capture.dispose(); await owned.close() }
  }, 30000)

  it('refuses a configured submit or access control as an article expander', async () => {
    let submissions = 0
    const owned = await fixture((req, res) => {
      if (req.url === '/login') submissions++
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<title>Article</title><article><h1>Article</h1><p>Article body.</p><form action="/login"><button id="expand" type="submit">Sign in</button></form><p id="end">Ending.</p></article>')
    })
    const capture = createCapture(resolveCaptureConfig({ ...config, adapters: [{ id: 'owned-expand-v1', hosts: ['127.0.0.1'], articleSelector: 'article', endSelector: '#end', expandSelector: '#expand' }] }), { loadChromium: loadFixtureChromium, networkPolicy: owned.policy })
    try {
      const { snapshot } = await capture.capture(`${owned.origin}/article`)
      expect(snapshot.quality.status).toBe('partial')
      expect(snapshot.quality.reasons).toContain('unsafe-expand-control')
      expect(submissions).toBe(0)
    } finally { await capture.dispose(); await owned.close() }
  }, 30000)
})
