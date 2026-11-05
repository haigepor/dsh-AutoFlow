/** Graph execution exercises real task admission and LLM routing with deterministic external model output. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, LlmError, type GenerateOptions, type StreamChunk, type ImageGenerationRequest } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { canvasId, nodeId, assetId, runId, starterCanvas, nodeFingerprint, canConnect, validateCanvas, newNode, canvasSchema, canvasAssetInventorySchema, canvasRunSchema, type CanvasDocument, type CanvasAsset, type CanvasRun, type CanvasId, type AssetId, type RunId } from '../src/shared/canvas.ts'
import { CanvasService } from '../src/host/canvas-service.ts'
import { StylePromptService } from '../src/host/service.ts'
import type { CanvasRepository } from '../src/host/canvas-repository.ts'
import { Config } from '../src/host/config.ts'
import { taskIdSchema } from '../src/shared/model.ts'
import { compileQuick } from '../src/shared/compose.ts'
import { observation, newInput, memoryRepository, pixels, route } from './fixture.ts'
import { enCanvas, zhCanvas } from '../src/client/canvas-locale.ts'

function memoryCanvas(): CanvasRepository {
  const documents = new Map<CanvasId, CanvasDocument>(), assets = new Map<AssetId, CanvasAsset>(), runs = new Map<RunId, CanvasRun>()
  return { documents: () => structuredClone([...documents.values()]), document: id => structuredClone(documents.get(id)), saveDocument: async value => { documents.set(value.id, structuredClone(value)) }, deleteDocument: async id => { documents.delete(id) }, assets: () => structuredClone([...assets.values()]), asset: id => structuredClone(assets.get(id)), saveAsset: async value => { assets.set(value.id, structuredClone(value)) }, deleteAsset: async id => { assets.delete(id) }, runs: () => structuredClone([...runs.values()]), run: id => structuredClone(runs.get(id)), saveRun: async value => { runs.set(value.id, structuredClone(value)) }, deleteRun: async id => { runs.delete(id) }, close: async () => {} }
}
class Adapter extends LlmAdapter {
  analyses = 0
  prompts = 0
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, inputModalities: model === 'vision' ? ['image', 'text'] as const : ['text'] as const } }
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const image = options.messages.some(message => message.content.some(block => block.type === 'image'))
    if (image) this.analyses++; else this.prompts++
    const base = compileQuick(observation, newInput())
    const input = options.messages[0]?.content.find(block => block.type === 'text')
    const brief = !image && input?.type === 'text' ? String(JSON.parse(input.text).targetBrief.en) : ''
    const result = image ? observation : { ...base, fullPrompt: { zh: brief, en: brief }, variants: [0, 1, 2].map(index => ({ title: { zh: `方案 ${index}`, en: `Variant ${index}` }, prompt: { zh: `方案 ${index}`, en: `Variant ${index}` }, changes: [{ zh: '更换构图', en: 'Change composition' }] })) }
    yield { type: 'text-delta', index: 0, text: JSON.stringify(result) }; yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
async function fixture(configInput: Partial<Config> = {}) {
  const ctx = new Context(), llm = new LlmRuntime(ctx), adapter = new Adapter(), tasks = memoryRepository(), repository = memoryCanvas()
  const unregister = llm.registerAdapter([route.provider], adapter)
  const preview = { attachmentId: AttachmentId('canvas-image'), mediaType: 'image/png' as const, bytes: pixels.length, width: 32, height: 24, name: 'image.png' }
  const attachments = { saveImages: async (images: readonly { name?: string }[]) => images.map(image => ({ ...preview, ...(image.name ? { name: image.name } : {}) })), readImage: async () => ({ data: pixels, ref: preview }) }
  const requests: ImageGenerationRequest[] = []
  let waitForAbort = false
  const removeImages = llm.registerImageProvider(route.provider, { listModels: async () => [{ id: 'image-model', name: 'Fixture image' }], generate: async request => {
    requests.push(request)
    if (request.prompt === 'FAIL') throw new LlmError('fixture failure', 'IMAGE_GENERATION_FAILED')
    if (waitForAbort) await new Promise<void>((_resolve, reject) => { if (request.signal.aborted) reject(request.signal.reason); else request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }) })
    return [{ preview, original: { attachmentId: AttachmentId('original-image'), name: 'original.png', bytes: pixels.length } }]
  } })
  const config = Config.parse({ pollIntervalMs: 250, ...configInput }), legacy = new StylePromptService(tasks, { llm, attachments }, config, () => { throw new Error('unexpected legacy storage failure') })
  const service = new CanvasService(repository, legacy, tasks, { llm, attachments }, config, () => { throw new Error('unexpected canvas storage failure') })
  const signal = new AbortController().signal, call = (action: Parameters<CanvasService['action']>[0]) => service.action(action, signal)
  await legacy.initialize(); await service.initialize()
  const document = starterCanvas(canvasId.parse('canvas-1'))
  await call({ operation: 'canvas/upload', assets: [{ id: assetId.parse('asset-1'), name: 'reference.png', mediaType: 'image/png', base64: pixels.toString('base64') }] })
  document.nodes = document.nodes.map(node => node.kind === 'reference' ? { ...node, assetIds: [assetId.parse('asset-1')] } : node.kind === 'analysis' ? { ...node, route } : node.kind === 'prompt' ? { ...node, route: { ...route, model: 'text' } } : node.kind === 'brief' ? { ...node, brief: newInput().brief, changes: newInput().changes } : node.kind === 'image' ? { ...node, route: { ...route, model: 'image-model' } } : node)
  await call({ operation: 'canvas/save', document, expectedRevision: 0 })
  const settle = async (id: RunId): Promise<CanvasRun> => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) { const run = repository.run(id); if (run?.status !== 'running' && run) return run; await delay(10) }
    throw new Error('Canvas run did not settle')
  }
  return { ctx, llm, adapter, tasks, repository, service, document, requests, call, settle, wait() { waitForAbort = true }, cleanup: async () => { await service.dispose(); await legacy.dispose(); removeImages(); unregister(); await ctx.fiber.dispose() } }
}
test('typed links reject cycles, incompatible ports and duplicate single inputs; layout preserves results', () => {
  const document = starterCanvas(canvasId.parse('graph'))
  assert.equal(canConnect(document, { source: nodeId.parse('node-1'), sourceHandle: 'images', target: nodeId.parse('node-5'), targetHandle: 'style' }), false)
  assert.equal(canConnect(document, { source: nodeId.parse('node-6'), sourceHandle: 'images', target: nodeId.parse('node-2'), targetHandle: 'images' }), false)
  assert.equal(canConnect(document, document.edges[1]!), false)
  const before = nodeFingerprint(document, nodeId.parse('node-6'))
  document.nodes[0]!.position.x = 1000
  document.nodes[0]!.width = 640; document.nodes[0]!.height = 480
  assert.equal(nodeFingerprint(document, nodeId.parse('node-6')), before)
  const brief = document.nodes.find(node => node.kind === 'brief')!; if (brief.kind === 'brief') brief.brief.en = 'A different scene'
  assert.notEqual(nodeFingerprint(document, nodeId.parse('node-6')), before)
  document.edges.push({ ...document.edges[0]!, id: 'duplicate' })
  assert.throws(() => validateCanvas(document), /invalid-input/)
})

test('older hosts report unavailable image generation without breaking the canvas or sending a request', async () => {
  const f = await fixture()
  try {
    Object.defineProperty(f.llm, 'listImageModels', { value: undefined })
    Object.defineProperty(f.llm, 'generateImages', { value: undefined })
    const catalog = z.object({ models: z.array(z.unknown()), failures: z.array(z.object({ code: z.string() })) }).parse(await f.call({ operation: 'canvas/models' }))
    assert.deepEqual(catalog.models, [])
    assert.ok(catalog.failures.length > 0)
    assert.ok(catalog.failures.every(failure => failure.code === 'capability-unavailable'))
    const id = runId.parse('older-host')
    await f.call({ operation: 'canvas/run', id, document: f.document, targets: [nodeId.parse('node-7')] })
    const result = await f.settle(id)
    assert.equal(result.status, 'failed')
    assert.equal(result.nodes.find(node => node.nodeId === 'node-6')?.failure?.code, 'capability-unavailable')
    assert.equal(f.requests.length, 0)
  } finally { await f.cleanup() }
})

test('one shared analysis feeds two branches; failed image generation blocks only its own output', async () => {
  const f = await fixture()
  try {
    const document = structuredClone(f.document)
    const brief = { ...newNode('brief', nodeId.parse('brief-b'), { x: 680, y: 900 }), kind: 'brief' as const, brief: { zh: '失败分支', en: 'FAIL' }, changes: newInput().changes }
    const prompt = { ...newNode('prompt', nodeId.parse('prompt-b')), kind: 'prompt' as const, route: { ...route, model: 'text' }, mode: 'model' as const, platform: 'generic' as const, historyTaskId: null }
    const image = { ...newNode('image', nodeId.parse('image-b')), kind: 'image' as const, route: { ...route, model: 'image-model' }, prompt: '', variant: -1, size: '1024x1024' as const, quality: 'auto' as const }
    const output = newNode('output', nodeId.parse('output-b'))
    document.nodes.push(brief, prompt, image, output)
    for (const [source, sourceHandle, target, targetHandle] of [['node-3', 'style', prompt.id, 'style'], [brief.id, 'brief', prompt.id, 'brief'], [prompt.id, 'prompt', image.id, 'prompt'], [image.id, 'images', output.id, 'images']]) document.edges.push({ id: `edge-${target}-${targetHandle}`, source: nodeId.parse(source), sourceHandle: sourceHandle!, target: nodeId.parse(target), targetHandle: targetHandle! })
    const id = runId.parse('run-branches')
    await f.call({ operation: 'canvas/run', id, document, targets: [nodeId.parse('node-7'), output.id] })
    const result = await f.settle(id)
    assert.equal(result.status, 'failed')
    assert.equal(f.adapter.analyses, 1); assert.equal(f.adapter.prompts, 2); assert.equal(f.requests.length, 2)
    assert.equal(result.nodes.find(node => node.nodeId === 'node-7')?.status, 'succeeded')
    assert.equal(result.nodes.find(node => node.nodeId === output.id)?.status, 'blocked')
    const successful = result.nodes.find(node => node.nodeId === 'node-6')!
    assert.equal(successful.imageRequest?.prompt, newInput().brief.en)
    assert.equal(successful.originals[0]?.name, 'original.png')
    assert.equal(JSON.stringify(result).includes('base64'), false)
    await f.call({ operation: 'canvas/run', id, document, targets: [nodeId.parse('node-7'), output.id] })
    assert.equal(f.requests.length, 2, 'Retrying admitted run identity does not dispatch again')
  } finally { await f.cleanup() }
})

test('rerunning an image reuses unchanged ancestors and a changed brief reruns only downstream work', async () => {
  const f = await fixture()
  try {
    for (const id of ['first', 'second']) { await f.call({ operation: 'canvas/run', id: runId.parse(id), document: f.document, targets: [nodeId.parse('node-7')] }); assert.equal((await f.settle(runId.parse(id))).status, 'succeeded') }
    assert.equal(f.adapter.analyses, 1); assert.equal(f.adapter.prompts, 1); assert.equal(f.requests.length, 2)
    const document = structuredClone(f.document), brief = document.nodes.find(node => node.kind === 'brief')!
    if (brief.kind === 'brief') brief.brief.en = 'New branch scene'
    await f.call({ operation: 'canvas/run', id: runId.parse('third'), document, targets: [nodeId.parse('node-7')] }); await f.settle(runId.parse('third'))
    assert.equal(f.adapter.analyses, 1); assert.equal(f.adapter.prompts, 2); assert.equal(f.requests.at(-1)?.prompt, 'New branch scene')
    const oldTask = f.tasks.list().find(task => task.kind === 'generation')!, before = JSON.stringify(f.tasks.list())
    await f.call({ operation: 'canvas/import-history', id: oldTask.id, canvasId: canvasId.parse('imported') })
    assert.equal(JSON.stringify(f.tasks.list()), before, 'Import leaves every released task record byte-equivalent')
    assert.equal(f.service.referencesTask(oldTask.id), true)
  } finally { await f.cleanup() }
})

test('cancellation drains the active image request and restart never resubmits interrupted work', async () => {
  const f = await fixture()
  try {
    f.wait(); const id = runId.parse('cancelled-run')
    await f.call({ operation: 'canvas/run', id, document: f.document, targets: [nodeId.parse('node-7')] })
    const deadline = Date.now() + 15000
    while (!f.requests.length && Date.now() < deadline) await delay(10)
    assert.equal(f.requests.length, 1)
    await f.call({ operation: 'canvas/cancel', id })
    assert.equal(f.repository.run(id)?.status, 'cancelled'); assert.equal(f.requests[0]!.signal.aborted, true)
    const saved = f.repository.run(id)!
    await f.repository.saveRun({ ...saved, status: 'running', nodes: saved.nodes.map(node => ({ ...node, status: 'running' })) })
    await f.service.initialize()
    assert.equal(f.repository.run(id)?.status, 'interrupted'); assert.equal(f.requests.length, 1)
  } finally { await f.cleanup() }
})

test('optimistic canvas saves preserve the newer revision and canvas copy is bilingual', async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.call({ operation: 'canvas/save', document: { ...f.document, name: 'stale' }, expectedRevision: 0 }), /operation-conflict/)
    assert.notEqual(f.repository.document(f.document.id)?.name, 'stale')
    assert.equal(enCanvas['canvas.node.image'], 'Generate image'); assert.equal(zhCanvas['canvas.node.image'], '生成图片')
    assert.deepEqual(Object.keys(enCanvas).sort(), Object.keys(zhCanvas).sort())
  } finally { await f.cleanup() }
})

test('missing inputs reject before dispatch and repeated running branches do not create another request', async () => {
  const f = await fixture()
  try {
    const incomplete = structuredClone(f.document)
    incomplete.nodes = incomplete.nodes.map(node => node.kind === 'reference' ? { ...node, assetIds: [] } : node)
    await assert.rejects(f.call({ operation: 'canvas/run', id: runId.parse('incomplete'), document: incomplete, targets: [nodeId.parse('node-7')] }), /invalid-input/)
    assert.equal(f.repository.run(runId.parse('incomplete')), undefined)
    assert.equal(f.adapter.analyses, 0)
    f.wait()
    await f.call({ operation: 'canvas/run', id: runId.parse('active'), document: f.document, targets: [nodeId.parse('node-7')] })
    const deadline = Date.now() + 15000
    while (!f.requests.length && Date.now() < deadline) await delay(10)
    assert.equal(f.requests.length, 1)
    await assert.rejects(f.call({ operation: 'canvas/run', id: runId.parse('duplicate'), document: f.document, targets: [nodeId.parse('node-7')] }), /busy/)
    assert.equal(f.repository.run(runId.parse('duplicate')), undefined)
    assert.equal(f.requests.length, 1)
  } finally { await f.cleanup() }
})

test('portable imports remap reference hashes and release foreign history identities', async () => {
  const f = await fixture()
  try {
    const existing = f.repository.asset(assetId.parse('asset-1'))!, foreignId = assetId.parse('another-profile-image')
    const document = structuredClone(f.document)
    document.nodes = document.nodes.map(node => node.kind === 'reference' ? { ...node, assetIds: [foreignId] } : node.kind === 'analysis' || node.kind === 'prompt' ? { ...node, historyTaskId: taskIdSchema.parse('foreign-history') } : node)
    const bundle = { formatVersion: 1 as const, exportType: 'style-prompt-canvas' as const, document, assets: [{ id: foreignId, name: 'reference.png', sha256: existing.reference.sha256 }] }
    const imported = canvasSchema.parse(await f.call({ operation: 'canvas/import', bundle, canvasId: canvasId.parse('portable-copy') }))
    assert.equal(imported.nodes.find(node => node.kind === 'reference')?.assetIds[0], existing.id)
    assert.ok(imported.nodes.filter(node => node.kind === 'analysis' || node.kind === 'prompt').every(node => node.historyTaskId === null))
    assert.equal(f.requests.length, 0)
    await assert.rejects(f.call({ operation: 'canvas/import', bundle: { ...bundle, assets: [{ ...bundle.assets[0]!, sha256: '0'.repeat(64) }] }, canvasId: canvasId.parse('missing-images') }), /missing-record/)
    assert.equal(f.repository.document(canvasId.parse('missing-images')), undefined)
  } finally { await f.cleanup() }
})

test('changing an imported scene recomposes its prompt instead of replaying the pinned history', async () => {
  const f = await fixture()
  try {
    await f.call({ operation: 'canvas/run', id: runId.parse('source'), document: f.document, targets: [nodeId.parse('node-7')] }); await f.settle(runId.parse('source'))
    const record = f.tasks.list().find(task => task.kind === 'generation')!
    const document = canvasSchema.parse(await f.call({ operation: 'canvas/import-history', id: record.id, canvasId: canvasId.parse('from-history') }))
    document.nodes = document.nodes.map(node => node.kind === 'brief' ? { ...node, brief: { zh: '新分支场景', en: 'A changed imported scene' } } : node)
    await f.call({ operation: 'canvas/run', id: runId.parse('changed-history'), document, targets: [nodeId.parse('node-7')] })
    assert.equal((await f.settle(runId.parse('changed-history'))).status, 'succeeded')
    assert.equal(f.adapter.analyses, 1); assert.equal(f.adapter.prompts, 2)
    const output = f.repository.run(runId.parse('changed-history'))!.nodes.find(node => node.nodeId === 'node-7')!
    const generated = output.taskId ? f.tasks.get(output.taskId) : undefined
    assert.equal(generated?.kind === 'generation' ? generated.result?.fullPrompt.en : undefined, 'A changed imported scene')
    assert.equal(f.tasks.get(record.id)?.updatedAt, record.updatedAt)
  } finally { await f.cleanup() }
})


test('asset cleanup protects saved canvases, run snapshots, recent imports and newly added references', async () => {
  const f = await fixture()
  try {
    const base = f.repository.asset(assetId.parse('asset-1'))!
    const make = async (id: string, recent = false) => { const asset = { ...base, id: assetId.parse(id), createdAt: recent ? new Date().toISOString() : '2000-01-01T00:00:00.000Z' }; await f.repository.saveAsset(asset); return asset.id }
    await f.repository.saveAsset({ ...base, createdAt: '2000-01-01T00:00:00.000Z' })
    const snapshot = await make('snapshot'), recent = await make('recent', true), orphan = await make('orphan'), changed = await make('now-referenced'), draft = await make('unsaved-draft')
    const historical = structuredClone(f.document)
    historical.nodes = historical.nodes.map(node => node.kind === 'reference' ? { ...node, assetIds: [snapshot] } : node)
    await f.repository.saveRun(canvasRunSchema.parse({ formatVersion: 1, id: 'history', canvasId: historical.id, createdAt: historical.updatedAt, updatedAt: historical.updatedAt, status: 'cancelled', document: historical, targets: ['node-1'], nodes: [], failure: null }))
    const first = canvasAssetInventorySchema.parse(await f.call({ operation: 'canvas/assets' }))
    assert.equal(first.total, 6)
    assert.equal(first.assets.find(value => value.asset.id === base.id)?.used, true)
    assert.equal(first.assets.find(value => value.asset.id === snapshot)?.used, true)
    assert.equal(first.assets.find(value => value.asset.id === recent)?.recent, true)
    const updated = structuredClone(f.document)
    updated.nodes = updated.nodes.map(node => node.kind === 'reference' ? { ...node, assetIds: [...node.assetIds, changed] } : node)
    await f.call({ operation: 'canvas/save', document: updated, expectedRevision: 1 })
    const cleaned = await f.call({ operation: 'canvas/assets-prune', ids: first.assets.map(value => value.asset.id), keep: [draft] })
    assert.equal(zCleanup(cleaned).removed, 1)
    assert.equal(f.repository.asset(orphan), undefined)
    for (const id of [base.id, snapshot, recent, changed, draft]) assert.ok(f.repository.asset(id))
    const opened = await f.call({ operation: 'canvas/get', id: f.document.id })
    assert.ok(JSON.stringify(opened).includes('snapshot'))
    assert.equal(f.requests.length, 0)
  } finally { await f.cleanup() }
})

function zCleanup(value: unknown) {
  assert.ok(value && typeof value === 'object' && 'removed' in value && typeof value.removed === 'number')
  return { removed: value.removed }
}

test('canvas import accepts large valid files and enforces the same advertised profile limit', async () => {
  const f = await fixture(), small = await fixture({ maxCanvasFileBytes: 1024 })
  try {
    const document = structuredClone(f.document)
    document.nodes = Array.from({ length: 280 }, (_, index) => ({ ...newNode('image', nodeId.parse(`large-${index}`), { x: 0, y: 0 }), kind: 'image' as const, route: null, prompt: 'x'.repeat(8000), variant: -1, size: 'auto' as const, quality: 'auto' as const }))
    document.edges = []
    const bundle = { formatVersion: 1 as const, exportType: 'style-prompt-canvas' as const, document, assets: [] }
    assert.ok(Buffer.byteLength(JSON.stringify(bundle)) > 2 * 1024 ** 2)
    const imported = canvasSchema.parse(await f.call({ operation: 'canvas/import', bundle, canvasId: canvasId.parse('large-import') }))
    assert.equal(imported.nodes.length, 280)
    await assert.rejects(small.call({ operation: 'canvas/import', bundle, canvasId: canvasId.parse('too-large') }), /invalid-input/)
    assert.equal(small.repository.document(canvasId.parse('too-large')), undefined)
    assert.equal(Config.parse({ maxRequestBytes: 4096 }).maxCanvasFileBytes, 4096 - 512)
  } finally { await f.cleanup(); await small.cleanup() }
})
