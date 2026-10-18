/** Shared rich capture with verified static templates and browser fallback, without business records or model requests. */
import { randomBytes, createHash } from 'node:crypto'
import { JSDOM, VirtualConsole } from 'jsdom'
import { Readability } from '@mozilla/readability'
import { z } from 'zod'
import parseSrcset from '@prettier/parse-srcset'
import { failure, assertArticleStatus } from './contracts.js'
import { snapshotSchema, hashSnapshot, textOfBlock } from './capture-contracts.js'
import { captureAssets, createPublicRequest, captureUrl } from './capture-media.js'
import { CaptureRenderer } from './capture-renderer.js'
import { dimsOriginal, restoreDeclaredImages, imageIdentity } from './declared-images.js'
import { networkConfigSchema } from './network-config.js'
import { CookieJar } from './session.js'
import { assertDeclaredAccess } from './articles.js'
import { captureEmbeds } from './capture-embeds.js'
import { fetchPage } from './fetch.js'
import { staticEligible, verifyStaticDocument } from './capture-static.js'
import { failureFamily } from './pipeline.js'
import { matchesCaptureAdapter } from './capture-adapters.js'

const selector = z.string().trim().min(1).max(2000).refine(value => {
  try { JSDOM.fragment('').querySelector(value); return true } catch (error) { void error; return false }
}, 'Invalid article selector')
const hosts = z.array(z.string().max(253).refine(value => {
  try { const url = new URL(`https://${value}`); return url.hostname === value.toLowerCase() && url.host === url.hostname && url.pathname === '/' && !url.username && !url.password } catch (error) { void error; return false }
})).min(1).max(100)
const embeddedSource = z.object({ selector, hosts, kind: z.enum(['story', 'video']), rootSelector: selector,
  pageSelector: selector.optional(), excludeSelector: selector.optional(), pageIndexAttribute: z.string().regex(/^data-[a-z][a-z0-9-]*$/).optional(),
}).strict().refine(value => value.kind !== 'story' || Boolean(value.pageSelector), 'Stories require a page selector')
const httpsOrigin = z.string().max(2048).refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value && !url.username && !url.password && !url.hostname.includes('*') } catch (error) { void error; return false }
}, 'Expected an exact HTTPS origin')
const metadataKey = z.string().regex(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/).max(80).refine(value => !['__proto__', 'prototype', 'constructor'].includes(value))
const metadataPath = z.array(metadataKey).min(1).max(16)
const captionMetadata = z.object({ globalPath: metadataPath, identityPath: metadataPath, tracksPath: metadataPath,
  formatKey: metadataKey, formatValue: z.string().min(1).max(80), urlKey: metadataKey, anchorSelector: selector, language: z.string().max(80),
  poster: z.object({ urlPath: metadataPath, titlePath: metadataPath, hosts }).strict().optional(),
}).strict()
const siteAdapter = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
  hosts, pathPrefixes: z.array(z.string().min(1).max(2000).refine(value => {
    if (!value.startsWith('/') || value.startsWith('//') || ['?', '#', '\\'].some(char => value.includes(char))) return false
    return new URL(value, 'https://path.invalid').pathname === value
  }, 'Expected a canonical absolute pathname prefix')).min(1).max(32).optional(),
  articleSelector: selector, endSelector: selector.optional(), expectedMinImages: z.number().int().min(0).max(1000).default(0),
  pagination: z.object({ nextSelector: selector, identitySelector: selector, identityAttribute: z.string().regex(/^(?:id|data-[a-z][a-z0-9-]*)$/), maxPages: z.number().int().min(2).max(100) }).strict().optional(),
  expandSelector: selector.optional(), excludeSelector: selector.optional(), pendingSelector: selector.optional(),
  static: z.object({ startSelector: selector, endSelector: selector, requiredSelectors: z.array(selector).max(32).default([]) }).strict().optional(),
  browserResources: z.object({ deferTypes: z.array(z.enum(['image', 'font', 'media'])).max(3).refine(values => new Set(values).size === values.length, 'Duplicate deferred resource type') }).strict().optional(),
  embeddedSources: z.array(embeddedSource).min(1).max(32).optional(),
  captionSources: z.array(z.object({ selector, hosts, metadata: captionMetadata.optional() }).strict()).min(1).max(32).optional(),
  imageRedirects: z.array(z.object({ from: httpsOrigin, to: httpsOrigin }).strict().refine(value => value.from !== value.to, 'CDN origins must differ')).min(1).max(32).optional(),
}).strict()

