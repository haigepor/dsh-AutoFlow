/** Per-origin cookie jar shared by static retrieval and the browser renderer. */

const ATTRIBUTE = /;\s*([a-z][a-z-]*)(?:\s*=\s*([^;]*))?/gi
const SAFE_NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/i
// 前缀约定（RFC 6265bis）：__Host- 要求 Secure、Path=/ 且无 Domain；__Secure- 只要求 Secure。
const HOST_PREFIX = /^__Host-/i
const SECURE_PREFIX = /^__Secure-/i

/** Parse one Set-Cookie value into its name, value and attributes. @param {string} line Header value. @param {number} now Reference time for Max-Age. @returns {object|null} Parsed cookie. */
function parseSetCookie(line, now) {
  const [pair, ...attributes] = String(line).split(';')
  const index = pair.indexOf('=')
  if (index <= 0) return null
  const name = pair.slice(0, index).trim(), value = pair.slice(index + 1).trim()
  if (!SAFE_NAME.test(name)) return null
  const cookie = { name, value, path: null, domain: null, expires: null, secure: false, httpOnly: false, sameSite: null }
  for (const part of attributes) {
    const match = /^\s*([a-z][a-z-]*)\s*(?:=\s*(.*))?$/i.exec(part)
    if (!match) continue
    const key = match[1].toLowerCase(), raw = match[2]?.trim()
    if (key === 'path' && raw?.startsWith('/')) cookie.path = raw
    else if (key === 'domain' && raw) cookie.domain = raw.replace(/^\./, '').toLowerCase()
    else if (key === 'expires' && raw) cookie.expires = Date.parse(raw)
    else if (key === 'max-age' && raw && /^-?\d+$/.test(raw)) cookie.expires = now + Number(raw) * 1000
    else if (key === 'secure') cookie.secure = true
    else if (key === 'httponly') cookie.httpOnly = true
    else if (key === 'samesite' && raw) cookie.sameSite = raw.toLowerCase()
  }
  // 前缀约束不满足时浏览器会丢弃整条 cookie；按同一规则处理，避免把非法凭据发给站点。
  if (HOST_PREFIX.test(name) && (!cookie.secure || cookie.domain || cookie.path !== '/')) return null
  if (SECURE_PREFIX.test(name) && !cookie.secure) return null
  return cookie
}

/** Split a Set-Cookie header list into individual values, respecting Expires commas. @param {string|string[]} value Header or list. @returns {string[]} Cookie lines. */
export function splitSetCookie(value) {
  const values = Array.isArray(value) ? value : [value]
  return values.flatMap(entry => {
    // Expires 里含逗号（Wdy, DD Mon YYYY）；只在后面不是数字日期时切分。
    const parts = String(entry).split(/,(?=\s*[^;,]+=)/)
    return parts.map(part => part.trim()).filter(Boolean)
  })
}

/** Default request path for a cookie without a Path attribute. @param {string} pathname Request path. @returns {string} Directory prefix. */
function defaultPath(pathname) {
  if (!pathname.startsWith('/')) return '/'
  const index = pathname.lastIndexOf('/')
  return index <= 0 ? '/' : pathname.slice(0, index)
}

/** True when a request path falls under a cookie path. @param {string} pathname Request path. @param {string} cookiePath Cookie path. @returns {boolean} Path match. */
function pathMatches(pathname, cookiePath) {
  if (pathname === cookiePath) return true
  if (!pathname.startsWith(cookiePath)) return false
  return cookiePath.endsWith('/') || pathname[cookiePath.length] === '/'
}

