/** Audit a URL corpus through the production rich kernel without business records or model calls. */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import { JSDOM, VirtualConsole } from 'jsdom'
import { createCapture, resolveCaptureConfig } from '../src/capture.js'
import { CaptureRenderer } from '../src/capture-renderer.js'
import { createPublicRequest } from '../src/capture-media.js'
import { CookieJar } from '../src/session.js'
import { textOfBlock } from '../src/capture-contracts.js'
import { dimsOriginal } from '../src/declared-images.js'

const { values } = parseArgs({ options: {
  input: { type: 'string' }, config: { type: 'string' }, out: { type: 'string' },
  concurrency: { type: 'string', default: '2' }, only: { type: 'string' }, review: { type: 'string' },
  'timeout-ms': { type: 'string' },
} })
if (!values.input || !values.config || !values.out) throw new Error('Required: --input <JSON rows> --config <capture/profile JSON> --out <private directory>')
const concurrency = Number(values.concurrency)
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Concurrency must be 1..8')
const input = JSON.parse(await readFile(resolve(values.input), 'utf8'))
if (!Array.isArray(input) || !input.length || input.some(row => !Number.isInteger(row.index) || row.index < 1 || typeof row.url !== 'string')) throw new Error('Input rows require positive index and URL')
const wanted = values.only ? new Set(values.only.split(',').map(Number)) : null
const rows = input.filter(row => !wanted || wanted.has(row.index))
const raw = JSON.parse(await readFile(resolve(values.config), 'utf8'))
const config = resolveCaptureConfig(raw.capture ? { ...raw.capture, network: raw.capture.network ?? raw.network } : raw)
const timeoutMs = Number(values['timeout-ms'] ?? config.renderTimeoutMs + config.requestTimeoutMs * 2)
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800000) throw new Error('Audit timeout must be 1000..1800000 ms')
const output = resolve(values.out)
await mkdir(output, { recursive: true, mode: 0o700 })
const normalize = value => (value ?? '').normalize('NFKC').replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"').replace(/\s+/gu, ' ').trim()
const compact = value => normalize(value).replace(/\s+/gu, '')
const excluded = 'nav,aside,footer,form,button,[role="navigation"],[role="complementary"],[hidden],[aria-hidden="true"],[data-ai-hidden="true"],.related,.recommendations,.recommended,.comments,#comments,[data-ad],[data-ad-slot],[data-primis-wrapper],[class~="advertisement" i],[class~="advert" i],[role="toolbar"],[role="menu"],[role="menubar"],[role="listbox"],[role="tablist"],.vjs-control-bar,.vjs-menu,.vjs-modal-dialog,.vjs-text-track-display,.ima-ad-container,.socialBarWrapper,.socialBar,li[class~="article-bg-article-social"]'
const visible = element => !element.closest(excluded)
const absolute = (value, base) => { try { return new URL(value, base).href.split('#')[0] } catch { return null } }
const imageKey = (value, base) => { const href = typeof value === 'string' && value ? absolute(value, base) : null; return href ? dimsOriginal(href) ?? href : null }

function declaredArticle(document, url) {
  const nodes = [], visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 20) return
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return }
    if ([value['@type']].flat().some(type => /^(Article|NewsArticle|ReportageNewsArticle|BlogPosting)$/.test(type))) nodes.push(value)
    visit(value['@graph'], depth + 1); visit(value.mainEntity, depth + 1)
  }
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { visit(JSON.parse(script.textContent)) } catch (error) { void error }
  }
  const identities = new Set([absolute(url, url), absolute(document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? url, url)])
  const matches = nodes.filter(node => {
    const id = node.url ?? node.mainEntityOfPage?.['@id'] ?? node.mainEntityOfPage
    return typeof id === 'string' ? identities.has(absolute(id, url)) : nodes.length === 1
  })
  return matches.length === 1 ? matches[0] : null
}

