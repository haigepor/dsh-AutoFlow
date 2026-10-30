/** Profile-owned composition of subscription accounts, durable images and a loopback gateway. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-authorization'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-app-boot'
import { z } from 'zod'
import { CodexAccounts } from './accounts/index.ts'
import { ImageService } from './images/service.ts'
import { imageAttachmentAdapter } from './images/attachments.ts'
import { projectImageSession } from './images/view.ts'
import type { ImageTaskRepository, ImageServiceSettings } from './images/types.ts'
import { openImageTaskRepository } from './tasks/repository.ts'
import { CodexResponsesTransport } from './relay/transport.ts'
import { startRelay } from './relay/server.ts'
import { codexUserAgent } from './codex-request.ts'
import { CodexUpstream } from './upstream.ts'
import { CodexVersion } from './version.ts'
import type { GatewayKey, RelayServer, RelayRequestContext } from './relay/types.ts'
import { resolveOptions, type Config, type SubscriptionOptions } from './config.ts'
import { configureSchema, managementSchema, snapshotSchema, type ManagementSnapshot } from '../shared/management.ts'
import { saveModelCatalogSchema, type ModelCatalog } from '../shared/model-catalog.ts'
import type { CodexModelView } from './accounts/types.ts'

/** Independent Home-scoped gateway credential; all active profiles observe its revocation. */
export const GATEWAY_KEY = credentialKey('codex-subscription', 'gateway')
const gatewaySchema = z.strictObject({ version: z.literal(1), id: z.string().min(1), secret: z.string().min(32), createdAt: z.number() })
const identifier = z.string().min(1).max(256)
const accountMutation = z.strictObject({ accountKey: identifier, revision: z.number().int().positive(), label: z.string().max(256).optional(), enabled: z.boolean().optional(), allowCredits: z.boolean().optional(), priority: z.number().int().min(-1000).max(1000).optional() })
const accountRead = z.strictObject({ accountKey: identifier, fresh: z.boolean().optional() })
const imageInput = z.strictObject({ prompt: z.string().min(1), model: z.string().min(1).optional(), size: z.string().optional(), n: z.number().int().min(1).max(4).optional(),
  quality: z.enum(['auto', 'low', 'medium', 'high']).optional(), background: z.enum(['auto', 'opaque', 'transparent']).optional(), outputFormat: z.enum(['png', 'jpeg', 'webp']).optional(), referenceImages: z.array(z.string()).optional(), mask: z.string().optional() })
const BASE = 'https://chatgpt.com/backend-api/codex'

/** Services consumed by the composition root; tests can supply the same public operations. */
export interface SubscriptionHost {
  readonly profileContext: Pick<Context['profileContext'], 'dir'>
  readonly credentials: Pick<Context['credentials'], 'readRecord' | 'modifyRecord' | 'deleteRecord'>
  readonly authorization: Pick<Context['authorization'], 'registerFlow' | 'begin' | 'cancel'>
  readonly settings: Pick<Context['settings'], 'describe' | 'update'>
  readonly storageDomain: Pick<Context['storageDomain'], 'open'>
  readonly attachments: Pick<Context['attachments'], 'validateImage' | 'saveFile' | 'saveImage' | 'readFileStream' | 'readImage'>
  readonly logger: Pick<Context['logger'], 'error'>
}

/** I/O providers use production implementations unless the composition explicitly replaces them. */
export interface SubscriptionDependencies {
  readonly fetch?: typeof globalThis.fetch
  readonly openRepository?: typeof openImageTaskRepository
  readonly startRelay?: typeof startRelay
}

/** Stable management code suitable for caller-owned localization. */
export class ManagementError extends Error {
  constructor(readonly code: string) { super(code) }
}

