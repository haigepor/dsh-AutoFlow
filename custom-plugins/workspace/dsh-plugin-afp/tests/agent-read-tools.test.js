import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AfpService } from '../src/host/afp-service.js'
import { registerAgentTools } from '../src/host/afp-agent-tools.js'
import { resolveConfig } from '../config-schema.js'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'afp-agent-reads-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const config = resolveConfig({ pageSize: 2 }), calls = { opens: 0, search: [], writes: 0 }
  const photo = id => ({ id, title: `Photo ${id}`, caption: 'A cat', guid: `guid-${id}`, provider: 'AFP',
    mockup: [{ href: 'https://signed.example/?token=secret' }], accessToken: 'secret' })
  const client = {
    async searchPhotos(request) {
      calls.search.push(request.variables.input)
      return request.variables.input.cursor ? { docs: [photo('p2')], cursor: 'end', hasMore: false }
        : { docs: [photo('p1')], cursor: 'next', hasMore: true }
    },
    async photosByIds(ids) { return ids.filter(id => id !== 'missing').map(photo) },
    async listSelections() { return [{ id: 'shared', name: 'Shared', isPrivate: false }] },
    async getSelection() { return { docs: ['p1', 'p2', 'p3'] } },
    async buyPhoto() { calls.writes++; throw new Error('Unexpected purchase') },
    async addSelectionDocs() { calls.writes++; throw new Error('Unexpected write') },
  }
  const connection = { async open(signal) { calls.opens++; signal.throwIfAborted(); return { client } } }
  const service = new AfpService({ profileContext: { home, dir: join(home, 'profile') } }, config, { connection })
  const disable = await service.enable('read')
  t.after(() => service.dispose())
  const tools = new Map(), disposers = []
  registerAgentTools({ effect(fn) { disposers.push(fn()) }, tools: { register(spec) {
    tools.set(spec.name, spec); return () => tools.delete(spec.name)
  } } }, service, 'read')
  const exec = { agent: { id: 'test-session' }, signal: new AbortController().signal }
  const invoke = async (name, args = {}, context = exec) => {
    assert.ok(tools.has(name), `Missing tool ${name}`)
    return JSON.parse(await tools.get(name).execute(args, context))
  }
  return { service, client, connection, calls, tools, exec, invoke, disable, disposeTools: () => disposers.forEach(dispose => dispose()) }
}

async function errorOf(invoke, name, args, context) {
  try { await invoke(name, args, context) } catch (error) { return JSON.parse(error.message) }
  assert.fail('Expected an AFP tool error')
}

test('Agent searches actual photo pages with language and safe metadata without writes', async t => {
  const { invoke, calls } = await fixture(t)
  const first = await invoke('afp_photo_search', { query: 'cat', language: 'fr', limit: 2 })
  const second = await invoke('afp_photo_search', { query: 'cat', language: 'fr', limit: 2, cursor: first.cursor })
  assert.deepEqual(first.items.map(item => item.id), ['p1'])
  assert.deepEqual(second.items.map(item => item.id), ['p2'])
  assert.equal(first.hasMore, true); assert.equal(second.hasMore, false); assert.equal(second.cursor, null)
  assert.equal(first.meta.language, 'fr'); assert.ok(first.meta.durationMs >= 0)
  assert.equal(calls.search[0].query, 'caption="cat"'); assert.equal(calls.search[1].cursor, 'next')
  assert.equal(calls.search[0].lang, 'fr'); assert.equal(calls.writes, 0)
  assert.doesNotMatch(JSON.stringify(first), /signed\.example|secret|previewPath|mockup|accessToken/)
})

test('explicit first-page tool has no cursor and follows the returned cursor with the existing tool', async t => {
  const { invoke, calls, tools } = await fixture(t)
  const spec = tools.get('afp_photo_search_start')
  assert.ok(spec, 'First-page search must have a cursor-free entry point')
  assert.deepEqual(spec.parameters.required, ['query', 'language', 'limit'])
  assert.equal(Object.hasOwn(spec.parameters.properties, 'cursor'), false)
  const bad = await errorOf(invoke, 'afp_photo_search_start', { query: 'cat', language: 'en', limit: 2, cursor: '?' })
  assert.equal(bad.code, 'invalid-arguments'); assert.equal(calls.opens, 0)
  const first = await invoke('afp_photo_search_start', { query: 'cat', language: 'en', limit: 2 })
  const second = await invoke('afp_photo_search', { query: 'cat', language: 'en', limit: 2, cursor: first.cursor })
  assert.deepEqual(first.items.map(row => row.id), ['p1'])
  assert.deepEqual(second.items.map(row => row.id), ['p2'])
  assert.equal(Object.hasOwn(calls.search[0], 'cursor'), false); assert.equal(calls.search[1].cursor, 'next')
  assert.equal(first.meta.language, 'en'); assert.equal(first.meta.limit, 2); assert.ok(first.meta.durationMs >= 0)
  assert.equal(calls.writes, 0)
  assert.doesNotMatch(JSON.stringify(first), /signed\.example|secret|previewPath/)
})

