/** One profile owns its website sign-in, cancellation and secret commit lifecycle. */
import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CuratorConfig } from './config.ts'
import type { GalleryAccount, GalleryAccountId, GalleryLoginView } from '../shared/gallery.ts'
import type { UnsplashApi } from '../media/unsplash.ts'
import { MediaError } from '../media/errors.ts'
import { CuratorError } from '../shared/errors.ts'

/** An isolated, Host-owned login window; only Unsplash's session may be read. */
export interface GalleryLoginBrowser {
  closed: AbortSignal
  cookie(): Promise<string>
  close(): Promise<void>
}

type Identity = Awaited<ReturnType<UnsplashApi['me']>>
type Flow = {
  view: GalleryLoginView; operationId: string; owner: string; expected?: GalleryAccount; controller: AbortController
  work: Promise<void>; secret?: string | undefined; saving?: Promise<GalleryAccount> | undefined; cleanup?: (() => Promise<void>) | undefined
}
const failed = (code: string) => new MediaError(code, 'gallery-login', false, 'The Unsplash sign-in could not finish.', 'Open a new sign-in window and retry.')

/** Session material never enters the Client projection or model/tool transcript. */
export class GalleryLogins {
  private flow: Flow | undefined
  private stopping = false
  private readonly cancelledStarts = new Map<string, number>()
  /** @param config Validated deployment/account settings. @param lifetime Plugin lifetime. @param launch Owned window factory. @param identify Bounded real /me check. @param store DSH credential writer. */
  constructor(private readonly config: CuratorConfig, private readonly lifetime: AbortSignal, private readonly launch: (signal: AbortSignal) => Promise<GalleryLoginBrowser>, private readonly identify: (cookie: string, signal: AbortSignal) => Promise<Identity>, private readonly store: (ref: string, cookie: string) => Promise<void>) {}

  /** @param input Idempotent Client start and optional account being renewed. @param owner Authenticated profile/Session identity. @returns Safe opening status immediately. */
  start(input: { operationId: string; accountId?: string }, owner: string): GalleryLoginView {
    if (this.stopping || this.lifetime.aborted) throw failed('gallery-login-unavailable')
    if (this.flow?.cleanup) throw failed('gallery-login-close-failed')
    for (const [key, expires] of this.cancelledStarts) if (expires <= Date.now()) this.cancelledStarts.delete(key)
    if (this.cancelledStarts.has(JSON.stringify([owner, input.operationId]))) throw failed('gallery-login-cancelled')
    if (this.flow?.operationId === input.operationId) return this.status(this.flow.view.id, owner)
    if (this.flow && !['saved', 'failed', 'cancelled'].includes(this.flow.view.state)) throw failed('gallery-login-busy')
    const expected = input.accountId ? this.config.source.unsplash.accounts.find(item => item.id === input.accountId) : undefined
    if (input.accountId && !expected) throw failed('gallery-login-account-mismatch')
    const flow: Flow = { view: { id: randomUUID(), state: 'opening' }, operationId: input.operationId, owner, ...(expected ? { expected } : {}), controller: new AbortController(), work: Promise.resolve() }
    this.flow = flow
    flow.work = this.capture(flow)
    return { ...flow.view }
  }

  /** @param id Opaque active sign-in identity. @param owner Authenticated caller. @returns Safe progress without session material. */
  status(id: string, owner: string): GalleryLoginView { return { ...this.require(id, owner).view } }

  /** @param id Validated, ready sign-in. @param owner Authenticated caller. @returns Account metadata after an idempotent credential write. */
  async finish(id: string, owner: string): Promise<GalleryAccount> {
    const flow = this.require(id, owner)
    await flow.work
    if (flow.view.state === 'saved' && flow.view.account) return flow.view.account
    if (flow.saving) return flow.saving
    if (flow.view.state !== 'ready' || !flow.secret || !flow.view.account) throw failed(flow.view.errorCode ?? 'gallery-login-not-ready')
    const account = flow.view.account, secret = flow.secret
    flow.controller.signal.throwIfAborted(); this.lifetime.throwIfAborted()
    flow.view.state = 'saving'
    flow.saving = this.store(account.credentialRef, secret).then(() => {
      // 写入一旦提交，关闭弹窗只结束窗口，不把已保存凭据误报为取消。
      flow.view.state = 'saved'; flow.secret = undefined
      return account
    }, () => { flow.view.state = 'ready'; flow.saving = undefined; throw failed('gallery-login-save-failed') })
    return flow.saving
  }

