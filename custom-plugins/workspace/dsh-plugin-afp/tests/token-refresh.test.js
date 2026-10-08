import test from 'node:test'
import assert from 'node:assert/strict'
import { Connection } from '../src/host/afp-credentials.js'
import { resolveConfig } from '../config-schema.js'
import { digest } from '../src/host/afp-state-store.js'
import { createAfpApiClient } from '../src/vendor/auto-afp-img/afp-api-client.mjs'
import { agentError } from '../src/host/afp-agent-errors.js'

const request = { operationName: 'getPhotos', query: 'query getPhotos { photos { hasMore } }', variables: { input: { query: 'cat', maxRows: 10 } } }
const invalid = () => Response.json({ errors: [{ message: 'invalid token', extensions: { code: 'not-an-apollo-code' } }], data: { photos: null } })
const photos = () => Response.json({ data: { photos: { docs: [{ id: 'real-photo', title: 'Cat' }], hasMore: false } } })
const forbidden = () => Response.json({ errors: [{ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } }], data: { photos: null } })

function fixture({ refreshToken = 'fixture-refresh', overrides = {}, fetchImpl } = {}) {
  const config = resolveConfig({ readRetries: 0, ...overrides })
  const refs = { AFP_USERNAME: 'fixture-user', AFP_PASSWORD: 'fixture-password' }
  const fingerprint = digest(JSON.stringify(['', refs.AFP_USERNAME, refs.AFP_PASSWORD, config.loginEndpoint]))
  let record = { kind: 'grant', payload: { fingerprint, token: 'old-token', refreshToken, verifiedAt: 1, generation: 0 } }, lock = Promise.resolve()
  const credentials = {
    resolve: async key => refs[key] ? { value: refs[key] } : undefined,
    describe: async key => ({ configured: Boolean(refs[key]) }),
    readRecord: async () => record,
    modifyRecord(_key, update) { const task = lock.then(async () => { record = await update(record) }); lock = task.catch(() => {}); return task },
  }
  return { connection: new Connection(credentials, config, fetchImpl), readGrant: () => record.payload }
}

test('AFP invalid token at HTTP 200 is classified without disclosing the upstream body', async () => {
  const client = createAfpApiClient({ accessToken: 'secret', retries: 0, fetchImpl: async () => invalid() })
  await assert.rejects(client.searchPhotos(request), error => {
    const safe = agentError(error, 'search', 5)
    assert.equal(safe.code, 'authentication-failed')
    assert.deepEqual(safe.upstream, { protocol: 'graphql', httpStatus: 200, category: 'authentication' })
    assert.doesNotMatch(JSON.stringify(safe), /invalid token|not-an-apollo|secret/)
    return true
  })
})

test('opaque cached token accepted by SLT is replaced when FAR rejects it, retaining the rotating refresh grant', async () => {
  let sltCalls = 0, refreshCalls = 0, loginCalls = 0
  const f = fixture({ fetchImpl: async (url, init) => {
    if (url.includes('slt-')) { sltCalls++; return Response.json([]) }
    const body = JSON.parse(init.body)
    if (body.operationName === 'refreshToken') {
      refreshCalls++; assert.equal(body.variables.refreshToken, 'fixture-refresh')
      assert.equal(body.variables.username, 'fixture-user')
      return Response.json({ data: { token: { access: 'new-token', refresh: 'new-refresh' } } })
    }
    if (body.operationName === 'getlogin') { loginCalls++; throw new Error('must use refresh grant first') }
    return init.headers.authorization === 'Bearer old-token' ? invalid() : photos()
  } })
  const { client } = await f.connection.open(new AbortController().signal)
  assert.equal((await client.searchPhotos(request)).docs[0].id, 'real-photo')
  assert.equal(refreshCalls, 1); assert.equal(loginCalls, 0); assert.equal(sltCalls, 0)
  assert.equal(f.readGrant().token, 'new-token'); assert.equal(f.readGrant().refreshToken, 'new-refresh')
})

test('legacy grants without refresh credentials recover using one login and store both tokens', async () => {
  let logins = 0
  const f = fixture({ refreshToken: '', fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.operationName === 'getlogin') { logins++; return Response.json({ data: { token: { tokenPayload: { access: 'new-token', refresh: 'rotated' } } } }) }
    return init.headers.authorization === 'Bearer old-token' ? invalid() : photos()
  } })
  await f.connection.open(new AbortController().signal)
  assert.equal(logins, 1); assert.equal(f.readGrant().refreshToken, 'rotated')
})

