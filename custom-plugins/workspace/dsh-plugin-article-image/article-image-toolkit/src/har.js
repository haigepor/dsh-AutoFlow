/** HAR 1.2 exchange records with secret redaction. */
import { failure } from './contracts.js'

const SENSITIVE = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i
// 键名先去掉分隔符再比后缀，userPassword / access-token / APIKey 这些写法才都会被收进脱敏范围。
const SECRET_SUFFIX = /(?:token|password|passwd|secret|apikey|accesskey|session|sessionid|credential|credentials|signature|authorization)$/

/** True when a field name denotes a credential. @param {string} key Object key or form field name. @returns {boolean} Sensitivity. */
function isSecretKey(key) { return SECRET_SUFFIX.test(String(key).toLowerCase().replace(/[_-]/g, '')) }

/** True when a header carries a credential rather than routine request metadata. @param {string} name Header name. @returns {boolean} Sensitivity. */
export function isSensitiveHeader(name) { return SENSITIVE.test(name) }

/** Replace a credential with an equivalent descriptor that keeps its scheme and length. @param {string} value Header value. @returns {string} Redacted value. */
export function redactHeader(value) {
  const text = String(value)
  const scheme = /^([a-z]+)\s/i.exec(text)?.[1]
  // 保留认证方案名（bearer/basic）与长度，排障时能看出站点用的是哪种鉴权。
  return scheme ? `${scheme} <redacted:${text.length}>` : `<redacted:${text.length}>`
}

/** Replace credential-shaped object values while keeping the document structure. @param {unknown} value Parsed JSON. @returns {unknown} Redacted copy. */
export function redactJson(value) {
  if (Array.isArray(value)) return value.map(redactJson)
  if (!value || typeof value !== 'object') return value
  const result = {}
  for (const [key, field] of Object.entries(value)) result[key] = isSecretKey(key) && typeof field === 'string' && field.length > 0 ? `<redacted:${field.length}>` : redactJson(field)
  return result
}

/** Summarize a cookie header without exposing its values. @param {string} value Cookie header. @returns {object} Name list and count. */
export function summarizeCookie(value) {
  const names = String(value).split(';').map(part => part.split('=')[0]?.trim()).filter(Boolean)
  return { count: names.length, names: names.slice(0, 30) }
}

/** Describe an authorization header without exposing its token. @param {string} value Authorization header. @returns {object} Scheme and presence. */
export function summarizeAuthorization(value) {
  const text = String(value)
  const scheme = /^([a-z]+)\s/i.exec(text)?.[1]?.toLowerCase() ?? 'unknown'
  return { scheme, present: text.trim().length > 0, length: text.length }
}

/** Build one HAR entry from a recorded exchange. @param {object} exchange Recorded exchange. @returns {object} HAR entry. */
export function harEntry(exchange) {
  const request = exchange.request, response = exchange.response
  return {
    startedDateTime: new Date(exchange.startedAt).toISOString(),
    time: exchange.timingMs ?? 0,
    request: {
      method: request.method,
      url: request.url,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: Object.entries(request.headers).map(([name, value]) => ({ name, value: String(value) })),
      queryString: [...new URL(request.url).searchParams].map(([name, value]) => ({ name, value })),
      headersSize: -1,
      bodySize: request.body ? Buffer.byteLength(request.body) : 0,
      ...(request.body ? { postData: { mimeType: request.headers['content-type'] ?? 'application/octet-stream', text: request.body } } : {}),
    },
    response: {
      status: response.status,
      statusText: '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: Object.entries(response.headers ?? {}).map(([name, value]) => ({ name, value: String(value) })),
      content: {
        size: response.bodyBytes ?? 0,
        mimeType: response.mime ?? 'application/octet-stream',
        ...(response.body !== undefined ? { text: response.body } : {}),
      },
      redirectURL: response.location ?? '',
      headersSize: -1,
      bodySize: response.bodyBytes ?? 0,
    },
    cache: {},
    timings: { send: 0, wait: exchange.timingMs ?? 0, receive: 0 },
    ...(exchange.resourceType ? { _resourceType: exchange.resourceType } : {}),
    // 非标准扩展：被录制但未代发的请求在 HAR 阅读器里显示为状态 0，这里保留原因。
    ...(exchange.sent === false ? { _sent: false, _blocked: exchange.blocked ?? null } : {}),
  }
}

