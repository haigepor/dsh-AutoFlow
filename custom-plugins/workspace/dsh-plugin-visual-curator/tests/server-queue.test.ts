/** Protocol integration uses real media, persistence and crop/review code with isolated vision responses. */
import assert from 'node:assert/strict'
import { wallpaperFixtureResponse } from './helpers/wallpaper-response.ts'
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
import { RunEngine, dataOf, specOf, toJson } from '../src/host/runtime.ts'
import { resolveConfig } from '../src/host/config.ts'
import { wallpaperStateSchema, wallpaperSettingsSchema } from '../src/shared/wallpaper.ts'
import { serverImageComplete, serverPullSchema, serverQueueViewSchema } from '../src/shared/server-queue.ts'
import { CuratorError } from '../src/shared/errors.ts'
import { MediaError } from '../src/media/errors.ts'
import type { HttpClient } from '../src/media/network.ts'
import { createCuratorTransport } from '../src/client/transport.ts'

const expected = JSON.parse(await readFile(new URL('./fixtures/server-queue.expected.json', import.meta.url), 'utf8'))
const presented = (view: z.infer<typeof serverQueueViewSchema>) => view.items.map(item => ({ serverId: item.id, processing: item.phase, upload: item.transfer?.status ?? null }))

async function fixture(count = 1, options: { pageSize?: number; autoDeliver?: boolean; secondReview?: Promise<void>; onSecondReview?(): void; onApproved?(): void; rejectCount?: number; rework?: boolean } = {}) {
  const f = await serviceFixture(); await f.service.initialize()
  const config = resolveConfig({ source: { endpoint: 'https://source.example.test', credentialRef: '' }, vision: { backend: 'compatible', endpoint: 'https://vision.example.test/chat', model: 'fixture', credentialRef: '' }, limits: { maxRetryAttempts: 0 } })
  const scenario = options.rework ? serverReworkScenario(f.root) : undefined
  if (scenario) { config.wallpaper.imageProvider = 'isolated-images'; config.wallpaper.imageModel = 'isolated-background'; config.wallpaper.maxReworks = 1 }
  const original = await sharp({ create: { width: 2400, height: 4000, channels: 3, background: '#536f53' } }).png().toBuffer()
  const md5 = createHash('md5').update(original).digest('hex'), items = Array.from({ length: count }, (_, index) => ({ id: String(index + 11), name: 'same-name.png', title: 'Untrusted article text', img_url: 'https://images.example.test/' + index, md5, size: String(original.length), update_time: '123' }))
  let mode: 'success' | 'timeout' | 'wrong-id' | 'rejected' | 'duplicate-index' | 'partial' = 'success', badReview = false, downloads = 0, maxActive = 0, active = 0
  let reworkTarget: string | undefined, targetReviews = 0
  const uploadBatches: string[][] = [], rejectedOriginals = new Set<string>(), pullPages: number[] = []
  const barrier = Promise.withResolvers<void>(), uploads: { id: string; digest: string; width: number; height: number }[] = [], observations: string[] = []
  const http: HttpClient = { request: async (url, request) => {
    if (url.startsWith('https://images.example.test/')) {
      downloads++; active++; maxActive = Math.max(maxActive, active)
      if (active === Math.min(count, 2)) barrier.resolve()
      await barrier.promise; active--
      assert.equal(request.headers?.authorization, undefined)
      return { status: 200, headers: { 'content-type': 'image/png' }, bytes: original }
    }
    if (request.method === 'GET') {
      assert.equal(request.body, undefined); assert.equal(new URL(url).searchParams.get('token'), 'isolated-token')
      const page = Number(new URL(url).searchParams.get('page') ?? 1), pageSize = Number(new URL(url).searchParams.get('pageSize') ?? options.pageSize ?? Math.max(20, count))
      pullPages.push(page)
      return { status: 200, headers: {}, bytes: Buffer.from(JSON.stringify({ success: true, data: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize })) }
    }
    assert.match(request.headers?.['content-type'] ?? '', /^multipart\/form-data; boundary=/)
    const form = await new Request(url, { method: 'POST', headers: request.headers ?? {}, body: new Uint8Array(request.body ?? []) }).formData()
    assert.equal(form.get('token'), 'isolated-token')
    const ids = [...form.keys()].filter(key => /^ids\[\d+\]$/.test(key)).map((_, index) => String(form.get(`ids[${index}]`)))
    assert(ids.length >= 1 && ids.length <= 20)
    assert.equal([...form.keys()].filter(key => key.startsWith('images[')).length, ids.length)
    uploadBatches.push(ids)
    for (const [index, id] of ids.entries()) {
      const file = form.get(`images[${index}]`)
      assert.ok(file && typeof file !== 'string'); assert.equal(file.type, 'image/png')
      const bytes = Buffer.from(await file.arrayBuffer()), metadata = await sharp(bytes).metadata()
      assert.equal(metadata.format, 'png')
      uploads.push({ id, digest: createHash('sha256').update(bytes).digest('hex'), width: metadata.width!, height: metadata.height! })
    }
    if (mode === 'timeout') throw new MediaError('remote-timeout', 'network', true, 'Isolated post-send timeout.', 'Verify the receipt.')
    return { status: 200, headers: {}, bytes: Buffer.from(JSON.stringify({ success: mode !== 'rejected' && mode !== 'partial', message: 'Isolated response', data: mode === 'rejected' ? [] : { total: ids.length, updated: ids.length, failed: 0, skipped: 0, results: ids.map((id, index) => ({ index: mode === 'duplicate-index' ? 0 : index, id: mode === 'wrong-id' ? 999 : Number(id), status: 'updated', message: 'Isolated acknowledgement' })) } })) }
  } }
  const oldRequest = f.http.request.bind(f.http)
  f.http.request = async (url, request) => {
    if (!url.startsWith('https://vision.example.test')) return oldRequest(url, request)
    const messages = z.object({ messages: z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ text: z.string().optional() }).passthrough())]) })) }).parse(JSON.parse(Buffer.from(request.body!).toString('utf8'))).messages
    const content = messages.find(row => row.role === 'user')!.content; assert.ok(Array.isArray(content))
    const wire = JSON.parse(content[0]!.text!)
    const input = z.object({ input: z.object({ operation: z.string(), images: z.array(z.object({ role: z.string(), imageVersionId: z.string() })) }) }).parse(wire).input
    observations.push(input.operation)
    if (input.operation === 'wallpaper-review' && observations.filter(operation => operation === 'wallpaper-review').length === 2) { options.onSecondReview?.(); await options.secondReview }
    const source = input.images.find(image => image.role === 'wallpaper-original')
    assert.ok(source)
    if (scenario) reworkTarget ??= source.imageVersionId
    const target = source.imageVersionId === reworkTarget
    const subjectRect = target ? { x: 0.06, y: 0.24, width: 0.88, height: 0.65 } : { x: 0.29, y: 0.39, width: 0.42, height: 0.36 }
    const outputSubject = target ? { x: 0.153, y: 0.332, width: 0.694, height: 0.48 } : { x: 0.233, y: 0.357, width: 0.534, height: 0.429 }
    const outputDetail = target ? { x: 0.468, y: 0.538, width: 0.063, height: 0.059 } : { x: 0.449, y: 0.512, width: 0.102, height: 0.095 }
    const detailRect = { x: 0.46, y: 0.52, width: 0.08, height: 0.08 }
    const regions = [{ name: 'Subject', entityId: 'subject', role: 'subject', rect: subjectRect }, { name: 'Identity detail', entityId: 'detail', role: 'critical', rect: detailRect }]
    let result: object
    if (input.operation === 'wallpaper-plan') {
      result = { version: 1, imageVersionId: source.imageVersionId, mode: 'single', subject: 'Isolated central subject', evidence: 'Scripted observation only.', priorities: [], anchors: [], truncations: [], uncertainties: [], regions,
        objectRoles: [{ entityId: 'subject', name: 'Subject', role: 'primary', safetyClass: 'general', evidence: 'Visible focal subject.', rect: subjectRect, sourceEdges: [] }, { entityId: 'detail', name: 'Identity detail', role: 'critical-part', evidence: 'Indispensable visible identity.', rect: detailRect, sourceEdges: [] }],
        reason: 'Preserve the visible source and its background.', editPrompt: targetReviews ? 'Correct the dark seam from the rejected version without changing the subject.' : 'Continue the uniform muted green background.' }
    } else {
      assert.equal(input.operation, 'wallpaper-review')
      const actual = input.images.find(image => image.role === 'actual-wallpaper')
      assert.ok(actual)
      if (rejectedOriginals.size < (options.rejectCount ?? 0)) rejectedOriginals.add(source.imageVersionId)
      const reject = badReview || rejectedOriginals.has(source.imageVersionId) || target && ++targetReviews === 1
      result = { reviewVersion: 'wallpaper-review-source-v4', protocol: 'practical-v1', sourceImageVersionId: source.imageVersionId, outputImageVersionId: actual.imageVersionId, mode: 'single', subject: 'Isolated central subject',
        actualLayout: { regions: regions.map(region => ({ ...region, rect: region.role === 'subject' ? outputSubject : outputDetail, scope: 'core' })) },
        defects: reject ? [{ kind: 'collage-seam', severity: 'major', reason: 'The generated background has a dark seam.', outputRect: { x: 0.05, y: 0.05, width: 0.1, height: 0.1 } }] : [], uncertainties: [],
      }
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(wallpaperFixtureResponse(wire, result)) }, finish_reason: 'stop' }] })) }
  }
  let queue: ServerQueue
  const engine = new RunEngine(f.repository, f.jobs, undefined, undefined, options.autoDeliver ? run => queue.deliver(run) : undefined), wallpaper = new WallpaperWorkflows({ domain: f.domain, files: f.files, engine, config: () => config, vision: f.providers.vision, source: f.providers.source, media: f.providers.media, skill: () => ({ id: 'isolated', content: 'Scripted fixture' }), ...(scenario ? { llm: scenario.llm, attachments: scenario.attachments } : {}), ...(options.autoDeliver ? { approved: async (run, imageVersionId) => { await queue.deliver(run, imageVersionId); options.onApproved?.() } } : {}) })
  const direct = new DirectCropTasks({ domain: f.domain, files: f.files, engine, wallpaper, config: () => config })
  const path = join(f.root, 'postman.json'); await writeFile(path, JSON.stringify({ item: [{ request: { method: 'POST', url: { raw: 'https://api.example.test/OperateImage/receive.html' }, body: { formdata: [{ key: 'token', type: 'text', value: 'isolated-token' }] } } }, { request: { method: 'GET', url: { raw: 'https://api.example.test/OperateImage/pull.html' }, body: { mode: 'raw', raw: '{"articles":[]}' } } }] }), 'utf8')
  const deps = { domain: f.domain, files: f.files, engine, direct, credentials: f.host.credentials, config: () => config, signal: new AbortController().signal, http: () => http }
  queue = new ServerQueue(deps)
  await queue.configure({ baseUrl: 'https://api.example.test', auth: { kind: 'postman', path }, allowedMediaOrigins: ['https://images.example.test'] }, f.actor)
  const snapshot = await queue.pull(f.actor, deps.signal)
  const start = async () => { const result = await queue.start({ operationId: 'server-test', name: 'Isolated server batch', snapshotId: snapshot.snapshotId, ids: items.map(item => item.id) }, f.actor, deps.signal); await queue.drain(); await f.jobs.drain(); return f.domain.require('run', result.runId) }
  return { ...f, queue, deps, direct, engine, items, uploads, uploadBatches, pullPages, original, observations, start, scenario, reworkTarget: () => reworkTarget, targetReviews: () => targetReviews, downloads: () => downloads, maxActive: () => maxActive, setMode(value: typeof mode) { mode = value }, rejectReview() { badReview = true }, cleanup: async () => { await engine.dispose(); await queue.drain(); await f.cleanup(); await scenario?.close() } }
}