/** True when a host falls under a cookie domain. @param {string} host Request host. @param {string} domain Cookie domain. @returns {boolean} Domain match. */
function domainMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`)
}

// 两级公共后缀（com.br、co.uk、com.au …）。响应可以把 Domain 设成公共后缀，
// 浏览器会拒绝这种 cookie；按同一规则丢弃，否则一个站点的会话会发给同后缀的所有站点。
const MULTI_LABEL_SUFFIX = /^(?:com|net|org|gov|edu|co|ac|or|ne|go|gob|mil|int)\.[a-z]{2}$/i

/** True when a Domain attribute names a public suffix rather than a registrable domain. @param {string} domain Cookie domain. @param {string} host Request host. @returns {boolean} Rejection. */
function publicSuffix(domain, host) {
  const labels = domain.split('.')
  // RFC 6265 只接受与主机相同的单标签 Domain；其余单标签即公共后缀。
  if (labels.length === 1) return domain !== host
  return labels.length === 2 && MULTI_LABEL_SUFFIX.test(domain)
}

/**
 * Cookies are scoped by origin and never sent cross-site.
 * Neither retrieval leg previously carried a session: a static read of a page that sets
 * an access cookie, then a render of the same page, each started without it.
 */
export class CookieJar {
  /** @param {object} [options] Clock and limit overrides. */
  constructor(options = {}) {
    this.cookies = new Map()
    this.maxCookies = options.maxCookies ?? 300
    this.now = options.now ?? Date.now
  }

  /** Store the cookies a response set. @param {string} url Response URL. @param {object} headers Response headers. @returns {number} Stored count. */
  store(url, headers) {
    const value = headers?.['set-cookie']
    if (!value) return 0
    const target = new URL(url)
    const host = target.hostname.toLowerCase()
    let stored = 0
    for (const line of splitSetCookie(value)) {
      const cookie = parseSetCookie(line, this.now())
      if (!cookie) continue
      if (cookie.domain && (!domainMatches(host, cookie.domain) || publicSuffix(cookie.domain, host))) continue
      if (cookie.secure && target.protocol !== 'https:') continue
      const domain = cookie.domain ?? host
      const path = cookie.path ?? defaultPath(target.pathname)
      const key = `${domain}\u0000${path}\u0000${cookie.name}`
      if (cookie.expires !== null && cookie.expires <= this.now()) { this.cookies.delete(key); continue }
      this.cookies.set(key, { ...cookie, domain, path, hostOnly: cookie.domain === null, createdAt: this.now() })
      stored++
    }
    this.prune()
    return stored
  }

  /** Adopt a cookie the browser already scoped. @param {object} cookie Browser cookie record. @returns {void} Completion. */
  adopt(cookie) {
    if (!cookie?.name || !cookie.domain) return
    if (cookie.expires !== null && cookie.expires !== undefined && cookie.expires <= this.now()) return
    const key = `${cookie.domain}\u0000${cookie.path ?? '/'}\u0000${cookie.name}`
    this.cookies.set(key, { name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path ?? '/',
      expires: cookie.expires ?? null, secure: Boolean(cookie.secure), httpOnly: Boolean(cookie.httpOnly), hostOnly: Boolean(cookie.hostOnly), createdAt: this.now() })
    this.prune()
  }

  /**
   * Cookies that apply to one request, most specific path first.
   * @param {string} url Request URL.
   * @returns {object[]} Matching cookie records.
   */
  matching(url) {
    const target = new URL(url)
    const host = target.hostname.toLowerCase()
    const secure = target.protocol === 'https:'
    const now = this.now()
    const selected = []
    for (const [key, cookie] of this.cookies) {
      if (cookie.expires !== null && cookie.expires <= now) { this.cookies.delete(key); continue }
      if (cookie.secure && !secure) continue
      if (cookie.hostOnly ? host !== cookie.domain : !domainMatches(host, cookie.domain)) continue
      if (!pathMatches(target.pathname || '/', cookie.path)) continue
      selected.push(cookie)
    }
    // 较长路径优先，符合 RFC 6265 的排序要求；同名 cookie 靠前者被站点视为更具体。
    return selected.sort((left, right) => right.path.length - left.path.length || left.createdAt - right.createdAt)
  }

  /** Build a Cookie header for one request. @param {string} url Request URL. @returns {string|undefined} Header value. */
  header(url) {
    const selected = this.matching(url)
    if (!selected.length) return undefined
    return selected.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
  }

  /** Drop expired cookies and enforce the capacity limit, oldest first. @returns {number} Removed count. */
  prune() {
    const now = this.now()
    let removed = 0
    for (const [key, cookie] of this.cookies) {
      if (cookie.expires !== null && cookie.expires <= now) { this.cookies.delete(key); removed++ }
    }
    while (this.cookies.size > this.maxCookies) {
      this.cookies.delete(this.cookies.keys().next().value)
      removed++
    }
    return removed
  }

  /** List cookie names per domain without exposing values. @returns {object[]} Domain summaries. */
  summary() {
    this.prune()
    const byDomain = new Map()
    for (const cookie of this.cookies.values()) {
      const entry = byDomain.get(cookie.domain) ?? { domain: cookie.domain, count: 0, names: [] }
      entry.count++
      if (entry.names.length < 20) entry.names.push(cookie.name)
      byDomain.set(cookie.domain, entry)
    }
    return [...byDomain.values()]
  }

  /** Discard every cookie. @returns {void} Completion. */
  clear() { this.cookies.clear() }
}
