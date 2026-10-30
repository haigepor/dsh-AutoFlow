/** Models-page subscription state owns login polling and refreshes both sibling directories after mutations. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SubscriptionFailure, subscriptionAccounts, subscriptionLogin, subscriptionModels, subscriptionCatalog } from './subscription-api.ts'
import type { SubscriptionAccount, SubscriptionAvailability, SubscriptionLogin, SubscriptionModel, SubscriptionOperations, SubscriptionCatalog, SubscriptionCatalogEntry } from './subscription-api.ts'

/** Localized operation feedback survives tab and page navigation through the shell overlay. */
export interface SubscriptionNotice { id: number; code: string; success: boolean }
/** Safe view state; credentials and full OAuth callback URLs never enter this snapshot. */
export interface SubscriptionState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  availability: SubscriptionAvailability
  accounts: readonly SubscriptionAccount[]
  models: readonly SubscriptionModel[]
  login: SubscriptionLogin | null
  busy: string | null
  error: string | null
  notice: SubscriptionNotice | null
  catalog: SubscriptionCatalog | null
  catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  catalogError: string | null
}

/** One Client plugin instance owns the optional Host connection and all polling timers. */
export class SubscriptionController {
  /** Safe account metadata and shared operation feedback for Client consumers. */
  readonly store = createSnapshotStore<SubscriptionState>({ status: 'idle', availability: 'missing', accounts: [], models: [], login: null, busy: null, error: null, notice: null, catalog: null, catalogStatus: 'idle', catalogError: null })
  private operations: SubscriptionOperations | undefined
  private readonly lifetime = new AbortController()
  private readonly tasks = new Set<Promise<unknown>>()
  private loading: Promise<void> | undefined
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private loginEpoch = 0
  private noticeId = 0
  private requested = false

  constructor(private readonly refreshDirectories: () => Promise<void>) {}

  /** Bind only while the generated plugin-manager Remote is available.
   * @param operations Owner-authorized Host callbacks.
   * @returns Disposer for this connection generation.
   */
  connect(operations: SubscriptionOperations): () => void {
    this.operations = operations
    if (this.requested) void this.ensure()
    return () => { if (this.operations === operations) this.operations = undefined }
  }

  /** Load on first visit; sibling settings invalidations refresh only an already opened surface. */
  ensure(): Promise<void> { this.requested = true; return this.track(this.load()) }

  /** Refresh an opened page after credentials or connection topology changes. */
  invalidate(): void { if (this.requested && !this.lifetime.signal.aborted) void this.ensure() }

  /** Dismiss only the currently displayed operation outcome. */
  dismissNotice(): void { this.store.update((state) => { state.notice = null }) }

  private patch(change: (state: SubscriptionState) => void): void { if (!this.lifetime.signal.aborted) this.store.update(change) }
  private announce(code: string, success: boolean): void {
    this.patch((state) => { state.notice = { id: ++this.noticeId, code, success } })
  }
  private code(error: unknown): string { return error instanceof SubscriptionFailure ? error.code : 'UNAVAILABLE' }
  private invoke(operation: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.lifetime.signal.throwIfAborted()
    if (this.operations === undefined) throw new SubscriptionFailure('UNAVAILABLE')
    return this.operations.invoke(operation, args, this.lifetime.signal)
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.tasks.add(promise)
    void promise.then(() => { this.tasks.delete(promise) }, () => { this.tasks.delete(promise) })
    return promise
  }

  private load(): Promise<void> {
    if (this.loading !== undefined) return this.loading
    if (this.lifetime.signal.aborted) return Promise.resolve()
    this.loading = (async () => {
      this.patch((state) => { state.status = 'loading'; state.error = null })
      try {
        const availability = this.operations === undefined ? 'missing' : await this.operations.availability(this.lifetime.signal)
        if (availability !== 'active') { this.patch((state) => { state.availability = availability; state.status = 'ready' }); return }
        const [rawAccounts, rawModels] = await Promise.all([this.invoke('account-list'), this.invoke('model-list')])
        const accounts = subscriptionAccounts(rawAccounts), models = subscriptionModels(rawModels)
        this.patch((state) => { state.availability = availability; state.accounts = accounts; state.models = models; state.status = 'ready'; state.error = null })
      } catch (error) { this.patch((state) => { state.status = 'error'; state.error = this.code(error) }) }
    })().finally(() => { this.loading = undefined })
    return this.loading
  }

