/** Address-pinned public GET transport and bounded, decoded article image acquisition. */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import http from 'node:http'
import https from 'node:https'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { createGunzip, createBrotliDecompress, createInflate } from 'node:zlib'
import ipaddr from 'ipaddr.js'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { failure } from './contracts.js'
import { reportProgress } from './diagnostics.js'
import { createDohResolver, DOH_ADDRESSES } from './network.js'

function raceAbort(operation, signal) {
  // 先检查取消再启动 DNS；已取消的 route 不能留下无人接管的异步拒绝。
  if (signal?.aborted) return Promise.reject(failure('article-interrupted'))
  const promise = operation()
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = () => reject(failure('article-interrupted'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function isPublic(address) {
  try {
    const parsed = ipaddr.parse(address)
    return (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress() ? parsed.toIPv4Address() : parsed).range() === 'unicast'
  } catch (error) { void error; return false }
}

function embeddedV4(bytes, bits) {
  if (bits === 96) return bytes.slice(12, 16).join('.')
  if (bytes[8] !== 0) return null
  const offset = bits / 8, count = 8 - offset
  return [...bytes.slice(offset, offset + count), ...bytes.slice(9, 13 - count)].join('.')
}

/** Resolve only globally reachable destinations; used for navigation, data and original images. @param {URL} url Validated URL. @param {object} options Cancellation. @returns {Promise<object[]>} Pinned address set. */
export async function publicNetworkPolicy(url, { signal, resolver = lookup } = {}) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await raceAbort(() => resolver(hostname, { all: true, order: 'verbatim', signal }), signal)
  if (!addresses.length || addresses.some(entry => !isPublic(entry.address))) throw failure('article-url-blocked')
  // 自定义 DNS64 前缀也可能把全局 IPv6 转换成内网 IPv4；与原生 HTTP 提供方一样检测 RFC 7050 前缀。
  if (addresses.some(entry => entry.family === 6)) {
    const discovery = await raceAbort(() => resolver('ipv4only.arpa', { all: true, order: 'verbatim', signal }), signal)
    for (const entry of discovery.filter(value => value.family === 6)) {
      const bytes = ipaddr.parse(entry.address).toByteArray()
      for (const bits of [32, 40, 48, 56, 64, 96]) {
        if (!['192.0.0.170', '192.0.0.171'].includes(embeddedV4(bytes, bits))) continue
        const prefix = bytes.slice(0, bits / 8)
        for (const destination of addresses.filter(value => value.family === 6)) {
          const candidate = ipaddr.parse(destination.address).toByteArray()
          if (prefix.every((byte, index) => candidate[index] === byte) && !isPublic(embeddedV4(candidate, bits))) throw failure('article-url-blocked')
        }
      }
    }
  }
  return addresses
}

/** Validate a resource URL without making a request. @param {string} value URL. @returns {URL} Public-scheme URL, before DNS. */
export function captureUrl(value) {
  let url
  try { url = new URL(value) } catch (error) { void error; throw failure('article-url') }
  if (value.length > 16384 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw failure('article-url-blocked')
  return url
}

/** Create pinned HTTP transport with optional operation-owned sessions. Every session request revalidates its URL and address set; dispose closes its sockets and waits for requests. Policy injection is test-only. @param {object} config Resolved capture limits. @param {object} dependencies Exact fixture policy. @returns {Function} Bounded request with createSession accepting poolSize, connectionsPerOrigin and exact redirect edges; omitted settings retain image-session defaults. */
export function createPublicRequest(config, dependencies = {}) {
  const resolver = config.network.dnsProvider === 'cloudflare' ? createDohResolver(config.network, dependencies.dnsQuery ?? (async (url, options) => {
    const response = await requestPinned(url, DOH_ADDRESSES, { ...options, method: 'GET', userAgent: config.articleUserAgent, network: config.network })
    return { ...response, mime: (response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() }
  })) : lookup
  const policy = dependencies.networkPolicy ?? ((url, options) => publicNetworkPolicy(url, { ...options, resolver }))
  const makeRequest = (session, redirects = []) => async (input, options = {}) => {
    if (session?.life.signal.aborted) throw failure('article-interrupted')
    const signal = AbortSignal.any([...(session ? [session.life.signal] : []), ...(options.signal ? [options.signal] : []), AbortSignal.timeout(config.requestTimeoutMs)])
    let url = captureUrl(input)
    let headers = options.headers
    const byteLimit = options.maxBytes ?? config.maxArticleHtmlBytes
    let received = 0
    // 跳转链上的每一跳都可能 Set-Cookie（登录门闸先 302 再下发会话）；这些 cookie 属于同一来源，
    // 丢掉它们会让调用方在跳转后拿不到刚刚建立的会话。
    const cookies = []
    try {
      for (let hop = 0; hop <= config.maxRedirects; hop++) {
        const addresses = await raceAbort(() => policy(url, { signal }), signal)
        if (!addresses.length) throw failure('article-url-blocked')
        const lease = await session?.acquire(url, addresses)
        let response
        try { response = await requestPinned(url, addresses, { signal, maxBytes: session ? byteLimit - received : byteLimit, method: options.method ?? 'GET', userAgent: config.articleUserAgent, headers, body: options.body, network: config.network,
          agent: lease?.agent, trackSocket: session?.trackSocket }) }
        finally { lease?.release() }
        if (session) received += response.bytes.length
        if (response.headers['set-cookie']) cookies.push(...[response.headers['set-cookie']].flat())
        if (response.statusCode >= 300 && response.statusCode < 400) {
          if (!response.headers.location) throw failure('article-redirect')
          const target = captureUrl(new URL(response.headers.location, url).href)
          if (target.origin !== url.origin) {
            // 只有当前站点的原图会话可显式批准精确 CDN 边；页面请求保持同源限制。
            if (!['GET', 'HEAD'].includes(options.method ?? 'GET') || options.body !== undefined || !redirects.some(edge => edge.from === url.origin && edge.to === target.origin)) throw failure('article-redirect')
            headers = Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => ['accept', 'referer'].includes(name.toLowerCase())))
            // 旧来源的 Set-Cookie 不能被最终来源的 CookieJar 接收，也不能在返程恢复。
            cookies.length = 0
          }
          if (session && received >= byteLimit) throw failure('article-resource-limit')
          url = target
          continue
        }
        const responseHeaders = cookies.length ? { ...response.headers, 'set-cookie': cookies } : response.headers
        return { ...response, ...(session ? { chargedBytes: received } : {}), headers: responseHeaders, url: url.href, mime: (responseHeaders['content-type'] ?? '').split(';')[0].trim().toLowerCase() }
      }
      throw failure('article-redirect')
    } catch (error) {
      if (options.signal?.aborted || session?.life.signal.aborted) throw failure('article-interrupted')
      if (signal.aborted) throw Object.assign(failure('article-timeout'), { cause: error })
      if (error?.code?.startsWith('article-') || error?.code?.startsWith('image-')) throw error
      throw Object.assign(failure('article-network'), { cause: error })
    }
  }
  const request = makeRequest(null)
  // 工厂普通调用保持一次性请求；渲染和原图各自显式持有独立会话及连接预算。
  request.createSession = ({ redirects = [], poolSize = config.imageConnectionPoolSize ?? 0, connectionsPerOrigin = 1 } = {}) => {
    const session = connectionSession(poolSize, connectionsPerOrigin, config.network.proxyUrl), run = makeRequest(session, redirects)
    const scoped = (input, options) => {
      const pending = run(input, options)
      session.pending.add(pending)
      pending.then(() => session.pending.delete(pending), () => session.pending.delete(pending))
      return pending
    }
    scoped.dispose = session.dispose
    return scoped
  }
  return request
}

function connectionSession(limit, connectionsPerOrigin, proxyUrl) {
  const life = new AbortController(), pools = new Map(), sockets = new Set(), pending = new Set(), retirements = new Set()
  let disposing
  const closed = socket => socket.closed ? Promise.resolve() : new Promise(resolve => socket.once('close', resolve))
  const retire = entry => {
    const owned = [...Object.values(entry.agent.sockets), ...Object.values(entry.agent.freeSockets)].flat(), done = owned.map(closed)
    entry.agent.destroy()
    const retiring = Promise.all(done)
    retirements.add(retiring)
    retiring.then(() => retirements.delete(retiring), () => retirements.delete(retiring))
  }
  return { life, pending,
    trackSocket(socket) { if (!sockets.has(socket)) { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) } },
    async acquire(url, addresses) {
      if (life.signal.aborted) throw failure('article-interrupted')
      if (!limit) return null
      // 每次请求先重新校验DNS；不同来源或已验证地址集合绝不能借用旧连接。
      const key = JSON.stringify([url.origin, addresses.map(a => `${a.family}:${a.address}`).sort(), proxyUrl ? addresses[0].address : ''])
      let entry = pools.get(key)
      if (!entry) {
        if (pools.size >= limit) {
          const idle = [...pools].find(([_key, value]) => !value.busy)
          if (!idle) return null
          // 不在预留新池前让出执行权；同源并发请求必须看到同一个新 agent。
          pools.delete(idle[0]); retire(idle[1])
        }
        const options = { keepAlive: true, maxSockets: connectionsPerOrigin, maxFreeSockets: connectionsPerOrigin, maxTotalSockets: connectionsPerOrigin }
        entry = { busy: 0, agent: proxyUrl ? new HttpsProxyAgent(proxyUrl, options) : url.protocol === 'https:' ? new https.Agent(options) : new http.Agent(options) }
      }
      pools.delete(key); pools.set(key, entry); entry.busy++
      return { agent: entry.agent, release() { entry.busy-- } }
    },
    dispose() {
      if (!disposing) disposing = (async () => {
        const done = [...sockets].map(closed)
        life.abort()
        for (const entry of pools.values()) entry.agent.destroy()
        for (const socket of sockets) socket.destroy()
        await Promise.allSettled([...pending, ...done, ...retirements]); pools.clear()
      })()
      return disposing
    },
  }
}

async function requestPinned(url, addresses, options) {
  const agent = options.agent ?? (options.network.proxyUrl ? new HttpsProxyAgent(options.network.proxyUrl, { signal: options.signal, keepAlive: false }) : null)
  let request, closed, complete = false
  try { return await new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : Buffer.from(String(options.body))
    const headers = { ...(options.headers ?? {}), 'user-agent': options.userAgent, accept: options.headers?.accept ?? '*/*', 'accept-encoding': 'identity' }
    // 调用方不得借此设置连接级头；这里只接受请求语义头。
    for (const name of ['connection', 'transfer-encoding', 'content-length', 'host']) delete headers[name]
    for (const name of Object.keys(headers)) if (['proxy-authorization', 'proxy-connection', 'host'].includes(name.toLowerCase())) delete headers[name]
    if (body) headers['content-length'] = String(body.length)
    request = (url.protocol === 'https:' ? https : http).request(url, { method: options.method, signal: options.signal,
      // 默认禁用连接池；篇级池只按本次已校验的地址集合和origin隔离复用。
      agent: agent ?? false, headers: { ...headers, host: url.host },
      // CONNECT 使用已验证 IP，Host 与 TLS SNI 仍使用发布站域名；代理无法重新解析目标到私网。
      ...(options.network.proxyUrl ? { hostname: addresses[0].address, servername: isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname } : {}),
      lookup: (_hostname, lookupOptions, callback) => {
        const eligible = lookupOptions.family ? addresses.filter(value => value.family === lookupOptions.family) : addresses
        const selected = eligible[0]
        if (!selected) { callback(failure('article-url-blocked')); return }
        if (lookupOptions.all) callback(null, eligible)
        else callback(null, selected.address, selected.family)
      },
    }, response => {
      const chunks = []; let size = 0
      response.once('error', reject)
      const length = Number(response.headers['content-length'] ?? 0)
      if (length > options.maxBytes) { response.destroy(failure('article-resource-limit')); return }
      const encoding = response.headers['content-encoding']?.toLowerCase()
      const decoder = !encoding || encoding === 'identity' ? null : encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress() : encoding === 'deflate' ? createInflate() : undefined
      if (decoder === undefined) { response.destroy(failure('article-resource-encoding')); return }
      const body = decoder ? response.pipe(decoder) : response
      body.once('error', error => { response.destroy(); reject(error) })
      body.on('data', chunk => {
        size += chunk.length
        if (size > options.maxBytes) { body.destroy(failure('article-resource-limit')); response.destroy() }
        else chunks.push(chunk)
      })
      body.once('end', () => { complete = true; resolve({ bytes: Buffer.concat(chunks), statusCode: response.statusCode ?? 0, headers: response.headers }) })
    })
    closed = new Promise(resolve => request.once('close', resolve))
    request.on('socket', socket => options.trackSocket?.(socket))
    request.once('error', reject)
    request.once('proxyConnect', response => { if (response.statusCode !== 200) request.destroy(failure('article-network')) })
    request.end(body)
  }) } finally {
    if (!complete || !options.agent) request?.destroy()
    if (!options.agent) agent?.destroy()
    if (closed) await closed
  }
}

