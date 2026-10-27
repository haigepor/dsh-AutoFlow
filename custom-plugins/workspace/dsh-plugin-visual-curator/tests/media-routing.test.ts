/** Media failover changes resolution only; authorization, hostname TLS and the outer attempt stay fixed. */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { GalleryMediaClient } from '../src/media/media-routing.ts'
import { MediaError } from '../src/media/errors.ts'
import type { DnsResolver, HttpClient } from '../src/media/network.ts'

const options = { connectTimeoutMs: 100, mediaConnectTimeoutMs: 100, mediaConnectAttempts: 5, mediaDnsCacheEntries: 8, mediaDnsCacheTtlMs: 10_000, mediaDnsFailureTtlMs: 1000, mediaDnsResolvers: ['https://dns.example/resolve', 'https://other-dns.example/resolve'] }
const bounds = { method: 'GET' as const, maxBytes: 1000, timeoutMs: 5000, maxRedirects: 1 }
const connectFailure = () => new MediaError('remote-connect-timeout', 'network', true, 'Connection timed out.', 'Retry resolution.', { modelOutput: null, issues: ['before-response', 'connect-timeout'] })

it('uses refreshed HTTPS DNS after an unreachable system answer and reuses the working route', async () => {
  const attempts: string[] = [], hosts: string[] = []
  let queries = 0
  const client = new GalleryMediaClient(options, {
    lookup: async () => [{ address: '146.75.114.208', family: 4 }],
    query: async () => { queries++; return { addresses: [{ address: '151.101.2.208', family: 4 }], ttlMs: 8000 } },
    createClient: (resolve: DnsResolver): HttpClient => ({ request: async (url, input) => {
      hosts.push(new URL(url).hostname)
      assert.ok(input.connectTimeoutMs! <= options.connectTimeoutMs)
      const [address] = await resolve(new URL(url).hostname); attempts.push(address!.address)
      if (address!.address === '146.75.114.208') throw connectFailure()
      return { status: 200, headers: { 'content-type': 'image/jpeg' }, bytes: Buffer.from('pixels') }
    } }),
  })
  await client.request('https://images.unsplash.com/photo?w=400', bounds)
  await client.request('https://images.unsplash.com/photo?w=1080', bounds)
  assert.deepEqual(attempts, ['146.75.114.208', '151.101.2.208', '151.101.2.208'])
  assert.deepEqual(hosts, ['images.unsplash.com', 'images.unsplash.com', 'images.unsplash.com'])
  assert.equal(queries, 1)
})

it('rotates public addresses and DNS services without repeating a known failed node', async () => {
  const attempts: string[] = [], resolvers: string[] = []
  const client = new GalleryMediaClient(options, {
    lookup: async () => [{ address: '146.75.114.208', family: 4 }],
    query: async endpoint => { resolvers.push(endpoint); return { addresses: endpoint.includes('other-') ? [{ address: '151.101.194.208', family: 4 }] : [{ address: '146.75.114.208', family: 4 }, { address: '151.101.2.208', family: 4 }], ttlMs: 1000 } },
    createClient: resolve => ({ request: async url => { const [address] = await resolve(new URL(url).hostname); attempts.push(address!.address); if (address!.address !== '151.101.194.208') throw connectFailure(); return { status: 200, headers: {}, bytes: Buffer.from('ok') } } }),
  })
  await client.request('https://images.unsplash.com/photo', bounds)
  assert.deepEqual(attempts, ['146.75.114.208', '151.101.2.208', '151.101.194.208'])
  assert.equal(resolvers.length, 2)
})

it('rejects nonpublic DNS answers and never retries a certificate or authorization failure', async () => {
  for (const code of ['configuration-required', 'remote-certificate-error']) {
    let calls = 0, queries = 0
    const client = new GalleryMediaClient(options, { lookup: async () => [{ address: '151.101.2.208', family: 4 }], query: async () => { queries++; throw new Error('not expected') }, createClient: () => ({ request: async () => { calls++; throw new MediaError(code, 'network', false, 'Refused.', 'Check settings.') } }) })
    await assert.rejects(client.request('https://images.unsplash.com/photo', bounds), { code })
    assert.equal(calls, 1); assert.equal(queries, 0)
  }
  let calls = 0
  const blocked = new GalleryMediaClient(options, { lookup: async () => [{ address: '127.0.0.1', family: 4 }], createClient: () => ({ request: async () => { calls++; throw new Error('unexpected') } }) })
  await assert.rejects(blocked.request('https://images.unsplash.com/photo', bounds), { code: 'invalid-input' })
  assert.equal(calls, 0)
})

