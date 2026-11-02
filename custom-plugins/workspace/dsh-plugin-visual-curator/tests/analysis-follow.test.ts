import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { serviceFixture, FixtureJobs } from './helpers/service-fixture.ts'
import { analysisDetailSchema, analysisStreamFrameSchema } from '../src/shared/analysis-process.ts'
import { DomainRepository, MemoryDomainAdapter } from '../src/domain/repository.ts'
import { RunEngine, type WorkContext } from '../src/host/runtime.ts'
import { resolveCurrentConfig } from '../src/host/config.ts'
import { analysisFollowResponse } from '../src/host/analysis-follow.ts'

async function liveStream(t: TestContext) {
  const repository = new DomainRepository('stream-fixture', new MemoryDomainAdapter()), jobs = new FixtureJobs(), engine = new RunEngine(repository, jobs)
  const actor = { kind: 'human', id: 'stream-reader', profileId: 'stream-fixture' } as const
  let release!: () => void, entered!: () => void, context!: WorkContext
  const gate = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { entered = resolve })
  t.after(async () => { release(); await jobs.drain(); await engine.dispose() })
  const run = await engine.create({ kind: 'analyze', config: resolveCurrentConfig({ limits: { processPollIntervalMs: 100 } }), input: { styleId: 'stream-fixture' }, fixed: {}, specDigest: 'stream-fixture' }, actor, async ctx => { context = ctx; entered(); await gate; return 'target-met' })
  await ready
  const lifetime = new AbortController()
  const response = analysisFollowResponse(engine, engine.get(run.id, actor), actor, lifetime.signal), reader = response.body!.getReader()
  const next = async () => {
    const item = await reader.read()
    assert.equal(item.done, false)
    return analysisStreamFrameSchema.parse(JSON.parse(new TextDecoder().decode(item.value).slice(6).trim()))
  }
  return { context, reader, next, lifetime, release, engine, jobs, run, actor }
}

test('ordinary fragments share the configured interval while first content, checkpoints and completion remain immediate', async t => {
  const f = await liveStream(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  assert.equal((await f.next()).checkpoint, true)
  f.context.report({ phase: 'receiving', content: 'a', resetOutput: true })
  assert.equal((await f.next()).process?.content, 'a')
  let delivered = false
  const combined = f.next().then(frame => { delivered = true; return frame })
  for (const content of ['b', 'c']) { f.context.report({ phase: 'receiving', content }); await setImmediate() }
  t.mock.timers.tick(99); await setImmediate()
  assert.equal(delivered, false)
  t.mock.timers.tick(1)
  assert.equal((await combined).process?.content, 'abc')
  f.context.report({ phase: 'receiving', content: 'd' })
  await f.context.save('screening', { counts: { observed: 1 } })
  const checkpoint = await f.next()
  assert.equal(checkpoint.checkpoint, true); assert.equal(checkpoint.process?.content, 'abcd')
  f.context.report({ phase: 'receiving', content: 'e' })
  f.release(); await f.jobs.drain()
  let final = await f.next()
  if (final.status === 'running') final = await f.next()
  assert.equal(final.status, 'completed'); assert.equal(final.process?.content, 'abcde')
  assert.equal(final.checkpoint, true); assert.equal((await f.reader.read()).done, true)
  t.mock.timers.tick(1000)
})

test('backpressure keeps the latest snapshot and checkpoint marker until a reader resumes', async t => {
  const f = await liveStream(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await setImmediate()
  f.context.report({ phase: 'receiving', content: 'a', resetOutput: true })
  await f.context.save('screening', { counts: { observed: 1 } })
  f.context.report({ phase: 'receiving', content: 'b' }); await setImmediate()
  assert.equal((await f.next()).process?.content, '')
  const saved = await f.next()
  assert.equal(saved.process?.content, 'ab'); assert.equal(saved.checkpoint, true)
  await f.reader.cancel()
  assert.equal(f.engine.get(f.run.id, f.actor).status, 'running')
  t.mock.timers.tick(1000)
})

test('aborting observation with a coalesced update pending leaves the model task running', async t => {
  const f = await liveStream(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await f.next()
  f.context.report({ phase: 'receiving', content: 'a', resetOutput: true }); await f.next()
  f.context.report({ phase: 'receiving', content: 'b' })
  const reading = assert.rejects(f.reader.read(), { name: 'AbortError' })
  f.lifetime.abort(); await reading
  assert.equal(f.engine.get(f.run.id, f.actor).status, 'running')
  t.mock.timers.tick(1000)
})

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
