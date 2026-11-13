/** Profile-owned OpenAI image edits with durable, non-replayable operation receipts. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { LlmError, assertUsableApiKey, type ImageGenerationProvider, type ImageGenerationModel, type ImageGenerationRequest, type ImageGenerationTask, type ImageGenerationId, type ImageGenerationTaskId, type GeneratedImage } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { CuratorConfig } from './config.ts'

export const officialImageProviderId = 'visual-curator-openai'
const imageModelId = /^gpt-image-(?:2(?:$|[-.])|[3-9](?:$|[-.]))/
const modelsResult = z.object({ data: z.array(z.object({ id: z.string() })) })
const imageResult = z.object({ data: z.array(z.object({ b64_json: z.string().min(1) })).min(1) })
const storedTaskShape = z.strictObject({
  id: z.string().min(1), taskId: z.string().min(1), sourceId: z.string().min(1), credentialRef: z.string().min(1), model: z.string().min(1), digest: z.string().min(1),
  state: z.enum(['queued', 'sent', 'succeeded', 'failed', 'cancelled', 'outcome-unknown']), updatedAt: z.number().finite(),
  images: z.array(z.object({ original: z.object({ attachmentId: z.string(), name: z.string(), bytes: z.number() }), preview: z.object({ attachmentId: z.string(), mediaType: z.string(), bytes: z.number(), width: z.number(), height: z.number() }) })).max(1),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
})
interface StoredTask { id: string; taskId: string; sourceId: string; credentialRef: string; model: string; digest: string; state: ImageGenerationTask['state']; updatedAt: number; images: GeneratedImage[]; error?: ImageGenerationTask['error'] }
const storedTaskSchema = z.custom<StoredTask>(value => storedTaskShape.safeParse(value).success)

async function readFile(attachments: Pick<AttachmentStore, 'readFileStream'>, ref: Parameters<AttachmentStore['readFileStream']>[0], signal: AbortSignal, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []; let size = 0
  for await (const chunk of attachments.readFileStream(ref, signal)) { size += chunk.byteLength; if (size > limit) throw new LlmError('An image input exceeds the supported size', 'UNSUPPORTED_OPTION'); chunks.push(chunk) }
  return Buffer.concat(chunks)
}

async function readResponse(response: Response, limit: number): Promise<string> {
  if (!response.body) throw new LlmError('OpenAI returned an empty image response', 'IMAGE_GENERATION_FAILED')
  const chunks: Uint8Array[] = []; let size = 0
  for await (const chunk of response.body) { size += chunk.byteLength; if (size > limit) throw new LlmError('OpenAI image response exceeded the size limit', 'IMAGE_GENERATION_FAILED'); chunks.push(chunk) }
  return Buffer.concat(chunks).toString('utf8')
}

/** Open one image-only provider and its profile-private durable task table.
 * @param options Profile services and current key profiles.
 * @returns Provider and drain function owned by the Visual Curator fiber.
 */
