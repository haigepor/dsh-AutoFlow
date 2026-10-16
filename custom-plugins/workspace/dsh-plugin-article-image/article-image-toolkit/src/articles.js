/** Extract inert article text without executing page code or loading resources. */
import { JSDOM, VirtualConsole } from 'jsdom'
import { Readability } from '@mozilla/readability'
import { hash } from './hash.js'
import { failure } from './contracts.js'

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

function inspectPage(document) {
  const root = document.querySelector('main') ?? document.querySelector('article') ?? document.body
  const heading = document.querySelector('article h1') ?? root.querySelector('h1')
  const headings = [document.title, heading?.textContent ?? '']
    .map(text => normalized(text).replace(/\s+[|–—-]\s+.*$/u, '').replace(/[.!…:]+$/gu, ''))
  const pageText = normalized(articleBlocks(root).join(' '))
  const challengeHeading = headings.some(text => /^(?:just a moment|attention required|checking your browser|verify (?:that )?you are human|verifique (?:se )?(?:voce )?(?:e )?humano|verificacao de seguranca)$/u.test(text))
  const challengeMarker = document.querySelector('#challenge-form,#cf-challenge-running,#challenge-running,.cf-turnstile,.g-recaptcha,#px-captcha,[name="cf-turnstile-response"],script[src*="/cdn-cgi/challenge-platform/"]')
  const challengeForm = root.querySelector('form#challenge-form,#cf-challenge-running,#challenge-running,#px-captcha')
  const challengeText = normalized(challengeForm?.textContent ?? '')
  // 评论区或登录弹窗也可能带 CAPTCHA；普通验证组件需要页面主标题的限制证据。
  if ((challengeHeading && challengeMarker) || (challengeForm && /(?:verifique (?:se )?voce e humano|confirme que voce nao e um robo|verify (?:that )?you are human|checking your browser|verifique seu navegador)/u.test(challengeText))) throw failure('article-challenge')
  const loginHeading = headings.some(text => /^(?:login|entrar(?: para continuar)?|entre(?: na sua conta)?|faca(?: o)? login(?: para continuar(?: lendo)?)?|inicie sessao(?: para continuar)?|sign in(?: to (?:continue|read))?|log in(?: to (?:continue|read))?)$/u.test(text))
  if (loginHeading && (root.querySelector('input[type="password"]') || /(?:para continuar lendo|para ler (?:esta|essa|a) (?:noticia|reportagem|materia)|to (?:continue reading|read (?:this|the) (?:article|story)))/u.test(pageText))) throw failure('article-login')
  const description = document.querySelector('meta[name="description" i],meta[property="og:description" i]')?.content ?? ''
  let restricted = false
  for (const gate of document.querySelectorAll('[class*="paywall" i],[id*="paywall" i],[data-paywall],[data-access="restricted"],[data-testid*="paywall" i],[class*="subscription-wall" i]')) {
    const blocks = [...gate.querySelectorAll(gateBlocks)]
    const notices = (blocks.length ? blocks : [gate]).filter(node => isSubscriptionNotice(node.textContent))
    if (!notices.length) continue
    restricted = true
    // 仅删除结构化限制区域中的提示块，保留同一容器内仍然可读的正文。
    for (const notice of notices) notice.remove()
  }
  return { restricted, description }
}

/** Extract readable text while rejecting recognized access gates; this does not certify completeness. @param {object} page Web result. @param {object} item Imported item. @param {object} config Limits. @returns {object} Durable article. */
export function extractArticle(page, item, config) {
  if (page.statusCode === 404) throw failure('article-not-found')
  if (page.statusCode === 429) throw failure('article-rate-limit')
  if (page.statusCode >= 500) throw failure('article-server')
  if (page.statusCode < 200 || page.statusCode >= 300) throw failure('article-access')
  if (page.truncated) throw failure('article-truncated')
  let title = item.url, text = page.body.content, language = item.language
  if (page.body.kind === 'html') {
    // 页面解析诊断可能包含完整样式文本；实例控制台不转发到调用方日志。
    const dom = new JSDOM(text, { url: page.url || item.url, virtualConsole: new VirtualConsole() })
    try {
      const document = dom.window.document
      if (document.getElementsByTagName('*').length > config.maxArticleElements) throw failure('article-extraction')
      language ||= document.documentElement.lang
      const { restricted, description } = inspectPage(document)
      let result
      try {
        result = new Readability(document, { charThreshold: config.minArticleChars, maxElemsToParse: config.maxArticleElements, serializer: node => node }).parse()
      } catch (error) {
        // 不把解析器的页面内容或内部异常文本带入工具和持久化错误记录。
        void error
        throw failure('article-extraction')
      }
      if (!result) throw failure(restricted ? 'article-restricted' : 'article-extraction')
      title = result.title || title
      const blocks = articleBlocks(result.content)
      text = blocks.join('\n\n')
      const bodyWithoutTitle = blocks[0] && normalized(blocks[0]) === normalized(title) ? blocks.slice(1).join(' ') : text
      // 限制提示与长度或原始摘要同时吻合才拒绝；订阅元数据本身不能证明正文缺失。
      if (restricted && (bodyWithoutTitle.length < config.minArticleChars || (description && normalized(bodyWithoutTitle) === normalized(description)))) throw failure('article-restricted')
    } finally { dom.window.close() }
  }
  return articleRecord({ title, text, language, url: page.url || item.url, basis: 'web' }, config)
}
