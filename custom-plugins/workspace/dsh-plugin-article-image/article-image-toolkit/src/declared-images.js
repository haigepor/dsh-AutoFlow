/** Preserve DOM-backed photos explicitly declared for the current article. */
import parseSrcset from '@prettier/parse-srcset'
function imageUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value, base)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch (error) { void error; return null }
}

/** Read the published source behind a DIMS transform; unrelated URL parameters stay opaque. @param {string} value Image URL. @returns {string|null} Explicit original source. */
export function dimsOriginal(value) {
  try {
    const url = new URL(value)
    if (!/^\/dims[0-9]+\//.test(url.pathname) || !url.searchParams.has('url')) return null
    return imageUrl(url.searchParams.get('url'), url)
  } catch (error) { void error; return null }
}

function key(value, base) {
  const url = imageUrl(value, base)
  if (!url) return null
  const identity = new URL(dimsOriginal(url) ?? url)
  // 仅比较公开图片的显示变换；来源 ID、签名及其他参数仍参与身份，绝不据此构造请求地址。
  for (const name of ['width', 'height', 'w', 'h', 'quality', 'crop', 'format', 'preferwebp', 'fit', 'background', 'dpr']) identity.searchParams.delete(name)
  identity.pathname = identity.pathname.replace(/^\/cdn-cgi\/image\/[^/]+\//u, '/')
  identity.pathname = identity.pathname.replace(/\/@@images\/[^/]+(?:\/.*)?$/u, '')
  // Arc 的签名随尺寸改变；只有相同公开资源 ID 的 resizer 地址采用此比较，普通鉴权参数不变。
  if (/^\/resizer\/v2\/[A-Za-z0-9_-]+\.(?:jpe?g|png|webp)$/iu.test(identity.pathname)) identity.searchParams.delete('auth')
  return identity.href
}

/** Match a published image to existing DOM candidates; this identity must never construct a download URL. @param {string} value Published image URL. @param {string} base Article URL. @returns {string|null} Resource identity excluding display transforms. */
export function imageIdentity(value, base) { return key(value, base) }

function declared(document, url, limit) {
  const identities = new Set([new URL(url).href.split('#')[0]])
  const canonical = imageUrl(document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? '', url)
  if (canonical && new URL(canonical).origin === new URL(url).origin) identities.add(canonical.split('#')[0])
  const articles = [], walk = (value, depth = 0) => {
    if (depth > 20 || !value || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return }
    if ([value['@type']].flat().some(type => /^(?:Article|NewsArticle|ReportageNewsArticle|BlogPosting)$/.test(type))) articles.push(value)
    walk(value['@graph'], depth + 1); walk(value.mainEntity, depth + 1)
  }
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { walk(JSON.parse(script.textContent)) } catch (error) { void error /* 无效结构化数据不扩大正文范围。 */ }
  }
  const current = articles.filter(article => {
    const identity = article.url ?? article.mainEntityOfPage?.['@id'] ?? article.mainEntityOfPage
    const candidate = typeof identity === 'string' ? imageUrl(identity, url) : null
    return candidate ? identities.has(candidate.split('#')[0]) : articles.length === 1
  })
  if (current.length !== 1) return new Map()
  const images = [current[0].image].flat().slice(0, limit)
  const result = new Map()
  for (const image of images) {
    const href = imageUrl(typeof image === 'string' ? image : image?.contentUrl ?? image?.url, url), identity = key(href, url)
    if (identity && !result.has(identity)) result.set(identity, dimsOriginal(href) ?? href)
  }
  return result
}

/** Restore declared, visible photos in their original order around retained prose. @param {Document} document Source DOM. @param {Element} root Readability projection. @param {string} url Article URL. @param {number} limit Image budget. @returns {Element} Projection with retained photo metadata. */
export function restoreDeclaredImages(document, root, url, limit) {
  const wanted = declared(document, url, limit)
  if (!wanted.size) return root
  // 缩略图的父链接可明确指向已声明原图；只接受该精确地址，不推导图片文件名。
  const identityOf = image => {
    const sources = [image.getAttribute('src'), image.getAttribute('data-ai-current-src'), image.getAttribute('data-original'), image.closest('a[href]')?.getAttribute('href')]
    for (const attr of ['srcset', 'data-srcset', 'data-lazy-srcset']) {
      try { sources.push(...parseSrcset(image.getAttribute(attr) ?? '').map(candidate => candidate.source.value)) }
      catch (error) { void error /* 畸形来源不参与原图匹配，也不输出可能带签名的属性值。 */ }
    }
    const identity = sources.map(value => key(value, url)).find(value => wanted.has(value))
    return identity ? wanted.get(identity) : undefined
  }
  const existing = new Set([...root.querySelectorAll('img')].map(image => {
    const identity = identityOf(image)
    if (identity) image.setAttribute('data-original', identity)
    return identity
  }).filter(Boolean))
  const text = value => value.replace(/\s+/gu, ' ').trim()
  const original = new Map()
  // 非语义正文也用投影中保留的完整段落定位；导航、隐藏和推荐区域不提供锚点。
  const excluded = '[hidden],[aria-hidden="true"],[data-ai-hidden="true"],aside,nav,footer,[role="navigation"],[role="complementary"],.related,.recommendations,.recommended,.comments'
  for (const paragraph of document.querySelectorAll('body p')) if (!paragraph.closest(excluded) && !original.has(text(paragraph.textContent))) original.set(text(paragraph.textContent), paragraph)
  const anchors = [...root.querySelectorAll('p')].map(copy => ({ copy, source: original.get(text(copy.textContent)) })).filter(anchor => anchor.source)
  if (!anchors.length) return root
  for (const image of document.querySelectorAll('body img')) {
    const identity = identityOf(image)
    if (!identity || existing.has(identity) || image.closest(excluded)) continue
    const figure = image.closest('figure') ?? image.closest('picture') ?? image
    const copy = figure.cloneNode(true)
    const sources = figure.matches('img') ? [figure] : [...figure.querySelectorAll('img')]
    const images = copy.matches('img') ? [copy] : [...copy.querySelectorAll('img')]
    for (const [index, other] of images.entries()) {
      const original = identityOf(sources[index])
      if (!original) other.remove()
      else other.setAttribute('data-original', original)
    }
    // 使用原 DOM 的段落锚点，避免把正文主图放到结尾或引入相关推荐图。
    const anchor = anchors.find(anchor => image.compareDocumentPosition(anchor.source) & 4)
    if (anchor) anchor.copy.before(copy)
    else root.append(copy)
    existing.add(identity)
  }
  return root
}
