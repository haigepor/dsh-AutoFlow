/** The production LLM seam, attachment admission and task-owned retry remain observable together. */
import { it } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import LocalAttachmentStore from '../../../../packages/attachment/attachment-local/src/index.ts'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import { NativeVisionProvider } from '../src/host/native-vision.ts'
import { resolveConfig, resolveCurrentConfig, reviewerRevision } from '../src/host/config.ts'
import type { VisionImage, VisionInput } from '../src/media/vision.ts'
import type { HttpClient } from '../src/media/network.ts'
import { remoteReferenceDigest } from '../src/media/remote-reference.ts'
import type { Json } from '../src/shared/model.ts'
import { safeFailure } from '../src/host/runtime.ts'

class Adapter extends LlmAdapter {
  readonly started = Promise.withResolvers<void>()
  calls: GenerateOptions[] = []
  mode: 'success' | 'failure' | 'truncated' | 'waiting' | 'incomplete' = 'success'
  imageIds = ['image-one']
  images = true
  override async resolveModel() { return { provider: 'native-fixture', id: 'vision-model', name: 'Vision fixture', inputModalities: this.images ? ['text', 'image'] as const : ['text'] as const } }
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.calls.push(options)
    this.started.resolve()
    if (this.mode === 'waiting') {
      await new Promise<void>(resolve => { if (options.signal?.aborted) resolve(); else options.signal?.addEventListener('abort', () => resolve(), { once: true }) })
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Stopped' } } }; return
    }
    yield { type: 'reasoning-delta', index: 0, text: '检查实际图片' }
    if (this.mode === 'failure') { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'private upstream failure', status: 429 } } }; return }
    const text = JSON.stringify({ observations: this.imageIds.map(imageVersionId => ({ imageVersionId, dimensions: [{ dimension: 'color', observation: '低饱和绿色', uncertain: false }] })), suggestedRules: [] })
    yield { type: 'text-delta', index: 1, text: text.slice(0, 35) }
    yield { type: 'text-delta', index: 1, text: text.slice(35) }
    yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 25, cacheReadTokens: 160, reasoningTokens: 10, totalTokens: 225 } }
    if (this.mode !== 'incomplete') yield { type: 'finish', reason: { kind: this.mode === 'truncated' ? 'max-tokens' : 'stop' } }
  }
}

it('defaults new work to native LLM while preserving frozen legacy and explicit HTTP selection', () => {
  const current = resolveCurrentConfig({ vision: { model: 'vision-model' } })
  assert.equal(current.vision.backend, 'native')
  assert.equal(reviewerRevision(current), reviewerRevision(resolveConfig(JSON.parse(JSON.stringify(current)))))
  assert.equal(resolveConfig({ vision: { model: 'legacy' } }).vision.backend, undefined)
  assert.equal(resolveCurrentConfig({ vision: { backend: 'compatible', model: 'backup' } }).vision.backend, 'compatible')
})

it('retains an image admission failure without misreporting model configuration or exposing raw errors', async () => {
  const f = await fixture()
  f.attachments.saveImages = async () => { throw new AttachmentError('private-path-and-response', 'IMAGE_TYPE_MISMATCH') }
  try {
    await assert.rejects(f.provider.analyze(f.input, f.bounds), error => {
      const saved = safeFailure(error)
      assert.equal(saved.code, 'IMAGE_TYPE_MISMATCH')
      assert.equal(saved.stage, 'vision-images')
      assert.equal(saved.retryable, false)
      assert.ok(!JSON.stringify(saved).includes('private-path-and-response'))
      return true
    })
    assert.equal(f.adapter.calls.length, 0)
    assert.equal(f.metadata.length, 0)
  } finally { await f.cleanup() }
})

it('admits a bounded retry for an atomic attachment write failure before model dispatch', async () => {
  const f = await fixture()
  f.attachments.saveImages = async () => { throw new AttachmentError('private-storage-details', 'ATTACHMENT_WRITE_FAILED') }
  try {
    await assert.rejects(f.provider.analyze(f.input, f.bounds), error => {
      const saved = safeFailure(error)
      assert.equal(saved.code, 'ATTACHMENT_WRITE_FAILED')
      assert.equal(saved.stage, 'vision-images')
      assert.equal(saved.retryable, true)
      assert.ok(!JSON.stringify(saved).includes('private-storage-details'))
      return true
    })
    assert.equal(f.adapter.calls.length, 0)
  } finally { await f.cleanup() }
})