/** Deployment-varying capture choices are resolved here before execution. */
export const captureConfigSchema = z.object({
  network: networkConfigSchema.prefault({}),
  renderHeadless: z.boolean().default(true), renderTimeoutMs: z.number().int().min(1000).max(600000).default(60000),
  maxResourceDiagnostics: z.number().int().min(0).max(100).default(20),
  maxEmbeddedSources: z.number().int().min(0).max(32).default(8),
  maxCaptionCues: z.number().int().min(1).max(10000).default(2000),
  imageMetadataSources: z.array(z.object({ hosts, globalPath: metadataPath, identityPath: metadataPath, itemsPath: metadataPath,
    typeKey: metadataKey, typeValue: z.string().min(1).max(80), sourcePath: metadataPath, altPath: metadataPath,
  }).strict()).max(32).default([]),
  renderWaitMs: z.number().int().min(0).max(60000).default(5000), maxScrollSteps: z.number().int().min(1).max(200).default(30),
  scrollWaitMs: z.number().int().min(0).max(5000).default(150), requestTimeoutMs: z.number().int().min(1000).max(600000).default(45000),
  maxRedirects: z.number().int().min(0).max(8).default(3), maxArticleHtmlBytes: z.number().int().min(1000).max(32000000).default(8000000),
  maxArticleHtmlChars: z.number().int().min(1000).max(32000000).default(8000000), maxArticleElements: z.number().int().min(100).max(200000).default(50000),
  minArticleChars: z.number().int().min(1).max(5000).default(100), maxArticleChars: z.number().int().min(1000).max(500000).default(100000),
  maxImages: z.number().int().min(1).max(1000).default(100), maxImageBytes: z.number().int().min(100).max(64000000).default(12000000),
  maxImageCandidates: z.number().int().min(1).max(20).default(5),
  imageConnectionPoolSize: z.number().int().min(0).max(64).default(8),
  rendererConnectionPoolSize: z.number().int().min(0).max(64).default(8),
  rendererConnectionsPerOrigin: z.number().int().min(1).max(16).default(4),
  maxImageTransportRetries: z.number().int().min(0).max(2).default(1),
  maxTotalImageBytes: z.number().int().min(100).max(512000000).default(64000000), maxImagePixels: z.number().int().min(1).max(200000000).default(40000000),
  articleUserAgent: z.string().min(1).max(300).regex(/^[^\r\n]+$/).default('ArticleImageToolkit (+https://github.com/haigepor/dsh-AutoFlow)'),
  adapters: z.array(siteAdapter).max(100).default([]),
}).strict().refine(value => value.minArticleChars <= value.maxArticleChars && value.maxImageBytes <= value.maxTotalImageBytes, 'Invalid capture limits').superRefine((value, ctx) => {
  const hosts = new Set(), ids = new Set()
  for (const adapter of value.adapters) {
    if (ids.has(adapter.id)) ctx.addIssue({ code: 'custom', message: 'Duplicate site adapter id' })
    ids.add(adapter.id)
    for (const host of adapter.hosts) {
      if (hosts.has(host.toLowerCase())) ctx.addIssue({ code: 'custom', message: 'Ambiguous site adapter hostname' })
      hosts.add(host.toLowerCase())
    }
  }
})

/** Resolve a complete isolated-browser capture configuration. @param {object} input Explicit capture fields. @returns {object} Validated settings. */
export function resolveCaptureConfig(input = {}) { return captureConfigSchema.parse(input) }

