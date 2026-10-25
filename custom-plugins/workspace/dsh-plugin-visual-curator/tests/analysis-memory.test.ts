/** Local reference pixels are read for one model batch, not retained for the whole collection. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { AssetFiles } from '../src/media/index.ts'
import { dataOf } from '../src/host/runtime.ts'
import { serviceFixture } from './helpers/service-fixture.ts'

test('local analysis reads at most the current batch and cancellation leaves later pixels unread', { timeout: 15_000 }, async t => {
  const fixture = await serviceFixture(undefined, { maxReferenceImages: 2 })
  const originalRead = AssetFiles.prototype.read, originalRequest = fixture.http.request
  const paths = new Set<string>()
  let tracking = false, localReads = 0, modelRequests = 0
  let firstRequest!: (value: number) => void
  const entered = new Promise<number>(resolve => { firstRequest = resolve })
  t.after(async () => {
    try { await fixture.cleanup() }
    finally { AssetFiles.prototype.read = originalRead; fixture.http.request = originalRequest }
  })
  // Node 的 test 文件各自运行于独立进程；此钩子只统计本测试选择的本地路径，并在清理排空后恢复。
  AssetFiles.prototype.read = async function(blob, signal) {
    if (tracking && blob.localSource && paths.has(blob.localSource.path)) localReads++
    return await originalRead.call(this, blob, signal)
  }
  fixture.http.request = async (url, request) => {
    if (!url.startsWith('https://vision.example.test/')) return await originalRequest.call(fixture.http, url, request)
    modelRequests++
    if (!request.signal) throw new Error('Expected a cancellable model request')
    const signal = request.signal
    firstRequest(localReads)
    return await new Promise<never>((_resolve, reject) => {
      const abort = () => reject(signal.reason)
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
  }
  await fixture.service.initialize()
  const styleId = z.object({ id: z.string() }).parse(await fixture.action('style-create', { operationId: 'bounded-local-style', name: 'Bounded local references' })).id
  const files = []
  for (let index = 0; index < 5; index++) {
    const path = join(fixture.root, `local-${index}.png`)
    await writeFile(path, await sharp({ create: { width: 80 + index, height: 80, channels: 3, background: { r: 40 + index, g: 100, b: 120 } } }).png().toBuffer())
    paths.add(path)
    files.push({ path, name: `local-${index}.png` })
  }
  await fixture.action('reference-local-import', { operationId: 'bounded-local-import', styleId, expectedRevision: 1, role: 'positive', files })
  assert.equal(fixture.domain.require('draft', fixture.domain.require('style', styleId).draftId).referenceIds.length, 5)
  tracking = true
  const runId = z.object({ runId: z.string() }).parse(await fixture.action('reference-analyze', { operationId: 'bounded-local-analyze', styleId, buildDataset: true })).runId
  const readsBeforeFirstRequest = await Promise.race([entered, fixture.jobs.drain().then(() => { throw new Error('Analysis settled before its first model request') })])
  await fixture.action('analysis-stop', { runId })
  await fixture.jobs.drain()
  const run = fixture.domain.require('run', runId)
  assert.equal(run.status, 'cancelled')
  assert.equal(dataOf(run).autoResume, false)
  assert.equal(modelRequests, 1)
  assert.equal(localReads, readsBeforeFirstRequest, 'cancel must not dispatch or read later batches')
  assert.ok(readsBeforeFirstRequest <= 2, `only two references fit the first request, but ${readsBeforeFirstRequest} local images were read`)
})