it('does not turn an attachment error after model dispatch into an automatic write retry', async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.provider.analyze(f.input, { ...f.bounds, onOutput: () => { throw new AttachmentError('private-storage-details', 'ATTACHMENT_WRITE_FAILED') } }), error => {
      assert.equal(safeFailure(error).code, 'ATTACHMENT_WRITE_FAILED')
      assert.equal(safeFailure(error).retryable, false)
      return true
    })
    assert.equal(f.adapter.calls.length, 1)
  } finally { await f.cleanup() }
})

async function fixture(managed = false) {
  const root = await mkdtemp(join(tmpdir(), 'curator-native-'))
  const ctx = new Context(), llm = new LlmRuntime(ctx), attachments = new LocalAttachmentStore(ctx, { dshHome: root }), adapter = new Adapter()
  const registration = llm.registerAdapter(['native-fixture'], adapter)
  const pixels = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#426143' } }).png().toBuffer()
  const image: VisionImage = { imageVersionId: 'image-one', digest: createHash('sha256').update(pixels).digest('hex'), mime: 'image/png', role: 'positive', bytes: pixels }
  const config = (managed ? resolveCurrentConfig : resolveConfig)({ vision: { provider: 'native-fixture', model: 'vision-model', credentialRef: '' } })
  let downloads = 0
  const media: HttpClient = { request: async () => { downloads++; return { status: 200, headers: { 'content-type': 'image/png' }, bytes: pixels } } }
  const provider = new NativeVisionProvider(config, { llm, attachments, media })
  const metadata: Json[] = [], deltas: { content?: string; reasoning?: string }[] = []
  const bounds = { maxBytes: 100_000, maxRedirects: 0, timeoutMs: 5000, onOutput: (delta: { content?: string; reasoning?: string }) => { deltas.push(delta) }, onMetadata: async (data: Json) => { metadata.push(data) } }
  const input = { requestId: 'request-one', taskBrief: 'Observe supplied pixels.', rules: [], images: [image] }
  return { provider, adapter, attachments, media, metadata, deltas, bounds, input, pixels, get downloads() { return downloads }, cleanup: async () => { registration(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) } }
}

it('inherits the registered output and reasoning defaults and records its context capacity', async () => {
  const f = await fixture(true)
  f.adapter.resolveModel = async () => ({ provider: 'native-fixture', id: 'vision-model', name: 'Vision fixture', inputModalities: ['text', 'image'], context: { contextWindow: 1_000_000 }, defaultMaxTokens: 65_536 })
  try {
    await f.provider.analyze(f.input, f.bounds)
    assert.equal(f.adapter.calls[0]!.maxTokens, 65_536)
    assert.equal(f.adapter.calls[0]!.reasoningEffort, undefined)
    assert.equal(JSON.parse(JSON.stringify(f.metadata.at(-1))).context.contextWindow, 1_000_000)
  } finally { await f.cleanup() }
})

