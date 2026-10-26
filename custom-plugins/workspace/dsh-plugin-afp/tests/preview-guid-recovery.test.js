import test from 'node:test'
import assert from 'node:assert/strict'
import { createAfpPreviewClient } from '../src/vendor/auto-afp-img/afp-preview-client.mjs'
import { Connection } from '../src/host/afp-credentials.js'
import { WorkbenchData } from '../src/host/afp-workbench-data.js'
import { previewSource } from '../src/client/afp-preview-media.js'
import { conversationPhotoModel } from '../src/client/afp-conversation-photos.js'
import { reviewedImageRows } from '../src/client/afp-conversation-reviewed-images.js'
import { reviewedPhotoResults } from '../src/host/afp-refresh-workflow.js'
import { resolveConfig } from '../config-schema.js'

const uno = 'newsml.afp.com.20190216T000000Z.partners-photo%2520(11)'
const guid = 'afp.com-20190216-partners-photo-guid'
const cdn = 'dpreview123.cloudfront.net'
const jpeg = new Uint8Array([255, 216, 255, 0])
const image = () => new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } })
const photo = (href, overrides = {}) => ({ id: uno, guid, mockup: [{ role: 'Mockup', href }], ...overrides })
const metadata = docs => Response.json({ data: { docs } })

function previewFixture({ lookup, media, retries = 2 }) {
  const queries = [], mediaCalls = []
  const client = createAfpPreviewClient({ accessToken: 'private-fixture', retries, autoDiscoverCdnHosts: true,
    sleep: async () => {}, fetchImpl: async (url, init) => {
      if (init.method === 'POST') {
        const body = JSON.parse(init.body)
        queries.push(body)
        return lookup(body, queries.length)
      }
      mediaCalls.push({ url, headers: init.headers })
      return media ? media(url, mediaCalls.length) : image()
    } })
  return { client, queries, mediaCalls }
}

test('an empty UNO lookup recovers the same photo through its known GUID without decoding its UNO', async () => {
  const f = previewFixture({ lookup: body => body.variables.input.isUno
    ? metadata([]) : metadata([photo(`https://${cdn}/image`)]) })
  const result = await f.client.getPreviewBytes(uno, { guid })
  assert.deepEqual(result.bytes, jpeg)
  assert.deepEqual(f.queries.map(body => body.variables), [
    { ids: [uno], input: { isUno: true } },
    { ids: [guid], input: { isUno: false } },
  ])
  assert.equal(f.mediaCalls.length, 1)
  assert.equal(f.mediaCalls[0].headers.authorization, undefined)
  assert.doesNotMatch(JSON.stringify(result), /private-fixture|cloudfront|Signature/)
})

test('an available UNO preview does not require a second GUID lookup', async () => {
  const f = previewFixture({ lookup: () => metadata([photo(`https://${cdn}/image`)]) })
  assert.deepEqual((await f.client.getPreviewBytes(uno, { guid })).bytes, jpeg)
  assert.equal(f.queries.length, 1)
})

test('an empty UNO result without a GUID remains unavailable without inventing another identity', async () => {
  const f = previewFixture({ lookup: () => metadata([]) })
  await assert.rejects(f.client.getPreviewBytes(uno))
  assert.equal(f.queries.length, 1)
  assert.equal(f.mediaCalls.length, 0)
})

for (const mismatch of [{ id: 'another-uno' }, { guid: 'another-guid' }]) {
  test(`GUID fallback refuses a photo with mismatched ${Object.keys(mismatch)[0]}`, async () => {
    const f = previewFixture({ lookup: body => body.variables.input.isUno ? metadata([])
      : metadata([photo(`https://${cdn}/image`, mismatch)]) })
    await assert.rejects(f.client.getPreviewBytes(uno, { guid }))
    assert.equal(f.queries.length, 2)
    assert.equal(f.mediaCalls.length, 0)
  })
}

for (const code of ['UNAUTHENTICATED', 'FORBIDDEN', 'GRAPHQL_VALIDATION_FAILED']) {
  test(`GUID fallback does not reinterpret ${code} as an empty photo result`, async () => {
    const f = previewFixture({ lookup: () => Response.json({ errors: [{ extensions: { code } }] }) })
    await assert.rejects(f.client.getPreviewBytes(uno, { guid }))
    assert.equal(f.queries.length, 1)
    assert.equal(f.mediaCalls.length, 0)
  })
}