function audit(result, config, url, snapshot, embeddedRule) {
  if (!result) return { basis: 'no-rendered-document', issues: [] }
  const dom = new JSDOM(result.html, { url: result.url, virtualConsole: new VirtualConsole() })
  try {
    const document = dom.window.document, declared = embeddedRule ? null : declaredArticle(document, result.url)
    const adapter = config.adapters.find(row => row.hosts.includes(new URL(result.url).hostname))
    for (const element of document.querySelectorAll('script,style')) element.remove()
    const candidates = [...document.querySelectorAll('article,main,[role="main"],[itemprop="articleBody"],.content-inner,.entry-content,.c-news__body,.story-body')].filter(visible)
    const scopes = candidates.map(node => ({ tag: node.tagName, id: node.id, className: node.className,
      paragraphs: [...node.querySelectorAll('p')].filter(visible).length, chars: normalize(node.textContent).length }))
    let selected = adapter ? document.querySelector(adapter.articleSelector) : candidates.find(node => node.matches('[itemprop="articleBody"],.content-inner,.entry-content,.c-news__body,.story-body'))
      ?? candidates.find(node => node.matches('article') && node.querySelectorAll('p').length > 1) ?? candidates.find(node => node.matches('main,[role="main"]'))
    if (embeddedRule) {
      const root = document.querySelector(embeddedRule.rootSelector)
      selected = document.createElement('section')
      const pages = embeddedRule.kind === 'story' ? [...root?.querySelectorAll(embeddedRule.pageSelector) ?? []] : []
      for (const page of pages) {
        if (embeddedRule.excludeSelector && page.matches(embeddedRule.excludeSelector)) continue
        const clone = page.cloneNode(true)
        clone.removeAttribute('aria-hidden')
        if (embeddedRule.excludeSelector) for (const node of clone.querySelectorAll(embeddedRule.excludeSelector)) node.remove()
        for (const node of clone.querySelectorAll('amp-img')) {
          const image = document.createElement('img')
          for (const attribute of node.attributes) image.setAttribute(attribute.name, attribute.value)
          node.replaceWith(image)
        }
        for (const node of clone.querySelectorAll('h1')) { const heading = document.createElement('h2'); heading.textContent = node.textContent; node.replaceWith(heading) }
        selected.append(clone)
      }
      if (embeddedRule.kind === 'video') {
        for (const query of ['meta[property="og:title"]', 'meta[property="og:description"],meta[name="description"]']) {
          const text = document.querySelector(query)?.getAttribute('content')
          if (text?.trim()) { const paragraph = document.createElement('p'); paragraph.textContent = text; selected.append(paragraph) }
        }
        const poster = document.querySelector('meta[property="og:image"]')?.getAttribute('content')
        if (poster?.trim()) { const image = document.createElement('img'); image.setAttribute('src', poster); selected.append(image) }
      }
    }
    const structured = typeof declared?.articleBody === 'string' && declared.articleBody.trim() ? JSDOM.fragment(declared.articleBody) : null
    const reference = structured?.querySelector('p,li,h2,h3') ? structured : selected
    if (adapter?.excludeSelector && selected) for (const node of document.querySelectorAll(adapter.excludeSelector)) if (node !== selected && selected.contains(node)) node.remove()
    for (const node of reference?.querySelectorAll('script,style') ?? []) node.remove()
    // 审计参考保留发布者正文；推荐模块必须同时具备组件类、明确标题和文章链接，不能按文中平台名称剔除。
    const ignoredControls = []
    for (const node of reference?.querySelectorAll('.read-more') ?? []) {
      const title = normalize(node.textContent).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
      if (/^(?:saiba mais|leia tambem|mais lidas|ultimas noticias)\b/u.test(title) && node.querySelector('li a[href],article a[href]')) {
        ignoredControls.push({ type: 'related-stories', paragraphs: node.querySelectorAll('p').length, listItems: node.querySelectorAll('li').length, images: node.querySelectorAll('img').length })
        node.remove()
      }
    }
    const paragraphNodes = [...reference?.querySelectorAll('p') ?? []].filter(visible)
    const headings = [...reference?.querySelectorAll('h2,h3,h4,h5,h6') ?? []].filter(visible).map(node => normalize(node.textContent)).filter(Boolean)
    const listItems = [...reference?.querySelectorAll('li') ?? []].filter(visible).map(node => normalize(node.textContent)).filter(Boolean)
    const paragraphs = paragraphNodes.map(node => normalize(node.textContent)).filter(Boolean)
    const captured = normalize(snapshot?.blocks.filter(block => block.type !== 'figure').map(textOfBlock).join(' ') ?? '')
    const capturedHeadings = new Set(snapshot?.blocks.filter(block => block.type === 'heading').map(textOfBlock).map(normalize) ?? [])
    const declaredImages = [declared?.image].flat().map(image => imageKey(typeof image === 'string' ? image : image?.contentUrl ?? image?.url, result.url)).filter(Boolean)
    const capturedImages = new Set(snapshot?.assets.filter(asset => asset.status === 'ready').map(asset => imageKey(asset.sourceUrl, result.url)) ?? [])
    const missingParagraphs = snapshot ? paragraphs.filter(text => !compact(captured).includes(compact(text))) : []
    const missingListItems = snapshot ? listItems.filter(text => !compact(captured).includes(compact(text))) : []
    const missingHeadings = snapshot ? headings.filter(text => !capturedHeadings.has(text)) : []
    const missingDeclaredImages = snapshot ? declaredImages.filter(href => !capturedImages.has(href)) : []
    // 声明地址有不同裁剪尺寸；保留未匹配地址供核对，不将 URL 数量冒充缺图数量。
    const domImages = [...selected?.querySelectorAll('img') ?? []].filter(visible).filter(image => !(Number(image.getAttribute('width')) > 0 && Number(image.getAttribute('height')) > 0 && Number(image.getAttribute('width')) <= 2 && Number(image.getAttribute('height')) <= 2))
    const unmatchedDomImages = snapshot ? domImages.filter(image => !snapshot.assets.some(asset => {
      if (asset.status !== 'ready') return false
      const src = image.getAttribute('src') ?? ''
      if (/^data:image\/(?:png|jpeg|gif|webp);base64,/u.test(src)) return asset.contentHash === createHash('sha256').update(Buffer.from(src.slice(src.indexOf(',') + 1), 'base64')).digest('hex')
      const values = ['src','data-src','data-original','data-ai-current-src'].map(name => imageKey(image.getAttribute(name), result.url))
      values.push(imageKey(image.closest('a[href]')?.getAttribute('href'), result.url))
      return values.includes(imageKey(asset.sourceUrl, result.url)) || ['srcset','data-srcset'].some(name => image.getAttribute(name)?.includes(asset.sourceUrl))
    })).map(image => ({ src: image.getAttribute('src')?.startsWith('data:') ? '[inline raster]' : image.getAttribute('src'), alt: image.getAttribute('alt') ?? '' })) : []
    const issues = [
      ...(missingParagraphs.length ? ['paragraph-coverage'] : []), ...(missingListItems.length ? ['list-coverage'] : []),
      ...(missingHeadings.length ? ['heading-coverage'] : []), ...(missingDeclaredImages.length ? ['unmatched-declared-image-urls'] : []),
      ...(unmatchedDomImages.length ? ['dom-image-review'] : []),
      ...(snapshot?.assets.some(asset => asset.status !== 'ready') ? ['failed-originals'] : []),
    ]
    return { basis: reference === structured && structured ? 'publisher-jsonld-body' : selected ? 'rendered-dom-region' : 'unresolved',
      declaredFree: declared?.isAccessibleForFree ?? null, scopes, expected: { paragraphs: paragraphs.length, headings: headings.length, listItems: listItems.length, declaredImages: declaredImages.length },
      captured: snapshot ? { paragraphs: snapshot.blocks.filter(block => block.type === 'paragraph').length, headings: capturedHeadings.size,
        listItems: snapshot.blocks.filter(block => block.type === 'list').reduce((sum, block) => sum + countListItems(block.items), 0), readyImages: snapshot.assets.filter(asset => asset.status === 'ready').length,
        chars: captured.length, first: captured.slice(0, 160), last: captured.slice(-160) } : null,
      missingParagraphs, missingListItems, missingHeadings, missingDeclaredImages, unmatchedDomImages, ignoredControls, issues }
  } finally { dom.window.close() }
}