it('native summary records short model labels and restores complete canonical evidence', async () => {
  const f = await fixture(true), imageIds = Array.from({ length: 24 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`)
  f.adapter.resolveModel = async () => ({ provider: 'native-fixture', id: 'vision-model', name: 'Vision fixture', inputModalities: ['text', 'image'], context: { contextWindow: 1_000_000 }, defaultMaxTokens: 65_536 })
  const input: VisionInput = { ...f.input, requestId: 'native-summary', images: imageIds.slice(0, 8).map(imageVersionId => ({ ...f.input.images[0]!, imageVersionId, bytes: Uint8Array.from(f.pixels) })),
    taskBrief: JSON.stringify({ instruction: 'Summarize every saved observation.', samples: imageIds.map(imageVersionId => ({ imageVersionId, role: 'positive', observation: { imageVersionId, dimensions: [{ dimension: 'subject', observation: 'A clear vehicle subject.' }] } })) }) }
  const briefSchema = z.object({ imageAliases: z.record(z.string(), z.string()), samples: z.array(z.object({ imageVersionId: z.string(), observation: z.object({ imageVersionId: z.string() }) })) })
  const wireSchema = z.object({ input: z.object({ taskBrief: z.string(), images: z.array(z.object({ imageVersionId: z.string() })) }) })
  const receiptSchema = z.object({ request: z.object({ config: z.object({ maxTokens: z.number() }), messages: z.array(z.json()) }), images: z.array(z.object({ imageVersionId: z.string(), attachment: z.object({ name: z.string() }).passthrough() })) })
  f.adapter.stream = async function* (options: GenerateOptions): AsyncGenerator<StreamChunk> {
    f.adapter.calls.push(options)
    const content = options.messages[0]!.content, first = content[0]!
    assert.equal(first.type, 'text')
    if (first.type !== 'text') throw new Error('Expected the actual summary input before image attachments.')
    const wire = wireSchema.parse(JSON.parse(first.text)).input, brief = briefSchema.parse(JSON.parse(wire.taskBrief)), labels = brief.samples.map(sample => sample.imageVersionId)
    assert.equal(labels.length, 24)
    assert.ok(labels.every(label => /^r\d+$/u.test(label)))
    assert.deepEqual(labels.map(label => brief.imageAliases[label]), imageIds)
    assert.deepEqual(brief.samples.map(sample => sample.observation.imageVersionId), labels)
    assert.deepEqual(wire.images.map(image => image.imageVersionId), labels.slice(0, 8))
    assert.deepEqual(content.flatMap(block => block.type === 'text' ? [block.text] : []).slice(1).map(text => z.object({ imageVersionId: z.string() }).parse(JSON.parse(text)).imageVersionId), labels.slice(0, 8))
    assert.equal(f.metadata.length, 1, 'The complete request must be recorded before the adapter dispatches it.')
    const receipt = receiptSchema.parse(f.metadata[0])
    assert.deepEqual(receipt.request.messages, options.messages)
    assert.deepEqual(receipt.images.map(image => image.imageVersionId), imageIds.slice(0, 8))
    assert.deepEqual(receipt.images.map(image => image.attachment.name), imageIds.slice(0, 8))
    assert.equal(receipt.request.config.maxTokens, 65_536)
    const text = JSON.stringify({ name: 'Vehicle portraits', summary: 'Clear vehicle subjects with varied environments.', matchingPrompt: 'Inspect the candidate image for a clear vehicle subject.', searchHints: ['car portrait'], avoidTerms: [],
      dimensions: [{ dimension: 'subject', description: 'The vehicle commands attention.', consistency: 'mixed', supportImageVersionIds: labels.slice(0, 20), counterImageVersionIds: labels.slice(20) }],
      conflicts: [{ description: 'Different environments.', imageVersionIds: labels }],
      suggestedRules: [{ statement: 'Prefer a clear vehicle subject.', dimension: 'subject', strength: 'preferred', stage: 'source', supportImageVersionIds: labels.slice(0, 20), counterImageVersionIds: labels.slice(20), condition: '', exceptions: [] }],
      organization: { groups: [{ groupId: 'vehicle', name: 'Vehicle portraits', description: 'A supported alternative.', imageVersionIds: labels }], selections: [{ ruleIndex: 0, enabled: true, groupId: 'vehicle', reason: 'Supported reference observations.' }] } })
    yield { type: 'text-delta', index: 0, text: text.slice(0, 100) }
    yield { type: 'text-delta', index: 0, text: text.slice(100) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  try {
    const original = structuredClone(input), descriptor = f.provider.describeRequest(input, 'summarize')
    const result = await f.provider.summarize(input, imageIds, f.bounds)
    assert.deepEqual(input, original)
    assert.equal(descriptor.promptVersion, 'visual-curator-summary-v3')
    assert.deepEqual(descriptor.images.map(image => image.imageVersionId), imageIds.slice(0, 8))
    assert.deepEqual(result.dimensions[0]!.supportImageVersionIds, imageIds.slice(0, 20))
    assert.deepEqual(result.dimensions[0]!.counterImageVersionIds, imageIds.slice(20))
    assert.deepEqual(result.conflicts[0]!.imageVersionIds, imageIds)
    assert.deepEqual(result.suggestedRules[0]!.supportImageVersionIds, imageIds.slice(0, 20))
    assert.deepEqual(result.suggestedRules[0]!.counterImageVersionIds, imageIds.slice(20))
    assert.deepEqual(result.organization!.groups[0]!.imageVersionIds, imageIds)
    assert.equal(f.adapter.calls.length, 1)
    assert.equal(f.adapter.calls[0]!.maxTokens, 65_536)
    for (const block of f.adapter.calls[0]!.messages[0]!.content) if (block.type === 'image') assert.ok((await f.attachments.readImage(block.attachment)).data.byteLength > 0)
  } finally { await f.cleanup() }
})

it('streams through the native LLM with admitted pixels and records disjoint usage before committing output', async () => {
  const f = await fixture()
  try {
    const result = await f.provider.analyze(f.input, f.bounds)
    assert.equal(result.observations.length, 1)
    assert.equal(f.adapter.calls.length, 1)
    assert.ok(f.deltas.some(delta => delta.reasoning === '检查实际图片'))
    assert.equal(f.deltas.filter(delta => delta.content).length, 2)
    const image = f.adapter.calls[0]!.messages[0]!.content.find(block => block.type === 'image')
    assert.equal(image?.type, 'image')
    if (image?.type === 'image') assert.ok((await f.attachments.readImage(image.attachment)).data.byteLength > 0)
    const saved = f.metadata.at(-1)
    assert.ok(saved && typeof saved === 'object' && !Array.isArray(saved))
    assert.deepEqual(saved.usage, { inputTokens: 40, outputTokens: 25, cacheReadTokens: 160, reasoningTokens: 10, totalTokens: 225 })
    assert.equal(saved.transport, 'native-llm')
    assert.ok(!JSON.stringify(saved).includes('base64'))
    const expected = JSON.parse(await readFile(new URL('./fixtures/native-llm-call.expected.json', import.meta.url), 'utf8'))
    assert.deepEqual({ transport: saved.transport, provider: saved.provider, model: saved.model, inputRoles: f.adapter.calls[0]!.messages.map(message => message.role), images: f.adapter.calls[0]!.messages.flatMap(message => message.content).filter(block => block.type === 'image').length, reasoning: f.deltas.map(delta => delta.reasoning ?? '').join(''), observations: result.observations, usage: saved.usage, finish: saved.finish }, expected)
  } finally { await f.cleanup() }
})

it('native profile observation calls omit rule generation and normalize the saved result', async () => {
  const f = await fixture()
  const observations = [{ imageVersionId: 'image-one', dimensions: [{ dimension: 'color', observation: '低饱和绿色', uncertain: false }] }]
  f.adapter.stream = async function* (options: GenerateOptions): AsyncGenerator<StreamChunk> {
    f.adapter.calls.push(options)
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ observations }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  try {
    const result = await f.provider.analyze({ ...f.input, analysisOutput: 'observations-only' }, f.bounds)
    assert.deepEqual(result, { observations, suggestedRules: [] })
    assert.equal(f.adapter.calls.length, 1)
    const sent = f.adapter.calls[0]!.messages[0]!.content[0]!
    assert.equal(sent.type, 'text')
    if (sent.type === 'text') assert.deepEqual(Object.keys(JSON.parse(sent.text).outputSchema.properties), ['observations'])
    assert.equal(f.metadata.length, 2)
  } finally { await f.cleanup() }
})

it('downloads authorized remote pixels before attachment admission and records both identities', async () => {
  const f = await fixture()
  const request = f.media.request.bind(f.media), downloadTimeouts: number[] = []
  f.media.request = async (location, bounds) => { downloadTimeouts.push(bounds.timeoutMs); return request(location, bounds) }
  try {
    const source = { providerId: 'unsplash' as const, photoId: 'photo', accountId: 'public', url: 'https://plus.unsplash.com/premium_photo-example?w=1080', thumbnailUrl: 'https://plus.unsplash.com/premium_photo-example?w=400' }
    const image: VisionImage = { imageVersionId: 'image-one', digest: remoteReferenceDigest(source), mime: 'image/jpeg', role: 'positive', remoteSource: source }
    let reserved = 0, settled = 0
    await f.provider.analyze({ ...f.input, images: [image] }, { ...f.bounds, reserveDownload: async limit => { reserved = limit; return { maxBytes: limit, settle: async bytes => { settled = bytes } } } })
    assert.equal(f.downloads, 1)
    assert.deepEqual(downloadTimeouts, [f.bounds.timeoutMs])
    assert.ok(reserved >= f.pixels.byteLength)
    assert.equal(settled, f.pixels.byteLength)
    const saved = f.metadata[0]
    assert.ok(saved && typeof saved === 'object' && !Array.isArray(saved))
    assert.ok(JSON.stringify(saved).includes('remote-url-v1:'))
    assert.ok(JSON.stringify(saved).includes('attachmentId'))
    await f.provider.analyze({ ...f.input, requestId: 'retry-same-images', images: [image] }, f.bounds)
    assert.equal(f.downloads, 1, 'Retries reuse verified admitted bytes rather than downloading mutable URLs again')
    assert.equal(f.adapter.calls.length, 2)
  } finally { await f.cleanup() }
})

it('parallel native requests prepare cold shared images once while their model streams overlap', async () => {
  const f = await fixture(), release = Promise.withResolvers<void>(), started = Promise.withResolvers<void>()
  const original = f.adapter.stream.bind(f.adapter)
  let active = 0, peak = 0
  f.adapter.stream = async function* (options: GenerateOptions): AsyncGenerator<StreamChunk> {
    active++; peak = Math.max(peak, active)
    if (active === 3) started.resolve()
    try { await release.promise; yield* original(options) } finally { active-- }
  }
  const source = { providerId: 'unsplash' as const, photoId: 'shared', accountId: 'public', url: 'https://images.unsplash.com/shared?w=1080', thumbnailUrl: 'https://images.unsplash.com/shared?w=320' }
  const image: VisionImage = { imageVersionId: 'image-one', digest: remoteReferenceDigest(source), mime: 'image/png', role: 'positive', remoteSource: source }
  const calls = [1, 2, 3].map(index => f.provider.analyze({ ...f.input, requestId: `parallel-${index}`, images: [image] }, f.bounds))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // This deadline only bounds a deadlock regression; the model requests remain held by the gate.
    const arrived = await Promise.race([started.promise.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 5000) })])
    assert.equal(arrived, true, 'Image preparation must release its queue before model dispatch completes')
    assert.equal(peak, 3)
    assert.equal(f.downloads, 1, 'Concurrent requests must reuse already admitted reference bytes')
    release.resolve(); await Promise.all(calls)
  } finally { clearTimeout(timer); release.resolve(); await Promise.allSettled(calls); await f.cleanup() }
})

it('cancelling a queued image preparation keeps the active reader and later cached readers intact', async () => {
  const f = await fixture(), ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), controller = new AbortController()
  const original = f.media.request.bind(f.media)
  f.media.request = async (location, bounds) => { ready.resolve(); await release.promise; return original(location, bounds) }
  const source = { providerId: 'unsplash' as const, photoId: 'shared', accountId: 'public', url: 'https://images.unsplash.com/shared?w=1080', thumbnailUrl: 'https://images.unsplash.com/shared?w=320' }
  const image: VisionImage = { imageVersionId: 'image-one', digest: remoteReferenceDigest(source), mime: 'image/png', role: 'positive', remoteSource: source }
  const input = { ...f.input, images: [image] }, first = f.provider.analyze(input, f.bounds)
  const calls: Promise<unknown>[] = [first]
  try {
    await ready.promise
    let acknowledged = false
    const cancelled = assert.rejects(f.provider.analyze(input, { ...f.bounds, signal: controller.signal }), { code: 'cancelled' }).then(() => { acknowledged = true })
    calls.push(cancelled)
    controller.abort(); await setImmediate()
    assert.equal(acknowledged, true, 'A cancelled waiter must settle without waiting for another image transfer')
    const third = f.provider.analyze(input, f.bounds); calls.push(third)
    release.resolve(); await Promise.all(calls)
    assert.equal(f.downloads, 1)
    assert.equal(f.adapter.calls.length, 2)
  } finally { controller.abort(); release.resolve(); await Promise.allSettled(calls); await f.cleanup() }
})

it('rejects text-only native routes before calling the model', async () => {
  const f = await fixture(); f.adapter.images = false
  try { await assert.rejects(f.provider.analyze(f.input, f.bounds), { code: 'capability-unavailable' }); assert.equal(f.adapter.calls.length, 0) } finally { await f.cleanup() }
})

it('reserves one bounded download bundle and settles once after all images arrive', async () => {
  const f = await fixture()
  try {
    f.adapter.imageIds = ['image-one', 'image-two']
    const source = { providerId: 'unsplash' as const, photoId: 'photo', accountId: 'public', url: 'https://images.unsplash.com/photo-example?w=1080', thumbnailUrl: 'https://images.unsplash.com/photo-example?w=400' }
    const images: VisionImage[] = f.adapter.imageIds.map(imageVersionId => ({ imageVersionId, digest: remoteReferenceDigest(source), mime: 'image/jpeg', role: 'positive', remoteSource: source }))
    const caps: number[] = [], settled: number[] = []
    let reservations = 0
    f.media.request = async (_url, request) => { caps.push(request.maxBytes); return { status: 200, headers: { 'content-type': 'image/png' }, bytes: f.pixels } }
    await f.provider.analyze({ ...f.input, images }, { ...f.bounds, reserveDownload: async () => { reservations++; return { maxBytes: f.pixels.byteLength * 2, settle: async bytes => { settled.push(bytes) } } } })
    assert.equal(reservations, 1, 'Durable budget writes are per bundle, not per image')
    assert.deepEqual(caps, [f.pixels.byteLength * 2, f.pixels.byteLength])
    assert.deepEqual(settled, [f.pixels.byteLength * 2])
    assert.equal(f.adapter.calls.length, 1)
  } finally { await f.cleanup() }
})

it('retains a whole bundle reservation when a later image transfer is unknown', async () => {
  const f = await fixture()
  try {
    const source = { providerId: 'unsplash' as const, photoId: 'photo', accountId: 'public', url: 'https://images.unsplash.com/photo-example?w=1080', thumbnailUrl: 'https://images.unsplash.com/photo-example?w=400' }
    const images: VisionImage[] = ['image-one', 'image-two'].map(imageVersionId => ({ imageVersionId, digest: remoteReferenceDigest(source), mime: 'image/jpeg', role: 'positive', remoteSource: source }))
    let calls = 0, reservations = 0, settlements = 0
    f.media.request = async () => { if (++calls === 2) throw new Error('incomplete image transfer'); return { status: 200, headers: { 'content-type': 'image/png' }, bytes: f.pixels } }
    await assert.rejects(f.provider.analyze({ ...f.input, images }, { ...f.bounds, reserveDownload: async limit => { reservations++; return { maxBytes: limit, settle: async () => { settlements++ } } } }), /incomplete image transfer/)
    assert.equal(reservations, 1)
    assert.equal(settlements, 0)
    assert.equal(f.adapter.calls.length, 0)
  } finally { await f.cleanup() }
})

it('keeps complete JSON uncommitted when the native stream has no terminal chunk', async () => {
  const f = await fixture(); f.adapter.mode = 'incomplete'
  try { await assert.rejects(f.provider.analyze(f.input, f.bounds), { code: 'vision-invalid-output' }); assert.equal(f.adapter.calls.length, 1) } finally { await f.cleanup() }
})

it('keeps native failure retryable for the task owner without an internal second call', async () => {
  const f = await fixture(); f.adapter.mode = 'failure'
  try {
    await assert.rejects(f.provider.analyze(f.input, f.bounds), error => error instanceof Error && 'retryable' in error && error.retryable === true && !error.message.includes('private upstream'))
    assert.equal(f.adapter.calls.length, 1)
  } finally { await f.cleanup() }
})

it('retains usage when a native response reaches its token limit', async () => {
  const f = await fixture(); f.adapter.mode = 'truncated'
  try { await assert.rejects(f.provider.analyze(f.input, f.bounds), { code: 'vision-output-truncated' }); assert.ok(JSON.stringify(f.metadata.at(-1)).includes('cacheReadTokens')); assert.equal(f.adapter.calls.length, 1) } finally { await f.cleanup() }
})

it('completes native analysis while active output exceeds the plugin request timeout', async context => {
  const f = await fixture(true), deadline = new AbortController()
  context.mock.method(AbortSignal, 'timeout', () => deadline.signal)
  f.adapter.stream = async function* (options: GenerateOptions): AsyncGenerator<StreamChunk> {
    f.adapter.calls.push(options)
    const text = JSON.stringify({ observations: [{ imageVersionId: 'image-one', dimensions: [{ dimension: 'color', observation: 'Muted green.', uncertain: false }] }], suggestedRules: [] })
    for (let index = 0; index < 4; index++) {
      if (index === 1) deadline.abort(new DOMException('Old plugin deadline.', 'TimeoutError'))
      options.signal?.throwIfAborted()
      yield { type: 'text-delta', index: 0, text: text.slice(Math.floor(index * text.length / 4), Math.floor((index + 1) * text.length / 4)) }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  try {
    const result = await f.provider.analyze(f.input, { ...f.bounds, timeoutMs: 10 })
    assert.equal(result.observations.length, 1)
    assert.equal(f.deltas.filter(delta => delta.content).length, 4)
    assert.equal(f.adapter.calls.length, 1)
  } finally { await f.cleanup() }
})

it('completes native search review after the former plugin request deadline', async context => {
  const f = await fixture(), deadline = new AbortController()
  context.mock.method(AbortSignal, 'timeout', () => deadline.signal)
  f.adapter.stream = async function* (options: GenerateOptions): AsyncGenerator<StreamChunk> {
    f.adapter.calls.push(options)
    yield { type: 'reasoning-delta', index: 0, text: 'Reviewing actual image pixels.' }
    deadline.abort(new DOMException('Former plugin deadline.', 'TimeoutError'))
    options.signal?.throwIfAborted()
    yield { type: 'text-delta', index: 1, text: JSON.stringify({ ruleResults: [], cropPotential: 'direct', preferenceScores: [], taskRelevance: 'relevant' }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  try {
    const result = await f.provider.review({ ...f.input, stage: 'final' }, { ...f.bounds, timeoutMs: 10 })
    assert.equal(result.taskRelevance, 'relevant')
    assert.equal(f.adapter.calls.length, 1)
  } finally { await f.cleanup() }
})

it('retains native adapter idle failures when analysis has no plugin time limit', async () => {
  const f = await fixture(true)
  f.adapter.stream = async function* (): AsyncGenerator<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TIMEOUT', message: 'Native stream idle timeout.' } } }
  }
  try {
    await assert.rejects(f.provider.analyze(f.input, f.bounds), error => {
      assert.equal(safeFailure(error).code, 'remote-request-failed')
      assert.equal(safeFailure(error).retryable, true)
      return true
    })
  } finally { await f.cleanup() }
})

it('forwards cancellation to the native stream and never retries it', async () => {
  const f = await fixture(); f.adapter.mode = 'waiting'; const controller = new AbortController()
  try {
    const pending = f.provider.analyze(f.input, { ...f.bounds, signal: controller.signal })
    await Promise.race([f.adapter.started.promise, pending.then(() => { throw new Error('Stream unexpectedly completed before cancellation') })])
    controller.abort()
    await assert.rejects(pending, { code: 'cancelled' })
    assert.equal(f.adapter.calls.length, 1)
    assert.equal(f.adapter.calls[0]?.signal?.aborted, true)
  } finally { await f.cleanup() }
})