const ignored = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'FORM', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SVG', 'CANVAS', 'NOSCRIPT'])
const nestedBlocks = 'p,h1,h2,h3,h4,h5,h6,blockquote,ul,ol,table,figure'
function tidy(value) { return (value ?? '').replace(/\s+/gu, ' ').trim() }
function normalized(value) { return tidy(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase() }
function safeLink(value, url) {
  try { const parsed = captureUrl(new URL(value, url).href); return parsed.href } catch (error) { void error; return undefined }
}

function inlines(node, url, skipLists = false) {
  const result = []
  const visit = (current, marks = {}, depth = 0) => {
    if (depth > 100) throw failure('article-extraction')
    if (current.nodeType === 3) { if (current.nodeValue) result.push({ text: current.nodeValue.replace(/\s+/gu, ' '), ...marks }); return }
    if (current.nodeType !== 1 || ignored.has(current.tagName) || ['IMG', 'FIGURE', 'PICTURE'].includes(current.tagName) || (skipLists && ['UL', 'OL'].includes(current.tagName))) return
    const next = { ...marks }
    if (['STRONG', 'B'].includes(current.tagName)) next.bold = true
    if (['EM', 'I'].includes(current.tagName)) next.italic = true
    if (current.tagName === 'A') { const href = safeLink(current.getAttribute('href') ?? '', url); if (href) next.href = href }
    if (current.tagName === 'BR') result.push({ text: '\n' })
    for (const child of current.childNodes) visit(child, next, depth + 1)
  }
  if (node.nodeType === 11) for (const child of node.childNodes) visit(child)
  else visit(node)
  if (result[0]) result[0].text = result[0].text.trimStart()
  if (result.at(-1)) result.at(-1).text = result.at(-1).text.trimEnd()
  // 空控件留下的多个空白节点不构成正文；有效行内片段之间的空格必须保留。
  if (!result.some(value => value.text.trim())) return []
  return result.filter(value => value.text)
}

function listValue(element, url, depth = 0) {
  if (depth > 30) throw failure('article-extraction')
  return { ordered: element.tagName === 'OL', items: [...element.children].filter(child => child.tagName === 'LI').map(item => ({
    inline: inlines(item, url, true), children: [...item.querySelectorAll('ul,ol')].filter(child => child.parentElement.closest('li') === item && child.parentElement.closest('ul,ol') === element).map(child => listValue(child, url, depth + 1)),
  })).filter(item => item.inline.length || item.children.some(child => child.items.length)) }
}

function pruneControls(root, url) {
  // 控件角色与明确组件标记不代表编辑内容；仅移除图注内的图标，保留图注文字和照片。
  for (const element of root.querySelectorAll('[role="toolbar"],[role="menu"],[role="menubar"],[role="listbox"],[role="tablist"],.vjs-control-bar,.vjs-menu,.vjs-modal-dialog,.vjs-text-track-display,.ima-ad-container,.socialBarWrapper,.socialBar,li[class~="article-bg-article-social"]')) element.remove()
  for (const element of root.querySelectorAll('.read-more')) {
    if (/^(?:saiba mais|leia tambem|mais lidas|ultimas noticias)\b/u.test(normalized(element.textContent)) && element.querySelector('li a[href],article a[href]')) element.remove()
  }
  for (const element of root.querySelectorAll('.fullScreenButton svg,.carousel-arrow svg,.responsive-img-caption > svg,[role="button"] > svg')) {
    if (!element.matches('[role="img"]') && !element.querySelector('title,desc,text,image,foreignObject')) element.remove()
  }
  for (const element of root.querySelectorAll('[role="button"]')) {
    if (!element.querySelector('img,picture,figure,video,audio,iframe,canvas,svg[role="img"],svg title,svg desc,svg text,svg image,svg foreignObject')) element.remove()
  }
  // 只识别公开分享动作端点，普通社交平台资料链接和正文提及保持原样。
  for (const anchor of root.querySelectorAll('a[href]')) {
    const href = safeLink(anchor.getAttribute('href'), url)
    if (!href) continue
    const target = new URL(href), host = target.hostname.replace(/^www\./u, ''), path = target.pathname
    if ((['twitter.com', 'x.com'].includes(host) && path === '/intent/tweet') || (host === 'facebook.com' && ['/sharer.php', '/sharer/sharer.php', '/dialog/share'].includes(path)) || (host === 'api.whatsapp.com' && path === '/send') || (host === 'wa.me' && path === '/' && target.searchParams.has('text')) || (host === 'linkedin.com' && path === '/sharing/share-offsite/') || (host === 't.me' && path === '/share/url')) anchor.remove()
  }
}

function imageSources(image, url) {
  const candidates = []
  const add = (value, score) => {
    const source = tidy(value), href = source.startsWith('data:') ? source : safeLink(source, url)
    if (href) candidates.push({ href, score })
  }
  const srcset = value => {
    if (!value?.trim()) return
    let parsed
    // 畸形属性只丢弃当前 srcset；解析器错误含原始签名 URL，不能输出到 MCP stdout 或诊断。
    try { parsed = parseSrcset(value) } catch (error) { void error; return }
    for (const candidate of parsed) add(candidate.source.value, candidate.width?.value ?? (candidate.density ? candidate.density.value * 10000 : 1))
  }
  const picture = image.closest('picture')
  // figure 可以包含多张图；source 只属于当前 img 所在的 picture。
  for (const source of picture?.querySelectorAll('source') ?? []) { srcset(source.getAttribute('srcset')); srcset(source.getAttribute('data-srcset')) }
  for (const attr of ['srcset', 'data-srcset', 'data-lazy-srcset']) srcset(image.getAttribute(attr))
  // 页面公开的原图属性优先于响应式缩略图；currentSrc 仅用作没有更高来源时的回退。
  for (const [attr, score] of [['data-original', 1000000], ['data-full-src', 1000000], ['data-lazy-src', 50000], ['data-src', 50000], ['data-ai-current-src', 2], ['src', 1]]) {
    const value = image.getAttribute(attr)
    if (value) add(value, score)
  }
  // DIMS 的 url 参数直接声明原文件；它先于裁剪尺寸候选，仍逐次经过公网校验。
  for (const candidate of [...candidates]) {
    const original = dimsOriginal(candidate.href)
    if (original) add(original, 900000)
  }
  candidates.sort((a, b) => b.score - a.score)
  return [...new Set(candidates.map(candidate => candidate.href))]
}

function inspectGates(document) {
  assertDeclaredAccess(document)
  const title = normalized(document.querySelector('h1')?.textContent ?? document.title).replace(/[.!…:]+$/gu, '')
  if ((/^(?:just a moment|checking your browser|verify (?:that )?you are human|attention required)$/u.test(title) && document.querySelector('#challenge-form,#cf-challenge-running,.cf-turnstile,.g-recaptcha')) || document.querySelector('#challenge-form,#cf-challenge-running,#px-captcha')) throw failure('article-challenge')
  if (/^(?:sign in|log in|login|entrar|faca login|entre na sua conta)(?:\b|$)/u.test(title) && document.querySelector('input[type="password"]')) throw failure('article-login')
  // 受限需要两个事实：页面出现明确的全文限制提示，且提示所在容器不承载实质正文。
  // 推广尾注常与正文同容器（folha 的 .j-paywall 承载整篇报道），只看提示文本会把完整正文误判为受限。
  for (const gate of document.querySelectorAll('[class*="paywall" i],[id*="paywall" i],[data-paywall],[data-access="restricted"],[class*="subscription-wall" i]')) {
    if (gate.closest('[hidden],[aria-hidden="true"],[data-ai-hidden="true"]')) continue
    const visible = gate.cloneNode(true)
    for (const element of visible.querySelectorAll('[hidden],[aria-hidden="true"],[data-ai-hidden="true"],script,style')) element.remove()
    if (!/subscribe.*(?:continue|read)|exclusive.*subscribers|conteudo.*(?:exclusivo|restrito)|limite de materias (?:livres|gratuitas)|(?:订阅|付费|会员).*(?:继续阅读|阅读全文|专享)/iu.test(normalized(visible.textContent))) continue
    if (normalized(gate.textContent).length >= structuredBodyChars(document) * 0.5) throw failure('article-restricted')
  }
}

/** Measure the declared body of the page so gate notices can be compared with real text. @param {Document} document Rendered page. @returns {number} Character count of the declared article body. */
function structuredBodyChars(document) {
  const root = document.querySelector('article') ?? document.querySelector('main,[role="main"]') ?? document.body
  return normalized(root?.textContent).length
}

function readableRoot(document, url, config) {
  const projection = document.cloneNode(true), marker = 'data-ai-heading-level'
  for (const element of projection.querySelectorAll('nav,aside,footer,[role="navigation"],[role="complementary"],.related,.recommendations,.recommended,.comments,#comments')) element.remove()
  // 页面自带的同名属性不能冒充本次投影标记；原 DOM 与正文顺序保持不变。
  for (const element of projection.querySelectorAll('[' + marker + ']')) element.removeAttribute(marker)
  // Readability 会把近似文章标题的小节标题删除；评分时使用段落，输出前恢复语义层级。
  for (const heading of projection.querySelectorAll('h2,h3,h4,h5,h6')) {
    const paragraph = projection.createElement('p')
    for (const attribute of heading.attributes) paragraph.setAttribute(attribute.name, attribute.value)
    paragraph.setAttribute(marker, heading.tagName.slice(1))
    paragraph.append(...heading.childNodes)
    heading.replaceWith(paragraph)
  }
  const result = new Readability(projection, { charThreshold: config.minArticleChars, maxElemsToParse: config.maxArticleElements, serializer: node => node }).parse()
  if (!result?.content) return null
  for (const paragraph of result.content.querySelectorAll('p[' + marker + ']')) {
    const heading = projection.createElement('h' + paragraph.getAttribute(marker))
    for (const attribute of paragraph.attributes) if (attribute.name !== marker) heading.setAttribute(attribute.name, attribute.value)
    heading.append(...paragraph.childNodes)
    paragraph.replaceWith(heading)
  }
  return restoreDeclaredImages(document, result.content, url, config.maxImages)
}

function extract(document, url, config, selectedRoot, handledPagination = false, excludeSelector, imageDescriptions = []) {
  if (document.getElementsByTagName('*').length > config.maxArticleElements) throw failure('article-extraction')
  inspectGates(document)
  const reasons = new Set(), figures = [], blocks = []
  const article = [...document.querySelectorAll('article')].find(element => !element.closest('nav,aside,footer,[role="navigation"],[role="complementary"],.related,.recommendations,.recommended'))
  let root = selectedRoot ?? article ?? document.querySelector('main,[role="main"]')
  // role=main 常标在整页 wrapper 上；Readability 收窄其导航、推荐与账号组件。
  if (!root || (!selectedRoot && root.matches('[role="main"]') && !root.matches('main,article'))) {
    root = readableRoot(document, url, config)
  }
  if (!root) throw failure('article-extraction')
  if (selectedRoot) root = restoreDeclaredImages(document, root, url, config.maxImages)
  // 访问声明先于站点排除规则检查；排除只能收窄已选正文，不能隐藏登录或订阅限制。
  if (excludeSelector) {
    // 在原文档解析含祖先与 :has 的选择器，再限定到正文后代，避免局部查询的作用域差异。
    for (const element of (root.isConnected ? document : root).querySelectorAll(excludeSelector)) if (element !== root && root.contains(element)) element.remove()
  }
  for (const element of root.querySelectorAll('[hidden],[aria-hidden="true"],[data-ai-hidden="true"]')) element.remove()
  if (!handledPagination && (root.querySelector('a[rel~="next"],a[class*="next-page"],a[href*="?page="],a[href*="&page="],[class*="pagination"],[class*="page-numbers"]') || document.querySelector('link[rel="next"]'))) reasons.add('unhandled-pagination')
  if (root.querySelector('[aria-busy="true"],[data-loading="true"],[class~="skeleton"]')) reasons.add('content-not-ready')
  // media 是合法正文图片容器；Primis 明示的广告播放器不属于文章配图。
  for (const element of root.querySelectorAll('nav,aside,footer,[role="navigation"],[role="complementary"],.related,.recommendations,.recommended,[class~="advertisement" i],[class~="advert" i],.comments,#comments,[data-ad],[data-ad-slot],[data-primis-wrapper],script,style,form,button,input,[hidden],[aria-hidden="true"]')) element.remove()
  // 明确标为广告的 iframe/播放器不属于正文嵌入，其封面也不能作为文章原图。
  for (const element of root.querySelectorAll('iframe[aria-label="Advertisement" i],video[aria-label="Advertisement" i],video[title="Advertisement" i]')) element.remove()
  // 站点常用普通 div 承载页脚和关注推广；按组件标记排除，正文提及平台名称不受影响。
  for (const element of root.querySelectorAll('[class],[id]')) {
    if (/(?:^|\s)(?:footer|promo)(?:[-_\s]|$)/iu.test(element.className) || /(?:^|[-_])follow[-_]cta$/iu.test(element.id)) element.remove()
  }
  pruneControls(root, url)
  if (root.querySelector('canvas,svg,[style*="background-image"],video,audio,iframe')) reasons.add('unsupported-graphic')
  for (const element of root.querySelectorAll('noscript')) {
    const fragment = JSDOM.fragment(element.querySelector('img') ? element.innerHTML : element.textContent)
    if (!element.previousElementSibling?.matches('img,picture') && fragment.querySelector('img')) element.replaceWith(fragment)
    else element.remove()
  }
  // poster 是页面明确公开的封面，不代表已获取视频；复用现有图片时不再插入第二个图块。
  for (const video of root.querySelectorAll('video[poster]')) {
    const source = tidy(video.getAttribute('poster')), poster = source.startsWith('data:') ? source : source ? safeLink(source, url) : null
    if (!poster || [...root.querySelectorAll('img')].some(image => imageSources(image, url).includes(poster))) continue
    const image = document.createElement('img')
    image.setAttribute('src', poster); image.setAttribute('alt', tidy(video.getAttribute('title')))
    video.before(image)
  }
  const add = value => { const id = `b${blocks.length + 1}`; blocks.push({ id, ...value }); return id }
  const seen = new Set()
  const descriptions = new Map()
  let imageDescriptionsUsed = 0
  for (const value of imageDescriptions) {
    const source = imageIdentity(value.url, url), alt = tidy(value.alt)
    if (source && alt) descriptions.set(source, descriptions.has(source) && descriptions.get(source) !== alt ? null : alt)
  }
  const figure = element => {
    const images = element.matches('img') ? [element] : [...element.querySelectorAll('img')]
    for (const image of images) {
      if (seen.has(image)) continue
      seen.add(image)
      const width = Number(image.getAttribute('width') ?? 0), height = Number(image.getAttribute('height') ?? 0)
      if ((width > 0 && width <= 2) || (height > 0 && height <= 2) || /(?:^|[\s_-])(?:avatar|icon|tracking|pixel)(?:$|[\s_-])/iu.test(`${image.className} ${image.getAttribute('role') ?? ''}`)) continue
      const parent = element.parentElement
      const wrapper = element.closest('figure') ?? (parent && !parent.matches('article,main,body,[role="main"]') ? parent : element)
      const candidates = imageSources(image, url), sourceUrl = candidates[0]?.startsWith('data:') ? url : candidates[0]
      const statedAlt = tidy(image.getAttribute('alt')), candidateDescriptions = candidates.map(source => descriptions.get(imageIdentity(source, url)))
      const alternatives = new Set(candidateDescriptions.filter(Boolean))
      // 只补当前文章、同一公开图片的明确描述；冲突元数据不能替换 DOM 已有文字。
      const alt = statedAlt || (!candidateDescriptions.includes(null) && alternatives.size === 1 ? [...alternatives][0] : ''), caption = tidy(wrapper.querySelector('figcaption,.caption,[class~="image-caption"]')?.textContent)
      if (!statedAlt && alt) imageDescriptionsUsed++
      const credit = tidy(wrapper.querySelector('[class*="credit"],[class*="copyright"],[class*="attribution"]')?.textContent)
      const placeholder = createHash('sha256').update(sourceUrl ?? `${url}#${blocks.length}`).digest('hex').slice(0, 32)
      const blockId = add({ type: 'figure', assetId: placeholder, alt, caption, credit })
      figures.push({ blockId, sourceUrl: sourceUrl ?? url, candidates, alt, caption, credit, error: sourceUrl ? null : 'image-source' })
    }
  }
  const walk = (node, depth = 0, quoted = false) => {
    if (depth > 100) throw failure('article-extraction')
    if (node.nodeType === 3) { const value = tidy(node.nodeValue); if (value) add({ type: quoted ? 'quote' : 'paragraph', inline: [{ text: value }] }); return }
    if (node.nodeType !== 1 || ignored.has(node.tagName)) return
    const tag = node.tagName
    if (['FIGURE', 'PICTURE', 'IMG'].includes(tag)) { figure(node); return }
    if (tag === 'FIGCAPTION') return
    if (/^H[1-6]$/.test(tag)) { const inline = inlines(node, url); if (inline.length) add({ type: 'heading', level: Number(tag[1]), inline }); return }
    if (tag === 'UL' || tag === 'OL') {
      const list = listValue(node, url)
      if (list.items.length) add({ type: 'list', ...list })
      for (const img of node.querySelectorAll('img')) figure(img)
      return
    }
    if (tag === 'TABLE') {
      add({ type: 'table', rows: [...node.querySelectorAll('tr')].filter(row => row.closest('table') === node).map(row => ({ cells: [...row.children].filter(cell => ['TD', 'TH'].includes(cell.tagName)).map(cell => ({ inline: inlines(cell, url), header: cell.tagName === 'TH', rowSpan: Math.min(1000, Math.max(1, cell.rowSpan)), colSpan: Math.min(1000, Math.max(1, cell.colSpan)) })) })) })
      for (const img of node.querySelectorAll('img')) figure(img)
      return
    }
    if (tag === 'P' || tag === 'BLOCKQUOTE' || !node.querySelector(`${nestedBlocks},div,section,article,main,header`)) {
      const type = quoted || tag === 'BLOCKQUOTE' ? 'quote' : 'paragraph'
      if (node.querySelector(`img,${nestedBlocks}`)) {
        // Readability 可把含 p 的 span 包进外层 p；按块分割，同时保留前后行内文字与图片位置。
        const fragment = document.createDocumentFragment()
        for (const child of [...node.childNodes]) {
          if (child.nodeType === 1 && (child.matches(`img,picture,${nestedBlocks}`) || child.querySelector(`img,${nestedBlocks}`))) {
            const before = inlines(fragment, url)
            if (before.length) add({ type, inline: before })
            fragment.replaceChildren()
            walk(child, depth + 1, type === 'quote')
          } else fragment.append(child.cloneNode(true))
        }
        const after = inlines(fragment, url)
        if (after.length) add({ type, inline: after })
      } else {
        const inline = inlines(node, url)
        if (inline.length) add({ type, inline })
      }
      return
    }
    for (const child of [...node.childNodes]) walk(child, depth + 1, quoted)
  }
  walk(root)
  const chars = blocks.filter(block => block.type !== 'figure').reduce((sum, block) => sum + textOfBlock(block).length, 0)
  // 评论组件和侧栏卡片也会使用 article；正文可能由普通 div 承载，没有 main 地标。
  // 过短的默认 article 可能是商品卡片；Readability 仍须满足同一字数阈值，显式站点范围不扩大。
  const otherProse = [...document.querySelectorAll('body p')].some(paragraph => !root.contains(paragraph) && !paragraph.closest('nav,aside,footer,.related,.recommendations,.recommended,.comments,[hidden],[data-ai-hidden="true"]') && tidy(paragraph.textContent).length >= config.minArticleChars)
  if (chars < config.minArticleChars && !selectedRoot && root.tagName === 'ARTICLE' && (!root.querySelector('p') || otherProse)) {
    const candidate = readableRoot(document, url, config)
    if (candidate) return extract(document, url, config, candidate, handledPagination, excludeSelector, imageDescriptions)
  }
  if (chars < config.minArticleChars || !blocks.length) throw failure('article-short')
  if (chars > config.maxArticleChars) throw failure('article-truncated')
  return { blocks, figures, reasons, root, imageDescriptionsUsed, title: tidy(root.querySelector('h1')?.textContent ?? document.title).slice(0, 2000) }
}

/** Create rich capture with verified static templates and isolated browser fallback. Capture options accept an awaited onSourceDocument observer for private child-HTML audits; observer failures do not change results. @param {object} config Complete capture settings. @param {object} dependencies Optional shared anonymous jar and test transport/adapter/renderer. @returns {object} Capture, readiness and quiescent dispose. */
export function createCapture(config, dependencies = {}) {
  const request = dependencies.request ?? createPublicRequest(config, dependencies)
  const jar = dependencies.jar ?? new CookieJar()
  const renderer = dependencies.renderer ?? new CaptureRenderer(config, { ...dependencies, request, jar })
  const lifetime = new AbortController(), active = new Set()
  let disposed = false, disposing = null
  const captureOne = async (url, options, expectedIdentity, remaining = {}, browserOnly = false) => {
    if (disposed || options.signal?.aborted) throw failure('article-interrupted')
    captureUrl(url)
    const signal = AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : [])])
    const onProgress = async progress => {
      try { await options.onProgress?.(progress) } catch (error) { void error }
    }
    let result, staticDom = null
    const adapter = config.adapters.find(adapter => matchesCaptureAdapter(adapter, url))
    const fallback = async (code, diagnostics = [], chargedBytes = 0) => {
      await onProgress({ phase: 'rendering', event: 'static-fallback', details: { code, diagnostics } })
      // 同一次抓取的失败解码和候选传输仍占原图总预算，浏览器回退不能重置额度。
      return captureOne(url, options, expectedIdentity, { ...remaining, maxTotalImageBytes: Math.max(0, (remaining.maxTotalImageBytes ?? config.maxTotalImageBytes) - chargedBytes) }, true)
    }
    if (!browserOnly && staticEligible(adapter)) {
      await onProgress({ phase: 'rendering', event: 'static-start', details: { origin: new URL(url).origin } })
      try {
        const page = await fetchPage(url, config, signal, async (target, input) => {
          const response = await request(target, input)
          if (response.bytes.length > input.maxBytes) throw failure('article-resource-limit')
          return response
        }, { jar })
        if (signal.aborted) throw failure('article-interrupted')
        assertArticleStatus(page.statusCode)
        if (page.truncated) throw failure('article-html-limit')
        if (page.body.kind !== 'html') throw failure('article-unsupported')
        staticDom = new JSDOM(page.body.content, { url: page.url, virtualConsole: new VirtualConsole() })
        inspectGates(staticDom.window.document)
        if (!verifyStaticDocument(staticDom.window.document, page.url, adapter, config)) throw failure('article-extraction')
        result = { html: page.body.content, url: page.url, statusCode: page.statusCode, diagnostics: [], mode: 'static' }
      } catch (error) {
        staticDom?.window.close(); staticDom = null
        if (signal.aborted) throw failure('article-interrupted')
        if (!['content', 'client', 'size'].includes(failureFamily(error.code))) throw error
        return fallback(error.code)
      }
    }
    result ??= await renderer.render(url, { signal, onProgress })
    if (signal.aborted) { staticDom?.window.close(); throw failure('article-interrupted') }
    assertArticleStatus(result.statusCode)
    const dom = staticDom ?? new JSDOM(result.html, { url: result.url, virtualConsole: new VirtualConsole() })
    try {
      await onProgress({ phase: 'extracting', completed: 0, total: 1 })
      const document = dom.window.document
      const site = config.adapters.find(adapter => matchesCaptureAdapter(adapter, result.url))
      const matches = site ? document.querySelectorAll(site.articleSelector) : []
      inspectGates(document)
      const embedded = (site?.embeddedSources || site?.captionSources) && matches.length === 1
        ? await captureEmbeds({ document, root: matches[0], url: result.url, html: result.html, site, config, request, jar, signal, inspectGates, onProgress, onSourceDocument: options.onSourceDocument, captionDeclarations: result.captionDeclarations })
        : { reasons: [], checks: [] }
      let pagination = null
      if (site?.pagination) {
        const identities = document.querySelectorAll(site.pagination.identitySelector), links = document.querySelectorAll(site.pagination.nextSelector)
        const identity = identities.length === 1 ? tidy(identities[0].getAttribute(site.pagination.identityAttribute)) : ''
        const nextUrl = links.length === 1 && links[0].matches('a[href]') ? safeLink(links[0].getAttribute('href'), result.url) : null
        pagination = { identity, nextUrl, maxPages: site.pagination.maxPages, valid: Boolean(identity) && identity.length <= 500 && links.length <= 1 && (!links.length || Boolean(nextUrl)) }
        if (nextUrl && new URL(nextUrl).origin !== new URL(result.url).origin) pagination.valid = false
        if (expectedIdentity && (!pagination.valid || identity !== expectedIdentity)) throw failure('article-pagination-identity')
        if (pagination.valid) for (const link of links) link.remove()
      }
      let value
      try { value = extract(document, result.url, config, matches.length === 1 ? matches[0] : undefined, Boolean(pagination?.valid), site?.excludeSelector, result.imageDescriptions) }
      catch (error) {
        if (result.mode === 'static' && ['content', 'size'].includes(failureFamily(error.code))) return await fallback(error.code)
        const root = document.querySelector(site?.articleSelector ?? 'article,main,[role="main"]')
        await onProgress({ phase: 'extracting', event: 'extraction-failed', details: { code: error.code, chars: tidy(root?.textContent).length, diagnostics: result.diagnostics ?? [] } })
        if (error.code === 'article-short' && result.diagnostics?.includes('content-not-ready')) throw failure('article-content-not-ready')
        throw error
      }
      if (result.mode === 'static' && (value.reasons.size || value.figures.some(figure => figure.error) || value.figures.length < site.expectedMinImages)) return await fallback('article-extraction', [...value.reasons, ...(value.figures.some(figure => figure.error) ? ['static-image-unresolved'] : []), ...(value.figures.length < site.expectedMinImages ? ['adapter-image-count'] : [])])
      await onProgress({ phase: 'extracting', event: 'source-extracted', completed: 1, total: 1, details: { blocks: value.blocks.length, assets: value.figures.length, chars: value.blocks.reduce((sum, block) => sum + textOfBlock(block).length, 0) } })
      // 未支持节点按类别与 origin 计数；签名路径和查询参数不能进入进度诊断。
      let reportedGraphics = 0
      for (const [kind, selector] of [['iframe', 'iframe'], ['video', 'video'], ['audio', 'audio'], ['drawing', 'svg,canvas,[style*="background-image"]']]) {
        const groups = new Map()
        for (const element of value.root.querySelectorAll(selector)) {
          const source = element.getAttribute('src'), href = source ? safeLink(source, result.url) : null, origin = href ? new URL(href).origin : ''
          groups.set(origin, (groups.get(origin) ?? 0) + 1)
        }
        for (const [origin, total] of groups) {
          if (reportedGraphics++ >= config.maxResourceDiagnostics) break
          await onProgress({ phase: 'extracting', event: 'unsupported-graphic', details: { code: `unsupported-${kind}`, total, ...(origin ? { origin } : {}) } })
        }
      }
      const imageSession = value.figures.length ? request.createSession?.({ redirects: site?.imageRedirects ?? [] }) : null
      const imageRequest = async (target, options) => {
        // 原图只携带目标自身作用域的匿名 Cookie；保留默认 Accept，避免 CDN 改变既有图片编码。
        const cookie = jar.header(target)
        const response = await (imageSession ?? request)(target, { ...options, headers: { referer: new URL(result.url).origin + '/', ...(cookie ? { cookie } : {}) } })
        jar.store(response.url ?? target, response.headers)
        return response
      }
      let inspector, media
      try {
        // 初始化也属于候选解码：失败保留该图片位置，不能丢掉已经取得的正文。
        const inspectImage = dependencies.inspectImage ?? (renderer.createImageInspector ? async (bytes, mime) => {
          inspector ??= await renderer.createImageInspector(signal)
          return inspector.inspect(bytes, mime)
        } : renderer.inspectImage?.bind(renderer))
        media = await captureAssets(value.figures, { ...config, ...remaining }, { request: imageRequest,
          inspectImage, signal, onProgress })
      } finally {
        try { await inspector?.dispose() } finally { await imageSession?.dispose() }
      }
      for (const block of value.blocks) if (block.type === 'figure') block.assetId = media.occurrences.get(block.id)
      const reasons = new Set([...value.reasons, ...embedded.reasons, ...(result.diagnostics ?? []), ...media.failures])
      const snapshot = { schemaVersion: 2, id: randomBytes(16).toString('hex'), title: value.title, url: result.url, requestedUrl: url,
        language: options.language || document.documentElement.lang || '', capturedAt: new Date().toISOString(), sourceHash: '0'.repeat(64),
        extractorVersion: 'article-image-rich/1', blocks: value.blocks, assets: media.metadata,
        quality: { status: 'needs-review', reasons: [], checks: [result.mode === 'static' ? 'static-dom' : 'rendered-dom', ...(result.mode === 'static' ? ['static-site-verified'] : []), 'ordered-blocks', 'decoded-assets', ...embedded.checks, ...(value.imageDescriptionsUsed ? ['published-image-descriptions'] : [])] } }
      const customAdapter = dependencies.adapter
      if (site) {
        snapshot.quality.adapter = site.id
        snapshot.quality.checks.push(`adapter:${site.id}`)
        if (matches.length !== 1) reasons.add('adapter-article-scope')
        if (!pagination && site.expectedMinImages > value.figures.length) reasons.add('adapter-image-count')
        if (pagination && !pagination.valid) reasons.add('adapter-pagination-invalid')
        if (site.endSelector && !pagination?.nextUrl) {
          const endings = value.root.querySelectorAll(site.endSelector)
          if (endings.length !== 1) reasons.add('adapter-missing-end')
          else {
            const end = tidy(endings[0].textContent), captured = value.blocks.map(textOfBlock).join(' ')
            // DOM 块边界不保证有空白，富文本段落之间则有分隔；忽略排版空白后核对尾部内容。
            if (!end || !tidy(value.root.textContent).endsWith(end) || !captured.replace(/\s+/gu, '').includes(end.replace(/\s+/gu, ''))) reasons.add('adapter-end-order')
          }
        }
      } else if (customAdapter && await customAdapter.match(result.url)) {
        const findings = await customAdapter.verify({ snapshot, document })
        for (const reason of findings) reasons.add(reason)
        snapshot.quality.adapter = customAdapter.id
        snapshot.quality.checks.push(`adapter:${customAdapter.id}`)
      } else reasons.add('unknown-article-scope')
      // 全页资源未静默可能只是统计请求；保留诊断并要求核对，不据此断言正文缺失。
      const knownMissing = media.failures.length > 0 || [...reasons].some(reason => reason.startsWith('adapter-') || ['embedded-source-incomplete', 'unhandled-pagination', 'unsupported-graphic', 'scroll-budget-exhausted', 'content-not-ready', 'unsafe-expand-control'].includes(reason))
      if (result.mode === 'static' && knownMissing) return await fallback('article-extraction', [...reasons], media.transferredBytes)
      snapshot.quality.status = knownMissing ? 'partial' : reasons.size ? 'needs-review' : 'passed'
      snapshot.quality.reasons = [...reasons]
      snapshot.sourceHash = hashSnapshot(snapshot)
      if (signal.aborted) throw failure('article-interrupted')
      if (result.mode === 'static') await onProgress({ phase: 'extracting', event: 'static-complete', details: { blocks: value.blocks.length, assets: media.metadata.length } })
      return { snapshot: snapshotSchema.parse(snapshot), assets: media.assets, pagination, transferredBytes: media.transferredBytes, imageCount: value.figures.length, expectedMinImages: site?.expectedMinImages ?? 0 }
    } finally { dom.window.close() }
  }
  const run = async (url, options) => {
    const first = await captureOne(url, options)
    if (!first.pagination) return { snapshot: first.snapshot, assets: first.assets }
    const parts = [first], visited = new Set([first.snapshot.url]), identity = first.pagination.identity
    let current = first, consumedBytes = first.transferredBytes, consumedImages = first.imageCount
    while (current.pagination.valid && current.pagination.nextUrl) {
      const next = current.pagination.nextUrl
      if (parts.length >= first.pagination.maxPages || visited.has(next)) {
        current.snapshot.quality.reasons.push('adapter-pagination-budget')
        break
      }
      visited.add(next)
      let candidate
      try { candidate = await captureOne(next, options, identity, { maxTotalImageBytes: Math.max(0, config.maxTotalImageBytes - consumedBytes), maxImages: Math.max(0, config.maxImages - consumedImages) }) }
      catch (error) {
        if (error.code !== 'article-pagination-identity') throw error
        current.snapshot.quality.reasons.push('adapter-pagination-identity')
        break
      }
      if (!candidate.pagination?.valid || candidate.pagination.identity !== identity) {
        current.snapshot.quality.reasons.push('adapter-pagination-identity')
        break
      }
      parts.push(candidate); current = candidate
      consumedBytes += candidate.transferredBytes; consumedImages += candidate.imageCount
    }
    const snapshot = { ...first.snapshot, blocks: [], assets: [], pages: [] }, unique = new Map(), bytes = new Map(), reasons = new Set()
    let totalChars = 0, totalBytes = 0, imageCount = 0
    for (const part of parts) {
      const ids = new Map(), pageBlocks = []
      for (const block of part.snapshot.blocks) {
        if (part !== first && !pageBlocks.length && block.type === 'heading' && block.level === 1 && textOfBlock(block) === first.snapshot.title) continue
        const id = `b${snapshot.blocks.length + 1}`
        ids.set(block.id, id); pageBlocks.push(id); snapshot.blocks.push({ ...block, id })
        totalChars += block.type === 'figure' ? 0 : textOfBlock(block).length
        if (block.type === 'figure') imageCount++
      }
      snapshot.pages.push({ url: part.snapshot.url, blockIds: pageBlocks })
      for (const asset of part.snapshot.assets) {
        const positions = asset.positions.map(id => ids.get(id)).filter(Boolean), previous = unique.get(asset.id)
        if (previous) previous.positions.push(...positions)
        else { unique.set(asset.id, { ...asset, positions }); totalBytes += asset.byteLength }
      }
      for (const asset of part.assets) if (!bytes.has(asset.id)) bytes.set(asset.id, asset)
      for (const reason of part.snapshot.quality.reasons) reasons.add(reason)
    }
    if (totalChars > config.maxArticleChars) throw failure('article-truncated')
    if (totalBytes > config.maxTotalImageBytes) throw failure('image-byte-limit')
    if (imageCount > config.maxImages) reasons.add('image-count-limit')
    if (imageCount < first.expectedMinImages) reasons.add('adapter-image-count')
    snapshot.assets = [...unique.values()]
    const partial = parts.some(part => part.snapshot.quality.status === 'partial') || [...reasons].some(reason => reason.startsWith('adapter-') || reason.startsWith('image-'))
    snapshot.quality = { ...first.snapshot.quality, status: partial ? 'partial' : reasons.size ? 'needs-review' : 'passed', reasons: [...reasons] }
    snapshot.sourceHash = hashSnapshot(snapshot)
    return { snapshot: snapshotSchema.parse(snapshot), assets: [...bytes.values()].map(asset => ({ ...asset, positions: unique.get(asset.id).positions })) }
  }
  return {
    capture(url, options = {}) {
      const operation = run(url, options).catch(error => {
        if (lifetime.signal.aborted || options.signal?.aborted) throw failure('article-interrupted')
        throw error
      })
      active.add(operation)
      void operation.finally(() => active.delete(operation)).catch(error => { void error })
      return operation
    },
    readiness: () => renderer.readiness(),
    dispose() {
      if (!disposing) {
        disposed = true
        disposing = Promise.resolve().then(async () => {
          try { await renderer.dispose() }
          finally { await Promise.allSettled([...active]) }
        })
        lifetime.abort()
      }
      return disposing
    },
  }
}