test('parallel reads rejected after validation share one renewal even when access token does not change', async () => {
  let expired = false, renewals = 0, held = []
  const f = fixture({ fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.operationName === 'refreshToken') { renewals++; expired = false; return Response.json({ data: { token: { access: 'old-token', refresh: 'rotated' } } }) }
    if (expired && body.variables.input.query) {
      await new Promise(resolve => { held.push(resolve); if (held.length === 2) held.forEach(done => done()) })
      return invalid()
    }
    return photos()
  } })
  const a = await f.connection.open(new AbortController().signal), b = await f.connection.open(new AbortController().signal)
  expired = true
  const results = await Promise.all([a.client.searchPhotos(request), b.client.searchPhotos(request)])
  assert.equal(results.length, 2); assert.equal(renewals, 1); assert.equal(f.readGrant().refreshToken, 'rotated')
})

test('disabling automatic refresh surfaces authentication failure without issuing auth mutations', async () => {
  let mutations = 0
  const f = fixture({ overrides: { autoRefreshToken: false }, fetchImpl: async (_url, init) => {
    if (JSON.parse(init.body).operationName !== 'getPhotos') mutations++
    return invalid()
  } })
  await assert.rejects(f.connection.open(new AbortController().signal), error => agentError(error, 'search', 0).code === 'authentication-failed')
  assert.equal(mutations, 0)
})

test('a collection mutation rejected after validation is submitted once and never renewed or replayed', async () => {
  let writes = 0, renewals = 0
  const f = fixture({ fetchImpl: async (url, init) => {
    if (url.includes('slt-')) { writes++; return new Response('', { status: 401 }) }
    if (JSON.parse(init.body).operationName === 'refreshToken') renewals++
    return photos()
  } })
  const { client } = await f.connection.open(new AbortController().signal, true)
  await assert.rejects(client.addSelectionDoc('collection', { id: 'photo' }))
  assert.equal(writes, 1); assert.equal(renewals, 0)
})

test('an explicitly rejected refresh grant falls back to one login; the rejected grant is replaced', async () => {
  let refreshes = 0, logins = 0
  const f = fixture({ fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.operationName === 'refreshToken') { refreshes++; return new Response('', { status: 401 }) }
    if (body.operationName === 'getlogin') { logins++; return Response.json({ data: { token: { tokenPayload: { access: 'new-token', refresh: 'new-refresh' } } } }) }
    return init.headers.authorization === 'Bearer old-token' ? invalid() : photos()
  } })
  await f.connection.open(new AbortController().signal)
  assert.equal(refreshes, 1); assert.equal(logins, 1); assert.equal(f.readGrant().refreshToken, 'new-refresh')
})

test('HUB refresh HTTP 401 wrapped inside GraphQL HTTP 200 falls back to one login and restores FAR reads', async () => {
  let refreshes = 0, logins = 0
  const f = fixture({ fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.operationName === 'refreshToken') {
      refreshes++
      return Response.json({ errors: [{ message: 'Request failed with status code 401', extensions: { code: 'upstream-wrapper' } }] })
    }
    if (body.operationName === 'getlogin') {
      logins++
      return Response.json({ data: { token: { tokenPayload: { access: 'new-token', refresh: 'new-refresh' } } } })
    }
    return init.headers.authorization === 'Bearer old-token' ? forbidden() : photos()
  } })
  const { client } = await f.connection.open(new AbortController().signal)
  assert.equal((await client.searchPhotos(request)).docs[0].id, 'real-photo')
  assert.equal(refreshes, 1); assert.equal(logins, 1)
  assert.equal(f.readGrant().refreshToken, 'new-refresh')
})

for (const message of ['Request failed with status code 403', 'Request failed with status code 503', 'invalid remote schema']) {
  test(`wrapped refresh failure ${message} does not trigger a login`, async () => {
    let logins = 0
    const f = fixture({ fetchImpl: async (_url, init) => {
      const operation = JSON.parse(init.body).operationName
      if (operation === 'getlogin') { logins++; throw new Error('unexpected login') }
      return operation === 'refreshToken' ? Response.json({ errors: [{ message }] }) : forbidden()
    } })
    await assert.rejects(f.connection.open(new AbortController().signal))
    assert.equal(logins, 0)
    assert.equal(f.readGrant().token, 'old-token')
  })
}

test('a wrapped 401 outside refreshToken remains unclassified and does not submit authentication requests', async () => {
  let mutations = 0
  const f = fixture({ fetchImpl: async (_url, init) => {
    if (JSON.parse(init.body).operationName !== 'getPhotos') mutations++
    return Response.json({ errors: [{ message: 'Request failed with status code 401' }] })
  } })
  await assert.rejects(f.connection.open(new AbortController().signal), error => error.afpFailure.category === 'unknown')
  assert.equal(mutations, 0)
})

for (const status of [403, 429, 503]) test(`HTTP ${status} never starts an authentication recovery loop`, async () => {
  let auth = 0
  const f = fixture({ fetchImpl: async (_url, init) => {
    if (JSON.parse(init.body).operationName !== 'getPhotos') auth++
    return new Response('', { status })
  } })
  await assert.rejects(f.connection.open(new AbortController().signal))
  assert.equal(auth, 0)
})

