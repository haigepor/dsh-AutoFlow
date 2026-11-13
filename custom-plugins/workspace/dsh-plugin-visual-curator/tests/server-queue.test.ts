/** Protocol integration uses real media, persistence and crop/review code with isolated vision responses. */
import assert from 'node:assert/strict'
import { wallpaperFixtureResponse } from './helpers/wallpaper-response.ts'
import { wallpaperGenerationBriefOutputSchema, wallpaperPromptPreparationPolicySchema } from '../src/shared/wallpaper-generation-brief.ts'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'
import { serverReworkScenario } from './helpers/server-rework.ts'
import { ServerQueue } from '../src/host/server-queue.ts'
import { DirectCropTasks } from '../src/host/direct-crop.ts'
import { WallpaperWorkflows } from '../src/host/wallpaper-workflow.ts'
import { RunEngine, dataOf } from '../src/host/runtime.ts'
import { resolveConfig } from '../src/host/config.ts'
import { wallpaperReviewKeys, wallpaperStateSchema } from '../src/shared/wallpaper.ts'
import { serverQueueViewSchema } from '../src/shared/server-queue.ts'
import { CuratorError } from '../src/shared/errors.ts'
import { MediaError } from '../src/media/errors.ts'
import type { HttpClient } from '../src/media/network.ts'
import { createCuratorTransport } from '../src/client/transport.ts'

const expected = JSON.parse(await readFile(new URL('./fixtures/server-queue.expected.json', import.meta.url), 'utf8'))
const presented = (view: z.infer<typeof serverQueueViewSchema>) => view.items.map(item => ({ serverId: item.id, processing: item.phase, upload: item.transfer?.status ?? null }))

