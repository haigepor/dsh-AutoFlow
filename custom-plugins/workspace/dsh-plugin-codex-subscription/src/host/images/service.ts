/** Durable Codex image operations. Protocol fields follow Magpie draw.go at e056779a67d2024a09aa25edad8a4373931a5b64. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ImageServiceError, imageFailure } from './errors.ts'
import { decodeImageDataUrl, detectImageMediaType, loadImageReference } from './remote.ts'
import type { ImageAssetRecord, ImageBytes, ImageInput, ImageOwner, ImageServiceOptions, ImageServiceSettings, ImageTask, ImageTaskRecord, ImagesFacade } from './types.ts'
import { parseImageAssetId, parseImageTaskId, type ImageTaskId } from './ids.ts'
import { accountRefusal } from '../accounts/failures.ts'
import { codexUserAgent } from '../codex-request.ts'

interface RunningTask { input: ImageInput; settings: ImageServiceSettings; controller: AbortController; sent: boolean; responseKnown: boolean; timer: ReturnType<typeof setTimeout> }

const wireResponse = z.object({ data: z.array(z.unknown()).min(1).max(4) })
const wireImage = z.object({ b64_json: z.string().optional(), url: z.string().optional() })
const terminal = (task: ImageTask) => task.state !== 'queued' && task.state !== 'sent'

/** One initialized service owns admission, task transitions, cancellation and drain order. */
export class ImageService implements ImagesFacade {
  private readonly operations = new Map<ImageTaskId, RunningTask>()
  private readonly queue: ImageTaskId[] = []
  private readonly running = new Set<Promise<void>>()
  private chain: Promise<void> = Promise.resolve()
  private started = false
  private closing = false
  private active = 0
  private readonly now: () => number
  private readonly id: () => string
  private settings: ImageServiceSettings

  constructor(private readonly options: ImageServiceOptions) { this.now = options.now ?? Date.now; this.id = options.id ?? randomUUID; this.settings = settingsOf(options) }

  /** Apply validated settings only to future tasks; accepted tasks retain their original limits.
   * @param settings New deployment settings validated by the plugin configuration parser.
   */
  updateSettings(settings: ImageServiceSettings): void { this.settings = settingsOf(settings); this.pump() }

  /** Recover interrupted tasks conservatively; accepted requests are never resent after restart.
   * @returns Completion after all recovery writes are durable.
   */
  async initialize(): Promise<void> {
    if (this.started) throw new ImageServiceError('already-initialized', 'The image service has already initialized.')
    for (const task of await this.options.repository.list()) {
      if (!terminal(task) && task.assets.length > 0) {
        await this.options.repository.put({ ...task, updatedAt: this.now(), state: 'succeeded', error: {
          code: 'image-partial-result', message: 'The Host restarted while saving results. Saved images remain available; missing outputs will not be regenerated automatically.' } })
      } else if (!terminal(task)) await this.options.repository.put({ ...task, updatedAt: this.now(),
        state: task.state === 'sent' ? 'outcome-unknown' : 'cancelled',
        error: task.state === 'sent'
          ? { code: 'interrupted-after-send', message: 'The Host restarted after dispatch. The remote outcome is unknown; this task will not be resent.' }
          : { code: 'interrupted-before-send', message: 'The Host restarted before dispatch. Start a new task to generate the image.' },
      })
    }
    this.started = true
  }

