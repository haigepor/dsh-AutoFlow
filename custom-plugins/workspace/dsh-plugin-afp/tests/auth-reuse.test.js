import test from 'node:test'
import assert from 'node:assert/strict'
import { Connection } from '../src/host/afp-credentials.js'
import { resolveConfig } from '../config-schema.js'
import { digest } from '../src/host/afp-state-store.js'

const signal = () => new AbortController().signal
const photos = () => Response.json({ data: { photos: { docs: [{ id: 'photo' }], hasMore: false } } })
const search = { operationName: 'getPhotos', query: 'query getPhotos { photos { hasMore } }', variables: { input: { query: 'cat', maxRows: 1 } } }
const nextTurn = () => new Promise(resolve => setImmediate(resolve))

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function fixture({ ttl = 60000, overrides = {}, fetchImpl = async () => photos() } = {}) {
  const config = resolveConfig({ readRetries: 0, ...overrides, tokenValidationTtlMs: ttl })
  const refs = { AFP_ACCESS_TOKEN: 'reference-token', AFP_USERNAME: 'fixture-user', AFP_PASSWORD: 'fixture-password' }
  const fingerprint = digest(JSON.stringify([refs.AFP_ACCESS_TOKEN, refs.AFP_USERNAME, refs.AFP_PASSWORD, config.loginEndpoint]))
  let record = { kind: 'grant', payload: { fingerprint, token: 'cached-token', refreshToken: 'cached-refresh', verifiedAt: 1, generation: 0 } }
  let lock = Promise.resolve(), writes = 0
  const credentials = {
    resolve: async key => refs[key] ? { value: refs[key] } : undefined,
    describe: async key => ({ configured: Boolean(refs[key]) }),
    readRecord: async () => structuredClone(record),
    modifyRecord(_key, update) {
      const task = lock.then(async () => {
        const next = await update(structuredClone(record))
        // 与 credentials-local 一致：undefined 保留原记录，也不提交磁盘写入。
        if (next !== undefined) { record = structuredClone(next); writes++ }
        return structuredClone(record)
      })
      lock = task.catch(() => {})
      return task
    },
  }
  return { connection: new Connection(credentials, config, fetchImpl), refs,
    grant: () => structuredClone(record.payload), writes: () => writes,
    changeGrant: update => { record = { ...record, payload: { ...record.payload, ...update } } } }
}

test('token validation reuse has a configurable bounded TTL and zero disables reuse', () => {
  assert.equal(resolveConfig().tokenValidationTtlMs, 60000)
  assert.equal(resolveConfig({ tokenValidationTtlMs: 0 }).tokenValidationTtlMs, 0)
  for (const value of [-1, 1.5, '60000', 3600001]) assert.throws(() => resolveConfig({ tokenValidationTtlMs: value }), /tokenValidationTtlMs/)
})

test('parallel and subsequent opens share one verified grant without rewriting unchanged credentials', async () => {
  const entered = deferred(), release = deferred()
  let probes = 0
  const f = fixture({ fetchImpl: async () => { probes++; entered.resolve(); await release.promise; return photos() } })
  const opened = [f.connection.open(signal())]
  await entered.promise
  opened.push(f.connection.open(signal()), f.connection.open(signal()), f.connection.open(signal()))
  release.resolve()
  const results = await Promise.all(opened)
  await f.connection.open(signal())
  assert.equal(results.length, 4)
  assert.equal(new Set(results.map(result => result.account)).size, 1)
  assert.equal(probes, 1)
  assert.equal(f.writes(), 1)
})

test('an expired validation window causes a new probe while reads inside the window reuse it', async t => {
  let now = 1000000, probes = 0
  t.mock.method(Date, 'now', () => now)
  const f = fixture({ fetchImpl: async () => { probes++; return photos() } })
  await f.connection.open(signal())
  now += 59999
  await f.connection.open(signal())
  assert.equal(probes, 1)
  now++
  await f.connection.open(signal())
  assert.equal(probes, 2)
  assert.equal(f.writes(), 2)
})

test('a zero validation TTL preserves a fresh probe for every sequential open', async () => {
  let probes = 0
  const f = fixture({ ttl: 0, fetchImpl: async () => { probes++; return photos() } })
  await f.connection.open(signal())
  await f.connection.open(signal())
  await f.connection.open(signal())
  assert.equal(probes, 3)
})

