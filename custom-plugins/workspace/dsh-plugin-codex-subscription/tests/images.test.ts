import test from 'node:test'
import assert from 'node:assert/strict'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { ImageService } from '../src/host/images/service.ts'
import { ImageServiceError } from '../src/host/images/errors.ts'
import { assertPublicImageUrl, decodeImageDataUrl } from '../src/host/images/remote.ts'
import type { ImageAssetRecord, ImageOwner, ImageServiceOptions, ImageTask, ImageTaskRepository } from '../src/host/images/types.ts'
import { parseImageAssetId, parseImageTaskId } from '../src/host/images/ids.ts'
import { imageTaskSchema } from '../src/host/tasks/repository.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
const owner: ImageOwner = { kind: 'session', sessionId: 'session-one', toolCallId: 'generate-one' }
const asset: ImageAssetRecord = { id: parseImageAssetId('asset-one'), mimeType: 'image/png',
  original: { attachmentId: AttachmentId('original-one'), bytes: png.length, name: 'original.png' },
  preview: { attachmentId: AttachmentId('preview-one'), mediaType: 'image/png', bytes: png.length, width: 1, height: 1 } }

async function fixture(overrides: Partial<ImageServiceOptions> = {}, initial: ImageTask[] = []) {
  const records = new Map(initial.map(task => { const record = imageTaskSchema.parse(task); return [record.id, record] }))
  const writes: ImageTask[] = []
  const errors: Error[] = []
  const requests: { url: string; init: RequestInit | undefined }[] = []
  let id = 0
  const repository: ImageTaskRepository = {
    get: key => Promise.resolve(structuredClone(records.get(key))), list: () => Promise.resolve([...records.values()].map(task => structuredClone(task))),
    put: task => { records.set(task.id, structuredClone(task)); writes.push(structuredClone(task)); return Promise.resolve() },
    delete: key => { records.delete(key); return Promise.resolve() }, close: () => Promise.resolve(),
  }
  const options: ImageServiceOptions = {
    repository,
    withAccount: async (_request, operation) => operation({ accountKey: 'account-one', accountId: 'workspace-one', accessToken: 'do-not-persist-token', signal: _request.signal ?? new AbortController().signal, headers: { Authorization: 'Bearer do-not-persist-token', 'chatgpt-account-id': 'workspace-one' } }),
    saveAssets: () => Promise.resolve([asset]), readAsset: () => Promise.resolve({ data: png, mimeType: 'image/png' }),
    validateReference: () => Promise.resolve(),
    fetch: async (url, init) => { requests.push({ url: String(url), init }); return Response.json({ data: [{ b64_json: png.toString('base64') }] }) },
    baseUrl: 'https://chatgpt.com/backend-api/codex', clientVersion: '0.153.4', defaultModel: 'gpt-image-2', timeoutMs: 10_000,
    maxConcurrent: 1, maxQueued: 2, maxReferenceImages: 2, maxImageBytes: 1024, maxResponseBytes: 8192, maxPromptChars: 200,
    maxRedirects: 2, maxHistoryTasks: 10, id: () => `id-${++id}`, reportError: error => { errors.push(error) }, ...overrides,
  }
  const service = new ImageService(options)
  await service.initialize()
  return { service, options, records, writes, errors, requests }
}

