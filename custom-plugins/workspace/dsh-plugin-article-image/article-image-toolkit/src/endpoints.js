/** API endpoint inventory derived from recorded exchanges. */
import { summarizeAuthorization, summarizeCookie } from './har.js'

const ID_PATTERN = /^\d{1,}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// 静态资源的指纹在扩展名之前（main.deadbeefdeadbeef00.js），只折叠指纹本身，保留名称与扩展名。
const HASH_SEGMENT = /^(.*?)([0-9a-f]{16,})(\.[a-z0-9]{1,6})?$/i
const YEAR_PATTERN = /^(?:19|20)\d{2}$/
const MONTH_PATTERN = /^(?:0?[1-9]|1[0-2])$/

/** Replace one path segment with a placeholder when it looks like an identifier. @param {string} segment Decoded segment. @param {string|undefined} previous Previous template segment. @returns {string} Placeholder or the original segment. */
function segmentTemplate(segment, previous) {
  if (!segment) return segment
  if (UUID_PATTERN.test(segment)) return ':uuid'
  if (ID_PATTERN.test(segment)) {
    if (YEAR_PATTERN.test(segment)) return ':year'
    // 紧跟年份的 1-2 位数字是月份：与 :id 分开后，同一站点不同月份仍归到同一端点但语义可读。
    if (previous === ':year' && MONTH_PATTERN.test(segment)) return ':month'
    return ':id'
  }
  const hashed = HASH_SEGMENT.exec(segment)
  if (hashed) return `${hashed[1]}:hash${hashed[3] ?? ''}`
  // 滑杆式 slug（loja-de-camisas-azuis）不折叠：折叠后不同文章会合并成同一端点。
  return segment
}

/**
 * Reduce a URL to a reusable endpoint template.
 * Segments that are numeric, UUID-shaped or long hexadecimal become placeholders; slug segments stay.
 * @param {string} value Absolute URL.
 * @returns {{path: string, query: string[]}} Template path and sorted query parameter names.
 */
export function endpointTemplate(value) {
  let url
  try { url = new URL(value) } catch { return { path: '/', query: [] } }
  const segments = []
  for (const segment of url.pathname.split('/')) {
    let decoded = segment
    try { decoded = decodeURIComponent(segment) } catch { /* 保留原样：非法百分号编码在模板里没有意义 */ }
    segments.push(segmentTemplate(decoded, segments.at(-1)))
  }
  return { path: segments.join('/') || '/', query: [...new Set(url.searchParams.keys())].sort() }
}

/** Read one named header case-insensitively. @param {object} headers Request headers. @param {string} name Header name. @returns {string|undefined} Header value. */
function header(headers, name) {
  return Object.entries(headers ?? {}).find(([entry]) => entry.toLowerCase() === name)?.[1]
}

// 广告、分析和标签管理主机。它们在同一页面上产生大部分请求，混进清单会掩盖站点自身的 API。
const TRACKER_HOSTS = [
  /(?:^|\.)doubleclick\.net$/, /(?:^|\.)googlesyndication\.com$/, /(?:^|\.)google-analytics\.com$/, /(?:^|\.)googletagmanager\.com$/,
  /(?:^|\.)google\.com$/, /(?:^|\.)clarity\.ms$/, /(?:^|\.)chartbeat\.(?:com|net)$/, /(?:^|\.)taboola\.com$/,
  /(?:^|\.)teads\.tv$/, /(?:^|\.)adnxs\.com$/, /(?:^|\.)rubiconproject\.com$/, /(?:^|\.)pubmatic\.com$/,
  /(?:^|\.)criteo\.(?:com|net)$/, /(?:^|\.)facebook\.(?:com|net)$/, /(?:^|\.)scorecardresearch\.com$/,
  /(?:^|\.)hotjar\.com$/, /(?:^|\.)segment\.(?:io|com)$/, /(?:^|\.)amplitude\.com$/, /(?:^|\.)newrelic\.com$/,
  /(?:^|\.)nr-data\.net$/, /(?:^|\.)sentry\.io$/, /(?:^|\.)bugsnag\.com$/, /(?:^|\.)optimizely\.com$/,
]

/**
 * Classify a URL host as tracking/advertising rather than site-owned API.
 * @param {string} host Hostname, optionally with port.
 * @returns {string} 'tracker' or 'site'.
 */
export function ownerOf(host) {
  const name = String(host).replace(/:\d+$/, '').toLowerCase()
  return TRACKER_HOSTS.some(pattern => pattern.test(name)) ? 'tracker' : 'site'
}

/** Describe the authorization a request used without exposing the token. @param {object} headers Request headers. @returns {object|null} Scheme and presence. */
function authorization(headers) {
  const value = header(headers, 'authorization')
  return value ? summarizeAuthorization(value) : null
}

/** Count cookies named by a request without exposing their values. @param {object} headers Request headers. @returns {object|null} Cookie summary. */
function cookieSummary(headers) {
  const value = header(headers, 'cookie')
  return value ? summarizeCookie(value) : null
}

/**
 * Group recorded exchanges into endpoints.
 * @param {object[]} exchanges Recorded exchanges.
 * @returns {object[]} Endpoints ordered by first appearance.
 */
export function inventory(exchanges) {  const groups = new Map()
  exchanges.forEach((exchange, position) => {
    const { path, query } = endpointTemplate(exchange.request.url)
    let host
    try { host = new URL(exchange.request.url).host } catch { host = '' }
    // 同一模板路径在不同主机上是不同端点：合并会把 CDN 与 API 的调用统计混在一起。
    const key = `${exchange.request.method} ${host}${path}`
    const statuses = groups.get(key)?.statuses ?? new Set()
    statuses.add(exchange.response.status)
    const mimes = groups.get(key)?.mimes ?? new Set()
    if (exchange.response.mime) mimes.add(exchange.response.mime)
    const queryNames = groups.get(key)?.query ?? new Set()
    for (const name of query) queryNames.add(name)
    const existing = groups.get(key)
    if (existing) {
      existing.count += 1
      existing.statuses = statuses
      existing.mimes = mimes
      existing.query = queryNames
      return
    }
    groups.set(key, {
      key,
      method: exchange.request.method,
      path,
      host,
      owner: ownerOf(host),
      count: 1,
      statuses,
      mimes,
      query: queryNames,
      auth: authorization(exchange.request.headers),
      cookie: cookieSummary(exchange.request.headers),
      resourceType: exchange.resourceType ?? 'other',
      sampleIndex: position,
    })
  })
  return [...groups.values()].map(endpoint => ({
    ...endpoint,
    statuses: [...endpoint.statuses].sort((left, right) => left - right),
    mimes: [...endpoint.mimes].sort(),
    query: [...endpoint.query].sort(),
  })).sort((left, right) => left.sampleIndex - right.sampleIndex)
}
