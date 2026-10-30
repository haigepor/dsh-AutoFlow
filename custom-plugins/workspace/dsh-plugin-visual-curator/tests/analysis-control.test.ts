/** Analysis controls acknowledge durable intent before a pending provider finishes cleanup. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { z } from 'zod'
import sharp from 'sharp'
import { serviceFixture } from './helpers/service-fixture.ts'
import { dataOf } from '../src/host/runtime.ts'
import { MediaError } from '../src/media/errors.ts'
import { analysisDetailSchema } from '../src/shared/analysis-process.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}

test('a failed summary exposes its cause and continues the same task without repeating saved observations', async () => {
  const f = await serviceFixture(undefined, { maxRetryAttempts: 0 }), send = f.http.request.bind(f.http)
  let fail = true, analyses = 0, summaries = 0
  f.http.request = async (url, input) => {
    if (url.includes('vision') && input.body) {
      const body = JSON.parse(Buffer.from(input.body).toString('utf8'))
      const operation = JSON.parse(body.messages[1].content[0].text).input.operation
      if (operation === 'analyze') analyses++
      if (operation === 'summarize') { summaries++; if (fail) throw new MediaError('request-timeout', 'reviewing', true, 'The model request timed out.', 'Continue from the saved checkpoint.') }
    }
    return send(url, input)
  }
  try {
    await f.service.initialize()
    const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'failed-summary-style', name: 'Summary recovery' }))
    await f.action('reference-import', { operationId: 'failed-summary-image', styleId, expectedRevision: 1, files: [{ name: 'reference.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    const { runId } = z.object({ runId: z.string() }).parse(await f.action('reference-analyze', { operationId: 'failed-summary-run', styleId, buildDataset: true }))
    await f.jobs.drain()
    const failed = f.domain.require('run', runId), checkpoint = dataOf(failed)
    const before = analysisDetailSchema.parse(await f.action('analysis-detail', { runId }))
    assert.equal(before.task.status, 'failed')
    assert.equal(z.object({ error: z.object({ code: z.string() }) }).parse(before.requests.at(-1)).error.code, 'request-timeout')
    fail = false
    await f.action('analysis-resume', { runId }); await f.jobs.drain()
    const complete = f.domain.require('run', runId), result = analysisDetailSchema.parse(await f.action('analysis-detail', { runId }))
    assert.equal(complete.status, 'completed')
    assert.equal(complete.outcome, 'target-met')
    assert.equal(result.observations.length, 1)
    assert.deepEqual(dataOf(complete).checkpoint.analysisResultIds, checkpoint.checkpoint.analysisResultIds)
    assert.equal(dataOf(complete).budget.deadlineAt, checkpoint.budget.deadlineAt)
    assert.ok(dataOf(complete).budget.vision > checkpoint.budget.vision)
    assert.equal(dataOf(complete).error, undefined)
    assert.equal(analyses, 1); assert.equal(summaries, 2)
    assert.equal(z.object({ error: z.object({ code: z.string() }) }).parse(result.requests[1]).error.code, 'request-timeout')
    await assert.rejects(f.action('analysis-resume', { runId }), { code: 'invalid-input' })
  } finally { await f.cleanup() }
})

test('continuing a failed image batch keeps earlier observations and saves later checkpoints', async () => {
  const f = await serviceFixture(undefined, { maxReferenceImages: 1, maxRetryAttempts: 0 }), send = f.http.request.bind(f.http)
  const analyzed: string[] = []
  let fail = true
  f.http.request = async (url, input) => {
    if (url.includes('vision') && input.body) {
      const body = JSON.parse(Buffer.from(input.body).toString('utf8')), prompt = JSON.parse(body.messages[1].content[0].text).input
      if (prompt.operation === 'analyze') { analyzed.push(prompt.images[0].imageVersionId); if (analyzed.length === 2 && fail) throw new MediaError('request-timeout', 'reviewing', true, 'Timed out', 'Continue analysis') }
    }
    return send(url, input)
  }
  try {
    await f.service.initialize()
    const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'partial-failure-style', name: 'Partial recovery' }))
    const files = await Promise.all(['red', 'blue'].map(async color => ({ name: `${color}.png`, mime: 'image/png', base64: (await sharp({ create: { width: 16, height: 16, channels: 3, background: color } }).png().toBuffer()).toString('base64'), role: 'positive', intent: 'overall', dimensions: [] })))
    await f.action('reference-import', { operationId: 'partial-failure-images', styleId, expectedRevision: 1, files })
    const { runId } = z.object({ runId: z.string() }).parse(await f.action('reference-analyze', { operationId: 'partial-failure-run', styleId, buildDataset: true }))
    await f.jobs.drain()
    const before = dataOf(f.domain.require('run', runId)), saved = f.repository.list('observation')[0]!
    assert.equal(before.counts.observed, 1)
    fail = false
    await f.action('analysis-resume', { runId }); await f.jobs.drain()
    const result = f.domain.require('run', runId), after = dataOf(result)
    assert.equal(result.status, 'completed'); assert.equal(after.counts.observed, 2)
    assert.equal(analyzed.filter(imageId => imageId === saved.imageVersionId).length, 1)
    assert.ok(f.repository.list('observation').some(observation => observation.id === saved.id))
    assert.equal(after.checkpoint.analysisRetryAfterRequestId, before.requestIds.at(-1))
    assert.equal(after.budget.deadlineAt, before.budget.deadlineAt)
  } finally { await f.cleanup() }
})

test('cancel returns its accepted state while provider cleanup is still pending', { timeout: 10_000 }, async () => {
  const command = 'cancel'
  const fixture = await serviceFixture(), entered = deferred(), aborted = deferred(), release = deferred()
  const request = fixture.http.request.bind(fixture.http)
  fixture.http.request = async (url, input) => {
    if (url.startsWith('https://vision.example.test')) {
      input.signal?.addEventListener('abort', () => aborted.resolve(), { once: true })
      entered.resolve()
      // 上游收到中止后仍可能等待清理；控制回执不能与该等待绑定。
      await release.promise
    }
    return request(url, input)
  }
  let pending: Promise<unknown> | undefined
  try {
    await fixture.service.initialize()
    const style = z.object({ id: z.string() }).parse(await fixture.action('style-create', { operationId: 'control-style', name: 'Control fixture' }))
    await fixture.action('reference-import', { operationId: 'control-image', styleId: style.id, expectedRevision: 1, files: [{ name: 'control.png', mime: 'image/png', base64: fixture.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    const run = z.object({ runId: z.string() }).parse(await fixture.action('reference-analyze', { operationId: 'control-analysis', styleId: style.id }))
    await entered.promise
    let acknowledged = false
    pending = fixture.action('run-control', { runId: run.runId, command, waitForCompletion: false }).then(value => { acknowledged = true; return value })
    await aborted.promise
    await setImmediate()
    assert.equal(acknowledged, true, 'Control must acknowledge before the blocked provider is released')
    const receipt = z.object({ status: z.string() }).parse(await pending)
    assert.equal(receipt.status, 'cancelling')
    const later = z.object({ status: z.string() }).parse(await fixture.action('run-control', { runId: run.runId, command: 'pause', waitForCompletion: false }))
    assert.equal(later.status, 'cancelling', 'A late pause cannot weaken an accepted cancellation')
    release.resolve()
    await fixture.jobs.drain()
    assert.equal(fixture.domain.require('run', run.runId).status, 'cancelled')
    assert.equal(fixture.repository.list('observation').length, 0)
  } finally {
    release.resolve()
    await pending
    await fixture.cleanup()
  }
})

test('analysis pause commits the current batch and resumes the same task without requesting committed images again', { timeout: 15_000 }, async () => {
  const fixture = await serviceFixture(undefined, { maxReferenceImages: 1 }), entered = deferred(), release = deferred()
  const request = fixture.http.request.bind(fixture.http)
  let dispatched = 0, aborted = false
  fixture.http.request = async (url, input) => {
    if (url.startsWith('https://vision.example.test') && ++dispatched === 1) {
      input.signal?.addEventListener('abort', () => { aborted = true }, { once: true })
      entered.resolve()
      await release.promise
    }
    return request(url, input)
  }
  try {
    await fixture.service.initialize()
    const style = z.object({ id: z.string() }).parse(await fixture.action('style-create', { operationId: 'cooperative-style', name: 'Cooperative pause' }))
    const files = await Promise.all(['red', 'blue'].map(async color => ({ name: `${color}.png`, mime: 'image/png', base64: (await sharp({ create: { width: 16, height: 16, channels: 3, background: color } }).png().toBuffer()).toString('base64'), role: 'positive', intent: 'overall', dimensions: [] })))
    await fixture.action('reference-import', { operationId: 'cooperative-images', styleId: style.id, expectedRevision: 1, files })
    const run = z.object({ runId: z.string() }).parse(await fixture.action('reference-analyze', { operationId: 'cooperative-analysis', styleId: style.id, buildDataset: true }))
    await entered.promise
    const pausing = z.object({ runId: z.string(), status: z.string() }).parse(await fixture.action('analysis-pause', { runId: run.runId }))
    assert.equal(pausing.runId, run.runId)
    assert.equal(pausing.status, 'pausing')
    assert.equal(aborted, false, 'Pausing lets the already admitted request finish')
    assert.equal(dispatched, 1)
    release.resolve()
    await fixture.jobs.drain()
    const paused = fixture.domain.require('run', run.runId)
    assert.equal(paused.status, 'paused')
    assert.equal(dataOf(paused).autoResume, false)
    assert.equal(dataOf(paused).counts.observed, 1)
    assert.equal(dataOf(paused).budget.vision, 1)
    assert.equal(dataOf(paused).process?.phase, 'paused')
    const retained = fixture.repository.list('observation')[0]!
    assert.equal(fixture.repository.list('request').filter(item => item.runId === run.runId && item.state === 'committed').length, 1)
    const continued = z.object({ runId: z.string() }).parse(await fixture.action('analysis-resume', { runId: run.runId }))
    assert.equal(continued.runId, run.runId)
    await fixture.jobs.drain()
    const complete = fixture.domain.require('run', run.runId)
    assert.equal(complete.status, 'completed')
    assert.equal(dataOf(complete).counts.observed, 2)
    assert.equal(dataOf(complete).attempts, 2)
    assert.equal(dataOf(complete).budget.vision, 3)
    assert.equal(dispatched, 3, 'Only two observation requests and one summary are paid')
    assert.deepEqual(fixture.repository.get('observation', retained.id), retained)
    assert.equal(fixture.repository.list('observation').length, 2)
    assert.equal(fixture.repository.list('run').length, 1)
  } finally { release.resolve(); await fixture.cleanup() }
})

test('cancellation aborts a request after a cooperative pause has been accepted', { timeout: 10_000 }, async () => {
  const fixture = await serviceFixture(), entered = deferred(), release = deferred(), aborted = deferred()
  const request = fixture.http.request.bind(fixture.http)
  fixture.http.request = async (url, input) => {
    if (url.startsWith('https://vision.example.test')) {
      input.signal?.addEventListener('abort', () => aborted.resolve(), { once: true })
      entered.resolve()
      await release.promise
    }
    return request(url, input)
  }
  try {
    await fixture.service.initialize()
    const style = z.object({ id: z.string() }).parse(await fixture.action('style-create', { operationId: 'override-style', name: 'Cancel paused request' }))
    await fixture.action('reference-import', { operationId: 'override-image', styleId: style.id, expectedRevision: 1, files: [{ name: 'override.png', mime: 'image/png', base64: fixture.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    const run = z.object({ runId: z.string() }).parse(await fixture.action('reference-analyze', { operationId: 'override-analysis', styleId: style.id }))
    await entered.promise
    await fixture.action('analysis-pause', { runId: run.runId })
    await fixture.action('analysis-stop', { runId: run.runId })
    await aborted.promise
    release.resolve()
    await fixture.jobs.drain()
    assert.equal(fixture.domain.require('run', run.runId).status, 'cancelled')
    assert.equal(fixture.repository.list('request')[0]?.state, 'outcome-unknown')
    assert.equal(fixture.repository.list('observation').length, 0)
  } finally { release.resolve(); await fixture.cleanup() }
})