test('Codex generations use JSON image headers, preserve original assets, and never persist the lease', async () => {
  const f = await fixture()
  try {
    const task = await f.service.submit({ prompt: 'A green square', n: 2, size: '1024x1024', quality: 'high', background: 'transparent' }, owner)
    const done = await f.service.getResult(task.id, owner, { waitMs: 1000 })
    assert.equal(done.state, 'succeeded')
    assert.deepEqual(f.writes.map(item => item.state), ['queued', 'sent', 'sent', 'succeeded'])
    assert.equal(f.requests[0]?.url, 'https://chatgpt.com/backend-api/codex/images/generations')
    assert.deepEqual(JSON.parse(String(f.requests[0]?.init?.body)), { prompt: 'A green square', n: 2, size: '1024x1024', quality: 'high', background: 'transparent', model: 'gpt-image-2' })
    const headers = new Headers(f.requests[0]?.init?.headers)
    assert.equal(headers.get('Accept'), 'application/json')
    assert.ok(headers.get('x-codex-imagegen-request-id'))
    assert.ok(headers.get('x-codex-image-turn-id'))
    assert.equal(headers.get('version'), '0.153.4')
    assert.match(headers.get('User-Agent') ?? '', /^codex_cli_rs\/0\.153\.4 /)
    assert.equal(done.assets[0]?.original.attachmentId, 'original-one')
    assert.equal(done.assets[0]?.preview.attachmentId, 'preview-one')
    assert.ok(!JSON.stringify(f.writes).includes('do-not-persist-token'))
    assert.deepEqual(await f.service.readAsset(task.id, 'asset-one', owner), { data: png, mimeType: 'image/png' })
  } finally { await f.service.dispose() }
})

test('image receipts separate requested settings, provider reports and saved pixel dimensions without retaining private payloads', async () => {
  let calls = 0, saves = 0
  let sentHeaders = new Headers()
  const savedBytes: Uint8Array[] = []
  const f = await fixture({ fetch: async (_url, init) => {
    calls++
    sentHeaders = new Headers(init?.headers)
    return Response.json({ size: '941x1672', quality: 'low', output_format: 'png', data: [
      { b64_json: png.toString('base64'), generation_id: 'generation-one', url: 'https://images.example/result?signature=private-signed-query' },
      { b64_json: png.toString('base64'), generation_id: 'generation-two' },
    ], privateBody: 'private-response-body' }, { headers: { 'x-codex-imagegen-request-id': 'image-response-one', 'x-oai-request-id': 'oai-response-one', 'x-request-id': 'response-one', authorization: 'Bearer private-response-token', 'set-cookie': 'private-cookie' } })
  }, saveAssets: async images => { savedBytes.push(...images.map(image => image.data)); return [{ ...asset, id: parseImageAssetId(`asset-${++saves}`) }] } })
  try {
    const accepted = await f.service.submit({ prompt: 'Keep requested and actual facts separate', size: '1872x3328', quality: 'high', outputFormat: 'webp', n: 2 }, owner)
    const done = await f.service.getResult(accepted.id, owner, { waitMs: 1000 })
    const headers = sentHeaders
    const requested = { size: '1872x3328', quality: 'high', outputFormat: 'webp', imagegenRequestId: headers.get('x-codex-imagegen-request-id'), imageTurnId: headers.get('x-codex-image-turn-id') }
    assert.equal(done.state, 'succeeded')
    assert.equal(calls, 1)
    assert.deepEqual(done.evidence, { requested, reported: { size: '941x1672', quality: 'low', outputFormat: 'png', imagegenRequestId: 'image-response-one', oaiRequestId: 'oai-response-one', requestId: 'response-one' } })
    assert.deepEqual(f.writes.find(task => task.state === 'sent')?.evidence?.requested, requested)
    assert.deepEqual(done.assets.map(image => image.generationId), ['generation-one', 'generation-two'])
    assert.deepEqual(done.assets.map(image => [image.preview.width, image.preview.height]), [[1, 1], [1, 1]])
    assert.deepEqual(savedBytes, [png, png])
    assert.deepEqual(imageTaskSchema.parse(f.records.get(parseImageTaskId(done.id))).evidence, done.evidence)
    assert.deepEqual(imageTaskSchema.parse(f.records.get(parseImageTaskId(done.id))).assets, done.assets)
    const durable = JSON.stringify(f.writes)
    for (const privateValue of ['base64', png.toString('base64'), 'do-not-persist-token', 'private-signed-query', 'private-response-body', 'private-response-token', 'private-cookie']) assert.equal(durable.includes(privateValue), false)
  } finally { await f.service.dispose() }
})