const acceptedMime = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

function inlineRaster(source, maxBytes, url) {
  const comma = source.indexOf(','), header = source.slice(0, comma)
  const mime = /^data:(image\/(?:png|jpeg|gif|webp));base64$/u.exec(header)?.[1]
  if (!mime) throw failure('image-invalid')
  const encoded = source.slice(comma + 1)
  if (encoded.length > Math.ceil(maxBytes / 3) * 4) throw failure('image-byte-limit')
  if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) throw failure('image-invalid')
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.toString('base64') !== encoded) throw failure('image-invalid')
  return { bytes, mime, url, statusCode: 200 }
}

function rasterHeader(bytes, mime) {
  if (mime === 'image/png' && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  if (mime === 'image/gif' && bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  if (mime === 'image/webp' && bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const type = bytes.toString('ascii', 12, 16)
    if (type === 'VP8X') return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 }
    if (type === 'VP8L' && bytes[20] === 0x2f) return { width: 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]), height: 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | (bytes[22] >> 6)) }
    if (type === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
  }
  if (mime === 'image/jpeg' && bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break
      while (bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]
      if (marker === 0xd9 || marker === 0xda) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > bytes.length) break
      const size = bytes.readUInt16BE(offset)
      if (size < 2 || offset + size > bytes.length) break
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && size >= 7) return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) }
      offset += size
    }
  }
  throw failure('image-invalid')
}