export async function openOfficialImageProvider(options: {
  storage: Pick<DomainFacility, 'open'>
  domainName: string
  attachments: Pick<AttachmentStore, 'readImage' | 'readFileStream' | 'validateImage' | 'saveFile' | 'saveImage'>
  credentials: Pick<CredentialProvider, 'resolve'>
  config(): CuratorConfig
  fetch?: typeof globalThis.fetch
  report(error: Error): void
}): Promise<{ provider: ImageGenerationProvider; close(): Promise<void> }> {
  const spec = defineDomain({ name: options.domainName, version: 1, tables: { tasks: domainTable<string, StoredTask>(storedTaskSchema) } })
  const domain = await options.storage.open(spec), tasks = domain.table('tasks')
  const running = new Map<string, { promise: Promise<void>; controller: AbortController }>()
  const modelCache = new Map<string, { expiresAt: number; models: ImageGenerationModel[] }>()
  let closing = false
  const modelsFor = async (profile: CuratorConfig['imageSources']['apiKeys'][number], key: string): Promise<ImageGenerationModel[]> => {
    const cacheId = `${profile.id}:${createHash('sha256').update(key).digest('hex')}`
    const cached = modelCache.get(cacheId)
    if (cached && cached.expiresAt > Date.now()) return cached.models
    const response = await (options.fetch ?? fetch)('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000), redirect: 'error' })
    if (!response.ok) { await response.body?.cancel(); throw new LlmError(`OpenAI model listing failed (HTTP ${response.status})`, 'IMAGE_MODEL_CATALOG_FAILED') }
    const parsed = modelsResult.safeParse(JSON.parse(await readResponse(response, 4 * 1024 * 1024)))
    if (!parsed.success) throw new LlmError('OpenAI returned an unsupported model catalog', 'IMAGE_MODEL_CATALOG_FAILED')
    const models = [...new Set(parsed.data.data.map(item => item.id).filter(id => imageModelId.test(id)))].sort((left, right) => left === 'gpt-image-2' ? -1 : right === 'gpt-image-2' ? 1 : left.localeCompare(right)).map(id => ({ id, name: id }))
    modelCache.set(cacheId, { expiresAt: Date.now() + 5 * 60_000, models })
    return models
  }
  const sourceModels = async (profile: CuratorConfig['imageSources']['apiKeys'][number]): Promise<ImageGenerationModel[]> => {
    const secret = await options.credentials.resolve(credentialRef(profile.credentialRef))
    if (!secret?.value) return []
    return modelsFor(profile, assertUsableApiKey(secret.value, 'Visual Curator image source', profile.credentialRef))
  }
  for (const [id, task] of tasks.entries()) if (task.state === 'queued' || task.state === 'sent') {
    await tasks.put(id, { ...task, state: task.state === 'sent' ? 'outcome-unknown' : 'cancelled', updatedAt: Date.now(), error: task.state === 'sent'
      ? { code: 'interrupted-after-send', message: 'The Host stopped after dispatch; the remote outcome is unknown and will not be retried.' }
      : { code: 'interrupted-before-send', message: 'The Host stopped before dispatch; start a new image operation.' } })
  }
  const project = (task: StoredTask): ImageGenerationTask => ({ id: brandString<ImageGenerationId>(task.id), provider: officialImageProviderId, model: task.model, taskId: brandString<ImageGenerationTaskId>(task.taskId), state: task.state, images: task.images, ...(task.error ? { error: task.error } : {}) })
  const save = async (task: StoredTask): Promise<void> => { await tasks.put(task.id, { ...task, updatedAt: Date.now() }) }
  const dispatch = async (request: ImageGenerationRequest, task: StoredTask, key: string, controller: AbortController): Promise<void> => {
    let sent = false, responseKnown = false
    try {
      const signal = AbortSignal.any([controller.signal, request.signal])
      const form = new FormData()
      form.set('model', request.model); form.set('prompt', request.prompt); form.set('size', request.size); form.set('quality', request.quality); form.set('n', '1'); form.set('output_format', 'png')
      for (let index = 0; index < request.references.length; index++) {
        const image = await options.attachments.readImage(request.references[index]!, signal)
        form.append('image[]', new Blob([new Uint8Array(image.data)], { type: image.ref.mediaType }), `reference-${index}.${image.ref.mediaType === 'image/jpeg' ? 'jpg' : image.ref.mediaType.slice(6)}`)
      }
      if (request.mask) {
        const mask = await readFile(options.attachments, request.mask, signal, 4 * 1024 * 1024)
        const first = request.references[0]
        if (!first || mask.length < 26 || Buffer.from(mask.subarray(0, 8)).toString('hex') !== '89504e470d0a1a0a' || Buffer.from(mask).readUInt32BE(16) !== first.width || Buffer.from(mask).readUInt32BE(20) !== first.height || ![4, 6].includes(mask[25]!)) throw new LlmError('The edit mask must be an alpha PNG matching the first reference', 'UNSUPPORTED_OPTION')
        form.set('mask', new Blob([new Uint8Array(mask)], { type: 'image/png' }), 'wallpaper-mask.png')
      }
      signal.throwIfAborted()
      await save({ ...task, state: 'sent' }); sent = true
      const response = await (options.fetch ?? fetch)('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal, redirect: 'error' })
      responseKnown = true
      if (!response.ok) { await response.body?.cancel(); throw new LlmError(`OpenAI rejected the image edit (HTTP ${response.status})`, 'IMAGE_GENERATION_FAILED') }
      const raw: unknown = JSON.parse(await readResponse(response, 100 * 1024 * 1024))
      const parsed = imageResult.safeParse(raw)
      if (!parsed.success || parsed.data.data.length !== 1) throw new LlmError('OpenAI returned an unsupported image result', 'IMAGE_GENERATION_FAILED')
      const encoded = parsed.data.data[0]!.b64_json
      if (encoded.length > 72 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new LlmError('OpenAI returned invalid image bytes', 'IMAGE_GENERATION_FAILED')
      const bytes = Buffer.from(encoded, 'base64')
      await options.attachments.validateImage({ data: bytes, mediaType: 'image/png' })
      const original = await options.attachments.saveFile({ data: bytes, name: `${task.id}.png` })
      const preview = await options.attachments.saveImage({ data: bytes, mediaType: 'image/png', name: `${task.id}.png` })
      await save({ ...task, state: 'succeeded', images: [{ original, preview }] })
    } catch (error) {
      const aborted = controller.signal.aborted || request.signal.aborted
      const state = sent && (aborted || !responseKnown) ? 'outcome-unknown' : aborted ? 'cancelled' : 'failed'
      try { await save({ ...task, state, error: { code: state === 'outcome-unknown' ? 'interrupted-after-send' : error instanceof LlmError ? error.code : 'image-operation-failed', message: state === 'outcome-unknown' ? 'The remote outcome is unknown; this operation will not be retried.' : error instanceof LlmError ? error.message : 'The OpenAI image operation failed.' } }) }
      catch (failure) { options.report(failure instanceof Error ? failure : new Error('Image task state could not be saved.')) }
    }
  }
  const provider: ImageGenerationProvider = {
    async listModels() {
      const catalogs = await Promise.allSettled(options.config().imageSources.apiKeys.map(sourceModels))
      return [...new Map(catalogs.flatMap(result => result.status === 'fulfilled' ? result.value : []).map(model => [model.id, model])).values()].sort((left, right) => left.id === 'gpt-image-2' ? -1 : right.id === 'gpt-image-2' ? 1 : left.id.localeCompare(right.id))
    },
    async listSources() {
      return await Promise.all(options.config().imageSources.apiKeys.map(async profile => {
        const secret = await options.credentials.resolve(credentialRef(profile.credentialRef))
        if (!secret?.value) return { id: profile.id, name: profile.label, available: false, models: [] }
        try { return { id: profile.id, name: profile.label, available: true, models: await modelsFor(profile, assertUsableApiKey(secret.value, 'Visual Curator image source', profile.credentialRef)) } }
        catch (error) { return { id: profile.id, name: profile.label, available: true, models: [], modelError: error instanceof LlmError ? error.code : 'IMAGE_MODEL_CATALOG_FAILED' } }
      }))
    },
    async start(request) {
      request.signal.throwIfAborted()
      if (closing || !request.sourceId) throw new LlmError('Select a configured OpenAI image source and model', 'UNSUPPORTED_OPTION')
      const digest = createHash('sha256').update(JSON.stringify({ sourceId: request.sourceId, model: request.model, prompt: request.prompt, references: request.references.map(ref => ref.attachmentId), mask: request.mask?.attachmentId, size: request.size, quality: request.quality })).digest('hex')
      const existing = tasks.get(request.id)
      if (existing) { if (existing.digest !== digest) throw new LlmError('The image operation was reused with different input', 'UNSUPPORTED_OPTION'); return project(existing) }
      const profile = options.config().imageSources.apiKeys.find(item => item.id === request.sourceId)
      if (!profile) throw new LlmError('The selected OpenAI API key profile is unavailable', 'UNSUPPORTED_OPTION')
      const secret = await options.credentials.resolve(credentialRef(profile.credentialRef))
      if (!secret?.value) throw new LlmError('The selected OpenAI API key is unavailable', 'UNSUPPORTED_OPTION')
      const key = assertUsableApiKey(secret.value, 'Visual Curator image source', profile.credentialRef)
      if (!(await modelsFor(profile, key)).some(model => model.id === request.model)) throw new LlmError('The selected OpenAI image model is unavailable for this key', 'UNSUPPORTED_OPTION')
      const task: StoredTask = { id: request.id, taskId: request.id, sourceId: request.sourceId, credentialRef: profile.credentialRef, model: request.model, digest, state: 'queued', updatedAt: Date.now(), images: [] }
      await save(task)
      const controller = new AbortController(), promise = dispatch(request, task, key, controller)
      running.set(task.id, { promise, controller })
      void promise.finally(() => running.delete(task.id))
      return project(task)
    },
    async get(handle, options) {
      const active = running.get(handle.id)
      if (active && options?.waitMs && options.waitMs > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try { await Promise.race([active.promise, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(options.waitMs!, 20_000)) })]) }
        finally { clearTimeout(timer) }
      }
      options?.signal?.throwIfAborted()
      const task = tasks.get(handle.id)
      if (!task || task.model !== handle.model || handle.taskId && task.taskId !== handle.taskId) throw new LlmError('The image task was not found', 'IMAGE_GENERATION_NOT_FOUND')
      return project(task)
    },
    async cancel(handle) {
      running.get(handle.id)?.controller.abort()
      const task = tasks.get(handle.id)
      if (!task) throw new LlmError('The image task was not found', 'IMAGE_GENERATION_NOT_FOUND')
      if (task.state === 'queued') await save({ ...task, state: 'cancelled', error: { code: 'cancelled', message: 'The image task was cancelled before dispatch.' } })
      return project(tasks.get(handle.id)!)
    },
    async generate(request) {
      const accepted = await provider.start!(request)
      let task = accepted
      while (task.state === 'queued' || task.state === 'sent') task = await provider.get!(accepted, { waitMs: 20_000, signal: request.signal })
      if (task.state !== 'succeeded') throw new LlmError(task.error?.message ?? 'The image task failed', 'IMAGE_GENERATION_FAILED')
      return task.images
    },
  }
  return { provider, async close() { closing = true; for (const operation of running.values()) operation.controller.abort(); await Promise.allSettled([...running.values()].map(operation => operation.promise)); await domain.close() } }
}
