/** Explicit public story and video projections; remote markup never runs scripts. */
import { JSDOM, VirtualConsole } from 'jsdom'
import parseSrcset from '@prettier/parse-srcset'
import { captureUrl } from './capture-media.js'
import { decodeBody } from './decode.js'
import { failure, assertArticleStatus } from './contracts.js'
import { captureCaptions } from './capture-captions.js'

const tidy = value => (value ?? '').replace(/\s+/gu, ' ').trim()
function absolute(value, base, raster = false) {
  if (!value?.trim()) return null
  if (raster && /^data:image\/(?:png|jpeg|gif|webp);base64,/u.test(value)) return value
  try { return captureUrl(new URL(value, base).href).href } catch (error) { void error; return null }
}

function resolveSources(root, url) {
  // 子文档标题属于主文章的附属小节，不能覆盖主文档标题。
  for (const element of root.querySelectorAll('h1')) {
    const heading = root.ownerDocument.createElement('h2')
    heading.append(...element.childNodes); element.replaceWith(heading)
  }
  for (const element of root.querySelectorAll('amp-img')) {
    const image = root.ownerDocument.createElement('img')
    for (const attribute of element.attributes) image.setAttribute(attribute.name, attribute.value)
    element.replaceWith(image)
  }
  for (const element of root.querySelectorAll('a,img,source,video,iframe,audio')) {
    for (const name of ['href', 'src', 'data-src', 'data-original', 'data-full-src', 'data-lazy-src', 'data-ai-current-src', 'poster']) {
      const value = element.getAttribute(name)
      if (!value) continue
      const resolved = absolute(value, url, element.matches('img,source'))
      if (resolved) element.setAttribute(name, resolved)
      else element.removeAttribute(name)
    }
    for (const name of ['srcset', 'data-srcset', 'data-lazy-srcset']) {
      const value = element.getAttribute(name)
      if (!value) continue
      try {
        const candidates = parseSrcset(value).flatMap(candidate => {
          const href = absolute(candidate.source.value, url, true)
          return href ? [href + (candidate.width ? ` ${candidate.width.value}w` : candidate.density ? ` ${candidate.density.value}x` : '')] : []
        })
        element.setAttribute(name, candidates.join(', '))
      } catch (error) { void error; element.removeAttribute(name) }
    }
  }
}

function storyProjection(document, rule) {
  const roots = document.querySelectorAll(rule.rootSelector)
  if (roots.length !== 1) throw failure('article-extraction')
  const original = [...roots[0].querySelectorAll(rule.pageSelector)]
  if (!original.length || original.some(page => page.parentElement.closest(rule.pageSelector))) throw failure('article-extraction')
  if (rule.pageIndexAttribute && original.some((page, index) => Number(page.getAttribute(rule.pageIndexAttribute)) !== index + 1)) throw failure('article-extraction')
  const projection = document.createElement('section')
  let excluded = 0
  for (const page of original) {
    if (rule.excludeSelector && page.matches(rule.excludeSelector)) { excluded++; continue }
    const clone = page.cloneNode(true)
    // 仅显式故事页的 inactive 状态可投影；隐藏后代和正文访问声明不能被取消。
    clone.removeAttribute('aria-hidden')
    if (clone.matches('[hidden],[data-ai-hidden="true"]')) throw failure('article-content-not-ready')
    if (rule.excludeSelector) for (const node of clone.querySelectorAll(rule.excludeSelector)) node.remove()
    for (const node of clone.querySelectorAll('script,style,[hidden],[aria-hidden="true"],[data-ai-hidden="true"]')) node.remove()
    for (const node of clone.querySelectorAll('[style]')) if (node.style.display === 'none' || node.style.visibility === 'hidden') node.remove()
    if (!tidy(clone.textContent) && !clone.querySelector('img,amp-img,video,audio,iframe,svg,canvas')) throw failure('article-content-not-ready')
    projection.append(clone)
  }
  if (!projection.children.length) throw failure('article-extraction')
  return { projection, pages: original.length, excluded }
}

function videoProjection(document, rule, url) {
  if (document.querySelectorAll(rule.rootSelector).length !== 1) throw failure('article-extraction')
  const projection = document.createElement('section')
  const title = tidy(document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? document.title)
  const description = tidy(document.querySelector('meta[property="og:description"],meta[name="description"]')?.getAttribute('content'))
  const poster = absolute(document.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? '', url)
  if (!poster || !title) throw failure('article-extraction')
  const image = document.createElement('img')
  image.setAttribute('src', poster); image.setAttribute('alt', title)
  projection.append(image)
  if (description && description !== title) { const paragraph = document.createElement('p'); paragraph.textContent = description; projection.append(paragraph) }
  return { projection, pages: 1, excluded: 0 }
}