test('malformed advisory metadata cannot discard a paid image or become a durable signed URL', async () => {
  let calls = 0
  const f = await fixture({ fetch: async () => { calls++; return Response.json({ size: 'https://images.example/private', quality: { token: 'private-metadata' }, output_format: 'Bearer private-metadata', data: [{ b64_json: png.toString('base64'), generation_id: 'https://images.example/private?token=secret' }] }, { headers: { 'x-oai-request-id': 'https://images.example/private', 'x-request-id': 'Bearer private-metadata' } }) } })
  try {
    const accepted = await f.service.submit({ prompt: 'No explicit size or quality' }, owner)
    const done = await f.service.getResult(accepted.id, owner, { waitMs: 1000 })
    assert.equal(done.state, 'succeeded')
    assert.equal(calls, 1)
    assert.equal(done.evidence?.requested.size, undefined)
    assert.equal(done.evidence?.requested.quality, undefined)
    assert.equal(done.evidence?.requested.outputFormat, undefined)
    assert.equal(done.evidence?.reported, undefined)
    assert.equal(done.assets[0]?.generationId, undefined)
    assert.deepEqual((await f.service.readAsset(done.id, 'asset-one', owner)).data, png)
    assert.equal(JSON.stringify(f.writes).includes('private-metadata'), false)
    assert.equal(JSON.stringify(f.writes).includes('https://images.example'), false)
  } finally { await f.service.dispose() }
})

test('historical tasks remain readable without invented request, response or generation metadata', async () => {
  const legacy: ImageTask = { id: 'legacy-image', owner, state: 'succeeded', prompt: 'An older image', model: 'gpt-image-2', createdAt: 1, updatedAt: 2, deadlineAt: 3, assets: [asset] }
  const f = await fixture({}, [legacy])
  try {
    const task = await f.service.getResult(legacy.id, owner)
    assert.deepEqual(task, legacy)
    assert.equal(task.evidence, undefined)
    assert.equal(task.assets[0]?.generationId, undefined)
    assert.deepEqual(imageTaskSchema.parse(JSON.parse(JSON.stringify(legacy))), legacy)
    assert.equal(f.writes.length, 0)
    assert.equal(f.requests.length, 0)
  } finally { await f.service.dispose() }
})

test('image refusal metadata survives durable task projection without retrying or exposing the body', async () => {
  const now = Date.now()
  let calls = 0
  const f = await fixture({ now: () => now, fetch: async () => { calls++; return Response.json({ error: { message: 'private upstream body', code: 'rate_limit_exceeded' } }, {
    status: 429, headers: { 'retry-after': '120', 'x-request-id': 'req_image_quota' },
  }) } })
  try {
    const submitted = await f.service.submit({ prompt: 'Known refusal' }, owner)
    const task = await f.service.getResult(submitted.id, owner, { waitMs: 1000 })
    assert.equal(task.state, 'failed'); assert.equal(calls, 1)
    assert.equal(task.error?.status, 429); assert.equal(task.error?.retryAt, now + 120000); assert.equal(task.error?.requestId, 'req_image_quota')
    assert.equal(task.evidence?.reported?.requestId, 'req_image_quota')
    assert.deepEqual(imageTaskSchema.parse(f.records.get(parseImageTaskId(task.id))).error, task.error)
    assert.equal(JSON.stringify(task).includes('private upstream'), false)
  } finally { await f.service.dispose() }
})

