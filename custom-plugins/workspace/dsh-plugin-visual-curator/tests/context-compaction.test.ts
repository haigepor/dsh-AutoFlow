/** Native compression participates in real curator Run budgets before final inference. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { serviceFixture } from './helpers/service-fixture.ts'
import { dataOf } from '../src/host/runtime.ts'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'

class Adapter extends LlmAdapter {
  truncated = false
  calls: GenerateOptions[] = []
  override async resolveModel(provider: string, id: string) { return { provider, id, name: id, context: { contextWindow: 20_000 }, defaultMaxTokens: 1000, inputModalities: ['text', 'image'] as const } }
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.calls.push(options)
    yield { type: 'text-delta', index: 0, text: 'Muted green palette; preserve uncertainty and negative examples. Human judgments are authoritative.' }
    yield { type: 'usage', usage: { inputTokens: 800, outputTokens: 25 } }
    yield { type: 'finish', reason: { kind: this.truncated ? 'max-tokens' : 'stop' } }
  }
}

for (const mode of ['success', 'truncated', 'budget'] as const) test(`native compression ${mode} with one visual slot preserves observations`, async () => {
  const truncated = mode === 'truncated'
  const f = await serviceFixture(undefined, { maxConcurrentRequests: 1, maxVisionCalls: mode === 'budget' ? 1 : 40 }), ctx = new Context(), llm = new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx); new TokenMeter(ctx)
  const compaction = new BasicCompactionEngine(ctx, { auto: false, thresholdRatio: 0.4, retainTokens: 0, headroomTokens: 100, maxTokens: 500 })
  const compact = compaction.compactInput.bind(compaction)
  compaction.compactInput = (input, run, signal) => compact(input, async (call, work) => {
    const result = await run(call, work)
    assert.deepEqual(await run(call, async () => { throw new Error('A committed compression must replay without dispatch') }), result)
    return result
  }, signal)
  const adapter = new Adapter(); adapter.truncated = truncated
  const dispose = llm.registerAdapter(['native'], adapter)
  f.host.llm = llm; f.host.get = ctx.get.bind(ctx)
  try {
    await f.service.initialize()
    const config = z.object({ source: z.json(), vision: z.record(z.string(), z.json()), limits: z.json() }).parse(await f.action('config-read'))
    f.service.updateConfiguration({ source: config.source, vision: { ...config.vision, backend: 'native', provider: 'native', model: 'vision', useModelDefaults: true }, limits: config.limits })
    const style = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'compact-style', name: 'Native context' }))
    const files = await Promise.all(['red', 'green', 'blue', 'white'].map(async color => ({ name: color + '.png', mime: 'image/png', base64: (await sharp({ create: { width: 16, height: 16, channels: 3, background: color } }).png().toBuffer()).toString('base64'), role: 'positive', intent: 'overall', dimensions: [] })))
    await f.action('reference-import', { operationId: 'compact-import', styleId: style.id, expectedRevision: 1, files })
    const send = f.http.request.bind(f.http)
    f.http.request = async (url, request) => {
      const response = await send(url, request)
      const body = JSON.parse(response.bytes.toString('utf8'))
      if (body.choices) {
        const output = JSON.parse(body.choices[0].message.content)
        if (output.observations) {
          for (const observation of output.observations) observation.dimensions = ['color', 'lighting', 'texture', 'subject', 'composition', 'density', 'depth'].map(dimension => ({ dimension, observation: 'Visible uncertain green details. '.repeat(90), uncertain: true }))
          body.choices[0].message.content = JSON.stringify(output)
          response.bytes = Buffer.from(JSON.stringify(body))
        }
      }
      return response
    }
    const started = z.object({ runId: z.string() }).parse(await f.action('reference-analyze', { operationId: 'compact-run', styleId: style.id, buildDataset: true }))
    await f.jobs.drain()
    const run = f.domain.require('run', started.runId), requests = f.repository.list('request').filter(row => row.runId === run.id)
    assert.equal(dataOf(run).counts.observed, 4)
    assert.equal(adapter.calls.length > 0, mode !== 'budget')
    assert.equal(dataOf(run).budget.vision, requests.length)
    assert.equal(run.status, truncated ? 'failed' : 'completed')
    const expected = JSON.parse(await readFile(new URL('./fixtures/native-context.expected.json', import.meta.url), 'utf8'))
    assert.deepEqual({ observed: dataOf(run).counts.observed, status: run.status, finalInference: f.http.summaryInputs.length > 0, error: dataOf(run).error?.code ?? null, compressionRecorded: requests.some(row => JSON.stringify(row.data).includes('compact-input')) }, expected[mode])
    if (mode === 'budget') {
      assert.equal(run.outcome, 'budget-exhausted')
      assert.equal(f.http.summaryInputs.length, 0)
    } else if (truncated) {
      assert.equal(f.http.summaryInputs.length, 0)
      assert.equal(dataOf(run).error?.code, 'vision-context-compaction-failed')
    } else {
      const summary = JSON.parse(f.http.summaryInputs[0]!)
      assert.ok(summary.observationSummary.includes('Muted green'))
      assert.equal(summary.samples.length, 4)
      assert.equal(summary.applicableFeedback.length, 4)
      assert.ok(summary.samples.every((sample: { observationId: string; imageVersionId: string }) => sample.observationId && sample.imageVersionId))
      assert.ok(requests.filter(row => JSON.stringify(row.data).includes('compact-input')).every(row => row.state === 'committed'))
    }
  } finally { dispose(); await f.cleanup(); await ctx.fiber.dispose() }
})
