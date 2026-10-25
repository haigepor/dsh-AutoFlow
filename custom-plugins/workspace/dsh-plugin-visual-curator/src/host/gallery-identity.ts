/** Account-scoped identity checks share only bounded success and independently cancellable I/O. */
import type { UnsplashApi } from '../media/unsplash.ts'
import type { RequestBounds } from '../media/network.ts'
import type { GalleryAccount } from '../shared/gallery.ts'
import { CuratorError } from '../shared/errors.ts'

type Identity = Awaited<ReturnType<UnsplashApi['me']>>
interface Pending { controller: AbortController; readers: Set<symbol>; promise: Promise<Identity> }
interface Entry { success?: { at: number; identity: Identity }; pending?: Pending }

/** Each instance belongs to one gallery service; credentials remain owned by its API factory. */
export class GalleryIdentityVerifier {
  private states = new WeakMap<UnsplashApi, Map<string, Entry>>()
  private readonly active = new Map<AbortController, Promise<Identity>>()
  private closed = false

  /** @param ttlMs Validated success lifetime; zero disables stored success but still coalesces pending checks.
   * @param now Clock for expiry; omission uses the system clock.
   */
  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  /** Reuse only a matching saved account identity on the same credential-bound API instance.
   * @param api Account-isolated API; credential, User-Agent or transport changes must replace this instance.
   * @param account Saved account ID and expected website user ID.
   * @param bounds The first pending reader supplies I/O limits; each reader retains its own optional signal.
   * @param options forceFresh ignores stored success; omission permits unexpired success. Both join a current check.
   * @returns Verified safe identity fields; failure and cancellation never populate the success cache.
   */
  async verify(api: UnsplashApi, account: Pick<GalleryAccount, 'id' | 'userId'>, bounds: RequestBounds, options?: { forceFresh?: boolean }): Promise<Identity> {
    bounds.signal?.throwIfAborted()
    if (this.closed) throw new CuratorError('cancelled', 'gallery', 'Gallery identity verification has stopped.')
    let scopes = this.states.get(api)
    if (!scopes) { scopes = new Map(); this.states.set(api, scopes) }
    const state = scopes, key = JSON.stringify([account.id, account.userId])
    let entry = state.get(key)
    if (!entry) { entry = {}; state.set(key, entry) }
    const scope = entry
    if (options?.forceFresh) delete scope.success
    if (scope.success) {
      const age = this.now() - scope.success.at
      if (age >= 0 && age < this.ttlMs) return { ...scope.success.identity }
      delete scope.success
    }
    if (!scope.pending) {
      const controller = new AbortController()
      const promise: Promise<Identity> = Promise.resolve().then(async () => {
        controller.signal.throwIfAborted()
        const identity = await api.me({ ...bounds, signal: controller.signal })
        controller.signal.throwIfAborted()
        if (identity.userId !== account.userId) throw new CuratorError('owner-denied', 'gallery', 'This session belongs to another account. Reconnect the selected account.')
        // 失效或关闭后的旧响应不能重新授权后续分页。
        if (!this.closed && this.states.get(api) === state && state.get(key) === scope && this.ttlMs > 0) scope.success = { at: this.now(), identity: { ...identity } }
        return identity
      }).finally(() => {
        if (scope.pending?.promise === promise) delete scope.pending
        this.active.delete(controller)
      })
      scope.pending = { controller, readers: new Set(), promise }
      this.active.set(controller, promise)
    }
    const pending = scope.pending, reader = Symbol(), signal = bounds.signal
    pending.readers.add(reader)
    return await new Promise<Identity>((resolve, reject) => {
      const detach = () => { signal?.removeEventListener('abort', abort); pending.readers.delete(reader) }
      const abort = () => {
        detach()
        if (!pending.readers.size) {
          if (scope.pending === pending) delete scope.pending
          pending.controller.abort()
        }
        reject(signal?.reason ?? new DOMException('Gallery identity check cancelled.', 'AbortError'))
      }
      signal?.addEventListener('abort', abort, { once: true })
      pending.promise.then(identity => { detach(); if (!signal?.aborted) resolve({ ...identity }) }, error => { detach(); if (!signal?.aborted) reject(error) })
      if (signal?.aborted) abort()
    })
  }

  /** Drop success and cancel pending checks after authentication or access failures.
   * @param api The credential-bound API whose authorization is no longer trusted.
   */
  invalidate(api: UnsplashApi): void {
    const state = this.states.get(api)
    this.states.delete(api)
    if (state) for (const scope of state.values()) scope.pending?.controller.abort()
  }

  /** Stop new readers and abort every owned check.
   * @returns Completion after all pending I/O settles; repeated disposal remains safe.
   */
  async dispose(): Promise<void> {
    this.closed = true
    this.states = new WeakMap()
    const requests = [...this.active]
    for (const [controller] of requests) controller.abort()
    await Promise.allSettled(requests.map(([, promise]) => promise))
  }
}
