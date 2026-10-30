/** Account pool, authorization flow and shared native OAuth resolver. */
import { createHash, randomUUID } from 'node:crypto'
import { createModels, type CredentialStore, type Provider, type AuthContext, type StreamOptions, type Model, type Api } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { AccountError, AccountRejected, accountErrorCause, credentialTag, readCredential, readGrant, type StoredAccount, type AccountsGrant } from './record.ts'
import { accountRefusal, failureDetails } from './failures.ts'
import { parseAccountUsage, quotaBlocks, resetCreditExpiry } from './quota.ts'
import { createOAuthAttempt, exchangeTokens, tokenMetadata, type OAuthAttempt } from './oauth.ts'
import type { AccountsFacade, AccountsOptions, AccountView, LoginView, AccountLease, AccountRequest, AccountOperation, CodexModelView, CodexModelRouteView, AccountUsage, AccountReadOptions } from './types.ts'
import { buildModelRoutes, selectModelRoute, type CodexModelRoute } from './routes.ts'
import { readBoundedJson } from './json.ts'
import { adaptCodexBody, codexSessionHeaders, codexUserAgent } from '../codex-request.ts'
import { observeCodexQuota } from '../codex-quota.ts'
import { ZodError } from 'zod'
import { resolveCodexModels, resolveModelSettings, type CodexModelSnapshot, type ModelSettings } from '../models.ts'
export { AccountError } from './record.ts'
export type * from './types.ts'

/** Stable owner record shared by authorization and all credential mutations. */
export const ACCOUNTS_KEY = credentialKey('codex-subscription', 'accounts')
const NATIVE_PROVIDER = 'openai-codex'
const operations: readonly AccountOperation[] = ['text', 'image', 'models', 'usage']

interface LoginState { view: LoginView; attempt?: OAuthAttempt; abort: AbortController; settled: Promise<void> }
interface NativeAccount { provider: Provider<'openai-codex-responses'>; credentials: CredentialStore; authContext: AuthContext; models: ReturnType<typeof createModels>
  providerWithRefusal(onRefusal: (failure: AccountRejected) => void): Provider<'openai-codex-responses'> }
interface ModelCache { at: number; lastGoodAt?: number; status: 'ready' | 'error'; models: readonly CodexModelView[]; snapshot: CodexModelSnapshot; version: string; settingsRevision: number }

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel: () => void = () => {}
  const raced = new Promise<T>((resolve, reject) => {
    cancel = () => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    promise.then(resolve, reject)
  })
  return raced.finally(() => signal.removeEventListener('abort', cancel))
}

/** Owns accounts and tokens; Remote callers receive only detached safe projections. */
export class CodexAccounts implements AccountsFacade {
  private readonly clock: () => number
  private readonly native = new Map<string, NativeAccount>()
  private readonly inflight = new Map<string, number>()
  private readonly affinity = new Map<string, string>()
  private readonly cooldowns = new Map<string, Partial<Record<AccountOperation, number>>>()
  private readonly cooldownStatuses = new Map<string, Partial<Record<AccountOperation, number>>>()
  private readonly refreshing = new Set<string>()
  private readonly modelCache = new Map<string, ModelCache>()
  private readonly modelPending = new Map<string, Promise<void>>()
  private readonly usageCache = new Map<string, AccountUsage>()
  private readonly usagePending = new Map<string, Promise<void>>()
  private readonly accountRefreshes = new Map<string, Promise<AccountView>>()
  private readonly liveUsageRevision = new Map<string, number>()
  private readonly logins = new Map<string, LoginState>()
  private active: LoginState | undefined
  private starting = false
  private unmount: (() => void) | undefined
  private disposed = false
  private readonly lifetime = new AbortController()
  private readonly writes = new Set<Promise<unknown>>()
  private readonly leases = new Set<Promise<unknown>>()
  private disposal: Promise<void> | undefined
  private modelSettings: ModelSettings
  private modelSettingsRevision = 0

  constructor(readonly options: AccountsOptions) { this.clock = options.now ?? Date.now; this.modelSettings = resolveModelSettings(options.modelSettings) }

  /** Change defaults for future directory generations; already prepared calls keep their snapshots.
   * @param input Model deployment settings, before or after parsing.
   */
  updateModelSettings(input: unknown): void {
    const next = resolveModelSettings(input)
    if (JSON.stringify(next) !== JSON.stringify(this.modelSettings)) { this.modelSettings = next; this.modelSettingsRevision++ }
  }

  /** Return a detached, already discovered generation for one account.
   * @param accountKey Selected Host account identifier.
   * @returns Its capability generation; absence fails instead of inventing a static directory.
   */
  modelSnapshot(accountKey: string): CodexModelSnapshot {
    const snapshot = this.modelCache.get(accountKey)?.snapshot
    if (snapshot === undefined) throw new AccountError('账号模型目录尚未就绪。', 'MODEL_DISCOVERY_FAILED')
    return structuredClone(snapshot)
  }

  /** Register the one authorization flow. The caller registers this disposer with ctx.effect. */
  mount(): () => Promise<void> {
    if (this.unmount) throw new AccountError('账号授权已挂载。', 'ALREADY_MOUNTED')
    this.unmount = this.options.authorization.registerFlow({ key: ACCOUNTS_KEY, label: 'ChatGPT / Codex',
      methods: [{ id: 'browser', label: '浏览器登录' }], run: session => this.runLogin(session) })
    return () => this.dispose()
  }

