/** Extract inert article text without executing page code or loading resources. */
import { JSDOM, VirtualConsole } from 'jsdom'
import { Readability } from '@mozilla/readability'
import { hash } from './hash.js'
import { failure, assertArticleStatus } from './contracts.js'

/** Build a bounded article record, rejecting short or oversized sources. @param {object} input Source metadata. @param {object} config Text limits. @returns {object} Durable article. */
export function articleRecord({ title, text, url, language = '', basis }, config) {
  const clean = text.replace(/\r\n?/g, '\n').trim()
  if (clean.length < config.minArticleChars) throw failure('article-short')
  if (clean.length > config.maxArticleChars) throw failure('article-truncated')
  const paragraphs = clean.split(/\n\s*\n/).flatMap(part => {
    const chunks = []
    let chunk = ''
    // 持久化字符串长度按 UTF-16 单元校验；逐码点读取以保留完整代理对。
    for (const character of part.trim()) {
      if (chunk.length + character.length > 1500) { chunks.push(chunk); chunk = '' }
      chunk += character
    }
    if (chunk) chunks.push(chunk)
    return chunks
  }).filter(Boolean).map((value, index) => ({ id: index + 1, text: value }))
  return { title: title.trim().slice(0, 2000), paragraphs, url, language, basis, fetchedAt: new Date().toISOString(),
    hash: hash(JSON.stringify({ title: title.trim(), paragraphs, url, language })) }
}

const blockElements = new Set(['ARTICLE', 'SECTION', 'MAIN', 'DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'DL', 'DT', 'DD', 'FIGCAPTION', 'TABLE', 'TR', 'TH', 'TD', 'BR', 'HR'])
const omittedElements = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'SVG', 'CANVAS'])
const gateBlocks = 'p,h1,h2,h3,h4,h5,h6,button'

function normalized(text) { return text.normalize('NFKD').replace(/\p{M}/gu, '').replace(/\s+/gu, ' ').trim().toLowerCase() }

function articleBlocks(root) {
  const blocks = [], stack = [{ node: root, closing: false }]
  let parts = []
  const flush = () => {
    const text = parts.join('').replace(/\s+/gu, ' ').trim()
    if (text) blocks.push(text)
    parts = []
  }
  // 父列表项与子段落共用文本节点；按进入和离开块的位置分段，每个节点只读取一次。
  while (stack.length) {
    const { node, closing } = stack.pop()
    if (node.nodeType === 3) { parts.push(node.nodeValue); continue }
    if (node.nodeType !== 1 || omittedElements.has(node.tagName)) continue
    const block = blockElements.has(node.tagName)
    if (block) flush()
    if (closing) continue
    if (block) stack.push({ node, closing: true })
    for (let index = node.childNodes.length - 1; index >= 0; index--) stack.push({ node: node.childNodes[index], closing: false })
  }
  flush()
  return blocks
}

function isSubscriptionNotice(text) {
  const value = normalized(text)
  return /^(?:(?:este|esse|o) conteudo (?:e )?(?:exclusivo|restrito) (?:para |a )?assinantes\b|(?:assine|faca uma assinatura)\b.*para (?:continuar|ler)\b|subscribe\b.*to (?:continue|read)\b)/u.test(value)
}

const skipLinkPhrases = /^(?:skip|jump) to\b|^ir para\b|^pular para\b|^saltar (?:a|al|para)\b|^(?:aller|acceder) (?:a|au|aux)\b|^zum inhalt\b|^direkt (?:zu|zum)\b|^vai (?:a|al)\b/u

/**
 * Remove the site chrome around the article: landmark regions (nav, aside, footer,
 * banner, contentinfo, search), in-page keyboard skip links, cookie bars and the
 * filter/breadcrumb toolbars publishers place above an article title. Readability removes
 * most of this by scoring, but its short-content retry restores the full page, and the
 * restored navigation text then reads as article paragraphs.
 * @param {Document} document Parsed page.
 */