  /** Accept and persist one generation before background execution.
   * @param input Model/tool or wire input; validated before acceptance.
   * @param owner Identity required for later reads and cancellation.
   * @returns The durable queued task, not a claim that generation completed.
   */
  submit(input: ImageInput, owner: ImageOwner): Promise<ImageTask> {
    return this.serialize(async () => {
      this.assertOpen()
      const settings = structuredClone(this.settings)
      const resolved = this.validate(input, settings)
      if (this.operations.size >= settings.maxQueued + settings.maxConcurrent) throw new ImageServiceError('image-queue-full', 'The image task queue is full. Wait for an existing task to finish.')
      if ((await this.options.repository.list()).length >= settings.maxHistoryTasks) throw new ImageServiceError('image-history-full', 'Image task history is full. Remove completed tasks from settings before starting a new task.')
      const now = this.now()
      const task: ImageTaskRecord = { id: parseImageTaskId(this.id()), owner: structuredClone(owner), state: 'queued', prompt: resolved.prompt,
        model: resolved.model!, createdAt: now, updatedAt: now, deadlineAt: now + settings.timeoutMs, assets: [] }
      await this.options.repository.put(task)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new ImageServiceError('image-deadline', 'The image task exceeded its configured deadline.')), Math.max(1, task.deadlineAt - this.now()))
      timer.unref()
      this.operations.set(task.id, { input: resolved, settings, controller, sent: false, responseKnown: false, timer })
      this.queue.push(task.id)
      this.pump()
      return structuredClone(task)
    })
  }

  /** Read or briefly wait for one authorized task. Aborting a wait leaves its generation running.
   * @param id Previously accepted task identifier.
   * @param owner Same Session or gateway key as the accepted task.
   * @param options Omitted waits zero milliseconds; provided waits are clamped to 20 seconds.
   * @returns A detached durable task projection.
   */
  async getResult(id: string, owner: ImageOwner, options: { waitMs?: number; signal?: AbortSignal } = {}): Promise<ImageTask> {
    let task = await this.owned(id, owner)
    const waitMs = Math.max(0, Math.min(20_000, options.waitMs ?? 0))
    const until = this.now() + waitMs
    while (!terminal(task) && this.now() < until) {
      await wait(Math.min(100, until - this.now()), options.signal)
      task = await this.owned(id, owner)
    }
    return task
  }

  /** Cancel local execution; a dispatched task records an unknown remote outcome.
   * @param id Accepted task identifier.
   * @param owner Authorized task owner.
   * @returns The durable terminal task.
   */
  cancel(id: string, owner: ImageOwner): Promise<ImageTask> {
    return this.serialize(async () => {
      const task = await this.owned(id, owner)
      if (terminal(task)) return task
      const next: ImageTaskRecord = { ...task, updatedAt: this.now(), state: task.state === 'sent' ? 'outcome-unknown' : 'cancelled',
        error: { code: task.state === 'sent' ? 'cancelled-after-send' : 'cancelled-before-send', message: task.state === 'sent'
          ? 'Local waiting was cancelled after dispatch. The remote outcome is unknown and the task will not be resent.' : 'The task was cancelled before dispatch.' } }
      await this.options.repository.put(next)
      this.operations.get(task.id)?.controller.abort(new ImageServiceError('image-cancelled', 'The image task was cancelled.'))
      return next
    })
  }

  /** List only this caller's tasks.
   * @param owner Caller identity.
   * @returns Detached tasks in newest-first order.
   */
  async list(owner: ImageOwner): Promise<ImageTask[]> { return (await this.options.repository.list()).filter(task => sameOwner(task.owner, owner)).sort((a, b) => b.createdAt - a.createdAt) }

  /** Read all task metadata for the authenticated profile owner; never expose this through relay/MCP.
   * @returns Detached task history newest first.
   */
  async listAll(): Promise<ImageTask[]> { return (await this.options.repository.list()).sort((a, b) => b.createdAt - a.createdAt) }

  /** Read one task for the Host's authenticated owner settings surface.
   * @param id Task identifier.
   * @returns Safe task metadata; caller must authenticate the profile owner first.
   */
  getTaskForOwnerUI(id: string): Promise<ImageTask> { return this.ownedRecord(id) }

  /** Read one original only for the Host's authenticated profile-owner surface.
   * @param taskId Successful task identifier.
   * @param assetId Asset within that task.
   * @param signal Optional original-read cancellation.
   * @returns Image bytes after task membership validation; caller owns profile-owner authentication.
   */
  async readAssetForOwnerUI(taskId: string, assetId: string, signal?: AbortSignal): Promise<ImageBytes> {
    const task = await this.ownedRecord(taskId)
    return this.readAsset(taskId, assetId, task.owner, signal)
  }

  /** Explicitly remove terminal task metadata older than a timestamp; attachment retention stays provider-owned.
   * @param before Exclusive creation timestamp cutoff selected by the authenticated profile owner.
   * @returns Number of removed records; pending tasks are never removed.
   */
  pruneCompleted(before: number): Promise<number> {
    return this.serialize(async () => {
      let removed = 0
      for (const task of await this.options.repository.list()) {
        if (terminal(task) && task.createdAt < before) { await this.options.repository.delete(task.id); removed++ }
      }
      return removed
    })
  }

  /** Read an original image after both task and asset authorization.
   * @param taskId Successful image task.
   * @param assetId Asset within that task.
   * @param owner Authorized caller identity.
   * @param signal Optional original-read cancellation; omitted reads to completion.
   * @returns Bounded original bytes with verified media type.
   */
  async readAsset(taskId: string, assetId: string, owner: ImageOwner, signal?: AbortSignal): Promise<ImageBytes> {
    const task = await this.owned(taskId, owner)
    const asset = task.assets.find(value => value.id === parseImageAssetId(assetId))
    if (asset === undefined) throw new ImageServiceError('image-asset-not-found', 'The requested image asset is unavailable.')
    return this.options.readAsset(asset, signal)
  }

  /** Stop admission, abort local work and drain its final writes; the caller closes the repository afterwards.
   * @returns Completion after admitted background operations and task transitions settle.
   */
  async dispose(): Promise<void> {
    this.closing = true
    await this.chain
    for (const operation of this.operations.values()) operation.controller.abort(new ImageServiceError('image-service-stopped', 'The image service stopped.'))
    this.pump()
    while (this.running.size > 0) await Promise.all([...this.running])
    await this.chain
  }

  private validate(input: ImageInput, settings: ImageServiceSettings): ImageInput {
    const schema = z.object({ prompt: z.string().trim().min(1).max(settings.maxPromptChars), model: z.string().trim().min(1).max(256).optional(),
      size: z.string().regex(/^(auto|[1-9]\d{0,4}x[1-9]\d{0,4}|[1-9]\d{0,2}:[1-9]\d{0,2})$/).optional(), n: z.number().int().min(1).max(4).optional(),
      quality: z.enum(['auto', 'low', 'medium', 'high']).optional(), background: z.enum(['auto', 'opaque', 'transparent']).optional(),
      outputFormat: z.enum(['png', 'jpeg', 'webp']).optional(),
      referenceImages: z.array(z.string().min(1).max(Math.ceil(settings.maxImageBytes / 3) * 4 + 128)).max(settings.maxReferenceImages).optional(),
      mask: z.string().min(1).max(Math.ceil(settings.maxImageBytes / 3) * 4 + 128).optional(),
    }).strict()
    const parsed = schema.safeParse(input)
    if (!parsed.success) throw new ImageServiceError('invalid-image-input', 'Image input is invalid. Check prompt, n (1–4), size, quality, background and reference limits.')
    if (parsed.data.mask !== undefined && (parsed.data.referenceImages?.length ?? 0) === 0) throw new ImageServiceError('invalid-image-mask', 'A mask requires at least one reference image.')
    return { ...parsed.data, model: parsed.data.model ?? settings.defaultModel, n: parsed.data.n ?? 1 }
  }

  private pump(): void {
    while (this.active < this.settings.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift()!
      this.active++
      const operation = this.run(id).catch(error => this.options.reportError(error instanceof Error ? error : new Error('Image background operation failed.'))).finally(() => {
        this.active--
        this.operations.delete(id)
        this.running.delete(operation)
        this.pump()
      })
      this.running.add(operation)
    }
  }

  private async run(id: ImageTaskId): Promise<void> {
    const operation = this.operations.get(id)!
    const settings = operation.settings
    const signal = operation.controller.signal
    try {
      signal.throwIfAborted()
      const refs: string[] = []
      for (const reference of operation.input.referenceImages ?? []) {
        const image = await this.load(reference, settings, signal)
        await this.options.validateReference(image)
        signal.throwIfAborted()
        refs.push(`data:${image.mimeType};base64,${Buffer.from(image.data).toString('base64')}`)
      }
      let mask: string | undefined
      if (operation.input.mask !== undefined) {
        const image = await this.load(operation.input.mask, settings, signal)
        await this.options.validateReference(image)
        signal.throwIfAborted()
        mask = `data:${image.mimeType};base64,${Buffer.from(image.data).toString('base64')}`
      }
      const task = await this.ownedRecord(id)
      await this.options.withAccount({ kind: 'image', model: task.model, ...(task.owner.kind === 'session' ? { sessionId: task.owner.sessionId } : {}), signal }, async lease => {
        const requestSignal = AbortSignal.any([signal, lease.signal])
        await this.serialize(async () => {
          const current = await this.ownedRecord(id)
          requestSignal.throwIfAborted()
          if (terminal(current)) throw new ImageServiceError('image-cancelled', 'The image task was cancelled.')
          await this.options.repository.put({ ...current, state: 'sent', accountKey: lease.accountKey, updatedAt: this.now() })
          operation.sent = true
          operation.responseKnown = false
        })
        requestSignal.throwIfAborted()
        const { referenceImages: _references, mask: _mask, outputFormat, ...input } = operation.input
        // Codex 编辑接口使用 JSON images；不发送 GPT-image 后端拒绝的 response_format。
        const body = { ...input, ...(outputFormat === undefined ? {} : { output_format: outputFormat }), ...(refs.length > 0 ? { images: refs.map(image_url => ({ image_url })) } : {}), ...(mask === undefined ? {} : { mask: { image_url: mask } }) }
        const fetched = await this.options.fetch(`${settings.baseUrl.replace(/\/$/, '')}/images/${refs.length > 0 ? 'edits' : 'generations'}`, {
          method: 'POST', redirect: 'error', signal: requestSignal,
          headers: { ...lease.headers, 'Content-Type': 'application/json', Accept: 'application/json', originator: 'codex_cli_rs',
            'OpenAI-Beta': 'responses=experimental', version: this.options.clientVersion,
            'User-Agent': codexUserAgent(this.options.clientVersion),
            'x-codex-imagegen-request-id': this.id(), 'x-codex-image-turn-id': this.id() },
          body: JSON.stringify(body),
        })
        const response = lease.observeResponse?.(fetched) ?? fetched
        if (!response.ok) {
          operation.responseKnown = true
          if ([401, 402, 403, 429].includes(response.status)) throw await accountRefusal(response, this.now(), requestSignal)
          await response.body?.cancel()
          throw new ImageServiceError('codex-image-http-error', 'Codex rejected the image request. Check account access, quota and requested image model.', response.status)
        }
        const responseText = await readResponse(response, settings.maxResponseBytes, requestSignal)
        operation.responseKnown = true
        let raw: unknown
        try { raw = JSON.parse(responseText) } catch (_error) { throw new ImageServiceError('invalid-image-response', 'Codex returned invalid image JSON.') }
        const decoded = wireResponse.safeParse(raw)
        if (!decoded.success) throw new ImageServiceError('invalid-image-response', 'Codex returned no supported image results.')
        let failed = 0
        let lastFailure: unknown
        for (const rawEntry of decoded.data.data) {
          requestSignal.throwIfAborted()
          let assets: ImageAssetRecord[]
          try {
            const image = await this.decodeOutput(rawEntry, settings, requestSignal)
            try { assets = await this.options.saveAssets([image]) }
            catch (_error) { throw new ImageServiceError('image-result-storage-failed', 'Codex returned image bytes but saving the result failed. Check Host storage; this task will not be resent automatically.') }
          } catch (error) {
            requestSignal.throwIfAborted()
            failed++; lastFailure = error; continue
          }
          // 每张图片立即提交引用；后续下载、解码或写入失败不能丢掉已经付费取得的成功结果。
          await this.serialize(async () => {
            const current = await this.ownedRecord(id)
            await this.options.repository.put({ ...current, updatedAt: this.now(), assets: [...current.assets, ...assets] })
          })
        }
        await this.serialize(async () => {
          const current = await this.ownedRecord(id)
          if (terminal(current)) return
          if (current.assets.length === 0) throw lastFailure ?? new ImageServiceError('invalid-image-response', 'Codex returned no saved images.')
          await this.options.repository.put({ ...current, state: 'succeeded', updatedAt: this.now(), ...(failed === 0 ? {} : { error: {
            code: 'image-partial-result', message: `${current.assets.length} image(s) saved; ${failed} output(s) could not be saved. Use the existing images; missing outputs will not be regenerated automatically.` } }) })
        })
      })
    } catch (error) {
      await this.serialize(async () => {
        const task = await this.ownedRecord(id)
        if (terminal(task)) return
        const unknown = operation.sent && !operation.responseKnown
        const failure = unknown
          ? { code: 'image-outcome-unknown', message: 'The request was dispatched but its remote outcome could not be confirmed. It will not be resent automatically.' }
          : imageFailure(signal.aborted ? signal.reason : error)
        await this.options.repository.put({ ...task, state: unknown ? 'outcome-unknown' : signal.aborted && !operation.sent ? 'cancelled' : 'failed', updatedAt: this.now(), error: failure })
      })
    } finally { clearTimeout(operation.timer) }
  }

  private async load(reference: string, settings: ImageServiceSettings, signal: AbortSignal): Promise<ImageBytes> {
    const image = reference.startsWith('data:') ? decodeImageDataUrl(reference, settings.maxImageBytes)
      : this.options.readRemoteImage === undefined
        ? await loadImageReference(reference, settings, signal) : await this.options.readRemoteImage(reference, signal)
    if (image.data.byteLength > settings.maxImageBytes) throw new ImageServiceError('image-too-large', 'An image exceeds the configured byte limit.')
    return { ...image, mimeType: detectImageMediaType(image.data) }
  }

  private async decodeOutput(raw: unknown, settings: ImageServiceSettings, signal: AbortSignal): Promise<ImageBytes> {
    const parsed = wireImage.safeParse(raw)
    if (!parsed.success) throw new ImageServiceError('invalid-image-response', 'Codex returned an invalid image entry.')
    const entry = parsed.data
    if (entry.b64_json === undefined) {
      if (entry.url === undefined) throw new ImageServiceError('invalid-image-response', 'Codex returned an image without bytes or a supported URL.')
      return this.load(entry.url, settings, signal)
    }
    if (entry.b64_json.length > Math.ceil(settings.maxImageBytes / 3) * 4) throw new ImageServiceError('image-too-large', 'A generated image exceeds the configured limit.')
    const data = Buffer.from(entry.b64_json, 'base64')
    if (data.byteLength > settings.maxImageBytes || data.toString('base64') !== entry.b64_json) throw new ImageServiceError('invalid-image-response', 'Codex returned invalid or oversized image base64.')
    return { data, mimeType: detectImageMediaType(data) }
  }

  private assertOpen(): void {
    if (!this.started || this.closing) throw new ImageServiceError('image-service-unavailable', 'The image service is not accepting tasks.')
  }

  private async ownedRecord(id: string): Promise<ImageTaskRecord> {
    const task = await this.options.repository.get(parseImageTaskId(id))
    if (task === undefined) throw new ImageServiceError('image-task-not-found', 'The image task is unavailable to this caller.')
    return task
  }

  private async owned(id: string, owner: ImageOwner): Promise<ImageTaskRecord> {
    const task = await this.ownedRecord(id)
    if (!sameOwner(task.owner, owner)) throw new ImageServiceError('image-task-not-found', 'The image task is unavailable to this caller.')
    return task
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation)
    this.chain = result.then(() => {}, () => {})
    return result
  }
}

function settingsOf(options: ImageServiceSettings): ImageServiceSettings {
  const { baseUrl, defaultModel, timeoutMs, maxConcurrent, maxQueued, maxReferenceImages, maxImageBytes, maxResponseBytes, maxPromptChars, maxRedirects, maxHistoryTasks } = options
  return { baseUrl, defaultModel, timeoutMs, maxConcurrent, maxQueued, maxReferenceImages, maxImageBytes, maxResponseBytes, maxPromptChars, maxRedirects, maxHistoryTasks }
}

function sameOwner(left: ImageOwner, right: ImageOwner): boolean {
  return left.kind === 'session' ? right.kind === 'session' && left.sessionId === right.sessionId : right.kind === 'gateway' && left.keyId === right.keyId
}

async function readResponse(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (response.body === null) throw new ImageServiceError('invalid-image-response', 'Codex returned an empty image response.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > maxBytes) throw new ImageServiceError('image-response-too-large', 'The image response exceeds the configured limit.')
      chunks.push(result.value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { await reader.cancel(); reader.releaseLock() }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    function abort() { clearTimeout(timer); reject(signal?.reason) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
