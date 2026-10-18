/**
 * Pre-serialization DOM pruning for renderer output.
 *
 * Static retrieval reads the source HTML, but rendered pages serialize the live DOM, and
 * large single-page applications can exceed the article HTML limit and truncate before
 * extraction. This drops subtrees that @mozilla/readability (0.6.0, the version pinned in
 * package.json) takes out during its own parsing anyway, so the serialized document stays
 * bounded without changing what extraction reads. The rules stay aligned with that pinned
 * version: script, style and noscript removal, hidden elements, unlikely candidates with
 * their tag and ancestor exceptions, unlikely roles, aria-modal dialogs, and empty
 * containers. Oversized attribute values (inline data-URI images, serialized component
 * state) are dropped last, since they inflate serialization without contributing text.
 *
 * The function is self-contained because render.js passes it to page.evaluate.
 */

/** @param {Document} [target] Document to prune; defaults to the global one inside the browser. */
export function pruneDocument(target = document) {
  const UNLIKELY_CANDIDATES = /-ad-|hidden|^hid$| hid$| hid |^hid |banner|combx|comment|com-|contact|footer|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|widget/i
  const OK_MAYBE_CANDIDATE = /and|article|body|column|main|shadow/i
  const UNLIKELY_ROLES = ['menu', 'menubar', 'complementary', 'navigation', 'alert', 'alertdialog', 'dialog']
  const CONTAINER_TAGS = new Set(['DIV', 'SECTION', 'HEADER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'])
  const GATE_MARKERS = '#challenge-form,#cf-challenge-running,#challenge-running,.cf-turnstile,.g-recaptcha,#px-captcha,[name="cf-turnstile-response"]'
  const INERT_TAGS = 'style,link,noscript,template,svg,canvas'

  // 与 Readability 的祖先检查一致：向上最多四层（maxDepth 3）。
  const hasAncestorTag = (node, tag) => {
    let depth = 0
    let current = node
    while (current.parentNode) {
      if (depth > 3) return false
      if (current.parentNode.tagName === tag) return true
      current = current.parentNode
      depth += 1
    }
    return false
  }

  // 只按 display:none 与 hidden/aria-hidden 判定不可见。visibility:hidden 不参与判定：
  // 页面会在加载后主动隐藏正文容器（付费墙、延迟渲染、A/B 测试），据此删节点会丢掉整篇正文。
  const isProbablyVisible = node => {
    const style = node.style
    return (!style || style.display !== 'none') &&
      !node.hasAttribute('hidden') &&
      (!node.hasAttribute('aria-hidden') || node.getAttribute('aria-hidden') !== 'true' ||
        (node.className && node.className.includes && node.className.includes('fallback-image')))
  }

  // 与 Readability 的空容器判断一致：无文本且子元素只剩 br/hr 视为空容器。
  const isEmptyContainer = node => {
    if (node.textContent.trim()) return false
    if (!node.children.length) return true
    return node.children.length === node.getElementsByTagName('br').length + node.getElementsByTagName('hr').length
  }

  const shouldRemove = node => {
    if (!isProbablyVisible(node)) return true
    if (node.getAttribute('aria-modal') === 'true' && node.getAttribute('role') === 'dialog') return true
    const matchString = node.className + ' ' + node.id
    if (UNLIKELY_CANDIDATES.test(matchString) && !OK_MAYBE_CANDIDATE.test(matchString) &&
      !hasAncestorTag(node, 'TABLE') && !hasAncestorTag(node, 'CODE') &&
      node.tagName !== 'BODY' && node.tagName !== 'A') return true
    if (UNLIKELY_ROLES.includes(node.getAttribute('role'))) return true
    return CONTAINER_TAGS.has(node.tagName) && isEmptyContainer(node)
  }

  const nextAfter = (node, skipChildren) => {
    if (!skipChildren && node.firstElementChild) return node.firstElementChild
    let current = node
    while (current && current !== target.documentElement) {
      if (current.nextElementSibling) return current.nextElementSibling
      current = current.parentElement
    }
    return null
  }

  for (const script of target.querySelectorAll('script')) {
    // 人机验证页脚本与 JSON-LD 元数据保留（访问限制检测和标题回退都需要它们）。
    const src = script.getAttribute('src') ?? ''
    if (src.includes('/cdn-cgi/challenge-platform/') || script.getAttribute('type') === 'application/ld+json') continue
    script.remove()
  }
  for (const node of target.querySelectorAll(INERT_TAGS)) node.remove()

  let node = target.documentElement
  while (node) {
    // 验证/登录标记所在子树整体保留，序列化后限制检测仍然成立。
    if (!node.matches(GATE_MARKERS) && !node.querySelector(GATE_MARKERS) && shouldRemove(node)) {
      const next = nextAfter(node, true)
      node.remove()
      node = next
      continue
    }
    node = nextAfter(node, false)
  }

  // 内嵌 data-URI 图片等超大属性值是序列化体积的主要来源（otempo.com.br 单张 base64 图 2.4MB）；提取只读短属性，超限的一律摘除。
  for (const element of target.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      if (attribute.value.length > 500) element.removeAttribute(attribute.name)
    }
  }
}