export function removeLandmarks(document) {
  for (const element of document.querySelectorAll('nav,aside,footer,[role="banner"],[role="contentinfo"],[role="search"],[role="navigation"],[role="complementary"]')) element.remove()
  // 顶层 header 是站点页眉（logo、菜单、无障碍工具条）；article/main 内的 header 是标题区，保留。
  for (const header of document.querySelectorAll('header')) {
    if (!header.closest('article,main')) header.remove()
  }
  // 正文页标题上方的筛选器与面包屑是站点控件：bcb.gov.br 的 “Filtrar por: Tudo Notícias …”
  // 在正文只有一句话时会被 Readability 短正文重试捞回，成为文章首段。
  for (const toolbar of document.querySelectorAll('[class*="breadcrumb" i],[class*="filter" i],[class*="toolbar" i],[class*="cookiebar" i],[class*="cookie-bar" i]')) {
    if (!toolbar.closest('article')) toolbar.remove()
  }
  for (const anchor of document.querySelectorAll('a[href^="#"]')) {
    const text = normalized(anchor.textContent ?? '')
    if (text.length <= 60 && skipLinkPhrases.test(text)) anchor.remove()
  }
}

/**
 * Drop visibility-only hiding before extraction. Readability skips elements whose inline
 * style is visibility:hidden, but pages hide the article container this way and reveal it
 * after boot (paywalls, delayed rendering). Only visibility is cleared: display:none and the
 * hidden/aria-hidden attributes still mark subtrees as removed.
 * @param {Document} document Parsed page.
 */
export function revealHiddenText(document) {
  for (const element of document.querySelectorAll('[style*="visibility" i]')) {
    const style = element.style
    if (!style || style.visibility !== 'hidden') continue
    style.visibility = ''
    if (!style.cssText.trim()) element.removeAttribute('style')
  }
}

function inspectPage(document) {
  assertDeclaredAccess(document)
  const root = document.querySelector('main') ?? document.querySelector('article') ?? document.body
  // cookie 同意横幅与地标/跳转锚都是站点界面而非正文；先移除，正文选择与限制检测都不再读到它们。
  for (const banner of document.querySelectorAll('[class*="cookie" i],[id*="cookie" i],[class*="consent" i],[id*="consent" i]')) {
    if (banner !== root && !banner.contains(root)) banner.remove()
  }
  removeLandmarks(document)
  revealHiddenText(document)
  const heading = document.querySelector('article h1') ?? root.querySelector('h1')
  const headings = [document.title, heading?.textContent ?? '']
    .map(text => normalized(text).replace(/\s+[|–—-]\s+.*$/u, '').replace(/[.!…:]+$/gu, ''))
  const pageText = normalized(articleBlocks(root).join(' '))
  const challengeHeading = headings.some(text => /^(?:just a moment|attention required|checking your browser|verify (?:that )?you are human|verifique (?:se )?(?:voce )?(?:e )?humano|verificacao de seguranca)$/u.test(text))
  const challengeMarker = document.querySelector('#challenge-form,#cf-challenge-running,#challenge-running,.cf-turnstile,.g-recaptcha,#px-captcha,[name="cf-turnstile-response"],script[src*="/cdn-cgi/challenge-platform/"]')
  const challengeForm = root.querySelector('form#challenge-form,#cf-challenge-running,#challenge-running,#px-captcha')
  const challengeText = normalized(challengeForm?.textContent ?? '')
  // 评论区或登录弹窗也可能带人机验证组件；普通验证组件需要页面主标题的限制证据。
  if ((challengeHeading && challengeMarker) || (challengeForm && /(?:verifique (?:se )?voce e humano|confirme que voce nao e um robo|verify (?:that )?you are human|checking your browser|verifique seu navegador)/u.test(challengeText))) throw failure('article-challenge')
  const loginHeading = headings.some(text => /^(?:login|entrar(?: para continuar)?|entre(?: na sua conta)?|faca(?: o)? login(?: para continuar(?: lendo)?)?|inicie sessao(?: para continuar)?|sign in(?: to (?:continue|read))?|log in(?: to (?:continue|read))?)$/u.test(text))
  if (loginHeading && (root.querySelector('input[type="password"]') || /(?:para continuar lendo|para ler (?:esta|essa|a) (?:noticia|reportagem|materia)|to (?:continue reading|read (?:this|the) (?:article|story)))/u.test(pageText))) throw failure('article-login')
  const description = document.querySelector('meta[name="description" i],meta[property="og:description" i]')?.content ?? ''
  // 限制提示普遍位于承载正文的同一容器内（推广尾注、订阅横幅）。先摘掉提示块并度量剩余正文，
  // 只有正文确实不足、或页面声明正文不可访问时才算受限；提示文本本身不构成证据。
  const access = structuredAccess(document)
  let noticeChars = 0, bodyChars = 0
  for (const gate of document.querySelectorAll('[class*="paywall" i],[id*="paywall" i],[data-paywall],[data-access="restricted"],[data-testid*="paywall" i],[class*="subscription-wall" i]')) {
    const blocks = [...gate.querySelectorAll(gateBlocks)]
    const notices = (blocks.length ? blocks : [gate]).filter(node => isSubscriptionNotice(node.textContent))
    for (const notice of notices) { noticeChars += normalized(notice.textContent).length; notice.remove() }
    bodyChars += normalized(gate.textContent).length
  }
  return { access, noticeChars, bodyChars, description }
}