test('pending pages append every image once and stop at the final page without downloading originals', async () => {
  const f = await fixture(45, { pageSize: 20 })
  try {
    const previewPath = f.queue.read(f.actor).items[0]?.previewPath
    assert.deepEqual(f.queue.read(f.actor).pagination, { loaded: 20, hasMore: true })
    assert.deepEqual((await f.queue.pull(f.actor, f.deps.signal, { next: true })).pagination, { loaded: 40, hasMore: true })
    const complete = await f.queue.pull(f.actor, f.deps.signal, { next: true })
    assert.deepEqual(complete.pagination, { loaded: 45, hasMore: false })
    assert.deepEqual(complete.items.map(item => item.id), f.items.map(item => item.id))
    assert.equal(complete.items[0]?.previewPath, previewPath, 'Appending pages must not reload earlier previews')
    await f.queue.pull(f.actor, f.deps.signal, { next: true })
    assert.deepEqual(f.pullPages, [1, 2, 3])
    assert.equal(f.downloads(), 0)
    assert.equal(f.uploads.length, 0)
    const refreshed = await f.queue.pull(f.actor, f.deps.signal)
    assert.equal(refreshed.items.length, 20)
    assert.deepEqual(refreshed.pagination, { loaded: 20, hasMore: true })
  } finally { await f.cleanup() }
})

