/** Optional browser rendering through the Playwright engine for pages that reject static HTTP retrieval. */
import { failure } from './contracts.js'
import { pruneDocument } from './prune.js'

const BLOCKED_ASSETS = new Set(['image', 'media', 'font'])

/** True once the article region holds minChars of text; pages without a content root pass immediately. Runs inside the rendered page. @param {number} minChars Threshold. @returns {boolean} Content state. */
function articleContentPresent(minChars) {
  const root = document.querySelector('main') ?? document.querySelector('article')
  return root === null || (root.innerText ?? '').trim().length >= minChars
}

/** Read the laid-out text of the page's own article region, or report that it has none. Runs inside the rendered page. @returns {{text: string, contentRoot: boolean, title: string}} Visible projection. */
function visibleArticle() {
  const root = document.querySelector('main') ?? document.querySelector('article') ?? document.querySelector('[role="main"]')
  // 没有正文区域时整页文本只是站点框架（导航、cookie 栏、页脚）。返回 body 文本但标记出来，
  // 让调用方知道这份文本不能当正文，而不是把框架当成文章。
  const target = root ?? document.body
  // 可见投影没有标记可读，标题只能取自文档；正文首部的清理需要它来识别并跳过标题行。
  return { text: (target?.innerText ?? '').trim(), contentRoot: root !== null, title: document.title }
}

/** True once two DOM samples taken a polling interval apart agree within 1%; runs inside the rendered page. @returns {boolean} Settled state. */
function domSettled() {
  const size = document.documentElement.outerHTML.length
  const previous = window.__articleImagePreviousSize
  window.__articleImagePreviousSize = size
  return previous !== undefined && Math.abs(size - previous) <= size * 0.01
}

/** Load the Playwright engine on first use. @returns {Promise<object>} Chromium launcher. */
async function loadChromium() {
  const { chromium } = await import('patchright')
  return chromium
}

/**
 * One shared browser renders pages for this service.
 * Pages that static retrieval cannot read are re-visited through the Playwright engine
 * with a real Chromium session, so the existing extraction pipeline decides content —
 * the renderer only produces HTML.
 */
export class Renderer {
  /** @param {object} config Deployment settings. @param {object} dependencies Test overrides and the shared cookie jar. */
  constructor(config, dependencies = {}) {
    this.config = config
    this.loadChromium = dependencies.loadChromium ?? loadChromium
    this.jar = dependencies.jar ?? null
    this.launching = null
    this.disposed = false
    this.disposing = null
    this.active = new Set()
  }

  /** Launch once and share the browser; concurrent renders await the same launch. @returns {Promise<object>} Browser or persistent context. */
  ensureBrowser() {
    if (this.disposed) throw failure('article-interrupted')
    if (!this.launching) this.launching = this.launch().catch(error => { this.launching = null; throw error })
    return this.launching
  }

  /** Start the browser, applying the persistent profile when configured. @returns {Promise<object>} Browser or persistent context. */
  async launch() {
    let chromium
    try {
      chromium = await this.loadChromium()
      const options = { headless: this.config.renderHeadless }
      if (this.config.renderUserDataDir) {
        const context = await chromium.launchPersistentContext(this.config.renderUserDataDir, options)
        if (this.config.renderBlockAssets) await this.blockAssets(context)
        return context
      }
      return await chromium.launch(options)
    } catch (error) {
      // 包缺失、浏览器二进制缺失与启动失败都落到同一可操作错误码：渲染层不可用。
      void error
      throw failure('article-render-unavailable')
    }
  }

  /** Abort image, media and font requests to make renders cheaper; scripts and data stay enabled. @param {object} context Browser or persistent context. @returns {Promise<void>} Completion after the route is installed. */
  blockAssets(context) {
    return context.route('**/*', route => BLOCKED_ASSETS.has(route.request().resourceType()) ? route.abort() : route.continue())
  }

  /**
   * Render one URL and return both projections of the same document.
   * `html` is the pruned serialized DOM for Readability; `visible` is the live text content
   * after layout, which keeps text that serialization drops.
   * @param {string} url Article URL. @param {AbortSignal|undefined} signal Cancellation. @returns {Promise<object>} Page result with both projections.
   */
  async render(url, signal) {
    if (this.disposed || signal?.aborted) throw failure('article-interrupted')
    const pending = this.renderPage(url, signal).catch(error => {
      if (this.disposed || signal?.aborted) throw failure('article-interrupted')
      throw error
    })
    this.active.add(pending)
    void pending.finally(() => this.active.delete(pending)).catch(error => { void error })
    return pending
  }