/** Read structured access declarations that pages publish for crawlers. @param {Document} document Parsed page. @returns {object} Declared access facts. */
function structuredAccess(document) {  const result = { declaredFree: null, restrictedSelectors: [] }
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    let data
    try { data = JSON.parse(script.textContent) } catch (error) { void error; continue }
    const nodes = Array.isArray(data) ? data : [data, ...(Array.isArray(data['@graph']) ? data['@graph'] : [])]
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue
      if (node.isAccessibleForFree === false || node.isAccessibleForFree === 'False') result.declaredFree = false
      else if ((node.isAccessibleForFree === true || node.isAccessibleForFree === 'True') && result.declaredFree === null) result.declaredFree = true
      const parts = [node.hasPart, node.isPartOf].flat().filter(part => part && typeof part === 'object')
      for (const part of parts) {
        if (part.isAccessibleForFree !== false || typeof part.cssSelector !== 'string') continue
        if (part.cssSelector.length <= 200) result.restrictedSelectors.push(part.cssSelector)
      }
    }
  }
  return result
}

/** Reject a declared subscriber teaser with a separate visible wall placeholder; body-bearing paywall containers remain eligible for normal inspection. @param {Document} document Parsed page. */
export function assertDeclaredAccess(document) {
  if (structuredAccess(document).declaredFree !== false) return
  for (const gate of document.querySelectorAll('[class*="paywall" i],[id*="paywall" i],[data-access="restricted"]')) {
    if (gate.closest('[hidden],[aria-hidden="true"],[data-ai-hidden="true"]') || gate.style.display === 'none') continue
    // 空的计量墙占位仍代表正文限制；不能因摘要足够长而把它升级成全文。
    if (!gate.querySelector('p') && !gate.matches('p')) throw failure('article-restricted')
  }
}

/**
 * Read the article body a page publishes as JSON-LD.
 * Publishers often serialize the full text into `articleBody` for crawlers while the
 * visible DOM carries only a teaser, so this is a second projection of the same bytes.
 * @param {string} html Page markup.
 * @returns {{title: string, text: string}|null} Declared article, or null.
 */
