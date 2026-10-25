import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, reviewerRevision } from '../src/host/config.ts'

test('gallery identity freshness has a deployment default and can disable stored success', () => {
  assert.equal(resolveConfig({}).source.unsplash.identityCacheTtlMs, 180000)
  assert.equal(resolveConfig({ source: { unsplash: { identityCacheTtlMs: 0 } } }).source.unsplash.identityCacheTtlMs, 0)
  assert.equal(resolveConfig({ source: { unsplash: { identityCacheTtlMs: 12000 } } }).source.unsplash.identityCacheTtlMs, 12000)
  for (const identityCacheTtlMs of [-1, 1.5]) assert.throws(() => resolveConfig({ source: { unsplash: { identityCacheTtlMs } } }))
})

test('gallery cache deployment limits default independently and reject non-positive budgets', () => {
  assert.deepEqual(resolveConfig({}).source.unsplash.cache, { ttlMs: 300000, maxPages: 120, maxBytes: 2097152 })
  assert.equal(resolveConfig({ source: { unsplash: { cache: { ttlMs: 12000, maxPages: 5, maxBytes: 2048 } } } }).source.unsplash.cache.ttlMs, 12000)
  for (const cache of [{ ttlMs: 0 }, { maxPages: -1 }, { maxBytes: 0 }]) assert.throws(() => resolveConfig({ source: { unsplash: { cache } } }))
})

test('reasoning effort is optional, validated and part of the reviewer identity', () => {
  const plain = resolveConfig({})
  assert.equal('reasoningEffort' in plain.vision, false)
  const low = resolveConfig({ vision: { reasoningEffort: 'low' } })
  assert.equal(low.vision.reasoningEffort, 'low')
  assert.notEqual(reviewerRevision(low), reviewerRevision(plain))
  const reset = resolveConfig({ vision: { ...low.vision, reasoningEffort: null } })
  assert.equal('reasoningEffort' in reset.vision, false)
  assert.equal(reviewerRevision(reset), reviewerRevision(plain))
  assert.throws(() => resolveConfig({ vision: { reasoningEffort: 'unsupported' } }))
})

test('vision base addresses resolve to chat completions without rewriting full custom endpoints', () => {
  for (const [input, expected] of [
    ['http://127.0.0.1:3425/v1', 'http://127.0.0.1:3425/v1/chat/completions'],
    ['https://vision.example.test/v1/', 'https://vision.example.test/v1/chat/completions'],
    ['https://vision.example.test', 'https://vision.example.test/v1/chat/completions'],
    ['https://vision.example.test/proxy/v1', 'https://vision.example.test/proxy/v1/chat/completions'],
    ['https://vision.example.test/custom/chat', 'https://vision.example.test/custom/chat'],
  ]) assert.equal(resolveConfig({ vision: { endpoint: input } }).vision.endpoint, expected)
})

test('deployment endpoints reject inline credentials, query parameters and fragments for every request role', () => {
  for (const target of ['source', 'lookup', 'vision'] as const) {
    for (const endpoint of ['https://user:secret@example.test/api', 'https://example.test/api?api_key=secret', 'https://example.test/api#secret']) {
      const input = target === 'vision' ? { vision: { endpoint } }
        : target === 'lookup' ? { source: { lookupEndpoint: endpoint } } : { source: { endpoint } }
      assert.throws(() => resolveConfig(input), error => error instanceof TypeError && /inline authentication|query parameters/.test(error.message) && !error.message.includes('secret'))
    }
  }
  const config = resolveConfig({ source: { endpoint: 'https://source.example.test/api/search', lookupEndpoint: 'https://source.example.test/api/lookup', credentialRef: 'CURATOR_SOURCE_KEY' },
    vision: { endpoint: 'https://vision.example.test/v1/chat/completions', credentialRef: 'CURATOR_VISION_KEY' } })
  assert.equal(config.source.credentialRef, 'CURATOR_SOURCE_KEY')
  assert.equal(config.vision.endpoint, 'https://vision.example.test/v1/chat/completions')
  assert.throws(() => resolveConfig({ source: { endpoint: 'https://source.example.test/search', apiKey: 'secret' } }))
})

test('allowed media and local vision destinations accept only canonical origins without paths or credentials', () => {
  for (const value of ['https://cdn.example.test/path', 'https://cdn.example.test/', 'https://cdn.example.test?key=secret',
    'https://cdn.example.test#fragment', 'https://user:secret@cdn.example.test', 'https://cdn.example.test:443']) {
    assert.throws(() => resolveConfig({ source: { allowedMediaOrigins: [value] } }))
    assert.throws(() => resolveConfig({ vision: { localOrigin: value } }))
  }
  const config = resolveConfig({ source: { allowedMediaOrigins: ['https://cdn.example.test', 'https://media.example.test:8443'] }, vision: { localOrigin: 'http://127.0.0.1:8080' } })
  assert.deepEqual(config.source.allowedMediaOrigins, ['https://cdn.example.test', 'https://media.example.test:8443'])
  assert.equal(config.vision.localOrigin, 'http://127.0.0.1:8080')
})

test('reviewer identity changes with model sampling, output limits and reference selection', () => {
  const base = resolveConfig({ vision: { endpoint: 'https://vision.example.test/chat', model: 'vision-a', vendorVersion: 'version-a' } })
  const identity = reviewerRevision(base)
  assert.equal(reviewerRevision(resolveConfig(structuredClone(base))), identity)
  for (const limits of [{ visionTemperature: 0.5 }, { maxVisionOutputTokens: base.limits.maxVisionOutputTokens + 1 },
    { maxReferenceImages: base.limits.maxReferenceImages + 1 }, { maxReferenceBytes: base.limits.maxReferenceBytes + 1 }]) {
    assert.notEqual(reviewerRevision(resolveConfig({ ...base, limits: { ...base.limits, ...limits } })), identity)
  }
  assert.notEqual(reviewerRevision(resolveConfig({ ...base, vision: { ...base.vision, model: 'vision-b' } })), identity)
  assert.notEqual(reviewerRevision(resolveConfig({ ...base, vision: { ...base.vision, vendorVersion: 'version-b' } })), identity)
  assert.equal(reviewerRevision(resolveConfig({ ...base, limits: { ...base.limits, pollIntervalMs: 3000, pageSize: 30, deadlineMs: base.limits.deadlineMs + 1 } })), identity)
})