test('an ignored page parameter fails without replacing the loaded snapshot and can be retried', async () => {
  const f = await fixture(45, { pageSize: 20 })
  try {
    const before = f.queue.read(f.actor), http = f.deps.http()
    f.deps.http = () => ({ request: async (url, request) => {
      const response = await http.request(url, request)
      const page = serverPullSchema.parse(JSON.parse(response.bytes.toString('utf8')))
      return { ...response, bytes: Buffer.from(JSON.stringify({ ...page, page: 1 })) }
    } })
    await assert.rejects(f.queue.pull(f.actor, f.deps.signal, { next: true }), { code: 'source-protocol-error' })
    assert.equal(f.queue.read(f.actor).snapshotId, before.snapshotId)
    assert.deepEqual(f.queue.read(f.actor).pagination, before.pagination)
    f.deps.http = () => http
    assert.equal((await f.queue.pull(f.actor, f.deps.signal, { next: true })).items.length, 40)
  } finally { await f.cleanup() }
})

test('legacy pending snapshots refresh the first page before continuing without dropping saved records', async () => {
  const f = await fixture(45, { pageSize: 20 })
  try {
    const saved = f.repository.manifests('server-snapshot:')[0]
    assert.ok(saved)
    const state = z.record(z.string(), z.unknown()).parse(saved.state)
    delete state.pagination
    await f.repository.commit({ aggregateId: saved.aggregateId, expectedRevision: saved.revision, operationId: 'legacy-page', request: {}, records: [], state: toJson(state) })
    await f.queue.pull(f.actor, f.deps.signal, { next: true })
    assert.deepEqual(f.pullPages, [1, 1])
    assert.equal((await f.queue.pull(f.actor, f.deps.signal, { next: true })).items.length, 40)
    assert.deepEqual(f.pullPages, [1, 1, 2])
  } finally { await f.cleanup() }
})