for (const docs of [null, undefined, [photo(`https://${cdn}/image`, { id: 'unrelated' })]]) {
  test(`only an explicit empty list permits GUID fallback (${docs === null ? 'null' : Array.isArray(docs) ? 'unrelated identity' : 'missing list'})`, async () => {
    const f = previewFixture({ lookup: () => metadata(docs) })
    await assert.rejects(f.client.getPreviewBytes(uno, { guid }))
    assert.equal(f.queries.length, 1)
    assert.equal(f.mediaCalls.length, 0)
  })
}

test('Connection preserves a known GUID while reading a preview through its authenticated client', async () => {
  let record
  const credentials = {
    resolve: async key => key === 'AFP_ACCESS_TOKEN' ? { value: 'opaque-fixture-token' } : undefined,
    readRecord: async () => record,
    async modifyRecord(_key, mutate) { const next = await mutate(record); if (next !== undefined) record = next; return record },
  }
  const lookups = []
  const connection = new Connection(credentials, resolveConfig({ readRetries: 0 }), async (_url, init) => {
    if (init.method !== 'POST') return image()
    const body = JSON.parse(init.body)
    if (body.operationName === 'getPhotos') return Response.json({ data: { photos: { docs: [{ id: 'probe' }], hasMore: false } } })
    lookups.push(body.variables)
    return body.variables.input.isUno ? metadata([]) : metadata([photo(`https://${cdn}/image`)])
  })
  const { previewClient } = await connection.open(new AbortController().signal, false, false, true)
  assert.deepEqual((await previewClient.getPreviewBytes(uno, { guid })).bytes, jpeg)
  assert.equal(lookups.length, 2)
  assert.deepEqual(lookups[1], { ids: [guid], input: { isUno: false } })
})

test('the authenticated preview route accepts one GUID hint and keeps the canonical UNO unchanged', async () => {
  const calls = []
  const workbench = new WorkbenchData({ ctx: {}, store: {}, config: resolveConfig(), connection: { open: async () => ({
    previewClient: { async getPreviewBytes(...args) { calls.push(args); return { bytes: jpeg, contentType: 'image/jpeg' } } },
  }) } })
  try {
    const url = new URL('https://profile.test/api/afp/preview')
    url.searchParams.set('photoId', uno); url.searchParams.set('guid', guid)
    const response = await workbench.previewResponse(new Request(url))
    assert.equal(response.status, 200)
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), jpeg)
    assert.deepEqual(calls, [[uno, { guid }]])
    for (const query of ['photoId=p&guid=g&guid=h', 'photoId=p&photoId=q&guid=g', 'photoId=p&guid=',
      'photoId=p&guid=%00', 'photoId=p&guid=%20%20', 'photoId=p&guid=' + 'g'.repeat(257), 'photoId=p&guid=g&url=https://outside.test/']) {
      assert.equal((await workbench.previewResponse(new Request('https://profile.test/api/afp/preview?' + query))).status, 400)
    }
    assert.equal(calls.length, 1)
  } finally { await workbench.dispose() }
})

test('client preview URLs add validated GUID hints without accepting another origin or extra query fields', () => {
  const base = 'https://profile.test/app/', path = 'api/afp/preview?photoId=' + encodeURIComponent(uno)
  const result = new URL(previewSource(path, base, guid))
  assert.equal(result.origin, 'https://profile.test')
  assert.equal(result.searchParams.get('photoId'), uno)
  assert.equal(result.searchParams.get('guid'), guid)
  for (const absent of [undefined, null]) assert.equal(new URL(previewSource(path, base, absent)).searchParams.has('guid'), false)
  for (const invalid of ['', ' ', 42, {}, 'g\u0000', 'g'.repeat(257)]) assert.equal(previewSource(path, base, invalid), null)
  for (const invalidPath of ['https://outside.test/api/afp/preview?photoId=p',
    'api/afp/preview?photoId=p&guid=g&guid=h', 'api/afp/preview?photoId=p&url=https://outside.test/']) {
    assert.equal(previewSource(invalidPath, base, guid), null)
  }
})

test('conversation photo projection retains known GUIDs for authenticated previews in native and legacy results', () => {
  const result = { items: [{ id: uno, guid, title: 'Known photo', previewPath: 'https://outside.test/?Signature=private',
    media: 'https://outside.test/original', token: 'private-fixture' }] }
  for (const block of [{ meta: { afp: { version: 1, result } } }, { content: [{ type: 'text', text: JSON.stringify(result) }] }]) {
    const model = conversationPhotoModel({ phase: 'result', block })
    assert.equal(model.state, 'ok')
    assert.equal(model.photos[0].guid, guid)
    const preview = new URL(previewSource(model.photos[0].previewPath, 'https://profile.test/', model.photos[0].guid))
    assert.equal(preview.searchParams.get('photoId'), uno)
    assert.equal(preview.searchParams.get('guid'), guid)
    assert.doesNotMatch(JSON.stringify(model), /outside|Signature|private-fixture|original/)
  }
})

