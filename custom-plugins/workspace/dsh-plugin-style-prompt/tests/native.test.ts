/** Real LlmRuntime dispatch with a controlled adapter; no external API or generated-image quality claim. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { StylePromptService } from '../src/host/service.ts'
import { Config } from '../src/host/config.ts'
import { actionSchema, taskIdSchema, type TaskRecord, type Reference } from '../src/shared/model.ts'
import { NativeModel, type ModelDependencies } from '../src/host/native-model.ts'
import { compileQuick } from '../src/shared/compose.ts'
import { analysisId, memoryRepository, observation, pixels, route, newInput } from './fixture.ts'

class Adapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  readonly started = Promise.withResolvers<void>()
  mode: 'success' | 'invalid' | 'truncated' | 'waiting' | 'text' = 'success'
  generation = false
  override async resolveModel() { return { provider: route.provider, id: route.model, name: 'Fixture vision', inputModalities: this.mode === 'text' ? ['text'] as const : ['image', 'text'] as const } }
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.calls.push(options); this.started.resolve()
    if (this.mode === 'waiting') {
      await new Promise<void>(resolve => { if (options.signal?.aborted) resolve(); else options.signal?.addEventListener('abort', () => resolve(), { once: true }) })
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'stopped' } } }; return
    }
    const base = compileQuick(observation, newInput())
    const output = this.generation ? { ...base, variants: [0, 1, 2].map(index => ({ title: { zh: `方案${index}`, en: `Plan ${index}` }, prompt: { zh: `街角咖啡店方案${index}，低饱和暖色与纸张颗粒`, en: `Corner coffee shop plan ${index}, muted warm colors and paper grain` }, changes: [{ zh: `空间布局${index}`, en: `Spatial layout ${index}` }] })) } : observation
    yield { type: 'text-delta', index: 0, text: this.mode === 'invalid' ? '{broken' : JSON.stringify(output) }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 60, totalTokens: 160 } }
    yield { type: 'finish', reason: { kind: this.mode === 'truncated' ? 'max-tokens' : 'stop' } }
  }
}

function fixture() {
  const ctx = new Context(), llm = new LlmRuntime(ctx), adapter = new Adapter(), repository = memoryRepository()
  const unregister = llm.registerAdapter([route.provider], adapter)
  const attachment = { attachmentId: AttachmentId('fixture-image'), mediaType: 'image/png' as const, bytes: pixels.length, width: 1, height: 1, name: 'reference.png' }
  const dependencies: ModelDependencies = { llm, attachments: { saveImages: async () => [attachment], readImage: async () => ({ data: pixels, ref: attachment }) } }
  const service = new StylePromptService(repository, dependencies, Config.parse({}), () => { throw new Error('unexpected storage failure') })
  const start = () => service.action(actionSchema.parse({ operation: 'analyze', input: { id: analysisId, route, dimensions: ['texture', 'color'], files: [{ name: 'reference.png', mediaType: 'image/png', base64: pixels.toString('base64') }] } }), new AbortController().signal)
  const settle = async (id = analysisId): Promise<TaskRecord> => {
    for (let i = 0; i < 100; i++) { const record = repository.get(id); if (record && record.status !== 'running') return record; await new Promise<void>(resolve => setImmediate(resolve)) }
    throw new Error('Task did not settle')
  }
  return { ctx, llm, adapter, repository, dependencies, service, start, settle, cleanup: async () => { await service.dispose(); unregister(); await ctx.fiber.dispose() } }
}

test('admitted pixels reach native LLM and the saved request exists before terminal output', async () => {
  const f = fixture()
  try {
    await f.service.initialize(); await f.start(); const record = await f.settle()
    assert.equal(record.status, 'succeeded')
    assert.equal(f.adapter.calls.length, 1)
    assert.equal(f.adapter.calls[0]?.messages[0]?.content.some(block => block.type === 'image'), true)
    assert.ok(record.call?.system.includes('sourceContent'))
    assert.deepEqual(record.call?.usage, { inputTokens: 100, outputTokens: 60, totalTokens: 160 })
    assert.ok(!JSON.stringify(record.call).includes('base64'))
    await f.start(); assert.equal(f.adapter.calls.length, 1)
    const input = { ...newInput(), mode: 'model' as const }
    f.adapter.generation = true
    const generationId = taskIdSchema.parse('generation-1')
    await f.service.action({ operation: 'generate', id: generationId, input }, new AbortController().signal)
    const generated = await f.settle(generationId)
    assert.equal(generated.status, 'succeeded')
    assert.equal(f.adapter.calls[1]?.messages[0]?.content.some(block => block.type === 'image'), false)
    const exported = await f.service.action({ operation: 'export', id: generationId }, new AbortController().signal)
    assert.ok(!JSON.stringify(exported).includes('戴红帽子的猫'))
  } finally { await f.cleanup() }
})

for (const mode of ['invalid', 'truncated'] as const) test(`does not commit ${mode} model output as successful analysis`, async () => {
  const f = fixture(); f.adapter.mode = mode
  try { await f.start(); const record = await f.settle(); assert.equal(record.status, 'failed'); assert.equal(record.failure?.code, 'invalid-output') }
  finally { await f.cleanup() }
})

test('text-only models are rejected before saving a task or dispatching', async () => {
  const f = fixture(); f.adapter.mode = 'text'
  try { await assert.rejects(f.start(), { code: 'capability-unavailable' }); assert.equal(f.adapter.calls.length, 0); assert.equal(f.repository.list().length, 0) }
  finally { await f.cleanup() }
})

test('cancel settles a pending native request without automatic retry', async () => {
  const f = fixture(); f.adapter.mode = 'waiting'
  try { await f.start(); await f.adapter.started.promise; await f.service.action({ operation: 'cancel', id: analysisId }, new AbortController().signal); assert.equal(f.repository.get(analysisId)?.status, 'cancelled'); assert.equal(f.adapter.calls.length, 1) }
  finally { await f.cleanup() }
})

test('restart marks pending records interrupted and does not dispatch', async () => {
  const f = fixture()
  try {
    const record = { formatVersion: 1 as const, kind: 'analysis' as const, id: analysisId, createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z', digest: 'saved', status: 'running' as const, failure: null, call: null, route, dimensions: ['color' as const], references: [], result: null }
    await f.repository.put(record); await f.service.initialize()
    assert.equal(f.repository.get(analysisId)?.status, 'interrupted'); assert.equal(f.adapter.calls.length, 0)
  } finally { await f.cleanup() }
})

test('native request persistence failure prevents any model dispatch', async () => {
  const f = fixture(), model = new NativeModel(f.dependencies, Config.parse({}))
  try {
    const reference: Reference = { id: observation.rules[0]!.referenceIds[0]!, name: 'reference.png', sha256: createHash('sha256').update(pixels).digest('hex'), attachment: { attachmentId: 'fixture-image', mediaType: 'image/png', bytes: pixels.length, width: 1, height: 1 } }
    await assert.rejects(model.call({ route, system: 'test', inputText: 'actual pixels', references: [reference], templateVersion: 'test' }, async () => { throw new Error('disk full') }, new AbortController().signal), /disk full/)
    assert.equal(f.adapter.calls.length, 0)
  } finally { await f.cleanup() }
})
