import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SourceHttpProvider, MediaError } from '../src/media/index.ts'
import type { HttpClient, HttpRequest, HttpResponse, SourceConfig } from '../src/media/index.ts'

const bounds = { maxBytes: 65536, timeoutMs: 5000, maxRedirects: 1 }
const config: SourceConfig = { endpoint: 'https://api.example.test/search', method: 'GET', request: { query: 'q', cursor: 'cursor', pageSize: 'limit', language: 'language', filter: 'filter' }, response: { items: '/data/items', nextCursor: '/data/next', id: '/id', previewUrl: '/preview', originalUrl: '/original', width: '/width', height: '/height' }, maxPageSize: 10 }
const item = { id: 'stable-1', preview: 'https://cdn.example.test/p?signature=short-lived', original: null, width: 80, height: 40 }
const hasCode = (code: string) => (error: unknown) => error instanceof MediaError && error.code === code

class JsonFixture implements HttpClient {
  readonly requests: { url: string; input: HttpRequest }[] = []
  constructor(private readonly responses: unknown[]) {}
  async request(url: string, input: HttpRequest): Promise<HttpResponse> {
    this.requests.push({ url, input })
    assert.ok(this.responses.length > 0, 'unexpected additional external request')
    return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, bytes: Buffer.from(JSON.stringify(this.responses.shift())) }
  }
}

test('omits initial cursor and uses real returned cursor with fixed query/language/filter', async () => {
  const fixture = new JsonFixture([{ data: { items: [item], next: 'cursor-2' } }, { data: { items: [], next: null } }])
  const source = new SourceHttpProvider(config, fixture, { authorization: 'Bearer api-only' })
  const query = { query: 'quiet landscape', pageSize: 5, language: 'zh', filter: 'photo' }
  const first = await source.search(query, null, bounds)
  const second = await source.search(query, first.nextCursor, { ...bounds, seenCursors: ['cursor-2'] })
  assert.equal(first.items[0]?.providerAssetId, 'stable-1')
  assert.equal(first.items[0]?.originalUrl, undefined)
  assert.equal(second.nextCursor, null)
  assert.equal(new URL(fixture.requests[0]?.url ?? '').searchParams.has('cursor'), false)
  const next = new URL(fixture.requests[1]?.url ?? '')
  assert.equal(next.searchParams.get('cursor'), 'cursor-2')
  assert.equal(next.searchParams.get('q'), query.query)
  assert.equal(next.searchParams.get('language'), query.language)
  assert.equal(next.searchParams.get('filter'), query.filter)
  assert.equal(fixture.requests[0]?.input.headers?.authorization, 'Bearer api-only')
})

test('POST request mappings and escaped JSON Pointers are data-only', async () => {
  const fixture = new JsonFixture([{ 'data/list': { '~items': [{ identifier: 'stable-2', image: 'https://cdn.example.test/2' }], next: null } }])
  const source = new SourceHttpProvider({ ...config, method: 'POST', response: { items: '/data~1list/~0items', nextCursor: '/data~1list/next', id: '/identifier', previewUrl: '/image' } }, fixture)
  await source.search({ query: 'cats', pageSize: 2 }, null, bounds)
  assert.deepEqual(JSON.parse(Buffer.from(fixture.requests[0]?.input.body ?? []).toString('utf8')), { q: 'cats', limit: 2 })
  assert.throws(() => new SourceHttpProvider({ ...config, request: { ...config.request, query: '(()=>evil())' } }, fixture), hasCode('invalid-input'))
  assert.throws(() => new SourceHttpProvider({ ...config, response: { ...config.response, items: '/invalid~3' } }, fixture), hasCode('invalid-input'))
})

test('rejects malformed fields, missing stable identity, overflowing pages and looping cursors', async () => {
  for (const data of [
    { next: null }, { items: [{ preview: 'https://cdn.example.test/1' }], next: null },
    { items: [item], next: '' }, { items: [item], next: 'seen-before' },
    { items: [{ ...item, preview: 'http://127.0.0.1/private' }], next: null },
    { items: [item, { ...item, id: 'two' }], next: null },
  ]) {
    const fixture = new JsonFixture([{ data }])
    const source = new SourceHttpProvider(config, fixture)
    await assert.rejects(source.search({ query: 'cat', pageSize: 1 }, null, { ...bounds, seenCursors: ['seen-before'] }), hasCode('source-protocol-error'))
    assert.equal(fixture.requests.length, 1)
  }
})

test('refreshes media only by matching stable ID and never restarts unsupported continuation', async () => {
  const fixture = new JsonFixture([{ id: 'stable-1', preview: 'https://cdn.example.test/new?token=ephemeral' }])
  const source = new SourceHttpProvider({ ...config, lookup: { endpoint: 'https://api.example.test/lookup', method: 'POST', idField: 'id', response: { id: '/id', previewUrl: '/preview' } } }, fixture)
  assert.equal((await source.lookup('stable-1', bounds)).providerAssetId, 'stable-1')
  assert.deepEqual(JSON.parse(Buffer.from(fixture.requests[0]?.input.body ?? []).toString('utf8')), { id: 'stable-1' })
  const unsupported = new SourceHttpProvider(config, fixture)
  await assert.rejects(unsupported.lookup('stable-1', bounds), hasCode('media-unavailable'))
  await assert.rejects(unsupported.search({ query: 'cat', pageSize: 1 }, '', bounds), hasCode('source-continuation-invalid'))
  assert.equal(fixture.requests.length, 1)
})