test('automatic model checks carry account and quota guards and reuse an uncertain receipt', async () => {
  let admitted = 0
  const f = await fixture({ withAccount: async (request, operation) => {
    assert.equal(request.accountKey, 'account-probe'); assert.deepEqual(request.includedQuotaOnly, { minimumRemainingPercent: 50 }); admitted++
    return operation({ accountKey: 'account-probe', accountId: 'workspace-probe', accessToken: 'fixture', signal: request.signal!, headers: {} })
  } })
  try {
    const input = { prompt: 'Probe', model: 'gpt-image-2.6-sunburst', size: '1024x1024' }, operation = { id: 'probe-operation', digest: 'probe-digest' }
    const submitted = await f.service.submitProbe(input, 'account-probe', operation, 50, new AbortController().signal)
    const probeOwner: ImageOwner = { kind: 'gateway', keyId: 'model-access-probe:account-probe' }
    const done = await f.service.getResult(submitted.id, probeOwner, { waitMs: 1000 })
    assert.equal(done.state, 'succeeded'); assert.equal(done.accountKey, 'account-probe')
    f.records.set(parseImageTaskId(done.id), imageTaskSchema.parse({ ...done, state: 'outcome-unknown' }))
    const recovered = await f.service.submitProbe(input, 'account-probe', operation, 50, new AbortController().signal)
    assert.equal(recovered.id, done.id); assert.equal(recovered.state, 'outcome-unknown')
    assert.equal(admitted, 1); assert.equal(f.requests.length, 1)
  } finally { await f.service.dispose() }
})

test('Codex edits normalize references into JSON images rather than multipart or local paths', async () => {
  const f = await fixture()
  try {
    const reference = `data:image/png;base64,${png.toString('base64')}`
    const task = await f.service.submit({ prompt: 'Add a cloud', referenceImages: [reference], mask: reference }, owner)
    assert.equal((await f.service.getResult(task.id, owner, { waitMs: 1000 })).state, 'succeeded')
    assert.ok(f.requests[0]?.url.endsWith('/images/edits'))
    assert.deepEqual(JSON.parse(String(f.requests[0]?.init?.body)).images, [{ image_url: `data:image/png;base64,${png.toString('base64')}` }])
    assert.deepEqual(JSON.parse(String(f.requests[0]?.init?.body)).mask, { image_url: reference })
    assert.ok(!JSON.stringify(f.writes).includes('base64'))
  } finally { await f.service.dispose() }
})

test('Codex image size ratios and output encoding pass through to the JSON endpoint', async () => {
  const f = await fixture()
  try {
    const task = await f.service.submit({ prompt: 'A landscape', size: '16:9', outputFormat: 'webp' }, owner)
    const done = await f.service.getResult(task.id, owner, { waitMs: 1000 })
    assert.equal(done.state, 'succeeded')
    const body = JSON.parse(String(f.requests[0]?.init?.body))
    assert.equal(body.size, '16:9')
    assert.equal(body.output_format, 'webp')
    assert.equal(body.outputFormat, undefined)
  } finally { await f.service.dispose() }
})

test('mask-only input and raster decoding failure are rejected before account dispatch', async () => {
  let validated = 0
  const f = await fixture({ validateReference: async () => { if (++validated === 2) throw new Error('invalid raster mask') } })
  try {
    const reference = `data:image/png;base64,${png.toString('base64')}`
    await assert.rejects(f.service.submit({ prompt: 'Mask needs reference', mask: reference }, owner), /requires at least one reference/)
    const accepted = await f.service.submit({ prompt: 'Validate mask', referenceImages: [reference], mask: reference }, owner)
    const done = await f.service.getResult(accepted.id, owner, { waitMs: 1000 })
    assert.equal(validated, 2)
    assert.equal(done.state, 'failed')
    assert.equal(f.requests.length, 0)
    assert.ok(!JSON.stringify(f.writes).includes('base64'))
  } finally { await f.service.dispose() }
})

