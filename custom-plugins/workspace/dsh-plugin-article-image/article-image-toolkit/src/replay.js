/** Replay a recorded exchange with explicit overrides over the pinned public transport. */
import { failure } from './contracts.js'
import { captureUrl } from './capture-media.js'

const SAFE_OVERRIDE_HEADERS = /^(?:accept|accept-language|content-type|user-agent|referer|origin|x-requested-with)$/i

/** Apply query overrides to a URL. @param {string} url Base URL. @param {object} query Replacements. @returns {string} New URL. */
function withQuery(url, query) {
  if (!query) return url
  const target = new URL(url)
  for (const [name, value] of Object.entries(query)) {
    if (value === null || value === undefined) target.searchParams.delete(name)
    else if (Array.isArray(value)) { target.searchParams.delete(name); for (const item of value) target.searchParams.append(name, String(item)) }
    else target.searchParams.set(name, String(value))
  }
  return target.href
}

/** Restrict caller-provided headers to non-credential request metadata. @param {object} headers Override headers. @returns {object} Accepted headers. */
function safeHeaders(headers) {
  const result = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    // 凭据只能来自录制时的原始请求；重放不接受调用方注入的认证头。
    if (SAFE_OVERRIDE_HEADERS.test(name)) result[name] = String(value)
  }
  return result
}

/**
 * Replay one exchange.
 * The URL passes the public-network policy again, so a captured loopback target cannot be replayed.
 * @param {object} exchange Raw recorded exchange.
 * @param {object} overrides Method, URL, query, headers and body changes.
 * @param {object} dependencies Pinned request transport and limits.
 * @returns {Promise<object>} Replay result.
 */
export async function replayExchange(exchange, overrides, dependencies) {
  const { request, limits } = dependencies
  const method = String(overrides?.method ?? exchange.request.method).toUpperCase()
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) throw failure('replay-method')
  const target = withQuery(overrides?.url ? captureUrl(overrides.url).href : exchange.request.url, overrides?.query)
  captureUrl(target)
  const headers = { ...exchange.request.headers, ...safeHeaders(overrides?.headers) }
  const body = overrides?.body !== undefined ? overrides.body : method === 'GET' || method === 'HEAD' ? undefined : exchange.request.body
  const started = Date.now()
  const response = await request(target, { signal: dependencies.signal, method, maxBytes: limits.maxExchangeBytes, headers, body })
  return {
    startedAt: started,
    timingMs: Date.now() - started,
    resourceType: exchange.resourceType ?? 'other',
    request: { method, url: target, headers, body },
    response: {
      status: response.statusCode,
      headers: { ...(response.headers ?? {}) },
      mime: response.mime,
      bodyBytes: response.bytes.length,
      body: (response.mime ?? '').includes('json') || (response.mime ?? '').startsWith('text/') ? response.bytes.toString('utf8').slice(0, limits.maxExchangeBytes) : undefined,
      location: response.headers?.location,
    },
  }
}

/** Produce a bounded preview of a response body for tool output. @param {string|undefined} body Body text. @param {number} limit Byte budget. @returns {object} Preview fields. */
export function bodyPreview(body, limit) {
  if (body === undefined) return { preview: null, truncated: false, bytes: 0 }
  const bytes = Buffer.byteLength(body)
  return { preview: body.slice(0, limit), truncated: bytes > limit, bytes }
}
