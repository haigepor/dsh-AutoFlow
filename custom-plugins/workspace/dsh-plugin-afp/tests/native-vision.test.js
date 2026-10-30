import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../config-schema.js'
import { nativeVisionInformation, createNativeVisionClient } from '../src/host/afp-native-vision.js'

function fixture(overrides = {}) {
  const models = new Map([['one', [{ provider: 'one', id: 'vision', name: 'Vision', inputModalities: ['text', 'image'] },
    { provider: 'one', id: 'text', name: 'Text', inputModalities: ['text'] }]],
  ['two', [{ provider: 'two', id: 'other', name: 'Other', inputModalities: ['image'] }]]])
  const requests = [], images = []
  const llm = {
    listProviders: () => [...models.keys()].map(id => ({ id, name: id.toUpperCase() })),
    listModels: async provider => models.get(provider) ?? [],
    async prepareCall(config) {
      return { config: { ...config, maxTokens: 4096 }, inputModalities: ['image'], async *stream(options) {
        requests.push(options)
        yield { type: 'text-delta', text: '{"keep":true,"category":"food","confidence":0.99,"reason":"visible food"}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } }
    }, ...overrides,
  }
  const attachments = { async saveImages(batch) { images.push(...batch); return [{ id: 'normalized-preview', mediaType: 'image/jpeg' }] } }
  const config = resolveConfig({ visionProvider: 'one', visionModel: 'vision', readRetries: 0 })
  return { llm, attachments, models, requests, images, config, signal: new AbortController().signal }
}

test('AFP offers only image models from active configured providers without provider secrets', async () => {
  const f = fixture()
  const info = await nativeVisionInformation(f.llm, f.config)
  assert.deepEqual(info.models.map(model => [model.provider, model.id]), [['one', 'vision'], ['two', 'other']])
  assert.deepEqual(info.selected, { provider: 'one', model: 'vision' })
  assert.equal(info.state, 'ready')
  assert.doesNotMatch(JSON.stringify(info), /apiKey|baseURL|authorization/)
})

test('legacy vision settings resolve a unique configured model but never guess between providers', async () => {
  const f = fixture(), config = resolveConfig({ visionModel: 'vision', visionBaseUrl: 'https://unused.test', visionKeyRef: 'OLD_KEY' })
  assert.deepEqual((await nativeVisionInformation(f.llm, config)).selected, { provider: 'one', model: 'vision' })
  f.models.set('two', [{ provider: 'two', id: 'vision', name: 'Other vision', inputModalities: ['image'] }])
  assert.equal((await nativeVisionInformation(f.llm, config)).state, 'selection-required')
  await assert.rejects(createNativeVisionClient({ ...f, config }), /Select.*Settings/i)
})

test('native review uses configured adapter defaults and admitted image bytes, without an AFP key', async () => {
  const f = fixture(), client = await createNativeVisionClient(f)
  const bytes = Buffer.from('encoded fixture image')
  assert.equal((await client.classify({ prompt: 'inspect pixels', bytes, contentType: 'image/jpeg' })).keep, true)
  assert.equal(f.images[0].data, bytes)
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].provider, 'one')
  assert.equal(f.requests[0].maxTokens, 4096)
  assert.equal(f.requests[0].messages[0].content[1].type, 'image')
  assert.equal(f.requests[0].messages[0].content[1].attachment.id, 'normalized-preview')
  assert.equal(f.requests[0].temperature, undefined)
  assert.equal(f.requests[0].reasoningEffort, undefined)
})

test('a removed selected model cannot silently dispatch even if the adapter accepts arbitrary IDs', async () => {
  const f = fixture(), client = await createNativeVisionClient(f)
  f.models.set('one', [])
  await assert.rejects(client.classify({ prompt: 'inspect', bytes: Buffer.from('image'), contentType: 'image/jpeg' }), /Settings/i)
  assert.equal(f.requests.length, 0)
  assert.equal(f.images.length, 0)
})

test('unknown or text-only model selection fails before image admission and model dispatch', async () => {
  const f = fixture()
  for (const model of ['text', 'missing']) await assert.rejects(createNativeVisionClient({ ...f, config: { ...f.config, visionModel: model } }), /Settings/i)
  assert.equal(f.images.length, 0)
})

test('a failed unrelated provider keeps usable models visible but records incomplete discovery', async () => {
  const f = fixture(), original = f.llm.listModels
  f.llm.listModels = provider => provider === 'two' ? Promise.reject(new Error('private upstream error')) : original(provider)
  const info = await nativeVisionInformation(f.llm, f.config)
  assert.equal(info.state, 'ready')
  assert.deepEqual(info.unavailableProviders, ['two'])
  assert.doesNotMatch(JSON.stringify(info), /private upstream/)
})

for (const finish of [{ kind: 'max-tokens' }, { kind: 'error', failure: { code: 'NETWORK', message: 'private-key', status: 503 } }, undefined]) {
  test(`incomplete native output is not a pixel decision (${finish?.kind ?? 'missing finish'})`, async () => {
    const f = fixture({ async prepareCall(config) { return { config, inputModalities: ['image'], async *stream() {
      yield { type: 'text-delta', text: '{"keep":true}' }
      if (finish) yield { type: 'finish', reason: finish }
    } } } })
    const client = await createNativeVisionClient(f)
    await assert.rejects(client.classify({ prompt: 'inspect', bytes: Buffer.from('image'), contentType: 'image/jpeg' }), error => !error.message.includes('private-key'))
  })
}

test('cancellation before classification sends no model request', async () => {
  const f = fixture(), controller = new AbortController()
  const client = await createNativeVisionClient({ ...f, signal: controller.signal })
  controller.abort()
  await assert.rejects(client.classify({ prompt: 'inspect', bytes: Buffer.from('image'), contentType: 'image/jpeg' }), { name: 'AbortError' })
  assert.equal(f.requests.length, 0)
})

test('request metadata must be saved before dispatch and failed persistence sends no request', async () => {
  const f = fixture(), client = await createNativeVisionClient(f)
  const input = { prompt: 'inspect pixels', bytes: Buffer.from('image'), contentType: 'image/jpeg' }
  let saved
  await client.classify({ ...input, onRequest: async request => {
    assert.equal(f.requests.length, 0)
    saved = request
  } })
  assert.equal(saved.prompt, input.prompt)
  assert.equal(saved.config.provider, 'one')
  assert.equal(saved.attachment.id, 'normalized-preview')
  await assert.rejects(client.classify({ ...input, onRequest: async () => { throw new Error('storage unavailable') } }), /storage/)
  assert.equal(f.requests.length, 1)
})

test('adapter capability changes and unsupported preview content stop before image admission', async () => {
  const f = fixture(), client = await createNativeVisionClient(f)
  await assert.rejects(client.classify({ prompt: 'inspect', bytes: Buffer.from('html'), contentType: 'text/html' }), /unsupported/)
  f.llm.prepareCall = async config => ({ config, inputModalities: ['text'] })
  await assert.rejects(client.classify({ prompt: 'inspect', bytes: Buffer.from('image'), contentType: 'image/jpeg' }), /Settings/i)
  assert.equal(f.images.length, 0)
  assert.equal(f.requests.length, 0)
})

test('a changed adapter default is read on the next photo without changing the selected model', async () => {
  const f = fixture(), client = await createNativeVisionClient(f)
  let actual
  f.llm.prepareCall = async config => ({ config: { ...config, reasoningEffort: 'high' }, inputModalities: ['image'], async *stream(options) {
    actual = options
    yield { type: 'text-delta', text: '{"keep":false}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } })
  await client.classify({ prompt: 'inspect', bytes: Buffer.from('image'), contentType: 'image/jpeg' })
  assert.equal(actual.reasoningEffort, 'high')
  assert.equal(actual.model, 'vision')
})

test('partial discovery cannot claim a legacy model is unique', async () => {
  const f = fixture(), list = f.llm.listModels
  f.llm.listModels = provider => provider === 'two' ? Promise.reject(new Error('offline')) : list(provider)
  assert.equal((await nativeVisionInformation(f.llm, { ...f.config, visionProvider: '' })).state, 'selection-required')
})

test('reasoning output and text share the configured byte budget', async () => {
  const f = fixture({ async prepareCall(config) { return { config, inputModalities: ['image'], async *stream() {
    yield { type: 'reasoning-delta', text: 'a'.repeat(1025) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } } })
  const client = await createNativeVisionClient({ ...f, config: { ...f.config, maxResponseBytes: 1024 } })
  await assert.rejects(client.classify({ prompt: 'inspect', bytes: Buffer.from('image'), contentType: 'image/jpeg' }), /byte limit/)
})