/** One profile runtime owns listeners and task writers until disposal completes. */
export class CodexSubscriptionService {
  readonly accounts: CodexAccounts
  images!: ImageService
  private repository: ImageTaskRepository | undefined
  private readonly transport: CodexResponsesTransport
  private readonly upstream: CodexUpstream
  private readonly versions: CodexVersion
  private readonly fetch: typeof globalThis.fetch
  private relay: RelayServer | undefined
  private options: SubscriptionOptions
  private relayError: string | undefined
  private relayGeneration = ''
  private updates: Promise<void> = Promise.resolve()
  private controls: Promise<unknown> = Promise.resolve()
  private disposal: Promise<void> | undefined
  private initialization: Promise<void> | undefined
  private stopped = false
  private readonly lifetime = new AbortController()
  private readonly foreground = new Set<Promise<unknown>>()

  constructor(private readonly ctx: SubscriptionHost, readonly settingsNs: string, private readonly boot: Config, initial: unknown, private readonly dependencies: SubscriptionDependencies = {}) {
    this.options = resolveOptions(initial)
    this.versions = new CodexVersion({ minimum: boot.clientVersion, ...this.options.version })
    this.upstream = new CodexUpstream({ endpoint: `${BASE}/responses`, fetch: dependencies.fetch ?? globalThis.fetch, settings: this.options.upstream })
    // 模型目录、原生适配器、图片与中转共用版本及 WS→HTTP 选择；OAuth 请求保持其独立协议。
    this.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin !== 'https://chatgpt.com' || !url.pathname.startsWith('/backend-api/')) return this.upstream.fetch(input, init)
      const version = await this.versions.current()
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      headers.set('version', version); headers.set('user-agent', codexUserAgent(version))
      if (url.pathname === '/backend-api/codex/models') url.searchParams.set('client_version', version)
      return this.upstream.fetch(input instanceof Request ? new Request(url, input) : url, { ...init, headers })
    }
    this.accounts = new CodexAccounts({ credentials: ctx.credentials, authorization: ctx.authorization, fetch: this.fetch,
      clientId: 'app_EMoamEEZ73f0CkXaXp7hrann', authorizeUrl: 'https://auth.openai.com/oauth/authorize', tokenUrl: 'https://auth.openai.com/oauth/token',
      callbackPorts: [1455, 1457], loginTimeoutMs: boot.loginTimeoutMs, tokenTimeoutMs: boot.tokenTimeoutMs,
      sessionAffinityLimit: boot.sessionAffinityLimit, modelCooldownLimit: boot.modelCooldownLimit, cooldownMs: boot.cooldownMs, baseUrl: 'https://chatgpt.com/backend-api',
      clientVersion: boot.clientVersion, discoveryTtlMs: boot.discoveryTtlMs, modelSettings: this.options.models, resolveClientVersion: () => this.versions.current() })
    this.transport = new CodexResponsesTransport({ accounts: this.accounts, fetch: this.fetch, endpoint: `${BASE}/responses`,
      originator: 'codex_cli_rs', userAgent: codexUserAgent(boot.clientVersion), clientVersion: boot.clientVersion, sessionStateLimit: boot.sessionAffinityLimit })
  }

  /** Current tool wait policy; accepted image tasks keep their own deadline. */
  get quickWaitMs(): number { return this.options.images.quickWaitMs }

  /** Inspect protocol negotiation without network I/O or credential values.
   * @returns Current transport counters and version sources.
   */
  protocolStatus() { return { upstream: this.upstream.status(), version: this.versions.status() } }

  /** List explicitly selected text models with current shared-account capabilities.
   * @returns Routable conversational models; image models remain on the image API.
   */
  async catalogModels(): Promise<readonly CodexModelView[]> {
    const configured = new Map(this.options.catalog.filter(entry => entry.kind === 'text').map(entry => [entry.id, entry]))
    return (await this.accounts.models()).flatMap(model => {
      const entry = configured.get(model.id)
      return entry === undefined ? [] : [{ ...model, name: entry.name,
        ...entry.nativeWebSearch === undefined ? {} : { nativeWebSearch: entry.nativeWebSearch } }]
    })
  }

  /** Read explicit choices and upstream candidates without changing any default model.
   * @returns Safe model configuration and its profile settings revision.
   */
  async modelCatalog(): Promise<ModelCatalog> {
    const candidates = await this.accounts.models()
    const { revision, options } = this.catalogConfiguration()
    return { revision, entries: structuredClone(options.catalog), defaultImageModel: options.images.defaultModel,
      candidates: candidates.map(model => ({ id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens, input: [...model.input],
        ...model.nativeWebSearch === undefined ? {} : { nativeWebSearch: model.nativeWebSearch } })) }
  }

  private catalogConfiguration(): { revision: number; options: SubscriptionOptions } {
    const descriptor = this.ctx.settings.describe().find(item => item.ns === this.settingsNs)
    if (descriptor === undefined) return { revision: 0, options: this.options }
    // revision 与值必须来自同一次读取；运行时 listener 更新可能仍在等待，不能用其旧 options 作保存基线。
    const value = z.object({ options: z.unknown().optional() }).parse(descriptor.value)
    return { revision: descriptor.revision, options: resolveOptions(value.options ?? {}) }
  }

  /** Send Responses fields using the shared account scheduler and negotiated transport.
   * @param body Complete stateless Responses input; the caller owns body consumption.
   * @param signal Caller cancellation, combined with profile shutdown.
   * @param context Authenticated gateway metadata; omitted for internal method calls.
   * @returns An SSE response whose body must be consumed or cancelled.
   */
  requestResponses(body: Record<string, unknown>, signal: AbortSignal, context?: RelayRequestContext): Promise<Response> {
    if (this.stopped) return Promise.reject(new ManagementError('STOPPING'))
    return this.transport.request(body, AbortSignal.any([signal, this.lifetime.signal]), context)
  }

  /** Open durable tasks before exposing any Client, Agent or HTTP operation. */
  initialize(): Promise<void> {
    return this.initialization ??= this.start()
  }

  private async start(): Promise<void> {
    this.accounts.mount()
    const profilePath = await realpath(this.ctx.profileContext.dir)
    const profileId = createHash('sha256').update(profilePath).digest('hex').slice(0, 24)
    this.repository = await (this.dependencies.openRepository ?? openImageTaskRepository)(this.ctx.storageDomain, `codex_subscription_images_${profileId}`, join(profilePath, 'codex-subscription', 'writer'))
    const attachments = imageAttachmentAdapter(this.ctx.attachments, 100 * 1024 * 1024)
    this.images = new ImageService({ repository: this.repository, withAccount: (request, run) => this.accounts.withAccount(request, run),
      ...attachments, fetch: this.fetch, clientVersion: this.boot.clientVersion, ...this.imageSettings(this.options), reportError: () => {
        this.ctx.logger.error('Codex image task state could not be persisted; inspect task history before retrying.')
      } })
    await this.images.initialize()
    try { await this.reconfigure(this.options) } catch (error) {
      if (!(error instanceof ManagementError) || !['GATEWAY_KEY_REQUIRED', 'RELAY_START_FAILED'].includes(error.code)) throw error
      // 中转状态单独报告；端口冲突或密钥撤销不能撤下订阅模型和授权管理能力。
      this.ctx.logger.error(`Codex relay is unavailable (${error.code}); subscription models and management remain available.`)
    }
  }

  /** Re-read the gateway credential after a local or cross-process credential notification.
   * @returns Completion after old-key listeners are replaced or stopped.
   */
  refreshGateway(): Promise<void> { return this.reconfigure(this.options) }

  private imageSettings(options: SubscriptionOptions): ImageServiceSettings {
    const { quickWaitMs: _quickWait, uiPollIntervalMs: _uiPoll, ...images } = options.images
    return { ...images, baseUrl: BASE }
  }

  /** Current bounds for resolving Session attachments before task admission. */
  get imageReferenceLimits(): { maxImageBytes: number; maxReferenceImages: number } {
    return { maxImageBytes: this.options.images.maxImageBytes, maxReferenceImages: this.options.images.maxReferenceImages }
  }

  /** Apply new defaults without replacing in-flight task or account instances.
   * @param input Current validated volatile configuration.
   * @returns Completion after listener state matches the requested settings, or an explicit failure.
   */
  reconfigure(input: unknown): Promise<void> {
    const next = resolveOptions(input)
    const operation = this.updates.catch((_error: unknown) => { /* A reported listener failure must not block the next settings correction. */ }).then(async () => {
      if (this.stopped) throw new ManagementError('STOPPING')
      this.options = next
      this.upstream.update(next.upstream)
      this.versions.update(next.version)
      this.accounts.updateModelSettings(next.models)
      this.images.updateSettings(this.imageSettings(next))
      const keys = await this.gatewayKeys()
      const generation = JSON.stringify({ relay: next.relay, keyIds: keys.map(key => key.id) })
      if (generation === this.relayGeneration) return
      const previous = this.relay
      this.relay = undefined
      await previous?.close()
      this.relayGeneration = ''
      this.relayError = undefined
      if (!next.relay.enabled) { this.relayGeneration = generation; return }
      if (keys.length === 0) { this.relayError = 'GATEWAY_KEY_REQUIRED'; throw new ManagementError(this.relayError) }
      try {
        if (this.stopped) throw new ManagementError('STOPPING')
        const listener = await (this.dependencies.startRelay ?? startRelay)({ ...next.relay, gatewayKeys: keys, imageWaitMs: Math.min(next.relay.requestTimeoutMs, next.images.timeoutMs) }, {
          requestResponses: (body, signal, context) => this.requestResponses(body, signal, context),
          observeClient: headers => { this.versions.observeClient(headers) },
          listModels: async signal => { signal.throwIfAborted(); return this.catalogModels() },
          images: this.images,
          readAsset: (taskId, assetId, owner) => this.images.readAsset(taskId, assetId, owner),
        })
        if (this.stopped) { await listener.close(); throw new ManagementError('STOPPING') }
        this.relay = listener
        this.relayGeneration = generation
      } catch (_error) {
        // 不向 Client 复制网络错误，错误对象可能携带有凭据的请求上下文。
        this.relayError = 'RELAY_START_FAILED'
        throw new ManagementError(this.relayError)
      }
    })
    this.updates = operation
    return operation
  }

  private async gatewayKeys(): Promise<GatewayKey[]> {
    const record = await this.ctx.credentials.readRecord(GATEWAY_KEY)
    if (record === undefined) return []
    if (record.kind !== 'grant') throw new ManagementError('INVALID_GATEWAY_RECORD')
    const saved = gatewaySchema.parse(record.payload)
    return [{ id: saved.id, secret: saved.secret }]
  }

  /** Project account, task and listener state without credential values.
   * @returns Bounded metadata for the authenticated profile owner.
   */
  async snapshot(): Promise<ManagementSnapshot> {
    const [accounts, models, tasks, keys] = await Promise.all([this.accounts.list(), this.accounts.models(), this.images.listAll(), this.gatewayKeys()])
    const descriptor = this.ctx.settings.describe().find(item => item.ns === this.settingsNs)
    return snapshotSchema.parse({ accounts, models, protocol: this.protocolStatus(), taskCount: tasks.length, revision: descriptor?.revision ?? 0,
      tasks: tasks.slice(0, 50).map(task => ({ id: task.id, state: task.state, prompt: task.prompt.slice(0, 500), model: task.model, createdAt: task.createdAt,
        ...(task.error ? { errorCode: task.error.code } : {}), assets: task.assets.map(asset => {
          const query = new URLSearchParams({ task: task.id, asset: asset.id })
          return { id: asset.id, previewUrl: `api/codex-subscription/media?${query}`, downloadUrl: `api/codex-subscription/media?${query}&original=1`, width: asset.preview.width, height: asset.preview.height }
        }) })),
      configuration: { imageModel: this.options.images.defaultModel, imageTimeoutMs: this.options.images.timeoutMs,
        relayEnabled: this.options.relay.enabled, relayHost: this.options.relay.host, relayPort: this.options.relay.port },
      relay: { state: this.relay ? 'running' : this.relayError ? 'error' : 'stopped', ...(this.relay ? { origin: this.relay.origin } : {}),
        ...(this.relayError ? { errorCode: this.relayError } : {}), keyConfigured: keys.length > 0, ...(keys[0] ? { keyId: keys[0].id } : {}) },
    })
  }

  /** Execute an owner-authorized command; wire input cannot choose a caller identity.
   * @param input Parsed but untrusted JSON envelope.
   * @param signal Request cancellation; accepted image work has an independent lifetime.
   * @returns JSON-compatible safe result.
   */
  action(input: unknown, signal: AbortSignal): Promise<unknown> {
    const operation = this.runAction(input, AbortSignal.any([signal, this.lifetime.signal]))
    this.foreground.add(operation)
    void operation.then(() => { this.foreground.delete(operation) }, () => { this.foreground.delete(operation) })
    return operation
  }

  private async runAction(input: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.stopped) throw new ManagementError('STOPPING')
    signal.throwIfAborted()
    const command = managementSchema.parse(input)
    if (['gateway-create', 'gateway-revoke', 'configure', 'model-catalog-save'].includes(command.operation)) {
      const result = this.controls.catch((_error: unknown) => { /* The failed mutation has already been reported to its caller. */ }).then(async () => {
        signal.throwIfAborted()
        if (this.stopped) throw new ManagementError('STOPPING')
        return await this.executeAction(command, signal)
      })
      this.controls = result
      return await result
    }
    return await this.executeAction(command, signal)
  }

  private async executeAction({ operation, args }: z.infer<typeof managementSchema>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    switch (operation) {
      case 'snapshot': return this.snapshot()
      case 'account-list': return this.accounts.list()
      case 'account-status': {
        const value = accountRead.parse(args)
        return this.accounts.getAccountStatus(value.accountKey, { ...(value.fresh === undefined ? {} : { fresh: value.fresh }), signal })
      }
      case 'account-quota': {
        const value = accountRead.parse(args)
        return await this.accounts.getAccountQuota(value.accountKey, { ...(value.fresh === undefined ? {} : { fresh: value.fresh }), signal }) ?? null
      }
      case 'account-refresh': return this.accounts.refreshAccount(z.strictObject({ accountKey: identifier }).parse(args).accountKey, signal)
      case 'model-list': return this.accounts.models()
      case 'model-catalog': return this.modelCatalog()
      case 'model-catalog-save': {
        const value = saveModelCatalogSchema.parse(args)
        const { revision, options } = this.catalogConfiguration()
        if (revision !== value.revision) throw new ManagementError('REVISION_CONFLICT')
        const candidates = new Set((await this.accounts.models()).map(model => model.id))
        const previous = new Set(options.catalog.filter(entry => entry.kind === 'text').map(entry => entry.id))
        if (value.entries.some(entry => entry.kind === 'text' && !candidates.has(entry.id) && !previous.has(entry.id))) throw new ManagementError('MODEL_NOT_AVAILABLE')
        if (value.defaultImageModel !== undefined && !value.entries.some(entry => entry.kind === 'image' && entry.id === value.defaultImageModel)) throw new ManagementError('INVALID_IMAGE_MODEL')
        const next = resolveOptions({ ...options, catalog: value.entries, images: { ...options.images,
          ...(value.defaultImageModel === undefined ? {} : { defaultModel: value.defaultImageModel }) } })
        signal.throwIfAborted()
        await this.ctx.settings.update(this.settingsNs, { options: next }, value.revision)
        await this.reconfigure(next)
        return this.modelCatalog()
      }
      case 'model-routes': return this.accounts.modelRoutes()
      case 'protocol-status': return this.protocolStatus()
      case 'login-start': return this.accounts.beginLogin()
      case 'login-status': return this.accounts.loginStatus(identifier.parse(args.loginId))
      case 'login-complete': return this.accounts.completeLogin(identifier.parse(args.loginId), z.string().max(16_384).parse(args.callbackUrl))
      case 'login-cancel': await this.accounts.cancelLogin(identifier.parse(args.loginId)); return { cancelled: true }
      case 'account-update': {
        const { accountKey, ...patch } = accountMutation.parse(args)
        return this.accounts.update(accountKey, { revision: patch.revision,
          ...(patch.label === undefined ? {} : { label: patch.label }), ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
          ...(patch.allowCredits === undefined ? {} : { allowCredits: patch.allowCredits }),
          ...(patch.priority === undefined ? {} : { priority: patch.priority }) })
      }
      case 'account-remove': {
        const value = z.strictObject({ accountKey: identifier, revision: z.number().int().positive() }).parse(args)
        await this.accounts.remove(value.accountKey, value.revision); return { removed: true }
      }
      case 'configure': {
        const value = configureSchema.parse(args)
        if (value.relayEnabled && (await this.gatewayKeys()).length === 0) throw new ManagementError('GATEWAY_KEY_REQUIRED')
        const next = resolveOptions({ ...this.options, images: { ...this.options.images, defaultModel: value.imageModel, timeoutMs: value.imageTimeoutMs },
          relay: { ...this.options.relay, enabled: value.relayEnabled, port: value.relayPort } })
        await this.ctx.settings.update(this.settingsNs, { options: next }, value.revision)
        await this.reconfigure(next)
        return { saved: true }
      }
      case 'gateway-create': {
        const key = { version: 1 as const, id: randomUUID(), secret: `af-codex-${randomBytes(32).toString('base64url')}`, createdAt: Date.now() }
        await this.ctx.credentials.modifyRecord(GATEWAY_KEY, async () => ({ kind: 'grant', payload: key }))
        try { await this.reconfigure(this.options) }
        catch (_error) {
          // 凭据已持久化；监听失败仍必须交付这一次生成的密钥，避免用户拿不到有效凭据。
          return { id: key.id, secret: key.secret, relayError: this.relayError ?? 'RELAY_START_FAILED' }
        }
        return { id: key.id, secret: key.secret }
      }
      case 'gateway-revoke': {
        const descriptor = this.ctx.settings.describe().find(item => item.ns === this.settingsNs)
        const disabled = resolveOptions({ ...this.options, relay: { ...this.options.relay, enabled: false } })
        await this.ctx.settings.update(this.settingsNs, { options: disabled }, descriptor?.revision)
        await this.reconfigure(disabled)
        await this.ctx.credentials.deleteRecord(GATEWAY_KEY)
        return { revoked: true }
      }
      case 'relay-test': {
        if (!this.relay) throw new ManagementError('RELAY_START_FAILED')
        const key = (await this.gatewayKeys())[0]
        if (!key) throw new ManagementError('GATEWAY_KEY_REQUIRED')
        const response = await (this.dependencies.fetch ?? globalThis.fetch)(`${this.relay.origin}/v1/models`, {
          headers: { authorization: `Bearer ${key.secret}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(this.boot.tokenTimeoutMs)]), redirect: 'error',
        })
        await response.body?.cancel()
        if (!response.ok) throw new ManagementError('RELAY_TEST_FAILED')
        return { responding: true }
      }
      case 'image-submit': return this.images.submit(imageInput.parse(args), { kind: 'gateway', keyId: 'profile-owner' })
      case 'image-session-view': {
        const { sessionId } = z.strictObject({ sessionId: identifier }).parse(args)
        return projectImageSession(sessionId, await this.images.list({ kind: 'session', sessionId }), this.options.images.uiPollIntervalMs)
      }
      case 'image-result': {
        const task = await this.images.getTaskForOwnerUI(identifier.parse(args.taskId))
        const waitMs = z.number().int().min(0).max(20_000).default(0).parse(args.waitMs)
        return this.images.getResult(task.id, task.owner, { waitMs, signal })
      }
      case 'image-cancel': {
        const task = await this.images.getTaskForOwnerUI(identifier.parse(args.taskId))
        return this.images.cancel(task.id, task.owner)
      }
      case 'history-prune': return { removed: await this.images.pruneCompleted(z.number().finite().max(Date.now() + 1000).parse(args.before)) }
    }
  }

  /** Handle exact authenticated routes shared by Web and the desktop protocol carrier.
   * @param request Owner-authorized request from ctx.connection.fetch.
   * @returns Safe JSON or durable image bytes.
   */
  async handle(request: Request): Promise<Response> {
    if (this.stopped) return Response.json({ ok: false, error: { code: 'STOPPING' } }, { status: 503 })
    const operation = this.handleRequest(request)
    this.foreground.add(operation)
    try { return await operation } finally { this.foreground.delete(operation) }
  }

  private async handleRequest(request: Request): Promise<Response> {
    const signal = AbortSignal.any([request.signal, this.lifetime.signal])
    try {
      const url = new URL(request.url)
      if (url.pathname.endsWith('/media')) {
        const task = await this.images.getTaskForOwnerUI(identifier.parse(url.searchParams.get('task')))
        const sessionId = url.searchParams.get('session')
        if (sessionId !== null && (task.owner.kind !== 'session' || task.owner.sessionId !== identifier.parse(sessionId))) throw new ManagementError('IMAGE_NOT_FOUND')
        const asset = task.assets.find(item => item.id === url.searchParams.get('asset'))
        if (!asset) throw new ManagementError('IMAGE_NOT_FOUND')
        const original = url.searchParams.get('original') === '1'
        const image = original ? await this.images.readAssetForOwnerUI(task.id, asset.id, signal)
          : await this.ctx.attachments.readImage(asset.preview, signal)
        return new Response(request.method === 'HEAD' ? null : new Uint8Array(image.data), { headers: {
          'content-type': original ? asset.mimeType : asset.preview.mediaType, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
          'content-disposition': `${original && url.searchParams.get('view') !== '1' ? 'attachment' : 'inline'}; filename="codex-${asset.id}.${asset.mimeType === 'image/jpeg' ? 'jpg' : asset.mimeType.slice(6)}"`,
        } })
      }
      const reader = request.body?.getReader(), chunks: Uint8Array[] = []
      let bytes = 0
      try {
        if (reader) for (;;) {
          signal.throwIfAborted()
          const next = await reader.read()
          if (next.done) break
          bytes += next.value.byteLength
          if (bytes > this.options.relay.maxRequestBytes) { await reader.cancel(); throw new ManagementError('REQUEST_TOO_LARGE') }
          chunks.push(next.value)
        }
      } finally { reader?.releaseLock() }
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const value = await this.action(input, signal)
      return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
    } catch (error) {
      const code = safeCode(error)
      return Response.json({ ok: false, error: { code } }, { status: code === 'IMAGE_NOT_FOUND' ? 404 : 400, headers: { 'cache-control': 'no-store' } })
    }
  }

  /** Stop admission, listeners and work before releasing the durable task writer. */
  dispose(): Promise<void> {
    return this.disposal ??= this.stop()
  }

  private async stop(): Promise<void> {
    this.stopped = true
    this.lifetime.abort()
    const accountResults = Promise.allSettled([this.accounts.dispose(), this.upstream.dispose()])
    await Promise.allSettled([this.initialization, this.updates, this.controls])
    const results = await Promise.allSettled([this.relay?.close(), this.transport.dispose(), this.images?.dispose()])
    await Promise.allSettled(this.foreground)
    const repositoryResult = await Promise.allSettled([this.repository?.close(), this.versions.dispose()])
    const failures = [...results, ...await accountResults, ...repositoryResult].filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason), 'Codex subscription shutdown did not release every resource')
  }
}

/** Keep upstream messages, OAuth URLs and token-bearing error objects out of wire responses.
 * @param error Rejected Host operation.
 * @returns Stable error code only.
 */
export function safeCode(error: unknown): string {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 'INVALID_INPUT'
  if (error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,80}$/.test(error.code)) return error.code
  return 'OPERATION_FAILED'
}
