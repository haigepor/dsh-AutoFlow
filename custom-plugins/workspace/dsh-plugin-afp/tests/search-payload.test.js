import test from 'node:test'
import assert from 'node:assert/strict'
import { WorkbenchData } from '../src/host/afp-workbench-data.js'
import { createAfpApiClient } from '../src/vendor/auto-afp-img/afp-api-client.mjs'
import { resolveConfig } from '../config-schema.js'

test('metadata search succeeds without asking AFP to resolve unused media references', async () => {
  const client = createAfpApiClient({ accessToken: 'fixture', retries: 0, fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body)
    if (/\bmedias\s*\(/.test(request.query)) return Response.json({ errors: [{ extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] })
    return Response.json({ data: { photos: { docs: [{ id: 'photo', guid: 'known-guid', title: 'Cat' }], hasMore: false } } })
  } })
  const workbench = new WorkbenchData({ ctx: {}, store: {}, config: resolveConfig(), connection: { open: async () => ({ client }) } })
  try {
    const result = await workbench.photoSearch({ query: 'cat', limit: 1 }, new AbortController().signal)
    assert.equal(result.items[0].id, 'photo')
    assert.equal(result.items[0].guid, 'known-guid')
    assert.equal(result.hasMore, false)
  } finally { await workbench.dispose() }
})