test('cancelled renewal leaves the previous grant intact and does not replay the pending search', async () => {
  const controller = new AbortController(); let searches = 0
  const f = fixture({ fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.operationName === 'refreshToken') { controller.abort(); return Response.json({ data: { token: { access: 'new', refresh: 'new-refresh' } } }) }
    if (body.variables.input.query) { searches++; return invalid() }
    return photos()
  } })
  const { client } = await f.connection.open(controller.signal)
  await assert.rejects(client.searchPhotos(request), { name: 'AbortError' })
  assert.equal(searches, 1); assert.equal(f.readGrant().token, 'old-token'); assert.equal(f.readGrant().refreshToken, 'fixture-refresh')
})

test('a fresh token that FAR rejects is never committed or retried recursively', async () => {
  let refreshes = 0
  const f = fixture({ fetchImpl: async (_url, init) => {
    if (JSON.parse(init.body).operationName === 'refreshToken') { refreshes++; return Response.json({ data: { token: { access: 'also-invalid', refresh: 'new-refresh' } } }) }
    return invalid()
  } })
  await assert.rejects(f.connection.open(new AbortController().signal))
  assert.equal(refreshes, 1); assert.equal(f.readGrant().token, 'old-token')
})

test('a malformed successful FAR response does not establish token verification or start a login', async () => {
  let requests = 0
  const f = fixture({ fetchImpl: async () => { requests++; return Response.json({ data: { photos: null } }) } })
  await assert.rejects(f.connection.open(new AbortController().signal), /invalid photo metadata/)
  assert.equal(requests, 1); assert.equal(f.readGrant().verifiedAt, 1)
})

test('automatic refresh defaults on and rejects nonboolean deployment values', () => {
  assert.equal(resolveConfig({}).autoRefreshToken, true)
  assert.throws(() => resolveConfig({ autoRefreshToken: 'true' }), /autoRefreshToken/)
})

test('a cached token rejected as GraphQL FORBIDDEN at the token probe is renewed once', async () => {
  let renewals = 0
  const f = fixture({ fetchImpl: async (_url, init) => {
    if (JSON.parse(init.body).operationName === 'refreshToken') {
      renewals++; return Response.json({ data: { token: { access: 'renewed-token', refresh: 'renewed-refresh' } } })
    }
    return init.headers.authorization === 'Bearer old-token' ? forbidden() : photos()
  } })
  const { client } = await f.connection.open(new AbortController().signal)
  assert.equal((await client.searchPhotos(request)).docs[0].id, 'real-photo')
  assert.equal(renewals, 1); assert.equal(f.readGrant().token, 'renewed-token')
})

test('a new grant rejected as GraphQL FORBIDDEN preserves the authorization failure and prior cache', async () => {
  let renewals = 0
  const f = fixture({ fetchImpl: async (_url, init) => {
    if (JSON.parse(init.body).operationName === 'refreshToken') {
      renewals++; return Response.json({ data: { token: { access: 'renewed-token', refresh: 'renewed-refresh' } } })
    }
    return forbidden()
  } })
  await assert.rejects(f.connection.open(new AbortController().signal), error => error.afpFailure?.category === 'authorization')
  assert.equal(renewals, 1); assert.equal(f.readGrant().token, 'old-token')
})

test('disabled renewal does not recover a cached GraphQL FORBIDDEN grant', async () => {
  let auth = 0
  const f = fixture({ overrides: { autoRefreshToken: false }, fetchImpl: async (_url, init) => {
    if (JSON.parse(init.body).operationName !== 'getPhotos') auth++
    return forbidden()
  } })
  await assert.rejects(f.connection.open(new AbortController().signal), error => error.afpFailure?.category === 'authorization')
  assert.equal(auth, 0)
})

test('a business read denied after the token probe is not renewed or replayed', async () => {
  let searches = 0, auth = 0
  const f = fixture({ fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.operationName === 'refreshToken') auth++
    if (body.variables.input.query) { searches++; return forbidden() }
    return photos()
  } })
  const { client } = await f.connection.open(new AbortController().signal)
  await assert.rejects(client.searchPhotos(request), error => error.afpFailure?.category === 'authorization')
  assert.equal(searches, 1); assert.equal(auth, 0)
})

test('search is replayed only once when the renewed grant passes validation but the search still rejects it', async () => {
  let searches = 0, refreshes = 0
  const f = fixture({ fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.operationName === 'refreshToken') { refreshes++; return Response.json({ data: { token: { access: 'new', refresh: 'rotated' } } }) }
    if (body.variables.input.query) { searches++; return invalid() }
    return photos()
  } })
  const { client } = await f.connection.open(new AbortController().signal)
  await assert.rejects(client.searchPhotos(request), error => agentError(error, 'search', 0).code === 'authentication-failed')
  assert.equal(searches, 2); assert.equal(refreshes, 1)
  const metadata = await f.connection.configurationInfo()
  assert.doesNotMatch(JSON.stringify(metadata), /rotated|fixture-refresh|fixture-password/)
})
