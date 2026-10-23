import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, reviewerRevision } from '../src/host/config.ts'

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