  /** @param id Owned sign-in. @param owner Authenticated caller. @returns Final status after browser and polling have drained. */
  async cancel(id: string, owner: string): Promise<GalleryLoginView> {
    const flow = this.require(id, owner)
    if (flow.saving) await flow.saving
    if (flow.view.state !== 'saved') { flow.view.state = 'cancelled'; flow.secret = undefined; flow.controller.abort() }
    await flow.work
    if (flow.cleanup) {
      try { await flow.cleanup(); flow.cleanup = undefined }
      catch (_error) { throw failed('gallery-login-close-failed') }
    }
    return { ...flow.view }
  }

  /** Cancel an accepted or not-yet-admitted start when its HTTP response was lost.
   * @param operationId Original Client start identity. @param owner Authenticated caller.
   */
  async cancelStart(operationId: string, owner: string): Promise<void> {
    this.cancelledStarts.set(JSON.stringify([owner, operationId]), Date.now() + this.config.source.unsplash.login.timeoutMs)
    // 取消收据只防止迟到的启动请求；固定上限限制认证路由的临时内存占用。
    while (this.cancelledStarts.size > 64) this.cancelledStarts.delete(this.cancelledStarts.keys().next().value!)
    if (this.flow?.operationId === operationId) await this.cancel(this.flow.view.id, owner)
  }

  /** Await owned window cleanup before the profile releases dependent services. */
  async dispose(): Promise<void> {
    this.stopping = true
    if (this.flow) await this.cancel(this.flow.view.id, this.flow.owner)
    this.cancelledStarts.clear()
  }

  private require(id: string, owner: string): Flow {
    if (!this.flow || this.flow.view.id !== id || this.flow.owner !== owner) throw new CuratorError('owner-denied', 'gallery-login', 'This sign-in is unavailable to the caller.')
    return this.flow
  }

  private async capture(flow: Flow): Promise<void> {
    const signal = AbortSignal.any([this.lifetime, flow.controller.signal, AbortSignal.timeout(this.config.source.unsplash.login.timeoutMs)])
    let browser: GalleryLoginBrowser | undefined
    try {
      browser = await this.launch(signal)
      const active = AbortSignal.any([signal, browser.closed])
      active.throwIfAborted()
      flow.view.state = 'waiting'
      while (true) {
        active.throwIfAborted()
        const cookie = await browser.cookie()
        if (cookie) {
          flow.view.state = 'validating'
          let me: Identity | undefined
          try { me = await this.identify(cookie, active) }
          catch (error) {
            active.throwIfAborted()
            if (!(error instanceof MediaError) || !['source-auth-required', 'source-access-check', 'source-access-denied'].includes(error.code)) throw error
            flow.view.errorCode = error.code
          }
          active.throwIfAborted()
          if (me) {
            delete flow.view.errorCode
            if (flow.expected && flow.expected.userId !== me.userId) throw failed('gallery-login-account-mismatch')
            // 同一官网身份复用原连接；新登录只更新其会话，不新增重复账号或覆盖备注。
            const existing = flow.expected ?? this.config.source.unsplash.accounts.find(account => account.userId === me.userId)
            const id = existing?.id ?? brandString<GalleryAccountId>(randomUUID())
            flow.view.account = { id, credentialRef: existing?.credentialRef ?? `VISUAL_CURATOR_UNSPLASH_${id.replaceAll('-', '_')}`, label: existing?.label ?? (me.name.trim() || me.username), userId: me.userId, username: me.username, name: me.name }
            flow.secret = cookie; flow.view.state = 'ready'
            break
          }
          flow.view.state = 'waiting'
        }
        await setTimeout(this.config.source.unsplash.login.pollIntervalMs, undefined, { signal: active })
      }
    } catch (error) {
      flow.secret = undefined
      const cancelled = flow.controller.signal.aborted || this.lifetime.aborted || !signal.aborted && browser?.closed.aborted
      flow.view = { id: flow.view.id, state: cancelled ? 'cancelled' : 'failed', errorCode: signal.aborted && !cancelled ? 'gallery-login-timeout' : browser?.closed.aborted && !flow.controller.signal.aborted ? 'gallery-login-window-closed' : error instanceof MediaError ? error.code : 'gallery-login-failed' }
    } finally {
      const acquired = browser
      flow.cleanup = acquired ? () => acquired.close() : undefined
      try { await flow.cleanup?.(); flow.cleanup = undefined }
      catch (_error) { flow.secret = undefined; flow.view = { id: flow.view.id, state: 'failed', errorCode: 'gallery-login-close-failed' } }
    }
  }
}
