import test from 'node:test'
import assert from 'node:assert/strict'
import { createOpenAiCompatibleVisionClient } from '../src/vendor/auto-afp-img/openai-compatible-vision.mjs'

test('vision works with a provider that accepts only its default sampling temperature', async () => {
  let requests = 0
  const client = createOpenAiCompatibleVisionClient({ baseUrl: 'https://vision.example/v1', apiKey: 'fixture-only', model: 'reasoning-vision', retries: 0,
    fetchImpl: async (_url, init) => {
      requests++
      const body = JSON.parse(init.body)
      if (Object.hasOwn(body, 'temperature')) return Response.json({ error: { code: 'unsupported_value', param: 'temperature' } }, { status: 400 })
      return Response.json({ choices: [{ message: { content: JSON.stringify({ category: 'animals', confidence: 0.9, keep: false, reason: 'test' }) } }] })
    } })
  const result = await client.classify({ prompt: 'Review visible animals.', bytes: new Uint8Array([255, 216, 255]), contentType: 'image/jpeg' })
  assert.equal(result.category, 'animals')
  assert.equal(requests, 1)
})
