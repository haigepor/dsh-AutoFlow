import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createAccountProfileReader } from '../src/host/afp-account-profile.js'
import { resolveConfig } from '../config-schema.js'
import { createAfpPreviewClient, validatePreviewUrl } from '../src/vendor/auto-afp-img/afp-preview-client.mjs'

test('account reader uses the documented user query and returns only display fields, preserving zero credit', async () => {
  let request
  const config = resolveConfig({ readRetries: 0 })
  const read = createAccountProfileReader({ accessToken: 'fixture-token', config, sleep: async () => {},
    fetchImpl: async (url, init) => {
      request = { url, init }
      return Response.json({ data: { user: { login: 'alice', id: 1, firstName: 'Alice', lastName: 'Test',
        email: 'alice@example.test', clientId: 'client', credit: { amount: 0 }, subjectToCredit: true,
        password: 'must-not-project', accessToken: 'must-not-project', authorities: ['admin'] } } })
    } })
  const result = await read()
  assert.equal(request.url, config.loginEndpoint)
  assert.equal(request.init.headers.authorization, 'Bearer fixture-token')
  assert.equal(JSON.parse(request.init.body).operationName, 'user')
  assert.doesNotMatch(JSON.parse(request.init.body).query, /mutation|authorities|password/)
  assert.deepEqual(result, JSON.parse(readFileSync(new URL('./fixtures/account-profile.json', import.meta.url), 'utf8')))
  assert.doesNotMatch(JSON.stringify(result), /must-not-project|admin|fixture-token/)
})

test('account reader distinguishes missing balance from zero and rejects GraphQL failures', async () => {
  let payload = { data: { user: { login: 'alice' } } }
  const read = createAccountProfileReader({ accessToken: 'test', config: resolveConfig({ readRetries: 0 }), sleep: async () => {},
    fetchImpl: async () => Response.json(payload) })
  assert.equal((await read()).credit, null)
  for (const value of [-1, '100', null]) { payload.data.user.credit = { amount: value }; assert.equal((await read()).credit, null) }
  payload = { errors: [{ message: 'private-token' }], data: { user: { credit: { amount: 100 } } } }
  await assert.rejects(read(), error => error.message === 'AFP account profile unavailable')
})

test('preview strips authorization at CDN redirects, cancels the redirect body and requests supported raster formats', async () => {
  const calls = []
  let cancelled = false
  const preview = createAfpPreviewClient({ accessToken: 'fixture-token', retries: 0, allowedCdnHosts: ['cdn.example.test'],
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      if (calls.length === 1) return Response.json({ data: { docs: [{ id: 'photo', mockup: [{ href: 'mockup-id', role: 'Mockup' }] }] } })
      if (calls.length === 2) return new Response(new ReadableStream({ cancel() { cancelled = true } }), {
        status: 302, headers: { location: 'https://cdn.example.test/image.jpg?signature=private' } })
      return new Response(new Uint8Array([255, 216, 255]), { headers: { 'content-type': 'application/octet-stream' } })
    } })
  const result = await preview.getPreviewBytes('photo')
  assert.equal(cancelled, true)
  assert.equal(calls[2].init.headers.authorization, undefined)
  assert.equal(calls[1].init.headers.accept, 'image/jpeg,image/png,image/webp,image/gif')
  assert.equal(result.bytes.length, 3)
  assert.doesNotMatch(JSON.stringify(result), /signature|fixture-token/)
  assert.throws(() => validatePreviewUrl('https://denied.example.test/photo?secret=token'), error =>
    error.code === 'preview-host-blocked' && error.hostname === 'denied.example.test' && !error.message.includes('token'))
  assert.throws(() => validatePreviewUrl('https://user:pass@afp-apicore-prod.afp.com/photo'), /credentials/)
})

test('preview does not download media returned for a different photo ID', async () => {
  let calls = 0
  const preview = createAfpPreviewClient({ accessToken: 'test', retries: 0, fetchImpl: async () => {
    calls++
    return Response.json({ data: { docs: [{ id: 'other-photo', mockup: [{ href: 'other-mockup', role: 'Mockup' }] }] } })
  } })
  await assert.rejects(preview.getPreviewBytes('requested-photo'), /requested photo/)
  assert.equal(calls, 1)
})