async function fixture(count = 1, options: { autoDeliver?: boolean; secondReview?: Promise<void>; rework?: boolean } = {}) {
  const f = await serviceFixture(); await f.service.initialize()
  const config = resolveConfig({ source: { endpoint: 'https://source.example.test', credentialRef: '' }, vision: { backend: 'compatible', endpoint: 'https://vision.example.test/chat', model: 'fixture', credentialRef: '' }, limits: { maxRetryAttempts: 0 } })
  const scenario = options.rework ? serverReworkScenario(f.root) : undefined
  if (scenario) { config.wallpaper.imageProvider = 'isolated-images'; config.wallpaper.imageModel = 'isolated-background'; config.wallpaper.maxReworks = 1; config.wallpaper.repairPolicy = { version: 'subject-repair-v1', mode: 'preserve', maxRepeatedDefects: 2 }; config.vision.wallpaperPromptPreparation = wallpaperPromptPreparationPolicySchema.parse({ reasoningEffort: 'high' }) }
  const original = await sharp({ create: { width: 2400, height: 4000, channels: 3, background: '#536f53' } }).png().toBuffer()
  const md5 = createHash('md5').update(original).digest('hex'), items = Array.from({ length: count }, (_, index) => ({ id: String(index + 11), name: 'same-name.png', title: 'Untrusted article text', img_url: 'https://images.example.test/' + index, md5, size: String(original.length), update_time: '123' }))
  let mode: 'success' | 'timeout' | 'wrong-id' | 'rejected' = 'success', badReview = false, downloads = 0, maxActive = 0, active = 0
  const barrier = Promise.withResolvers<void>(), uploads: { id: string; digest: string; width: number; height: number }[] = [], observations: string[] = []
  const http: HttpClient = { request: async (url, request) => {
    if (url.startsWith('https://images.example.test/')) {
      downloads++; active++; maxActive = Math.max(maxActive, active)
      if (active === count) barrier.resolve()
      await barrier.promise; active--
      assert.equal(request.headers?.authorization, undefined)
      return { status: 200, headers: { 'content-type': 'image/png' }, bytes: original }
    }
    if (request.method === 'GET') {
      assert.equal(request.body, undefined); assert.equal(new URL(url).searchParams.get('token'), 'isolated-token')
      return { status: 200, headers: {}, bytes: Buffer.from(JSON.stringify({ success: true, data: items, total: items.length, page: 1, pageSize: 20 })) }
    }
    assert.match(request.headers?.['content-type'] ?? '', /^multipart\/form-data; boundary=/)
    const form = await new Request(url, { method: 'POST', headers: request.headers ?? {}, body: new Uint8Array(request.body ?? []) }).formData()
    assert.equal(form.get('token'), 'isolated-token')
    const id = String(form.get('ids[0]')), file = form.get('images[0]')
    assert.ok(file && typeof file !== 'string'); assert.equal(file.type, 'image/png')
    const bytes = Buffer.from(await file.arrayBuffer()), metadata = await sharp(bytes).metadata()
    assert.equal(metadata.format, 'png')
    uploads.push({ id, digest: createHash('sha256').update(bytes).digest('hex'), width: metadata.width!, height: metadata.height! })
    if (mode === 'timeout') throw new MediaError('remote-timeout', 'network', true, 'Isolated post-send timeout.', 'Verify the receipt.')
    return { status: 200, headers: {}, bytes: Buffer.from(JSON.stringify({ success: mode !== 'rejected', message: 'Isolated response', data: mode === 'rejected' ? [] : { total: 1, updated: 1, failed: 0, skipped: 0, results: [{ index: 0, id: mode === 'wrong-id' ? 999 : Number(id), status: 'updated', message: 'Isolated acknowledgement' }] } })) }
  } }
  const oldRequest = f.http.request.bind(f.http)
  f.http.request = async (url, request) => {
    if (!url.startsWith('https://vision.example.test')) return oldRequest(url, request)
    const messages = z.object({ messages: z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ text: z.string().optional() }).passthrough())]) })) }).parse(JSON.parse(Buffer.from(request.body!).toString('utf8'))).messages
    const content = messages.find(row => row.role === 'user')!.content; assert.ok(Array.isArray(content))
    const preparedBrief = wallpaperGenerationBriefOutputSchema.safeParse(wallpaperFixtureResponse(JSON.parse(content[0]!.text!), {}))
    if (preparedBrief.success) {
      const usage = z.object({ input: z.object({ usage: z.object({ plan: z.object({ editPrompt: z.string().optional() }), previousReview: z.object({ checks: z.record(z.string(), z.object({ result: z.string(), reason: z.string() })) }).optional() }) }) }).parse(JSON.parse(content[0]!.text!)).input.usage
      const repair = [usage.plan.editPrompt, ...Object.values(usage.previousReview?.checks ?? {}).filter(check => check.result !== 'satisfied').map(check => check.reason)].filter(Boolean).join('\n')
      const authored = { ...preparedBrief.data, ...(repair ? { repairInstructions: repair, generationPrompt: `${preparedBrief.data.generationPrompt}\n${repair}` } : {}) }
      observations.push('wallpaper-generation-brief')
      return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(authored) }, finish_reason: 'stop' }] })) }
    }
    const input = z.object({ input: z.object({ operation: z.string(), images: z.array(z.object({ role: z.string(), imageVersionId: z.string() })), usage: z.unknown().optional() }) }).parse(JSON.parse(content[0]!.text!)).input
    observations.push(input.operation)
    if (input.operation === 'wallpaper-review' && observations.filter(operation => operation === 'wallpaper-review').length === 2) await options.secondReview
    const subjectRect = { x: 0.35, y: 0.5, width: 0.3, height: 0.2 }, detailRect = { x: 0.45, y: 0.56, width: 0.05, height: 0.04 }
    const regions = [{ name: 'Subject', ...(!scenario ? { entityId: 'subject' } : {}), role: 'subject', rect: subjectRect }, { name: 'Identity detail', ...(!scenario ? { entityId: 'detail' } : {}), role: 'critical', rect: detailRect }]
    const result = input.operation === 'wallpaper-plan' ? { version: 1, imageVersionId: input.images[0]!.imageVersionId, mode: 'single', subject: 'Isolated central subject', evidence: 'Scripted observation only.', priorities: [], anchors: [], truncations: [], uncertainties: [], regions, ...(!scenario ? { objectRoles: [{ entityId: 'subject', name: 'Subject', role: 'primary', evidence: 'Visible focal subject.', rect: subjectRect, sourceEdges: [] }, { entityId: 'detail', name: 'Identity detail', role: 'critical-part', evidence: 'Indispensable visible identity.', rect: detailRect, sourceEdges: [] }] } : {}), reason: 'Fits without generation.', editPrompt: 'Extend only the uniform muted green background and preserve protected original pixels, illumination and texture.' } : {
      reviewVersion: scenario ? 'wallpaper-review-source-v1' : 'wallpaper-review-source-v4', subject: 'Isolated central subject', checks: { ...Object.fromEntries(wallpaperReviewKeys.map(key => [key, { result: badReview && key === 'background' ? 'violated' : 'satisfied', reason: 'Isolated observation.' }])), clarity: { result: 'satisfied', reason: 'Isolated clarity.' } }, issues: [], styleResults: [], ...(!scenario ? { sourceRepair: { result: 'satisfied', reason: 'Complete source.' }, sourceCorrespondence: { result: 'satisfied', reason: 'Same visible subject.' }, actualLayout: { imageVersionId: input.images.find(image => image.role === 'actual-wallpaper')!.imageVersionId, regions: regions.map(region => ({ ...region, scope: 'core' })) } } : {}), subjectIntegrity: { mode: 'single', source: { extent: 'complete', reason: 'Isolated source.', imageVersionId: input.images.find(image => image.role === 'wallpaper-original')!.imageVersionId }, output: { extent: 'complete', reason: 'Isolated output.', imageVersionId: input.images.find(image => image.role === 'actual-wallpaper')!.imageVersionId }, task: { result: 'satisfied', reason: 'Isolated task.' } },
    }
    const reply = scenario ? scenario.reply(input, result) : result
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(wallpaperFixtureResponse(JSON.parse(content[0]!.text!), reply)) }, finish_reason: 'stop' }] })) }
  }
  let queue: ServerQueue
  const engine = new RunEngine(f.repository, f.jobs), wallpaper = new WallpaperWorkflows({ domain: f.domain, files: f.files, engine, config: () => config, vision: f.providers.vision, source: f.providers.source, media: f.providers.media, skill: () => ({ id: 'isolated', content: 'Scripted fixture' }), ...(scenario ? { llm: scenario.llm, attachments: scenario.attachments } : {}), ...(options.autoDeliver ? { approved: (run, imageVersionId) => queue.deliver(run, imageVersionId) } : {}) })
  const direct = new DirectCropTasks({ domain: f.domain, files: f.files, engine, wallpaper, config: () => config })
  const path = join(f.root, 'postman.json'); await writeFile(path, JSON.stringify({ item: [{ request: { method: 'POST', url: { raw: 'https://api.example.test/OperateImage/receive.html' }, body: { formdata: [{ key: 'token', type: 'text', value: 'isolated-token' }] } } }, { request: { method: 'GET', url: { raw: 'https://api.example.test/OperateImage/pull.html' }, body: { mode: 'raw', raw: '{"articles":[]}' } } }] }), 'utf8')
  const deps = { domain: f.domain, files: f.files, engine, direct, credentials: f.host.credentials, config: () => config, signal: new AbortController().signal, http: () => http }
  queue = new ServerQueue(deps)
  await queue.configure({ baseUrl: 'https://api.example.test', auth: { kind: 'postman', path }, allowedMediaOrigins: ['https://images.example.test'] }, f.actor)
  const snapshot = await queue.pull(f.actor, deps.signal)
  const start = async () => { const result = await queue.start({ operationId: 'server-test', name: 'Isolated server batch', snapshotId: snapshot.snapshotId, ids: items.map(item => item.id) }, f.actor, deps.signal); await queue.drain(); await f.jobs.drain(); return f.domain.require('run', result.runId) }
  return { ...f, queue, deps, direct, engine, items, uploads, original, observations, start, scenario, downloads: () => downloads, maxActive: () => maxActive, setMode(value: typeof mode) { mode = value }, rejectReview() { badReview = true }, cleanup: async () => { await engine.dispose(); await queue.drain(); await f.cleanup(); await scenario?.close() } }
}

