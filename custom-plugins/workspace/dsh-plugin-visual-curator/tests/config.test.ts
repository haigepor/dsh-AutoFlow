import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, resolveCurrentConfig, reviewerRevision, searchScreeningPolicySchema } from '../src/host/config.ts'

test('current wallpaper limits upgrade the former defaults once and retain explicit later choices', () => {
  const legacy = resolveConfig({ wallpaper: { maxEditsPerImage: 2, maxReworks: 2 } })
  const current = resolveCurrentConfig(legacy)
  assert.equal(current.wallpaper.maxEditsPerImage, 5)
  assert.equal(current.wallpaper.maxReworks, 5)
  assert.equal(legacy.wallpaper.maxEditsPerImage, 2)
  assert.deepEqual(resolveCurrentConfig(current), current)
  const chosen = resolveCurrentConfig({ ...current, wallpaper: { ...current.wallpaper, maxEditsPerImage: 2, maxReworks: 1 } })
  assert.equal(chosen.wallpaper.maxEditsPerImage, 2)
  assert.equal(chosen.wallpaper.maxReworks, 1)
  assert.equal(resolveCurrentConfig({ wallpaper: { maxEditsPerImage: 0 } }).wallpaper.maxEditsPerImage, 0)
  assert.throws(() => resolveConfig({ wallpaper: { maxEditsPerImage: 6 } }))
})

test('new searches resolve bounded pools without changing legacy reviewer or frozen configuration', () => {
  const legacy = resolveConfig({})
  assert.equal('searchScreening' in legacy, false)
  assert.deepEqual(resolveConfig(JSON.parse(JSON.stringify(legacy))), legacy)
  const current = resolveCurrentConfig(legacy)
  assert.deepEqual(current.searchScreening, { candidatePoolSize: 50, batchSize: 6, maxScreeningImageEdge: 384 })
  const alternate = resolveCurrentConfig({ ...current, searchScreening: { candidatePoolSize: 100, batchSize: 4, maxScreeningImageEdge: 512 } })
  assert.equal(reviewerRevision(alternate), reviewerRevision(current))
  assert.equal(resolveCurrentConfig({ searchScreening: { enabled: false } }).searchScreening?.enabled, false)
  assert.deepEqual(searchScreeningPolicySchema.parse({ version: 1, ...alternate.searchScreening }), { version: 1, candidatePoolSize: 100, batchSize: 4, maxScreeningImageEdge: 512 })
  for (const searchScreening of [{ candidatePoolSize: 30 }, { batchSize: 0 }, { batchSize: 17 }, { maxScreeningImageEdge: 127 }, { maxScreeningImageEdge: 1025 }]) assert.throws(() => resolveCurrentConfig({ searchScreening }))
  assert.throws(() => searchScreeningPolicySchema.parse({ version: 1 }))
})

test('batch view cache limits have validated deployment defaults and support disabling', () => {
  assert.equal(resolveConfig({}).limits.batchCacheTtlMs, 60000)
  assert.equal(resolveConfig({}).limits.batchCacheMaxViews, 8)
  const disabled = resolveConfig({ limits: { batchCacheTtlMs: 0, batchCacheMaxViews: 0 } })
  assert.equal(disabled.limits.batchCacheTtlMs, 0)
  assert.equal(disabled.limits.batchCacheMaxViews, 0)
  for (const limits of [{ batchCacheTtlMs: -1 }, { batchCacheTtlMs: 1.5 }, { batchCacheMaxViews: -1 }, { batchCacheMaxViews: 65 }]) assert.throws(() => resolveConfig({ limits }))
})

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
test('dataset cache budgets are independently configurable and may disable reuse', () => {
  const defaults = resolveConfig({}).limits
  assert.deepEqual([defaults.datasetCacheTtlMs, defaults.datasetCacheMaxViews, defaults.datasetCacheMaxBytes], [60000, 8, 16 * 1024 * 1024])
  const disabled = resolveConfig({ limits: { datasetCacheTtlMs: 0, datasetCacheMaxViews: 0, datasetCacheMaxBytes: 0 } }).limits
  assert.deepEqual([disabled.datasetCacheTtlMs, disabled.datasetCacheMaxViews, disabled.datasetCacheMaxBytes], [0, 0, 0])
  for (const limits of [{ datasetCacheTtlMs: -1 }, { datasetCacheTtlMs: 3600001 }, { datasetCacheMaxViews: 65 }, { datasetCacheMaxBytes: -1 }, { datasetCacheMaxBytes: 128 * 1024 * 1024 + 1 }]) assert.throws(() => resolveConfig({ limits }))
})

test('analysis task summaries use validated entry and byte limits without retaining complete runs', () => {
  const limits = resolveConfig({}).limits
  assert.deepEqual([limits.analysisTaskCacheMaxEntries, limits.analysisTaskCacheMaxBytes], [128, 1024 * 1024])
  const disabled = resolveConfig({ limits: { analysisTaskCacheMaxEntries: 0, analysisTaskCacheMaxBytes: 0 } }).limits
  assert.deepEqual([disabled.analysisTaskCacheMaxEntries, disabled.analysisTaskCacheMaxBytes], [0, 0])
  for (const limits of [{ analysisTaskCacheMaxEntries: -1 }, { analysisTaskCacheMaxEntries: 4097 }, { analysisTaskCacheMaxBytes: -1 }, { analysisTaskCacheMaxBytes: 32 * 1024 * 1024 + 1 }]) assert.throws(() => resolveConfig({ limits }))
})