  /** Produce both projections inside an owned page. @param {string} url Target URL. @param {AbortSignal|undefined} signal Cancellation. @returns {Promise<object>} Rendered article. */
  async renderPage(url, signal) {
    if (signal?.aborted) throw failure('article-interrupted')
    const persistent = this.config.renderUserDataDir !== undefined
    const browser = await this.ensureBrowser()
    if (this.disposed || signal?.aborted) throw failure('article-interrupted')
    const context = persistent ? browser : await browser.newContext()
    let page, aborting
    const abort = () => {
      // 普通请求拥有独立 context；持久配置只关闭本次 page，避免取消其他并发请求。
      aborting ??= Promise.resolve().then(() => persistent ? page?.close() : context.close()).catch(error => { void error })
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      if (this.disposed || signal?.aborted) throw failure('article-interrupted')
      if (!persistent && this.config.renderBlockAssets) await this.blockAssets(context)
      await this.seedCookies(context, url)
      page = await context.newPage()
      if (signal?.aborted) throw failure('article-interrupted')
      let response
      try {
        response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.renderTimeoutMs })
      } catch (error) {
        if (signal?.aborted) throw failure('article-interrupted')
        if (error?.name === 'TimeoutError') throw failure('article-timeout')
        throw failure('article-render')
      }
      // 三个阶段各有独立预算：网络安静、正文就位、DOM 尺寸稳定。SPA 启动到首个数据请求可间隔数秒，
      // 只有正文门槛能等到真正的内容；慢站每阶段等满预算后照常快照。
      if (this.config.renderWaitMs > 0) {
        await page.waitForLoadState('networkidle', { timeout: this.config.renderWaitMs }).catch(() => {})
        await page.waitForFunction(articleContentPresent, this.config.minArticleChars, { timeout: this.config.renderWaitMs, polling: 500 }).catch(() => {})
        await page.waitForFunction(domSettled, undefined, { timeout: this.config.renderWaitMs, polling: 500 }).catch(() => {})
      }
      let content, visible
      try {
        // 渲染后的 DOM 可比源 HTML 大一个数量级（otempo.com.br 约 9MB）；先按 Readability 的规则剪枝，序列化后才不会触发截断。
        await page.evaluate(pruneDocument)
        content = await page.content()
        visible = await page.evaluate(visibleArticle)
      } catch (error) {
        if (signal?.aborted) throw failure('article-interrupted')
        void error
        throw failure('article-render')
      }
      if (this.jar) await this.captureCookies(context, response?.url() ?? url)
      const truncated = content.length > this.config.maxArticleHtmlChars
      return { url: response?.url() ?? url, statusCode: response?.status() ?? 200, truncated,
        body: { kind: 'html', content: truncated ? content.slice(0, this.config.maxArticleHtmlChars) : content },
        // 没有正文区域时这份文本是站点框架，标记为不可抽取，不能让兜底把它当文章。
        visible: visible?.contentRoot ? visible.text : '',
        visibleIsArticle: Boolean(visible?.contentRoot),
        visibleTitle: visible?.title ?? '' }
    } finally {
      signal?.removeEventListener('abort', abort)
      await aborting
      if (page) await page.close().catch(() => {})
      if (!persistent) await context.close().catch(() => {})
    }
  }

  /** Hand the jar's cookies for this URL to a fresh browser context. @param {object} context Browser context. @param {string} url Target URL. @returns {Promise<void>} Completion. */
  async seedCookies(context, url) {
    if (!this.jar) return
    const scheme = new URL(url).protocol
    // 按 cookie 自身的作用域逐个交给浏览器：host-only 用 url 形式，避免被当成域 cookie 扩散到子域。
    const cookies = this.jar.matching(url).map(cookie => ({
      name: cookie.name, value: cookie.value,
      ...(cookie.hostOnly ? { url: `${scheme}//${cookie.domain}${cookie.path}` } : { domain: cookie.domain, path: cookie.path }),
      ...(cookie.expires === null ? {} : { expires: Math.floor(cookie.expires / 1000) }),
      secure: cookie.secure, httpOnly: cookie.httpOnly,
    }))
    if (!cookies.length) return
    await context.addCookies(cookies).catch(error => { void error })
  }

  /** Merge the context's cookies for this URL back into the jar. @param {object} context Browser context. @param {string} url Final URL. @returns {Promise<void>} Completion. */
  async captureCookies(context, url) {
    try {
      const cookies = await context.cookies(url)
      // 浏览器已经完成域名与路径作用域计算；按它给出的域与路径原样写回，不再重新推导。
      for (const cookie of cookies) {
        this.jar.adopt({ name: cookie.name, value: cookie.value, domain: cookie.domain.replace(/^\./, '').toLowerCase(), path: cookie.path ?? '/',
          expires: cookie.expires === -1 ? null : cookie.expires * 1000, secure: cookie.secure, httpOnly: cookie.httpOnly, hostOnly: !cookie.domain.startsWith('.') })
      }
    } catch (error) { void error }
  }

  /** Stop new renders, await the shared browser close and all page cleanup. @returns {Promise<void>} Shared shutdown completion. */
  dispose() {
    this.disposed = true
    if (!this.disposing) this.disposing = Promise.resolve().then(async () => {
      try {
        let browser
        try { browser = await this.launching } catch (error) { void error /* 启动失败没有可关闭的浏览器。 */ }
        if (browser) await browser.close()
      } finally { await Promise.allSettled([...this.active]) }
    })
    return this.disposing
  }
}