test('server originals import concurrently, retain independent IDs and upload only reviewed clean PNGs once', async () => {
  const f = await fixture(2)
  try {
    assert.equal(JSON.stringify(f.queue.read(f.actor)).includes('isolated-token'), false)
    assert.deepEqual(presented(f.queue.read(f.actor)), expected.pending)
    const run = await f.start(); assert.equal(run.status, 'completed'); assert.equal(run.outcome, 'target-met', JSON.stringify(dataOf(run).checkpoint.wallpaper)); assert.equal(f.maxActive(), 2)
    const state = wallpaperStateSchema.parse(dataOf(run).checkpoint.wallpaper); assert.equal(state.items.filter(item => item.status === 'passed').length, 2)
    await f.queue.deliver(run); await f.queue.deliver(run)
    assert.deepEqual(f.uploads.map(row => row.id), ['11', '12']); assert.ok(f.uploads.every(row => row.width === 1845 && row.height === 3280))
    assert.ok(serverQueueViewSchema.parse(f.queue.read(f.actor)).items.every(row => row.transfer?.status === 'uploaded'))
    assert.deepEqual(presented(f.queue.read(f.actor)), expected.accepted)
    const before = f.observations.length; await f.queue.recover(); await f.start()
    assert.equal(f.uploads.length, 2); assert.equal(f.downloads(), 2); assert.equal(f.observations.length, before)
  } finally { await f.cleanup() }
})

