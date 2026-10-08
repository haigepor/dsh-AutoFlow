import test from 'node:test'
import assert from 'node:assert/strict'
import { createAfpApiClient } from '../src/vendor/auto-afp-img/afp-api-client.mjs'
import { agentError } from '../src/host/afp-agent-errors.js'

const request = { operationName: 'getPhotos', query: 'query getPhotos { photos { hasMore } }', variables: {} }

for (const [extensionCode, code, category, stage] of [
  ['UNAUTHENTICATED', 'authentication-failed', 'authentication', 'authentication'],
  ['FORBIDDEN', 'access-denied', 'authorization', 'authorization'],
  ['GRAPHQL_VALIDATION_FAILED', 'api-schema-rejected', 'schema', 'read'],
  ['BAD_USER_INPUT', 'query-rejected', 'query', 'read'],
  ['INTERNAL_SERVER_ERROR', 'upstream-unavailable', 'service', 'read'],
  ['token=private https://signed.example/?token=private', 'upstream-error', 'unknown', 'read'],
]) {
  test(`safe read errors distinguish GraphQL ${category} failures at HTTP 200`, async () => {
    let calls = 0
    const client = createAfpApiClient({ accessToken: 'private-token', retries: 0, fetchImpl: async () => {
      calls++
      return new Response(JSON.stringify({ errors: [{ message: 'private-password https://signed.example/?token=private',
        extensions: { code: extensionCode }, path: ['private-path'], private: 'private-value' }] }), { status: 200 })
    } })
    let projected
    try { await client.searchPhotos(request) } catch (error) {
      assert.doesNotMatch(error.message, /private|signed\.example/)
      projected = agentError(error, 'search', 8)
    }
    assert.ok(projected)
    assert.equal(projected.code, code)
    assert.equal(projected.stage, stage)
    assert.deepEqual(projected.upstream, { protocol: 'graphql', httpStatus: 200, category })
    assert.doesNotMatch(JSON.stringify(projected), /private|signed\.example|path/)
    assert.equal(calls, 1)
  })
}
