/** Checkpoint continuation through the real service and provider decoder. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { serviceFixture } from './helpers/service-fixture.ts'
import { dataOf, specOf } from '../src/host/runtime.ts'
import { MediaError } from '../src/media/errors.ts'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'

test('profile analysis commits observations before inducing rules once while ordinary analysis retains suggestions', async () => {
  const f = await serviceFixture(undefined, { maxReferenceImages: 2 })
  try {
    await f.service.initialize()
    const created = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'staged-style', name: 'Staged' }))
    const files = await Promise.all(['red', 'green', 'blue', 'white', 'black'].map(async color => ({ name: `${color}.png`, mime: 'image/png', base64: (await sharp({ create: { width: 16, height: 16, channels: 3, background: color } }).png().toBuffer()).toString('base64'), role: 'positive', intent: 'overall', dimensions: [] })))
    await f.action('reference-import', { operationId: 'staged-images', styleId: created.id, expectedRevision: 1, files })
    const requestSchema = z.object({ outputSchema: z.object({ properties: z.record(z.string(), z.unknown()) }), input: z.object({ operation: z.string(), images: z.array(z.unknown()) }) })
    const send = f.http.request.bind(f.http), batches: number[] = [], fields: string[][] = []
    let observedBeforeSummary = 0, rulesBeforeSummary = 0, collecting = true
    f.http.request = async (url, request) => {
      const body = z.object({ messages: z.array(z.object({ content: z.union([z.string(), z.array(z.object({ text: z.string().optional() }))]) })) }).parse(JSON.parse(Buffer.from(request.body!).toString('utf8')))
      const content = body.messages[1]!.content
      assert.ok(Array.isArray(content))
      const input = requestSchema.parse(JSON.parse(content[0]!.text!))
      if (collecting && input.input.operation === 'analyze') { batches.push(input.input.images.length); fields.push(Object.keys(input.outputSchema.properties)) }
      if (input.input.operation === 'summarize') { observedBeforeSummary = f.repository.list('observation').length; rulesBeforeSummary = f.repository.list('suggestion').length }
      return send(url, request)
    }
    const started = z.object({ runId: z.string() }).parse(await f.action('reference-analyze', { operationId: 'staged-profile', styleId: created.id, buildDataset: true }))
    await f.jobs.drain()
    const run = f.domain.require('run', started.runId)
    assert.equal(run.status, 'completed')
    const summary = z.object({ checkpoint: z.object({ styleAnalysis: z.object({ summary: z.object({ suggestedRules: z.array(z.unknown()) }) }) }) }).parse(run.data)
    const responses = f.repository.list('request').filter(request => request.runId === run.id).map(request => z.object({ bundle: z.object({ operation: z.string() }), output: z.object({ suggestedRules: z.array(z.unknown()) }) }).parse(request.data))
    collecting = false
    const ordinary = z.object({ runId: z.string() }).parse(await f.action('reference-analyze', { operationId: 'staged-ordinary', styleId: created.id, buildDataset: false }))
    await f.jobs.drain()
    assert.equal(f.domain.require('run', ordinary.runId).status, 'completed')
    const ordinaryRules = f.repository.list('request').filter(request => request.runId === ordinary.runId).map(request => z.object({ output: z.object({ suggestedRules: z.array(z.unknown()) }) }).parse(request.data).output.suggestedRules.length)
    const actual = { mode: specOf(run).fixed.analysisOutput, observationBatches: batches, observationFields: fields, observedBeforeSummary, rulesBeforeSummary, observed: dataOf(run).counts.observed, finalRules: summary.checkpoint.styleAnalysis.summary.suggestedRules.length, normalizedBatchRules: responses.filter(response => response.bundle.operation === 'analyze').map(response => response.output.suggestedRules.length), summaryCalls: responses.filter(response => response.bundle.operation === 'summarize').length, ordinaryRules }
    assert.deepEqual(actual, JSON.parse(await readFile(new URL('./fixtures/observation-stages.expected.json', import.meta.url), 'utf8')))
  } finally { await f.cleanup() }
})

test('each observation batch receives only its human judgments while summary keeps all feedback', async () => {
  const f = await serviceFixture(undefined, { maxReferenceImages: 1 })
  try {
    await f.service.initialize()
    const created = await f.action('style-create', { operationId: 'scoped-style', name: 'Scoped' }) as { id: string }
    const files = await Promise.all(['red', 'green', 'blue'].map(async color => ({ name: `${color}.png`, mime: 'image/png', base64: (await sharp({ create: { width: 16, height: 16, channels: 3, background: color } }).png().toBuffer()).toString('base64'), role: 'positive', intent: 'overall', dimensions: [] })))
    await f.action('reference-import', { operationId: 'scoped-images', styleId: created.id, expectedRevision: 1, files })
    const send = f.http.request.bind(f.http), counts: number[] = []
    let summaryFeedback = 0
    f.http.request = async (url, request) => {
      const input = JSON.parse(JSON.parse(Buffer.from(request.body!).toString('utf8')).messages[1].content[0].text).input
      const brief = JSON.parse(input.taskBrief)
      if (input.operation === 'analyze') {
        counts.push(brief.applicableFeedback.length)
        assert.ok(brief.applicableFeedback.every((item: { subject: { imageVersionId: string } }) => item.subject.imageVersionId === input.images[0].imageVersionId))
      } else if (input.operation === 'summarize') summaryFeedback = brief.applicableFeedback.length
      return send(url, request)
    }
    const started = await f.action('reference-analyze', { operationId: 'scoped-analysis', styleId: created.id, buildDataset: true }) as { runId: string }
    await f.jobs.drain()
    assert.equal(f.domain.require('run', started.runId).status, 'completed')
    assert.deepEqual(counts, [1, 1, 1])
    assert.equal(summaryFeedback, 3)
    assert.equal(f.repository.list('feedback').length, 3)
  } finally { await f.cleanup() }
})

test('continues after a transient batch failure without repeating committed images', async () => {
  const f = await serviceFixture(undefined, { maxReferenceImages: 1, maxRetryAttempts: 1 })
  try {
    await f.service.initialize()
    const created = await f.action('style-create', { operationId: 'recovery-style', name: 'Recovery' }) as { id: string }
    const files = await Promise.all(['red', 'green', 'blue'].map(async color => ({ name: `${color}.png`, mime: 'image/png', base64: (await sharp({ create: { width: 16, height: 16, channels: 3, background: color } }).png().toBuffer()).toString('base64'), role: 'positive', intent: 'overall', dimensions: [] })))
    await f.action('reference-import', { operationId: 'recovery-images', styleId: created.id, expectedRevision: 1, files })
    const send = f.http.request.bind(f.http), ids: string[] = []
    let failed = false
    f.http.request = async (url, request) => {
      const descriptor = JSON.parse(JSON.parse(Buffer.from(request.body!).toString('utf8')).messages[1].content[0].text).input
      if (descriptor.operation === 'analyze') {
        ids.push(descriptor.images[0].imageVersionId)
        if (ids.length === 2) { failed = true; throw new MediaError('remote-request-failed', 'reviewing', true, 'Transient provider failure.', 'Retry the pending batch.') }
      }
      return send(url, request)
    }
    const start = await f.action('reference-analyze', { operationId: 'recovery-analysis', styleId: created.id, buildDataset: true }) as { runId: string }
    await f.jobs.drain()
    const run = f.domain.require('run', start.runId)
    assert.equal(failed, true)
    assert.equal(run.status, 'completed')
    assert.equal(dataOf(run).counts.observed, 3)
    assert.equal(ids.filter(id => id === ids[0]).length, 1)
    assert.equal(ids[1], ids[2])
    assert.equal(dataOf(run).budget.vision, 5)
  } finally { await f.cleanup() }
})

test('a new analysis automatically reuses a matching partial failed checkpoint', async () => {
  const f = await serviceFixture(undefined, { maxReferenceImages: 1, maxRetryAttempts: 0 })
  try {
    await f.service.initialize()
    const created = await f.action('style-create', { operationId: 'partial-style', name: 'Partial' }) as { id: string }
    const files = await Promise.all(['red', 'blue'].map(async color => ({ name: `${color}.png`, mime: 'image/png', base64: (await sharp({ create: { width: 16, height: 16, channels: 3, background: color } }).png().toBuffer()).toString('base64'), role: 'positive', intent: 'overall', dimensions: [] })))
    await f.action('reference-import', { operationId: 'partial-images', styleId: created.id, expectedRevision: 1, files })
    const send = f.http.request.bind(f.http), ids: string[] = []
    let rejectSecond = true
    f.http.request = async (url, request) => {
      const input = JSON.parse(JSON.parse(Buffer.from(request.body!).toString('utf8')).messages[1].content[0].text).input
      if (input.operation === 'analyze') {
        ids.push(input.images[0].imageVersionId)
        if (ids.length === 2 && rejectSecond) throw new MediaError('remote-request-failed', 'reviewing', true, 'Transient provider failure.', 'Continue saved analysis.')
      }
      return send(url, request)
    }
    const first = await f.action('reference-analyze', { operationId: 'partial-first', styleId: created.id, buildDataset: true }) as { runId: string }
    await f.jobs.drain()
    assert.equal(dataOf(f.domain.require('run', first.runId)).counts.observed, 1)
    rejectSecond = false
    const next = await f.action('reference-analyze', { operationId: 'partial-next', styleId: created.id, buildDataset: true }) as { runId: string }
    await f.jobs.drain()
    const run = f.domain.require('run', next.runId)
    assert.equal(run.status, 'completed')
    assert.equal(dataOf(run).counts.observed, 2)
    assert.equal(ids.length, 3)
    assert.notEqual(ids[0], ids[2])
    assert.equal(ids[1], ids[2])
    const reused = z.array(z.object({ runId: z.string(), imageVersionId: z.string(), observationId: z.string() })).parse(specOf(run).fixed.reuseObservations)
    assert.equal(reused.length, 1)
    assert.equal(reused[0]!.runId, first.runId)
    assert.equal(reused[0]!.imageVersionId, ids[0])
    assert.equal(f.domain.require('observation', reused[0]!.observationId).imageVersionId, ids[0])
    assert.equal(f.repository.list('observation').length, 2)
  } finally { await f.cleanup() }
})