test('an approved image is delivered and its receipt is visible while another review is still running', { timeout: 20000 }, async () => {
  const release = Promise.withResolvers<void>(), sent = Promise.withResolvers<void>()
  const f = await fixture(2, { autoDeliver: true, secondReview: release.promise }), server = f.deps.http()
  f.deps.http = () => ({ request: async (url, request) => {
    const response = await server.request(url, request)
    if (request.method === 'POST') sent.resolve()
    return response
  } })
  const started = f.start()
  try {
    await Promise.race([sent.promise, started.then(() => { throw new Error('Batch finished before sending an approved image') })])
    await f.queue.drain()
    assert.equal(f.uploads.length, 1)
    const row = f.queue.read(f.actor).items.find(item => item.id === f.uploads[0]!.id)!
    assert.equal(f.domain.require('run', row.runId!).status, 'running')
    const page = await f.action('wallpaper-read', { sourceRunId: row.runId! })
    assert.equal(z.object({ serverTransfers: z.record(z.string(), z.object({ status: z.string(), current: z.boolean().optional() })) }).parse(page).serverTransfers[row.imageVersionId!]!.status, 'uploaded')
    release.resolve()
    const run = await started
    await f.queue.deliver(run); await f.queue.recover()
    assert.deepEqual(f.uploads.map(upload => upload.id).sort(), ['11', '12'])
  } finally { release.resolve(); await started; await f.cleanup() }
})

test('a server batch resolves detail evidence, regenerates a rejected background and delivers only the approved artifacts', { timeout: 60000 }, async () => {
  const f = await fixture(2, { autoDeliver: true, rework: true })
  try {
    const run = await f.start(), state = wallpaperStateSchema.parse(dataOf(run).checkpoint.wallpaper)
    const revised = state.items.find(item => item.imageVersionId === f.scenario!.target())!
    assert.equal(revised.status, 'passed', JSON.stringify({ reason: revised.reason, error: revised.errorCode, step: revised.failedStep, edits: revised.edits }))
    assert.equal(run.outcome, 'target-met')
    assert.equal(f.downloads(), 2)
    assert.ok(revised.attempts.some(attempt => attempt.detailAnalysis?.outcome === 'resolved'))
    const reviewed = revised.attempts.filter(attempt => attempt.review)
    assert.deepEqual(reviewed.map(attempt => attempt.review!.checks.background.result), ['violated', 'satisfied'])
    assert.equal(f.scenario!.generations.size, 2)
    assert.equal(f.scenario!.reviews(), 2)
    assert.notEqual(reviewed[0]!.generation!.id, reviewed[1]!.generation!.id)
    assert.notEqual(reviewed[0]!.outputId, reviewed[1]!.outputId)
    assert.ok(reviewed[1]!.generationInput?.prompt.includes('dark seam'))
    const rejected = f.domain.require('imageVersion', reviewed[0]!.outputId!)
    assert.ok(f.uploads.every(upload => upload.digest !== rejected.blob.digest))
    const page = f.queue.read(f.actor)
    for (const item of state.items) {
      const approved = await f.direct.approvedFile(run.id, item.imageVersionId, f.actor, f.deps.signal)
      const row = page.items.find(row => row.imageVersionId === item.imageVersionId)!
      assert.equal(row.transfer?.status, 'uploaded')
      assert.equal(row.transfer.current, true)
      assert.deepEqual(f.uploads.filter(upload => upload.id === row.id), [{ id: row.id, digest: approved.image.blob.digest, width: 1845, height: 3280 }])
    }
    const restarted = new ServerQueue(f.deps)
    await restarted.initialize(); await restarted.recover()
    assert.deepEqual(presented(restarted.read(f.actor)), expected.accepted)
    assert.equal(f.uploads.length, 2)
  } finally { await f.cleanup() }
})

