import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AfpService } from '../src/host/afp-service.js'
import { registerAgentTools } from '../src/host/afp-agent-tools.js'
import { resolveConfig } from '../config-schema.js'

async function fixture(t, overrides = {}) {
  const home = await mkdtemp(join(tmpdir(), 'afp-agent-reads-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const config = resolveConfig({ pageSize: 2, ...overrides }), calls = { opens: 0, search: [], writes: 0 }
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
  const sessions = new Map()
  const service = new AfpService({ profileContext: { home, dir: join(home, 'profile') }, get: () => sessions }, config, { connection })
  const disable = await service.enable('read')
  t.after(() => service.dispose())
  const tools = new Map(), disposers = []
  registerAgentTools({ effect(fn) { disposers.push(fn()) }, tools: { register(spec) {
    tools.set(spec.name, spec); return () => tools.delete(spec.name)
  } } }, service, 'read')
  const events = [{ seq: 0, type: 'turn/start', data: { turn: 1 } }]
  const session = { id: 'test-session', snapshotEvents: () => events }
  sessions.set(session.id, session)
  const exec = { agent: { id: session.id, session }, signal: new AbortController().signal }
  let serial = 0
  const invoke = async (name, args = {}, context = exec) => {
    assert.ok(tools.has(name), `Missing tool ${name}`)
    const callId = `call-${++serial}`, call = { ...context, callId, name, arguments: args }
    const log = context.agent?.session?.snapshotEvents()
    const turn = log?.findLast(event => event.type === 'turn/start')?.data.turn
    const append = event => log?.push({ seq: (log.at(-1)?.seq ?? -1) + 1, ...event })
    if (call.rootCallId) append({ type: 'tool/call', data: { turn, callId: call.rootCallId, name: 'run_code' } })
    else append({ type: 'tool/call', data: { turn, callId, name, arguments: args } })
    try {
      const value = await tools.get(name).execute(args, call)
      const content = [{ type: 'text', text: value }]
      if (call.rootCallId) append({ type: 'tool/ptc-dispatch', data: { rootCallId: call.rootCallId, subCallId: callId, name, content } })
      else append({ type: 'tool/result', data: { turn, message: { toolCallId: callId, content }, meta: tools.get(name).output.presentationMeta(args, value) } })
      return JSON.parse(value)
    } catch (error) {
      if (log) append({ type: 'tool/result', data: { turn, message: { toolCallId: callId, isError: true, content: [{ type: 'text', text: error.message }] } } })
      throw error
    }
  }
  return { service, client, connection, calls, tools, exec, events, sessions, invoke, disable, disposeTools: () => disposers.forEach(dispose => dispose()) }
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
  assert.equal(first.items[0].previewPath, 'api/afp/preview?photoId=p1')
  assert.doesNotMatch(JSON.stringify(first), /signed\.example|secret|mockup|accessToken/)
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
  assert.equal(first.items[0].previewPath, 'api/afp/preview?photoId=p1')
  assert.doesNotMatch(JSON.stringify(first), /signed\.example|secret/)
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
  assert.equal(tools.size, 14)
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
  assert.equal(details.photo.previewPath, 'api/afp/preview?photoId=p1')
  assert.deepEqual((await invoke('afp_photo_details', { photoId: 'missing' })).photo, null)
  assert.equal((await invoke('afp_photo_details', { photoId: 'missing' })).found, false)
  const list = await invoke('afp_collection_list')
  assert.equal(list.items[0].id, 'shared'); assert.equal(list.items[0].writable, false)
  const first = await invoke('afp_collection_items', { collectionId: 'shared', limit: 2 })
  const second = await invoke('afp_collection_items', { collectionId: 'shared', limit: 2, offset: first.collectionNextOffset })
  assert.equal(first.total, 3); assert.equal(first.collectionNextOffset, 2)
  assert.deepEqual(first.items.map(item => item.id), ['p1', 'p2'])
  assert.deepEqual(first.items.map(item => item.previewPath), ['api/afp/preview?photoId=p1', 'api/afp/preview?photoId=p2'])
  assert.deepEqual(second.items.map(item => item.id), ['p3']); assert.equal(second.collectionNextOffset, null)
  assert.equal(second.hasMore, false); assert.equal(calls.writes, 0)
})

test('preview links encode opaque IDs and never expose upstream media fields', async t => {
  const { invoke, client } = await fixture(t)
  client.photosByIds = async ids => ids.map(id => ({ id, title: 'Photo', previewPath: 'https://signed.example/?token=secret',
    accessToken: 'secret', mockup: [{ href: 'https://signed.example/?token=secret' }] }))
  const result = await invoke('afp_photo_details', { photoId: 'photo/1?x=y&z#fragment' })
  assert.equal(result.photo.previewPath, 'api/afp/preview?photoId=photo%2F1%3Fx%3Dy%26z%23fragment')
  assert.doesNotMatch(JSON.stringify(result), /signed\.example|secret|mockup|accessToken/)
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
    ['afp_report', {}], ['afp_report', { kind: 'run', id: 'not-an-id' }],
  ]) {
    const error = await errorOf(invoke, name, args)
    assert.equal(error.code, 'invalid-arguments'); assert.equal(error.stage, 'validation')
    assert.equal(error.retryable, false); assert.ok(error.durationMs >= 0)
  }
  assert.equal(calls.opens, 0)
  const conflict = await errorOf(invoke, 'afp_report', { runId: '00000000-0000-0000-0000-000000000001', planId: '00000000-0000-0000-0000-000000000002' })
  assert.equal(conflict.code, 'report-parameters-conflict'); assert.equal(conflict.retryable, false)
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
    ['getPhotos returned GraphQL errors: upstream secret https://signed.example/?token=secret', 'upstream-error', false],
    ['secret-password https://signed.example/?token=secret', 'operation-failed', false],
  ]) {
    connection.open = async () => { throw new Error(message) }
    const error = await errorOf(invoke, 'afp_photo_search', { query: `cat-${code}` })
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

test('final selection reads only logged current-turn photos, preserves ordering and makes no new AFP request', async t => {
  const { invoke, exec, calls, events } = await fixture(t)
  events.push({ seq: 1, type: 'tool/call', data: { turn: 1, callId: 'old', name: 'afp_photo_search_start' } },
    { seq: 2, type: 'tool/result', data: { turn: 1, message: { toolCallId: 'old', content: [{ type: 'text', text: JSON.stringify({ items: [{ id: 'old-photo' }] }) }] } } },
    { seq: 3, type: 'turn/start', data: { turn: 2 } })
  const first = await invoke('afp_photo_search_start', { query: 'cat', language: 'en', limit: 2 })
  await invoke('afp_photo_search', { query: 'cat', cursor: first.cursor, limit: 2 }, { ...exec, rootCallId: 'ptc' })
  events.push({ seq: events.length, type: 'tool/ptc-dispatch', data: { rootCallId: 'old', name: 'afp_photo_search', content: [{ type: 'text', text: JSON.stringify({ items: [{ id: 'foreign' }] }) }] } },
    { seq: events.length + 1, type: 'tool/ptc-dispatch', data: { rootCallId: 'ptc', name: 'afp_photo_search', isError: true, content: [{ type: 'text', text: JSON.stringify({ items: [{ id: 'failed' }] }) }] } })
  const opens = calls.opens
  const metadata = { basis: 'metadata', runId: null }
  const selected = await invoke('afp_photo_selection', { photoIds: ['p2', 'p1'], criteria: 'Cat metadata', ...metadata })
  assert.deepEqual(selected.items.map(photo => photo.id), ['p2', 'p1'])
  assert.equal(selected.selection.basis, 'metadata'); assert.ok(selected.meta.durationMs >= 0)
  assert.doesNotMatch(JSON.stringify(selected), /secret|signed\.example/)
  const deduped = await invoke('afp_photo_selection', { photoIds: ['p1', 'p1'], criteria: 'Cat', ...metadata })
  assert.equal(deduped.items.length, 1)
  for (const id of ['old-photo', 'foreign', 'failed', 'invented']) {
    const error = await errorOf(invoke, 'afp_photo_selection', { photoIds: [id], criteria: 'Cat', ...metadata })
    assert.equal(error.code, 'selection-missing-photos'); assert.equal(error.retryable, false)
  }
  assert.equal((await invoke('afp_photo_selection', { photoIds: [], criteria: 'No suitable image', ...metadata })).items.length, 0)
  assert.equal(calls.opens, opens); assert.equal(calls.writes, 0)
})

test('visual final selection requires a report read in this turn and actual kept decisions', async t => {
  const { invoke, service, calls } = await fixture(t)
  const run = await service.store.createRun(['animals'], service.config)
  run.groups.animals = { candidates: [{ id: 'kept', title: 'Cat' }, { id: 'rejected', title: 'Cat' }], batches: 1 }
  run.decisions = [{ id: 'kept', category: 'animals', keep: true }, { id: 'rejected', category: 'animals', keep: false }]
  await service.store.saveRun(run)
  const args = { photoIds: ['kept'], criteria: 'Animals', basis: 'visual', runId: run.id }
  assert.equal((await errorOf(invoke, 'afp_photo_selection', args)).code, 'selection-report-missing')
  await invoke('afp_report', { kind: 'run', id: run.id })
  const selected = await invoke('afp_photo_selection', args)
  assert.equal(selected.selection.basis, 'visual'); assert.equal(selected.items[0].id, 'kept')
  assert.equal((await errorOf(invoke, 'afp_photo_selection', { ...args, photoIds: ['rejected'] })).code, 'selection-visual-rejected')
  assert.equal(calls.opens, 0); assert.equal(calls.writes, 0)
})

test('large native and nested results retain complete scoped evidence while local pages stay bounded', async t => {
  const { invoke, client, service, calls, exec, events, sessions } = await fixture(t, { pageSize: 10, agentResultMaxBytes: 4096 })
  client.searchPhotos = async () => ({ docs: Array.from({ length: 10 }, (_, index) => ({ id: `large-${index}`, title: `Photo ${index}`,
    caption: 'Landscape '.repeat(500), provider: 'AFP', mockup: [{ href: 'https://signed.example/?token=secret' }] })), hasMore: false })
  for (const context of [exec, { ...exec, rootCallId: 'large-ptc' }]) {
    const first = await invoke('afp_photo_search_start', { query: 'landscape', language: 'en', limit: 10 }, context)
    assert.ok(Buffer.byteLength(JSON.stringify(first)) <= service.config.agentResultMaxBytes)
    assert.ok(first.items.length < 10); assert.equal(first.totalItems, 10); assert.ok(first.nextOffset > 0)
    const full = await service.conversationData('conversation-result', { sessionId: exec.agent.id, turn: 1, resultRef: first.resultRef })
    assert.equal(full.items.length, 10)
    assert.equal(full.items.at(-1).caption, 'Landscape '.repeat(500))
    assert.doesNotMatch(JSON.stringify(full), /signed\.example|secret|mockup/)
    const opens = calls.opens
    const page = await invoke('afp_result_page', { resultRef: first.resultRef, offset: first.nextOffset, limit: 10 })
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= service.config.agentResultMaxBytes)
    assert.equal(page.items[0].id, `large-${first.nextOffset}`)
    assert.equal(page.nextOffset, null); assert.equal(calls.opens, opens)
    const selected = await invoke('afp_photo_selection', { photoIds: ['large-9'], criteria: 'Landscape metadata', basis: 'metadata', runId: null })
    assert.equal(selected.items[0].id, 'large-9'); assert.equal(calls.opens, opens)
    const foreign = { ...exec, agent: { id: 'foreign-session', session: { id: 'foreign-session', snapshotEvents: () => events } } }
    sessions.set(foreign.agent.id, foreign.agent.session)
    const error = await errorOf(invoke, 'afp_result_page', { resultRef: first.resultRef, offset: 0, limit: 10 }, foreign)
    assert.equal(error.code, 'selection-unverified')
  }
  const prior = events.find(event => event.type === 'tool/result' && event.data.meta?.afp?.result.resultRef)?.data.meta.afp.result.resultRef
  events.push({ seq: events.length, type: 'turn/start', data: { turn: 2 } })
  const stale = await errorOf(invoke, 'afp_result_page', { resultRef: prior, offset: 0, limit: 10 })
  assert.equal(stale.code, 'selection-unverified'); assert.equal(calls.writes, 0)
})