test('a zero validation TTL still coalesces authentication already in flight', async () => {
  const entered = deferred(), release = deferred()
  let probes = 0
  const f = fixture({ ttl: 0, fetchImpl: async () => { probes++; entered.resolve(); await release.promise; return photos() } })
  const first = f.connection.open(signal())
  await entered.promise
  const second = f.connection.open(signal())
  await nextTurn()
  release.resolve()
  await Promise.all([first, second])
  assert.equal(probes, 1)
})

test('persisted verification timestamps do not bypass the first probe of a new Connection', async () => {
  let probes = 0
  const f = fixture({ fetchImpl: async () => { probes++; return photos() } })
  f.changeGrant({ verifiedAt: Date.now() + 1000000 })
  await f.connection.open(signal())
  assert.equal(probes, 1)
})

test('changing a credential reference value invalidates the previous verification', async () => {
  const seen = []
  const f = fixture({ fetchImpl: async (_url, options) => { seen.push(options.headers.authorization); return photos() } })
  await f.connection.open(signal())
  f.refs.AFP_ACCESS_TOKEN = 'replacement-reference-token'
  await f.connection.open(signal())
  assert.deepEqual(seen, ['Bearer cached-token', 'Bearer replacement-reference-token'])
})

for (const update of [{ token: 'externally-rotated-token' }, { generation: 1 }]) {
  test(`an external grant ${Object.keys(update)[0]} change invalidates verification`, async () => {
    let probes = 0
    const f = fixture({ fetchImpl: async () => { probes++; return photos() } })
    await f.connection.open(signal())
    f.changeGrant(update)
    await f.connection.open(signal())
    assert.equal(probes, 2)
  })
}

test('a cached validation never extends a JWT beyond its configured refresh margin', async t => {
  let now = 1000000, refreshes = 0
  t.mock.method(Date, 'now', () => now)
  const jwt = `header.${Buffer.from(JSON.stringify({ exp: (now + 90000) / 1000 })).toString('base64url')}.signature`
  const f = fixture({ ttl: 120000, overrides: { tokenRefreshMarginSeconds: 30 }, fetchImpl: async (_url, options) => {
    if (JSON.parse(options.body).operationName === 'refreshToken') {
      refreshes++
      return Response.json({ data: { token: { access: 'renewed-token', refresh: 'renewed-refresh' } } })
    }
    return photos()
  } })
  f.changeGrant({ token: jwt })
  await f.connection.open(signal())
  now += 60001
  await f.connection.open(signal())
  assert.equal(refreshes, 1)
  assert.equal(f.grant().token, 'renewed-token')
})

test('an authenticated read rejected after cached validation renews once and replays once', async () => {
  let probes = 0, refreshes = 0, searches = 0
  const f = fixture({ fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body)
    if (body.operationName === 'refreshToken') {
      refreshes++
      return Response.json({ data: { token: { access: 'renewed-token', refresh: 'renewed-refresh' } } })
    }
    if (!body.variables.input.query) { probes++; return photos() }
    searches++
    return options.headers.authorization === 'Bearer cached-token' ? new Response('', { status: 401 }) : photos()
  } })
  await f.connection.open(signal())
  const { client } = await f.connection.open(signal())
  assert.equal((await client.searchPhotos(search)).docs[0].id, 'photo')
  await f.connection.open(signal())
  assert.equal(searches, 2)
  assert.equal(refreshes, 1)
  assert.equal(probes, 2)
  assert.equal(f.grant().token, 'renewed-token')
})

test('candidate membership reads renew a rejected grant once before returning a complete response', async () => {
  let refreshes = 0, reads = 0
  const f = fixture({ fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body)
    if (body.operationName === 'refreshToken') {
      refreshes++
      return Response.json({ data: { token: { access: 'renewed-token', refresh: 'renewed-refresh' } } })
    }
    if (body.operationName !== 'membership') return photos()
    reads++
    return options.headers.authorization === 'Bearer cached-token' ? new Response('', { status: 401 })
      : Response.json({ data: { docs: [{ id: 'photo', selections: [] }] } })
  } })
  const { client } = await f.connection.open(signal())
  assert.deepEqual(await client.photoSelectionsByIds(['photo']), [{ id: 'photo', selections: [] }])
  assert.equal(reads, 2); assert.equal(refreshes, 1)
})

test('adopting an external grant during recovery does not treat its persisted verification as local evidence', async () => {
  let probes = 0
  const f = fixture({ fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body)
    if (!body.variables.input.query) { probes++; return photos() }
    return options.headers.authorization === 'Bearer cached-token' ? new Response('', { status: 401 }) : photos()
  } })
  const { client } = await f.connection.open(signal())
  f.changeGrant({ token: 'external-token', generation: 1, verifiedAt: Date.now() })
  assert.equal((await client.searchPhotos(search)).docs[0].id, 'photo')
  await f.connection.open(signal())
  assert.equal(probes, 2)
})