it('bounds failover by the configured attempt count and shares DNS lookups without sharing cancellation', async () => {
  let calls = 0, queries = 0
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const client = new GalleryMediaClient({ ...options, mediaConnectAttempts: 3 }, {
    lookup: async () => [{ address: '146.75.114.208', family: 4 }],
    query: async () => { queries++; entered.resolve(); await release.promise; return { addresses: [{ address: '151.101.2.208', family: 4 }], ttlMs: 1000 } },
    createClient: resolve => ({ request: async url => { calls++; const [ip] = await resolve(new URL(url).hostname); if (ip!.address === '146.75.114.208') throw connectFailure(); return { status: 200, headers: {}, bytes: Buffer.from('ok') } } }),
  })
  const controller = new AbortController()
  const cancelled = client.request('https://images.unsplash.com/one', { ...bounds, signal: controller.signal })
  await entered.promise
  const other = client.request('https://images.unsplash.com/two', bounds)
  controller.abort(); await assert.rejects(cancelled, { code: 'cancelled' })
  release.resolve(); await other
  assert.equal(queries, 1); assert.ok(calls <= 3)
})

it('uses no external resolver on a healthy system route and honors zero DNS TTL', async () => {
  let queries = 0
  const healthy = new GalleryMediaClient(options, { lookup: async () => [{ address: '151.101.2.208', family: 4 }], query: async () => { throw new Error('unexpected external DNS') }, createClient: () => ({ request: async () => ({ status: 200, headers: {}, bytes: Buffer.from('ok') }) }) })
  await healthy.request('https://images.unsplash.com/photo', bounds)
  const expired = new GalleryMediaClient(options, { lookup: async () => [{ address: '146.75.114.208', family: 4 }], query: async () => { queries++; return { addresses: [{ address: '151.101.2.208', family: 4 }], ttlMs: 0 } }, createClient: resolve => ({ request: async url => { const [ip] = await resolve(new URL(url).hostname); if (ip!.address === '146.75.114.208') throw connectFailure(); return { status: 200, headers: {}, bytes: Buffer.from('ok') } } }) })
  await expired.request('https://images.unsplash.com/one', bounds); await expired.request('https://images.unsplash.com/two', bounds)
  assert.equal(queries, 2)
  await healthy.dispose(); await expired.dispose()
})

it('disposal cancels and drains a shared DNS query without dispatching another image', async () => {
  const entered = Promise.withResolvers<void>()
  let calls = 0
  const client = new GalleryMediaClient(options, { lookup: async () => [{ address: '146.75.114.208', family: 4 }], query: async (_endpoint, _host, signal) => { entered.resolve(); await new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }) }); throw new Error('aborted DNS must not resolve') }, createClient: () => ({ request: async () => { calls++; throw connectFailure() } }) })
  const pending = client.request('https://images.unsplash.com/photo', bounds)
  const settled = assert.rejects(pending, { code: 'cancelled' })
  await entered.promise; await client.dispose(); await settled
  assert.equal(calls, 1)
})

it('refreshes exhausted DNS answers and retries a transiently failed node within the same bound', async () => {
  let calls = 0, queries = 0
  const client = new GalleryMediaClient({ ...options, mediaDnsResolvers: [options.mediaDnsResolvers[0]!] }, { lookup: async () => [{ address: '151.101.2.208', family: 4 }], query: async () => { queries++; return { addresses: [{ address: '151.101.2.208', family: 4 }], ttlMs: 1000 } }, createClient: () => ({ request: async () => { if (++calls === 1) throw connectFailure(); return { status: 200, headers: {}, bytes: Buffer.from('ok') } } }) })
  await client.request('https://images.unsplash.com/photo', bounds)
  assert.equal(calls, 2); assert.equal(queries, 2)
  await client.dispose()
})

it('stops reconnecting when the attempt budget is exhausted', async () => {
  let calls = 0
  const client = new GalleryMediaClient({ ...options, mediaConnectAttempts: 2 }, { lookup: async () => [{ address: '146.75.114.208', family: 4 }], query: async () => ({ addresses: [{ address: '151.101.2.208', family: 4 }, { address: '151.101.66.208', family: 4 }], ttlMs: 1000 }), createClient: () => ({ request: async () => { calls++; throw connectFailure() } }) })
  await assert.rejects(client.request('https://images.unsplash.com/photo', bounds), { code: 'remote-connect-timeout' })
  assert.equal(calls, 2)
  await client.dispose()
})