test('foreign Session and gateway keys cannot list, read, cancel, or read task assets', async () => {
  const f = await fixture()
  try {
    const task = await f.service.submit({ prompt: 'Owned image' }, owner)
    await f.service.getResult(task.id, owner, { waitMs: 1000 })
    for (const foreign of [{ kind: 'session', sessionId: 'other' }, { kind: 'gateway', keyId: 'session-one' }] satisfies ImageOwner[]) {
      assert.deepEqual(await f.service.list(foreign), [])
      await assert.rejects(f.service.getResult(task.id, foreign), /unavailable/)
      await assert.rejects(f.service.cancel(task.id, foreign), /unavailable/)
      await assert.rejects(f.service.readAsset(task.id, 'asset-one', foreign), /unavailable/)
    }
    assert.equal((await f.service.list({ kind: 'session', sessionId: 'session-one', toolCallId: 'later-call' })).length, 1)
    assert.equal((await f.service.listAll()).length, 1)
  } finally { await f.service.dispose() }
})

test('a sent cancellation records unknown outcome and never retries another account', async () => {
  let announce!: () => void
  const dispatched = new Promise<void>(resolve => { announce = resolve })
  let sends = 0
  const f = await fixture({ fetch: async (_url, init) => {
    sends++; announce()
    return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }) })
  } })
  try {
    const task = await f.service.submit({ prompt: 'One request only' }, owner)
    await dispatched
    assert.equal((await f.service.cancel(task.id, owner)).state, 'outcome-unknown')
    await f.service.dispose()
    assert.equal((await f.service.getResult(task.id, owner)).state, 'outcome-unknown')
    assert.equal(sends, 1)
  } finally { await f.service.dispose() }
})

test('cancelled result waits do not cancel accepted generations', async () => {
  let complete!: (response: Response) => void
  const f = await fixture({ fetch: () => new Promise<Response>(resolve => { complete = resolve }) })
  try {
    const task = await f.service.submit({ prompt: 'Continue in background' }, owner)
    const controller = new AbortController()
    const waiting = f.service.getResult(task.id, owner, { waitMs: 1000, signal: controller.signal })
    controller.abort(new Error('wait cancelled'))
    await assert.rejects(waiting, /wait cancelled/)
    while (complete === undefined) await new Promise(resolve => setImmediate(resolve))
    complete(Response.json({ data: [{ b64_json: png.toString('base64') }] }))
    assert.equal((await f.service.getResult(task.id, owner, { waitMs: 1000 })).state, 'succeeded')
  } finally { await f.service.dispose() }
})

test('restart never resends dispatched or queued tasks', async () => {
  const base: ImageTask = { id: 'interrupted', owner, state: 'sent', prompt: 'Before restart', model: 'gpt-image-2', createdAt: 1, updatedAt: 2, deadlineAt: 3, assets: [] }
  const f = await fixture({}, [base, { ...base, id: 'not-sent', state: 'queued' }])
  try {
    assert.equal((await f.service.getResult('interrupted', owner)).state, 'outcome-unknown')
    assert.equal((await f.service.getResult('not-sent', owner)).state, 'cancelled')
    assert.equal(f.requests.length, 0)
  } finally { await f.service.dispose() }
})

test('new settings apply only to new tasks and bounded history requires explicit cleanup', async () => {
  const f = await fixture()
  try {
    const first = await f.service.submit({ prompt: 'Old settings' }, owner)
    f.service.updateSettings({ ...f.options, defaultModel: 'new-image-model', baseUrl: 'https://new.example/codex', maxHistoryTasks: 2 })
    const second = await f.service.submit({ prompt: 'New settings' }, owner)
    await f.service.getResult(second.id, owner, { waitMs: 1000 })
    assert.equal((await f.service.getResult(first.id, owner)).model, 'gpt-image-2')
    assert.equal(f.requests[0]?.url, 'https://chatgpt.com/backend-api/codex/images/generations')
    assert.equal(f.requests[1]?.url, 'https://new.example/codex/images/generations')
    await assert.rejects(f.service.submit({ prompt: 'History is full' }, owner), /history is full/)
    assert.equal(await f.service.pruneCompleted(Date.now() + 1), 2)
  } finally { await f.service.dispose() }
})