test('unchanged non-retryable reads do not run twice and new successful evidence permits selection recovery', async t => {
  const { invoke, client, calls } = await fixture(t)
  let attempts = 0
  client.searchPhotos = async () => { attempts++; throw new Error('getPhotos failed with HTTP 403') }
  const first = await errorOf(invoke, 'afp_photo_search', { query: 'cat' })
  const repeated = await errorOf(invoke, 'afp_photo_search', { query: 'cat' })
  assert.equal(first.code, 'access-denied'); assert.equal(repeated.code, 'access-denied'); assert.equal(repeated.repeated, true)
  assert.equal(attempts, 1)
  await errorOf(invoke, 'afp_photo_search', { query: 'dog' }); assert.equal(attempts, 2)
  const selection = { photoIds: ['p3'], criteria: 'Cat metadata', basis: 'metadata', runId: null }
  assert.equal((await errorOf(invoke, 'afp_photo_selection', selection)).code, 'selection-missing-photos')
  assert.equal((await errorOf(invoke, 'afp_photo_selection', selection)).repeated, true)
  await invoke('afp_photo_details', { photoId: 'p3' })
  const selected = await invoke('afp_photo_selection', selection)
  assert.deepEqual(selected.items.map(photo => photo.id), ['p3']); assert.equal(calls.writes, 0)
})