test('a failed independent quality check never sends an image to the server', async () => {
  const f = await fixture()
  try { f.rejectReview(); const run = await f.start(); await f.queue.deliver(run); assert.equal(f.uploads.length, 0); assert.ok(f.observations.includes('wallpaper-review')); assert.ok(wallpaperStateSchema.parse(dataOf(run).checkpoint.wallpaper).items[0]!.attempts.some(attempt => attempt.review?.checks.background.result === 'violated')); assert.equal(f.queue.read(f.actor).items[0]!.phase, 'attention') }
  finally { await f.cleanup() }
})

for (const mode of ['timeout', 'wrong-id'] as const) test(`${mode} remains unknown through restart, receipt inspection and attempted retry`, async () => {
  const f = await fixture()
  try {
    f.setMode(mode); const run = await f.start(); await f.queue.deliver(run)
    assert.equal(f.queue.read(f.actor).items[0]!.transfer?.status, 'unknown')
    const restarted = new ServerQueue(f.deps); await restarted.initialize(); await restarted.recover(); await restarted.transmission({ runId: run.id, id: '11' }, f.actor, false)
    await assert.rejects(restarted.transmission({ runId: run.id, id: '11' }, f.actor, true), (error: unknown) => error instanceof CuratorError && error.code === 'constraint-conflict')
    assert.equal(f.uploads.length, 1)
  } finally { await f.cleanup() }
})

test('an explicit server rejection permits upload-only retry of the same approved bytes', async () => {
  const f = await fixture()
  try {
    f.setMode('rejected'); const run = await f.start(); await f.queue.deliver(run); assert.equal(f.queue.read(f.actor).items[0]!.transfer?.status, 'failed')
    const before = f.observations.length; f.setMode('success')
    const retries = await Promise.allSettled([f.queue.transmission({ runId: run.id, id: '11' }, f.actor, true), f.queue.transmission({ runId: run.id, id: '11' }, f.actor, true)])
    assert.equal(retries.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(f.uploads.length, 2); assert.deepEqual(f.uploads[0], f.uploads[1]); assert.equal(f.observations.length, before)
  } finally { await f.cleanup() }
})

test('checksum changes and unapproved source locations stop before processing or uploading', async () => {
  const f = await fixture()
  try {
    f.items[0]!.md5 = '0'.repeat(32); const snapshot = await f.queue.pull(f.actor, f.deps.signal)
    await f.queue.start({ operationId: 'changed', snapshotId: snapshot.snapshotId, name: 'Invalid original', ids: ['11'] }, f.actor, f.deps.signal)
    await f.queue.drain()
    assert.equal(f.queue.imports(f.actor)[0]!.status, 'failed'); assert.equal(f.queue.imports(f.actor)[0]!.errorCode, 'source-protocol-error')
    assert.equal(f.observations.length, 0); assert.equal(f.uploads.length, 0)
    f.items[0]!.img_url = 'https://unapproved.example.test/image'
    await assert.rejects(f.queue.pull(f.actor, f.deps.signal), (error: unknown) => error instanceof CuratorError && error.code === 'source-protocol-error')
  } finally { await f.cleanup() }
})

test('the server dialog reads the authenticated HTTP route instead of the bounded native action channel', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const transport = createCuratorTransport({ baseUrl: 'https://desktop.example.test/', signal: new AbortController().signal, action: async () => { throw new Error('Unexpected native action fallback') }, fetch: async (input, init) => f.service.data(new Request(input, init)) })
    const value = serverQueueViewSchema.parse(await transport.invoke('server-queue-read', {}))
    assert.equal(value.total, 0); assert.equal(value.settings.baseUrl, '')
    await assert.rejects(transport.invoke('server-queue-import-retry', { runId: 'missing-isolated-import' }), error => !(error instanceof Error && error.message === 'Unexpected native action fallback'))
  } finally { await f.cleanup() }
})

