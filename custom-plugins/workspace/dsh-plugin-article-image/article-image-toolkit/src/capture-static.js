/** Conservative completeness checks for explicitly verified server-rendered article templates. */
import { captureUrl } from './capture-media.js'
import { matchesCaptureAdapter } from './capture-adapters.js'

/** Dynamic sources retain browser execution even when a static template is configured. @param {object|undefined} adapter Site settings. @returns {boolean} Whether static capture may be attempted. */
export function staticEligible(adapter) {
  return Boolean(adapter?.static && !adapter.pagination && !adapter.embeddedSources && !adapter.captionSources && !adapter.expandSelector && !adapter.pendingSelector)
}

function meaningful(fragment) {
  for (const node of fragment.querySelectorAll('script,style,template,[hidden],[aria-hidden="true"]')) node.remove()
  return Boolean(fragment.textContent.trim() || fragment.querySelector('img,picture,video,audio,iframe,canvas,svg'))
}

/** Verify identity, unique article scope, published start/end and absence of unresolved dynamic content. Access restrictions must be checked before this function; exclusions cannot hide them. @param {Document} document Inert decoded HTML. @param {string} url Final controlled response URL. @param {object} site Verified site settings. @param {object} config Resolved extraction limits. @returns {boolean} Whether the document is complete enough for the normal rich extractor. */
export function verifyStaticDocument(document, url, site, config) {
  if (!staticEligible(site) || !matchesCaptureAdapter(site, url) || document.getElementsByTagName('*').length > config.maxArticleElements) return false
  const canonical = document.querySelectorAll('link[rel~="canonical"]'), roots = document.querySelectorAll(site.articleSelector)
  if (canonical.length !== 1 || roots.length !== 1) return false
  try {
    if (!canonical[0].getAttribute('href') || captureUrl(new URL(canonical[0].getAttribute('href'), url).href).href.split('#')[0] !== captureUrl(url).href.split('#')[0]) return false
  } catch (error) { void error; return false }
  const root = roots[0]
  if (root.closest('[hidden],[aria-hidden="true"],[aria-busy="true"],[data-loading="true"]')) return false
  for (let ancestor = root; ancestor; ancestor = ancestor.parentElement) {
    if (/(?:display\s*:\s*none|visibility\s*:\s*hidden|content-visibility\s*:\s*hidden)/iu.test(ancestor.getAttribute('style') ?? '')) return false
    if (ancestor.hasAttribute('data-loading') && ancestor.getAttribute('data-loading') !== 'false') return false
  }
  // 首尾标记可能是空的隐藏 span；先保留它们检查范围，再由普通抽取清理。
  if (site.excludeSelector) for (const node of document.querySelectorAll(site.excludeSelector)) if (node !== root && root.contains(node)) node.remove()
  const starts = root.querySelectorAll(site.static.startSelector), ends = root.querySelectorAll(site.static.endSelector)
  if (starts.length !== 1 || ends.length !== 1 || starts[0] === ends[0] || starts[0].contains(ends[0]) || ends[0].contains(starts[0]) || !(starts[0].compareDocumentPosition(ends[0]) & 4)) return false
  if (site.static.requiredSelectors.some(selector => !root.querySelector(selector))) return false
  const prefix = document.createRange(), suffix = document.createRange()
  prefix.selectNodeContents(root); prefix.setEndBefore(starts[0])
  suffix.selectNodeContents(root); suffix.setStartAfter(ends[0])
  if (meaningful(prefix.cloneContents()) || meaningful(suffix.cloneContents())) return false
  if (root.querySelector('script:not([type="application/ld+json"]),template,iframe,video,audio,canvas,svg,[aria-busy="true"],[data-loading="true"],.skeleton,link[rel="next"],a[rel~="next"]')) return false
  // 未实现的自定义图片/媒体元素与非空隐藏正文不能按“没有图片”或“只有摘要”发布。
  if ([...root.querySelectorAll('*')].some(node => node.localName.includes('-') || node.matches('object,embed') || (node.matches('picture') && !node.querySelector('img')) || (node.hasAttribute('data-loading') && node.getAttribute('data-loading') !== 'false'))) return false
  if ([...root.querySelectorAll('[hidden],[aria-hidden="true"]')].some(node => node.textContent.trim() || node.querySelector('img,picture,video,audio,iframe,canvas,svg'))) return false
  if (document.querySelector('link[rel~="next"]')) return false
  // CSS 隐藏的正文无法由静态布局证明可见；显式的隐藏占位与尚未展开内容交还浏览器。
  if ([...root.querySelectorAll('[style]')].some(node => /(?:display\s*:\s*none|visibility\s*:\s*hidden)/iu.test(node.getAttribute('style')))) return false
  return true
}
