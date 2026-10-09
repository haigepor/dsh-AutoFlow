import test from 'node:test'
import assert from 'node:assert/strict'
import { createOpenAiCompatibleVisionClient } from '../src/vendor/auto-afp-img/openai-compatible-vision.mjs'
import { triageCandidates } from '../src/vendor/auto-afp-img/afp-visual-triage.mjs'

test('preview reads and completed visual decisions remain separate when a request fails', async () => {
  const stages = [], settled = []
  const decisions = await triageCandidates({ candidateManifest: { categories: [{ category: 'food', candidates: [{ id: 'one' }, { id: 'two' }] }] }, concurrency: 1,
    previewClient: { async getPreviewBytes() { return { bytes: new Uint8Array([255, 216, 255]), contentType: 'image/jpeg' } } },
    visionClient: { async classify() { if (settled.length) throw new Error('secret'); return { category: 'food', confidence: .99, keep: true, reason: 'visible food' } } },
    onStage: event => stages.push(event), onProgress: event => settled.push(event) })
  assert.equal(stages.filter(event => event.stage === 'preview').length, 2)
  assert.deepEqual(stages[0].previewPhotoIds, [])
  assert.deepEqual(stages.at(-1).previewPhotoIds, ['one', 'two'])
  assert.deepEqual(settled.at(-1), { completed: 2, total: 2, previewed: 2, pixelReviewed: 1, requestFailures: 1 })
  assert.equal(decisions[1].reason, 'preview or vision request failed')
  assert.doesNotMatch(JSON.stringify(stages), /secret/)
})

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