test('known HTTP errors redact backend bodies, while network failure after send is unknown', async () => {
  const rejected = await fixture({ fetch: async () => new Response('Bearer backend-secret', { status: 429 }) })
  const disconnected = await fixture({ fetch: async () => { throw new Error('backend-secret transport') } })
  try {
    const task = await rejected.service.submit({ prompt: 'Quota' }, owner)
    const done = await rejected.service.getResult(task.id, owner, { waitMs: 1000 })
    assert.equal(done.state, 'failed'); assert.equal(done.error?.status, 429)
    assert.ok(!JSON.stringify(done).includes('backend-secret'))
    const sent = await disconnected.service.submit({ prompt: 'Network uncertain' }, owner)
    assert.equal((await disconnected.service.getResult(sent.id, owner, { waitMs: 1000 })).state, 'outcome-unknown')
  } finally { await rejected.service.dispose(); await disconnected.service.dispose() }
})

test('image inputs and references reject invalid n, MIME aliases, oversized bytes and private destinations', async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.service.submit({ prompt: 'Bad count', n: 5 }, owner), ImageServiceError)
    assert.throws(() => decodeImageDataUrl(`data:image/jpeg;base64,${png.toString('base64')}`, 1024), /does not match/)
    assert.throws(() => decodeImageDataUrl(`data:image/png;base64,${png.toString('base64')}`, 4), /limit/)
    for (const url of ['http://127.0.0.1/image', 'http://169.254.169.254/image', 'file:///tmp/image.png', 'https://user:password@example.com/image', 'http://[::1]/image', 'http://example.com:8080/image']) {
      assert.throws(() => assertPublicImageUrl(new URL(url)), ImageServiceError)
    }
    const local = await f.service.submit({ prompt: 'Reject local path', referenceImages: ['D:\\secret.png'] }, owner)
    assert.equal((await f.service.getResult(local.id, owner, { waitMs: 1000 })).state, 'failed')
    assert.equal(f.requests.length, 0)
  } finally { await f.service.dispose() }
})

test('queued cancellation does not dispatch a second paid request and disposal drains its terminal write', async () => {
  let announce!: () => void
  const dispatched = new Promise<void>(resolve => { announce = resolve })
  let sends = 0
  const f = await fixture({ fetch: async (_url, init) => {
    sends++; announce()
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }))
  } })
  const first = await f.service.submit({ prompt: 'First request' }, owner)
  await dispatched
  const second = await f.service.submit({ prompt: 'Queued request' }, owner)
  assert.equal((await f.service.cancel(second.id, owner)).state, 'cancelled')
  await f.service.dispose()
  assert.equal(sends, 1)
  assert.equal((await f.service.getResult(first.id, owner)).state, 'outcome-unknown')
  assert.equal((await f.service.getResult(second.id, owner)).state, 'cancelled')
  await assert.rejects(f.service.submit({ prompt: 'After disposal' }, owner), /not accepting/)
})

