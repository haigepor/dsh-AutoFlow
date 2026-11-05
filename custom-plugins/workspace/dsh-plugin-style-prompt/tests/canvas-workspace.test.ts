/** Client state regressions use the actual wire parser with controlled response ordering. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { createCanvasTransport, createCanvasWorkspace } from '../src/client/canvas-workspace.ts'
import { canvasActionSchema, canvasId, nodeId, runId, newNode, starterCanvas, type CanvasDocument, type CanvasRun } from '../src/shared/canvas.ts'
import { actionSchema } from '../src/shared/model.ts'
import { canvasInputIssues } from '../src/shared/canvas-validation.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function draft(id: string): CanvasDocument {
  const document = starterCanvas(canvasId.parse(id))
  document.revision = 1
  document.nodes = document.nodes.filter(node => node.kind === 'image' || node.kind === 'brief')
  document.nodes = document.nodes.map(node => node.kind === 'image' ? { ...node, route: { provider: 'fixture', model: 'image' }, prompt: 'A canvas test' } : node)
  document.edges = []
  return document
}
function execution(document: CanvasDocument, id: string): CanvasRun {
  return { formatVersion: 1, id: runId.parse(id), canvasId: document.id, document: structuredClone(document), targets: [nodeId.parse('node-6')], createdAt: '2026-11-05T01:00:00.000Z', updatedAt: '2026-11-05T01:00:00.000Z', status: 'running', failure: null, nodes: [{ nodeId: nodeId.parse('node-6'), status: 'running', fingerprint: '', inputKey: '', taskId: null, analysisId: null, selectedRuleIds: [], images: [], originals: [], imageRequest: null, failure: null }] }
}
async function fixture() {
  const documents = new Map([['a', draft('a')], ['b', draft('b')]])
  const runs = new Map<string, CanvasRun>(), saves: CanvasDocument[] = []
  let failAdmission = false
  let admit: ReturnType<typeof deferred<unknown>> | undefined, polled: ReturnType<typeof deferred<unknown>> | undefined, failSave = false
  const events = { admitted: deferred<CanvasRun>(), polling: deferred<void>() }
  const fetcher: typeof fetch = async (_input, init) => {
    const action = z.union([canvasActionSchema, actionSchema]).parse(JSON.parse(String(init?.body)))
    let value: unknown
    switch (action.operation) {
      case 'canvas/list': value = { healthy: true, documents: [...documents.values()].map(({ nodes: _nodes, edges: _edges, ...summary }) => summary), activeRuns: [...runs.values()].filter(run => run.status === 'running'), limits: { saveDelayMs: 10, pollIntervalMs: 60_000, maxCanvasFileBytes: 16 * 1024 * 1024 } }; break
      case 'canvas/models': value = { models: [], textModels: [], failures: [] }; break
      case 'list': value = { healthy: true, tasks: [], limits: { maxImages: 4, maxImageBytes: 8 * 1024 ** 2, maxUploadBytes: 32 * 1024 ** 2, pollIntervalMs: 60_000 } }; break
      case 'canvas/get': value = { document: documents.get(action.id), assets: [], runs: [...runs.values()].filter(run => run.canvasId === action.id) }; break
      case 'canvas/save': {
        if (failSave) throw new TypeError('offline')
        const saved = { ...structuredClone(action.document), revision: action.expectedRevision + 1 }
        documents.set(saved.id, saved); saves.push(saved); value = saved; break
      }
      case 'canvas/run': {
        const run = runs.get(action.id) ?? execution(action.document, action.id); runs.set(run.id, run); events.admitted.resolve(run)
        if (failAdmission) { failAdmission = false; throw new TypeError('lost admission response') }
        value = admit ? await admit.promise : run; break
      }
      case 'canvas/run-get': {
        const run = structuredClone(runs.get(action.id)); events.polling.resolve()
        value = polled ? await polled.promise : run; break
      }
      case 'canvas/cancel': {
        const run = runs.get(action.id)!
        const cancelled: CanvasRun = { ...run, status: 'cancelled', nodes: run.nodes.map(node => ({ ...node, status: 'cancelled' })) }
        runs.set(run.id, cancelled); value = cancelled; break
      }
      case 'canvas/import': {
        const document = { ...action.bundle.document, id: action.canvasId, revision: 1 }
        documents.set(document.id, document); value = document; break
      }
      default: throw new Error(`Unexpected request: ${action.operation}`)
    }
    return new Response(JSON.stringify({ ok: true, value }), { headers: { 'content-type': 'application/json' } })
  }
  const workspace = createCanvasWorkspace(createCanvasTransport({ baseUrl: 'http://fixture.test/', fetch: fetcher }), 'Untitled')
  await workspace.refresh()
  return { workspace, documents, runs, saves, events, holdAdmission() { admit = deferred(); return admit }, holdPoll() { polled = deferred(); return polled }, failSaving(value: boolean) { failSave = value }, loseAdmission() { failAdmission = true } }
}

test('a delayed admission remains attached to its source canvas after switching', async t => {
  const f = await fixture(); t.after(() => f.workspace.dispose())
  const held = f.holdAdmission(), submitting = f.workspace.run([nodeId.parse('node-6')])
  const accepted = await f.events.admitted.promise
  assert.deepEqual(f.workspace.getSnapshot().admitting, ['a'])
  await f.workspace.open(canvasId.parse('b'))
  held.resolve(accepted); assert.equal(await submitting, true)
  const state = f.workspace.getSnapshot()
  assert.equal(state.document?.id, 'b'); assert.deepEqual(state.runs, [])
  assert.equal(state.activeRuns[0]?.canvasId, 'a'); assert.deepEqual(state.admitting, [])
})

test('a late running poll cannot revive a cancelled execution', async t => {
  const f = await fixture(); t.after(() => f.workspace.dispose())
  await f.workspace.run([nodeId.parse('node-6')])
  const accepted = f.workspace.getSnapshot().runs[0]!, held = f.holdPoll()
  const polling = f.workspace.refreshRuns(); await f.events.polling.promise
  await f.workspace.cancel(accepted.id)
  assert.equal(f.workspace.getSnapshot().runs[0]?.status, 'cancelled')
  held.resolve(accepted); await polling
  assert.equal(f.workspace.getSnapshot().runs[0]?.status, 'cancelled')
  assert.deepEqual(f.workspace.getSnapshot().activeRuns, [])
})

test('keyboard movement saves automatically and one key gesture undoes as a unit', async t => {
  const f = await fixture(); t.after(() => f.workspace.dispose())
  const id = nodeId.parse('node-6'), initial = f.workspace.getSnapshot().document!.nodes.find(node => node.id === id)!.position
  f.workspace.move(id, { ...initial, x: initial.x + 5 }); f.workspace.move(id, { ...initial, x: initial.x + 10 }); f.workspace.endKeyboardMove()
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { unsubscribe(); reject(new Error('Movement was not saved')) }, 1500); const unsubscribe = f.workspace.subscribe(() => { if (!f.workspace.getSnapshot().dirty) { clearTimeout(timer); unsubscribe(); resolve() } }) })
  assert.equal(f.documents.get('a')?.nodes.find(node => node.id === id)?.position.x, initial.x + 10)
  assert.equal(f.workspace.getSnapshot().dirty, false)
  f.workspace.undo(); await f.workspace.save()
  assert.deepEqual(f.documents.get('a')?.nodes.find(node => node.id === id)?.position, initial)
  f.workspace.redo(); await f.workspace.save()
  assert.equal(f.documents.get('a')?.nodes.find(node => node.id === id)?.position.x, initial.x + 10)
})

test('running from history returns to the live draft and preserves the old snapshot', async t => {
  const f = await fixture(); t.after(() => f.workspace.dispose())
  const old = { ...execution(f.documents.get('a')!, 'old-run'), status: 'cancelled' as const }
  f.runs.set(old.id, old); await f.workspace.open(canvasId.parse('a'))
  f.workspace.inspect(old.id)
  f.workspace.changeNode(nodeId.parse('node-6'), node => node.kind === 'image' ? { ...node, prompt: 'Cannot edit history' } : node)
  assert.equal(f.workspace.getSnapshot().document?.nodes.find(node => node.kind === 'image')?.prompt, 'A canvas test')
  await f.workspace.run([nodeId.parse('node-6')])
  assert.equal(f.workspace.getSnapshot().inspection, null)
  assert.equal(f.workspace.getSnapshot().runs[0]?.status, 'running')
  assert.equal(f.runs.get(old.id)?.status, 'cancelled')
})

test('failed autosave retains the draft with a connection error and recovers on retry', async t => {
  const f = await fixture(); t.after(() => f.workspace.dispose())
  f.failSaving(true); f.workspace.rename('Kept offline draft')
  assert.equal(await f.workspace.save(), false)
  assert.equal(f.workspace.getSnapshot().saveError, 'connection-error')
  assert.equal(f.workspace.getSnapshot().document?.name, 'Kept offline draft')
  assert.equal(f.workspace.getSnapshot().dirty, true)
  f.failSaving(false); assert.equal(await f.workspace.save(), true)
  assert.equal(f.workspace.getSnapshot().saveError, null); assert.equal(f.workspace.getSnapshot().dirty, false)
})

test('portable canvases larger than 2 MiB use the advertised file limit', async t => {
  const f = await fixture(); t.after(() => f.workspace.dispose())
  const document = draft('large')
  document.nodes = Array.from({ length: 280 }, (_, index) => ({ ...newNode('image', nodeId.parse(`image-${index}`), { x: 0, y: 0 }), kind: 'image' as const, route: null, prompt: 'x'.repeat(8000), variant: -1, size: 'auto' as const, quality: 'auto' as const }))
  const text = JSON.stringify({ formatVersion: 1, exportType: 'style-prompt-canvas', document, assets: [] })
  assert.ok(Buffer.byteLength(text) > 2 * 1024 ** 2)
  assert.equal(await f.workspace.importCanvas(new File([text], 'canvas.json', { type: 'application/json' })), true)
  assert.equal(f.workspace.getSnapshot().document?.nodes.length, 280)
  assert.equal(f.workspace.getSnapshot().notice?.key, 'canvas.notice.imported')
})

test('quick prompt validation locates the two English fields on their owning brief', () => {
  const document = starterCanvas(canvasId.parse('fields'))
  document.nodes = document.nodes.map(node => node.kind === 'prompt' ? { ...node, mode: 'quick' } : node)
  const issues = canvasInputIssues(document, [nodeId.parse('node-5')])
  assert.deepEqual(issues.filter(issue => issue.kind === 'english').map(issue => ({ nodeId: issue.nodeId, field: issue.field })), [{ nodeId: 'node-4', field: 'brief.en' }, { nodeId: 'node-4', field: 'changes.en' }])
  assert.deepEqual(issues.filter(issue => issue.kind === 'brief').map(issue => issue.field), ['brief.zh', 'changes.zh'])
})


test('retrying a lost admission reads its completed run without submitting another execution', async t => {
  const f = await fixture(); t.after(() => f.workspace.dispose())
  f.loseAdmission()
  assert.equal(await f.workspace.run([nodeId.parse('node-6')]), false)
  const accepted = [...f.runs.values()][0]!
  f.runs.set(accepted.id, { ...accepted, status: 'succeeded', nodes: accepted.nodes.map(node => ({ ...node, status: 'succeeded' })) })
  assert.equal(await f.workspace.run([nodeId.parse('node-6')]), true)
  assert.equal(f.runs.size, 1)
  assert.equal(f.workspace.getSnapshot().runs[0]?.id, accepted.id)
  assert.equal(f.workspace.getSnapshot().runs[0]?.status, 'succeeded')
  assert.equal(f.workspace.getSnapshot().notice?.key, 'canvas.notice.completedContext')
  assert.deepEqual(f.workspace.getSnapshot().activeRuns, [])
})
