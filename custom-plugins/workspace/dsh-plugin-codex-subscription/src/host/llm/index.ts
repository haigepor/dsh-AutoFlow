/** Public LLM route backed by per-account native Codex adapters and the shared account pool. */
import { LlmAdapter, LlmError, resolveRetryPolicy, type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type PreparedAdapterCall, type StreamChunk, type ProviderRequestId, type NativeWebSearchRequest, type NativeWebSearchResult } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { PiAiAdapter, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { CodexAccounts } from '../accounts/index.ts'
import type { AccountLease, PoolAdapterOptions } from '../accounts/types.ts'
import { nativeRequest, wrapReplay } from './replay.ts'
import { AccountError } from '../accounts/index.ts'
import { AccountRejected } from '../accounts/record.ts'
import type { CodexModelSnapshot } from '../models.ts'
import type { StreamOptions } from '@earendil-works/pi-ai'
import { requestImageDimensions, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

function deferred<T>() {
  let resolve: (value: T) => void = () => {}, reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

class UnstartedRefusal extends Error {
  constructor(readonly accountKey: string, readonly finish: Extract<StreamChunk, { type: 'finish' }>) { super('The account refused before model output.') }
}

/** Describe only capabilities available on every account captured for this request. */
export function commonCapabilities(models: readonly LlmResolvedModelInfo[], provider: string): LlmResolvedModelInfo {
  const reference = models[0]
  if (!reference) throw new LlmError('订阅账号没有可用的模型快照。', 'UNKNOWN_MODEL')
  const modalities = models.every(model => model.inputModalities !== undefined)
    ? reference.inputModalities?.filter(modality => models.every(model => model.inputModalities?.includes(modality))) : undefined
  const context = models.every(model => model.context !== undefined) ? { contextWindow: Math.min(...models.map(model => model.context!.contextWindow)) } : undefined
  const maxTokens = models.every(model => model.defaultMaxTokens !== undefined) ? Math.min(...models.map(model => model.defaultMaxTokens!)) : undefined
  const efforts = reference.reasoning?.efforts.filter(effort => models.every(model => model.reasoning?.efforts.some(other => other.id === effort.id)))
  const defaultEffort = reference.reasoning?.defaultEffort
  const reasoning = efforts?.length ? { efforts, ...(defaultEffort !== undefined && efforts.some(effort => effort.id === defaultEffort)
    && models.every(model => model.reasoning?.defaultEffort === defaultEffort) ? { defaultEffort } : {}) } : undefined
  return { provider, id: reference.id, name: reference.name, nativeWebSearch: models.every(model => model.nativeWebSearch === true),
    ...(modalities === undefined ? {} : { inputModalities: modalities }), ...(context === undefined ? {} : { context }),
    ...(maxTokens === undefined ? {} : { defaultMaxTokens: maxTokens }), ...(reasoning === undefined ? {} : { reasoning }),
    ...(models.every(model => model.systemPromptUpdate === 'in-history') ? { systemPromptUpdate: 'in-history' } : {}),
    ...(models.every(model => model.toolUpdate !== undefined) ? { toolUpdate: models.every(model => model.toolUpdate === 'in-history') ? 'in-history' : 'addition-only' } : {}) }
}

/** Common native capabilities freeze at prepare; stream selects a sticky account from that generation. */
export class CodexPoolAdapter extends LlmAdapter {
  private readonly retryPolicy = resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'codex-subscription')
  private readonly config: PoolAdapterOptions

  constructor(private readonly accounts: CodexAccounts, options: PoolAdapterOptions) { super(); this.config = { ...options } }

  override providerInfo(provider: string) { this.check(provider); return { id: provider, name: this.config.displayName } }
  override providerRetryPolicy(provider: string) { this.check(provider); return this.retryPolicy }
  override imageRequestTarget(provider: string, _model: string, image: ImageAttachmentRef) {
    this.check(provider)
    return { ...requestImageDimensions(image.width, image.height, this.config.requestImagePixelBudget), maxBytes: this.config.requestImageMaxBytes }
  }

  private check(provider: string): void {
    if (provider !== this.config.provider) throw new LlmError('订阅适配器不拥有该 provider。', 'NO_ADAPTER')
  }

  private inner(accountKey: string, snapshot: CodexModelSnapshot, baseModelId: string, onRefusal?: (failure: AccountRejected) => void, nativeSearch = false): PiAiAdapter {
    const native = this.accounts.nativeFor(accountKey)
    const upstream = onRefusal === undefined ? native.provider : native.providerWithRefusal(onRefusal)
    const models = snapshot.models.map(model => Object.freeze({ ...model, baseUrl: this.config.baseUrl }))
    const profile: ResolvedPiAiProviderProfile = { provider: 'openai-codex', displayName: this.config.displayName,
      baseURL: this.config.baseUrl, piProvider: { ...upstream, baseUrl: this.config.baseUrl,
        getModels: () => models, getAllModels: () => models,
        stream: (model, context, options) => {
          const common: StreamOptions | undefined = options
          return upstream.stream({ ...model, api: 'openai-codex-responses', id: baseModelId }, context, common)
        },
        streamSimple: (model, context, options) => upstream.streamSimple({ ...model, api: 'openai-codex-responses', id: baseModelId }, context, options) },
      transport: 'sse', timeoutMs: this.config.timeoutMs, streamIdleTimeoutMs: this.config.streamIdleTimeoutMs,
      headers: { originator: 'codex_cli_rs', 'User-Agent': `codex_cli_rs/${this.accounts.options.clientVersion}` },
      maxRequestImageBytes: this.config.maxRequestImageBytes, requestImagePixelBudget: this.config.requestImagePixelBudget,
      requestImageMaxBytes: this.config.requestImageMaxBytes, retryPolicy: this.retryPolicy,
      modelErrors: new Map(), configuredMaxTokens: new Map(), configuredReasoningEfforts: snapshot.defaults,
      configuredNativeWebSearch: new Map(snapshot.views.flatMap(view => nativeSearch || view.nativeWebSearch !== undefined
        ? [[view.id, nativeSearch || view.nativeWebSearch === true] as const] : [])) }
    const profiles = new Map([['openai-codex', profile]])
    const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => undefined,
      auth: { credentials: native.credentials, authContext: native.authContext },
      ...(this.config.resolveAttachments === undefined ? {} : { resolveAttachments: this.config.resolveAttachments }),
      ...(this.config.resolveImageAccess === undefined ? {} : { resolveImageAccess: this.config.resolveImageAccess }) })
    return adapter
  }

  /** The configured directory advertises only selected, currently routable text models. */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.check(provider)
    return (await (this.config.listModels?.() ?? this.accounts.models())).map(model => ({ provider, id: model.id, name: model.name, inputModalities: [...model.input] }))
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return (await this.prepareCall(provider, model, signal)).model
  }

  /** Capture model capabilities and eligible account keys; credential freshness is checked at dispatch. */
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    this.check(provider); signal?.throwIfAborted()
    const route = await this.accounts.captureModelRoute(model)
    if (route === undefined || route.view.accountKeys.length === 0) throw new LlmError('账号模型目录未提供该模型，请检查登录和目录状态。', 'UNKNOWN_MODEL')
    const allowed = new Set(route.view.accountKeys)
    const calls = new Map(await Promise.all([...allowed].map(async accountKey => {
      const snapshot = route.snapshot, baseModelId = route.view.baseModelId
      const prepared = await this.inner(accountKey, snapshot, baseModelId).prepareCall('openai-codex', model, signal)
      return [accountKey, { model: prepared.model, stream: options => this.nativeStream(accountKey, snapshot, baseModelId, model, options) } satisfies PreparedAdapterCall] as const
    })))
    const configured = (await this.config.listModels?.())?.find(item => item.id === model)?.nativeWebSearch
    return { model: { ...commonCapabilities([...calls.values()].map(call => call.model), provider),
      ...configured === undefined ? {} : { nativeWebSearch: configured } }, stream: options => this.streamPrepared(options, calls) }
  }

  /**
   * Use the selected subscription account for one isolated, native search request.
   * @param request Exact public model route and the parent search tool's ownership.
   * @returns Structured sources through the same account scheduler and proxy transport.
   */
  override async searchNative(request: NativeWebSearchRequest): Promise<NativeWebSearchResult> {
    if ((await this.prepareCall(request.provider, request.model, request.signal)).model.nativeWebSearch !== true) {
      throw new LlmError('Native web search is disabled for this model', 'UNSUPPORTED_OPTION')
    }
    const route = await this.accounts.captureModelRoute(request.model)
    if (route === undefined) throw new LlmError('The subscription model is unavailable', 'UNKNOWN_MODEL')
    return this.accounts.withCandidates({ kind: 'text', model: request.model, signal: request.signal }, new Set(route.view.accountKeys), lease =>
      this.inner(lease.accountKey, route.snapshot, route.view.baseModelId, undefined, true).searchNative({ ...request, provider: 'openai-codex', signal: lease.signal }))
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const prepared = await this.prepareCall(options.provider, options.model, options.signal)
    yield* prepared.stream(options)
  }

  private async *nativeStream(accountKey: string, snapshot: CodexModelSnapshot, baseModelId: string, model: string, options: GenerateOptions): AsyncGenerator<StreamChunk> {
    let refusal: AccountRejected | undefined
    // 每次消费独立持有拒绝信息，避免 SDK 的字符串错误投影丢掉 402，也避免并发请求互串状态。
    const prepared = await this.inner(accountKey, snapshot, baseModelId, failure => { refusal = failure }).prepareCall('openai-codex', model, options.signal)
    for await (const chunk of prepared.stream(options)) {
      yield chunk.type === 'finish' && chunk.reason.kind === 'error' && refusal !== undefined
        ? { ...chunk, reason: { kind: 'error', failure: { message: refusal.message, code: 'ACCOUNT_REJECTED', status: refusal.status!,
          ...(refusal.details.retryAt === undefined ? {} : { providerRetryAfterMs: Math.max(0, refusal.details.retryAt - Date.now()) }),
          ...(refusal.details.requestId === undefined ? {} : { requestId: brandString<ProviderRequestId>(refusal.details.requestId) }) } } } : chunk
    }
  }

  private async *streamPrepared(options: GenerateOptions, calls: ReadonlyMap<string, PreparedAdapterCall>): AsyncGenerator<StreamChunk> {
    const remaining = new Map(calls)
    while (remaining.size > 0) {
      try { yield* this.streamAccount(options, remaining); return }
      catch (error) {
        if (!(error instanceof UnstartedRefusal)) throw error
        remaining.delete(error.accountKey)
        if (remaining.size === 0) { yield error.finish; return }
      }
    }
  }

  private async *streamAccount(options: GenerateOptions, calls: ReadonlyMap<string, PreparedAdapterCall>): AsyncGenerator<StreamChunk> {
    this.check(options.provider)
    const ready = deferred<AccountLease>(), completed = deferred<void>()
    let acquired = false
    // 持有账号直到消费者完成或 return；仅拿到 HTTP headers 不代表请求已结束。
    const holding = this.accounts.withCandidates({ kind: 'text', model: options.model,
      ...(options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }) }, new Set(calls.keys()), async lease => {
      acquired = true; ready.resolve(lease); await completed.promise
    })
    const observed = holding.then(() => undefined, error => { ready.reject(error); return error })
    try {
      const lease = await ready.promise
      const prepared = calls.get(lease.accountKey)
      if (!prepared) throw new LlmError('选中账号不属于本次已准备请求。', 'NO_ADAPTER')
      let emitted = false, pendingUsage: Extract<StreamChunk, { type: 'usage' }> | undefined
      for await (const chunk of prepared.stream(nativeRequest({ ...options, signal: lease.signal }, lease.accountKey, this.config.provider))) {
        if (chunk.type === 'usage' && !emitted && Object.values(chunk.usage).every(value => value === undefined || value === 0)) { pendingUsage = chunk; continue }
        if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
          const failure = chunk.reason.failure
          const status = failure.status ?? (failure.code === 'AUTH' ? 401 : failure.code === 'RATE_LIMIT' || failure.code === 'QUOTA_EXCEEDED' ? 429 : undefined)
          if (status !== undefined) {
            completed.reject(new AccountError(failure.message, failure.code, status))
            if (!emitted && [401, 402, 403, 429].includes(status)) throw new UnstartedRefusal(lease.accountKey, chunk)
          }
        }
        if (pendingUsage !== undefined) { yield pendingUsage; pendingUsage = undefined }
        emitted = true
        yield chunk.type === 'finish' && chunk.replayState !== undefined
          ? { ...chunk, replayState: wrapReplay(chunk.replayState, lease.accountKey, this.config.provider) } : chunk
      }
      completed.resolve()
    } catch (error) { if (acquired) completed.reject(error); else completed.resolve(); throw error }
    finally { completed.resolve(); await observed }
  }
}
