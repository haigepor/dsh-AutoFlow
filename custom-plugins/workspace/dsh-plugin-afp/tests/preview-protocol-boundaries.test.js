import test from 'node:test'
import assert from 'node:assert/strict'
import { createAfpPreviewClient, findMockupReference, validatePreviewUrl } from '../src/vendor/auto-afp-img/afp-preview-client.mjs'
import { Connection, transport } from '../src/host/afp-credentials.js'
import { resolveConfig } from '../config-schema.js'
import { digest } from '../src/host/afp-state-store.js'

const far = 'https://far.afp.test/'
const media = 'https://media.afp.test/objects/api/medias'
const cdn = 'dpreview123.cloudfront.net'
const jpeg = new Uint8Array([255, 216, 255, 0])
const image = () => new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } })
const metadata = href => Response.json({ data: { docs: [{ id: 'photo', mockup: [{ href, role: 'Mockup' }] }] } })

test('a preview redirect back from CDN to the configured AFP origin retains AFP authentication', async () => {
  const calls = []
  const client = createAfpPreviewClient({ accessToken: 'fixture-token', retries: 0, farEndpoint: far,
    apicoreEndpoint: media, autoDiscoverCdnHosts: true, fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), authorization: options.headers.authorization })
      if (options.method === 'POST') return metadata('mockup-id')
      if (new URL(url).searchParams.has('step')) return new Response(null, { status: 302, headers: { location: `https://${cdn}/handoff` } })
      if (new URL(url).hostname === cdn) return new Response(null, { status: 302, headers: { location: new URL('/final', media).href } })
      return options.headers.authorization === 'Bearer fixture-token' ? image() : new Response(null, { status: 401 })
    } })
  assert.deepEqual((await client.getPreviewBytes('photo')).bytes, jpeg)
  assert.equal(calls.filter(call => call.url.hostname === cdn).every(call => call.authorization === undefined), true)
  assert.equal(calls.filter(call => call.url.origin === new URL(media).origin).every(call => call.authorization === 'Bearer fixture-token'), true)
})

for (const destination of ['https://media.afp.test:8443/image', `https://${cdn}:8443/image`]) {
  test(`metadata cannot change a preview destination to an unconfigured port (${new URL(destination).hostname})`, async () => {
    let mediaReads = 0
    const client = createAfpPreviewClient({ accessToken: 'fixture-token', retries: 0, farEndpoint: far,
      apicoreEndpoint: media, allowedCdnHosts: [cdn], fetchImpl: async (_url, options) => {
        if (options.method === 'POST') return metadata(destination)
        mediaReads++; return image()
      } })
    await assert.rejects(client.getPreviewBytes('photo'))
    assert.equal(mediaReads, 0)
  })
}

test('a non-default HTTPS port is usable only when it is the configured AFP origin', async () => {
  const endpoint = 'https://media.afp.test:8443/objects/api/medias'
  const client = createAfpPreviewClient({ accessToken: 'fixture-token', retries: 0, farEndpoint: far,
    apicoreEndpoint: endpoint, fetchImpl: async (url, options) => {
      if (options.method === 'POST') return metadata('mockup-id')
      assert.equal(new URL(url).origin, new URL(endpoint).origin)
      assert.equal(options.headers.authorization, 'Bearer fixture-token')
      return image()
    } })
  assert.deepEqual((await client.getPreviewBytes('photo')).bytes, jpeg)
})

test('Mockup selection skips missing references and retains unlabelled legacy Mockups', () => {
  assert.equal(findMockupReference({ mockup: [{ role: 'Mockup', href: '' }, { role: 'Mockup', href: 'usable' }] }), 'usable')
  assert.equal(findMockupReference({ mockup: [{ href: 'legacy' }] }), 'legacy')
})

