import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serviceFixture } from './helpers/service-fixture.ts'
import { analysisDetailSchema } from '../src/shared/analysis-process.ts'

test('live output reaches an authenticated reader before completion; reconnecting does not restart the model', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  let release!: () => void, entered!: () => void
  const done = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { entered = resolve })
  const send = f.http.request.bind(f.http)
  let calls = 0
  f.http.request = async (url, request) => {
    if (!url.includes('vision') || !request.body) return send(url, request)
    const body = JSON.parse(Buffer.from(request.body).toString('utf8'))
    const input = JSON.parse(body.messages[1].content[0].text).input
    if (input.operation !== 'analyze') return send(url, request)
    calls++
    const output = '```json\n' + JSON.stringify({ observations: input.images.map((image: { imageVersionId: string }) => ({ imageVersionId: image.imageVersionId, dimensions: [{ dimension: 'color', observation: '柔和绿色', uncertain: false }] })), ...(input.analysisOutput === 'observations-only' ? {} : { suggestedRules: [] }) }) + '\n```'
    const first = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '观察画面', content: output.slice(0, 30) } }] })}\n\n`
    request.onChunk?.(Buffer.from(first), 'text/event-stream'); entered()
    await done
    const last = `data: ${JSON.stringify({ choices: [{ delta: { content: output.slice(30) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
    request.onChunk?.(Buffer.from(last), 'text/event-stream')
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, bytes: Buffer.from(first + last) }
  }
  const follow = (runId: string) => f.service.followAnalysis(new Request('http://127.0.0.1/api/visual-curator/analysis-stream', { method: 'POST', body: JSON.stringify({ operation: 'analysis-follow', args: { runId } }) }))
  try {
    const style = await f.action('style-create', { operationId: 'follow-style', name: 'Live output' }) as { id: string }
    await f.action('reference-import', { operationId: 'follow-image', styleId: style.id, expectedRevision: 1, files: [{ name: 'saved.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    const started = await f.action('reference-analyze', { operationId: 'follow-analysis', styleId: style.id, buildDataset: true }) as { runId: string }
    await ready
    const response = await follow(started.runId)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type')!, /text\/event-stream/u)
    const reader = response.body!.getReader(), first = await reader.read()
    const frame = JSON.parse(new TextDecoder().decode(first.value).slice(6).trim())
    assert.equal(frame.status, 'running')
    assert.equal(frame.process.messages[0].state, 'streaming')
    assert.ok(frame.process.content.startsWith('```json'))
    await reader.cancel()
    assert.equal(calls, 1)
    const resumed = await follow(started.runId), resumedReader = resumed.body!.getReader()
    await resumedReader.read()
    release()
    let terminal
    for (;;) { const item = await resumedReader.read(); if (item.done) break; terminal = JSON.parse(new TextDecoder().decode(item.value).slice(6).trim()) }
    assert.equal(terminal.status, 'completed')
    assert.equal(terminal.checkpoint, true)
    await f.jobs.drain()
    const detail = analysisDetailSchema.parse(await f.action('analysis-detail', { runId: started.runId }))
    assert.equal(detail.observations.length, 1)
    assert.ok(detail.summary)
    assert.equal(calls, 1)
    assert.equal((await follow('missing-task')).status, 400)
  } finally { release(); await f.cleanup() }
})
