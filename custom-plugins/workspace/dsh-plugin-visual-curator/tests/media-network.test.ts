import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { isPublicAddress, SafeHttpClient, MediaError, validateEndpoint } from '../src/media/index.ts'
import type { RequestBounds } from '../src/media/index.ts'

const bounds: RequestBounds = { maxBytes: 128, maxRedirects: 2, timeoutMs: 5000 }
const hasCode = (code: string) => (error: unknown) => error instanceof MediaError && error.code === code

test('rejects private, reserved and IPv4-mapped addresses across address families', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.0.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '192.0.2.1', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '2001:db8::1', 'garbage']) assert.equal(isPublicAddress(address), false, address)
  assert.equal(isPublicAddress('1.1.1.1'), true)
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true)
  assert.throws(() => validateEndpoint('https://key:secret@api.example.test', { allowedOrigins: ['https://api.example.test'] }), hasCode('invalid-input'))
  assert.throws(() => validateEndpoint('http://127.0.0.1:8000', { allowedOrigins: [] }), hasCode('invalid-input'))
})

test('rejects DNS sets containing any private address and never leaks upstream URL/credentials', async () => {
  const http = new SafeHttpClient({ allowedOrigins: ['https://api.example.test'] }, async () => [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }])
  await assert.rejects(http.request('https://api.example.test/media?signature=private-token', { ...bounds, method: 'GET', headers: { authorization: 'Bearer secret-key' } }), (error: unknown) => error instanceof MediaError && !JSON.stringify(error).includes('private-token') && !error.message.includes('secret-key') && error.code === 'invalid-input')
})

test('pins checked DNS records, keeps original Host and constrains the local vision exception', async () => {
  let host = ''
  let hits = 0
  const server = createServer((request, response) => { host = request.headers.host ?? ''; hits++; response.setHeader('content-type', 'application/json'); response.end('{"ok":true}') })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address !== null && typeof address !== 'string')
  const origin = `http://vision.test:${address.port}`
  let resolutions = 0
  const http = new SafeHttpClient({ allowedOrigins: [origin], localVisionOrigin: origin }, async hostname => { assert.equal(hostname, 'vision.test'); resolutions++; return [{ address: '127.0.0.1', family: 4 }] })
  try {
    const response = await http.request(`${origin}/v1/chat/completions`, { ...bounds, method: 'POST', body: Buffer.from('{}') })
    assert.deepEqual(JSON.parse(response.bytes.toString('utf8')), { ok: true })
    assert.equal(resolutions, 1)
    assert.equal(host, `vision.test:${address.port}`)
    await assert.rejects(http.request(`http://127.0.0.1:${address.port}/other`, { ...bounds, method: 'GET' }), hasCode('invalid-input'))
    assert.equal(hits, 1)
  } finally { server.close(); await once(server, 'close') }
})

test('revalidates redirected hosts before connection and bounds actual streamed bytes', async () => {
  let hits = 0
  const server = createServer((request, response) => {
    hits++
    if (request.url === '/redirect') { response.writeHead(302, { location: 'https://cdn.example.test/private?token=secret' }); response.end() }
    else { response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.write(Buffer.alloc(80)); response.end(Buffer.alloc(80)) }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address !== null && typeof address !== 'string')
  const origin = `http://vision.test:${address.port}`
  const resolutions: string[] = []
  const http = new SafeHttpClient({ allowedOrigins: ['https://cdn.example.test'], localVisionOrigin: origin }, async hostname => { resolutions.push(hostname); return [{ address: '127.0.0.1', family: 4 }] })
  try {
    await assert.rejects(http.request(`${origin}/redirect`, { ...bounds, method: 'GET', headers: { authorization: 'secret-api-key', 'x-api-key': 'other-key' } }), hasCode('invalid-input'))
    assert.deepEqual(resolutions, ['vision.test', 'cdn.example.test'])
    assert.equal(hits, 1)
    await assert.rejects(http.request(`${origin}/large`, { ...bounds, method: 'GET' }), hasCode('budget-exhausted'))
  } finally { server.close(); await once(server, 'close') }
})

test('cancellation interrupts unresolved DNS without a connection or hidden retries', async () => {
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let resolutions = 0
  const http = new SafeHttpClient({ allowedOrigins: ['https://api.example.test'] }, async () => { resolutions++; entered(); return await new Promise<never>(() => {}) })
  const controller = new AbortController()
  const pending = http.request('https://api.example.test', { ...bounds, method: 'GET', signal: controller.signal })
  await started
  controller.abort()
  await assert.rejects(pending, hasCode('cancelled'))
  assert.equal(resolutions, 1)
})