/** Build a complete HAR 1.2 document. @param {object[]} exchanges Recorded exchanges. @param {object} [options] Creator metadata. @returns {object} HAR document. */
export function buildHar(exchanges, options = {}) {
  return {
    log: {
      version: '1.2',
      creator: { name: 'article-image-toolkit', version: options.version ?? '0.1.0' },
      pages: options.pages ?? [],
      entries: exchanges.map(harEntry),
    },
  }
}

/** Convert one HAR entry back into the recorded exchange form. @param {object} entry HAR entry. @param {number} index Entry position. @returns {object} Recorded exchange. */
export function exchangeFromEntry(entry, index) {
  const request = entry.request ?? {}, response = entry.response ?? {}
  const headers = Object.fromEntries((request.headers ?? []).filter(header => header?.name).map(header => [String(header.name), String(header.value ?? '')]))
  const responseHeaders = Object.fromEntries((response.headers ?? []).filter(header => header?.name).map(header => [String(header.name), String(header.value ?? '')]))
  let url
  try { url = new URL(String(request.url)) } catch { throw failure('har-invalid') }
  return {
    index,
    startedAt: Date.parse(entry.startedDateTime ?? '') || Date.now(),
    timingMs: Number.isFinite(entry.time) ? entry.time : 0,
    resourceType: entry._resourceType ?? 'other',
    ...(entry._sent === false ? { sent: false, blocked: entry._blocked ?? null } : {}),
    request: { method: String(request.method ?? 'GET').toUpperCase(), url: url.href, headers, body: request.postData?.text },
    response: { status: Number(response.status ?? 0), headers: responseHeaders, mime: String(response.content?.mimeType ?? ''), bodyBytes: Number(response.content?.size ?? 0), body: response.content?.text, location: response.redirectURL || undefined },
  }
}

/** Validate and convert a HAR document into recorded exchanges. @param {unknown} document Parsed HAR. @param {object} limits Size limits. @returns {object[]} Recorded exchanges. */
export function parseHar(document, limits = {}) {
  const entries = document?.log?.entries
  if (!Array.isArray(entries)) throw failure('har-invalid')
  if (entries.length > (limits.maxEntries ?? 5000)) throw failure('har-size')
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw failure('har-invalid')
    return exchangeFromEntry(entry, index)
  })
}

/** Redact one exchange for tool output; credentials stay in the private raw copy. @param {object} exchange Recorded exchange. @param {object} [options] Reveal switch. @returns {object} Redacted exchange. */
export function redactExchange(exchange, options = {}) {
  const reveal = options.reveal === true
  const headers = {}
  for (const [name, value] of Object.entries(exchange.request.headers ?? {})) {
    headers[name] = reveal || !isSensitiveHeader(name) ? value : redactHeader(value)
  }
  const responseHeaders = {}
  for (const [name, value] of Object.entries(exchange.response.headers ?? {})) {
    responseHeaders[name] = reveal || !isSensitiveHeader(name) ? value : redactHeader(value)
  }
  return {
    ...exchange,
    request: { ...exchange.request, headers, body: reveal ? exchange.request.body : redactRequestBody(exchange.request) },
    response: { ...exchange.response, headers: responseHeaders, body: reveal ? exchange.response.body : redactBody(exchange.response) },
    revealsCredentials: reveal,
  }
}

/** Redact a request body, which carries form logins and JSON credentials. @param {object} request Recorded request. @returns {string|undefined} Redacted body. */
function redactRequestBody(request) {
  if (request.body === undefined) return undefined
  const type = String(request.headers?.['content-type'] ?? '').toLowerCase()
  if (type.includes('json')) {
    try { return JSON.stringify(redactJson(JSON.parse(request.body))) } catch (error) { void error; return '<body:unparseable json>' }
  }
  if (type.includes('x-www-form-urlencoded')) {
    // 表单登录的密码字段与 JSON 一样要按字段名判定，不能只看头。
    return request.body.split('&').map(pair => {
      const [name, ...rest] = pair.split('=')
      if (!rest.length || !isSecretKey(decodeURIComponent(name))) return pair
      return `${name}=<redacted:${rest.join('=').length}>`
    }).join('&')
  }
  return `<body:${Buffer.byteLength(request.body)} bytes>`
}

/** Redact a response body for display while keeping its structure. @param {object} response Recorded response. @returns {string|undefined} Redacted body. */
function redactBody(response) {
  if (response.body === undefined) return undefined
  const type = (response.mime ?? '').toLowerCase()
  if (!type.includes('json')) return `<body:${Buffer.byteLength(response.body)} bytes>`
  try { return JSON.stringify(redactJson(JSON.parse(response.body))) } catch (error) { void error; return '<body:unparseable json>' }
}