function childAudits(sources, snapshot, articleUrl) {
  const adapter = config.adapters.find(row => row.hosts.includes(new URL(articleUrl).hostname))
  return sources.map(source => ({ origin: new URL(source.url).origin, kind: source.kind, pages: source.pages, excluded: source.excluded,
    audit: audit(source, config, source.url, snapshot, adapter.embeddedSources[source.ruleIndex]) }))
}

function countListItems(items) { return items.reduce((sum, item) => sum + 1 + item.children.reduce((nested, list) => nested + countListItems(list.items), 0), 0) }

if (values.review) {
  const source = resolve(values.review), original = JSON.parse(await readFile(join(source, 'results.json'), 'utf8'))
  for (const row of original.results) {
    const directory = join(source, String(row.index).padStart(2, '0'))
    const snapshot = row.ok ? JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8')) : null
    let html
    try { html = await readFile(join(directory, 'rendered.html'), 'utf8') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    row.audit = audit(html ? { html, url: snapshot?.url ?? row.url } : null, config, row.url, snapshot)
    try {
      const sources = JSON.parse(await readFile(join(directory, 'embedded-sources.json'), 'utf8'))
      for (const source of sources) source.html = await readFile(join(directory, source.file), 'utf8')
      row.embedded = childAudits(sources, snapshot, snapshot?.url ?? row.url)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  await writeFile(join(output, 'results.json'), JSON.stringify({ ...original, reviewedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ reviewed: original.results.length, networkRequests: 0 }))
  process.exit(0)
}

const results = [], started = Date.now()
let next = 0, writes = Promise.resolve()
const save = () => {
  writes = writes.then(async () => {
    const json = JSON.stringify({ startedAt: new Date(started).toISOString(), elapsedMs: Date.now() - started, total: rows.length,
      completed: results.length, results: [...results].sort((a, b) => a.index - b.index) }, null, 2) + '\n'
    await writeFile(join(output, 'results.tmp.json'), json, { mode: 0o600 })
    await rename(join(output, 'results.tmp.json'), join(output, 'results.json'))
  })
  return writes
}
await save()
async function runRow(row) {
  const directory = join(output, String(row.index).padStart(2, '0'))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const request = createPublicRequest(config), jar = new CookieJar(), renderer = new CaptureRenderer(config, { request, jar })
  const render = renderer.render.bind(renderer)
  let rendered
  renderer.render = async (...args) => {
    const value = await render(...args); rendered = value
    await writeFile(join(directory, 'rendered.html'), value.html, { mode: 0o600 })
    return value
  }
  const capture = createCapture(config, { request, jar, renderer }), events = [], sources = [], begin = Date.now()
  const result = { index: row.index, id: row.id, url: row.url, ok: false, code: null }
  try {
    const value = await capture.capture(row.url, { language: row.language ?? '',
      signal: AbortSignal.timeout(timeoutMs),
      onSourceDocument: async source => {
        const file = `embedded-${sources.length + 1}.html`
        await writeFile(join(directory, file), source.html, { mode: 0o600 })
        sources.push({ ...source, file })
        await writeFile(join(directory, 'embedded-sources.json'), JSON.stringify(sources.map(({ html, ...value }) => value), null, 2) + '\n', { mode: 0o600 })
      },
      onProgress: progress => {
        if (events.length < 200) events.push(progress)
        if (progress.event?.startsWith('embedded-source-')) console.log(JSON.stringify({ index: row.index, event: progress.event, details: progress.details }))
      } })
    result.ok = true; result.title = value.snapshot.title; result.finalUrl = value.snapshot.url; result.quality = value.snapshot.quality
    result.blocks = value.snapshot.blocks.length
    result.assets = value.snapshot.assets.map(asset => ({ id: asset.id, status: asset.status, sourceUrl: asset.sourceUrl,
      width: asset.width, height: asset.height, byteLength: asset.byteLength, error: asset.error }))
    result.audit = audit(rendered, config, row.url, value.snapshot)
    result.embedded = childAudits(sources, value.snapshot, value.snapshot.url)
    await writeFile(join(directory, 'snapshot.json'), JSON.stringify(value.snapshot, null, 2) + '\n', { mode: 0o600 })
    for (const asset of value.assets) if (asset.bytes) await writeFile(join(directory, asset.id + '.asset'), asset.bytes, { mode: 0o600 })
  } catch (error) {
    result.code = error.code ?? 'audit-execution'
    result.audit = audit(rendered, config, row.url)
    if (!error.code) result.diagnostic = error.message
  } finally {
    await capture.dispose()
    result.elapsedMs = Date.now() - begin
    await writeFile(join(directory, 'events.json'), JSON.stringify(events, null, 2) + '\n', { mode: 0o600 })
    results.push(result); await save()
    console.log(JSON.stringify({ index: row.index, completed: results.length, total: rows.length, ok: result.ok, code: result.code,
      issues: result.audit?.issues, blocks: result.blocks, images: result.assets?.length, elapsedMs: result.elapsedMs }))
  }
}
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (next < rows.length) { const row = rows[next++]; await runRow(row) }
}))
await writes
console.log(JSON.stringify({ completed: results.length, ok: results.filter(row => row.ok).length, failed: results.filter(row => !row.ok).length, elapsedMs: Date.now() - started }))
