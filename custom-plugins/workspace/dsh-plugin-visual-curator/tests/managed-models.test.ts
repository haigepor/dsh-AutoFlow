import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { serviceFixture } from './helpers/service-fixture.ts'
import { visionModelsSchema } from '../src/shared/vision-models.ts'
import { createVisionModelDirectory, managedVision, visionModelKey } from '../src/client/vision-models.ts'
import { resolveConfig } from '../src/host/config.ts'

class CatalogAdapter extends LlmAdapter {
  images = true
  calls = 0
  override async listModels(provider: string) { return ['vision', 'text', 'unknown'].map(id => ({ provider, id, name: id })) }
  override async resolveModel(provider: string, id: string) { return { provider, id, name: id, context: { contextWindow: 1_000_000 }, defaultMaxTokens: 65_536, ...(id === 'unknown' ? {} : { inputModalities: id === 'vision' && this.images ? ['text', 'image'] as const : ['text'] as const }) } }
  async *stream(): AsyncGenerator<StreamChunk> { this.calls++; throw new Error('Catalog reads must never invoke a model') }
}

test('the curator lists only image-capable models from the current project registry without making a paid call', async () => {
  const f = await serviceFixture(), ctx = new Context(), llm = new LlmRuntime(ctx), adapter = new CatalogAdapter()
  const remove = llm.registerAdapter(['configured'], adapter)
  f.host.llm = llm
  try {
    await f.service.initialize()
    const read = async () => visionModelsSchema.parse(await f.action('vision-models'))
    const catalog = await read()
    assert.deepEqual(catalog.models.map(model => [model.provider, model.id]), [['configured', 'vision']])
    assert.equal(catalog.models[0]!.contextWindow, 1_000_000)
    assert.equal(catalog.models[0]!.maxOutputTokens, 65_536)
    assert.equal(JSON.stringify(catalog).includes('endpoint'), false)
    adapter.images = false
    assert.deepEqual((await read()).models, [])
    remove()
    assert.deepEqual((await read()).models, [])
    assert.equal(adapter.calls, 0)
    assert.equal(f.http.operations.length, 0)
    const response = await f.service.data(new Request('http://owner.test/api/visual-curator/data', { method: 'POST', body: JSON.stringify({ operation: 'vision-models', args: {} }) }))
    assert.equal(response.status, 200)
  } finally { remove(); await f.cleanup(); await ctx.fiber.dispose() }
})

test('a catalog failure is isolated without exposing provider errors and stale model selection is refused', async () => {
  const f = await serviceFixture(), ctx = new Context(), llm = new LlmRuntime(ctx), adapter = new CatalogAdapter()
  const bad = new CatalogAdapter()
  bad.listModels = async () => { throw new Error('private key or endpoint') }
  const remove = llm.registerAdapter(['configured'], adapter), removeBad = llm.registerAdapter(['broken'], bad)
  f.host.llm = llm
  try {
    await f.service.initialize()
    const catalog = visionModelsSchema.parse(await f.action('vision-models'))
    assert.equal(catalog.models.length, 1)
    assert.equal(catalog.unavailable.length, 1)
    assert.equal(JSON.stringify(catalog).includes('private key'), false)
    const config = await f.action('config-read')
    assert.ok(config && typeof config === 'object' && !Array.isArray(config) && typeof config.revision === 'string')
    await assert.rejects(f.action('config-save', { revision: config.revision, source: {}, limits: {}, vision: { backend: 'native', provider: 'configured', model: 'text' } }), { code: 'configuration-required' })
    remove()
    await assert.rejects(f.action('config-save', { revision: config.revision, source: {}, limits: {}, vision: { backend: 'native', provider: 'configured', model: 'vision' } }), { code: 'configuration-required' })
    assert.equal(adapter.calls, 0)
  } finally { remove(); removeBad(); await f.cleanup(); await ctx.fiber.dispose() }
})

test('managed selection keeps only the chosen native route and uses its centrally managed reasoning defaults', () => {
  const config = resolveConfig({ vision: { backend: 'compatible', endpoint: 'https://legacy.test/v1', credentialRef: 'OLD_KEY', localOrigin: 'http://127.0.0.1:3425', reasoningEffort: 'high' } })
  const model = { provider: 'configured', providerName: 'Configured', id: 'vision', name: 'Vision' }
  const selected = managedVision(config.vision, visionModelKey(model), { models: [model], unavailable: [] })
  assert.equal(selected.backend, 'native'); assert.equal(selected.provider, model.provider); assert.equal(selected.model, model.id)
  assert.equal(selected.endpoint, ''); assert.equal(selected.credentialRef, ''); assert.equal(selected.localOrigin, '')
  assert.equal(selected.reasoningEffort, null)
  assert.equal(selected.useModelDefaults, true)
  assert.throws(() => managedVision(config.vision, visionModelKey(model), { models: [], unavailable: [] }), /model-unavailable/)
})

test('model catalogs share reads and ignore a disconnected or disposed generation', async () => {
  const reads: ((value: unknown) => void)[] = []
  const directory = createVisionModelDirectory(() => new Promise(resolve => reads.push(resolve)))
  const a = directory.load(), b = directory.load()
  assert.equal(reads.length, 1)
  directory.reset()
  reads[0]!({ models: [{ provider: 'old', providerName: 'Old', id: 'm', name: 'M' }], unavailable: [] })
  await Promise.all([a, b])
  assert.equal(directory.getSnapshot().value, null)
  const fresh = directory.load()
  reads[1]!({ models: [], unavailable: [] }); await fresh
  assert.deepEqual(directory.getSnapshot().value?.models, [])
  await directory.load(); assert.equal(reads.length, 2)
  directory.invalidate(); assert.equal(reads.length, 3)
  directory.dispose(); reads[2]!({ models: [], unavailable: [] })
  await Promise.resolve()
})