test('explicit download roles and non-string media references never become previews', () => {
  for (const mockup of [[{ role: 'HighRes', href: 'download-only' }], [{ role: 'MidRes', href: 'download-only' }],
    [{ role: 'Mockup', href: 42 }], [{ role: 'Mockup', href: { url: 'not-a-reference' } }]]) {
    assert.throws(() => findMockupReference({ mockup }))
  }
})

for (const host of ['0.0.0.0', '100.64.0.1', '224.0.0.1', '[fc00::1]', '[fe90::1]', '[::ffff:127.0.0.1]',
  'localhost.', 'nested.localhost.', 'printer.local.']) {
  test(`preview origins reject non-public literal addresses (${host})`, () => {
    assert.throws(() => validatePreviewUrl(`https://${host}/image`, { apicoreEndpoint: `https://${host}/media` }))
  })
}

test('a cancelled preview releases redirects and cannot admit a later media request', async () => {
  const controller = new AbortController(), calls = []
  let response
  const client = createAfpPreviewClient({ accessToken: 'fixture-token', retries: 0, farEndpoint: far,
    apicoreEndpoint: media, autoDiscoverCdnHosts: true, fetchImpl: transport(controller.signal, async (url, options) => {
      calls.push(url)
      if (options.method === 'POST') return metadata('mockup-id')
      response = new Response('redirect-body', { status: 302, headers: { location: `https://${cdn}/image` } })
      controller.abort()
      return response
    }) })
  await assert.rejects(client.getPreviewBytes('photo'), { name: 'AbortError' })
  assert.equal(calls.length, 2)
  assert.equal(response.bodyUsed, true)
})

for (const scenario of ['afp-recovers', 'afp-remains-unauthenticated', 'cdn-rejects']) {
  test(`media authentication recovery is limited to one trusted AFP replay (${scenario})`, async () => {
    const config = resolveConfig({ readRetries: 0 })
    const refs = { AFP_ACCESS_TOKEN: 'fixture-token', AFP_USERNAME: 'fixture-user', AFP_PASSWORD: 'fixture-password' }
    let record = { kind: 'grant', payload: { fingerprint: digest(JSON.stringify([
      refs.AFP_ACCESS_TOKEN, refs.AFP_USERNAME, refs.AFP_PASSWORD, config.loginEndpoint,
    ])), token: 'fixture-token', refreshToken: 'fixture-refresh', generation: 0 } }
    const credentials = {
      resolve: async key => refs[key] ? { value: refs[key] } : undefined,
      readRecord: async () => structuredClone(record),
      async modifyRecord(_key, update) { record = await update(structuredClone(record)) ?? record; return record },
    }
    let refreshes = 0, mediaReads = 0
    const connection = new Connection(credentials, config, async (_url, options) => {
      if (options.method === 'POST') {
        const body = JSON.parse(options.body)
        if (body.operationName === 'refreshToken') {
          refreshes++
          return Response.json({ data: { token: { access: 'renewed-token', refresh: 'renewed-refresh' } } })
        }
        if (body.operationName === 'getPhotos') return Response.json({ data: { photos: { docs: [{ id: 'probe' }], hasMore: false } } })
        return metadata(scenario === 'cdn-rejects' ? `https://${cdn}/image` : 'mockup-id')
      }
      mediaReads++
      if (scenario === 'cdn-rejects') assert.equal(options.headers.authorization, undefined)
      if (scenario === 'afp-recovers' && options.headers.authorization === 'Bearer renewed-token') return image()
      return new Response('private-upstream-detail', { status: 401 })
    })
    const { previewClient } = await connection.open(new AbortController().signal, false, false, true)
    if (scenario === 'afp-recovers') assert.deepEqual((await previewClient.getPreviewBytes('photo')).bytes, jpeg)
    else await assert.rejects(previewClient.getPreviewBytes('photo'), error => {
      assert.doesNotMatch(error.message, /private-upstream-detail/)
      return true
    })
    assert.equal(refreshes, scenario === 'cdn-rejects' ? 0 : 1)
    assert.equal(mediaReads, scenario === 'cdn-rejects' ? 1 : 2)
  })
}
