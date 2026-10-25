/** The Client follows a Host-owned sign-in and receives only verified account metadata. */
import type { GalleryAccount, GalleryLoginView } from '../shared/gallery.ts'
import type { ActionArgs, ConfigurationView } from './contract.ts'

/**
 * Merge verified metadata into its existing connection without changing that connection's default selection.
 * @param source Current settings protected by the configuration revision on save.
 * @param account Verified connection, reusing its original ID on repeated sign-in.
 * @returns Settings with one account entry; a new account becomes default only when no default was selected.
 */
export function withGalleryAccount(source: ConfigurationView['source'], account: GalleryAccount): ConfigurationView['source'] {
  const existed = source.unsplash.accounts.some(item => item.id === account.id)
  return { ...source, provider: 'unsplash', unsplash: { ...source.unsplash,
    accounts: existed ? source.unsplash.accounts.map(item => item.id === account.id ? account : item) : [...source.unsplash.accounts, account],
    defaultAccountId: existed ? source.unsplash.defaultAccountId : source.unsplash.defaultAccountId ?? account.id,
  } }
}

const pause = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
  const timer = setTimeout(done, ms)
  signal.addEventListener('abort', done, { once: true })
  if (signal.aborted) done()
})

/** @param read Authenticated gallery transport. @param input Saved revision and optional reconnect target. @param options Polling, cancellation and a safe status callback invoked only when progress changes. @returns Verified account after the Host stores its session. */
export async function connectGalleryLogin(read: (operation: string, args: ActionArgs, signal: AbortSignal) => Promise<unknown>, input: { revision: string; operationId: string; accountId?: string }, options: { pollIntervalMs: number; requestTimeoutMs: number; signal: AbortSignal; onStatus(status: GalleryLoginView): void }): Promise<GalleryAccount> {
  let id: string | undefined, saved = false, progress: string | undefined
  try {
    const view = await read('gallery-login-start', input, options.signal) as GalleryLoginView
    id = view.id
    let current = view
    while (true) {
      options.signal.throwIfAborted()
      const nextProgress = JSON.stringify(current)
      if (nextProgress !== progress) { progress = nextProgress; options.onStatus(current) }
      if (current.state === 'ready' || current.state === 'saved') {
        const account = await read('gallery-login-finish', { loginId: id }, options.signal) as GalleryAccount
        saved = true
        return account
      }
      if (current.state === 'cancelled' || current.state === 'failed') throw Object.assign(new Error('Gallery sign-in did not complete.'), { code: current.errorCode ?? 'gallery-login-failed' })
      await pause(options.pollIntervalMs, options.signal)
      options.signal.throwIfAborted()
      current = await read('gallery-login-status', { loginId: id }, options.signal) as GalleryLoginView
    }
  } finally {
    if (!saved) {
      try { await read('gallery-login-cancel', id ? { loginId: id } : { operationId: input.operationId }, AbortSignal.timeout(options.requestTimeoutMs)) }
      catch (_error) { /* Host 的登录超时仍会关闭窗口；断线不能伪装成已连接。 */ }
    }
  }
}