/** Merge only adapter-declared child sources, sharing HTML limits and cancellation with the parent. @param {object} input Parent DOM, explicit rules, transport, anonymous jar, callbacks and limits. @returns {Promise<object>} Quality reasons and bounded verification checks. */
export async function captureEmbeds({ document, root, url, html, site, config, request, jar, signal, inspectGates, onProgress, onSourceDocument, captionDeclarations }) {
  const reasons = new Set(), checks = [], seen = new Set()
  const budget = { bytes: Buffer.byteLength(html), chars: html.length, elements: document.getElementsByTagName('*').length }
  let count = 0
  const excluded = site.excludeSelector ? [...document.querySelectorAll(site.excludeSelector)] : []
  for (const [ruleIndex, rule] of (site.embeddedSources ?? []).entries()) {
    for (const frame of root.querySelectorAll(rule.selector)) {
      if (!frame.matches('iframe[src]') || seen.has(frame) || excluded.some(node => node.contains(frame))) continue
      seen.add(frame)
      if (frame.closest('[hidden],[aria-hidden="true"],[data-ai-hidden="true"],nav,aside,footer,[data-ad],[data-ad-slot]')) continue
      let target
      try {
        target = captureUrl(new URL(frame.getAttribute('src'), url).href)
        if (!rule.hosts.includes(target.hostname)) throw failure('article-url-blocked')
        if (++count > config.maxEmbeddedSources) throw failure('article-resource-limit')
        const maxBytes = config.maxArticleHtmlBytes - budget.bytes
        if (maxBytes <= 0 || budget.chars >= config.maxArticleHtmlChars || budget.elements >= config.maxArticleElements) throw failure('article-resource-limit')
        await onProgress({ phase: 'extracting', event: 'embedded-source-start', details: { origin: target.origin, attempt: count } })
        const cookie = jar.header(target.href)
        const response = await request(target.href, { signal, maxBytes, headers: { accept: 'text/html,application/xhtml+xml', referer: new URL(url).origin + '/', ...(cookie ? { cookie } : {}) } })
        if (signal.aborted) throw failure('article-interrupted')
        const final = captureUrl(response.url ?? target.href)
        if (final.origin !== target.origin) throw failure('article-redirect')
        assertArticleStatus(response.statusCode)
        jar.store(final.href, response.headers ?? {})
        if (response.mime && !['text/html', 'application/xhtml+xml'].includes(response.mime)) throw failure('article-content-type')
        budget.bytes += response.bytes.length
        const { text: childHtml } = decodeBody(response.bytes, response.headers?.['content-type'])
        budget.chars += childHtml.length
        if (budget.bytes > config.maxArticleHtmlBytes || budget.chars > config.maxArticleHtmlChars) throw failure('article-resource-limit')
        const dom = new JSDOM(childHtml, { url: final.href, virtualConsole: new VirtualConsole() })
        try {
          const child = dom.window.document
          budget.elements += child.getElementsByTagName('*').length
          if (budget.elements > config.maxArticleElements) throw failure('article-resource-limit')
          // 子页面原始访问声明先于裁剪、排除和 carousel 投影检查。
          inspectGates(child)
          const result = rule.kind === 'story' ? storyProjection(child, rule) : videoProjection(child, rule, final.href)
          resolveSources(result.projection, final.href)
          const imported = document.importNode(result.projection, true)
          const source = document.createElement('p'), link = document.createElement('a')
          const canonical = absolute(child.querySelector('link[rel="canonical"]')?.getAttribute('href'), final.href)
          link.setAttribute('href', canonical && new URL(canonical).origin === final.origin ? canonical : final.href)
          link.textContent = tidy(child.title || frame.title || final.hostname).slice(0, 2000)
          source.append(link); imported.prepend(source)
          // 海报不等于视频正文：保留真实播放器节点及其 partial 诊断。
          if (rule.kind === 'video') frame.before(imported)
          else frame.replaceWith(imported)
          checks.push(`embedded-${rule.kind}:${result.pages - result.excluded}/${result.pages}`)
          try { await onSourceDocument?.({ url: final.href, html: childHtml, ruleIndex, kind: rule.kind, pages: result.pages, excluded: result.excluded }) } catch (error) { void error }
          await onProgress({ phase: 'extracting', event: 'embedded-source-complete', completed: result.pages - result.excluded, total: result.pages - result.excluded, details: { origin: final.origin, code: rule.kind } })
        } finally { dom.window.close() }
      } catch (error) {
        if (signal.aborted) throw failure('article-interrupted')
        reasons.add('embedded-source-incomplete')
        // 外部错误文本、签名 URL 与 Cookie 不进入进度；保留工具定义的失败码。
        const code = /^article-[a-z-]{1,80}$/u.test(error.code ?? '') ? error.code : 'article-extraction'
        await onProgress({ phase: 'extracting', event: 'embedded-source-failed', details: { code, ...(target ? { origin: target.origin } : {}) } })
      }
    }
  }
  const captions = await captureCaptions({ document, root, url, site, config, budget, count, request, jar, signal, onProgress, captionDeclarations })
  for (const reason of captions.reasons) reasons.add(reason)
  checks.push(...captions.checks)
  return { reasons, checks }
}