test('saved matching update receipts reconcile locally while weak acknowledgements never permit resending', async () => {
  const f = await fixture()
  try {
    const run = await f.start(); await f.queue.deliver(run)
    let manifest = f.repository.manifests('server-transfer:')[0]!
    const saved = z.record(z.string(), z.json()).parse(manifest.state)
    await f.repository.commit({ aggregateId: manifest.aggregateId, expectedRevision: manifest.revision, operationId: 'saved-unrecognized', request: { fixture: 'unrecognized-receipt' }, records: [], state: { ...saved, status: 'unknown' } })
    await f.queue.transmission({ runId: run.id, id: '11' }, f.actor, false)
    assert.equal(f.queue.read(f.actor).items[0]!.transfer?.status, 'uploaded'); assert.equal(f.uploads.length, 1)
    manifest = f.repository.manifests('server-transfer:')[0]!
    await f.repository.commit({ aggregateId: manifest.aggregateId, expectedRevision: manifest.revision, operationId: 'weak-receipt', request: { fixture: 'weak-receipt' }, records: [], state: { ...saved, status: 'unknown', response: { success: true, data: null } } })
    await f.queue.transmission({ runId: run.id, id: '11' }, f.actor, false)
    assert.equal(f.queue.read(f.actor).items[0]!.transfer?.status, 'unknown'); assert.equal(f.uploads.length, 1)
    assert.equal(JSON.stringify(f.repository.manifests('server-transfer:')).includes('isolated-token'), false)
    f.items.splice(0); const retained = await f.queue.pull(f.actor, f.deps.signal)
    assert.equal(retained.total, 0); assert.equal(retained.items[0]!.id, '11'); assert.equal(retained.items[0]!.transfer?.status, 'unknown')
  } finally { await f.cleanup() }
})


test('an accepted server import remains visible and continues when its client disconnects before originals finish', { timeout: 20000 }, async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), controller = new AbortController()
  const originalHttp = f.deps.http()
  f.deps.http = () => ({ request: async (url, request) => { if (url.startsWith('https://images.example.test/')) { entered.resolve(); await release.promise } return originalHttp.request(url, request) } })
  const view = f.queue.read(f.actor)
  const starting = f.queue.start({ operationId: 'background-import', name: 'Background import', snapshotId: view.snapshotId, ids: [f.items[0]!.id] }, f.actor, controller.signal)
  try {
    await entered.promise
    assert.equal(f.direct.list(f.actor).batches.length, 0)
    const progress = z.object({ imports: z.array(z.object({ runId: z.string(), status: z.string(), saved: z.number(), total: z.number() })) }).safeParse(f.queue.read(f.actor))
    assert.ok(progress.success, 'Accepted server imports must remain visible before a crop batch exists')
    assert.equal(progress.data.imports[0]!.status, 'importing')
    assert.equal(progress.data.imports[0]!.saved, 0)
    assert.equal(progress.data.imports[0]!.total, 1)
    const receipt = await starting
    assert.equal(receipt.runId, progress.data.imports[0]!.runId)
    controller.abort()
    release.resolve()
    await f.queue.drain(); await f.jobs.drain()
    assert.equal(f.direct.list(f.actor).batches[0]!.runId, receipt.runId)
    assert.equal(f.queue.read(f.actor).imports.length, 0)
  } finally { release.resolve(); await starting; await f.queue.drain(); await f.jobs.drain(); await f.cleanup() }
})


