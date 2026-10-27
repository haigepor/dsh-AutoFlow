import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCuratorStore } from '../src/client/store.ts'
import { createCuratorTransport } from '../src/client/transport.ts'
import { analysisDetailSchema, type AnalysisStreamFrame } from '../src/shared/analysis-process.ts'
import { createWorkbenchSelector } from '../src/client/workbench-state.ts'

const process = (content: string) => ({ phase: 'receiving' as const, events: [], content, reasoning: '', messages: [{ sequence: 0, kind: 'analysis' as const, batch: 1, imageIds: [], content, reasoning: '', state: 'streaming' as const, at: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:01Z' }], updatedAt: '2026-10-27T00:00:01Z', truncated: false })
const detail = () => analysisDetailSchema.parse({ task: { runId: 'live', styleId: 's', name: 'Live', status: 'running', observed: 0, total: 1, model: 'fixture', reasoningEffort: null, attempts: 1, startedAt: 'now', phase: 'analyzing', autoResume: true }, observations: [] })
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

test('live frames render before completion and closing the dialog aborts observation without cancelling the model', async () => {
  let receive!: (frame: AnalysisStreamFrame) => void, signal!: AbortSignal, reads = 0
  const operations: string[] = []
  const store = createCuratorStore({ invoke: async operation => { operations.push(operation); reads++; return detail() }, followAnalysis: async (_args, callback, lifetime) => {
    receive = callback; signal = lifetime
    await new Promise<void>(resolve => lifetime.addEventListener('abort', () => resolve(), { once: true }))
  } })
  try {
    store.openAnalysis('live'); await store.refreshAnalysisDetail(); await tick()
    const before = reads
    receive({ runId: 'live', status: 'running', checkpoint: false, process: process('第一段') })
    assert.equal(store.getSnapshot().analysisStreaming, true)
    assert.equal(store.getSnapshot().analysisDetail?.process?.content, '第一段')
    receive({ runId: 'live', status: 'running', checkpoint: false, process: process('第一段，第二段') })
    assert.equal(store.getSnapshot().analysisDetail?.process?.content, '第一段，第二段')
    assert.equal(reads, before, 'Token updates must not reload committed results or image lists')
    receive({ runId: 'live', status: 'running', checkpoint: true, process: process('完整输出') }); await tick(); await tick()
    assert.ok(reads > before)
    store.closeAnalysis()
    assert.equal(signal.aborted, true)
    assert.equal(store.getSnapshot().analysisStreaming, false)
    assert.ok(operations.every(operation => operation === 'analysis-detail'))
    receive({ runId: 'live', status: 'failed', checkpoint: true, process: process('迟到输出') })
    assert.equal(store.getSnapshot().analysisDetail, null)
  } finally { store.dispose() }
})

test('native SSE transport decodes split UTF-8 frames before the HTTP response closes', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>, endpoint = '', requestSignal: AbortSignal | undefined
  const lifetime = new AbortController(), observed: AnalysisStreamFrame[] = []
  const transport = createCuratorTransport({ action: async () => { throw new Error('Streams must not use action RPC') }, baseUrl: 'http://127.0.0.1:3080/', signal: lifetime.signal,
    fetch: async (url, init) => {
      endpoint = String(url); requestSignal = init?.signal ?? undefined
      assert.equal(init?.credentials, 'same-origin')
      assert.equal(JSON.parse(String(init?.body)).operation, 'analysis-follow')
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller } }), { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const reading = transport.followAnalysis!({ runId: 'live' }, frame => observed.push(frame), lifetime.signal)
  await tick()
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ runId: 'live', status: 'running', checkpoint: false, process: process('实时内容') })}\r\n\r\n`)
  for (const byte of bytes) stream.enqueue(new Uint8Array([byte]))
  await tick()
  assert.equal(observed[0]?.process?.content, '实时内容')
  assert.ok(endpoint.endsWith('/api/visual-curator/analysis-stream'))
  stream.close(); await reading
  assert.equal(requestSignal?.aborted, true, 'The request lifetime is released on EOF')
})

test('five hundred streamed updates change the dialog without replacing the gallery snapshot', async () => {
  let receive!: (frame: AnalysisStreamFrame) => void
  const store = createCuratorStore({ invoke: async () => detail(), followAnalysis: async (_args, callback, signal) => {
    receive = callback
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  } })
  const select = createWorkbenchSelector()
  let last = select(store.getSnapshot()), galleryChanges = 0
  const unsubscribe = store.subscribe(() => { const next = select(store.getSnapshot()); if (next !== last) galleryChanges++; last = next })
  try {
    store.openAnalysis('live'); await store.refreshAnalysisDetail(); await tick()
    const before = galleryChanges
    for (let index = 0; index < 500; index++) receive({ runId: 'live', status: 'running', checkpoint: false, process: process(`输出 ${index}`) })
    assert.equal(galleryChanges, before)
    assert.equal(store.getSnapshot().analysisDetail?.process?.content, '输出 499')
    store.selectWorkspace('tasks')
    assert.equal(galleryChanges, before + 1, 'Real workspace changes must remain observable')
  } finally { unsubscribe(); store.dispose() }
})
