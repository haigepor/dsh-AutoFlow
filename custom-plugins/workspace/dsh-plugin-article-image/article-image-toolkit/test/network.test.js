/** Proxy tunneling keeps address pinning, cancellation and origin-header isolation. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { once } from 'node:events'
import { createPublicRequest } from '../src/capture-media.js'
import { resolveCaptureConfig } from '../src/capture.js'
import { resolveConfig } from '../src/config.js'
import { createDohResolver } from '../src/network.js'

const cleanups = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function server(handler = (req, res) => { res.end('') }) {
  const value = createServer(handler), sockets = new Set()
  value.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  value.listen(0, '127.0.0.1')
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => value.close(resolve)) })
  await once(value, 'listening')
  return { server: value, port: value.address().port, url: `http://127.0.0.1:${value.address().port}`, sockets }
}
function dnsResponse(url, address = '93.184.216.34', ttl = 0) {
  const type = Number(url.searchParams.get('type')), name = url.searchParams.get('name')
  return { statusCode: 200, mime: 'application/dns-json', bytes: Buffer.from(JSON.stringify({ Status: 0, TC: false, Question: [{ name: name + '.', type }], Answer: type === 1 ? [{ name, type, TTL: ttl, data: address }] : [] })) }
}
async function tunnel(target) {
  const requests = [], proxy = await server()
  proxy.server.on('connect', (req, socket, head) => {
    requests.push({ target: req.url, headers: req.headers })
    if (req.url !== `93.184.216.34:${target.port}`) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
    // 精确的测试代理只连接本测试拥有的端口，不会向该公网示例地址发包。
    const upstream = connect(target.port, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream).pipe(socket) })
    socket.once('close', () => upstream.destroy()); upstream.once('error', () => socket.destroy())
  })
  return { ...proxy, requests }
}

describe('pinned proxy transport', () => {
  it('never starts DNS or policy work after cancellation has taken ownership', async () => {
    const policy = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
    const request = createPublicRequest(resolveCaptureConfig(), { networkPolicy: policy })
    await expect(request('https://articles.example.test/story', { signal: AbortSignal.abort() })).rejects.toThrow('article-interrupted')
    expect(policy).not.toHaveBeenCalled()
  })

  it('uses CONNECT with the validated IP while preserving the original HTTP Host', async () => {
    const received = []
    const target = await server((req, res) => { received.push(req.headers); res.writeHead(200, { 'content-type': 'text/plain' }); res.end('public article') })
    const proxy = await tunnel(target)
    const config = resolveCaptureConfig({ network: { proxyUrl: proxy.url, dnsProvider: 'cloudflare' } })
    const request = createPublicRequest(config, { dnsQuery: async url => dnsResponse(url) })
    const value = await request(`http://articles.example.test:${target.port}/story`, { headers: { cookie: 'anonymous=value', 'proxy-authorization': 'must-not-reach-origin', host: 'attacker.example' } })
    expect(value.bytes.toString()).toBe('public article')
    expect(proxy.requests[0].target).toBe(`93.184.216.34:${target.port}`)
    expect(proxy.requests[0].headers.cookie).toBeUndefined()
    expect(received[0]).toMatchObject({ host: `articles.example.test:${target.port}`, cookie: 'anonymous=value' })
    expect(received[0]['proxy-authorization']).toBeUndefined()
  })

  it('rejects private DNS answers, including a rebinding answer after a successful request', async () => {
    const target = await server((req, res) => res.end('public'))
    const proxy = await tunnel(target)
    let address = '93.184.216.34'
    const request = createPublicRequest(resolveCaptureConfig({ network: { proxyUrl: proxy.url, dnsProvider: 'cloudflare' } }), { dnsQuery: async url => dnsResponse(url, address) })
    await request(`http://articles.example.test:${target.port}/story`)
    address = '127.0.0.1'
    await expect(request(`http://articles.example.test:${target.port}/story`)).rejects.toThrow('article-url-blocked')
    await expect(request(`http://127.0.0.1:${target.port}/private`)).rejects.toThrow('article-url-blocked')
    expect(proxy.requests).toHaveLength(1)
  })

  it('revalidates same-origin redirects and refuses cross-origin redirects through a proxy', async () => {
    const target = await server((req, res) => { res.writeHead(302, { location: 'http://127.0.0.1/private' }); res.end() })
    const proxy = await tunnel(target)
    const request = createPublicRequest(resolveCaptureConfig({ network: { proxyUrl: proxy.url, dnsProvider: 'cloudflare' } }), { dnsQuery: async url => dnsResponse(url) })
    await expect(request(`http://articles.example.test:${target.port}/story`)).rejects.toThrow('article-redirect')
    expect(proxy.requests).toHaveLength(1)
  })

  it('aborts a proxy still waiting for CONNECT and closes its socket', async () => {
    const proxy = await server(), controller = new AbortController()
    let started, ended
    const ready = new Promise(resolve => { started = resolve }), closed = new Promise(resolve => { ended = resolve })
    proxy.server.on('connect', (req, socket) => {
      socket.once('close', ended)
      // CONNECT 已脱离 HTTP parser；测试代理自己关闭收到 FIN 的半开连接。
      socket.once('end', () => socket.end()); socket.resume(); started()
    })
    const request = createPublicRequest(resolveCaptureConfig({ network: { proxyUrl: proxy.url, dnsProvider: 'cloudflare' } }), { dnsQuery: async url => dnsResponse(url) })
    const operation = request('https://articles.example.test/story', { signal: controller.signal }).catch(error => error.code)
    await ready; controller.abort()
    expect(await operation).toBe('article-interrupted')
    await closed
  })

  it('classifies a proxy refusal as a transport failure without sending origin cookies', async () => {
    const proxy = await server(), headers = []
    proxy.server.on('connect', (req, socket) => { headers.push(req.headers); socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n') })
    const request = createPublicRequest(resolveCaptureConfig({ network: { proxyUrl: proxy.url, dnsProvider: 'cloudflare' } }), { dnsQuery: async url => dnsResponse(url) })
    await expect(request('https://articles.example.test/story', { headers: { cookie: 'private=never-in-connect' } })).rejects.toThrow('article-network')
    expect(headers[0].cookie).toBeUndefined()
  })

  it('inherits toolkit network settings into rich capture unless explicitly overridden', () => {
    const network = { proxyUrl: 'http://127.0.0.1:7897', dnsProvider: 'cloudflare' }
    expect(resolveConfig({ network }).capture.network).toEqual(resolveConfig({ network }).network)
    expect(resolveConfig({ network, capture: { network: { dnsProvider: 'system' } } }).capture.network.proxyUrl).toBeUndefined()
    expect(() => resolveConfig({ network: { proxyUrl: 'http://user:secret@proxy.example' } })).toThrow('Expected an HTTP(S) proxy without credentials')
  })
})

describe('bounded DNS over HTTPS', () => {
  it('respects answer TTL and the configured cache size', async () => {
    const config = resolveCaptureConfig({ network: { maxDnsCacheEntries: 1, maxDnsCacheTtlMs: 5000 } }).network
    let clock = 0, calls = 0
    const resolve = createDohResolver(config, async url => { calls++; return dnsResponse(url, '93.184.216.34', 30) }, () => clock)
    await resolve('one.example.test'); await resolve('one.example.test'); expect(calls).toBe(2)
    clock = 5001; await resolve('one.example.test'); expect(calls).toBe(4)
    await resolve('two.example.test'); await resolve('one.example.test'); expect(calls).toBe(8)
  })

  it.each(['invalid-json', 'wrong-question', 'truncated', 'invalid-address', 'oversized', 'wrong-mime'])('rejects a %s response without forwarding its text', async kind => {
    const resolve = createDohResolver(resolveCaptureConfig().network, async url => {
      const response = dnsResponse(url), data = JSON.parse(response.bytes)
      if (kind === 'invalid-json') response.bytes = Buffer.from('private remote content')
      if (kind === 'wrong-question') { data.Question[0].name = 'other.example.test'; response.bytes = Buffer.from(JSON.stringify(data)) }
      if (kind === 'truncated') { data.TC = true; response.bytes = Buffer.from(JSON.stringify(data)) }
      if (kind === 'invalid-address') { data.Answer = [{ type: Number(url.searchParams.get('type')), TTL: 1, data: 'not-an-address' }]; response.bytes = Buffer.from(JSON.stringify(data)) }
      if (kind === 'oversized') response.bytes = Buffer.alloc(65537)
      if (kind === 'wrong-mime') response.mime = 'text/html'
      return response
    })
    await expect(resolve('article.example.test')).rejects.toThrow('article-network')
  })
})
