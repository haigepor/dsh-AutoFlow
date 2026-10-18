/** HAR round-trip and credential redaction, which every capture read path depends on. */
import { describe, expect, it } from 'vitest'
import {
  buildHar, exchangeFromEntry, isSensitiveHeader, parseHar, redactExchange, redactHeader, redactJson, summarizeAuthorization, summarizeCookie,
} from '../src/har.js'

const exchange = (overrides = {}) => ({
  index: 0,
  startedAt: Date.parse('2026-10-17T12:00:00.000Z'),
  timingMs: 42,
  resourceType: 'xhr',
  request: { method: 'POST', url: 'https://api.example.com/v1/items?page=2', headers: { 'content-type': 'application/json', authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig', cookie: 'sid=secret-value; theme=dark' }, body: '{"name":"Roteiro","password":"hunter2"}' },
  response: { status: 201, headers: { 'content-type': 'application/json', 'set-cookie': 'sid=next-secret; Path=/' }, mime: 'application/json', bodyBytes: 34, body: '{"id":7,"access_token":"abc123"}' },
  ...overrides,
})

describe('header sensitivity', () => {
  it('covers every credential-bearing header case-insensitively', () => {
    for (const name of ['authorization', 'Authorization', 'PROXY-AUTHORIZATION', 'cookie', 'Set-Cookie', 'x-api-key', 'X-Auth-Token', 'x-csrf-token', 'x-xsrf-token']) {
      expect(isSensitiveHeader(name)).toBe(true)
    }
  })

  it('leaves ordinary request metadata alone', () => {
    for (const name of ['accept', 'content-type', 'user-agent', 'referer', 'org-id', 'cookie-notice']) {
      expect(isSensitiveHeader(name)).toBe(false)
    }
  })

  it('keeps the scheme and length so a failure stays diagnosable', () => {
    expect(redactHeader('Bearer abcdefgh')).toBe(`Bearer <redacted:${'Bearer abcdefgh'.length}>`)
    expect(redactHeader('Basic dXNlcjpwYXNz')).toBe(`Basic <redacted:${'Basic dXNlcjpwYXNz'.length}>`)
    expect(redactHeader('opaque-token')).toBe(`<redacted:${'opaque-token'.length}>`)
  })
})

describe('JSON redaction', () => {
  it('redacts credential keys under the common spellings', () => {
    const result = redactJson({ access_token: 'a', userPassword: 'b', 'api-key': 'c', APIKey: 'd', session_id: 'e', credentials: 'f', signature: 'g', nested: [{ refreshToken: 'h' }], name: 'keep' })
    expect(result).toEqual({
      access_token: '<redacted:1>', userPassword: '<redacted:1>', 'api-key': '<redacted:1>', APIKey: '<redacted:1>', session_id: '<redacted:1>',
      credentials: '<redacted:1>', signature: '<redacted:1>', nested: [{ refreshToken: '<redacted:1>' }], name: 'keep',
    })
  })

  it('keeps non-string and empty values readable', () => {
    expect(redactJson({ token: 42, secret: '', retries: 3 })).toEqual({ token: 42, secret: '', retries: 3 })
  })
})

describe('credential summaries', () => {
  it('names cookies without exposing their values', () => {
    expect(summarizeCookie('sid=secret; theme=dark; _ga=GA1.2')).toEqual({ count: 3, names: ['sid', 'theme', '_ga'] })
  })

  it('describes an authorization scheme without the token', () => {
    expect(summarizeAuthorization('Bearer eyJhbGciOi.payload')).toEqual({ scheme: 'bearer', present: true, length: 'Bearer eyJhbGciOi.payload'.length })
    expect(summarizeAuthorization('   ')).toEqual({ scheme: 'unknown', present: false, length: 3 })
  })
})

describe('HAR document', () => {
  it('round-trips a recorded exchange through build and parse', () => {
    const document = buildHar([exchange()], { version: '9.9.9' })
    expect(document.log.version).toBe('1.2')
    expect(document.log.creator).toEqual({ name: 'article-image-toolkit', version: '9.9.9' })
    const [parsed] = parseHar(document)
    expect(parsed.request.method).toBe('POST')
    expect(parsed.request.url).toBe('https://api.example.com/v1/items?page=2')
    expect(parsed.request.body).toBe('{"name":"Roteiro","password":"hunter2"}')
    expect(parsed.response).toMatchObject({ status: 201, mime: 'application/json', bodyBytes: 34, body: '{"id":7,"access_token":"abc123"}' })
    expect(parsed.resourceType).toBe('xhr')
    expect(parsed.timingMs).toBe(42)
    expect(parsed.startedAt).toBe(Date.parse('2026-10-17T12:00:00.000Z'))
  })

  it('records query parameters and post data separately from the URL', () => {
    const entry = buildHar([exchange()]).log.entries[0]
    expect(entry.request.queryString).toEqual([{ name: 'page', value: '2' }])
    expect(entry.request.postData).toEqual({ mimeType: 'application/json', text: '{"name":"Roteiro","password":"hunter2"}' })
    expect(entry.request.bodySize).toBe(Buffer.byteLength('{"name":"Roteiro","password":"hunter2"}'))
    expect(entry._resourceType).toBe('xhr')
  })

  it('rejects malformed documents and oversized entry counts', () => {
    expect(() => parseHar({})).toThrow('har-invalid')
    expect(() => parseHar({ log: { entries: [{ request: { url: 'not a url' } }] } })).toThrow('har-invalid')
    expect(() => parseHar({ log: { entries: [{}, {}] } }, { maxEntries: 1 })).toThrow('har-size')
  })

  it('tolerates entries that omit optional HAR fields', () => {
    const [parsed] = parseHar({ log: { entries: [{ request: { method: 'get', url: 'https://example.com/a' }, response: { status: 200 } }] } })
    expect(parsed.request.method).toBe('GET')
    expect(parsed.request.headers).toEqual({})
    expect(parsed.response.mime).toBe('')
    expect(parsed.response.bodyBytes).toBe(0)
    expect(parsed.resourceType).toBe('other')
  })
})

describe('exchange redaction', () => {
  it('redacts request and response headers, request body and response body by default', () => {
    const view = redactExchange(exchange(), {})
    expect(view.revealsCredentials).toBe(false)
    expect(view.request.headers.authorization).toBe(`Bearer <redacted:${'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig'.length}>`)
    expect(view.request.headers.cookie).toBe(`<redacted:${'sid=secret-value; theme=dark'.length}>`)
    expect(view.request.headers['content-type']).toBe('application/json')
    expect(view.request.body).toBe('{"name":"Roteiro","password":"<redacted:7>"}')
    expect(view.response.headers['set-cookie']).toBe(`<redacted:${'sid=next-secret; Path=/'.length}>`)
    expect(JSON.parse(view.response.body)).toEqual({ id: 7, access_token: '<redacted:6>' })
  })

  it('redacts form-encoded login bodies field by field', () => {
    const form = exchange({ request: { method: 'POST', url: 'https://example.com/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'user=ana&password=hunter2&remember=1' } })
    expect(redactExchange(form).request.body).toBe('user=ana&password=<redacted:7>&remember=1')
  })

  it('replaces non-JSON bodies with a byte count instead of echoing them', () => {
    const page = exchange({ request: { method: 'GET', url: 'https://example.com/a', headers: { accept: 'text/html' } }, response: { status: 200, headers: {}, mime: 'text/html', bodyBytes: 11, body: '<p>secret</p>' } })
    const view = redactExchange(page)
    expect(view.request.body).toBeUndefined()
    expect(view.response.body).toBe('<body:13 bytes>')
  })

  it('returns original values only when reveal is explicitly true', () => {
    const view = redactExchange(exchange(), { reveal: true })
    expect(view.revealsCredentials).toBe(true)
    expect(view.request.headers.authorization).toContain('Bearer eyJ')
    expect(view.request.body).toContain('hunter2')
    expect(view.response.body).toContain('abc123')
  })

  it('does not mutate the raw exchange that replay depends on', () => {
    const raw = exchange()
    redactExchange(raw, {})
    expect(raw.request.headers.authorization).toBe('Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig')
    expect(raw.request.body).toContain('hunter2')
  })

  it('keeps an unparseable JSON body from leaking its content', () => {
    const broken = exchange({ response: { status: 200, headers: {}, mime: 'application/json', bodyBytes: 9, body: '{"a":toke' } })
    expect(redactExchange(broken).response.body).toBe('<body:unparseable json>')
  })
})

describe('entry conversion', () => {
  it('upper-cases methods and keeps the raw redirect target', () => {
    const parsed = exchangeFromEntry({ startedDateTime: '2026-01-01T00:00:00.000Z', time: 5, request: { method: 'put', url: 'https://example.com/a', headers: [{ name: 'Accept', value: 'text/html' }] }, response: { status: 302, redirectURL: 'https://example.com/b', content: { size: 0, mimeType: 'text/html' } } }, 3)
    expect(parsed.request.method).toBe('PUT')
    expect(parsed.request.headers).toEqual({ Accept: 'text/html' })
    expect(parsed.response.location).toBe('https://example.com/b')
    expect(parsed.index).toBe(3)
  })
})