test('interrupted imports retain verified originals and resume the same batch without automatic restart work', async () => {
  const f = await fixture(2), originalHttp = f.deps.http()
  let failSecond = true
  f.deps.http = () => ({ request: async (url, request) => { const response = await originalHttp.request(url, request); if (failSecond && url.endsWith('/1')) throw new MediaError('remote-timeout', 'network', true, 'Isolated import timeout.', 'Retry the import.'); return response } })
  const view = f.queue.read(f.actor), input = { operationId: 'resumable-import', name: 'Resumable originals', snapshotId: view.snapshotId, ids: f.items.map(item => item.id) }
  try {
    const receipt = await f.queue.start(input, f.actor, f.deps.signal); await f.queue.drain()
    assert.equal(f.queue.imports(f.actor)[0]!.status, 'failed'); assert.equal(f.queue.imports(f.actor)[0]!.saved, 1); assert.equal(f.downloads(), 2)
    const manifest = f.repository.manifests('server-admission:')[0]!, state = z.record(z.string(), z.json()).parse(manifest.state)
    await f.repository.commit({ aggregateId: manifest.aggregateId, expectedRevision: manifest.revision, operationId: 'isolated-crash-marker', request: { isolated: true }, records: [], state: { ...state, status: 'importing' } })
    const restarted = new ServerQueue(f.deps); await restarted.initialize()
    assert.equal(restarted.imports(f.actor)[0]!.status, 'interrupted'); assert.equal(restarted.imports(f.actor)[0]!.saved, 1); assert.equal(f.downloads(), 2, 'Initialization never silently resumes original downloads')
    failSecond = false
    const retry = await restarted.retryImport({ runId: receipt.runId }, f.actor, f.deps.signal); assert.equal(retry.runId, receipt.runId)
    await restarted.drain(); await f.jobs.drain()
    assert.equal(f.downloads(), 3, 'The verified first original is reused')
    assert.equal(f.direct.list(f.actor).batches[0]!.runId, receipt.runId); assert.equal(restarted.imports(f.actor).length, 0)
    const repeated = await restarted.start({ ...input, operationId: 'another-click' }, f.actor, f.deps.signal)
    assert.equal(repeated.runId, receipt.runId); assert.equal(f.direct.list(f.actor).total, 1); assert.equal(f.downloads(), 3)
  } finally { await f.cleanup() }
})

test('queued originals preview on demand without importing files or sending authentication to image hosts', async () => {
  const f = await fixture()
  try {
    const view = f.queue.read(f.actor), before = f.repository.manifests('server-import:').length
    assert(view.items[0]!.previewPath?.includes('serverSnapshotId='))
    const originalHttp = f.deps.http()
    f.deps.http = () => ({ request: async (url, request) => { const response = await originalHttp.request(url, request); return { ...response, headers: { 'content-type': 'application/octet-stream' } } } })
    const preview = await f.queue.preview(f.items[0]!.id, view.snapshotId, f.actor, f.deps.signal)
    assert.equal(preview.mime, 'image/png'); assert.equal(preview.bytes.equals(f.original), true)
    assert.equal(f.repository.manifests('server-import:').length, before); assert.equal(f.queue.read(f.actor).items[0]!.imported, false); assert.equal(f.direct.list(f.actor).total, 0); assert.equal(f.uploads.length, 0)
    await assert.rejects(f.queue.preview(f.items[0]!.id, 'stale-snapshot', f.actor, f.deps.signal), error => error instanceof CuratorError && error.code === 'reference-unavailable')
    await assert.rejects(f.queue.preview(f.items[0]!.id, view.snapshotId, { ...f.actor, kind: 'agent' }, f.deps.signal), error => error instanceof CuratorError && error.code === 'owner-denied')
    assert.equal(f.downloads(), 1)
  } finally { await f.cleanup() }
})

test('a prefixed API base retains its path for pull and approved delivery using a local Postman token', async () => {
  const f = await fixture(), originalHttp = f.deps.http(), paths: string[] = []
  f.deps.http = () => ({ request: async (url, request) => { if (!url.startsWith('https://images.example.test/')) paths.push(new URL(url).pathname); return originalHttp.request(url, request) } })
  try {
    const settings = f.queue.read(f.actor).settings
    await f.queue.configure({ ...settings, baseUrl: 'https://api.example.test/service/api/' }, f.actor)
    const view = await f.queue.pull(f.actor, f.deps.signal)
    const receipt = await f.queue.start({ operationId: 'prefixed', name: 'Prefixed API', snapshotId: view.snapshotId, ids: [f.items[0]!.id] }, f.actor, f.deps.signal)
    await f.queue.drain(); await f.jobs.drain(); await f.queue.deliver(f.domain.require('run', receipt.runId))
    assert(paths.includes('/service/api/OperateImage/pull.html')); assert(paths.includes('/service/api/OperateImage/receive.html')); assert(paths.every(value => value.startsWith('/service/api/')))
    assert.equal(f.uploads.length, 1); assert.equal(f.queue.read(f.actor).items[0]!.transfer?.status, 'uploaded')
  } finally { await f.cleanup() }
})