test('one deadline includes reference loading before account acquisition', async () => {
  let accountCalls = 0
  const f = await fixture({ timeoutMs: 25,
    withAccount: async (_request, operation) => { accountCalls++; return operation({ accountKey: 'account', accountId: 'workspace', accessToken: 'token', headers: {}, signal: _request.signal ?? new AbortController().signal }) },
    readRemoteImage: (_url, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  })
  try {
    const started = await f.service.submit({ prompt: 'Bound reference time', referenceImages: ['https://example.com/image.png'] }, owner)
    assert.equal(started.deadlineAt - started.createdAt, 25)
    const done = await f.service.getResult(started.id, owner, { waitMs: 1000 })
    assert.equal(done.state, 'cancelled')
    assert.equal(done.error?.code, 'image-deadline')
    assert.equal(accountCalls, 0)
  } finally { await f.service.dispose() }
})

test('received image bytes followed by attachment failure are a known storage failure without retry', async () => {
  const f = await fixture({ saveAssets: () => Promise.reject(new Error('private filesystem detail')) })
  try {
    const started = await f.service.submit({ prompt: 'Store the original' }, owner)
    const done = await f.service.getResult(started.id, owner, { waitMs: 1000 })
    assert.equal(done.state, 'failed')
    assert.equal(done.error?.code, 'image-result-storage-failed')
    assert.equal(f.requests.length, 1)
    assert.ok(!JSON.stringify(done).includes('private filesystem detail'))
  } finally { await f.service.dispose() }
})

test('failed durable dispatch prevents the paid request', async () => {
  const f = await fixture()
  const originalPut = f.options.repository.put
  f.options.repository.put = task => {
    if (task.state !== 'sent') return originalPut(task)
    assert.ok(task.evidence?.requested.imagegenRequestId)
    assert.ok(task.evidence?.requested.imageTurnId)
    return Promise.reject(new Error('storage offline'))
  }
  try {
    const started = await f.service.submit({ prompt: 'Persist before sending' }, owner)
    assert.equal((await f.service.getResult(started.id, owner, { waitMs: 1000 })).state, 'failed')
    assert.equal(f.requests.length, 0)
  } finally { await f.service.dispose() }
})

test('one invalid output preserves the other paid image and its durable download after restart', async () => {
  const f = await fixture({ fetch: async () => Response.json({ data: [{ b64_json: png.toString('base64') }, { b64_json: 'invalid' }] }) })
  try {
    const queued = await f.service.submit({ prompt: 'Keep the useful image', n: 2 }, owner)
    const done = await f.service.getResult(queued.id, owner, { waitMs: 1000 })
    assert.equal(done.state, 'succeeded')
    assert.equal(done.error?.code, 'image-partial-result')
    assert.equal(done.assets.length, 1)
    const restarted = await fixture({}, [done])
    try { assert.deepEqual((await restarted.service.readAsset(done.id, 'asset-one', owner)).data, png); assert.equal(restarted.requests.length, 0) }
    finally { await restarted.service.dispose() }
  } finally { await f.service.dispose() }
})

test('a later attachment write failure preserves images saved earlier without regenerating', async () => {
  let saves = 0
  const f = await fixture({ fetch: async () => Response.json({ data: [{ b64_json: png.toString('base64') }, { b64_json: png.toString('base64') }] }),
    saveAssets: async () => { if (++saves === 2) throw new Error('private disk detail'); return [asset] } })
  try {
    const queued = await f.service.submit({ prompt: 'Save separately', n: 2 }, owner)
    const done = await f.service.getResult(queued.id, owner, { waitMs: 1000 })
    assert.equal(saves, 2); assert.equal(done.state, 'succeeded'); assert.equal(done.assets.length, 1)
    assert.equal(done.error?.code, 'image-partial-result'); assert.equal(f.requests.length, 0)
    assert.equal(JSON.stringify(done).includes('private disk'), false)
    assert.ok(f.writes.some(task => task.state === 'sent' && task.assets.length === 1))
  } finally { await f.service.dispose() }
})

test('restart preserves already persisted images from an interrupted multi-image response', async () => {
  const f = await fixture({}, [{ id: 'interrupted-images', owner, state: 'sent', prompt: 'Partial saved result', model: 'gpt-image-2', createdAt: 1, updatedAt: 2, deadlineAt: 3, assets: [asset] }])
  try {
    const done = await f.service.getResult('interrupted-images', owner)
    assert.equal(done.state, 'succeeded'); assert.equal(done.error?.code, 'image-partial-result')
    assert.deepEqual((await f.service.readAsset(done.id, 'asset-one', owner)).data, png)
    assert.equal(f.requests.length, 0)
  } finally { await f.service.dispose() }
})