  private async reload(): Promise<void> { await this.loading; await this.load() }

  /** Read model choices only when their management dialog is opened.
   * @returns Completion after candidates or a localized failure are available.
   */
  loadCatalog(): Promise<void> {
    return this.track((async () => {
      this.patch(state => { state.catalogStatus = 'loading'; state.catalogError = null })
      try {
        const catalog = subscriptionCatalog(await this.invoke('model-catalog'))
        this.patch(state => { state.catalog = catalog; state.catalogStatus = 'ready' })
      } catch (error) { this.patch(state => { state.catalogStatus = 'error'; state.catalogError = this.code(error) === 'INVALID_INPUT' ? 'CATALOG_UPDATE_REQUIRED' : this.code(error) }) }
    })())
  }

  /** Persist explicit model choices; sign-in never calls this operation or changes defaults.
   * @param entries Complete profile-level text/image choices from the current editor.
   * @param defaultImageModel Explicitly chosen new image default, when requested.
   * @returns Whether saving and refreshing the shared directories completed.
   */
  saveCatalog(entries: readonly SubscriptionCatalogEntry[], defaultImageModel?: string): Promise<boolean> {
    return this.track(this.run('models', async () => {
      const current = this.store.getSnapshot().catalog
      if (current === null) throw new SubscriptionFailure('INVALID_RESPONSE')
      let saved: unknown
      try { saved = await this.invoke('model-catalog-save', { revision: current.revision, entries, ...(defaultImageModel === undefined ? {} : { defaultImageModel }) }) }
      catch (error) { if (this.code(error) === 'REVISION_CONFLICT') await this.loadCatalog(); throw error }
      const catalog = subscriptionCatalog(saved)
      this.patch(state => { state.catalog = catalog; state.catalogStatus = 'ready'; state.catalogError = null })
      await this.refreshDirectories()
    }, 'MODELS_SAVED'))
  }

  /** Activate the already shipped optional bundle after the user's explicit click.
   * @returns Whether activation completed without a refused or concurrent operation.
   */
  activate(): Promise<boolean> {
    return this.track(this.run('activate', async () => {
      if (this.operations === undefined) throw new SubscriptionFailure('UNAVAILABLE')
      const availability = await this.operations.activate(this.lifetime.signal)
      this.patch((state) => { state.availability = availability })
      if (availability === 'active') { await this.reload(); await this.refreshDirectories() }
    }, 'ACTIVATED'))
  }

  /** Begin PKCE and start one nonoverlapping status poller.
   * @returns Validated external login URL, or undefined after a reported refusal.
   */
  startLogin(): Promise<string | undefined> {
    return this.track((async () => {
      if (this.store.getSnapshot().busy !== null) return undefined
      let url: string | undefined
      await this.run('login', async () => {
        const login = subscriptionLogin(await this.invoke('login-start'))
        this.patch((state) => { state.login = login }); url = login.authorizationUrl
        const epoch = ++this.loginEpoch
        this.schedulePoll(epoch)
      })
      return url
    })())
  }

  private schedulePoll(epoch: number): void {
    if (this.lifetime.signal.aborted || epoch !== this.loginEpoch) return
    clearTimeout(this.pollTimer)
    this.pollTimer = setTimeout(() => { this.pollTimer = undefined; void this.track(this.poll(epoch)) }, 1000)
  }

  private async acceptLogin(value: unknown, epoch: number): Promise<void> {
    if (epoch !== this.loginEpoch || this.lifetime.signal.aborted) return
    const login = subscriptionLogin(value)
    this.patch((state) => { state.login = login })
    if (login.state === 'authorized') {
      clearTimeout(this.pollTimer); this.loginEpoch++
      this.patch((state) => { state.login = null })
      try {
        await this.reload(); await this.refreshDirectories()
        if (this.store.getSnapshot().status === 'error') throw new SubscriptionFailure('DIRECTORY_REFRESH_FAILED')
        this.announce('CONNECTED', true)
      } catch (_error) { this.patch((state) => { state.error = 'DIRECTORY_REFRESH_FAILED' }); this.announce('DIRECTORY_REFRESH_FAILED', false) }
    } else if (login.state === 'failed' || login.state === 'cancelled') {
      clearTimeout(this.pollTimer); this.loginEpoch++
      if (login.state === 'failed') this.announce('LOGIN_FAILED', false)
    } else this.schedulePoll(epoch)
  }