test('changed counts, overlapping pages and truncated pages preserve the earlier complete page for retry', async () => {
  const f = await fixture(45, { pageSize: 20 })
  try {
    const before = f.queue.read(f.actor), http = f.deps.http()
    let mode = 'count'
    f.deps.http = () => ({ request: async (url, request) => {
      const response = await http.request(url, request), reply = serverPullSchema.parse(JSON.parse(response.bytes.toString('utf8')))
      return { ...response, bytes: Buffer.from(JSON.stringify({ ...reply, total: mode === 'count' ? 44 : reply.total, data: mode === 'overlap' ? [...f.items.slice(0, 1), ...reply.data.slice(1)] : mode === 'short' ? reply.data.slice(1) : reply.data })) }
    } })
    for (const scenario of [{ mode: 'count', code: 'revision-conflict' }, { mode: 'overlap', code: 'revision-conflict' }, { mode: 'short', code: 'source-protocol-error' }]) {
      mode = scenario.mode
      await assert.rejects(f.queue.pull(f.actor, f.deps.signal, { next: true }), { code: scenario.code })
      assert.deepEqual(f.queue.read(f.actor), before)
    }
    f.deps.http = () => http
    assert.equal((await f.queue.pull(f.actor, f.deps.signal, { next: true })).items.length, 40)
  } finally { await f.cleanup() }
})

