/** Cookie scoping shared by static retrieval and the browser renderer. */
import { describe, expect, it } from 'vitest'
import { splitSetCookie, CookieJar } from '../src/session.js'

/** Build a jar with a controllable clock. @returns {object} Jar and clock controls. */
function makeJar(options = {}) {
  let time = 1_000_000
  const jar = new CookieJar({ now: () => time, ...options })
  return { jar, advance: ms => { time += ms }, at: () => time }
}

describe('splitSetCookie', () => {
  it('splits a folded header without breaking Expires dates', () => {
    const lines = splitSetCookie('a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT, b=2; Path=/x')
    expect(lines).toEqual(['a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT', 'b=2; Path=/x'])
  })

  it('flattens a header list', () => {
    expect(splitSetCookie(['a=1', 'b=2; Path=/'])).toEqual(['a=1', 'b=2; Path=/'])
  })
})

describe('CookieJar', () => {
  it('stores a host-only cookie and sends it to that host only', () => {
    const { jar } = makeJar()
    expect(jar.store('https://news.example.com/a/b', { 'set-cookie': 'sid=abc; Path=/' })).toBe(1)
    expect(jar.header('https://news.example.com/x')).toBe('sid=abc')
    expect(jar.header('https://other.example.com/x')).toBeUndefined()
    expect(jar.header('https://example.com/x')).toBeUndefined()
  })

  it('shares a domain cookie with subdomains and rejects an unrelated domain', () => {
    const { jar } = makeJar()
    jar.store('https://example.com/', { 'set-cookie': ['wide=1; Domain=.example.com; Path=/', 'unrelated=2; Domain=other.test; Path=/'] })
    expect(jar.header('https://news.example.com/x')).toBe('wide=1')
    expect(jar.header('https://example.com/x')).toBe('wide=1')
    expect(jar.header('https://other.test/')).toBeUndefined()
  })

  it('refuses a cookie scoped to a public suffix', () => {
    const { jar } = makeJar()
    jar.store('https://www.folha.com.br/', { 'set-cookie': 'leak=1; Domain=com.br; Path=/' })
    expect(jar.header('https://www.folha.com.br/')).toBeUndefined()
    expect(jar.header('https://www.uol.com.br/')).toBeUndefined()
  })

  it('puts a longer path first and never sends a cookie outside its path', () => {
    const { jar } = makeJar()
    jar.store('https://example.com/news/2026/', { 'set-cookie': 'deep=1; Path=/news' })
    jar.store('https://example.com/', { 'set-cookie': 'root=2; Path=/' })
    expect(jar.header('https://example.com/news/2026/a')).toBe('deep=1; root=2')
    expect(jar.header('https://example.com/newsfeed')).toBe('root=2')
    expect(jar.header('https://example.com/')).toBe('root=2')
  })

  it('honors Secure, Max-Age and expiry', () => {
    const { jar, advance } = makeJar()
    jar.store('https://example.com/', { 'set-cookie': 'sec=1; Secure; Path=/, short=2; Max-Age=10; Path=/' })
    expect(jar.header('http://example.com/')).toBe('short=2')
    expect(jar.header('https://example.com/')).toBe('sec=1; short=2')
    advance(11_000)
    expect(jar.header('https://example.com/')).toBe('sec=1')
  })

  it('drops a secure cookie that was set over plain HTTP', () => {
    const { jar } = makeJar()
    expect(jar.store('http://example.com/', { 'set-cookie': 'sec=1; Secure; Path=/' })).toBe(0)
    expect(jar.header('https://example.com/')).toBeUndefined()
  })

  it('enforces the __Host- and __Secure- prefix rules', () => {
    const { jar } = makeJar()
    jar.store('https://example.com/', { 'set-cookie': 'ok=1; Path=/' })
    jar.store('https://example.com/', {
      'set-cookie': '__Host-good=1; Secure; Path=/, __Host-nopath=2; Secure; __Host-domain=3; Secure; Path=/; Domain=example.com, __Secure-plain=4; Path=/, __Secure-good=5; Secure; Path=/',
    })
    expect(jar.header('https://example.com/')).toBe('ok=1; __Host-good=1; __Secure-good=5')
  })

  it('replaces a re-set cookie instead of duplicating it', () => {
    const { jar } = makeJar()
    jar.store('https://example.com/', { 'set-cookie': 'sid=old; Path=/' })
    jar.store('https://example.com/', { 'set-cookie': 'sid=new; Path=/' })
    expect(jar.header('https://example.com/')).toBe('sid=new')
  })

  it('evicts the oldest cookie past the capacity limit', () => {
    const { jar } = makeJar({ maxCookies: 2 })
    jar.store('https://example.com/', { 'set-cookie': 'a=1; Path=/' })
    jar.store('https://example.com/', { 'set-cookie': 'b=2; Path=/' })
    jar.store('https://example.com/', { 'set-cookie': 'c=3; Path=/' })
    expect(jar.header('https://example.com/')).toBe('b=2; c=3')
  })

  it('adopts browser-scoped cookies and lists names without values', () => {
    const { jar } = makeJar()
    jar.adopt({ name: 'browser', value: 'sensitive', domain: 'example.com', path: '/', expires: null, secure: true, httpOnly: true, hostOnly: true })
    expect(jar.header('https://example.com/')).toBe('browser=sensitive')
    expect(jar.summary()).toEqual([{ domain: 'example.com', count: 1, names: ['browser'] }])
  })

  it('ignores an already expired adopted cookie', () => {
    const { jar, at } = makeJar()
    jar.adopt({ name: 'gone', value: 'x', domain: 'example.com', path: '/', expires: at() - 1 })
    expect(jar.header('https://example.com/')).toBeUndefined()
  })

  it('clears every cookie on request', () => {
    const { jar } = makeJar()
    jar.store('https://example.com/', { 'set-cookie': 'a=1; Path=/' })
    jar.clear()
    expect(jar.header('https://example.com/')).toBeUndefined()
  })
})