test('saved review outcomes retain GUIDs through the passed, rejected and incomplete thumbnail projections', () => {
  const candidates = ['passed', 'rejected', 'incomplete'].map((kind, index) => ({ id: `${uno}-${kind}`, guid: `${guid}-${index}`, title: kind }))
  const run = { groups: { animals: { candidates } }, decisions: candidates.map((item, index) => ({ id: item.id,
    category: 'animals', keep: index === 0, reason: index === 2 ? 'preview or vision request failed' : 'visual rule' })) }
  const saved = reviewedPhotoResults(run)
  assert.deepEqual(saved.map(item => item.guid), candidates.map(item => item.guid))
  const rows = reviewedImageRows(saved, ['previewed-only'])
  assert.deepEqual(rows.map(item => item.status), ['passed', 'rejected', 'incomplete', 'unknown'])
  assert.deepEqual(rows.slice(0, 3).map(item => item.guid), candidates.map(item => item.guid))
  for (const row of rows.slice(0, 3)) {
    const preview = new URL(previewSource(row.previewPath, 'https://profile.test/', row.guid))
    assert.equal(preview.searchParams.get('photoId'), row.id)
    assert.equal(preview.searchParams.get('guid'), row.guid)
  }
  assert.equal(Object.hasOwn(rows[3], 'guid'), false)
  const invalid = reviewedImageRows([{ id: 'safe', guid: '\u0000', keep: true }])
  assert.equal(Object.hasOwn(invalid[0], 'guid'), false)
})

const expiredBodies = [
  '<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>',
  '<Error><Code>RequestExpired</Code></Error>',
  '<Error><Code>ExpiredToken</Code></Error>',
]
for (const body of expiredBodies) {
  const label = body.includes('AccessDenied') ? 'AccessDenied expiration message' : body.match(/<Code>(.*?)<\/Code>/)[1]
  test(`an explicit ${label} media response obtains a fresh reference once`, async () => {
    let expiredResponse
    const f = previewFixture({ lookup: (_request, count) => metadata([photo(`https://${cdn}/image?generation=${count}`)]),
      media: (_url, count) => count === 1
        ? (expiredResponse = new Response(body, { status: 403, headers: { 'content-type': 'application/xml' } })) : image() })
    assert.deepEqual((await f.client.getPreviewBytes(uno, { guid })).bytes, jpeg)
    assert.equal(f.queries.length, 2)
    assert.equal(f.mediaCalls.length, 2)
    assert.notEqual(f.mediaCalls[0].url, f.mediaCalls[1].url)
    assert.equal(expiredResponse.bodyUsed, true)
  })
}

test('a second expired media reference stops instead of creating an unbounded refresh loop', async () => {
  const responses = []
  const f = previewFixture({ lookup: (_request, count) => metadata([photo(`https://${cdn}/image?generation=${count}`)]),
    media: () => { const response = new Response(expiredBodies[0], { status: 403 }); responses.push(response); return response } })
  await assert.rejects(f.client.getPreviewBytes(uno, { guid }))
  assert.equal(f.queries.length, 2)
  assert.equal(f.mediaCalls.length, 2)
  assert.equal(responses.every(response => response.bodyUsed), true)
})

for (const status of [403, 404]) {
  test(`ordinary media HTTP ${status} remains a single failure and releases its response body`, async () => {
    const responses = []
    const f = previewFixture({ lookup: () => metadata([photo(`https://${cdn}/image`)]),
      media: () => { const response = new Response('<Error><Code>AccessDenied</Code><Message>Denied</Message></Error>', { status }); responses.push(response); return response } })
    await assert.rejects(f.client.getPreviewBytes(uno, { guid }))
    assert.equal(f.queries.length, 1)
    assert.equal(f.mediaCalls.length, 1)
    assert.equal(responses[0].bodyUsed, true)
  })
}

test('an oversized 403 error body is released without triggering recovery or exposing its content', async () => {
  let response
  const f = previewFixture({ lookup: () => metadata([photo(`https://${cdn}/image`)]),
    media: () => (response = new Response(expiredBodies[0] + 'private-diagnostic'.repeat(400), { status: 403 })) })
  await assert.rejects(f.client.getPreviewBytes(uno, { guid }), error => {
    assert.doesNotMatch(error.message, /private-diagnostic|AccessDenied|Request has expired/)
    return true
  })
  assert.equal(f.queries.length, 1)
  assert.equal(f.mediaCalls.length, 1)
  assert.equal(response.bodyUsed, true)
})
