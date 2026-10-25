import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import { serviceFixture } from './helpers/service-fixture.ts'
import { analysisDetailSchema } from '../src/shared/analysis-process.ts'
import { analysisRequests, readAnalysisInput } from '../src/host/analysis-input.ts'
import { dataOf, toJson } from '../src/host/runtime.ts'
import { requestSchema } from '../src/shared/model.ts'

test('saved analysis inputs match transmitted messages and preserve request identities without another model call', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const wire: { messages: { role: string; content: string | { type: string; text?: string }[] }[] }[] = []
    const send = f.http.request.bind(f.http)
    f.http.request = async (url, request) => { if (request.body && url.includes('vision')) wire.push(JSON.parse(Buffer.from(request.body).toString('utf8'))); return send(url, request) }
    const created = await f.action('style-create', { operationId: 'input-style', name: 'Input records' }) as { id: string }
    const bytes = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#536f53' } }).png().toBuffer()
    await f.action('reference-import', { operationId: 'input-images', styleId: created.id, expectedRevision: 1, files: [{ name: 'reference.png', mime: 'image/png', base64: bytes.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    const started = await f.action('reference-analyze', { operationId: 'input-analysis', styleId: created.id, buildDataset: true }) as { runId: string }
    await f.jobs.drain()
    const detail = analysisDetailSchema.parse(await f.action('analysis-detail', { runId: started.runId }))
    assert.equal(detail.requests.length, 2)
    assert.ok(!JSON.stringify(detail.requests).includes('instructions'))
    assert.ok(!JSON.stringify(detail.requests).includes('inputText'))
    const actual = []
    for (const [index, row] of detail.requests.entries()) {
      const saved = await f.action('analysis-input', { runId: started.runId, requestId: row.requestId }) as { instructions: string; inputText: string; images: { imageVersionId: string; previewPath: string; sourceKind: string }[] }
      const transmitted = wire[index]!
      assert.equal(saved.instructions, transmitted.messages[0]!.content)
      assert.equal(saved.inputText, (transmitted.messages[1]!.content as { text: string }[])[0]!.text)
      const descriptors = JSON.parse(saved.inputText).input.images as { imageVersionId: string }[]
      assert.deepEqual(saved.images.map(image => image.imageVersionId), descriptors.map(image => image.imageVersionId))
      assert.ok(saved.images.every(image => image.previewPath.startsWith('/api/visual-curator/resource?')))
      assert.equal(detail.process?.messages?.[index]?.requestId, row.requestId)
      assert.ok(!JSON.stringify(saved).includes('data:image'))
      actual.push({ operation: row.operation, state: row.state, available: row.available, imageCount: saved.images.length, sourceKind: saved.images[0]?.sourceKind })
    }
    assert.deepEqual(actual, JSON.parse(await readFile(new URL('./fixtures/analysis-input.expected.json', import.meta.url), 'utf8')))
    assert.equal(f.http.operations.length, 2)
    const route = await f.service.data(new Request('http://127.0.0.1/api/visual-curator/data', { method: 'POST', body: JSON.stringify({ operation: 'analysis-input', args: { runId: started.runId, requestId: detail.requests[0]!.requestId } }) }))
    assert.equal(route.status, 200)
    assert.equal((await route.json()).value.requestId, detail.requests[0]!.requestId)
    const run = f.domain.require('run', started.runId), request = f.domain.require('request', detail.requests[0]!.requestId)
    const legacy = requestSchema.parse({ ...request, id: 'legacy-request', state: 'outcome-unknown', data: {} })
    await f.repository.commit({ aggregateId: 'legacy-request-fixture', expectedRevision: 0, operationId: 'legacy-request-fixture', request: {}, records: [legacy], state: {} })
    const legacyRun = { ...run, data: toJson({ ...dataOf(run), requestIds: [legacy.id] }) }
    assert.equal(analysisRequests(f.domain, legacyRun)[0]?.available, false)
    assert.throws(() => readAnalysisInput(f.domain, legacyRun, legacy.id, f.actor), /historical|saved input/i)
    const wrongRun = { ...run, id: 'another-run' as typeof run.id, data: toJson({ ...dataOf(run), requestIds: [request.id] }) }
    assert.throws(() => readAnalysisInput(f.domain, wrongRun, request.id, f.actor), /unavailable|task/i)
    await assert.rejects(() => f.action('analysis-input', { runId: started.runId, requestId: 'foreign-request' }), /unavailable|belong|request/i)
    await assert.rejects(() => f.service.action({ operation: 'analysis-input', args: { runId: started.runId, requestId: detail.requests[0]!.requestId } }, { ...f.actor, profileId: 'foreign-profile' }, new AbortController().signal))
  } finally { await f.cleanup() }
})