test('a normal open during renewal does not continue using a token already rejected by AFP', async () => {
  const entered = deferred(), release = deferred()
  let rejectedSearches = 0, refreshes = 0
  const f = fixture({ fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body)
    if (body.operationName === 'refreshToken') {
      refreshes++; entered.resolve(); await release.promise
      return Response.json({ data: { token: { access: 'renewed-token', refresh: 'renewed-refresh' } } })
    }
    if (body.variables.input.query && options.headers.authorization === 'Bearer cached-token') {
      rejectedSearches++
      return new Response('', { status: 401 })
    }
    return photos()
  } })
  const original = await f.connection.open(signal())
  const recovery = original.client.searchPhotos(search)
  await entered.promise
  const opening = f.connection.open(signal())
  await nextTurn()
  release.resolve()
  await recovery
  const next = await opening
  assert.equal((await next.client.searchPhotos(search)).docs[0].id, 'photo')
  assert.equal(rejectedSearches, 1)
  assert.equal(refreshes, 1)
})

test('cached validation does not renew or replay an AFP collection mutation', async () => {
  let probes = 0, writes = 0, auth = 0
  const f = fixture({ fetchImpl: async (url, options) => {
    if (url.includes('slt-')) { writes++; return new Response('', { status: 401 }) }
    if (JSON.parse(options.body).operationName === 'refreshToken') auth++
    probes++
    return photos()
  } })
  await f.connection.open(signal())
  const { client } = await f.connection.open(signal(), true)
  await assert.rejects(client.addSelectionDoc('collection', { id: 'photo' }))
  assert.equal(probes, 1)
  assert.equal(writes, 1)
  assert.equal(auth, 0)
})

test('cancelling the first waiter does not cancel another waiter sharing authentication', { timeout: 3000 }, async () => {
  const entered = deferred(), release = deferred(), firstController = new AbortController(), secondController = new AbortController()
  let probes = 0
  const f = fixture({ fetchImpl: async (_url, options) => {
    probes++; entered.resolve()
    await new Promise((resolve, reject) => {
      const aborted = () => reject(options.signal.reason)
      options.signal.addEventListener('abort', aborted, { once: true })
      release.promise.then(() => { options.signal.removeEventListener('abort', aborted); resolve() })
    })
    return photos()
  } })
  const first = f.connection.open(firstController.signal)
  const cancelled = assert.rejects(first, { name: 'AbortError' })
  await entered.promise
  const second = f.connection.open(secondController.signal)
  try {
    // 让第二个 open 的凭据读取和订阅准入完成；网络请求仍由显式 gate 阻塞。
    await nextTurn()
    firstController.abort()
    release.resolve()
    await cancelled
    assert.ok((await second).client)
    assert.equal(probes, 1)
    assert.equal(f.writes(), 1)
  } finally { firstController.abort(); secondController.abort(); release.resolve(); await Promise.allSettled([first, second]) }
})

test('cancelling every authentication waiter leaves the stored grant unchanged', { timeout: 3000 }, async () => {
  const entered = deferred(), release = deferred(), firstController = new AbortController(), secondController = new AbortController()
  const f = fixture({ fetchImpl: async (_url, options) => {
    entered.resolve()
    await new Promise((resolve, reject) => {
      const aborted = () => reject(options.signal.reason)
      options.signal.addEventListener('abort', aborted, { once: true })
      release.promise.then(() => { options.signal.removeEventListener('abort', aborted); resolve() })
    })
    return photos()
  } })
  const previous = f.grant(), first = f.connection.open(firstController.signal)
  const firstResult = assert.rejects(first, { name: 'AbortError' })
  await entered.promise
  const second = f.connection.open(secondController.signal), secondResult = assert.rejects(second, { name: 'AbortError' })
  try {
    await nextTurn()
    firstController.abort(); secondController.abort(); release.resolve()
    await Promise.all([firstResult, secondResult])
    await nextTurn()
    assert.equal(f.writes(), 0)
    assert.deepEqual(f.grant(), previous)
    assert.ok((await f.connection.open(signal())).client)
    assert.equal(f.writes(), 1)
  } finally { firstController.abort(); secondController.abort(); release.resolve(); await Promise.allSettled([first, second]) }
})