/** Acquire verified unique bytes and metadata, retaining each failure at its article position. @param {object[]} figures Ordered candidates. @param {object} config Limits. @param {object} dependencies Transport/decoder. @returns {Promise<object>} Assets and figure references. */
export async function captureAssets(figures, config, dependencies) {
  const unique = new Map(), occurrences = new Map(), failures = [], byUrl = new Map()
  let totalBytes = 0, completed = 0, downloadMs = 0, decodeMs = 0
  for (const figure of figures) {
    dependencies.signal?.throwIfAborted()
    const metadata = { sourceUrl: figure.sourceUrl, alt: figure.alt, caption: figure.caption, credit: figure.credit, positions: [], error: null }
    const candidates = (figure.candidates ?? [figure.sourceUrl]).slice(0, config.maxImageCandidates)
    let asset, code = figure.error ?? 'image-source'
    const report = (event, attempt, source, error, response = {}) => reportProgress(dependencies.onProgress, { phase: 'assets', event, completed, total: figures.length,
      details: { attempt, blockId: figure.blockId, origin: new URL(source.startsWith('data:') ? figure.sourceUrl : source).origin, ...(error ? { code: error } : {}), statusCode: response.statusCode, mime: response.mime } })
    for (let index = 0; !figure.error && index < candidates.length; index++) {
      const source = candidates[index]
      dependencies.signal?.throwIfAborted()
      let cached = byUrl.get(source)
      if (!cached) {
        let budget, response
        try {
          if (completed >= config.maxImages) throw failure('image-count-limit')
          for (let transfer = 0; ; transfer++) {
            dependencies.signal?.throwIfAborted()
            budget = Math.min(config.maxImageBytes, config.maxTotalImageBytes - totalBytes)
            if (budget <= 0) throw failure('image-byte-limit')
            // 内联栅格图沿用字节、像素与真实解码限制；不持久化data URL。
            const downloadStarted = performance.now()
            let transferError
            try { response = source.startsWith('data:') ? inlineRaster(source, budget, figure.sourceUrl) : await dependencies.request(source, { signal: dependencies.signal, maxBytes: budget }) }
            catch (error) {
              // 未知已读字节按整次额度扣除；同候选重试也不能扩大篇级预算。
              if (!['article-url-blocked', 'article-redirect'].includes(error.code)) totalBytes += budget
              transferError = error
            } finally { downloadMs += performance.now() - downloadStarted }
            if (!transferError) break
            if (dependencies.signal?.aborted) throw failure('article-interrupted')
            if (transfer >= config.maxImageTransportRetries || !['article-timeout', 'article-network'].includes(transferError.code)) throw transferError
            await report('image-transfer-retry', transfer + 1, source, transferError.code)
          }
          totalBytes += response.chargedBytes ?? response.bytes.length
          if ((response.chargedBytes ?? response.bytes.length) > budget) throw failure('image-byte-limit')
          if (response.statusCode < 200 || response.statusCode >= 300) throw failure('image-download')
          if (!acceptedMime.has(response.mime) || !response.bytes.length) throw failure('image-invalid')
          const header = rasterHeader(response.bytes, response.mime)
          if (header.width < 1 || header.height < 1 || header.width * header.height > config.maxImagePixels) throw failure('image-dimensions')
          const decodeStarted = performance.now()
          let dimensions
          try { dimensions = await dependencies.inspectImage(response.bytes, response.mime, dependencies.signal) }
          finally { decodeMs += performance.now() - decodeStarted }
          if (!dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width * dimensions.height > config.maxImagePixels) throw failure('image-dimensions')
          const contentHash = createHash('sha256').update(response.bytes).digest('hex'), id = contentHash.slice(0, 32)
          asset = unique.get(id)
          if (!asset) {
            asset = { ...metadata, sourceUrl: response.url ?? source, id, status: 'ready', contentHash, mime: response.mime,
              width: dimensions.width, height: dimensions.height, byteLength: response.bytes.length, bytes: response.bytes }
            unique.set(id, asset)
          }
          cached = { asset }
        } catch (error) {
          if (dependencies.signal?.aborted) throw failure('article-interrupted')
          const code = ['image-source', 'image-count-limit', 'image-byte-limit', 'image-download', 'image-invalid', 'image-dimensions', 'article-url-blocked', 'article-redirect', 'article-resource-limit', 'article-timeout', 'article-network'].includes(error?.code) ? error.code : 'image-invalid'
          cached = { code, statusCode: response?.statusCode, mime: response?.mime }
        }
        byUrl.set(source, cached)
      }
      if (cached.asset) {
        asset = cached.asset
        if (index > 0) await report('image-candidate-selected', index + 1, source)
        break
      }
      code = cached.code
      await report('image-candidate-failed', index + 1, source, code, cached)
      // 公网策略拒绝不能用另一候选隐藏；达到篇级预算时也立即停止。
      if (['article-url-blocked', 'article-redirect', 'image-count-limit', 'image-byte-limit'].includes(code)) break
    }
    if (!asset) {
      const id = createHash('sha256').update(figure.candidates?.[0] ?? figure.sourceUrl).digest('hex').slice(0, 32)
      asset = unique.get(id) ?? { ...metadata, id, status: 'failed', contentHash: null, mime: null, width: null, height: null, byteLength: 0, error: code }
      failures.push(code)
      unique.set(id, asset)
    }
    asset.positions.push(figure.blockId)
    occurrences.set(figure.blockId, asset.id)
    completed++
    await reportProgress(dependencies.onProgress, { phase: 'assets', completed, total: figures.length,
      details: { downloadMs: Math.round(downloadMs), decodeMs: Math.round(decodeMs), chargedBytes: totalBytes } })
  }
  const assets = [...unique.values()]
  return { assets: assets.filter(asset => asset.status === 'ready'), metadata: assets.map(({ bytes, ...metadata }) => { void bytes; return metadata }), occurrences, failures, transferredBytes: totalBytes }
}
