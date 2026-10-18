/** Endpoint templating and inventory grouping, the basis of the reverse-engineering view. */
import { describe, expect, it } from 'vitest'
import { endpointTemplate, inventory } from '../src/endpoints.js'

const call = (method, url, { status = 200, mime = 'application/json', headers = {}, resourceType = 'xhr' } = {}) => ({
  resourceType,
  request: { method, url, headers },
  response: { status, mime, headers: {} },
})

describe('endpointTemplate', () => {
  it('folds numeric path segments but keeps year and month precision', () => {
    expect(endpointTemplate('https://www1.folha.uol.com.br/turismo/2026/10/roteiro-de-36-horas.shtml').path)
      .toBe('/turismo/:year/:month/roteiro-de-36-horas.shtml')
    expect(endpointTemplate('https://example.com/items/42').path).toBe('/items/:id')
    // 只有年份后面那一格才当月份；其它位置的两位数字仍是 id。
    expect(endpointTemplate('https://example.com/items/12').path).toBe('/items/:id')
  })

  it('folds UUIDs and long hexadecimal identifiers', () => {
    expect(endpointTemplate('https://example.com/users/3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6a7b/profile').path).toBe('/users/:uuid/profile')
    expect(endpointTemplate('https://example.com/assets/deadbeefdeadbeef00.js').path).toBe('/assets/:hash.js')
  })

  it('keeps slugs so different articles stay different endpoints', () => {
    const left = endpointTemplate('https://example.com/a/loja-de-camisas-azuis')
    const right = endpointTemplate('https://example.com/a/loja-de-camisas-verdes')
    expect(left.path).not.toBe(right.path)
  })

  it('collects sorted unique query names', () => {
    expect(endpointTemplate('https://example.com/search?q=a&page=2&q=b&lang=pt').query).toEqual(['lang', 'page', 'q'])
  })

  it('returns a readable template for an unparseable URL instead of throwing', () => {
    expect(endpointTemplate('not a url')).toEqual({ path: '/', query: [] })
  })
})

describe('inventory', () => {
  it('groups repeated calls into one endpoint with status, mime and query summaries', () => {
    const endpoints = inventory([
      call('GET', 'https://api.example.com/v1/items/1?page=1'),
      call('GET', 'https://api.example.com/v1/items/2?page=2'),
      call('GET', 'https://api.example.com/v1/items/3?page=3', { status: 500, mime: 'text/plain' }),
    ])
    expect(endpoints).toHaveLength(1)
    expect(endpoints[0]).toMatchObject({ key: 'GET api.example.com/v1/items/:id', method: 'GET', path: '/v1/items/:id', host: 'api.example.com', count: 3 })
    expect(endpoints[0].statuses).toEqual([200, 500])
    expect(endpoints[0].mimes).toEqual(['application/json', 'text/plain'])
    expect(endpoints[0].query).toEqual(['page'])
    expect(endpoints[0].sampleIndex).toBe(0)
  })

  it('separates methods and hosts that share a template path', () => {
    const endpoints = inventory([
      call('GET', 'https://api.example.com/v1/items/1'),
      call('POST', 'https://api.example.com/v1/items/2'),
      call('GET', 'https://cdn.example.com/v1/items/3'),
    ])
    expect(endpoints.map(endpoint => endpoint.key).sort()).toEqual([
      'GET api.example.com/v1/items/:id', 'GET cdn.example.com/v1/items/:id', 'POST api.example.com/v1/items/:id',
    ])
    expect(endpoints.map(endpoint => endpoint.host).sort()).toEqual(['api.example.com', 'api.example.com', 'cdn.example.com'])
  })

  it('summarizes credentials without exposing them', () => {
    const [endpoint] = inventory([call('GET', 'https://api.example.com/v1/me', {
      headers: { Authorization: 'Bearer super-secret-token', Cookie: 'sid=abc; theme=dark' },
    })])
    expect(endpoint.auth).toEqual({ scheme: 'bearer', present: true, length: 'Bearer super-secret-token'.length })
    expect(endpoint.cookie).toEqual({ count: 2, names: ['sid', 'theme'] })
    expect(JSON.stringify(endpoint)).not.toContain('super-secret-token')
    expect(JSON.stringify(endpoint)).not.toContain('abc')
  })

  it('reports no credential summary when the request carried none', () => {
    const [endpoint] = inventory([call('GET', 'https://api.example.com/v1/feed')])
    expect(endpoint.auth).toBeNull()
    expect(endpoint.cookie).toBeNull()
  })

  it('orders endpoints by first appearance, not by frequency', () => {
    const endpoints = inventory([
      call('GET', 'https://example.com/rare'),
      call('GET', 'https://example.com/common'),
      call('GET', 'https://example.com/common'),
      call('GET', 'https://example.com/common'),
    ])
    expect(endpoints.map(endpoint => endpoint.path)).toEqual(['/rare', '/common'])
  })

  it('marks ad and analytics hosts so site endpoints stay visible', () => {
    const endpoints = inventory([
      call('GET', 'https://www1.folha.uol.com.br/turismo/2026/10/roteiro.shtml'),
      call('POST', 'https://trc.taboola.com/folhadespaulo/trc/123/json'),
      call('GET', 'https://www.google-analytics.com/g/collect'),
      call('GET', 'https://securepubads.g.doubleclick.net/pagead/ppub_config'),
      call('GET', 'https://paywall.folha.uol.com.br/wall.json'),
      call('GET', 'https://fastlane.rubiconproject.com/a/api/fastlane.json'),
      call('GET', 'https://teads.tv/iframe'),
    ])
    const byHost = Object.fromEntries(endpoints.map(endpoint => [endpoint.host, endpoint.owner]))
    expect(byHost).toMatchObject({
      'www1.folha.uol.com.br': 'site', 'paywall.folha.uol.com.br': 'site',
      'trc.taboola.com': 'tracker', 'www.google-analytics.com': 'tracker', 'teads.tv': 'tracker',
      'securepubads.g.doubleclick.net': 'tracker', 'fastlane.rubiconproject.com': 'tracker',
    })
  })
})