test('upload verification finds selected originals beyond the first pending page', async () => {
  const f = await fixture(21, { pageSize: 20 })
  try {
    const snapshot = await f.queue.pull(f.actor, f.deps.signal, { next: true }), selected = f.items.slice(-2)
    const result = await f.queue.start({ operationId: 'later-page', snapshotId: snapshot.snapshotId, name: 'Later page', ids: selected.map(item => item.id) }, f.actor, f.deps.signal)
    await f.queue.drain(); await f.jobs.drain()
    await f.queue.deliver(f.domain.require('run', result.runId))
    assert.deepEqual(f.uploads.map(row => row.id), selected.map(item => item.id))
    assert.deepEqual(f.pullPages.slice(-2), [1, 2])
    const records = [...f.repository.list('run')]
    const refreshed = await f.queue.pull(f.actor, f.deps.signal)
    assert.deepEqual(refreshed.pagination, { loaded: 20, hasMore: true })
    assert.equal(refreshed.items.length, 21, 'The owned later-page task survives a pending-list refresh')
    assert.equal(refreshed.items.find(item => item.id === selected[1]?.id)?.transfer?.status, 'uploaded')
    assert.deepEqual(f.repository.list('run'), records)
  } finally { await f.cleanup() }
})

test('server originals import concurrently, retain independent IDs and upload only reviewed clean PNGs once', async () => {
  const f = await fixture(2)
  try {
    assert.equal(JSON.stringify(f.queue.read(f.actor)).includes('isolated-token'), false)
    assert.deepEqual(presented(f.queue.read(f.actor)), expected.pending)
    const run = await f.start(); assert.equal(run.status, 'completed')
    const state = wallpaperStateSchema.parse(dataOf(run).checkpoint.wallpaper)
    assert.equal(run.outcome, 'target-met', JSON.stringify(state.items.map(({ status, reason, errorCode, attempts }) => ({ status, reason, errorCode, placement: attempts[0]?.plan.placement }))))
    assert.equal(f.maxActive(), 2); assert.equal(state.items.filter(item => item.status === 'passed').length, 2)
    await f.queue.deliver(run); await f.queue.deliver(run)
    assert.deepEqual(f.uploadBatches, [['11', '12']]); assert.deepEqual(f.uploads.map(row => row.id), ['11', '12']); assert.ok(f.uploads.every(row => row.width === 1845 && row.height === 3280))
    assert.ok(serverQueueViewSchema.parse(f.queue.read(f.actor)).items.every(row => row.transfer?.status === 'uploaded'))
    assert.deepEqual(presented(f.queue.read(f.actor)), expected.accepted)
    const before = f.observations.length; await f.queue.recover(); await f.start()
    assert.equal(f.uploads.length, 2); assert.equal(f.downloads(), 2); assert.equal(f.observations.length, before)
  } finally { await f.cleanup() }
})

test('approved outputs wait for the whole batch and use one multipart request', { timeout: 20000 }, async () => {
  const release = Promise.withResolvers<void>(), approved = Promise.withResolvers<void>(), reviewing = Promise.withResolvers<void>()
  const f = await fixture(2, { autoDeliver: true, secondReview: release.promise, onSecondReview: reviewing.resolve, onApproved: approved.resolve })
  const started = f.start()
  try {
    await Promise.all([approved.promise, reviewing.promise])
    assert.equal(f.uploadBatches.length, 0)
    const row = f.queue.read(f.actor).items.find(item => item.phase === 'approved')!
    assert.equal(serverImageComplete(row), false)
    assert.equal(f.domain.require('run', row.runId!).status, 'running')
    release.resolve()
    const run = await started
    await f.queue.deliver(run); await f.queue.recover()
    assert.deepEqual(f.uploadBatches, [['11', '12']])
    assert(f.queue.read(f.actor).items.every(serverImageComplete))
  } finally { release.resolve(); await started; await f.cleanup() }
})

