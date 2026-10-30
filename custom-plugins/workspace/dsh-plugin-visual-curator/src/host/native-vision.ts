/** Native LLM dispatch owns no retries; the durable curator task remains the attempt owner. */
import { createHash } from 'node:crypto'
import { BlockAssembler, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmFailure, LlmRuntime, PreparedLlmCall, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { isAttachmentError } from '@deepseek-ai/dsh-attachment'
import { StructuredVisionProvider } from '../media/vision.ts'
import type { VisionBounds, VisionInput, VisionRequestDescriptor } from '../media/vision.ts'
import type { HttpClient } from '../media/network.ts'
import { MediaError, invalidInput } from '../media/errors.ts'
import { parseModelJson } from '../shared/model-json.ts'
import type { CuratorConfig } from './config.ts'
import { toJson } from './runtime.ts'

/** Capabilities resolved by the profile, with no private HTTP model adapter. */
export interface NativeVisionDependencies {
  llm: Pick<LlmRuntime, 'prepareCall'>
  attachments: Pick<AttachmentStore, 'saveImages' | 'readImage'>
  media: HttpClient
}

function failed(failure: LlmFailure, output: string): MediaError {
  const retryable = failure.status === 429 || failure.status !== undefined && failure.status >= 500
    || ['RATE_LIMIT', 'TIMEOUT', 'LLM_STREAM_IDLE_TIMEOUT', 'NETWORK', 'NETWORK_ERROR', 'SERVER_ERROR', 'STREAM_ERROR', 'UNKNOWN'].includes(failure.code)
  return new MediaError('remote-request-failed', 'reviewing', retryable, 'The native model request failed.', 'Check the native model configuration or continue within the task retry budget.', { modelOutput: { rawText: output }, issues: [failure.code, ...(failure.status === undefined ? [] : [`status:${failure.status}`])] })
}

function mediaType(value: string | undefined): ImageMediaType {
  const mime = value?.split(';', 1)[0]?.trim().toLowerCase()
  if (mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/webp' || mime === 'image/gif') return mime
  throw invalidInput('The image response has an unsupported media type.')
}

/** Uses the registered route and the same attachment normalization as ordinary AI conversations. */
export class NativeVisionProvider extends StructuredVisionProvider {
  private readonly provider: string
  private readonly useModelDefaults: boolean
  private readonly imageCache = new Map<string, { byteDigest: string; attachment: ImageAttachmentRef }>()
  private readonly cacheLimit: number
  constructor(config: CuratorConfig, private readonly dependencies: NativeVisionDependencies) {
    super({ endpoint: '', model: config.vision.model, supportsMultiImage: config.vision.supportsMultipleImages,
      maxImages: config.limits.maxReferenceImages + 2, maxImageBytes: config.limits.maxReferenceBytes,
      maxRequestBytes: config.limits.maxVisionRequestBytes, maxOutputTokens: config.limits.maxVisionOutputTokens,
      temperature: config.limits.visionTemperature, ...(config.vision.reasoningEffort ? { reasoningEffort: config.vision.reasoningEffort } : {}),
      ...(config.vision.vendorVersion ? { declaredModelVersion: config.vision.vendorVersion } : {}) })
    if (!config.vision.provider) throw invalidInput('Select a registered native model provider.')
    this.provider = config.vision.provider
    this.useModelDefaults = config.vision.useModelDefaults === true
    this.cacheLimit = Math.max(config.limits.maxGalleryReferenceFiles, config.limits.maxLocalReferenceFiles)
  }

  override describeRequest(input: VisionInput, operation: VisionRequestDescriptor['operation']): VisionRequestDescriptor {
    return { ...super.describeRequest(input, operation), provider: this.provider, transport: 'native-llm' }
  }

  /** Validate the current registered model before a job can reserve a paid request. */
  async preflight(signal?: AbortSignal): Promise<void> { await this.prepare(signal) }

  private async prepare(signal?: AbortSignal): Promise<PreparedLlmCall> {
    try {
      const prepared = await this.dependencies.llm.prepareCall({ provider: this.provider, model: this.config.model,
        ...(this.useModelDefaults ? {} : { temperature: this.config.temperature, maxTokens: this.config.maxOutputTokens,
          ...(this.config.reasoningEffort ? { reasoningEffort: ReasoningEffortId(this.config.reasoningEffort) } : {}) }) }, signal)
      if (!prepared.inputModalities?.includes('image')) throw new MediaError('capability-unavailable', 'vision-preflight', false, 'The native model route does not declare image input.', 'Select an image-capable model in the project model settings.')
      return prepared
    } catch (error) {
      if (signal?.aborted) throw new MediaError('cancelled', 'reviewing', false, 'Operation cancelled.', 'Resume explicitly when needed.')
      if (error instanceof LlmError) throw new MediaError('capability-unavailable', 'vision-preflight', false, 'The native model route or its request controls are unavailable.', 'Check provider, model and reasoning level in the project model settings.', { modelOutput: null, issues: [error.code] })
      throw error
    }
  }

  protected async invoke(input: VisionInput, operation: VisionRequestDescriptor['operation'], bounds: VisionBounds): Promise<unknown> {
    const descriptor = this.describeRequest(input, operation), startedAt = Date.now()
    bounds.onPhase?.('preparing')
    const deadline = AbortSignal.timeout(bounds.timeoutMs)
    const signal = bounds.signal ? AbortSignal.any([bounds.signal, deadline]) : deadline
    let firstOutputMs: number | undefined, firstReasoningMs: number | undefined, firstTextMs: number | undefined, usage: TokenUsage | undefined, terminal = false, streamStarted = false
    const assembler = new BlockAssembler()
    try {
      const prepared = await this.prepare(signal), inputs: SaveImageAttachment[] = [], sources: { imageVersionId: string; sourceDigest: string; byteDigest: string }[] = []
      const refsByIndex = new Map<number, ImageAttachmentRef>(), missing: { index: number; key: string }[] = []
      let totalBytes = 0, downloadedBytes = 0
      let reservation: Awaited<ReturnType<NonNullable<VisionBounds['reserveDownload']>>> | undefined
      for (const image of input.images) {
        signal.throwIfAborted()
        const key = `${image.imageVersionId}:${image.digest}`, cached = this.imageCache.get(key)
        if (cached) {
          const verified = await this.dependencies.attachments.readImage(cached.attachment, signal)
          totalBytes += verified.data.byteLength
          if (totalBytes > this.config.maxImageBytes) throw invalidInput('The native image bundle exceeds the configured byte budget.')
          refsByIndex.set(sources.length, verified.ref)
          sources.push({ imageVersionId: image.imageVersionId, sourceDigest: image.digest, byteDigest: cached.byteDigest })
          continue
        }
        let bytes: Uint8Array, mime: ImageMediaType
        if (image.remoteSource) {
          // 整批共享一次持久化预留；后续传输未知时保留预留，不能提前释放额度。
          if (!reservation) reservation = await bounds.reserveDownload?.(this.config.maxImageBytes)
          const maxBytes = Math.min(this.config.maxImageBytes - totalBytes, reservation ? reservation.maxBytes - downloadedBytes : this.config.maxImageBytes)
          if (maxBytes <= 0) throw new MediaError('budget-exhausted', 'vision-images', false, 'The native image download budget is exhausted.', 'Adjust the image download budget before starting another task.')
          const response = await this.dependencies.media.request(image.remoteSource.url, { ...bounds, signal, method: 'GET', maxBytes })
          if (response.status < 200 || response.status >= 300) throw new MediaError('remote-request-failed', 'vision-images', response.status === 429 || response.status >= 500, 'An authorized image could not be loaded for the native model.', 'Check the image source and retry within the task budget.')
          bytes = response.bytes; mime = mediaType(response.headers['content-type'])
          downloadedBytes += bytes.byteLength
        } else { bytes = image.bytes; mime = mediaType(image.mime) }
        totalBytes += bytes.byteLength
        if (!bytes.byteLength || totalBytes > this.config.maxImageBytes || Buffer.byteLength(descriptor.instructions + descriptor.inputText) + Math.ceil(totalBytes / 3) * 4 > this.config.maxRequestBytes) throw invalidInput('The native image bundle exceeds the configured byte budget.')
        inputs.push({ data: bytes, mediaType: mime, name: image.imageVersionId })
        missing.push({ index: sources.length, key })
        sources.push({ imageVersionId: image.imageVersionId, sourceDigest: image.digest, byteDigest: createHash('sha256').update(bytes).digest('hex') })
      }
      await reservation?.settle(downloadedBytes)
      if (Buffer.byteLength(descriptor.instructions + descriptor.inputText) + Math.ceil(totalBytes / 3) * 4 > this.config.maxRequestBytes) throw invalidInput('The native image bundle exceeds the configured request byte budget.')
      const admitted = inputs.length ? await this.dependencies.attachments.saveImages(inputs) : []
      for (let index = 0; index < missing.length; index++) {
        const target = missing[index]!, attachment = admitted[index]!
        refsByIndex.set(target.index, attachment)
        this.imageCache.delete(target.key); this.imageCache.set(target.key, { attachment, byteDigest: sources[target.index]!.byteDigest })
        while (this.imageCache.size > this.cacheLimit) this.imageCache.delete(this.imageCache.keys().next().value!)
      }
      const refs = [...refsByIndex].sort(([left], [right]) => left - right).map(([, attachment]) => attachment)
      signal.throwIfAborted()
      const content: ContentBlock[] = [{ type: 'text', text: descriptor.inputText }]
      for (let index = 0; index < refs.length; index++) {
        const image = input.images[index]!, attachment = refs[index]!
        content.push({ type: 'text', text: JSON.stringify({ imageVersionId: image.imageVersionId, digest: image.digest, role: image.role }) }, { type: 'image', attachment })
      }
      const options: GenerateOptions = { ...prepared.config, system: descriptor.instructions, messages: [{ role: 'user', content }], signal }
      const base = { transport: 'native-llm', provider: this.provider, model: this.config.model, ...(prepared.context ? { context: prepared.context } : {}), request: { config: prepared.config, system: options.system, messages: options.messages }, images: sources.map((source, index) => ({ ...source, attachment: refs[index] })) }
      const metadata = () => toJson({ ...base, ...(usage ? { usage } : {}), timing: { startedAt: new Date(startedAt).toISOString(), elapsedMs: Date.now() - startedAt, firstOutputMs, firstReasoningMs, firstTextMs }, ...(terminal ? { finish: assembler.finish } : {}) })
      // 原生附件与实际参数先落盘，之后才允许发送模型请求。
      await bounds.onMetadata?.(metadata())
      bounds.onPhase?.('analyzing')
      let outputBytes = 0
      streamStarted = true
      for await (const chunk of prepared.stream(options)) {
        if (chunk.type === 'reasoning-delta' || chunk.type === 'text-delta') {
          outputBytes += Buffer.byteLength(chunk.text)
          if (outputBytes > bounds.maxBytes) throw new MediaError('budget-exhausted', 'reviewing', false, 'The native response exceeds the configured byte limit.', 'Reduce the output size or adjust the response byte budget.')
        }
        if (chunk.type === 'finish') terminal = true
        assembler.push(chunk)
        if (chunk.type === 'reasoning-delta' || chunk.type === 'text-delta') {
          if (!chunk.text) continue
          const elapsed = Date.now() - startedAt
          firstOutputMs ??= elapsed
          if (chunk.type === 'reasoning-delta') { firstReasoningMs ??= elapsed; bounds.onOutput?.({ reasoning: chunk.text }) }
          else { firstTextMs ??= elapsed; bounds.onOutput?.({ content: chunk.text }) }
        } else if (chunk.type === 'usage') usage = chunk.usage
      }
      await bounds.onMetadata?.(metadata())
      signal.throwIfAborted()
      const text = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
      const finish = assembler.finish
      if (!terminal) throw new MediaError('vision-invalid-output', 'reviewing', true, 'The native model stream ended without a completion result.', 'Continue using saved progress.', { modelOutput: { rawText: text }, issues: ['missing-native-finish'] })
      if (finish.kind === 'error' || finish.kind === 'aborted') throw failed(finish.failure, text)
      if (finish.kind === 'max-tokens') throw new MediaError('vision-output-truncated', 'reviewing', false, 'The vision response reached its output token limit.', 'Increase output tokens or reduce batch size.', { modelOutput: { rawText: text }, issues: ['max-tokens'] })
      if (finish.kind !== 'stop' || !text.trim()) throw new MediaError('vision-invalid-output', 'reviewing', true, 'The native model returned no complete JSON response.', 'Continue using saved progress.', { modelOutput: { rawText: text }, issues: [`finish:${finish.kind}`] })
      try { return parseModelJson(text) } catch (error) {
        // 保留原文供诊断，展示层不把无效 JSON 当成已提交的观察。
        if (error instanceof Error) throw new MediaError('vision-invalid-output', 'reviewing', true, 'The vision response is not valid JSON.', 'Continue using saved progress.', { modelOutput: { rawText: text }, issues: ['invalid-json'] })
        throw error
      }
    } catch (error) {
      if (bounds.signal?.aborted) throw new MediaError('cancelled', 'reviewing', false, 'Operation cancelled.', 'Resume explicitly when needed.')
      if (deadline.aborted) throw new MediaError('request-timeout', 'reviewing', true, 'The native model request timed out.', 'Continue within the saved task budget.')
      if (isAttachmentError(error)) {
        // 接纳采用按内容发布的原子写入；仅在进入模型流之前允许重试写入失败。
        const retryable = error.code === 'ATTACHMENT_WRITE_FAILED' && !streamStarted
        throw new MediaError(error.code, 'vision-images', retryable, 'An image attachment could not be prepared for analysis.', retryable ? 'Check attachment storage and continue within the saved task budget.' : 'Check image format, size and attachment integrity before starting an incremental analysis.', { modelOutput: null, issues: [error.code] })
      }
      throw error
    }
  }
}
