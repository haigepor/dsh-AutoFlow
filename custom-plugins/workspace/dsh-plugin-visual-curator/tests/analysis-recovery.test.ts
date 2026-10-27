/** Checkpoint continuation through the real service and provider decoder. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { serviceFixture } from './helpers/service-fixture.ts'
import { dataOf, specOf } from '../src/host/runtime.ts'
import { MediaError } from '../src/media/errors.ts'

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
    assert.deepEqual(specOf(run).fixed.reuseAnalysis, { runId: first.runId })
    assert.equal(f.repository.list('observation').length, 2)
  } finally { await f.cleanup() }
})
