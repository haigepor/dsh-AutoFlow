/** Bounded, certificate-verified DNS over HTTPS with validated question and address records. */
import { isIP } from 'node:net'
import { failure } from './contracts.js'

// Cloudflare 公布的 DoH 主机与引导地址；HTTPS 仍按主机名校验证书，代理只连接这个固定公网 IP。
export const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query'
export const DOH_ADDRESSES = [{ address: '1.1.1.1', family: 4 }]

/** Resolve A/AAAA through bounded DoH; the caller still applies public-network policy to every result. @param {object} config Resolved network settings. @param {Function} query Address-pinned HTTPS request. @param {Function} [now] Cache clock. @returns {Function} Resolver compatible with publicNetworkPolicy. */
export function createDohResolver(config, query, now = Date.now) {
  const cache = new Map(), normalized = host => host.toLowerCase().replace(/\.$/, '')
  return async (host, { signal } = {}) => {
    const name = normalized(host), saved = cache.get(name)
    if (saved && saved.expires > now()) return saved.addresses
    cache.delete(name)
    let ttl = config.maxDnsCacheTtlMs
    const parts = await Promise.all([1, 28].map(async type => {
      const url = new URL(DOH_ENDPOINT); url.searchParams.set('name', name); url.searchParams.set('type', String(type))
      const response = await query(url, { signal, maxBytes: 65536, headers: { accept: 'application/dns-json' } })
      if (response.statusCode !== 200 || response.bytes.length > 65536 || response.mime !== 'application/dns-json') throw failure('article-network')
      let data
      try { data = JSON.parse(response.bytes.toString('utf8')) } catch (error) { void error; throw failure('article-network') }
      if (!data || typeof data !== 'object' || data.Status !== 0 || data.TC || !Array.isArray(data.Question) || data.Question.length !== 1 || typeof data.Question[0]?.name !== 'string' || normalized(data.Question[0].name) !== name || data.Question[0].type !== type) throw failure('article-network')
      if (data.Answer !== undefined && !Array.isArray(data.Answer)) throw failure('article-network')
      if ((data.Answer ?? []).some(record => !record || typeof record !== 'object')) throw failure('article-network')
      return (data.Answer ?? []).filter(record => record.type === type).map(record => {
        const family = type === 1 ? 4 : 6
        if (typeof record.data !== 'string' || isIP(record.data) !== family || !Number.isFinite(record.TTL) || record.TTL < 0) throw failure('article-network')
        ttl = Math.min(ttl, record.TTL * 1000)
        return { address: record.data, family }
      })
    }))
    const addresses = parts.flat()
    if (signal?.aborted) throw failure('article-interrupted')
    if (addresses.length && ttl > 0) {
      while (cache.size >= config.maxDnsCacheEntries) cache.delete(cache.keys().next().value)
      cache.set(name, { addresses, expires: now() + ttl })
    }
    return addresses
  }
}