export function structuredArticle(html) {
  const dom = new JSDOM(html, { virtualConsole: new VirtualConsole() })
  try {
    const document = dom.window.document
    let best = null
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data
      try { data = JSON.parse(script.textContent) } catch (error) { void error; continue }
      const nodes = Array.isArray(data) ? data : [data, ...(Array.isArray(data['@graph']) ? data['@graph'] : [])]
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue
        const body = node.articleBody
        if (typeof body !== 'string' || body.trim().length < 1) continue
        // 多节点时取最长正文：列表页的 @graph 会同时带摘要卡片与完整文章。
        if (!best || body.length > best.text.length) best = { title: typeof node.headline === 'string' ? node.headline : '', text: body }
      }
    }
    return best
  } finally { dom.window.close() }
}

/**
 * Re-run extraction inside the page's own main region when the first pass picked a
 * page-level wrapper. Angular/React shells often render the article inside `<main>`
 * while the scoring pass selects a `div.page` that also holds the site header, search
 * panel and filter toolbar; those then read as the first article paragraphs.
 * The main markup must be captured before Readability runs: parse() mutates the input
 * document and removes the region this function needs.
 * @param {Document} document Parsed page, used only for document creation.
 * @param {object} result First Readability result.
 * @param {object} config Limits.
 * @param {string} mainHtml Main region markup captured before parsing.
 * @returns {object} Possibly narrowed result.
 */
function narrowToMain(document, result, config, mainHtml) {
  if (!result?.content || !mainHtml) return result
  const width = node => normalized(node?.textContent ?? '').length
  const wide = width(result.content)
  if (wide < config.minArticleChars) return result
  const narrow = document.implementation.createHTMLDocument(document.title ?? '')
  narrow.body.innerHTML = mainHtml
  const nested = new Readability(narrow, { charThreshold: config.minArticleChars, maxElemsToParse: config.maxArticleElements, serializer: node => node }).parse()
  if (!nested) return result
  const narrowWidth = width(nested.content)
  if (narrowWidth >= wide * 0.6) return { ...result, content: nested.content, title: nested.title || result.title }
  // 容器内正文远短于首轮结果时，通常是首轮把主区域之外的站点壳算了进去。
  // 只有当首轮结果的文本并不来自该容器时才收窄；否则保留首轮结果，避免丢掉真正的正文。
  const mainText = normalized(narrow.body.textContent ?? '')
  const resultText = normalized(result.content.textContent ?? '')
  if (mainText.includes(resultText) || resultText.includes(mainText)) return result
  return narrowWidth >= config.minArticleChars ? { ...result, content: nested.content, title: nested.title || result.title } : result
}

// 正文容器类名：站点把文章主体标成这些名字，外围工具栏与导航则不会。命中时直接作为候选，
// 省掉 Readability 对整页的打分，也避免把 main 之外的搜索/筛选面板算进正文。
const articleContainerHint = /(?:^|[-_])(?:article|post|noticia|mat[eé]ria|reportagem|story|entry|conte[uú]do|corpo|body|text)(?:[-_]|$)/iu

/**
 * Capture the markup of the page's declared article container, if any. Search panels,
 * filter toolbars and cookie bars sit outside these containers, so extracting from the
 * container removes them without guessing by width.
 * @param {Document} document Parsed page, before Readability mutates it.
 * @param {object} config Limits.
 * @returns {string} Container markup, or an empty string when none qualifies.
 */
function declaredContainerHtml(document, config) {
  const width = node => normalized(node?.textContent ?? '').length
  let best = null, bestWidth = 0
  for (const element of document.querySelectorAll('[class],[id]')) {
    const className = typeof element.className === 'string' ? element.className : ''
    if (!articleContainerHint.test(className) && !articleContainerHint.test(element.id ?? '')) continue
    const text = width(element)
    if (text < config.minArticleChars || text <= bestWidth) continue
    best = element
    bestWidth = text
  }
  return best?.outerHTML ?? ''
}