test('a server batch regenerates a rejected complete canvas and delivers only independently approved artifacts', { timeout: 60000 }, async () => {
  const f = await fixture(2, { autoDeliver: true, rework: true })
  try {
    const run = await f.start(), state = wallpaperStateSchema.parse(dataOf(run).checkpoint.wallpaper)
    const revised = state.items.find(item => item.imageVersionId === f.reworkTarget())
    assert.ok(revised)
    assert.equal(revised.status, 'passed', JSON.stringify({ reason: revised.reason, error: revised.errorCode, step: revised.failedStep, edits: revised.edits, operations: f.observations, placement: revised.attempts[0]?.plan.placement }))
    assert.equal(run.outcome, 'target-met')
    assert.equal(f.downloads(), 2)
    const reviewed = revised.attempts.filter(attempt => attempt.review)
    assert.deepEqual(reviewed.map(attempt => attempt.review!.checks.background.result), ['violated', 'satisfied'])
    assert.equal(f.scenario!.generations.size, 2)
    assert.equal(f.targetReviews(), 3, 'Both generated candidates receive a native review and the accepted delivery pixels receive a final review')
    assert.equal(reviewed[1]!.postResolutionReview?.imageVersionId, reviewed[1]!.outputId)
    assert.ok(reviewed.every(attempt => attempt.compositionMode === 'generated-canvas-v1' && !attempt.sourceIntentProof))
    assert.deepEqual(reviewed.map(attempt => attempt.generationInput?.references.map(reference => reference.role)), [['original'], ['original']])
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

// Five full-resolution workflows and two reselected originals also pay native Intel media encoding costs.
test('five selected originals upload the three approved results together and keep failures selectable', { timeout: 120000 }, async () => {
  const f = await fixture(5, { autoDeliver: true, rejectCount: 2 })
  try {
    const run = await f.start(), rows = f.queue.read(f.actor).items
    assert.equal(run.status, 'completed')
    assert.equal(rows.filter(serverImageComplete).length, 3)
    assert.equal(rows.filter(row => row.phase === 'attention').length, 2)
    assert.equal(f.uploadBatches.length, 1)
    assert.equal(f.uploadBatches[0]!.length, 3)
    assert.deepEqual(f.uploadBatches[0], rows.filter(serverImageComplete).map(row => row.id))
    const failed = rows.filter(row => row.phase === 'attention')
    const retry = await f.queue.start({ operationId: 'retry-unqualified', name: 'Retry failed originals', snapshotId: f.queue.read(f.actor).snapshotId, ids: failed.map(row => row.id) }, f.actor, f.deps.signal)
    await f.queue.drain(); await f.jobs.drain()
    assert.notEqual(retry.runId, run.id)
    assert.equal(f.downloads(), 5)
    assert.equal(f.direct.list(f.actor).total, 2)
    await assert.rejects(f.queue.start({ operationId: 'repeat-completed', name: 'Already complete', snapshotId: f.queue.read(f.actor).snapshotId, ids: [rows.find(serverImageComplete)!.id] }, f.actor, f.deps.signal), error => error instanceof CuratorError && error.code === 'constraint-conflict')
  } finally { await f.cleanup() }
})

test('reselected originals belong to the new batch while the previous task and unselected output are retained', async () => {
  const f = await fixture(2)
  try {
    const first = await f.start(), view = f.queue.read(f.actor)
    const receipt = await f.queue.start({ operationId: 'reselect-one', name: 'Selected again', snapshotId: view.snapshotId, ids: ['11'] }, f.actor, f.deps.signal)
    await f.queue.drain(); await f.jobs.drain()
    assert.equal(f.queue.read(f.actor).items[0]!.runId, receipt.runId)
    assert.equal(f.queue.read(f.actor).items[1]!.runId, first.id)
    assert.equal(f.direct.list(f.actor).total, 2)
    assert.equal(f.downloads(), 2)
    await f.queue.deliver(first)
    assert.deepEqual(f.uploadBatches, [['12']], 'The old batch cannot deliver a reselected image')
    await f.queue.deliver(f.domain.require('run', receipt.runId))
    assert.deepEqual(f.uploadBatches, [['12'], ['11']])
    assert(f.queue.read(f.actor).items.every(serverImageComplete))
    assert.equal(f.domain.require('run', first.id).status, 'completed')
  } finally { await f.cleanup() }
})

test('an uncertain multi-image transmission remains selectable without automatically resending either image', async () => {
  const f = await fixture(2)
  try {
    f.setMode('timeout'); const first = await f.start(); await f.queue.deliver(first)
    assert.deepEqual(f.uploadBatches, [['11', '12']])
    const restarted = new ServerQueue(f.deps); await restarted.initialize(); await restarted.recover()
    const view = restarted.read(f.actor)
    assert(view.items.every(row => row.transfer?.status === 'unknown' && !serverImageComplete(row)))
    const receipt = await restarted.start({ operationId: 'reselect-unknown', name: 'Recheck quality', snapshotId: view.snapshotId, ids: ['11', '12'] }, f.actor, f.deps.signal)
    await restarted.drain(); await f.jobs.drain()
    f.setMode('success'); await restarted.deliver(f.domain.require('run', receipt.runId))
    await restarted.transmission({ runId: receipt.runId, id: '12' }, f.actor, false)
    assert.deepEqual(f.uploadBatches, [['11', '12']])
    assert.equal(f.direct.list(f.actor).total, 2)
    assert.equal(f.downloads(), 2)
  } finally { await f.cleanup() }
})

for (const mode of ['duplicate-index', 'partial'] as const) test(`${mode} batch receipts cannot confirm completion or authorize a resend`, async () => {
  const f = await fixture(2)
  try {
    f.setMode(mode); const run = await f.start(); await f.queue.deliver(run)
    assert(f.queue.read(f.actor).items.every(row => row.transfer?.status === 'unknown' && !serverImageComplete(row)))
    await f.queue.recover()
    for (const id of ['11', '12']) {
      await f.queue.transmission({ runId: run.id, id }, f.actor, false)
      await assert.rejects(f.queue.transmission({ runId: run.id, id }, f.actor, true), error => error instanceof CuratorError && error.code === 'constraint-conflict')
    }
    assert.deepEqual(f.uploadBatches, [['11', '12']])
  } finally { await f.cleanup() }
})

test('reselecting a processing image transfers delivery ownership before either batch can send it', { timeout: 20000 }, async () => {
  const release = Promise.withResolvers<void>(), approved = Promise.withResolvers<void>(), reviewing = Promise.withResolvers<void>()
  const f = await fixture(2, { autoDeliver: true, secondReview: release.promise, onSecondReview: reviewing.resolve, onApproved: approved.resolve }), started = f.start()
  try {
    await Promise.all([approved.promise, reviewing.promise])
    const view = f.queue.read(f.actor), receipt = await f.queue.start({ operationId: 'reselect-live', name: 'New live selection', snapshotId: view.snapshotId, ids: ['11'] }, f.actor, f.deps.signal)
    await f.queue.drain()
    assert.equal(f.queue.read(f.actor).items.find(row => row.id === '11')!.runId, receipt.runId)
    release.resolve(); await started; await f.jobs.drain(); await f.queue.drain()
    assert.deepEqual(f.uploads.map(row => row.id).sort(), ['11', '12'])
    assert.equal(f.uploadBatches.length, 2)
    assert.equal(f.direct.list(f.actor).total, 2)
    assert.equal(f.downloads(), 2)
  } finally { release.resolve(); await started; await f.cleanup() }
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


test('interrupted imports retain verified originals and resume the same batch after more pages load', async () => {
  const f = await fixture(3, { pageSize: 2 }), originalHttp = f.deps.http()
  let failSecond = true
  f.deps.http = () => ({ request: async (url, request) => { const response = await originalHttp.request(url, request); if (failSecond && url.endsWith('/1')) throw new MediaError('remote-timeout', 'network', true, 'Isolated import timeout.', 'Retry the import.'); return response } })
  const imageRoute = { imageProvider: 'autoflow-codex', imageSourceId: 'selected-server-account', imageModel: 'gpt-image-2' }
  const view = f.queue.read(f.actor), input = { operationId: 'resumable-import', name: 'Resumable originals', snapshotId: view.snapshotId, ids: view.items.map(item => item.id), imageRoute }
  try {
    const receipt = await f.queue.start(input, f.actor, f.deps.signal); await f.queue.drain()
    assert.equal(f.queue.imports(f.actor)[0]!.status, 'failed'); assert.equal(f.queue.imports(f.actor)[0]!.saved, 1); assert.equal(f.downloads(), 2)
    const manifest = f.repository.manifests('server-admission:')[0]!, state = z.record(z.string(), z.json()).parse(manifest.state)
    await f.repository.commit({ aggregateId: manifest.aggregateId, expectedRevision: manifest.revision, operationId: 'isolated-crash-marker', request: { isolated: true }, records: [], state: { ...state, status: 'importing' } })
    const restarted = new ServerQueue(f.deps); await restarted.initialize()
    assert.equal(restarted.imports(f.actor)[0]!.status, 'interrupted'); assert.equal(restarted.imports(f.actor)[0]!.saved, 1); assert.equal(f.downloads(), 2, 'Initialization never silently resumes original downloads')
    const expanded = await restarted.pull(f.actor, f.deps.signal, { next: true })
    assert.deepEqual(expanded.items.map(item => item.id), f.items.map(item => item.id))
    failSecond = false
    f.deps.config().wallpaper.imageModel = 'changed-global-model'
    const retry = await restarted.retryImport({ runId: receipt.runId }, f.actor, f.deps.signal); assert.equal(retry.runId, receipt.runId)
    await restarted.drain(); await f.jobs.drain()
    assert.equal(f.downloads(), 3, 'The verified first original is reused')
    assert.equal(f.direct.list(f.actor).batches[0]!.runId, receipt.runId); assert.equal(restarted.imports(f.actor).length, 0)
    const route = wallpaperSettingsSchema.parse(specOf(f.domain.require('run', receipt.runId)).fixed.wallpaper)
    assert.deepEqual({ imageProvider: route.imageProvider, imageSourceId: route.imageSourceId, imageModel: route.imageModel }, imageRoute)
    const repeated = await restarted.start({ ...input, operationId: 'another-click' }, f.actor, f.deps.signal)
    assert.notEqual(repeated.runId, receipt.runId); await restarted.drain(); await f.jobs.drain(); assert.equal(f.direct.list(f.actor).total, 2); assert.equal(f.downloads(), 3)
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
    const item = view.items[0]; assert.ok(item?.previewPath)
    const previewKey = new URL(item.previewPath, 'https://isolated.example').searchParams.get('serverSnapshotId'); assert.ok(previewKey)
    const stablePreview = await f.queue.preview(item.id, previewKey, f.actor, f.deps.signal)
    assert.equal(stablePreview.bytes.equals(f.original), true)
    assert.equal(f.repository.manifests('server-import:').length, before); assert.equal(f.queue.read(f.actor).items[0]!.imported, false); assert.equal(f.direct.list(f.actor).total, 0); assert.equal(f.uploads.length, 0)
    await assert.rejects(f.queue.preview(f.items[0]!.id, 'stale-snapshot', f.actor, f.deps.signal), error => error instanceof CuratorError && error.code === 'reference-unavailable')
    await assert.rejects(f.queue.preview(f.items[0]!.id, view.snapshotId, { ...f.actor, kind: 'agent' }, f.deps.signal), error => error instanceof CuratorError && error.code === 'owner-denied')
    assert.equal(f.downloads(), 2)
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