  /** Close callback listeners and withdraw active authorization on plugin disposal. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true; this.active?.abort.abort(new AccountError('登录已取消。', 'CANCELLED'))
    this.lifetime.abort(new AccountError('订阅服务已停止。', 'CANCELLED'))
    this.active?.attempt?.close(); this.options.authorization.cancel(ACCOUNTS_KEY)
    this.unmount?.(); this.unmount = undefined
    const login = this.active?.settled
    this.disposal = (async () => {
      await Promise.allSettled([...this.modelPending.values(), ...this.usagePending.values(), ...this.accountRefreshes.values(), ...this.leases, ...(login ? [login] : [])])
      // 已启动的 refresh 可能已轮换上游 token，必须等待持久化，不能随消费者取消丢弃。
      while (this.writes.size) await Promise.allSettled([...this.writes])
      this.affinity.clear(); this.native.clear(); this.modelCache.clear(); this.usageCache.clear(); this.liveUsageRevision.clear(); this.logins.clear()
      this.cooldowns.clear(); this.cooldownStatuses.clear(); this.refreshing.clear(); this.inflight.clear()
    })()
    return this.disposal
  }

  private async grant(): Promise<AccountsGrant> {
    const grant = readGrant(await this.options.credentials.readRecord(ACCOUNTS_KEY))
    for (const account of Object.values(grant.accounts)) if (!this.usageCache.has(account.accountKey) && account.lastUsage !== undefined) this.usageCache.set(account.accountKey, structuredClone(account.lastUsage))
    return grant
  }

  private async mutate(change: (grant: AccountsGrant) => Promise<boolean>): Promise<AccountsGrant> {
    const writing = this.options.credentials.modifyRecord(ACCOUNTS_KEY, async current => {
      const grant = readGrant(current)
      if (!await change(grant)) return undefined
      return { kind: 'grant', payload: { ...grant, revision: grant.revision + 1 } }
    })
    this.writes.add(writing)
    try { return readGrant(await writing) } finally { this.writes.delete(writing) }
  }

  private view(account: StoredAccount): AccountView {
    const catalog = this.modelCache.get(account.accountKey), usage = this.usageCache.get(account.accountKey)
    let metadata: Partial<ReturnType<typeof tokenMetadata>> = {}
    try { metadata = tokenMetadata(account.credential.access, account.credential.idToken, this.clock()) }
    catch (_error) { /* 旧凭据损坏仍须可查询、删除或重新授权；不伪造身份。 */ }
    account = { ...metadata, ...account }
    const failure = this.authFailure(account), livePlan = usage?.plan
    return { accountKey: account.accountKey, accountId: account.accountId, label: account.label,
      ...(account.email === undefined ? {} : { email: account.email }), ...(account.userId === undefined ? {} : { userId: account.userId }),
      identityStatus: account.userId !== undefined || account.email !== undefined ? 'identified' : 'legacy',
      ...(account.plan === undefined ? {} : { claimPlan: account.plan }), ...((livePlan ?? account.plan) === undefined ? {} : { plan: livePlan ?? account.plan }),
      planSource: livePlan !== undefined ? 'usage' : account.plan !== undefined ? 'token' : 'unknown',
      ...(livePlan !== undefined ? { planUpdatedAt: usage!.lastSuccessfulAt ?? usage!.fetchedAt } : account.plan === undefined ? {} : { planUpdatedAt: account.metadataAt ?? account.createdAt }),
      ...(account.workspace === undefined ? {} : { workspace: account.workspace }), enabled: account.enabled, allowCredits: account.allowCredits, priority: account.priority,
      revision: account.revision, createdAt: account.createdAt, updatedAt: account.updatedAt, metadataAt: account.metadataAt ?? account.createdAt,
      expiresAt: account.credential.expires, tokenExpiresAt: account.credential.expires, cooldowns: { ...this.cooldowns.get(account.accountKey) },
      ...(account.subscriptionUntil !== undefined && account.subscriptionUntil > this.clock() ? { subscriptionUntil: account.subscriptionUntil } : {}),
      ...(account.lastRefreshAt === undefined ? {} : { lastRefreshAt: account.lastRefreshAt }),
      auth: this.refreshing.has(account.accountKey) ? { state: 'refreshing' } : failure !== undefined ? { state: 'needs-login', errorCode: failure.code, changedAt: failure.at }
        : { state: account.credential.expires <= this.clock() ? 'refresh-required' : 'ready' },
      modelsStatus: catalog?.status ?? 'unfetched', ...(catalog?.lastGoodAt === undefined ? {} : { modelsFetchedAt: catalog.lastGoodAt }),
      ...(usage === undefined ? {} : { usage: structuredClone({ ...usage, freshness: usage.lastSuccessfulAt === undefined ? 'unknown'
        : usage.status === 'error' || this.clock() - usage.lastSuccessfulAt >= this.options.discoveryTtlMs ? 'stale' : 'fresh' }) }) }
  }

  private authFailure(account: StoredAccount): StoredAccount['authFailure'] {
    return account.authFailure?.credentialTag === credentialTag(account.credential) ? account.authFailure : undefined
  }

  /** List safe metadata, refreshing quota status with last-good values retained on failure. */
  async list(): Promise<readonly AccountView[]> {
    this.lifetime.signal.throwIfAborted()
    const before = await this.grant()
    await Promise.all(Object.values(before.accounts).filter(account => account.enabled).map(account => this.refreshUsage(account.accountKey)))
    this.lifetime.signal.throwIfAborted()
    return Object.values((await this.grant()).accounts).map(account => this.view(account))
  }

  /** Read one credential-free account projection; fresh explicitly bypasses discovery TTL.
   * @param accountKey Stable account identifier, including legacy keys.
   * @param options Local read or caller-cancellable refresh.
   * @returns Account identity, auth state, controls, cooldowns and last-good quota.
   */
  async getAccountStatus(accountKey: string, options: AccountReadOptions = {}): Promise<AccountView> {
    this.lifetime.signal.throwIfAborted(); options.signal?.throwIfAborted()
    if (options.fresh === true) return this.refreshAccount(accountKey, options.signal)
    const account = (await this.grant()).accounts[accountKey]
    if (account === undefined) throw new AccountError('账号不存在。', 'ACCOUNT_NOT_FOUND')
    return this.view(account)
  }

  /** Read the same quota projection as account-status and snapshot.
   * @param accountKey Stable account identifier.
   * @param options Local read or explicit refresh.
   * @returns Detached quota, or undefined before the first observation.
   */
  async getAccountQuota(accountKey: string, options: AccountReadOptions = {}): Promise<AccountUsage | undefined> {
    return (await this.getAccountStatus(accountKey, options)).usage
  }

  /** Refresh usage and models once for concurrent callers; known invalid authorization remains queryable.
   * @param accountKey Stable account identifier.
   * @param signal Cancels this waiter without discarding an already rotated refresh token.
   * @returns Latest safe account state, with failure/freshness markers when polling fails.
   */
  async refreshAccount(accountKey: string, signal?: AbortSignal): Promise<AccountView> {
    const combined = AbortSignal.any([this.lifetime.signal, ...(signal === undefined ? [] : [signal])]); combined.throwIfAborted()
    let pending = this.accountRefreshes.get(accountKey)
    if (pending === undefined) {
      pending = (async () => {
        const account = (await this.grant()).accounts[accountKey]
        if (account === undefined) throw new AccountError('账号不存在。', 'ACCOUNT_NOT_FOUND')
        if (account.enabled && this.authFailure(account) === undefined) await Promise.all([this.refreshUsage(accountKey, true), this.refreshModels(accountKey, true)])
        return this.getAccountStatus(accountKey)
      })().finally(() => { this.accountRefreshes.delete(accountKey) })
      this.accountRefreshes.set(accountKey, pending)
    }
    return raceAbort(pending, combined)
  }

  /** Start browser OAuth; returns before the user finishes authentication. */
  async beginLogin(): Promise<LoginView> {
    if (this.disposed || !this.unmount) throw new AccountError('账号授权服务未运行。', 'NOT_MOUNTED')
    if (this.starting || this.active) throw new AccountError('已有登录正在进行。', 'LOGIN_BUSY')
    this.starting = true
    try {
      const attempt = await createOAuthAttempt(this.options)
      if (this.disposed) { attempt.close(); throw new AccountError('账号服务已停止。', 'CANCELLED') }
      const loginId = randomUUID(), abort = new AbortController()
      const view: LoginView = { loginId, state: 'waiting', authorizationUrl: attempt.authorizationUrl, redirectUri: attempt.redirectUri, expiresAt: this.clock() + this.options.loginTimeoutMs }
      const state: LoginState = { view, attempt, abort, settled: Promise.resolve() }
      this.active = state; this.logins.set(loginId, state)
      // 历史只保留有限的安全进度，已结束流程不再保留 verifier/code。
      for (const [key, login] of this.logins) { if (this.logins.size <= 20) break; if (login !== this.active) this.logins.delete(key) }
      state.settled = this.options.authorization.begin({ key: ACCOUNTS_KEY, method: 'browser', signal: abort.signal,
        interaction: { notify() {}, prompt: async () => { throw new AccountError('请通过授权管理接口提交完整回调地址。', 'PASTE_REQUIRED') } },
      }).then(outcome => { state.view.state = outcome.status; attempt.finish(outcome.status === 'authorized') }, error => {
        state.view.state = abort.signal.aborted ? 'cancelled' : 'failed'
        state.view.error = error instanceof AccountError ? error.message : '登录失败，请重试。'
        attempt.finish(false)
      }).finally(() => { attempt.close(); delete state.attempt; if (this.active === state) this.active = undefined })
      return { ...view }
    } finally { this.starting = false }
  }

  /** Read detached progress for one known login. */
  loginStatus(loginId: string): LoginView {
    const login = this.logins.get(loginId)
    if (!login) throw new AccountError('登录流程不存在或已过期。', 'LOGIN_NOT_FOUND')
    return { ...login.view }
  }

  /** Deliver a manually pasted redirect URL through the same PKCE/state path as the callback. */
  async completeLogin(loginId: string, callbackUrl: string): Promise<LoginView> {
    const login = this.logins.get(loginId)
    if (!login || login !== this.active) throw new AccountError('登录流程不存在或已结束。', 'LOGIN_NOT_FOUND')
    if (!login.attempt) throw new AccountError('登录流程已结束。', 'LOGIN_NOT_FOUND')
    login.attempt.accept(callbackUrl)
    await login.settled
    return this.loginStatus(loginId)
  }

  /** Cancel and drain one login, including its owned callback listener. */
  async cancelLogin(loginId: string): Promise<void> {
    const login = this.logins.get(loginId)
    if (!login) throw new AccountError('登录流程不存在。', 'LOGIN_NOT_FOUND')
    if (login === this.active) { login.abort.abort(new AccountError('登录已取消。', 'CANCELLED')); this.options.authorization.cancel(ACCOUNTS_KEY); await login.settled }
  }

  private async runLogin(session: AuthorizationSession): Promise<void> {
    const state = this.active
    if (!state?.attempt) throw new AccountError('请先通过授权管理接口发起登录。', 'LOGIN_NOT_FOUND')
    const timeout = AbortSignal.timeout(this.options.loginTimeoutMs), signal = AbortSignal.any([session.signal, state.abort.signal, timeout])
    session.notify({ message: '请在浏览器中登录 ChatGPT；也可以粘贴回调地址。', url: state.view.authorizationUrl })
    const code = await raceAbort(state.attempt.code, signal)
    signal.throwIfAborted(); state.view.state = 'exchanging'
    const tokens = await exchangeTokens(this.options, { grant_type: 'authorization_code', code, code_verifier: state.attempt.verifier, redirect_uri: state.attempt.redirectUri },
      AbortSignal.any([signal, AbortSignal.timeout(this.options.tokenTimeoutMs)]))
    signal.throwIfAborted()
    await this.mutate(async grant => {
      signal.throwIfAborted()
      const identity = tokens.userId ?? tokens.email?.trim().toLowerCase()
      if (!identity) throw new AccountError('登录信息缺少用户身份，无法安全区分工作区成员。', 'LOGIN_IDENTITY_REQUIRED')
      // 已有键被任务和重放引用；只在能确认同一用户时替换凭据，不按工作区单独覆盖。
      const existing = Object.values(grant.accounts).find(account => {
        if (account.accountId !== tokens.accountId) return false
        let metadata: ReturnType<typeof tokenMetadata>
        try { metadata = tokenMetadata(account.credential.access, account.credential.idToken, this.clock()) }
        catch (_error) { return false /* 无法辨认的旧凭据保留，不能据工作区推断其所有者。 */ }
        const userId = account.userId ?? metadata.userId
        if (tokens.userId !== undefined && userId !== undefined) return userId === tokens.userId
        const email = account.email ?? metadata.email
        return tokens.email !== undefined && email !== undefined && tokens.email.trim().toLowerCase() === email.trim().toLowerCase()
      })
      const accountKey = existing?.accountKey ?? `acct-${createHash('sha256').update(JSON.stringify([tokens.accountId, identity])).digest('hex').slice(0, 24)}`
      const previous = grant.accounts[accountKey], now = this.clock()
      grant.accounts[accountKey] = { accountKey, accountId: tokens.accountId, label: previous?.label ?? tokens.email ?? tokens.accountId,
        enabled: previous?.enabled ?? true, allowCredits: previous?.allowCredits ?? true, priority: previous?.priority ?? 0, revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now, metadataAt: now,
        ...(tokens.email === undefined ? {} : { email: tokens.email }), ...(tokens.plan === undefined ? {} : { plan: tokens.plan }),
        ...(tokens.workspace === undefined ? {} : { workspace: tokens.workspace }), ...(tokens.userId === undefined ? {} : { userId: tokens.userId }),
        ...(tokens.subscriptionUntil === undefined ? {} : { subscriptionUntil: tokens.subscriptionUntil }),
        ...(previous?.lastUsage === undefined ? {} : { lastUsage: previous.lastUsage }), lastRefreshAt: now, credential: readCredential(tokens) }
      this.cooldowns.delete(accountKey); this.cooldownStatuses.delete(accountKey); this.modelCache.delete(accountKey); this.usageCache.delete(accountKey)
      return true
    })
  }

  /** Change account controls using compare-and-swap semantics. */
  async update(accountKey: string, patch: { label?: string; enabled?: boolean; allowCredits?: boolean; priority?: number; revision: number }): Promise<AccountView> {
    this.lifetime.signal.throwIfAborted()
    const label = patch.label?.trim()
    if (label !== undefined && (!label || label.length > 200)) throw new AccountError('账号名称需为 1–200 个字符。', 'INVALID_LABEL')
    if (patch.priority !== undefined && (!Number.isInteger(patch.priority) || Math.abs(patch.priority) > 1000)) throw new AccountError('账号优先级需为 -1000 至 1000 的整数。', 'INVALID_PRIORITY')
    const grant = await this.mutate(async grant => {
      const account = grant.accounts[accountKey]
      if (!account) throw new AccountError('账号不存在。', 'ACCOUNT_NOT_FOUND')
      if (account.revision !== patch.revision) throw new AccountError('账号已更新，请刷新后重试。', 'REVISION_CONFLICT', 409)
      grant.accounts[accountKey] = { ...account, ...(label === undefined ? {} : { label }), ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        ...(patch.allowCredits === undefined ? {} : { allowCredits: patch.allowCredits }), ...(patch.priority === undefined ? {} : { priority: patch.priority }), revision: account.revision + 1, updatedAt: this.clock() }
      return true
    })
    return this.view(grant.accounts[accountKey]!)
  }

  /** Remove one account without deleting the shared authorization record. */
  async remove(accountKey: string, revision: number): Promise<void> {
    this.lifetime.signal.throwIfAborted()
    await this.mutate(async grant => {
      const account = grant.accounts[accountKey]
      if (!account) throw new AccountError('账号不存在。', 'ACCOUNT_NOT_FOUND')
      if (account.revision !== revision) throw new AccountError('账号已更新，请刷新后重试。', 'REVISION_CONFLICT', 409)
      delete grant.accounts[accountKey]; return true
    })
    this.native.delete(accountKey); this.modelCache.delete(accountKey); this.usageCache.delete(accountKey); this.cooldowns.delete(accountKey); this.cooldownStatuses.delete(accountKey); this.liveUsageRevision.delete(accountKey)
    for (const [key, value] of this.affinity) if (value === accountKey) this.affinity.delete(key)
  }

  /** Native Provider and credential bridge, pinned by account rather than ambient route state. */
  nativeFor(accountKey: string): NativeAccount {
    const cached = this.native.get(accountKey)
    if (cached) return cached
    const read = async () => {
      const account = (await this.grant()).accounts[accountKey]
      if (account !== undefined && this.authFailure(account) !== undefined) throw new AccountError('账号授权已失效，请重新登录。', 'ACCOUNT_RELOGIN_REQUIRED', 401)
      return account?.credential
    }
    const credentials: CredentialStore = {
      read: async provider => { if (provider !== NATIVE_PROVIDER) return undefined; return read() },
      list: async () => await read() === undefined ? [] : [{ providerId: NATIVE_PROVIDER, type: 'oauth' }],
      modify: async (provider, fn, options) => {
        if (provider !== NATIVE_PROVIDER) throw new AccountError('无效的凭据提供方。', 'INVALID_PROVIDER')
        let rejectedRefresh: AccountError | undefined
        const grant = await this.mutate(async grant => {
          options?.signal?.throwIfAborted()
          const current = grant.accounts[accountKey]
          if (!current || !current.enabled) throw new AccountError('账号已删除或停用。', 'ACCOUNT_UNAVAILABLE')
          let result: Awaited<ReturnType<typeof fn>>
          try { result = await fn(current.credential) }
          catch (error) {
            const failure = accountErrorCause(error)
            if (failure?.details.authCode === undefined) throw error
            grant.accounts[accountKey] = { ...current, authFailure: { credentialTag: credentialTag(current.credential), code: failure.details.authCode, at: this.clock() }, revision: current.revision + 1, updatedAt: this.clock() }
            rejectedRefresh = failure
            return true
          }
          if (result === undefined) return false
          if (result.type !== 'oauth') throw new AccountError('订阅账号需要 OAuth 凭据。', 'INVALID_TOKEN')
          const credential = readCredential(result)
          if (credential.accountId !== current.accountId) throw new AccountError('刷新后账号发生变化。', 'ACCOUNT_CHANGED')
          const metadata = tokenMetadata(credential.access, credential.idToken, this.clock())
          const { authFailure: _oldFailure, ...kept } = current
          grant.accounts[accountKey] = { ...kept, credential, ...metadata, revision: current.revision + 1, updatedAt: this.clock(), lastRefreshAt: this.clock(),
            metadataAt: credential.idToken !== current.credential.idToken ? this.clock() : current.metadataAt ?? current.createdAt }
          return true
        })
        if (rejectedRefresh !== undefined) throw rejectedRefresh
        return grant.accounts[accountKey]?.credential
      },
      delete: async () => { throw new AccountError('请使用账号移除操作。', 'USE_ACCOUNT_REMOVE') },
    }
    const native = openaiCodexProvider(), oauth = native.auth.oauth
    if (!oauth) throw new AccountError('安装的 Codex provider 不支持 OAuth。', 'INVALID_PROVIDER')
    const requestOptions = <T extends StreamOptions>(options: T | undefined, onRefusal?: (failure: AccountRejected) => void) => {
      let cacheIdentity: string | undefined
      const headers = new Headers()
      for (const [key, value] of Object.entries(options?.headers ?? {})) if (value !== null) headers.set(key, value)
      headers.set('originator', 'codex_cli_rs'); headers.set('version', this.options.clientVersion)
      headers.set('User-Agent', codexUserAgent(this.options.clientVersion))
      codexSessionHeaders(headers, options?.cacheRetention === 'none' ? undefined : options?.sessionId)
      return Object.assign({}, options, { fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const outgoing = new Headers(init?.headers)
        codexSessionHeaders(outgoing, cacheIdentity)
        const response = this.observeResponse(accountKey, await this.options.fetch(input, { ...init, headers: outgoing }), outgoing.get('authorization')?.replace(/^Bearer /i, ''))
        // pi-ai 会把 429 改写成无状态码的说明；在其 JSON 解码前保留可分类的安全错误。
        if ([401, 402, 403, 429].includes(response.status)) {
          const failure = await accountRefusal(response, this.clock(), init?.signal ?? new AbortController().signal)
          await this.noteFailure(accountKey, 'text', failure, outgoing.get('authorization')?.replace(/^Bearer /i, ''))
          onRefusal?.(failure)
          throw failure
        }
        return response
      }, transport: 'sse' as const, maxRetries: 0, headers: Object.fromEntries(headers),
        onPayload: async (payload: unknown, model: Model<Api>) => {
          const body = adaptCodexBody(await options?.onPayload?.(payload, model) ?? payload)
          cacheIdentity = typeof body.prompt_cache_key === 'string' ? body.prompt_cache_key : undefined
          return body
        } })
    }
    const providerWithRefusal = (onRefusal?: (failure: AccountRejected) => void): Provider<'openai-codex-responses'> => ({ ...native, auth: { ...native.auth, oauth: { ...oauth,
      // 已处于 CredentialStore.modify 锁内；这里仅兑换令牌，不重入持久锁。
      refresh: async (credential, signal) => {
        this.refreshing.add(accountKey)
        try { return await exchangeTokens(this.options, { grant_type: 'refresh_token', refresh_token: credential.refresh }, AbortSignal.any([signal, AbortSignal.timeout(this.options.tokenTimeoutMs)]),
          { ...readCredential(credential), type: 'oauth' }) }
        finally { this.refreshing.delete(accountKey) }
      },
    } }, stream: (model, context, options) => native.stream(model, context, requestOptions(options, onRefusal)),
    streamSimple: (model, context, options) => native.streamSimple(model, context, requestOptions(options, onRefusal)) })
    const provider = providerWithRefusal()
    const authContext: AuthContext = { env: async () => undefined, fileExists: async () => false }
    const models = createModels({ credentials, authContext }); models.setProvider(provider)
    const result = { provider, credentials, authContext, models, providerWithRefusal }; this.native.set(accountKey, result); return result
  }

  /** Hold account capacity through completion; only an explicit pre-output AccountRejected permits a bounded account switch. */
  async withAccount<T>(request: AccountRequest, operation: (lease: AccountLease) => Promise<T>): Promise<T> {
    return this.withCandidates(request, undefined, operation)
  }

  /** Adapter-only generation freeze: new accounts cannot enter an already prepared request. */
  async withCandidates<T>(request: AccountRequest, allowed: ReadonlySet<string> | undefined, operation: (lease: AccountLease) => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([this.lifetime.signal, ...(request.signal ? [request.signal] : [])])
    const task = this.runCandidates({ ...request, signal }, allowed, operation)
    this.leases.add(task)
    try { return await task } finally { this.leases.delete(task) }
  }

  private async runCandidates<T>(request: AccountRequest & { signal: AbortSignal }, allowed: ReadonlySet<string> | undefined, operation: (lease: AccountLease) => Promise<T>, wireModel?: string): Promise<T> {
    request.signal?.throwIfAborted()
    if (request.kind === 'text' && request.model !== undefined && allowed === undefined) {
      const route = selectModelRoute(await this.discoverRoutes(), request.model, request.reasoningEffort, request.serviceTier)
      allowed = new Set(route?.view.accountKeys ?? [])
      wireModel = route?.view.baseModelId
    }
    if (request.kind === 'text') {
      // 调度不能依赖账号页面被打开；额度查询失败仅使额度未知，不撤销模型权限。
      const candidates = Object.values((await this.grant()).accounts).filter(account => account.enabled
        && (allowed === undefined || allowed.has(account.accountKey)) && (request.accountKey === undefined || request.accountKey === account.accountKey))
      await raceAbort(Promise.all(candidates.map(account => this.refreshUsage(account.accountKey))), request.signal)
    }
    request.signal.throwIfAborted()
    const grant = await this.grant(), now = this.clock()
    if (request.accountKey !== undefined) {
      const pinned = grant.accounts[request.accountKey]
      if (pinned !== undefined && this.authFailure(pinned) !== undefined) throw new AccountError('账号授权已失效，请重新登录。', 'ACCOUNT_RELOGIN_REQUIRED', 401)
    }
    const eligible = Object.values(grant.accounts).filter(account => account.enabled && (allowed === undefined || allowed.has(account.accountKey))
      && this.authFailure(account) === undefined
      && (request.accountKey === undefined || request.accountKey === account.accountKey)
      // 图片接口未提供可验证的“仅用订阅”选项；禁止积分的账号不派发生图，不能拿文字额度代替图片额度。
      && (request.kind !== 'image' || account.allowCredits)
      && (this.cooldowns.get(account.accountKey)?.[request.kind] ?? 0) <= now
      && !(request.kind === 'text' && quotaBlocks(this.usageCache.get(account.accountKey), account.allowCredits, now)))
    const affinityKey = request.sessionId === undefined ? undefined : `${request.kind}:${request.model ?? ''}:${request.sessionId}`
    const sticky = affinityKey === undefined ? undefined : this.affinity.get(affinityKey)
    eligible.sort((a, b) => (b.priority - a.priority) || ((this.inflight.get(a.accountKey) ?? 0) - (this.inflight.get(b.accountKey) ?? 0))
      || ((this.usageCache.get(a.accountKey)?.primary?.usedPercent ?? 0) - (this.usageCache.get(b.accountKey)?.primary?.usedPercent ?? 0)))
    const account = eligible.find(account => account.accountKey === sticky) ?? eligible[0]
    if (!account) {
      const imageAccounts = request.kind === 'image' ? Object.values(grant.accounts).filter(account => account.enabled && this.authFailure(account) === undefined
        && (allowed === undefined || allowed.has(account.accountKey)) && (request.accountKey === undefined || request.accountKey === account.accountKey)) : []
      if (imageAccounts.length > 0 && imageAccounts.every(account => !account.allowCredits)) {
        throw new AccountError('图片接口无法保证仅消耗订阅额度。请为用于生图的账号开启允许额外积分，或使用其他图片提供商。', 'IMAGE_CREDITS_DISABLED')
      }
      const waiting = Object.values(grant.accounts).filter(account => account.enabled && this.authFailure(account) === undefined
        && (allowed === undefined || allowed.has(account.accountKey)) && (request.accountKey === undefined || request.accountKey === account.accountKey)
        && (this.cooldowns.get(account.accountKey)?.[request.kind] ?? 0) > now)
        .map(account => ({ at: this.cooldowns.get(account.accountKey)![request.kind]!, status: this.cooldownStatuses.get(account.accountKey)?.[request.kind] ?? 429 }))
        .sort((a, b) => a.at - b.at)[0]
      throw new AccountError('没有可用的订阅账号，请登录、启用账号或等待额度恢复。', 'NO_AVAILABLE_ACCOUNT', waiting?.status,
        waiting === undefined ? {} : { retryAt: waiting.at })
    }
    if (affinityKey !== undefined) {
      this.affinity.delete(affinityKey); this.affinity.set(affinityKey, account.accountKey)
      while (this.affinity.size > this.options.sessionAffinityLimit) { const oldest = this.affinity.keys().next().value; if (oldest !== undefined) this.affinity.delete(oldest) }
    }
    this.inflight.set(account.accountKey, (this.inflight.get(account.accountKey) ?? 0) + 1)
    let rejected: AccountRejected | undefined
    let usedAccess: string | undefined
    try {
      const resolved = await this.nativeFor(account.accountKey).models.getAuth(NATIVE_PROVIDER, request.signal === undefined ? {} : { signal: request.signal })
      const accessToken = resolved?.auth.apiKey
      if (!accessToken) throw new AccountError('订阅账号没有有效认证信息，请重新登录。', 'MISSING_CREDENTIAL')
      usedAccess = accessToken
      const metadata = tokenMetadata(accessToken)
      if (metadata.accountId !== account.accountId) throw new AccountError('请求认证与选中账号不一致。', 'ACCOUNT_CHANGED')
      request.signal?.throwIfAborted()
      return await raceAbort(operation({ accountKey: account.accountKey, accountId: account.accountId, accessToken, signal: request.signal,
        ...(wireModel === undefined ? {} : { model: wireModel }),
        headers: { Authorization: `Bearer ${accessToken}`, 'chatgpt-account-id': account.accountId },
        observeResponse: response => this.observeResponse(account.accountKey, response, accessToken) }), request.signal)
    } catch (error) {
      // 凭据刷新发生在发送业务请求之前；终止型刷新拒绝也可转到另一个已捕获账号。
      const cause = accountErrorCause(error)
      if (usedAccess === undefined && cause?.details.authCode !== undefined && request.accountKey === undefined) error = new AccountRejected(401, cause.details)
      if (error instanceof Error && 'status' in error && typeof error.status === 'number' && [401, 402, 403, 429].includes(error.status)) {
        const renewed = error.status === 401 && usedAccess !== undefined && await this.renewRejectedCredential(account.accountKey, usedAccess)
        if (!renewed) await this.noteFailure(account.accountKey, request.kind, error instanceof AccountError ? error : new AccountError('账号请求被拒绝。', 'ACCOUNT_REJECTED', error.status), usedAccess)
        else this.clearAuthCooldowns(account.accountKey)
      }
      if (error instanceof AccountRejected && request.accountKey === undefined) rejected = error
      else throw error
    } finally { this.inflight.set(account.accountKey, Math.max(0, (this.inflight.get(account.accountKey) ?? 1) - 1)) }
    const remaining = new Set(eligible.filter(candidate => candidate.accountKey !== account.accountKey).map(candidate => candidate.accountKey))
    if (remaining.size === 0) throw rejected
    return this.runCandidates(request, remaining, operation, wireModel)
  }

  private clearAuthCooldowns(accountKey: string): void {
    const cooldown = this.cooldowns.get(accountKey), statuses = this.cooldownStatuses.get(accountKey)
    for (const kind of operations) if (statuses?.[kind] === 401) { delete cooldown?.[kind]; delete statuses[kind] }
  }

  private async noteFailure(accountKey: string, kind: AccountOperation, failure: AccountError, usedAccess?: string): Promise<void> {
    const cooldown = { ...this.cooldowns.get(accountKey) }, statuses = { ...this.cooldownStatuses.get(accountKey) }
    const until = Math.max(this.clock() + this.options.cooldownMs, failure.details.retryAt ?? 0)
    for (const operation of failure.status === 401 ? operations : [kind]) if (until > (cooldown[operation] ?? 0)
      || until === cooldown[operation] && failure.status !== 401) {
      cooldown[operation] = until; statuses[operation] = failure.status ?? 0
    }
    this.cooldowns.set(accountKey, cooldown); this.cooldownStatuses.set(accountKey, statuses)
    const code = failure.details.authCode
    if (code !== undefined && usedAccess !== undefined) await this.mutate(async grant => {
      const current = grant.accounts[accountKey]
      if (!current || current.credential.access !== usedAccess) return false
      if (this.authFailure(current)?.code === code) return false
      grant.accounts[accountKey] = { ...current, authFailure: { code, credentialTag: credentialTag(current.credential), at: this.clock() }, revision: current.revision + 1, updatedAt: this.clock() }
      return true
    })
  }

  private async renewRejectedCredential(accountKey: string, rejectedAccess: string): Promise<boolean> {
    try {
      const credential = await this.nativeFor(accountKey).credentials.modify(NATIVE_PROVIDER, async current => {
        if (current?.type !== 'oauth' || current.access !== rejectedAccess) return undefined
        // 上游可在 JWT 到期前撤下 access token；锁内比较可避免并发 401 重复轮换。
        return exchangeTokens(this.options, { grant_type: 'refresh_token', refresh_token: current.refresh }, AbortSignal.timeout(this.options.tokenTimeoutMs),
          { ...readCredential(current), type: 'oauth' })
      })
      return credential?.type === 'oauth' && credential.access !== rejectedAccess
    } catch (_error) {
      // 原 401 继续返回调用方并进入冷却；刷新失败不会转成成功或覆盖新授权。
      return false
    }
  }

  private observeResponse(accountKey: string, response: Response, usedAccess?: string): Response {
    return observeCodexQuota(response, this.clock(), windows => {
      const previous = this.usageCache.get(accountKey)
      this.liveUsageRevision.set(accountKey, (this.liveUsageRevision.get(accountKey) ?? 0) + 1)
      const next: AccountUsage = { ...previous, ...windows, status: 'ready', freshness: 'fresh', fetchedAt: this.clock(), lastSuccessfulAt: this.clock(), attemptedAt: this.clock() }
      delete next.errorCode
      if (next.heldReason === 'usage-limit' && [next.primary, next.secondary].every(window => window === undefined || window.usedPercent < 100 || (window.resetAt ?? Infinity) <= this.clock())) {
        next.held = false; delete next.heldReason; delete next.allowed
      }
      this.usageCache.set(accountKey, next)
      if (usedAccess !== undefined) void this.mutate(async grant => {
        const account = grant.accounts[accountKey]
        // 排队落盘时再次比较实时值和凭据，避免旧流或旧账号授权覆盖更新的观察。
        if (this.usageCache.get(accountKey) !== next || account?.credential.access !== usedAccess) return false
        grant.accounts[accountKey] = { ...account, lastUsage: next }; return true
      }).then(grant => {
        if (grant.accounts[accountKey]?.credential.access !== usedAccess && this.usageCache.get(accountKey) === next) this.usageCache.delete(accountKey)
      }, () => {
        if (!this.disposed && this.usageCache.get(accountKey) === next) this.usageCache.set(accountKey, { ...next, status: 'error', freshness: 'stale', errorCode: 'USAGE_STORAGE_FAILED' })
      })
    })
  }

  private endpoint(path: string): string { return `${this.options.baseUrl.replace(/\/$/, '')}/${path}` }

  private async refreshModels(accountKey: string, force = false): Promise<void> {
    const version = await (this.options.resolveClientVersion?.() ?? Promise.resolve(this.options.clientVersion))
    const cached = this.modelCache.get(accountKey)
    if (!force && cached && cached.version === version && cached.settingsRevision === this.modelSettingsRevision && this.clock() - cached.at < this.options.discoveryTtlMs) return
    const pending = this.modelPending.get(accountKey)
    if (pending) { await pending; return this.refreshModels(accountKey, force) }
    const settings = this.modelSettings, settingsRevision = this.modelSettingsRevision
    const task = this.withAccount({ kind: 'models', accountKey }, async lease => {
      const response = await this.options.fetch(`${this.endpoint('codex/models')}?client_version=${encodeURIComponent(version)}`, {
        headers: { ...lease.headers, originator: 'codex_cli_rs', version, 'User-Agent': codexUserAgent(version), 'OpenAI-Beta': 'responses=experimental' }, signal: AbortSignal.any([lease.signal, AbortSignal.timeout(this.options.tokenTimeoutMs)]), redirect: 'error' })
      if (!response.ok) throw new AccountError('模型目录读取失败。', 'MODEL_DISCOVERY_FAILED', response.status, await failureDetails(response, this.clock(), lease.signal))
      const snapshot = resolveCodexModels(await readBoundedJson(response, 1_048_576, lease.signal), this.nativeFor(accountKey).provider.getModels(), settings, this.endpoint('codex'))
      if ((await this.grant()).accounts[accountKey]?.credential.access !== lease.accessToken) return
      this.modelCache.set(accountKey, { status: 'ready', at: this.clock(), lastGoodAt: this.clock(), models: snapshot.views, snapshot, version, settingsRevision })
    }).catch(() => { if (!this.disposed) this.modelCache.set(accountKey, { status: 'error', at: this.clock(), ...(cached?.lastGoodAt === undefined ? {} : { lastGoodAt: cached.lastGoodAt }), models: cached?.models ?? [],
      snapshot: cached?.snapshot ?? { models: [], views: [], defaults: new Map() }, version, settingsRevision }) })
      .finally(() => { this.modelPending.delete(accountKey) })
    this.modelPending.set(accountKey, task); return task
  }

  private async refreshUsage(accountKey: string, force = false): Promise<void> {
    const cached = this.usageCache.get(accountKey)
    if (!force && cached && this.clock() - (cached.attemptedAt ?? cached.fetchedAt) < this.options.discoveryTtlMs) return
    const pending = this.usagePending.get(accountKey)
    if (pending) { await pending; return force ? this.refreshUsage(accountKey, true) : undefined }
    const liveRevision = this.liveUsageRevision.get(accountKey) ?? 0
    const task = this.withAccount({ kind: 'usage', accountKey }, async lease => {
      const response = await this.options.fetch(this.endpoint('wham/usage'), { headers: { ...lease.headers, originator: 'codex_cli_rs', version: this.options.clientVersion, 'User-Agent': codexUserAgent(this.options.clientVersion) }, signal: AbortSignal.any([lease.signal, AbortSignal.timeout(this.options.tokenTimeoutMs)]), redirect: 'error' })
      if (!response.ok) throw new AccountError('额度读取失败。', 'USAGE_FAILED', response.status, await failureDetails(response, this.clock(), lease.signal))
      const value = parseAccountUsage(await readBoundedJson(response, 262_144, lease.signal), this.clock())
      if ((value.resetCredits?.availableCount ?? 0) > 0) {
        try {
          const details = await this.options.fetch(this.endpoint('wham/rate-limit-reset-credits'), { headers: lease.headers,
            signal: AbortSignal.any([lease.signal, AbortSignal.timeout(this.options.tokenTimeoutMs)]), redirect: 'error' })
          if (details.ok) {
            const earliestExpiresAt = resetCreditExpiry(await readBoundedJson(details, 262_144, lease.signal), value.resetCredits!.availableCount, this.clock())
            if (earliestExpiresAt !== undefined) value.resetCredits!.earliestExpiresAt = earliestExpiresAt
          } else await details.body?.cancel()
        } catch (_error) { lease.signal.throwIfAborted() /* 明细是只读补充；失败时保留 usage 已确认的数量。 */ }
      }
      const latest = (this.liveUsageRevision.get(accountKey) ?? 0) !== liveRevision ? this.usageCache.get(accountKey) : undefined
      // 成功但缺字段也不能被当作额度恢复；已知窗口保留到新的同名窗口或已知重置时间。
      const primary = latest?.primary ?? value.primary ?? cached?.primary, secondary = latest?.secondary ?? value.secondary ?? cached?.secondary
      const next: AccountUsage = { ...value, ...(primary === undefined ? {} : { primary }), ...(secondary === undefined ? {} : { secondary }),
        ...(value.allowed === undefined && value.credits === undefined && cached?.allowed === false
          ? { allowed: false, ...(cached.held === undefined ? {} : { held: cached.held }), ...(cached.heldReason === undefined ? {} : { heldReason: cached.heldReason }) } : {}) }
      let accepted = false
      try {
        await this.mutate(async grant => {
          const account = grant.accounts[accountKey]
          if (account?.credential.access !== lease.accessToken) return false
          if ((this.liveUsageRevision.get(accountKey) ?? 0) !== liveRevision) {
            const live = this.usageCache.get(accountKey)
            if (live?.primary !== undefined) next.primary = live.primary
            if (live?.secondary !== undefined) next.secondary = live.secondary
          }
          // 额度属于同一用户和工作区；独立于控制项 revision 保留，避免重启或轮询失败解除禁用积分的保护。
          grant.accounts[accountKey] = { ...account, lastUsage: next }; accepted = true; return true
        })
      } catch (_error) {
        this.usageCache.set(accountKey, { ...next, status: 'error', freshness: 'stale', errorCode: 'USAGE_STORAGE_FAILED' })
        return
      }
      if (accepted) this.usageCache.set(accountKey, next)
    }).catch((error: unknown) => { if (!this.disposed && (this.liveUsageRevision.get(accountKey) ?? 0) === liveRevision) {
      const kept = this.usageCache.get(accountKey) ?? cached
      const failure = accountErrorCause(error)
      const errorStatus = failure?.status !== undefined && failure.status >= 400 && failure.status <= 599 ? failure.status : undefined
      const errorCode = errorStatus !== undefined ? 'USAGE_HTTP_FAILED' : error instanceof ZodError || error instanceof SyntaxError || failure?.code === 'INVALID_RESPONSE' || failure?.code === 'RESPONSE_TOO_LARGE' ? 'USAGE_INVALID_RESPONSE'
        : error instanceof Error && error.name === 'TimeoutError' ? 'USAGE_TIMEOUT' : 'USAGE_POLL_FAILED'
      // 只投影稳定分类和 HTTP 状态；异常消息可能包含请求、令牌或上游正文。
      const { errorStatus: _previousStatus, ...previous } = kept ?? {}
      this.usageCache.set(accountKey, { ...previous, status: 'error', errorCode, ...(errorStatus === undefined ? {} : { errorStatus }),
        freshness: kept?.lastSuccessfulAt === undefined ? 'unknown' : 'stale', fetchedAt: kept?.fetchedAt ?? this.clock(), attemptedAt: this.clock() })
    } })
      .finally(() => { this.usagePending.delete(accountKey) })
    this.usagePending.set(accountKey, task); return task
  }

  private async discoverRoutes(): Promise<readonly CodexModelRoute[]> {
    this.lifetime.signal.throwIfAborted()
    const accounts = Object.values((await this.grant()).accounts).filter(account => account.enabled && this.authFailure(account) === undefined)
    await Promise.all(accounts.map(account => this.refreshModels(account.accountKey)))
    this.lifetime.signal.throwIfAborted()
    const current = await this.grant()
    return buildModelRoutes(accounts.flatMap(account => {
      const latest = current.accounts[account.accountKey], snapshot = this.modelCache.get(account.accountKey)?.snapshot
      return latest?.enabled === true && this.authFailure(latest) === undefined && snapshot !== undefined ? [{ accountKey: account.accountKey, snapshot: structuredClone(snapshot) }] : []
    }))
  }

  /** Fetch coherent capability routes; retain last-good discovery on transient failure. */
  async models(): Promise<readonly CodexModelView[]> {
    return (await this.discoverRoutes()).map(route => { const { baseModelId: _base, capabilityId: _capability, routeKind: _kind, accountKeys: _accounts, ...view } = route.view; return view })
  }

  /** Inspect safe route IDs and their compatible fallback accounts.
   * @returns Complete capability groups without credential values.
   */
  async modelRoutes(): Promise<readonly CodexModelRouteView[]> { return (await this.discoverRoutes()).map(route => route.view) }

  /** Freeze one route's descriptors and candidate accounts before native preparation.
   * @param model Public model ID or capability alias.
   * @returns One detached discovery generation, when the model is available.
   */
  async captureModelRoute(model: string): Promise<CodexModelRoute | undefined> {
    return selectModelRoute(await this.discoverRoutes(), model)
  }

  /** Capture only accounts that can satisfy every advertised capability of the route. */
  async modelAccounts(model: string): Promise<ReadonlySet<string>> {
    return new Set((await this.captureModelRoute(model))?.view.accountKeys ?? [])
  }
}