// 正文前的元数据行：发布日期、更新时间、分类标签、作者署名。站点把这几行排成独立段落，
// Readability 会保留它们并挤到正文最前面。只认短行，避免把真正的一句话导语当成元数据。
const metadataLine = /^(?:publicado|atualizado|publicado em|atualizado em|posted on?|updated|last updated|published)\b|^(?:updated on|published on)\s*:?\s*\w+\s+\d{1,2},?\s*\d{4}|^\d{1,2}\/\d{1,2}\/\d{2,4}\b|^(?:categoria|category|tags?)\s*[:：]|^(?:por|by)\s+\S{2,40}$/iu
// 时间戳被拆成两段时，后半段以逗号或“atualizado”开头（metropoles 把日期与更新说明分开渲染）。
const metadataTail = /^[,;]\s*(?:atualizado|updated|modificado|modified|published|publicado)\b/iu
// 面包屑残留：站点把详情页分区名单独排成一段（bcb 的 “detalhenoticia”）。
const breadcrumbTag = /^detalhe[-_]?(?:noticia|notícia|materia|matéria|conteudo|conteúdo)$/iu
const authorBioLine = /^(?:[A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÁÉÍÓÚÂÊÔÃÕÇáéíóúâêôãõç'’.-]+\s+){1,4}(?:é|is|foi)\s+(?:formad[oa]|jornalista|escritor|graduad[oa]|especialista|correspondente)/u
// 站点搜索/筛选面板会作为独立短段落在正文最前面出现（bcb.gov.br 等）。这些短语不承载文章内容。
const chromeLine = /^(?:filtrar por|filter by|buscar|search|pesquisar)\s*:?$|^(?:tudo|todas|all)\s+(?:not[ií]cias|publica[cç][oõ]es|normativos|news|publications)\b/iu
// 署名块：姓名、职务、“查看完整简介”链接与作者简介句。它们在正文前连续出现，成组裁掉。
const bylineMarker = /^(?:by|por|von|par|di|door)\s*$/iu
const bylineRole = /^(?:news editor|editor|reporter|correspondent|staff writer|contributor|senior \w+|associate \w+|journalist|jornalista|correspondente|redator[a]?|editore|redattore|rédacteur|redakteur)\b/iu
const bylineName = /^(?:[A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÁÉÍÓÚÂÊÔÃÕÇáéíóúâêôãõç'’.-]+\s+){1,3}[A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÁÉÍÓÚÂÊÔÃÕÇáéíóúâêôãõç'’.-]+$/u
const bioTail = /^(?:read full bio|ver biografia completa|leia a biografia|biographie complète)\b|\b(?:é|is|foi)\s+(?:formad[oa]|jornalista|escritor|graduad[oa]|especialista|correspondente)\b|\bgraduat(?:e|ed) (?:of|from)\b|\bis (?:a|an) \w+ (?:editor|reporter|correspondent|writer)\b|\b(?:editor|reporter|correspondent) (?:at|for|na|no|da|do)\b/iu
// 图片说明：正文配图的出处行常紧跟媒体署名，不承载正文。
const captionCredit = /(?:getty images|afp|reuters|associated press|ap photo|shutterstock|epa|ansa|photographer|fotografo|fotógrafo)\s*$/iu
// 图注成对出现：说明文字后跟一行“姓名 | 机构”。说明行本身可以含逗号，只看后一行是否是机构署名。
const creditLine = /^[\p{Lu}][\p{L}.\s'-]{2,40}\s*[|—–-]\s*[\p{Lu}][\p{L}\s.&'-]{2,40}$/u

// 分享与打印控件常被排成正文前的独立短行（bcb 的 “Compartilhe:” / “print Imprimir”）。
const shareLine = /^(?:compartilhe|compartilhar|share|teilen|partager)\s*:?$|^(?:print|imprimir|drucken|impression)\b/iu

/**
 * Drop metadata blocks that crowd the top of the extracted body. Publishers place a
 * timestamp, a category label, an author byline and a photo credit above the lede, and
 * Readability keeps them as ordinary paragraphs because they sit inside the article
 * container. Trimming stops at the first substantial block so real prose is never touched.
 * @param {string[]} blocks Extracted text blocks.
 * @param {string} title Article title.
 * @returns {string[]} Blocks without leading metadata.
 */
function trimLeadingMetadata(blocks, title) {
  // 尾部的“Publicado em…”是页面脚注，不是正文开头，只在头部裁剪。
  let start = 0
  while (start < blocks.length) {
    const value = blocks[start].trim()
    const next = blocks[start + 1]?.trim() ?? ''
    if (!value.length) break
    // 块内剥离先于长度守卫：bcb 这类页面把面包屑、标题与正文并进同一段，长度不能作为跳过依据。
    const inline = stripInlineMetadata(value, title)
    if (inline !== value) {
      if (inline.length >= 1) blocks[start] = inline
      else start += 1
      continue
    }
    if (value.length > 300) break
    if (normalized(value) === normalized(title)) { start += 1; continue }
    if (metadataLine.test(value) || metadataTail.test(value) || breadcrumbTag.test(value) || authorBioLine.test(value) || chromeLine.test(value) || shareLine.test(value) || captionCredit.test(value)) { start += 1; continue }
    // “说明文字 + 姓名 | 机构”是一对图注，两段一起裁掉。说明行允许含逗号与较长描述。
    if (creditLine.test(next) && !/[.!?]\s*\p{Ll}/u.test(value)) { start += 2; continue }
    // 署名块：By、姓名、职位、简介、完整简介链接。它们连续出现，成组裁掉。
    if (bylineMarker.test(value) || bylineRole.test(value) || bylineName.test(value) || bioTail.test(value)) {
      start += 1
      while (start < blocks.length) {
        const follow = blocks[start].trim()
        // 署名区只吃明显是署名的短行；带句末标点或较长的一行是正文，立即停止。
        if (!follow.length || follow.length > 90 || /[.!?]\s/u.test(follow) || metadataLine.test(follow)) break
        if (!(bylineRole.test(follow) || bylineName.test(follow) || bioTail.test(follow))) break
        start += 1
      }
      continue
    }
    break
  }
  // 全部被裁掉时保留原样：由长度校验给出 article-short，而不是返回空正文。
  return start >= blocks.length ? blocks : blocks.slice(start)
}

// 块内前缀：面包屑标签、与标题重复的部分、发布时间。重复剥离直到不再变化。
const inlinePrefix = /^(?:detalhe[-_]?(?:noticia|notícia|materia|matéria|conteudo|conteúdo)\b|(?:publicado|atualizado|published|updated)(?:\s+em)?\s*:?\s*\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s*(?:às|as|at)\s*\d{1,2}[:h]\d{2})?|(?:publicado|atualizado|published|updated)\s+em\s*:?)\s*/iu

/**
 * Remove metadata that the page merged into the first text block instead of emitting as
 * its own paragraph. Publishers whose article body is a single link (bcb notas) render
 * breadcrumb, title and timestamp into one block; dropping the block would drop the body.
 * @param {string} value First text block.
 * @param {string} title Article title.
 * @returns {string} Block without its metadata prefix, or the input when nothing matched.
 */
function stripInlineMetadata(value, title) {
  let text = value
  for (let round = 0; round < 6; round++) {
    const before = text
    text = text.replace(inlinePrefix, '')
    if (title.length >= 8 && normalized(text).startsWith(normalized(title))) text = text.slice(findTitleEnd(text, title))
    text = text.trim()
    if (text === before) break
  }
  return text.trim()
}

/** Length of the leading segment of `text` that matches `title`, tolerant of spacing. @param {string} text Block. @param {string} title Title. @returns {number} Characters consumed. */
function findTitleEnd(text, title) {
  const wanted = normalized(title)
  let seen = ''
  for (let index = 0; index < text.length; index++) {
    seen = normalized(text.slice(0, index + 1))
    if (seen.length >= wanted.length) return index + 1
  }
  return 0
}

/** Drop search and filter panel fragments anywhere in the body; they never carry article prose. @param {string[]} blocks Extracted text blocks. @returns {string[]} Blocks without chrome fragments. */
function removeChromeBlocks(blocks) {
  const kept = blocks.filter(block => !chromeLine.test(block.trim()))
  return kept.length >= 2 ? kept : blocks
}

/** Extract readable text while rejecting recognized access gates; this does not certify completeness. @param {object} page Web result. @param {object} item Imported item. @param {object} config Limits. @returns {object} Durable article. */
export function extractArticle(page, item, config) {
  assertArticleStatus(page.statusCode)
  if (page.truncated) throw failure('article-truncated')
  // declaredTitle 来自结构化声明：正文由 JSON-LD 提供时，页面自身标题仍是最准确的标题。
  let title = page.declaredTitle || item.url, text = page.body.content, language = item.language
  if (page.body.kind === 'html') {    // 页面解析诊断可能包含完整样式文本；实例控制台不转发到调用方日志。
    const dom = new JSDOM(text, { url: page.url || item.url, virtualConsole: new VirtualConsole() })
    try {
      const document = dom.window.document
      if (document.getElementsByTagName('*').length > config.maxArticleElements) throw failure('article-extraction')
      language ||= document.documentElement.lang
      const { access, noticeChars, description } = inspectPage(document)
      // Readability.parse() 会改写输入文档并摘除它选中的容器；main 必须在解析前抓取。
      const mainHtml = (document.querySelector('main') ?? document.querySelector('[role="main"]'))?.innerHTML ?? ''
      // 声明的正文容器同样要在解析前定位：parse() 之后文档已被改写。
      const containerHtml = declaredContainerHtml(document, config)
      let result
      try {
        result = new Readability(document, { charThreshold: config.minArticleChars, maxElemsToParse: config.maxArticleElements, serializer: node => node }).parse()
        result = narrowToMain(document, result, config, containerHtml || mainHtml)
      } catch (error) {
        // 不把解析器的页面内容或内部异常文本带入工具和持久化错误记录。
        void error
        throw failure('article-extraction')
      }
      if (!result) throw failure(access.declaredFree === false || noticeChars > 0 ? 'article-restricted' : 'article-extraction')
      title = result.title || title
      const blocks = removeChromeBlocks(trimLeadingMetadata(articleBlocks(result.content), title))
      text = blocks.join('\n\n')
      const bodyWithoutTitle = blocks[0] && normalized(blocks[0]) === normalized(title) ? blocks.slice(1).join(' ') : text
      // 受限只在正文确实不足时成立：结构化声明正文不可见，或限制提示已经占据主体。
      const short = bodyWithoutTitle.length < config.minArticleChars
      const noticeDominates = noticeChars > 0 && bodyWithoutTitle.length < noticeChars
      const descriptionOnly = Boolean(description) && normalized(bodyWithoutTitle) === normalized(description)
      if ((short && access.declaredFree === false) || noticeDominates || (short && descriptionOnly)) throw failure('article-restricted')
    } finally { dom.window.close() }
  } else {
    // 纯文本投影（渲染后的可见文本、JSON-LD 正文、已解码的纯文本页面）没有块标记，
    // 只能按行切块后走同一套头部清理：整行当一块，清理规则与 HTML 路径共用。
    text = removeChromeBlocks(trimLeadingMetadata(text.split(/\n+/).map(line => line.trim()).filter(Boolean), page.declaredTitle || item.url)).join('\n\n')
  }
  return articleRecord({ title, text, language, url: page.url || item.url, basis: 'web' }, config)
}
