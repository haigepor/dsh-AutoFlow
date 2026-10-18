/** Isolated Chromium renderer whose HTTP resources use address-pinned, bounded transport. */
import { failure, assertArticleStatus } from './contracts.js'
import { captureUrl } from './capture-media.js'
import { CookieJar } from './session.js'
import { JSDOM, VirtualConsole } from 'jsdom'
import { assertDeclaredAccess } from './articles.js'
import { readImageDescriptions } from './capture-image-metadata.js'
import { matchesCaptureAdapter } from './capture-adapters.js'

async function loadChromium() { return (await import('patchright')).chromium }

function safeHeaders(headers) {
  // Playwright 将换行分隔的 Set-Cookie 拆成多个响应头；逗号会破坏 Expires 与 Cookie 作用域。
  return Object.fromEntries(Object.entries(headers).filter(([key, value]) => value !== undefined && !['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(key.toLowerCase())).map(([key, value]) => [key, Array.isArray(value) ? value.join(key.toLowerCase() === 'set-cookie' ? '\n' : ', ') : String(value)]))
}

/** Keep a bounded textual copy of a response for recording; binary payloads record size only. @param {object} response Pinned transport response. @returns {string|undefined} Body text. */
function recordedBody(response) {
  const type = (response.mime ?? '').toLowerCase()
  if (!type.includes('json') && !type.startsWith('text/') && !type.includes('x-www-form-urlencoded')) return undefined
  return response.bytes.toString('utf8').slice(0, 262144)
}

function contentReady({ selector, fallback, minArticleChars }) {
  let root = document.querySelector(selector)
  if (!root && fallback) {
    // 只用正文段落寻找非语义容器；导航、广告或隐藏段落不能令空 SPA 提前就绪。
    const candidates = new Map()
    for (const paragraph of document.querySelectorAll('body p')) {
      if (paragraph.closest('nav,aside,header,footer,form,[role="navigation"],[role="complementary"],[hidden],[aria-hidden="true"],.advertisement,.advert,.related,.comments') || getComputedStyle(paragraph).display === 'none') continue
      const parent = paragraph.parentElement
      candidates.set(parent, (candidates.get(parent) ?? 0) + paragraph.textContent.trim().length)
    }
    const candidate = [...candidates].sort((a, b) => b[1] - a[1])[0]
    if (candidate?.[1] >= minArticleChars) root = candidate[0]
  }
  const content = root
  const ready = Boolean(content && content.textContent.trim() && !content.matches('[aria-busy="true"],[data-loading="true"]') && !content.querySelector('[aria-busy="true"],[data-loading="true"]'))
  if (ready && fallback) content.setAttribute('data-ai-content-root', '')
  return ready
}

function scrollArticle(selector) {
  const root = document.querySelector(selector) ?? document.body
  const end = root.getBoundingClientRect().bottom + window.scrollY
  const next = Math.min(window.scrollY + window.innerHeight * 0.8, end)
  window.scrollTo(0, next)
  return { atEnd: window.scrollY + window.innerHeight >= end - 2, height: end }
}

/** Render and decode with one owned browser and a fresh context for each operation. */
export class CaptureRenderer {
  /** @param {object} config Resolved limits. @param {object} dependencies Bounded transport, optional launcher and session jar. */
  constructor(config, dependencies) {
    this.config = config; this.request = dependencies.request; this.loadChromium = dependencies.loadChromium ?? loadChromium
    // 录制浏览器与静态抓取共用同一个 cookie jar：站点在 XHR 里下发的会话，后续渲染要带上。
    this.jar = dependencies.jar ?? new CookieJar()
    this.launching = null; this.contexts = new Set(); this.inspectors = new Set(); this.renderSessions = new Set(); this.disposed = false; this.disposing = null
  }

  async ensureBrowser() {
    if (this.disposed) throw failure('article-interrupted')
    if (!this.launching) this.launching = this.loadChromium().then(chromium => chromium.launch({ headless: this.config.renderHeadless, timeout: this.config.renderTimeoutMs,
      // WebRTC 可绕开 HTTP 拦截；此 context 不需要点对点网络或后台组件流量。
      args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-background-networking', '--disable-component-update', '--disable-quic'],
    })).catch(error => { void error; this.launching = null; throw failure('article-render-unavailable') })
    return this.launching
  }

  /** Probe the actual browser executable without installing or using a persistent profile. @returns {Promise<object>} Readiness. */
  async readiness() {
    try { await this.ensureBrowser(); if (this.disposed) throw failure('article-interrupted'); return { available: true } }
    catch (error) { return { available: false, code: error.code ?? 'article-render-unavailable' } }
  }

  async context() {
    const browser = await this.ensureBrowser()
    if (this.disposed) throw failure('article-interrupted')
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false })
    if (this.disposed) { await context.close().catch(error => { void error }); throw failure('article-interrupted') }
    this.contexts.add(context)
    return context
  }

  /** Render with isolated pinned resource connections, scoped anonymous cookies and at most one main-document session retry. Adapter-declared deferred types apply only to markup capture; recording keeps every resource. Transport failures keep their safe codes. @param {string} input URL. @param {object} options Cancellation, progress, exchange recording and markup switch. @returns {Promise<object>} Rendered markup and diagnostics after bounded loading and scrolling. */
  async render(input, { signal, onProgress, onExchange, markup = true } = {}) {
    captureUrl(input)
    if (signal?.aborted) throw failure('article-interrupted')
    const context = await this.context(), pending = new Set(), diagnostics = new Set(), deferredResources = new Set()
    const requests = new AbortController(), requestSignal = AbortSignal.any([requests.signal, ...(signal ? [signal] : [])])
    const started = Date.now()
    let reportedResources = 0
    const report = async (event, details = {}) => { await onProgress?.({ phase: 'rendering', event, details: { elapsedMs: Date.now() - started, ...details } }) }
    // 录制与抽取解耦：请求在 route 回调内即可交付，页面抽取失败也已完成录制。
    const record = async entry => {
      if (!onExchange) return
      try { await onExchange(entry) } catch (error) { void error }
    }
    let adapter = this.config.adapters.find(adapter => matchesCaptureAdapter(adapter, input))
    let selector = adapter?.articleSelector ?? 'article,main,[role="main"],[data-ai-content-root]'
    let finalUrl = input, statusCode = 0, page, navigationError = null, aborting = Promise.resolve(), resourceSession
    const aborted = () => { aborting = context.close().catch(error => { void error }) }
    signal?.addEventListener('abort', aborted, { once: true })
    try {
      if (this.disposed || signal?.aborted) { aborted(); throw failure('article-interrupted') }
      resourceSession = this.request.createSession?.({ poolSize: this.config.rendererConnectionPoolSize, connectionsPerOrigin: this.config.rendererConnectionsPerOrigin })
      if (resourceSession) this.renderSessions.add(resourceSession)
      // domain 无前导点保留 host-only，避免把仅供单主机使用的匿名 Cookie 扩散到子域。
      const cookies = this.jar.matching(input).map(cookie => ({ name: cookie.name, value: cookie.value,
        domain: cookie.hostOnly ? cookie.domain : `.${cookie.domain}`, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
        ...(cookie.expires === null ? {} : { expires: Math.floor(cookie.expires / 1000) }),
      }))
      if (cookies.length) await context.addCookies(cookies)
      await context.routeWebSocket('**/*', socket => socket.close())
      await context.route('**/*', route => {
        const operation = (async () => {
          const request = route.request(), type = request.resourceType(), navigation = type === 'document' && request.isNavigationRequest() && request.frame() === page.mainFrame()
          const requestStarted = Date.now()
          try {
            if (!['GET', 'HEAD'].includes(request.method())) {
              // 非只读请求不代发，但它的方法、头与请求体仍要进入录制：登录与写接口正是逆向面最需要的端点。
              await record({
                startedAt: requestStarted, timingMs: 0, resourceType: type, sent: false, blocked: 'article-resource-method',
                request: { method: request.method(), url: request.url(), headers: { ...request.headers() }, body: request.postData() ?? undefined },
                response: { status: 0, headers: {}, mime: '', bodyBytes: 0 },
              })
              throw failure('article-resource-method')
            }
            if (markup && !navigation && adapter?.browserResources?.deferTypes.includes(type)) {
              // 只延迟站点显式批准的浏览器资源；保留 DOM 来源供后续正文和原图提取。
              await record({ startedAt: requestStarted, timingMs: Date.now() - requestStarted, resourceType: type, sent: false, blocked: 'article-resource-deferred',
                request: { method: request.method(), url: request.url(), headers: { ...request.headers() } }, response: { status: 0, headers: {}, mime: '', bodyBytes: 0 } })
              if (!deferredResources.has(type) && deferredResources.size < this.config.maxResourceDiagnostics) {
                deferredResources.add(type)
                await report('resource-deferred', { resourceType: type, origin: new URL(request.url()).origin })
              }
              await route.abort(); return
            }
            // route.fulfill 绕过了浏览器的网络栈，浏览器算出的 Cookie 头必须显式带上；
            // 否则页面脚本用 document.cookie 建立的会话，在后续子资源请求里会丢失。
            // headers() 可省略 HttpOnly Cookie；allHeaders() 才包含浏览器实际选定的请求头。
            const requestHeaders = await request.allHeaders(), responseCookies = []
            let cookie = requestHeaders.cookie, response
            for (let attempt = 0; attempt < 2; attempt++) {
              response = await (resourceSession ?? this.request)(request.url(), { signal: requestSignal, method: request.method(), maxBytes: type === 'image' ? this.config.maxImageBytes : this.config.maxArticleHtmlBytes, headers: cookie ? { cookie } : undefined })
              const stored = this.jar.store(response.url ?? request.url(), response.headers)
              if (response.headers?.['set-cookie']) responseCookies.push(...[response.headers['set-cookie']].flat())
              await record({
                startedAt: requestStarted, timingMs: Date.now() - requestStarted, resourceType: type, sent: true,
                request: { method: request.method(), url: request.url(), headers: { ...requestHeaders, ...(cookie ? { cookie } : {}) }, body: request.postData() ?? undefined },
                response: { status: response.statusCode, headers: { ...(response.headers ?? {}) }, mime: response.mime, bodyBytes: response.bytes.length, body: recordedBody(response), location: response.headers?.location },
              })
              const nextCookie = this.jar.header(request.url())
              // 只重试主文档的新匿名会话；相同 Cookie、访问决定和第二次拒绝不会继续重试。
              if (!navigation || attempt !== 0 || ![401, 403].includes(response.statusCode) || !stored || !nextCookie || nextCookie === cookie) break
              cookie = nextCookie
              await report('anonymous-session-retry', { statusCode: response.statusCode, origin: new URL(request.url()).origin })
            }
            // 首次拒绝的 Cookie 也交给隔离 context，供后续只读子资源使用并保留删除/过期语义。
            if (responseCookies.length) response = { ...response, headers: { ...response.headers, 'set-cookie': responseCookies } }
            if (markup && navigation && response.statusCode === 200 && response.mime === 'text/html') {
              // 页面脚本可隐藏计量墙；原始主文档的访问决定不能被后续 DOM 改写抹掉。
              const dom = new JSDOM(response.bytes.toString('utf8'), { virtualConsole: new VirtualConsole() })
              try { assertDeclaredAccess(dom.window.document) } finally { dom.window.close() }
            }
            if (navigation) {
              finalUrl = response.url; statusCode = response.statusCode
              // 同源跳转也可能切换页面模板；在子资源开始和正文等待前重新选择规则。
              adapter = this.config.adapters.find(adapter => matchesCaptureAdapter(adapter, finalUrl))
              selector = adapter?.articleSelector ?? 'article,main,[role="main"],[data-ai-content-root]'
              await report('document-loaded', { statusCode, bytes: response.bytes.length, origin: new URL(finalUrl).origin })
            }
            else if (response.statusCode >= 400 && reportedResources++ < this.config.maxResourceDiagnostics) await report('resource-http-error', { statusCode: response.statusCode, resourceType: type, origin: new URL(request.url()).origin })
            let body = response.bytes
            // 传输层自行跟随且校验跳转；base 保持最终文档中相对资源的原始含义。
            if (navigation && response.url !== request.url() && response.mime === 'text/html') {
              const escaped = response.url.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
              body = Buffer.from(body.toString('utf8').replace(/<head(?:\s[^>]*)?>/i, match => `${match}<base href="${escaped}">`))
            }
            await route.fulfill({ status: response.statusCode, headers: safeHeaders(response.headers ?? { 'content-type': response.mime }), body })
          } catch (error) {
            if (navigation) navigationError = error
            if (!requestSignal.aborted) {
              diagnostics.add(error?.code === 'article-url-blocked' ? 'blocked-network-resource' : 'resource-request-failed')
              if (reportedResources++ < this.config.maxResourceDiagnostics) await report('resource-failed', { code: error?.code ?? 'article-network', resourceType: type, origin: new URL(request.url()).origin })
            }
            await route.abort().catch(error => { void error })
            if (navigation) throw error
          }
        })()
        // route 回调失败通过导航结果和诊断呈现；避免浏览器关闭后的异步拒绝泄漏到下一任务。
        pending.add(operation)
        return operation.catch(error => { void error }).finally(() => pending.delete(operation))
      })
      page = await context.newPage()
      page.on('popup', popup => { void popup.close().catch(error => { void error }) })
      await report('navigation-start', { limitMs: this.config.renderTimeoutMs, origin: new URL(input).origin })
      try { await page.goto(input, { waitUntil: 'domcontentloaded', timeout: this.config.renderTimeoutMs }) }
      catch (error) {
        if (signal?.aborted || this.disposed) throw failure('article-interrupted')
        // 子资源的失败不能覆盖主文档；只透传由受控 HTTP 传输产生的安全错误码。
        if (/^article-[a-z-]+$/.test(navigationError?.code ?? '')) throw Object.assign(failure(navigationError.code), { cause: navigationError })
        throw failure(error.name === 'TimeoutError' ? 'article-timeout' : 'article-render')
      }
      if (markup) assertArticleStatus(statusCode)
      if (adapter?.expandSelector) {
        const unsafe = await page.evaluate(({ expandSelector, articleSelector }) => {
          const article = document.querySelector(articleSelector)
          let unsafe = false
          for (const element of document.querySelectorAll(expandSelector)) {
            if (!article?.contains(element) || element.closest('form') || /(?:captcha|verify|human|sign\s*in|log\s*in|subscribe|登录|验证|付费)/iu.test(element.textContent)) { unsafe = true; continue }
            if (element.tagName === 'DETAILS') { element.open = true; continue }
            const ids = (element.getAttribute('aria-controls') ?? '').split(/\s+/).filter(Boolean)
            if (element.tagName !== 'BUTTON' || element.getAttribute('type') !== 'button' || element.getAttribute('aria-expanded') !== 'false' || !ids.length || ids.some(id => !article.contains(document.getElementById(id)))) { unsafe = true; continue }
            element.click()
          }
          return unsafe
        }, { expandSelector: adapter.expandSelector, articleSelector: selector })
        if (unsafe) diagnostics.add('unsafe-expand-control')
      }
      if (this.config.renderWaitMs > 0) {
        // SPA 的正文等待使用导航总预算；短暂的资源稳定窗口不能替代正文就绪条件。
        await report('waiting-content')
        try { await page.waitForFunction(contentReady, { selector, fallback: !adapter, minArticleChars: this.config.minArticleChars }, { timeout: Math.max(1, this.config.renderTimeoutMs - (Date.now() - started)) }); await report('content-ready') }
        catch (error) { if (signal?.aborted) throw failure('article-interrupted'); void error; diagnostics.add('content-not-ready'); await report('content-not-ready') }
      }
      let atEnd = false
      for (let index = 0; index < this.config.maxScrollSteps; index++) {
        const state = await page.evaluate(scrollArticle, selector)
        if (this.config.scrollWaitMs > 0) await page.waitForTimeout(this.config.scrollWaitMs)
        if (state.atEnd) { atEnd = true; break }
      }
      if (!atEnd) diagnostics.add('scroll-budget-exhausted')
      // 图库常在进入视口后才请求图片；沿用导航总预算等待已配置的加载占位消失。
      if (adapter?.pendingSelector) {
        await report('waiting-content')
        try {
          await page.waitForFunction(({ selector, pending }) => {
            const root = document.querySelector(selector)
            return Boolean(root) && !root.querySelector(pending)
          }, { selector, pending: adapter.pendingSelector }, { timeout: Math.max(1, this.config.renderTimeoutMs - (Date.now() - started)) })
          await report('content-ready')
        } catch (error) {
          if (signal?.aborted) throw failure('article-interrupted')
          void error; diagnostics.add('content-not-ready'); await report('content-not-ready')
        }
      }
      // 等待窗口用于异步正文与图片加载；完成性由提取器/适配器判定，不能由 idle 或字数代替。
      if (this.config.renderWaitMs > 0) {
        try { await page.waitForLoadState('networkidle', { timeout: this.config.renderWaitMs }) }
        catch (error) { if (signal?.aborted) throw failure('article-interrupted'); void error; diagnostics.add('unsettled-resources') }
      }
      const annotated = await page.evaluate(limit => {
        const elements = document.querySelectorAll('body *')
        if (elements.length > limit) return false
        for (const image of document.querySelectorAll('img')) {
          // 相同 src 不重复写入；内联原图可达数 MB，重复属性会平白占用两倍 HTML 预算。
          if (image.currentSrc && image.currentSrc !== image.getAttribute('src')) image.setAttribute('data-ai-current-src', image.currentSrc)
          else image.removeAttribute('data-ai-current-src')
        }
        // 仅标注 display:none 的元素。visibility:hidden 常被站点在加载后用于隐藏正文容器，
        // 标注后会被提取阶段删除，反而丢掉整篇正文；屏幕外但可滚动到的正文同样保留。
        for (const element of elements) {
          if (getComputedStyle(element).display === 'none') element.setAttribute('data-ai-hidden', 'true')
        }
        return true
      }, this.config.maxArticleElements)
      if (!annotated) throw failure('article-extraction')
      // Patchright 默认隔离世界看不到站点全局变量；仅此处在主世界按声明路径读取自有数据属性。
      const captionDeclarations = adapter?.captionSources?.some(rule => rule.metadata) ? await page.evaluate(({ rules, url, limit }) => {
        const get = (value, path) => path.reduce((node, key) => node && typeof node === 'object' ? Object.getOwnPropertyDescriptor(node, key)?.value : undefined, value)
        return rules.flatMap((rule, ruleIndex) => {
          if (!rule.metadata) return []
          const metadata = rule.metadata
          try {
            const value = get(window, metadata.globalPath), identity = get(value, metadata.identityPath)
            if (typeof identity !== 'string' || identity.length > 16384 || new URL(identity, url).href !== url) throw new Error('identity')
            const tracks = get(value, metadata.tracksPath)
            if (!Array.isArray(tracks) || tracks.length > limit) throw new Error('tracks')
            const sources = tracks.filter(track => get(track, [metadata.formatKey]) === metadata.formatValue).map(track => get(track, [metadata.urlKey]))
            if (!sources.length || sources.length > limit || sources.some(source => typeof source !== 'string' || source.length > 16384)) throw new Error('sources')
            const posterUrl = metadata.poster && get(value, metadata.poster.urlPath), posterTitle = metadata.poster && get(value, metadata.poster.titlePath)
            const poster = typeof posterUrl === 'string' && posterUrl.length <= 16384 && typeof posterTitle === 'string' && posterTitle.length <= 2000 ? { url: posterUrl, title: posterTitle } : undefined
            return [{ ruleIndex, identity: new URL(identity, url).href, sources, ...(poster ? { poster } : {}) }]
          } catch (error) { void error; return [{ ruleIndex, code: 'article-extraction', sources: [] }] }
        })
      }, { rules: adapter.captionSources, url: finalUrl, limit: this.config.maxEmbeddedSources }, undefined, false) : []
      if (!markup) {
        await report('render-complete', { statusCode, bytes: 0, chars: 0, diagnostics: [...diagnostics], extracted: false })
        return { html: '', url: finalUrl, statusCode, diagnostics: [...diagnostics] }
      }
      // 脚本已经执行；序列化正文投影时剔除运行状态，保留访问声明与原图来源。
      const imageDescriptions = await readImageDescriptions(page, finalUrl, this.config)
      if (imageDescriptions.length) await report('image-metadata-complete', { assets: imageDescriptions.length })
      // 原始响应仍受下载预算限制；此处不修改正在运行的页面或网络回放材料。
      const html = await page.evaluate(() => {
        const projection = document.documentElement.cloneNode(true)
        for (const node of projection.querySelectorAll('script:not([type="application/ld+json"]),style')) {
          if (!node.getAttribute('src')?.includes('/cdn-cgi/challenge-platform/')) node.remove()
        }
        return '<!DOCTYPE html>\n' + projection.outerHTML
      })
      if (html.length > this.config.maxArticleHtmlChars || Buffer.byteLength(html) > this.config.maxArticleHtmlBytes) throw failure('article-truncated')
      const chars = await page.evaluate(selector => (document.querySelector(selector)?.textContent ?? '').trim().length, selector)
      if (this.disposed || signal?.aborted) throw failure('article-interrupted')
      await report('render-complete', { statusCode, bytes: Buffer.byteLength(html), chars, diagnostics: [...diagnostics] })
      return { html, url: finalUrl, statusCode, diagnostics: [...diagnostics], captionDeclarations, imageDescriptions }
    } finally {
      signal?.removeEventListener('abort', aborted)
      // HTML 已取得或导航已失败，终止本次 context 尚未完成的 HTTP 请求再等待收尾。
      requests.abort()
      await context.close().catch(error => { void error })
      await aborting
      try { await resourceSession?.dispose(); await Promise.allSettled([...pending]) }
      finally { this.contexts.delete(context); if (resourceSession) this.renderSessions.delete(resourceSession) }
    }
  }

  /** Decode raster bytes with Chromium; MIME alone is insufficient. @param {Buffer} bytes Asset bytes. @param {string} mime MIME. @param {AbortSignal} signal Cancellation. @returns {Promise<object>} Decoded dimensions. */
  async inspectImage(bytes, mime, signal) {
    const inspector = await this.createImageInspector(signal)
    try { return await inspector.inspect(bytes, mime) }
    finally { await inspector.dispose() }
  }

  /** Reuse one network-isolated blank page for one article's sequential decodes. @param {AbortSignal} signal Cancellation. @returns {Promise<object>} Inspector with quiescent disposal. */
  async createImageInspector(signal) {
    if (signal?.aborted || this.disposed) throw failure('article-interrupted')
    const context = await this.context()
    const pending = new Set(), renderer = this
    let closed = false, disposing, page, tail = Promise.resolve()
    const inspector = {
      inspect(bytes, mime) {
        const operation = tail.then(async () => {
          if (closed || signal?.aborted || renderer.disposed) throw failure('article-interrupted')
          try { return await page.evaluate(async ({ base64, mime }) => {
            const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0))
            const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }))
            const result = { width: bitmap.width, height: bitmap.height }
            bitmap.close()
            return result
          }, { base64: bytes.toString('base64'), mime }) }
          catch (error) { if (closed || signal?.aborted || renderer.disposed) throw failure('article-interrupted'); throw error }
        })
        tail = operation.then(() => {}, () => {})
        pending.add(operation); operation.then(() => pending.delete(operation), () => pending.delete(operation))
        return operation
      },
      dispose() {
        if (!disposing) {
          closed = true; signal?.removeEventListener('abort', abort)
          disposing = (async () => {
            await context.close().catch(error => { void error })
            await Promise.allSettled([...pending]); renderer.contexts.delete(context); renderer.inspectors.delete(inspector)
          })()
        }
        return disposing
      },
    }
    const abort = () => { void inspector.dispose() }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      if (signal?.aborted || this.disposed) throw failure('article-interrupted')
      await context.route('**/*', route => route.abort())
      page = await context.newPage()
      if (closed || signal?.aborted || this.disposed) throw failure('article-interrupted')
      this.inspectors.add(inspector)
      return inspector
    } catch (error) { await inspector.dispose(); throw error }
  }

  /** Close every context and await the owned browser, including a launch in progress. @returns {Promise<void>} Quiescent teardown. */
  async dispose() {
    if (this.disposing) return this.disposing
    this.disposed = true
    this.disposing = (async () => {
      await Promise.allSettled([...this.renderSessions].map(session => session.dispose()))
      await Promise.allSettled([...this.inspectors].map(inspector => inspector.dispose()))
      await Promise.allSettled([...this.contexts].map(context => context.close()))
      const launching = this.launching; this.launching = null
      if (launching) { try { await (await launching).close() } catch (error) { void error } }
    })()
    return this.disposing
  }
}