  private async poll(epoch: number): Promise<void> {
    const login = this.store.getSnapshot().login
    if (login === null || epoch !== this.loginEpoch || this.lifetime.signal.aborted) return
    if (Date.now() >= login.expiresAt) { this.announce('LOGIN_EXPIRED', false); this.patch((state) => { state.login = null }); return }
    try { await this.acceptLogin(await this.invoke('login-status', { loginId: login.loginId }), epoch) }
    catch (error) { this.patch((state) => { state.error = this.code(error) }); this.schedulePoll(epoch) }
  }

  /** Submit a manual callback without retaining it in page state.
   * @param callbackUrl Complete redirect entered by the user.
   * @returns Completion after the Host validates PKCE/state and sibling directories refresh.
   */
  completeLogin(callbackUrl: string): Promise<boolean> {
    return this.track(this.run('callback', async () => {
      const login = this.store.getSnapshot().login
      if (login === null) throw new SubscriptionFailure('LOGIN_NOT_FOUND')
      await this.acceptLogin(await this.invoke('login-complete', { loginId: login.loginId, callbackUrl }), this.loginEpoch)
    }))
  }

  /** Cancel the current login only; another browser/application login is never targeted.
   * @returns Whether cancellation completed and local polling was stopped.
   */
  cancelLogin(): Promise<boolean> {
    return this.track(this.run('cancel', async () => {
      const login = this.store.getSnapshot().login
      if (login !== null) await this.invoke('login-cancel', { loginId: login.loginId })
      this.loginEpoch++; clearTimeout(this.pollTimer); this.patch((state) => { state.login = null })
    }))
  }

  /** Apply one revision-checked account control, preserving rows on a failed mutation.
   * @param account Current detached account row.
   * @param patch Edited controls, never credentials.
   * @returns Whether the account write and directory refresh completed.
   */
  update(
    account: SubscriptionAccount,
    patch: { label?: string; enabled?: boolean; allowCredits?: boolean; priority?: number },
  ): Promise<boolean> {
    return this.track(this.run(account.accountKey, async () => {
      await this.invoke('account-update', { accountKey: account.accountKey, revision: account.revision, ...patch })
      await this.reload(); await this.refreshDirectories()
    }, 'SAVED'))
  }

  /** Remove only the selected credential generation after UI confirmation.
   * @param account Current detached row with its revision.
   * @returns Whether removal and directory refresh completed.
   */
  remove(account: SubscriptionAccount): Promise<boolean> {
    return this.track(this.run(account.accountKey, async () => {
      await this.invoke('account-remove', { accountKey: account.accountKey, revision: account.revision })
      await this.reload(); await this.refreshDirectories()
    }, 'REMOVED'))
  }

  /** Refresh every displayed account explicitly, then synchronize model membership.
   * @returns Whether refresh calls and directory synchronization completed.
   */
  refresh(): Promise<boolean> {
    return this.track(this.run('refresh', async () => {
      const refreshed = await Promise.all(this.store.getSnapshot().accounts.map(account => this.invoke('account-refresh', { accountKey: account.accountKey })))
      await this.reload(); await this.refreshDirectories()
      if (subscriptionAccounts(refreshed).some(account => account.usage?.status === 'error')) throw new SubscriptionFailure('QUOTA_REFRESH_FAILED')
    }, 'REFRESHED'))
  }

  private async run(busy: string, operation: () => Promise<void>, success?: string): Promise<boolean> {
    if (this.lifetime.signal.aborted || this.store.getSnapshot().busy !== null) return false
    this.patch((state) => { state.busy = busy; state.error = null })
    try { await operation(); if (success !== undefined) this.announce(success, true); return true }
    catch (error) {
      const code = this.code(error); this.announce(code, false)
      if (code === 'REVISION_CONFLICT') await this.load()
      return false
    } finally { this.patch((state) => { state.busy = null }) }
  }

  /** Stop timer admission, cancel Remote waiters and drain owned work. */
  async dispose(): Promise<void> {
    this.lifetime.abort(); this.loginEpoch++; clearTimeout(this.pollTimer)
    await Promise.allSettled([...this.tasks, ...this.loading === undefined ? [] : [this.loading]])
  }
}