test('reported question-mark placeholder never reaches AFP even when repeated', async t => {
  const { invoke, calls } = await fixture(t)
  for (let attempt = 0; attempt < 3; attempt++) {
    const error = await errorOf(invoke, 'afp_photo_search', { query: 'cat', language: 'en', limit: 2, cursor: '?' })
    assert.equal(error.code, 'invalid-cursor'); assert.equal(error.retryable, false)
    assert.match(error.action, /afp_photo_search_start/)
  }
  assert.equal(calls.opens, 0); assert.equal(calls.search.length, 0)
})

test('first-page cursor placeholder is rejected with guidance before an AFP read', async t => {
  const { invoke, calls, tools } = await fixture(t)
  const error = await errorOf(invoke, 'afp_photo_search', { query: 'cat', cursor: '0' })
  assert.equal(error.code, 'invalid-cursor'); assert.equal(error.retryable, false)
  assert.match(error.action, /omit cursor/i); assert.equal(calls.opens, 0)
  assert.match(tools.get('afp_photo_search').parameters.properties.cursor.description, /first page.*afp_photo_search_start.*omit/i)
  assert.equal((await invoke('afp_photo_search', { query: 'cat' })).items.length, 1)
})

test('all AFP model-visible tool schemas avoid unsupported regex lookaround', () => {
  const tools = new Map()
  const ctx = { effect(fn) { fn() }, on() { return () => {} }, tools: { register(spec) { tools.set(spec.name, spec); return () => tools.delete(spec.name) } } }
  for (const feature of ['read', 'refresh', 'write']) registerAgentTools(ctx, { config: { pageSize: 60 } }, feature)
  function inspect(value) {
    if (!value || typeof value !== 'object') return
    if (typeof value.pattern === 'string') assert.doesNotMatch(value.pattern, /\(\?(?:[=!]|<[=!])/,
      'Model API schema patterns must not contain lookaround; enforce contextual validation in the Host')
    for (const child of Object.values(value)) inspect(child)
  }
  assert.equal(tools.size, 12)
  for (const tool of tools.values()) inspect(tool.parameters)
})

test('unnamed directory entries are excluded while named shared collections remain readable', async t => {
  const { invoke, client } = await fixture(t)
  let memberReads = 0
  client.listSelections = async () => [{ id: 'SANDBOX#account', isPrivate: false }, { id: 'shared', name: 'Shared', isPrivate: false }]
  client.getSelection = async () => { memberReads++; return { docs: ['p1'] } }
  const list = await invoke('afp_collection_list')
  assert.deepEqual(list.items.map(row => row.id), ['shared'])
  assert.equal(list.meta.excludedUnnamedCount, 1)
  const error = await errorOf(invoke, 'afp_collection_items', { collectionId: 'SANDBOX#account' })
  assert.equal(error.code, 'collection-unavailable'); assert.equal(memberReads, 0)
  assert.equal((await invoke('afp_collection_items', { collectionId: 'shared' })).items.length, 1)
})

test('unknown read errors give read advice rather than partial write advice', async t => {
  const { invoke, connection } = await fixture(t)
  connection.open = async () => { throw new Error('upstream secret https://signed.example/?token=secret') }
  const error = await errorOf(invoke, 'afp_photo_search', { query: 'cat' })
  assert.equal(error.stage, 'read'); assert.equal(error.retryable, false)
  assert.doesNotMatch(JSON.stringify(error), /write|partial|afp_report|secret|signed\.example/i)
})

test('Agent reads photo absence, all collections and offset member pages', async t => {
  const { invoke, calls } = await fixture(t)
  const details = await invoke('afp_photo_details', { photoId: 'p1' })
  assert.equal(details.found, true); assert.equal(details.photo.id, 'p1')
  assert.deepEqual((await invoke('afp_photo_details', { photoId: 'missing' })).photo, null)
  assert.equal((await invoke('afp_photo_details', { photoId: 'missing' })).found, false)
  const list = await invoke('afp_collection_list')
  assert.equal(list.items[0].id, 'shared'); assert.equal(list.items[0].writable, false)
  const first = await invoke('afp_collection_items', { collectionId: 'shared', limit: 2 })
  const second = await invoke('afp_collection_items', { collectionId: 'shared', limit: 2, offset: first.nextOffset })
  assert.equal(first.total, 3); assert.equal(first.nextOffset, 2)
  assert.deepEqual(first.items.map(item => item.id), ['p1', 'p2'])
  assert.deepEqual(second.items.map(item => item.id), ['p3']); assert.equal(second.nextOffset, null)
  assert.equal(second.hasMore, false); assert.equal(calls.writes, 0)
})

test('invalid query, paging, language and report arguments are rejected before reads', async t => {
  const { invoke, calls } = await fixture(t)
  for (const [name, args] of [
    ['afp_search_plan', { query: ' ' }], ['afp_photo_search', { query: ' ' }],
    ['afp_photo_search_start', { query: 'cat' }], ['afp_photo_search_start', { query: ' ', language: 'en', limit: 2 }],
    ['afp_photo_search_start', { query: 'cat', language: 'zh', limit: 2 }],
    ['afp_photo_search_start', { query: 'cat', language: 'en', limit: 3 }],
    ['afp_photo_search', { query: 'cat', limit: 3 }], ['afp_photo_search', { query: 'cat', language: 'zh' }],
    ['afp_photo_search', { query: 'cat', cursor: '' }], ['afp_photo_search', { query: 'cat', secret: 'hidden' }],
    ['afp_photo_details', { photoId: '\n' }], ['afp_collection_items', { collectionId: 'shared', offset: -1 }],
    ['afp_report', {}], ['afp_report', { runId: '00000000-0000-0000-0000-000000000001', planId: '00000000-0000-0000-0000-000000000002' }],
  ]) {
    const error = await errorOf(invoke, name, args)
    assert.equal(error.code, 'invalid-arguments'); assert.equal(error.stage, 'validation')
    assert.equal(error.retryable, false); assert.ok(error.durationMs >= 0)
  }
  assert.equal(calls.opens, 0)
})

test('disabled reads and absent Session produce different errors and registrations dispose', async t => {
  const { invoke, exec, calls, disable, disposeTools, tools } = await fixture(t)
  const noSession = await errorOf(invoke, 'afp_photo_search_start', { query: 'cat', language: 'en', limit: 2 }, { signal: exec.signal })
  assert.equal(noSession.code, 'session-required')
  await disable()
  const disabled = await errorOf(invoke, 'afp_photo_search_start', { query: 'cat', language: 'en', limit: 2 })
  assert.equal(disabled.code, 'feature-disabled'); assert.equal(calls.opens, 0)
  disposeTools(); assert.equal(tools.size, 0)
})

test('recognized read errors give safe advice and unknown errors never expose their text', async t => {
  const { invoke, connection } = await fixture(t)
  for (const [message, code, retryable] of [
    ['AFP credentials are missing', 'credentials-missing', false],
    ['AFP getlogin did not return an access token', 'login-failed', false],
    ['AFP token validation failed with HTTP 401', 'authentication-failed', false],
    ['getPhotos failed with HTTP 401', 'authentication-failed', false],
    ['getPhotos failed with HTTP 403', 'access-denied', false],
    ['getPhotos failed with HTTP 429', 'rate-limited', true],
    ['getPhotos failed with HTTP 503', 'upstream-unavailable', true],
    ['getPhotos returned GraphQL errors: upstream secret https://signed.example/?token=secret', 'query-rejected', false],
    ['secret-password https://signed.example/?token=secret', 'operation-failed', false],
  ]) {
    connection.open = async () => { throw new Error(message) }
    const error = await errorOf(invoke, 'afp_photo_search', { query: 'cat' })
    assert.equal(error.code, code); assert.equal(error.retryable, retryable)
    assert.doesNotMatch(JSON.stringify(error), /secret|signed\.example/)
  }
})

test('Session cancellation interrupts Agent reads without publishing an upstream result', async t => {
  const { invoke, exec, client } = await fixture(t), controller = new AbortController()
  let started
  const ready = new Promise(resolve => { started = resolve })
  client.searchPhotos = async () => { started(); await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true })); return { docs: [], hasMore: false } }
  const pending = invoke('afp_photo_search_start', { query: 'cat', language: 'en', limit: 2 }, { ...exec, signal: controller.signal })
  await ready; controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})

test('revoking read access rejects a late Agent page and drains the owned read', async t => {
  const { invoke, client, disable } = await fixture(t)
  let start, finish
  const ready = new Promise(resolve => { start = resolve })
  client.searchPhotos = async () => { start(); return new Promise(resolve => { finish = () => resolve({ docs: [], hasMore: false }) }) }
  const rejected = errorOf(invoke, 'afp_photo_search_start', { query: 'cat', language: 'en', limit: 2 })
  await ready
  const drained = disable(); finish(); await drained
  assert.equal((await rejected).code, 'feature-disabled')
})
